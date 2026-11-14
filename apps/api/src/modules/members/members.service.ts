import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import {
  and,
  asc,
  eq,
  invites,
  isNull,
  sessions,
  users,
  withIdentity,
  withTenant,
  workspaceMembers,
  workspaces,
  type DatabaseHandle,
  type Tx,
} from "@openline/db";
import type {
  AcceptInviteInput,
  InviteDto,
  InviteInput,
  InviteLookupDto,
  MemberDto,
  Role,
} from "@openline/shared";
import { CONFIG, type AppConfig } from "../../config";
import type { AuthContext } from "../../common/auth-context";
import { ApiException, forbidden, notFound } from "../../common/http";
import { DB } from "../../database/database.module";
import { AuditService } from "../audit/audit.service";
import { hashPassword } from "../auth/password";
import { SessionService } from "../auth/session.service";
import { hashToken, newToken } from "../auth/tokens";
import type { ClientInfo } from "../auth/auth.service";

const DAY_MS = 86_400_000;

@Injectable()
export class MembersService {
  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  private scope<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, { workspaceId: auth.workspaceId, userId: auth.userId }, fn);
  }

  // ---------------------------------------------------------------- members

  list(auth: AuthContext): Promise<MemberDto[]> {
    return this.scope(auth, async (tx) => {
      const rows = await tx
        .select({
          userId: workspaceMembers.userId,
          name: users.name,
          email: users.email,
          role: workspaceMembers.role,
          joinedAt: workspaceMembers.createdAt,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(eq(workspaceMembers.workspaceId, auth.workspaceId))
        .orderBy(asc(users.name));
      return rows.map((r) => ({ ...r, joinedAt: r.joinedAt.toISOString() }));
    });
  }

  async changeRole(auth: AuthContext, targetUserId: string, role: Role): Promise<void> {
    await this.scope(auth, async (tx) => {
      const target = await this.getMember(tx, auth.workspaceId, targetUserId);
      if (target.role === role) return;
      // Only owners may create or remove owners.
      if ((role === "owner" || target.role === "owner") && auth.role !== "owner") {
        throw forbidden("Only an owner can change owner roles");
      }
      if (target.role === "owner" && role !== "owner") {
        await this.assertNotLastOwner(tx, auth.workspaceId);
      }
      await tx
        .update(workspaceMembers)
        .set({ role })
        .where(
          and(
            eq(workspaceMembers.workspaceId, auth.workspaceId),
            eq(workspaceMembers.userId, targetUserId),
          ),
        );
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "member.role_changed",
        entity: "user",
        entityId: targetUserId,
        metadata: { from: target.role, to: role },
      });
    });
  }

  async remove(auth: AuthContext, targetUserId: string): Promise<void> {
    const isSelf = targetUserId === auth.userId;
    if (!isSelf && auth.role !== "owner" && auth.role !== "admin") throw forbidden();

    await this.scope(auth, async (tx) => {
      const target = await this.getMember(tx, auth.workspaceId, targetUserId);
      if (target.role === "owner") {
        if (!isSelf && auth.role !== "owner") throw forbidden("Only an owner can remove an owner");
        await this.assertNotLastOwner(tx, auth.workspaceId);
      }
      await tx
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, auth.workspaceId),
            eq(workspaceMembers.userId, targetUserId),
          ),
        );
      // End their sessions in this workspace immediately.
      await tx
        .delete(sessions)
        .where(and(eq(sessions.userId, targetUserId), eq(sessions.workspaceId, auth.workspaceId)));
      // Invites they sent die with their access (no privilege left behind).
      await tx
        .update(invites)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(invites.workspaceId, auth.workspaceId),
            eq(invites.invitedBy, targetUserId),
            isNull(invites.acceptedAt),
            isNull(invites.revokedAt),
          ),
        );
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: isSelf ? "member.left" : "member.removed",
        entity: "user",
        entityId: targetUserId,
      });
    });
  }

  // ---------------------------------------------------------------- invites

  listInvites(auth: AuthContext): Promise<InviteDto[]> {
    return this.scope(auth, async (tx) => {
      const rows = await tx
        .select()
        .from(invites)
        .where(
          and(
            eq(invites.workspaceId, auth.workspaceId),
            isNull(invites.acceptedAt),
            isNull(invites.revokedAt),
          ),
        )
        .orderBy(asc(invites.createdAt));
      return rows
        .filter((r) => r.expiresAt.getTime() > Date.now())
        .map((r) => ({
          id: r.id,
          email: r.email,
          role: r.role,
          expiresAt: r.expiresAt.toISOString(),
          createdAt: r.createdAt.toISOString(),
        }));
    });
  }

  /** Returns the invite link. The token is shown once and only its hash is stored. */
  async invite(
    auth: AuthContext,
    input: InviteInput,
  ): Promise<{ invite: InviteDto; inviteUrl: string }> {
    const token = newToken();
    const invite = await this.scope(auth, async (tx) => {
      const [alreadyMember] = await tx
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(
          and(eq(workspaceMembers.workspaceId, auth.workspaceId), eq(users.email, input.email)),
        )
        .limit(1);
      if (alreadyMember) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          "already_member",
          "This person is already on the team",
        );
      }
      // Re-inviting replaces any pending invite for the same email.
      await tx
        .update(invites)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(invites.workspaceId, auth.workspaceId),
            eq(invites.email, input.email),
            isNull(invites.acceptedAt),
            isNull(invites.revokedAt),
          ),
        );
      const [created] = await tx
        .insert(invites)
        .values({
          workspaceId: auth.workspaceId,
          email: input.email,
          role: input.role,
          tokenHash: hashToken(token),
          invitedBy: auth.userId,
          expiresAt: new Date(Date.now() + this.config.INVITE_TTL_DAYS * DAY_MS),
        })
        .returning();
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "invite.created",
        entity: "invite",
        entityId: created!.id,
        metadata: { role: input.role },
      });
      return created!;
    });

    return {
      invite: {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expiresAt.toISOString(),
        createdAt: invite.createdAt.toISOString(),
      },
      inviteUrl: `${this.config.WEB_URL}/invite/${token}`,
    };
  }

  async revokeInvite(auth: AuthContext, inviteId: string): Promise<void> {
    await this.scope(auth, async (tx) => {
      const [updated] = await tx
        .update(invites)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(invites.id, inviteId),
            eq(invites.workspaceId, auth.workspaceId),
            isNull(invites.acceptedAt),
            isNull(invites.revokedAt),
          ),
        )
        .returning({ id: invites.id });
      if (!updated) throw notFound("Invite");
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "invite.revoked",
        entity: "invite",
        entityId: inviteId,
      });
    });
  }

  /** Public: what the invite page shows before the person accepts. */
  async lookup(token: string): Promise<InviteLookupDto> {
    const invite = await this.findInviteByToken(token);
    if (!invite) throw notFound("Invite");
    const [workspaceName, accountExists] = await Promise.all([
      withTenant(this.handle.db, { workspaceId: invite.workspaceId }, async (tx) => {
        const [ws] = await tx
          .select({ name: workspaces.name })
          .from(workspaces)
          .where(eq(workspaces.id, invite.workspaceId));
        return ws?.name ?? "";
      }),
      withIdentity(this.handle.db, async (tx) => {
        const [u] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, invite.email));
        return Boolean(u);
      }),
    ]);
    return {
      workspaceName,
      email: invite.email,
      role: invite.role,
      status: inviteStatus(invite),
      accountExists,
    };
  }

  /**
   * Accepting:
   *  - signed in as the invited email → joins the workspace;
   *  - no account for that email → creates one (name + password required) and signs in;
   *  - account exists but not signed in as it → must sign in first.
   * Returns a new session token when a session was created.
   */
  async accept(
    input: AcceptInviteInput,
    current: AuthContext | undefined,
    client: ClientInfo,
  ): Promise<string | null> {
    const invite = await this.findInviteByToken(input.token);
    if (!invite) throw notFound("Invite");
    const status = inviteStatus(invite);
    if (status !== "valid") {
      throw new ApiException(HttpStatus.GONE, `invite_${status}`, `This invite is ${status}`);
    }

    const existingUser = await withIdentity(this.handle.db, async (tx) => {
      const [u] = await tx.select().from(users).where(eq(users.email, invite.email)).limit(1);
      return u;
    });

    if (current && current.userId !== existingUser?.id) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        "logout_required",
        `This invite is for ${invite.email}. Sign out first, then open the link again.`,
      );
    }
    if (existingUser && current?.userId !== existingUser.id) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        "login_required",
        `Sign in as ${invite.email} to accept this invite`,
      );
    }
    if (!existingUser && (!input.name || !input.password)) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        "validation_error",
        "Name and password are required to create your account",
      );
    }
    const passwordHash = existingUser ? null : await hashPassword(input.password!);

    return withTenant(
      this.handle.db,
      { workspaceId: invite.workspaceId, inviteTokenHash: hashToken(input.token) },
      async (tx) => {
        const userId =
          existingUser?.id ??
          (
            await tx
              .insert(users)
              .values({ email: invite.email, name: input.name!, passwordHash: passwordHash! })
              .returning({ id: users.id })
          )[0]!.id;

        // Mark accepted first; the WHERE makes concurrent double-accepts impossible.
        const [claimed] = await tx
          .update(invites)
          .set({ acceptedAt: new Date() })
          .where(
            and(eq(invites.id, invite.id), isNull(invites.acceptedAt), isNull(invites.revokedAt)),
          )
          .returning({ id: invites.id });
        if (!claimed) throw new ApiException(HttpStatus.GONE, "invite_used", "This invite is used");

        await tx
          .insert(workspaceMembers)
          .values({ workspaceId: invite.workspaceId, userId, role: invite.role })
          .onConflictDoNothing();
        await tx
          .update(users)
          .set({ lastWorkspaceId: invite.workspaceId })
          .where(eq(users.id, userId));
        await this.audit.record(tx, {
          workspaceId: invite.workspaceId,
          actorId: userId,
          action: "invite.accepted",
          entity: "invite",
          entityId: invite.id,
          metadata: { role: invite.role },
        });

        if (current) {
          await tx
            .update(sessions)
            .set({ workspaceId: invite.workspaceId })
            .where(eq(sessions.id, current.sessionId));
          return null;
        }
        return this.sessions.create(tx, { userId, workspaceId: invite.workspaceId, ...client });
      },
    );
  }

  // ---------------------------------------------------------------- helpers

  private async findInviteByToken(token: string) {
    const tokenHash = hashToken(token);
    return withTenant(this.handle.db, { inviteTokenHash: tokenHash }, async (tx) => {
      const [row] = await tx
        .select()
        .from(invites)
        .where(eq(invites.tokenHash, tokenHash))
        .limit(1);
      return row;
    });
  }

  private async getMember(tx: Tx, workspaceId: string, userId: string) {
    const [m] = await tx
      .select()
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
      )
      .limit(1);
    if (!m) throw notFound("Member");
    return m;
  }

  private async assertNotLastOwner(tx: Tx, workspaceId: string): Promise<void> {
    const owners = await tx
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "owner")))
      // Lock the owner rows so two owners demoting each other can't both succeed.
      .for("update");
    if (owners.length <= 1) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        "last_owner",
        "A workspace needs at least one owner. Make someone else an owner first.",
      );
    }
  }
}

function inviteStatus(invite: {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}): InviteLookupDto["status"] {
  if (invite.acceptedAt) return "used";
  if (invite.revokedAt) return "revoked";
  if (invite.expiresAt.getTime() <= Date.now()) return "expired";
  return "valid";
}
