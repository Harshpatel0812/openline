import { sql } from "drizzle-orm";
import type { Db } from "./client";

/** A transaction handle; same query API as Db. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface TenantContext {
  /** The workspace whose rows are visible. Required for all tenant data. */
  workspaceId?: string;
  /** The signed-in user (lets them see their own memberships across workspaces). */
  userId?: string;
  /** SHA-256 of an invite token, so the invitee can read that one invite. */
  inviteTokenHash?: string;
}

/**
 * Runs `fn` in a transaction as the restricted `openline_app` role with the tenant context set.
 * Row-level security then limits every query to the current workspace — a second wall behind
 * the application's own `workspace_id` filters. ALWAYS use this for tenant data.
 */
export async function withTenant<T>(
  db: Db,
  ctx: TenantContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE openline_app`);
    await tx.execute(
      sql`SELECT
        set_config('app.workspace_id', ${ctx.workspaceId ?? ""}, true),
        set_config('app.user_id', ${ctx.userId ?? ""}, true),
        set_config('app.invite_token_hash', ${ctx.inviteTokenHash ?? ""}, true)`,
    );
    return fn(tx);
  });
}

/**
 * Runs `fn` in a transaction as `openline_app` with NO tenant context: only the global identity
 * tables (users, sessions) are usable; every tenant table returns zero rows.
 */
export function withIdentity<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenant(db, {}, fn);
}
