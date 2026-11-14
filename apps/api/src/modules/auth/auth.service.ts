import { randomUUID } from "node:crypto";
import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import {
  and,
  asc,
  eq,
  sessions,
  users,
  withIdentity,
  withTenant,
  workspaceMembers,
  workspaces,
  type DatabaseHandle,
} from "@openline/db";
import type { LoginInput, MeResponse, SignupInput } from "@openline/shared";
import type { AuthContext } from "../../common/auth-context";
import { ApiException, forbidden } from "../../common/http";
import { DB } from "../../database/database.module";
import { AuditService } from "../audit/audit.service";
import { getDummyHash, hashPassword, verifyPassword } from "./password";
import { SessionService } from "./session.service";

export interface ClientInfo {
  ip?: string;
  userAgent?: string;
}

const TRIAL_DAYS = 14;

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  /** Creates the user, their workspace (as owner) and a session, all in one transaction. */
  async signup(input: SignupInput, client: ClientInfo): Promise<string> {
    const passwordHash = await hashPassword(input.password);
    const workspaceId = randomUUID();

    return withTenant(this.handle.db, { workspaceId }, async (tx) => {
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, input.email))
        .limit(1);
      if (existing) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          "email_taken",
          "An account with this email already exists. Sign in instead.",
        );
      }

      const [user] = await tx
        .insert(users)
        .values({
          email: input.email,
          name: input.name,
          passwordHash,
          lastWorkspaceId: workspaceId,
        })
        .returning({ id: users.id });
      await tx.insert(workspaces).values({
        id: workspaceId,
        name: input.workspaceName,
        trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 86_400_000),
      });
      await tx.insert(workspaceMembers).values({ workspaceId, userId: user!.id, role: "owner" });
      await this.audit.record(tx, {
        workspaceId,
        actorId: user!.id,
        action: "workspace.created",
        entity: "workspace",
        entityId: workspaceId,
      });
      return this.sessions.create(tx, { userId: user!.id, workspaceId, ...client });
    });
  }

  /** Same error and similar timing for unknown email and wrong password. */
  async login(input: LoginInput, client: ClientInfo): Promise<string> {
    const user = await withIdentity(this.handle.db, async (tx) => {
      const [u] = await tx.select().from(users).where(eq(users.email, input.email)).limit(1);
      return u;
    });

    const valid = await verifyPassword(
      input.password,
      user?.passwordHash ?? (await getDummyHash()),
    );
    if (!user) {
      // Same lookup work as a known account, so response time doesn't reveal which emails exist.
      await this.pickWorkspace(randomUUID(), null);
    }
    if (user && !valid) {
      const failedWs = await this.pickWorkspace(user.id, user.lastWorkspaceId);
      if (failedWs) {
        await withTenant(this.handle.db, { workspaceId: failedWs, userId: user.id }, (tx) =>
          this.audit.record(tx, {
            workspaceId: failedWs,
            actorId: user.id,
            action: "auth.login_failed",
            entity: "user",
            entityId: user.id,
            metadata: { ip: client.ip ?? null },
          }),
        );
      }
    }
    if (!user || !valid) {
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        "invalid_credentials",
        "Email or password is incorrect",
      );
    }

    const workspaceId = await this.pickWorkspace(user.id, user.lastWorkspaceId);
    const membership = workspaceId ? { workspaceId } : undefined;
    if (!membership) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        "no_workspace",
        "Your account is not a member of any workspace. Ask your admin for an invite.",
      );
    }

    return withTenant(
      this.handle.db,
      { workspaceId: membership.workspaceId, userId: user.id },
      async (tx) => {
        await tx
          .update(users)
          .set({ lastWorkspaceId: membership.workspaceId })
          .where(eq(users.id, user.id));
        await this.audit.record(tx, {
          workspaceId: membership.workspaceId,
          actorId: user.id,
          action: "auth.login",
          entity: "user",
          entityId: user.id,
          metadata: { ip: client.ip ?? null },
        });
        return this.sessions.create(tx, {
          userId: user.id,
          workspaceId: membership.workspaceId,
          ...client,
        });
      },
    );
  }

  async me(auth: AuthContext): Promise<MeResponse> {
    return withTenant(
      this.handle.db,
      { workspaceId: auth.workspaceId, userId: auth.userId },
      async (tx) => {
        const memberships = await tx
          .select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role })
          .from(workspaceMembers)
          .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
          .where(eq(workspaceMembers.userId, auth.userId))
          .orderBy(asc(workspaces.name));
        const [ws] = await tx
          .select()
          .from(workspaces)
          .where(eq(workspaces.id, auth.workspaceId))
          .limit(1);
        return {
          user: { id: auth.userId, name: auth.user.name, email: auth.user.email },
          workspace: {
            id: ws!.id,
            name: ws!.name,
            plan: ws!.plan,
            trialEndsAt: ws!.trialEndsAt.toISOString(),
          },
          role: auth.role,
          workspaces: memberships,
        };
      },
    );
  }

  async switchWorkspace(auth: AuthContext, workspaceId: string): Promise<void> {
    const member = await withTenant(this.handle.db, { userId: auth.userId }, async (tx) => {
      const [m] = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.userId, auth.userId),
            eq(workspaceMembers.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      return m;
    });
    if (!member) throw forbidden("You are not a member of that workspace");
    await withIdentity(this.handle.db, async (tx) => {
      await tx.update(sessions).set({ workspaceId }).where(eq(sessions.id, auth.sessionId));
      await tx.update(users).set({ lastWorkspaceId: workspaceId }).where(eq(users.id, auth.userId));
    });
  }

  async recordLogout(auth: AuthContext): Promise<void> {
    await withTenant(this.handle.db, { workspaceId: auth.workspaceId, userId: auth.userId }, (tx) =>
      this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "auth.logout",
        entity: "user",
        entityId: auth.userId,
      }),
    );
  }

  /** The workspace the user used last if they're still a member, else their oldest one. */
  private async pickWorkspace(
    userId: string,
    lastWorkspaceId: string | null,
  ): Promise<string | undefined> {
    return withTenant(this.handle.db, { userId }, async (tx) => {
      const memberships = await tx
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, userId))
        .orderBy(asc(workspaceMembers.createdAt));
      const last = memberships.find((m) => m.workspaceId === lastWorkspaceId);
      return (last ?? memberships[0])?.workspaceId;
    });
  }
}
