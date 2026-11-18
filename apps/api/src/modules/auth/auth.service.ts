import { randomUUID } from "node:crypto";
import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import {
  and,
  asc,
  eq,
  isNull,
  seedDefaultStages,
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
import { CONFIG, type AppConfig } from "../../config";
import { DB } from "../../database/database.module";
import { AuditService } from "../audit/audit.service";
import { TransactionalMailService } from "../mail/transactional-mail.service";
import { EmailTokensService } from "./email-tokens.service";
import { getDummyHash, hashPassword, verifyPassword } from "./password";
import { SessionService } from "./session.service";

export interface ClientInfo {
  ip?: string;
  userAgent?: string;
}

const TRIAL_DAYS = 14;

@Injectable()
export class AuthService {
  private readonly logger = new Logger("Auth");
  private readonly pending = new Set<Promise<void>>();

  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly tokens: EmailTokensService,
    private readonly mail: TransactionalMailService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private link(path: string, token: string): string {
    return `${this.config.WEB_URL}${path}?token=${encodeURIComponent(token)}`;
  }

  /**
   * Creates the user, their workspace (as owner) and a session, all in one transaction, then
   * emails a verification link (valid 24 h).
   */
  async signup(input: SignupInput, client: ClientInfo): Promise<string> {
    const passwordHash = await hashPassword(input.password);
    const workspaceId = randomUUID();

    const { session, verifyToken } = await withTenant(
      this.handle.db,
      { workspaceId },
      async (tx) => {
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
          // Plan picked on /pricing, kept so the choice survives sign-up. Intent only.
          chosenPlan: input.plan ?? null,
          chosenBilling: input.plan ? (input.billing ?? "monthly") : null,
        });
        await tx.insert(workspaceMembers).values({ workspaceId, userId: user!.id, role: "owner" });
        await seedDefaultStages(tx, workspaceId);
        await this.audit.record(tx, {
          workspaceId,
          actorId: user!.id,
          action: "workspace.created",
          entity: "workspace",
          entityId: workspaceId,
          ...(input.plan
            ? { metadata: { chosenPlan: input.plan, chosenBilling: input.billing ?? "monthly" } }
            : {}),
        });
        return {
          session: await this.sessions.create(tx, { userId: user!.id, workspaceId, ...client }),
          verifyToken: await this.tokens.issue(tx, user!.id, "verify_email"),
        };
      },
    );
    await this.mail.sendVerification(input.email, this.link("/verify-email", verifyToken));
    return session;
  }

  // ---------------------------------------------------------------- account emails

  /** Confirms the email address. 410 token_invalid when unknown, expired or already used. */
  async verifyEmail(token: string): Promise<void> {
    const ok = await withIdentity(this.handle.db, async (tx) => {
      const userId = await this.tokens.consume(tx, token, "verify_email");
      if (!userId) return false;
      await tx
        .update(users)
        .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
      return true;
    });
    if (!ok) throw tokenInvalid();
  }

  /** Sends a fresh verification link (older links stop working). No-op when already verified. */
  async resendVerification(auth: AuthContext): Promise<void> {
    if (auth.emailVerified) return;
    const token = await withIdentity(this.handle.db, (tx) =>
      this.tokens.issue(tx, auth.userId, "verify_email"),
    );
    await this.mail.sendVerification(auth.user.email, this.link("/verify-email", token));
  }

  /**
   * Emails a reset link when the account exists. The caller always answers 200, and the token and
   * email are handled in the background, so neither the response nor its timing reveals whether
   * the account exists.
   */
  async forgotPassword(email: string): Promise<void> {
    const user = await withIdentity(this.handle.db, async (tx) => {
      const [u] = await tx
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      return u ?? null;
    });
    if (!user) return;
    // Issuing the token (a write) and sending happen after we answer, so a known email takes no
    // longer to respond than an unknown one.
    this.background(async () => {
      const token = await withIdentity(this.handle.db, (tx) =>
        this.tokens.issue(tx, user.id, "reset_password"),
      );
      await this.mail.sendPasswordReset(user.email, user.name, this.link("/reset-password", token));
    }, "password reset");
  }

  /** Work started after the response; failures are logged without personal data. */
  private background(job: () => Promise<void>, what: string): void {
    const run: Promise<void> = job()
      .catch((error: unknown) => {
        this.logger.error(`Could not finish ${what} (${(error as Error).name})`);
      })
      .finally(() => this.pending.delete(run));
    this.pending.add(run);
  }

  /** Resolves when all background work has finished (tests and graceful shutdown). */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  /** Sets a new password with a single-use token and ends ALL of the user's sessions. */
  async resetPassword(token: string, password: string): Promise<void> {
    const passwordHash = await hashPassword(password);
    const userId = await withIdentity(this.handle.db, async (tx) => {
      const id = await this.tokens.consume(tx, token, "reset_password");
      if (!id) return null;
      const now = new Date();
      const [current] = await tx
        .select({ emailVerifiedAt: users.emailVerifiedAt })
        .from(users)
        .where(eq(users.id, id));
      await tx
        .update(users)
        .set({
          passwordHash,
          updatedAt: now,
          // The reset link reached the inbox, which proves the address too.
          emailVerifiedAt: current?.emailVerifiedAt ?? now,
        })
        .where(eq(users.id, id));
      await this.sessions.revokeAllForUser(tx, id);
      return id;
    });
    if (!userId) throw tokenInvalid();

    // Audit in every workspace the user belongs to (the audit log is per workspace).
    const memberships = await withTenant(this.handle.db, { userId }, (tx) =>
      tx
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, userId)),
    );
    for (const { workspaceId } of memberships) {
      await withTenant(this.handle.db, { workspaceId, userId }, (tx) =>
        this.audit.record(tx, {
          workspaceId,
          actorId: userId,
          action: "auth.password_reset",
          entity: "user",
          entityId: userId,
        }),
      );
    }
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
          user: {
            id: auth.userId,
            name: auth.user.name,
            email: auth.user.email,
            emailVerified: auth.emailVerified,
          },
          workspace: {
            id: ws!.id,
            name: ws!.name,
            plan: ws!.plan,
            trialEndsAt: ws!.trialEndsAt.toISOString(),
            chosenPlan: ws!.chosenPlan,
            chosenBilling: ws!.chosenBilling,
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

const tokenInvalid = () =>
  new ApiException(
    HttpStatus.GONE,
    "token_invalid",
    "This link is invalid or has expired. Request a new one.",
  );
