import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  eq,
  sessions,
  users,
  withIdentity,
  withTenant,
  workspaceMembers,
  type DatabaseHandle,
  type Tx,
} from "@openline/db";
import type { Response } from "express";
import { CONFIG, type AppConfig } from "../../config";
import type { AuthContext } from "../../common/auth-context";
import { DB } from "../../database/database.module";
import { hashToken, newToken } from "./tokens";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Only write last_seen/expiry when it moved by more than this (avoids a write per request). */
const TOUCH_INTERVAL_MS = 15 * 60 * 1000;
/** Even an active session ends after this; the user signs in again. */
const ABSOLUTE_LIFETIME_MS = 90 * DAY_MS;

@Injectable()
export class SessionService {
  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Creates a session inside an existing transaction and returns the raw token (cookie only). */
  async create(
    tx: Tx,
    input: { userId: string; workspaceId: string; ip?: string; userAgent?: string },
  ): Promise<string> {
    const token = newToken();
    await tx.insert(sessions).values({
      userId: input.userId,
      workspaceId: input.workspaceId,
      tokenHash: hashToken(token),
      ip: input.ip?.slice(0, 64) ?? null,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      expiresAt: new Date(Date.now() + this.config.SESSION_TTL_DAYS * DAY_MS),
    });
    return token;
  }

  /** Resolves a cookie token to an auth context, or null if invalid/expired/no longer a member. */
  async resolve(token: string): Promise<AuthContext | null> {
    const tokenHash = hashToken(token);
    const row = await withIdentity(this.handle.db, async (tx) => {
      const [found] = await tx
        .select({ session: sessions, user: { name: users.name, email: users.email } })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(eq(sessions.tokenHash, tokenHash))
        .limit(1);
      return found;
    });
    if (!row) return null;

    const now = Date.now();
    if (
      row.session.expiresAt.getTime() <= now ||
      now - row.session.createdAt.getTime() > ABSOLUTE_LIFETIME_MS
    ) {
      await this.revokeByHash(tokenHash);
      return null;
    }

    const membership = await withTenant(
      this.handle.db,
      { workspaceId: row.session.workspaceId, userId: row.session.userId },
      async (tx) => {
        const [m] = await tx
          .select({ role: workspaceMembers.role })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, row.session.workspaceId),
              eq(workspaceMembers.userId, row.session.userId),
            ),
          )
          .limit(1);
        return m;
      },
    );
    if (!membership) return null;

    if (now - row.session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      // Sliding expiry: active users stay signed in; idle sessions expire.
      await withIdentity(this.handle.db, (tx) =>
        tx
          .update(sessions)
          .set({
            lastSeenAt: new Date(now),
            expiresAt: new Date(now + this.config.SESSION_TTL_DAYS * DAY_MS),
          })
          .where(eq(sessions.id, row.session.id)),
      );
    }

    return {
      sessionId: row.session.id,
      userId: row.session.userId,
      workspaceId: row.session.workspaceId,
      role: membership.role,
      user: row.user,
    };
  }

  async revokeByHash(tokenHash: string): Promise<void> {
    await withIdentity(this.handle.db, (tx) =>
      tx.delete(sessions).where(eq(sessions.tokenHash, tokenHash)),
    );
  }

  async revoke(token: string): Promise<void> {
    await this.revokeByHash(hashToken(token));
  }

  setCookie(res: Response, token: string): void {
    res.cookie(this.config.cookieName, token, {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: "lax",
      path: "/",
      maxAge: this.config.SESSION_TTL_DAYS * DAY_MS,
    });
  }

  clearCookie(res: Response): void {
    res.clearCookie(this.config.cookieName, {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: "lax",
      path: "/",
    });
  }

  readCookie(cookies: Record<string, string> | undefined): string | undefined {
    const value = cookies?.[this.config.cookieName];
    return typeof value === "string" && value.length >= 20 && value.length <= 200
      ? value
      : undefined;
  }
}
