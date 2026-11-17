/**
 * The CRM sync engine (ADR 0006). Claims due connections with claim_due_crm_syncs (the one
 * cross-tenant query, ids only), then for each, inside withTenant() for its workspace:
 *   previewing → dry-run import (counts + ≤ 20 example ids per bucket, no writes anywhere)
 *   importing  → initial import (CRM → Openline), resumable page by page, then Openline-only push
 *   active     → incremental two-way sync: CRM changes since the cursor (− 2 min overlap), local
 *                changes since the local cursor, due record retries, opt-outs, activity notes,
 *                and once a day a reconcile of linked ids (deletes and merges)
 *   paused     → token refresh only (Pipedrive refresh tokens expire after 60 days unused)
 * No transaction spans a network call. One connection's failure never affects another's.
 */
import {
  and,
  asc,
  companies,
  contacts,
  crmConnections,
  crmFieldMappings,
  crmLinks,
  crmStageMappings,
  crmSyncErrors,
  crmSyncRuns,
  dealContacts,
  deals,
  dealStageHistory,
  enrollments,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  mailboxes,
  messages,
  or,
  pipelineStages,
  sequences,
  sql,
  suppressions,
  auditLog,
  users,
  workspaceMembers,
  withIdentity,
  withTenant,
  type CrmConflictJson,
  type CrmConnectionRow,
  type CrmCursorsJson,
  type CrmLinkRow,
  type Db,
  type SQL,
  type Tx,
} from "@openline/db";
import { isSuppressed as suppressedBy } from "@openline/compliance";
import { openJson, sealJson } from "@openline/email";
import {
  CRM_DEFAULT_OPTIONS,
  CRM_LIMITS,
  CRM_PROVIDER_LABELS,
  CRM_SYNC_DEFAULTS,
  crmSyncEntitled,
  LOCKED_SUPPRESSION_REASONS,
  type CrmConnectionStatus,
  type CrmObject,
  type CrmOptions,
  type CrmProvider,
} from "@openline/shared";
import type { CrmConfig } from "./config";
import { decideField } from "./conflict";
import { nameKey, normalizeDomain } from "./domain";
import { CrmError } from "./errors";
import { fieldHash } from "./hash";
import { DailyBudget } from "./limiter";
import {
  customKeys,
  defaultMappings,
  effectiveMappings,
  localValue,
  pullFor,
  pushFor,
  remoteValue,
  reservedRemoteField,
  SKIP,
  type EffectiveMapping,
  type LocalCompanyRow,
  type LocalContactRow,
  type LocalDealRow,
  type LocalRow,
  type Lookup,
  type MappingRow,
} from "./mapping";
import { createOAuth } from "./providers";
import { recordRetryAt, runBackoffMs } from "./retry";
import { cleanDate, cleanEmail, cleanText } from "./sanitize";
import type { CallMeter, CrmApi, CrmOAuth, CrmSecret, RemoteRecord } from "./types";

const MINUTE = 60_000;
/** Overlap re-read on every cursor (search indexing lag, clock skew). */
export const CURSOR_OVERLAP_MS = 2 * MINUTE;
const LEASE = sql`now() + interval '10 minutes'`;
const LEASE_RENEW_MS = 2 * MINUTE;
const OBJECTS: CrmObject[] = ["company", "contact", "deal"];
/** Suppression reasons whose opt-out is pushed to the CRM. */
const PUSHED_OPTOUT_REASONS = ["unsubscribed", "asked_not_to_contact"];
const OPTOUT_MARK = "__optout";

export interface CrmSyncLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface CrmSyncOptions {
  db: Db;
  secretsKey: Buffer;
  config: CrmConfig;
  /** Replaces the provider OAuth clients (tests). */
  oauthFor?: (provider: CrmProvider) => CrmOAuth | undefined;
  now?: () => Date;
  logger?: CrmSyncLogger;
  /** One email to the workspace's admins when a reconnect is needed. */
  notifyReconnect?: (p: { workspaceId: string; provider: CrmProvider }) => Promise<void>;
  /** Per-run time budget of an incremental sync. */
  maxRunMs?: number;
  /** Per-run time budget of a preview or import (an import continues in the next claim). */
  maxImportMs?: number;
  /** Records per object per incremental run (the rest follows next run). */
  maxRecordsPerRun?: number;
}

export type RunOutcome =
  | "skipped"
  | "previewed"
  | "imported"
  | "import_continues"
  | "synced"
  | "refreshed"
  | "rate_limited"
  | "budget"
  | "reconnect"
  | "failed"
  | "lease_lost";

export interface CrmSyncSummary {
  claimed: number;
  outcomes: RunOutcome[];
}

export interface CrmSync {
  runOnce(batch?: number): Promise<CrmSyncSummary>;
  syncConnection(workspaceId: string, connectionId: string): Promise<RunOutcome>;
  /** Runs a pass soon (Sync now, preview, import) when the loop is running. */
  kick(): void;
  start(pollMs?: number): void;
  stop(): Promise<void>;
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}

/** A Postgres unique violation (23505), however the driver wraps it. */
function uniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/** SQL: a stored domain in match form (lower case, no leading www.). */
const domainKey = (column: unknown) => sql`regexp_replace(lower(${column}), '^www[0-9]?[.]', '')`;

const LOCKED_SQL = sql.raw(LOCKED_SUPPRESSION_REASONS.map((r) => `'${r}'`).join(", "));

/** Error text safe to log: codes only (DB errors carry parameters; CRM text is untrusted). */
function describe(error: unknown): string {
  const e = error as { name?: string; code?: string; query?: unknown; cause?: { code?: string } };
  if (error instanceof CrmError)
    return `CrmError(${error.kind}${error.status ? ` ${error.status}` : ""})`;
  if (e?.query !== undefined || e?.cause?.code || (e?.code && /^[0-9A-Z]{5}$/.test(e.code))) {
    return `${e?.name ?? "DatabaseError"} ${e?.cause?.code ?? e?.code ?? ""}`.trim();
  }
  return e?.name ?? "Error";
}

export function crmOptions(raw: Record<string, unknown> | null | undefined): CrmOptions {
  return { ...CRM_DEFAULT_OPTIONS, ...(raw ?? {}) } as CrmOptions;
}

// ----------------------------------------------------------------------------- run state

class RunState {
  counts: Record<string, Record<string, number>> = {};
  examples: Record<string, Record<string, string[]>> = {};
  conflicts: CrmConflictJson[] = [];
  conflictCount = 0;
  changed = 0;
  constructor(
    readonly id: string,
    readonly kind: "preview" | "import" | "incremental" | "reconcile",
  ) {}
  count(object: CrmObject, action: string, n = 1): void {
    const o = (this.counts[object] ??= {});
    o[action] = (o[action] ?? 0) + n;
  }
  example(object: CrmObject, bucket: string, id: string): void {
    const o = (this.examples[object] ??= {});
    const list = (o[bucket] ??= []);
    if (list.length < CRM_LIMITS.previewExamples) list.push(id);
  }
}

interface Ctx {
  ws: string;
  conn: CrmConnectionRow;
  provider: CrmProvider;
  api: CrmApi;
  meter: CallMeter;
  budget?: DailyBudget;
  options: CrmOptions;
  mappings: EffectiveMapping[];
  lk: Lookup & {
    setLink(object: CrmObject, localId: string, remoteId: string): void;
    dropLink(object: CrmObject, localId: string): void;
  };
  stageMappingComplete: boolean;
  suppressed: Map<string, string>;
  run: RunState;
  preview: boolean;
  deadline: number;
  renew(): Promise<void>;
  /** Remote ids handled in this run. */
  handled: Set<string>;
  /** Preview: Openline records a CRM record matched. */
  matched: Record<CrmObject, Set<string>>;
  /** Preview: match keys already seen, so a second CRM record with one is counted as import does. */
  seenKeys: Set<string>;
  /** Active Openline stages with no CRM stage (stage mapping drift). */
  unmappedStages: string[];
  importStartedAt?: Date;
  lastRenew: number;
}

class LeaseLost extends Error {}

type ConnPatch = {
  [K in keyof typeof crmConnections.$inferInsert]?: (typeof crmConnections.$inferInsert)[K] | SQL;
};

export function createCrmSync(options: CrmSyncOptions): CrmSync {
  const db = options.db;
  const now = options.now ?? (() => new Date());
  const log = options.logger ?? console;
  const maxRunMs = options.maxRunMs ?? 4 * MINUTE;
  const maxImportMs = options.maxImportMs ?? 9 * MINUTE;
  const maxRecords = options.maxRecordsPerRun ?? 5_000;
  const oauthCache = new Map<CrmProvider, CrmOAuth | undefined>();
  const oauthFor = (p: CrmProvider): CrmOAuth | undefined => {
    if (options.oauthFor) return options.oauthFor(p);
    if (!oauthCache.has(p)) oauthCache.set(p, createOAuth(options.config, p));
    return oauthCache.get(p);
  };
  const asWs = <T>(ws: string, fn: (tx: Tx) => Promise<T>) =>
    withTenant(db, { workspaceId: ws }, fn);

  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> | undefined;
  let stopped = true;
  let pollEvery = 15_000;

  // --------------------------------------------------------------------------- connection

  async function loadConn(ws: string, id: string): Promise<CrmConnectionRow | undefined> {
    const [row] = await asWs(ws, (tx) =>
      tx
        .select()
        .from(crmConnections)
        .where(and(eq(crmConnections.id, id), eq(crmConnections.workspaceId, ws))),
    );
    return row;
  }

  /**
   * Every engine write to the connection row. A disconnect (or uninstall) made meanwhile always
   * wins: a disconnected row is never written again, and status changes name the status they
   * expect to replace. Returns whether the row was written.
   */
  async function patchConn(
    ws: string,
    id: string,
    patch: ConnPatch,
    expected?: CrmConnectionStatus,
  ): Promise<boolean> {
    const rows = await asWs(ws, (tx) =>
      tx
        .update(crmConnections)
        .set({ ...patch, updatedAt: now() } as typeof crmConnections.$inferInsert)
        .where(
          and(
            eq(crmConnections.id, id),
            eq(crmConnections.workspaceId, ws),
            sql`${crmConnections.status} <> 'disconnected'`,
            expected ? eq(crmConnections.status, expected) : undefined,
          ),
        )
        .returning({ id: crmConnections.id }),
    );
    return rows.length > 0;
  }

  /** Renews the lease while the connection is still in the status the run started with. */
  async function renewLease(ws: string, id: string, status: CrmConnectionStatus): Promise<boolean> {
    const rows = await asWs(ws, (tx) =>
      tx
        .update(crmConnections)
        .set({ syncLockedUntil: LEASE })
        .where(
          and(
            eq(crmConnections.id, id),
            eq(crmConnections.workspaceId, ws),
            eq(crmConnections.status, status),
            sql`(${crmConnections.syncLockedUntil} IS NULL OR ${crmConnections.syncLockedUntil} > now())`,
          ),
        )
        .returning({ id: crmConnections.id }),
    );
    return rows.length > 0;
  }

  /** Opens the sealed tokens, refreshing (and re-sealing, rotation-safe) when they are about to expire. */
  async function session(conn: CrmConnectionRow, force = false) {
    const oauth = oauthFor(conn.provider);
    if (!oauth) throw new CrmError("forbidden_host", "This CRM isn't configured on this server");
    let secret = openJson<CrmSecret>(conn.secretSealed, options.secretsKey, conn.workspaceId);
    if (force || secret.accessExpiresAt - now().getTime() < 2 * MINUTE) {
      const t = await oauth.refresh(secret.refreshToken);
      secret = {
        kind: "oauth",
        refreshToken: t.refreshToken,
        accessToken: t.accessToken,
        accessExpiresAt: t.accessExpiresAt,
      };
      const sealed = sealJson(secret, options.secretsKey, conn.workspaceId);
      // Store the rotated refresh token at once: the old one no longer works. A disconnect made
      // meanwhile wins: the tokens are never written back.
      if (!(await patchConn(conn.workspaceId, conn.id, { secretSealed: sealed })))
        throw new LeaseLost();
      conn.secretSealed = sealed;
    }
    const opts = crmOptions(conn.options);
    const meter: CallMeter = { calls: 0, tokens: 0 };
    let budget: DailyBudget | undefined;
    if (conn.provider === "pipedrive") {
      budget = new DailyBudget(
        conn.budgetDay ?? DailyBudget.today(now()),
        conn.budgetSpent,
        opts.pipedriveDailyCap,
      );
    }
    const api = oauth.api({
      accessToken: secret.accessToken,
      apiDomain: conn.apiDomain,
      portalId: conn.accountMeta.portalId ?? null,
      meter,
      limiterKey: conn.id,
      spend: budget
        ? (cost) => {
            budget!.roll(now());
            if (!budget!.canSpend(cost)) throw new CrmError("budget", "Daily API budget used up");
            budget!.spend(cost);
          }
        : undefined,
    });
    return {
      api,
      meter,
      budget,
      options: opts,
      oauth,
      budgetStart: budget ? { day: budget.day, spent: budget.spent } : null,
    };
  }

  /**
   * The Pipedrive spend to save: an increment on what is stored, so spend saved by others meanwhile
   * (setup calls made through the API) is kept. Saving twice never counts twice.
   */
  function budgetPatch(s: Awaited<ReturnType<typeof session>>): ConnPatch {
    const b = s.budget;
    if (!b || !s.budgetStart) return {};
    if (b.day !== s.budgetStart.day) {
      s.budgetStart = { day: b.day, spent: b.spent };
      return { budgetDay: b.day, budgetSpent: b.spent };
    }
    const delta = b.spent - s.budgetStart.spent;
    s.budgetStart = { day: b.day, spent: b.spent };
    return {
      budgetDay: b.day,
      budgetSpent: sql`CASE WHEN ${crmConnections.budgetDay} = ${b.day}::date THEN ${crmConnections.budgetSpent} + ${delta} ELSE ${b.spent} END`,
    };
  }

  // --------------------------------------------------------------------------- lookups

  async function buildCtx(
    conn: CrmConnectionRow,
    s: Awaited<ReturnType<typeof session>>,
    run: RunState,
    preview: boolean,
    deadline: number,
  ): Promise<Ctx> {
    const ws = conn.workspaceId;
    const data = await asWs(ws, async (tx) => {
      const links = await tx
        .select({
          object: crmLinks.object,
          contactId: crmLinks.contactId,
          companyId: crmLinks.companyId,
          dealId: crmLinks.dealId,
          externalId: crmLinks.externalId,
        })
        .from(crmLinks)
        .where(
          and(
            eq(crmLinks.workspaceId, ws),
            eq(crmLinks.connectionId, conn.id),
            eq(crmLinks.state, "linked"),
          ),
        );
      const members = await tx
        .select({ id: users.id, email: users.email })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(eq(workspaceMembers.workspaceId, ws));
      const mappingRows = await tx
        .select()
        .from(crmFieldMappings)
        .where(
          and(eq(crmFieldMappings.workspaceId, ws), eq(crmFieldMappings.connectionId, conn.id)),
        );
      const stageRows = await tx
        .select()
        .from(crmStageMappings)
        .where(
          and(eq(crmStageMappings.workspaceId, ws), eq(crmStageMappings.connectionId, conn.id)),
        );
      const stages = await tx
        .select({
          id: pipelineStages.id,
          kind: pipelineStages.kind,
          archivedAt: pipelineStages.archivedAt,
        })
        .from(pipelineStages)
        .where(eq(pipelineStages.workspaceId, ws));
      const supp = await tx
        .select({ value: suppressions.value, reason: suppressions.reason })
        .from(suppressions)
        .where(eq(suppressions.workspaceId, ws));
      const [wsRow] = await tx
        .execute(sql`SELECT currency FROM workspaces WHERE id = ${ws}`)
        .then((r) => rowsOf<{ currency: string }>(r));
      return {
        links,
        members,
        mappingRows,
        stageRows,
        stages,
        supp,
        currency: wsRow?.currency ?? "USD",
      };
    });

    const l2r: Record<CrmObject, Map<string, string>> = {
      contact: new Map(),
      company: new Map(),
      deal: new Map(),
    };
    const r2l: Record<CrmObject, Map<string, string>> = {
      contact: new Map(),
      company: new Map(),
      deal: new Map(),
    };
    for (const l of data.links) {
      const local = l.contactId ?? l.companyId ?? l.dealId;
      if (!local || !l.externalId) continue;
      l2r[l.object].set(local, l.externalId);
      r2l[l.object].set(l.externalId, local);
    }
    const emailOfUser = new Map(data.members.map((m) => [m.id, m.email.toLowerCase()]));
    const userOfEmail = new Map(data.members.map((m) => [m.email.toLowerCase(), m.id]));
    const owners = await s.api.owners();
    const ownerOfEmail = new Map(owners.map((o) => [o.email, o.id]));
    const emailOfOwner = new Map(owners.map((o) => [o.id, o.email]));
    const from = new Map(
      data.stageRows
        .filter((r) => r.direction === "from_crm")
        .map((r) => [r.remoteStageId, r.stageId]),
    );
    const to = new Map(
      data.stageRows
        .filter((r) => r.direction === "to_crm")
        .map((r) => [r.stageId, r.remoteStageId]),
    );
    const kinds = new Map(data.stages.map((st) => [st.id, st.kind]));
    const activeStages = data.stages.filter((st) => !st.archivedAt);
    const unmappedStages = activeStages.filter((st) => !to.has(st.id)).map((st) => st.id);
    const stageMappingComplete =
      !!conn.pipelineId && conn.stageMappingComplete && !unmappedStages.length && from.size > 0;

    let defaultOwnerId = conn.defaultOwnerId ?? conn.connectedBy;
    if (defaultOwnerId && !emailOfUser.has(defaultOwnerId)) defaultOwnerId = null;
    defaultOwnerId ??= data.members[0]?.id ?? null;

    const lk: Ctx["lk"] = {
      remoteIdOf: (o, id) => l2r[o].get(id) ?? null,
      localIdOf: (o, id) => r2l[o].get(id) ?? null,
      emailOfUser: (id) => emailOfUser.get(id) ?? null,
      userOfEmail: (e) => userOfEmail.get(e.toLowerCase()) ?? null,
      remoteOwnerOfEmail: (e) => ownerOfEmail.get(e.toLowerCase()) ?? null,
      emailOfRemoteOwner: (id) => emailOfOwner.get(id) ?? null,
      stageFrom: (r) => from.get(r) ?? null,
      stageTo: (l) => to.get(l) ?? null,
      stageKind: (l) => kinds.get(l) ?? null,
      defaultOwnerId,
      currencies: conn.accountMeta.currencies ?? null,
      defaultCurrency: conn.accountMeta.defaultCurrency ?? data.currency,
      providerLabel: CRM_PROVIDER_LABELS[conn.provider],
      setLink(o, local, remote) {
        l2r[o].set(local, remote);
        r2l[o].set(remote, local);
      },
      dropLink(o, local) {
        const remote = l2r[o].get(local);
        l2r[o].delete(local);
        if (remote) r2l[o].delete(remote);
      },
    };
    const rows: MappingRow[] = data.mappingRows.length
      ? data.mappingRows
      : defaultMappings(conn.provider);
    const ctx: Ctx = {
      ws,
      conn,
      provider: conn.provider,
      api: s.api,
      meter: s.meter,
      budget: s.budget,
      options: s.options,
      // Key and consent fields never sync through a mapping (defence in depth: the API refuses them).
      mappings: effectiveMappings(
        rows.filter(
          (r) => !r.remoteField || !reservedRemoteField(conn.provider, r.object, r.remoteField),
        ),
        (o) => s.api.nativeFields(o),
      ),
      lk,
      stageMappingComplete,
      suppressed: new Map(data.supp.map((r) => [r.value, r.reason])),
      run,
      preview,
      deadline,
      handled: new Set(),
      matched: { contact: new Set(), company: new Set(), deal: new Set() },
      seenKeys: new Set(),
      unmappedStages: conn.pipelineId && conn.stageMappingComplete ? unmappedStages : [],
      lastRenew: Date.now(),
      renew: async () => {
        if (!(await renewLease(ws, conn.id, conn.status))) throw new LeaseLost();
        ctx.lastRenew = Date.now();
      },
    };
    return ctx;
  }

  // --------------------------------------------------------------------------- local rows

  const contactCols = {
    id: contacts.id,
    email: contacts.email,
    firstName: contacts.firstName,
    lastName: contacts.lastName,
    title: contacts.title,
    phone: contacts.phone,
    companyId: contacts.companyId,
    ownerId: contacts.ownerId,
    custom: contacts.custom,
    status: contacts.status,
    updatedAt: contacts.updatedAt,
  };
  const companyCols = {
    id: companies.id,
    name: companies.name,
    domain: companies.domain,
    custom: companies.custom,
    updatedAt: companies.updatedAt,
  };
  const dealCols = {
    id: deals.id,
    name: deals.name,
    amountMinor: deals.amountMinor,
    currency: deals.currency,
    stageId: deals.stageId,
    expectedCloseDate: deals.expectedCloseDate,
    lostReason: deals.lostReason,
    companyId: deals.companyId,
    primaryContactId: deals.primaryContactId,
    ownerId: deals.ownerId,
    updatedAt: deals.updatedAt,
  };

  async function localRows(
    tx: Tx,
    ws: string,
    object: CrmObject,
    ids: string[],
  ): Promise<LocalRow[]> {
    if (!ids.length) return [];
    if (object === "contact") {
      return tx
        .select(contactCols)
        .from(contacts)
        .where(and(eq(contacts.workspaceId, ws), inArray(contacts.id, ids)));
    }
    if (object === "company") {
      return tx
        .select(companyCols)
        .from(companies)
        .where(and(eq(companies.workspaceId, ws), inArray(companies.id, ids)));
    }
    return tx
      .select(dealCols)
      .from(deals)
      .where(and(eq(deals.workspaceId, ws), inArray(deals.id, ids)));
  }

  async function localChangedSince(
    ws: string,
    object: CrmObject,
    since: Date,
    limit: number,
  ): Promise<LocalRow[]> {
    return asWs(ws, async (tx) => {
      if (object === "contact") {
        return tx
          .select(contactCols)
          .from(contacts)
          .where(and(eq(contacts.workspaceId, ws), gte(contacts.updatedAt, since)))
          .orderBy(asc(contacts.updatedAt), asc(contacts.id))
          .limit(limit);
      }
      if (object === "company") {
        return tx
          .select(companyCols)
          .from(companies)
          .where(and(eq(companies.workspaceId, ws), gte(companies.updatedAt, since)))
          .orderBy(asc(companies.updatedAt), asc(companies.id))
          .limit(limit);
      }
      return tx
        .select(dealCols)
        .from(deals)
        .where(and(eq(deals.workspaceId, ws), gte(deals.updatedAt, since)))
        .orderBy(asc(deals.updatedAt), asc(deals.id))
        .limit(limit);
    });
  }

  function linkColumn(object: CrmObject) {
    return object === "contact"
      ? crmLinks.contactId
      : object === "company"
        ? crmLinks.companyId
        : crmLinks.dealId;
  }
  function linkLocal(l: CrmLinkRow): string | null {
    return l.contactId ?? l.companyId ?? l.dealId;
  }

  async function linkByExternal(
    ctx: Ctx,
    object: CrmObject,
    externalId: string,
  ): Promise<CrmLinkRow | undefined> {
    const [row] = await asWs(ctx.ws, (tx) =>
      tx
        .select()
        .from(crmLinks)
        .where(
          and(
            eq(crmLinks.workspaceId, ctx.ws),
            eq(crmLinks.connectionId, ctx.conn.id),
            eq(crmLinks.object, object),
            eq(crmLinks.externalId, externalId),
          ),
        ),
    );
    return row;
  }

  async function linksByLocal(
    ctx: Ctx,
    object: CrmObject,
    ids: string[],
  ): Promise<Map<string, CrmLinkRow>> {
    if (!ids.length) return new Map();
    const rows = await asWs(ctx.ws, (tx) =>
      tx
        .select()
        .from(crmLinks)
        .where(
          and(
            eq(crmLinks.workspaceId, ctx.ws),
            eq(crmLinks.connectionId, ctx.conn.id),
            inArray(linkColumn(object), ids),
          ),
        ),
    );
    return new Map(rows.map((r) => [linkLocal(r)!, r]));
  }

  // --------------------------------------------------------------------------- errors

  async function recordError(
    ctx: Ctx,
    e: {
      object: CrmObject;
      localId?: string | null;
      externalId?: string | null;
      direction: "to_crm" | "from_crm";
      code: string;
      message: string;
      /** Admin-only errors never retry by themselves. */
      noRetry?: boolean;
    },
  ): Promise<void> {
    if (ctx.preview) return;
    ctx.run.count(e.object, "errors");
    const t = now();
    const message = e.message.slice(0, CRM_LIMITS.errorMessageMax);
    await asWs(ctx.ws, async (tx) => {
      const [open] = await tx
        .select()
        .from(crmSyncErrors)
        .where(
          and(
            eq(crmSyncErrors.workspaceId, ctx.ws),
            eq(crmSyncErrors.connectionId, ctx.conn.id),
            eq(crmSyncErrors.object, e.object),
            eq(crmSyncErrors.code, e.code),
            isNull(crmSyncErrors.resolvedAt),
            e.localId
              ? eq(crmSyncErrors.localId, e.localId)
              : sql`${crmSyncErrors.externalId} = ${e.externalId ?? ""}`,
          ),
        )
        .limit(1);
      if (open) {
        const attempts = open.attempts + 1;
        await tx
          .update(crmSyncErrors)
          .set({ attempts, nextRetryAt: e.noRetry ? null : recordRetryAt(attempts, t) })
          .where(and(eq(crmSyncErrors.id, open.id), eq(crmSyncErrors.workspaceId, ctx.ws)));
        return;
      }
      await tx.insert(crmSyncErrors).values({
        workspaceId: ctx.ws,
        connectionId: ctx.conn.id,
        runId: ctx.run.id,
        object: e.object,
        localId: e.localId ?? null,
        externalId: e.externalId ?? null,
        direction: e.direction,
        code: e.code,
        message,
        attempts: 1,
        nextRetryAt: e.noRetry ? null : recordRetryAt(1, t),
      });
    });
  }

  async function resolveErrors(
    ctx: Ctx,
    object: CrmObject,
    localId: string | null,
    externalId: string | null,
    codes?: string[],
  ) {
    if (ctx.preview) return;
    await asWs(ctx.ws, (tx) =>
      tx
        .update(crmSyncErrors)
        .set({ resolvedAt: now(), resolution: "fixed" })
        .where(
          and(
            eq(crmSyncErrors.workspaceId, ctx.ws),
            eq(crmSyncErrors.connectionId, ctx.conn.id),
            eq(crmSyncErrors.object, object),
            isNull(crmSyncErrors.resolvedAt),
            codes
              ? inArray(crmSyncErrors.code, codes)
              : sql`${crmSyncErrors.code} NOT IN ('merge_conflict', 'unconfirmed')`,
            or(
              localId ? eq(crmSyncErrors.localId, localId) : sql`false`,
              externalId ? eq(crmSyncErrors.externalId, externalId) : sql`false`,
            ),
          ),
        ),
    );
  }

  /** Per-record CRM failures become sync errors; run-level ones propagate. */
  function recordLevel(error: unknown): error is CrmError {
    return error instanceof CrmError && (error.kind === "validation" || error.kind === "not_found");
  }

  // --------------------------------------------------------------------------- opt-outs

  /**
   * The suppression that covers an email: the exact address or its whole @domain (the same rule
   * the sending engine applies, packages/compliance). Undefined = not suppressed.
   */
  function suppressionOf(ctx: Ctx, email: string): string | undefined {
    // The rule only calls has(): the value → reason map answers it as a set of values would.
    if (!suppressedBy(email, ctx.suppressed as unknown as ReadonlySet<string>)) return undefined;
    const e = email.trim().toLowerCase();
    return ctx.suppressed.get(e) ?? ctx.suppressed.get(e.slice(e.lastIndexOf("@"))) ?? "invalid";
  }
  const isSuppressed = (ctx: Ctx, email: string) => suppressionOf(ctx, email) !== undefined;
  const locked = (reason: string | undefined) =>
    !!reason && (LOCKED_SUPPRESSION_REASONS as readonly string[]).includes(reason);

  /**
   * CRM opt-out → locked crm_unsubscribed suppression for the address: a new row, or an unlocked
   * one (manual, bounced, …) upgraded. Locked rows are never rewritten. Returns whether it wrote.
   */
  async function upsertCrmOptOut(ctx: Ctx, tx: Tx, email: string): Promise<boolean> {
    if (locked(ctx.suppressed.get(email))) return false;
    const rows = await tx
      .insert(suppressions)
      .values({ workspaceId: ctx.ws, value: email, reason: "crm_unsubscribed" })
      .onConflictDoUpdate({
        target: [suppressions.workspaceId, suppressions.value],
        set: { reason: "crm_unsubscribed" },
        setWhere: sql`${suppressions.reason} NOT IN (${LOCKED_SQL})`,
      })
      .returning({ id: suppressions.id });
    ctx.suppressed.set(email, "crm_unsubscribed");
    if (rows.length) ctx.run.count("contact", "optouts_pulled");
    return rows.length > 0;
  }

  /** CRM opt-out on a linked contact. Never the other way round (no re-subscribe path). */
  async function pullOptOut(ctx: Ctx, tx: Tx, contactId: string, email: string): Promise<void> {
    const wrote = await upsertCrmOptOut(ctx, tx, email);
    // Whatever the suppression already was, the contact is unsubscribed (archived stays archived).
    await tx
      .update(contacts)
      .set({ status: "unsubscribed", updatedAt: now() })
      .where(
        and(
          eq(contacts.id, contactId),
          eq(contacts.workspaceId, ctx.ws),
          inArray(contacts.status, ["active", "bounced"]),
        ),
      );
    if (!wrote) return;
    await tx.insert(auditLog).values({
      workspaceId: ctx.ws,
      actorId: null,
      action: "contact.suppressed",
      entity: "contact",
      entityId: contactId,
      metadata: { source: "crm", provider: ctx.provider, reason: "crm_unsubscribed" },
    });
  }

  /**
   * Runs one record's work. A unique violation inside it (the value is held by another Openline
   * record) becomes a record-level error; the run goes on.
   */
  async function perRecord(
    ctx: Ctx,
    e: {
      object: CrmObject;
      localId?: string | null;
      externalId?: string | null;
      direction: "to_crm" | "from_crm";
    },
    fn: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await fn();
    } catch (error) {
      if (!uniqueViolation(error)) throw error;
      ctx.run.count(e.object, "skipped_invalid");
      await recordError(ctx, {
        ...e,
        code: "duplicate_value",
        message:
          "Another Openline record already holds a value this record needs (for example the same domain), so it wasn't synced.",
      });
    }
  }

  /**
   * Stage mapping drift: an active Openline stage with no CRM stage, or a CRM deal in a stage that
   * isn't mapped. Deal sync waits ("Stage mapping needs attention"); contacts and companies go on.
   */
  async function flagStageDrift(
    ctx: Ctx,
    where: { localStageIds?: string[]; externalDealId?: string },
  ): Promise<void> {
    ctx.stageMappingComplete = false;
    if (ctx.preview) return;
    if (ctx.conn.stageMappingComplete) {
      ctx.conn.stageMappingComplete = false;
      await patchConn(ctx.ws, ctx.conn.id, { stageMappingComplete: false });
    }
    const label = ctx.lk.providerLabel;
    for (const stageId of where.localStageIds ?? []) {
      await recordError(ctx, {
        object: "deal",
        localId: stageId,
        direction: "to_crm",
        code: "stage_unmapped",
        message: `An Openline pipeline stage isn't mapped to a ${label} stage. Deal sync waits until the stage mapping is updated.`,
        noRetry: true,
      });
    }
    if (where.externalDealId) {
      await recordError(ctx, {
        object: "deal",
        externalId: where.externalDealId,
        direction: "from_crm",
        code: "stage_unmapped",
        message: `This ${label} deal is in a stage that isn't mapped to an Openline stage. Deal sync waits until the stage mapping is updated.`,
        noRetry: true,
      });
    }
  }

  async function resolveStageDrift(ctx: Ctx): Promise<void> {
    await asWs(ctx.ws, (tx) =>
      tx
        .update(crmSyncErrors)
        .set({ resolvedAt: now(), resolution: "fixed", nextRetryAt: null })
        .where(
          and(
            eq(crmSyncErrors.workspaceId, ctx.ws),
            eq(crmSyncErrors.connectionId, ctx.conn.id),
            eq(crmSyncErrors.code, "stage_unmapped"),
            isNull(crmSyncErrors.resolvedAt),
          ),
        ),
    );
  }

  async function warn(ctx: Ctx, warning: string): Promise<void> {
    if (ctx.conn.warnings.includes(warning)) return;
    ctx.conn.warnings = [...ctx.conn.warnings, warning];
    await patchConn(ctx.ws, ctx.conn.id, { warnings: ctx.conn.warnings });
  }

  const canPushOptOut = (ctx: Ctx) =>
    ctx.provider !== "hubspot" || ctx.conn.scopes.includes("communication_preferences.write");

  // --------------------------------------------------------------------------- pair sync

  /**
   * Syncs one linked pair field by field. Remote write first (network, no transaction), then the
   * local patch and the new shadow in one transaction.
   */
  async function syncPair(
    ctx: Ctx,
    object: CrmObject,
    link: CrmLinkRow,
    local: LocalRow,
    rec: RemoteRecord,
  ): Promise<void> {
    const shadow = { ...link.shadow };
    const remoteFields: Record<string, string | null> = {};
    const assoc: { companyId?: string; contactId?: string } = {};
    const pushedHashes: Record<string, string> = {};
    const newShadow: Record<string, string> = {};
    let localPatch: Record<string, unknown> = {};
    let fieldError: { code: string; message: string; direction: "to_crm" | "from_crm" } | null =
      null;

    for (const m of ctx.mappings.filter((x) => x.object === object)) {
      if (object === "deal" && m.field === "stage" && !ctx.stageMappingComplete) continue;
      const lv = localValue(m, local, ctx.lk);
      const rv = remoteValue(m, rec, ctx.lk);
      if (lv === SKIP || rv === SKIP) continue;
      const lh = fieldHash(m.field, lv);
      const rh = fieldHash(m.field, rv);
      const decision = decideField({
        shadow: shadow[m.field],
        localHash: lh,
        remoteHash: rh,
        localEmpty: lv === null,
        remoteEmpty: rv === null,
        direction: m.direction,
        sourceOfTruth: m.sourceOfTruth,
        localAt: local.updatedAt,
        remoteAt: rec.modifiedAt,
        // Pipedrive reports whole seconds: compare at that resolution (ties go to the CRM).
        resolutionMs: ctx.provider === "pipedrive" ? 1000 : 1,
      });
      if (decision.conflict) {
        ctx.run.conflictCount += 1;
        if (ctx.run.conflicts.length < 200) {
          ctx.run.conflicts.push({
            object,
            field: m.field,
            winner: decision.conflict.winner,
            localAt: local.updatedAt.toISOString(),
            remoteAt: rec.modifiedAt.toISOString(),
            rule: decision.conflict.rule,
          });
        }
      }
      if (decision.action === "adopt") newShadow[m.field] = lh;
      else if (decision.action === "pull") {
        const patch =
          m.field === "lostReason" && rv === null ? null : pullFor(m, rv, local, rec, ctx.lk);
        if (patch && object === "company" && m.field === "domain" && rv !== null) {
          if (await domainTaken(ctx, rv, local.id)) {
            // Another Openline company holds this domain: keep ours, flag the record.
            fieldError = {
              code: "domain_taken",
              direction: "from_crm",
              message: `Another Openline company already has this domain, so the domain from ${ctx.lk.providerLabel} wasn't applied.`,
            };
            continue;
          }
        }
        if (patch) {
          localPatch = { ...localPatch, ...patch };
          newShadow[m.field] = rh;
        }
      } else if (decision.action === "push") {
        const p = pushFor(m, lv, ctx.lk);
        if (p.kind === "fields") {
          Object.assign(remoteFields, p.fields);
          pushedHashes[m.field] = lh;
        } else if (p.kind === "assoc") {
          Object.assign(assoc, p);
          delete (assoc as { kind?: string }).kind;
          pushedHashes[m.field] = lh;
        } else if (p.kind === "error") {
          fieldError = { code: p.code, message: p.message, direction: "to_crm" };
        }
      }
    }

    // Opt-outs: outside the field rule. Pull CRM opt-outs; push ours once; never re-subscribe.
    let pushOptOut = false;
    if (object === "contact") {
      const email = (local as LocalContactRow).email;
      const reason = suppressionOf(ctx, email);
      if (
        reason &&
        PUSHED_OPTOUT_REASONS.includes(reason) &&
        !rec.optedOut &&
        !shadow[OPTOUT_MARK]
      ) {
        pushOptOut = true;
      }
    }

    let remoteFailed = false;
    if (Object.keys(remoteFields).length || Object.keys(assoc).length || pushOptOut) {
      // Still ours to write? (A pause or disconnect meanwhile stops the run here.)
      await ctx.renew();
      try {
        if (Object.keys(remoteFields).length) await ctx.api.update(object, rec.id, remoteFields);
        if (Object.keys(assoc).length) await ctx.api.associate(object, rec.id, assoc);
        if (Object.keys(remoteFields).length || Object.keys(assoc).length)
          ctx.run.count(object, "pushed");
        Object.assign(newShadow, pushedHashes);
      } catch (error) {
        if (!recordLevel(error)) throw error;
        remoteFailed = true;
        await recordError(ctx, {
          object,
          localId: local.id,
          externalId: rec.id,
          direction: "to_crm",
          code: error.kind === "not_found" ? "not_found" : "remote_rejected",
          message: `${ctx.lk.providerLabel} rejected the update to this record.`,
        });
      }
      if (pushOptOut) {
        if (!canPushOptOut(ctx))
          await warn(ctx, `Opt-outs are not being sent to ${ctx.lk.providerLabel}`);
        else {
          const result = await ctx.api.optOut(rec.id, (local as LocalContactRow).email);
          if (result === "done") {
            newShadow[OPTOUT_MARK] = "1";
            ctx.run.count("contact", "optouts_pushed");
          } else if (result === "not_permitted") {
            await warn(ctx, `Opt-outs are not being sent to ${ctx.lk.providerLabel}`);
          } else {
            await warn(
              ctx,
              `${ctx.lk.providerLabel} can't record opt-outs for this account (Campaigns is off)`,
            );
            newShadow[OPTOUT_MARK] = "0";
          }
        }
      }
    }

    await asWs(ctx.ws, async (tx) => {
      if (Object.keys(localPatch).length) {
        await applyLocalPatch(ctx, tx, object, local, localPatch);
        ctx.run.count(object, "pulled");
      }
      if (object === "contact" && rec.optedOut) {
        await pullOptOut(ctx, tx, local.id, (local as LocalContactRow).email);
      }
      if (object === "deal" && rec.contactIds?.length) {
        await addDealContacts(ctx, tx, local.id, rec.contactIds);
      }
      await tx
        .update(crmLinks)
        .set({
          shadow: { ...shadow, ...newShadow },
          state: "linked",
          reason: null,
          remoteModifiedAt: rec.modifiedAt,
          syncedAt: now(),
          updatedAt: now(),
        })
        .where(and(eq(crmLinks.id, link.id), eq(crmLinks.workspaceId, ctx.ws)));
    });

    if (
      !Object.keys(localPatch).length &&
      !Object.keys(remoteFields).length &&
      !Object.keys(assoc).length
    ) {
      ctx.run.count(object, "unchanged");
    } else ctx.run.changed += 1;

    if (fieldError) {
      await recordError(ctx, { object, localId: local.id, externalId: rec.id, ...fieldError });
    } else if (!remoteFailed) {
      await resolveErrors(ctx, object, local.id, rec.id);
    }
  }

  /** Whether another Openline company already holds this (normalized) domain. */
  async function domainTaken(ctx: Ctx, domain: string, exceptId: string): Promise<boolean> {
    const [row] = await asWs(ctx.ws, (tx) =>
      tx
        .select({ id: companies.id })
        .from(companies)
        .where(
          and(
            eq(companies.workspaceId, ctx.ws),
            sql`${domainKey(companies.domain)} = ${domain}`,
            sql`${companies.id} <> ${exceptId}`,
          ),
        )
        .limit(1),
    );
    return !!row;
  }

  async function addDealContacts(ctx: Ctx, tx: Tx, dealId: string, remoteContactIds: string[]) {
    const local = remoteContactIds
      .map((id) => ctx.lk.localIdOf("contact", id))
      .filter((x): x is string => !!x)
      .slice(0, CRM_LIMITS.dealContactsMax);
    if (!local.length) return;
    const [counted] = rowsOf<{ n: number }>(
      await tx.execute(
        sql`SELECT count(*)::int AS n FROM deal_contacts WHERE workspace_id = ${ctx.ws} AND deal_id = ${dealId}`,
      ),
    );
    const room = Math.max(0, CRM_LIMITS.dealContactsMax - Number(counted?.n ?? 0));
    if (!room) return;
    await tx
      .insert(dealContacts)
      .values(local.slice(0, room).map((contactId) => ({ workspaceId: ctx.ws, dealId, contactId })))
      .onConflictDoNothing();
  }

  async function applyLocalPatch(
    ctx: Ctx,
    tx: Tx,
    object: CrmObject,
    local: LocalRow,
    patch: Record<string, unknown>,
  ) {
    const t = now();
    const custom: Record<string, unknown> = {};
    const cols: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (k.startsWith("custom.")) custom[k.slice(7)] = v;
      else cols[k] = v;
    }
    const customSql = Object.keys(custom).length
      ? sql`custom || ${JSON.stringify(custom)}::jsonb`
      : undefined;
    if (object === "contact") {
      await tx
        .update(contacts)
        .set({ ...cols, ...(customSql ? { custom: customSql } : {}), updatedAt: t } as never)
        .where(and(eq(contacts.id, local.id), eq(contacts.workspaceId, ctx.ws)));
    } else if (object === "company") {
      await tx
        .update(companies)
        .set({ ...cols, ...(customSql ? { custom: customSql } : {}), updatedAt: t } as never)
        .where(and(eq(companies.id, local.id), eq(companies.workspaceId, ctx.ws)));
    } else {
      const deal = local as LocalDealRow;
      const next = cols.stageId as string | undefined;
      if (next && next !== deal.stageId) {
        const kind = ctx.lk.stageKind(next);
        cols.stageEnteredAt = t;
        cols.closedAt = kind === "open" ? null : t;
        if (kind === "lost" && !cols.lostReason && !deal.lostReason) {
          cols.lostReason = `Not given (from ${ctx.lk.providerLabel})`;
        }
        await tx.insert(dealStageHistory).values({
          workspaceId: ctx.ws,
          dealId: deal.id,
          fromStageId: deal.stageId,
          toStageId: next,
          movedBy: null,
          movedAt: t,
        });
      }
      // Pulled writes are the sync actor's: last_activity_at is not touched.
      await tx
        .update(deals)
        .set({ ...cols, updatedAt: t } as never)
        .where(and(eq(deals.id, local.id), eq(deals.workspaceId, ctx.ws)));
    }
  }

  // --------------------------------------------------------------------------- remote records

  /** First link of an existing CRM record, or creation of a new Openline record. */
  async function importRemote(ctx: Ctx, object: CrmObject, rec: RemoteRecord): Promise<void> {
    const { run } = ctx;
    const bucket = (b: string, id = rec.id) => {
      run.count(object, b);
      if (ctx.preview) run.example(object, b, id);
      if (b === "link") ctx.matched[object].add(id);
    };
    if (rec.archived) return;

    if (object === "deal") {
      if (rec.pipelineId !== ctx.conn.pipelineId) return bucket("skipped_other_pipeline");
      if (!ctx.stageMappingComplete) return bucket("skipped_invalid");
      const stageM = ctx.mappings.find((m) => m.object === "deal" && m.field === "stage");
      const stage = stageM ? remoteValue(stageM, rec, ctx.lk) : SKIP;
      if (stage === SKIP || stage === null || !ctx.lk.defaultOwnerId)
        return bucket("skipped_invalid");
      // Deals have no natural key. On (re-)import — e.g. after "forget links" — an unlinked
      // Openline deal with exactly this name (and amount / close date, where both have one)
      // is the same deal: link it instead of creating a second copy.
      if (ctx.preview || ctx.run.kind === "import") {
        const same = await sameLocalDeal(ctx, rec);
        if (same) {
          bucket("link", same.id);
          if (ctx.preview) return;
          await linkAndSync(ctx, object, same, rec);
          return;
        }
      }
      bucket("create");
      if (ctx.preview) return;
      const name = cleanText(rec.fields.name, CRM_LIMITS.nameMax) ?? "Untitled deal";
      const created = await asWs(ctx.ws, async (tx) => {
        const [d] = await tx
          .insert(deals)
          .values({
            workspaceId: ctx.ws,
            name,
            ownerId: ctx.lk.defaultOwnerId!,
            stageId: stage,
            currency: ctx.lk.defaultCurrency,
            closedAt: ctx.lk.stageKind(stage) === "open" ? null : now(),
            lostReason:
              ctx.lk.stageKind(stage) === "lost" && !cleanText(rec.fields.lostReason, 500)
                ? `Not given (from ${ctx.lk.providerLabel})`
                : null,
            createdAt: now(),
            updatedAt: new Date(0),
          })
          .returning(dealCols);
        await tx
          .insert(dealStageHistory)
          .values({ workspaceId: ctx.ws, dealId: d!.id, fromStageId: null, toStageId: stage });
        const [link] = await tx
          .insert(crmLinks)
          .values({
            workspaceId: ctx.ws,
            connectionId: ctx.conn.id,
            object,
            dealId: d!.id,
            externalId: rec.id,
          })
          .returning();
        return { row: d!, link: link! };
      });
      ctx.lk.setLink(object, created.row.id, rec.id);
      await syncPair(ctx, object, created.link, created.row, rec);
      return;
    }

    if (object === "contact") {
      const email = cleanEmail(rec.fields.email);
      if (!email) return bucket("skipped_no_email");
      if (ctx.preview) {
        // A second CRM record with an email seen already: the import links the first and flags
        // this one (merge_conflict), so the preview counts it the same way.
        if (ctx.seenKeys.has(`contact:${email}`)) return bucket("skipped_invalid");
        ctx.seenKeys.add(`contact:${email}`);
      }
      const [existing] = await asWs(ctx.ws, (tx) =>
        tx
          .select(contactCols)
          .from(contacts)
          .where(and(eq(contacts.workspaceId, ctx.ws), eq(contacts.email, email))),
      );
      if (existing) {
        if (ctx.lk.remoteIdOf("contact", existing.id)) {
          bucket("skipped_invalid");
          await recordError(ctx, {
            object,
            localId: existing.id,
            externalId: rec.id,
            direction: "from_crm",
            code: "merge_conflict",
            message: `Two ${ctx.lk.providerLabel} records match this contact's email; Openline never merges automatically.`,
            noRetry: true,
          });
          return;
        }
        bucket("link", existing.id);
        if (ctx.preview) return;
        await linkAndSync(ctx, object, existing, rec);
        return;
      }
      if (isSuppressed(ctx, email) || rec.optedOut) {
        bucket("skipped_suppressed_new");
        // Not imported, but a CRM opt-out still becomes a locked suppression for the address.
        if (!ctx.preview && rec.optedOut) {
          await asWs(ctx.ws, (tx) => upsertCrmOptOut(ctx, tx, email));
        }
        return;
      }
      bucket("create");
      if (ctx.preview) return;
      const [row] = await asWs(ctx.ws, (tx) =>
        tx
          .insert(contacts)
          // Pulled contacts start with no consent basis (lawful basis confirmed at import).
          .values({ workspaceId: ctx.ws, email, consentBasis: "none", updatedAt: new Date(0) })
          .onConflictDoNothing()
          .returning(contactCols),
      );
      if (!row) return;
      await linkAndSync(ctx, object, row, rec);
      return;
    }

    // company
    const domainM = ctx.mappings.find((m) => m.object === "company" && m.field === "domain");
    const domain = domainM ? remoteValue(domainM, rec, ctx.lk) : null;
    const name = cleanText(rec.fields.name, CRM_LIMITS.nameMax);
    let match: LocalCompanyRow | undefined;
    let byName = false;
    if (typeof domain === "string") {
      // Stored domains compare in match form (an older "www.Beta.io" is beta.io).
      [match] = await asWs(ctx.ws, (tx) =>
        tx
          .select(companyCols)
          .from(companies)
          .where(
            and(eq(companies.workspaceId, ctx.ws), sql`${domainKey(companies.domain)} = ${domain}`),
          )
          .orderBy(asc(companies.createdAt))
          .limit(1),
      );
    } else if (ctx.provider === "pipedrive" && name) {
      // Pipedrive organizations without a mapped website field match by exact name.
      const rows = await asWs(ctx.ws, (tx) =>
        tx
          .select(companyCols)
          .from(companies)
          .where(
            and(
              eq(companies.workspaceId, ctx.ws),
              sql`lower(${companies.name}) = ${nameKey(name)}`,
            ),
          )
          .limit(2),
      );
      if (rows.length === 1) {
        match = rows[0];
        byName = true;
      }
    }
    if (match && !ctx.lk.remoteIdOf("company", match.id)) {
      bucket("link", match.id);
      if (byName) bucket("matched_by_name", match.id);
      if (ctx.preview) return;
      await linkAndSync(ctx, object, match, rec);
      return;
    }
    if (!name) return bucket("skipped_invalid");
    bucket("create");
    if (ctx.preview) return;
    const [row] = await asWs(ctx.ws, (tx) =>
      tx
        .insert(companies)
        .values({
          workspaceId: ctx.ws,
          name,
          domain: typeof domain === "string" && !match ? domain : null,
          updatedAt: new Date(0),
        })
        .returning(companyCols),
    );
    await linkAndSync(ctx, object, row!, rec);
  }

  /** The one unlinked Openline deal that is clearly this CRM deal (re-import), else undefined. */
  async function sameLocalDeal(ctx: Ctx, rec: RemoteRecord): Promise<LocalDealRow | undefined> {
    const name = cleanText(rec.fields.name, CRM_LIMITS.nameMax);
    if (!name) return undefined;
    const rows = await asWs(ctx.ws, (tx) =>
      tx
        .select(dealCols)
        .from(deals)
        .where(
          and(
            eq(deals.workspaceId, ctx.ws),
            eq(deals.name, name),
            sql`NOT EXISTS (SELECT 1 FROM crm_links l WHERE l.workspace_id = ${deals.workspaceId}
                              AND l.connection_id = ${ctx.conn.id} AND l.deal_id = ${deals.id})`,
          ),
        )
        .limit(20),
    );
    const amountM = ctx.mappings.find((m) => m.object === "deal" && m.field === "amount");
    const remoteAmount = amountM ? remoteValue(amountM, rec, ctx.lk) : SKIP;
    const remoteClose = cleanDate(rec.fields.expectedCloseDate);
    const hits = rows.filter((d) => {
      if (ctx.matched.deal.has(d.id)) return false;
      const amount = d.amountMinor === null ? null : `${d.amountMinor} ${d.currency}`;
      if (amount && typeof remoteAmount === "string" && amount !== remoteAmount) return false;
      if (d.expectedCloseDate && remoteClose && d.expectedCloseDate !== remoteClose) return false;
      return true;
    });
    return hits.length === 1 ? hits[0] : undefined;
  }

  async function linkAndSync(ctx: Ctx, object: CrmObject, local: LocalRow, rec: RemoteRecord) {
    const col = object === "contact" ? "contactId" : object === "company" ? "companyId" : "dealId";
    const [link] = await asWs(ctx.ws, (tx) =>
      tx
        .insert(crmLinks)
        .values({
          workspaceId: ctx.ws,
          connectionId: ctx.conn.id,
          object,
          [col]: local.id,
          externalId: rec.id,
        })
        .onConflictDoNothing()
        .returning(),
    );
    if (!link) return;
    ctx.lk.setLink(object, local.id, rec.id);
    ctx.run.count(object, "linked");
    await syncPair(ctx, object, link, local, rec);
  }

  /** A record from the CRM change feed (or import list). */
  async function handleRemote(ctx: Ctx, object: CrmObject, rec: RemoteRecord): Promise<void> {
    if (ctx.handled.has(`${object}:${rec.id}`)) return;
    ctx.handled.add(`${object}:${rec.id}`);
    if (
      object === "deal" &&
      !ctx.preview &&
      ctx.stageMappingComplete &&
      !rec.archived &&
      rec.pipelineId === ctx.conn.pipelineId &&
      stageUnmapped(ctx, rec)
    ) {
      await flagStageDrift(ctx, { externalDealId: rec.id });
    }
    if (object === "deal" && !ctx.stageMappingComplete && !ctx.preview) {
      ctx.run.count("deal", "waiting_for_stage_mapping");
      return;
    }
    const link = await linkByExternal(ctx, object, rec.id);
    if (!link) return importRemote(ctx, object, rec);
    if (ctx.preview) {
      ctx.run.count(object, link.state === "linked" ? "update" : "skipped_invalid");
      return;
    }
    if (link.state === "tombstone") {
      ctx.run.count(object, "tombstoned");
      return;
    }
    if (rec.archived) {
      if (link.state === "linked") await handleGone(ctx, object, link, null);
      return;
    }
    if (object === "deal" && rec.pipelineId !== ctx.conn.pipelineId) {
      ctx.run.count(object, "skipped_other_pipeline");
      return;
    }
    if (link.state === "unlinked" && link.reason === "deleted_in_crm") {
      // Restored in the CRM: re-link.
      ctx.run.count(object, "restored");
    } else if (link.state !== "linked") return;
    const localId = linkLocal(link);
    if (!localId) return;
    const [local] = await asWs(ctx.ws, (tx) => localRows(tx, ctx.ws, object, [localId]));
    if (!local) return;
    ctx.lk.setLink(object, localId, rec.id);
    await syncPair(ctx, object, link, local, rec);
  }

  /** A CRM deal whose stage has no mapping (a stage added in the CRM after setup). */
  function stageUnmapped(ctx: Ctx, rec: RemoteRecord): boolean {
    const stageM = ctx.mappings.find((m) => m.object === "deal" && m.field === "stage");
    if (!stageM) return false;
    const raw = rec.fields[stageM.remoteKey];
    return typeof raw === "string" && raw !== "" && ctx.lk.stageFrom(raw) === null;
  }

  async function setLinkState(
    ctx: Ctx,
    link: CrmLinkRow,
    patch: Partial<typeof crmLinks.$inferInsert>,
  ) {
    await asWs(ctx.ws, (tx) =>
      tx
        .update(crmLinks)
        .set({ ...patch, updatedAt: now() })
        .where(and(eq(crmLinks.id, link.id), eq(crmLinks.workspaceId, ctx.ws))),
    );
  }

  /**
   * The linked CRM record is gone (deleted, or merged away). Merges re-match by key: one hit →
   * repoint ("merged in CRM"); none → unlink, kept as "Deleted in <CRM>" so a restore re-links.
   * Two Openline records never merge: the key match keeps the link, the other gets merge_conflict.
   */
  async function handleGone(
    ctx: Ctx,
    object: CrmObject,
    link: CrmLinkRow,
    survivorId: string | null,
  ): Promise<void> {
    const localId = linkLocal(link);
    if (!localId) return;
    const [local] = await asWs(ctx.ws, (tx) => localRows(tx, ctx.ws, object, [localId]));
    if (!local) return;
    let target: RemoteRecord | undefined;
    if (survivorId) {
      const got = await ctx.api.getMany(object, [survivorId], customKeys(ctx.mappings, object));
      target = got.found[0];
    } else if (object !== "deal") {
      const key =
        object === "contact"
          ? { email: (local as LocalContactRow).email }
          : (local as LocalCompanyRow).domain
            ? { domain: normalizeDomain((local as LocalCompanyRow).domain) ?? undefined }
            : {};
      const hits = Object.values(key).some(Boolean) ? await ctx.api.findByKey(object, key) : [];
      if (hits.length === 1) target = hits[0];
    }

    if (!target) {
      await setLinkState(ctx, link, { state: "unlinked", reason: "deleted_in_crm" });
      ctx.lk.dropLink(object, localId);
      ctx.run.count(object, "deleted_in_crm");
      return;
    }

    const other = await linkByExternal(ctx, object, target.id);
    const otherLocal = other ? linkLocal(other) : null;
    if (other && otherLocal && otherLocal !== localId && other.state === "linked") {
      // Two Openline records would point at one CRM record: the key match keeps the link, the
      // other gets merge_conflict for an admin. Openline never merges its own records.
      const [otherRow] = await asWs(ctx.ws, (tx) => localRows(tx, ctx.ws, object, [otherLocal]));
      const keyOf = (row: LocalRow | undefined) =>
        !row
          ? null
          : object === "contact"
            ? (row as LocalContactRow).email
            : normalizeDomain((row as LocalCompanyRow).domain);
      const targetKey =
        object === "contact"
          ? cleanEmail(target.fields.email)
          : normalizeDomain(target.fields.domain);
      const thisMatches =
        object !== "deal" &&
        targetKey !== null &&
        keyOf(local) === targetKey &&
        keyOf(otherRow) !== targetKey;
      const loser = thisMatches ? { link: other, localId: otherLocal } : { link, localId };
      await setLinkState(ctx, loser.link, {
        state: "unlinked",
        reason: "merge_conflict",
        // Frees the surviving id when this record takes it over.
        ...(thisMatches ? { externalId: null } : {}),
      });
      ctx.lk.dropLink(object, loser.localId);
      await recordError(ctx, {
        object,
        localId: loser.localId,
        externalId: target.id,
        direction: "from_crm",
        code: "merge_conflict",
        message: `Records were merged in ${ctx.lk.providerLabel}; two Openline records now match one. Openline never merges automatically.`,
        noRetry: true,
      });
      ctx.run.count(object, "merge_conflicts");
      if (!thisMatches) return;
    } else if (other && other.id !== link.id) {
      // A stale, non-linked row holds the survivor id: drop it so this link can take it.
      await asWs(ctx.ws, (tx) =>
        tx.delete(crmLinks).where(and(eq(crmLinks.id, other.id), eq(crmLinks.workspaceId, ctx.ws))),
      );
    }
    await setLinkState(ctx, link, { externalId: target.id, state: "linked", reason: null });
    ctx.lk.dropLink(object, localId);
    ctx.lk.setLink(object, localId, target.id);
    ctx.run.count(object, "merged_in_crm");
    await syncPair(ctx, object, { ...link, externalId: target.id }, local, target);
  }

  // --------------------------------------------------------------------------- pushing new records

  async function eligibleContacts(ctx: Ctx, ids: string[]): Promise<Set<string>> {
    if (ctx.options.contactPush === "never" || !ids.length) return new Set();
    if (ctx.options.contactPush === "all") return new Set(ids);
    // engaged = on a deal, replied, or in a sequence.
    const rows = await asWs(ctx.ws, (tx) =>
      tx.execute(sql`
        SELECT c.id FROM contacts c
         WHERE c.workspace_id = ${ctx.ws} AND c.id IN (${sql.join(
           ids.map((i) => sql`${i}::uuid`),
           sql`, `,
         )})
           AND (EXISTS (SELECT 1 FROM deal_contacts dc WHERE dc.workspace_id = c.workspace_id AND dc.contact_id = c.id)
             OR EXISTS (SELECT 1 FROM deals d WHERE d.workspace_id = c.workspace_id AND d.primary_contact_id = c.id)
             OR EXISTS (SELECT 1 FROM messages m WHERE m.workspace_id = c.workspace_id AND m.contact_id = c.id AND m.direction = 'inbound')
             OR EXISTS (SELECT 1 FROM enrollments e WHERE e.workspace_id = c.workspace_id AND e.contact_id = c.id))`),
    );
    return new Set(rowsOf<{ id: string }>(rows).map((r) => r.id));
  }

  /**
   * Creates an Openline record in the CRM. A `creating` link is reserved first (like send
   * reservations), so a crashed worker never creates twice: recovery looks it up by key.
   */
  async function pushNew(
    ctx: Ctx,
    object: CrmObject,
    local: LocalRow,
    depth = 0,
  ): Promise<string | null> {
    const existing = ctx.lk.remoteIdOf(object, local.id);
    if (existing) return existing;
    if (depth > 2 || Date.now() > ctx.deadline) return null;
    if (object === "contact") {
      const c = local as LocalContactRow;
      // Never out: suppressed contacts (by address or @domain) not already in the CRM.
      if (isSuppressed(ctx, c.email) || c.status !== "active") return null;
    }
    if (object === "deal") {
      if (!ctx.stageMappingComplete || !ctx.lk.stageTo((local as LocalDealRow).stageId))
        return null;
    }

    // Dependencies first: a synced contact / deal needs its company (and a deal its contact).
    const assoc: { companyId?: string | null; contactId?: string | null } = {};
    const companyId = (local as LocalContactRow | LocalDealRow).companyId ?? null;
    if (object !== "company" && companyId) {
      const [company] = await asWs(ctx.ws, (tx) => localRows(tx, ctx.ws, "company", [companyId]));
      if (company) assoc.companyId = await pushNew(ctx, "company", company, depth + 1);
    }
    if (object === "deal" && (local as LocalDealRow).primaryContactId) {
      const cid = (local as LocalDealRow).primaryContactId!;
      const remote = ctx.lk.remoteIdOf("contact", cid);
      if (remote) assoc.contactId = remote;
      else if ((await eligibleContacts(ctx, [cid])).has(cid)) {
        const [contact] = await asWs(ctx.ws, (tx) => localRows(tx, ctx.ws, "contact", [cid]));
        if (contact) assoc.contactId = await pushNew(ctx, "contact", contact, depth + 1);
      }
    }

    const fields: Record<string, string | null> = {};
    const shadow: Record<string, string> = {};
    let currencyError: { code: string; message: string } | null = null;
    if (object === "contact") fields.email = (local as LocalContactRow).email;
    for (const m of ctx.mappings.filter((x) => x.object === object)) {
      if (m.direction !== "both" && m.direction !== "to_crm") continue;
      if (m.field === "companyId" || m.field === "primaryContactId") continue;
      const lv = localValue(m, local, ctx.lk);
      if (lv === SKIP || lv === null) continue;
      const p = pushFor(m, lv, ctx.lk);
      if (p.kind === "fields") {
        Object.assign(fields, p.fields);
        shadow[m.field] = fieldHash(m.field, lv);
      } else if (p.kind === "error") currencyError = { code: p.code, message: p.message };
    }
    if (object === "company" && !fields.name) fields.name = (local as LocalCompanyRow).name;

    // Re-import (e.g. after "forget links"): a CRM deal with exactly this name in the pipeline,
    // not linked to anything, is this deal — link it rather than create a second copy.
    if (object === "deal" && ctx.run.kind === "import") {
      const d = local as LocalDealRow;
      const hits = (
        await ctx.api.findByKey("deal", {
          name: d.name,
          pipelineId: ctx.conn.pipelineId ?? undefined,
        })
      ).filter((h) => {
        if (
          ctx.lk.localIdOf("deal", h.id) ||
          cleanText(h.fields.name, CRM_LIMITS.nameMax) !== d.name
        )
          return false;
        const amountM = ctx.mappings.find((m) => m.object === "deal" && m.field === "amount");
        const ra = amountM ? remoteValue(amountM, h, ctx.lk) : SKIP;
        const la = d.amountMinor === null ? null : `${d.amountMinor} ${d.currency}`;
        return !(la && typeof ra === "string" && la !== ra);
      });
      if (hits.length === 1) {
        const hit = hits[0]!;
        const [link] = await asWs(ctx.ws, (tx) =>
          tx
            .insert(crmLinks)
            .values({
              workspaceId: ctx.ws,
              connectionId: ctx.conn.id,
              object,
              dealId: local.id,
              externalId: hit.id,
            })
            .onConflictDoNothing()
            .returning(),
        );
        if (!link) return null;
        ctx.lk.setLink(object, local.id, hit.id);
        ctx.run.count(object, "linked");
        await syncPair(ctx, object, link, local, hit);
        return hit.id;
      }
    }

    // Still ours to write? A pause or disconnect meanwhile stops the run before anything is created.
    await ctx.renew();
    const col = object === "contact" ? "contactId" : object === "company" ? "companyId" : "dealId";
    const reservedAt = now();
    const [reservation] = await asWs(ctx.ws, (tx) =>
      tx
        .insert(crmLinks)
        .values({
          workspaceId: ctx.ws,
          connectionId: ctx.conn.id,
          object,
          [col]: local.id,
          state: "creating",
          reservedAt,
        })
        .onConflictDoNothing()
        .returning(),
    );
    if (!reservation) return null; // linked, tombstoned or reserved by someone else

    let rec: RemoteRecord;
    try {
      rec = await ctx.api.create(
        object,
        fields,
        assoc,
        object === "deal" ? ctx.conn.pipelineId : null,
      );
    } catch (error) {
      if (!recordLevel(error)) throw error; // reservation stays: recovery decides
      // HubSpot answers 409 for an existing email: link to it instead of creating.
      const hits =
        object === "contact"
          ? await ctx.api.findByKey("contact", { email: (local as LocalContactRow).email })
          : [];
      if (hits.length === 1 && !ctx.lk.localIdOf(object, hits[0]!.id)) {
        await setLinkState(ctx, reservation, {
          state: "linked",
          externalId: hits[0]!.id,
          reservedAt: null,
        });
        ctx.lk.setLink(object, local.id, hits[0]!.id);
        ctx.run.count(object, "linked");
        await syncPair(ctx, object, { ...reservation, externalId: hits[0]!.id }, local, hits[0]!);
        return hits[0]!.id;
      }
      await asWs(ctx.ws, (tx) =>
        tx
          .delete(crmLinks)
          .where(and(eq(crmLinks.id, reservation.id), eq(crmLinks.workspaceId, ctx.ws))),
      );
      await recordError(ctx, {
        object,
        localId: local.id,
        direction: "to_crm",
        code: "remote_rejected",
        message: `${ctx.lk.providerLabel} rejected this record; check required fields and try again.`,
      });
      return null;
    }
    await setLinkState(ctx, reservation, {
      state: "linked",
      externalId: rec.id,
      reservedAt: null,
      shadow: {
        ...shadow,
        ...(assoc.companyId ? { companyId: fieldHash("companyId", assoc.companyId) } : {}),
        ...(assoc.contactId
          ? { primaryContactId: fieldHash("primaryContactId", assoc.contactId) }
          : {}),
      },
      remoteModifiedAt: rec.modifiedAt,
      syncedAt: now(),
    });
    ctx.lk.setLink(object, local.id, rec.id);
    ctx.run.count(object, "created_in_crm");
    ctx.run.changed += 1;
    if (currencyError) {
      await recordError(ctx, {
        object,
        localId: local.id,
        externalId: rec.id,
        direction: "to_crm",
        ...currencyError,
      });
    }
    return rec.id;
  }

  /** Reservations whose worker died: link by key (one hit) or mark unconfirmed. Never create twice. */
  async function recoverReservations(ctx: Ctx): Promise<void> {
    const stale = await asWs(ctx.ws, (tx) =>
      tx
        .select()
        .from(crmLinks)
        .where(
          and(
            eq(crmLinks.workspaceId, ctx.ws),
            eq(crmLinks.connectionId, ctx.conn.id),
            eq(crmLinks.state, "creating"),
            lt(
              crmLinks.reservedAt,
              new Date(now().getTime() - CRM_SYNC_DEFAULTS.leaseMinutes * MINUTE),
            ),
          ),
        ),
    );
    for (const link of stale) {
      const localId = linkLocal(link);
      if (!localId) continue;
      const [local] = await asWs(ctx.ws, (tx) => localRows(tx, ctx.ws, link.object, [localId]));
      if (!local) continue;
      let hits: RemoteRecord[] = [];
      if (link.object === "contact")
        hits = await ctx.api.findByKey("contact", { email: (local as LocalContactRow).email });
      else if (link.object === "company" && normalizeDomain((local as LocalCompanyRow).domain)) {
        hits = await ctx.api.findByKey("company", {
          domain: normalizeDomain((local as LocalCompanyRow).domain)!,
        });
      } else if (link.object === "deal") {
        hits = await ctx.api.findByKey("deal", {
          name: (local as LocalDealRow).name,
          pipelineId: ctx.conn.pipelineId ?? undefined,
          createdAfter: new Date((link.reservedAt ?? now()).getTime() - MINUTE),
        });
      }
      hits = hits.filter((h) => !ctx.lk.localIdOf(link.object, h.id));
      if (hits.length === 1) {
        await setLinkState(ctx, link, {
          state: "linked",
          externalId: hits[0]!.id,
          reservedAt: null,
        });
        ctx.lk.setLink(link.object, localId, hits[0]!.id);
        ctx.run.count(link.object, "recovered");
        await syncPair(
          ctx,
          link.object,
          { ...link, externalId: hits[0]!.id, shadow: {} },
          local,
          hits[0]!,
        );
      } else {
        await setLinkState(ctx, link, { state: "unconfirmed" });
        ctx.run.count(link.object, "unconfirmed");
        await recordError(ctx, {
          object: link.object,
          localId,
          direction: "to_crm",
          code: "unconfirmed",
          message: `We don't know whether this record was created in ${ctx.lk.providerLabel}. Check there, then retry or dismiss.`,
          noRetry: true,
        });
      }
    }
  }

  // --------------------------------------------------------------------------- run kinds

  function outOfTime(ctx: Ctx): boolean {
    return Date.now() > ctx.deadline;
  }

  async function maybeRenew(ctx: Ctx) {
    if (Date.now() - ctx.lastRenew >= LEASE_RENEW_MS) {
      await ctx.renew();
      ctx.lastRenew = Date.now();
    }
  }

  async function onlyInOpenline(ctx: Ctx): Promise<void> {
    for (const object of OBJECTS) {
      const table =
        object === "contact" ? "contacts" : object === "company" ? "companies" : "deals";
      const col =
        object === "contact" ? "contact_id" : object === "company" ? "company_id" : "deal_id";
      const rows = rowsOf<{ id: string }>(
        await asWs(ctx.ws, (tx) =>
          tx.execute(sql`
            SELECT t.id FROM ${sql.raw(table)} t
             WHERE t.workspace_id = ${ctx.ws}
               AND NOT EXISTS (SELECT 1 FROM crm_links l WHERE l.workspace_id = t.workspace_id
                                 AND l.connection_id = ${ctx.conn.id} AND l.${sql.raw(col)} = t.id)
             ORDER BY t.created_at`),
        ),
      );
      let n = 0;
      for (const r of rows) {
        if (ctx.matched[object].has(r.id)) continue;
        n += 1;
        ctx.run.example(object, "only_in_openline", r.id);
      }
      ctx.run.count(object, "only_in_openline", n);
    }
  }

  /**
   * Preview and import walk the full lists. Import resumes from cursors[object].after. The remote
   * cursor it leaves is in the CRM's own clock: the newest modified time seen, minus the import's
   * duration, so a change made in the CRM while the import ran is read again whatever the skew
   * between the two clocks.
   */
  async function walkAll(ctx: Ctx, cursors: CrmCursorsJson): Promise<boolean> {
    for (const object of OBJECTS) {
      const c = (cursors[object] ??= {});
      if (!ctx.preview && c.local) continue; // imported already
      let after = ctx.preview ? undefined : c.after;
      let seen = c.seen ? new Date(c.seen).getTime() : null;
      for (;;) {
        if (outOfTime(ctx)) return false;
        // Every page: still leased and in the status the run started with (pause, disconnect).
        await ctx.renew();
        const page = await ctx.api.listAll(object, {
          after,
          custom: customKeys(ctx.mappings, object),
        });
        for (const rec of page.records) {
          await perRecord(ctx, { object, externalId: rec.id, direction: "from_crm" }, () =>
            handleRemote(ctx, object, rec),
          );
          seen = Math.max(seen ?? 0, rec.modifiedAt.getTime());
        }
        after = page.next;
        if (!ctx.preview) {
          c.after = after;
          if (seen !== null) c.seen = new Date(seen).toISOString();
          await patchConn(ctx.ws, ctx.conn.id, { cursors });
        }
        if (!after) break;
      }
      if (!ctx.preview) {
        const started = ctx.importStartedAt ?? now();
        delete c.after;
        delete c.seen;
        if (seen !== null) {
          c.remote = new Date(
            seen - (now().getTime() - started.getTime()) - CURSOR_OVERLAP_MS,
          ).toISOString();
        }
        c.local = started.toISOString();
        await patchConn(ctx.ws, ctx.conn.id, { cursors });
      }
    }
    return true;
  }

  async function pushLocalOnly(ctx: Ctx): Promise<void> {
    for (const object of ["contact", "deal"] as const) {
      const table = object === "contact" ? "contacts" : "deals";
      const col = object === "contact" ? "contact_id" : "deal_id";
      const ids = rowsOf<{ id: string }>(
        await asWs(ctx.ws, (tx) =>
          tx.execute(sql`
            SELECT t.id FROM ${sql.raw(table)} t
             WHERE t.workspace_id = ${ctx.ws}
               AND NOT EXISTS (SELECT 1 FROM crm_links l WHERE l.workspace_id = t.workspace_id
                                 AND l.connection_id = ${ctx.conn.id} AND l.${sql.raw(col)} = t.id)
             ORDER BY t.created_at LIMIT 5000`),
        ),
      ).map((r) => r.id);
      const allowed = object === "contact" ? await eligibleContacts(ctx, ids) : new Set(ids);
      const list = ids.filter((id) => allowed.has(id));
      for (let i = 0; i < list.length; i += 200) {
        const rows = await asWs(ctx.ws, (tx) =>
          localRows(tx, ctx.ws, object, list.slice(i, i + 200)),
        );
        for (const row of rows) {
          if (outOfTime(ctx)) return;
          await perRecord(ctx, { object, localId: row.id, direction: "to_crm" }, () =>
            pushNew(ctx, object, row),
          );
        }
      }
    }
  }

  /** Incremental two-way sync for one object. */
  async function syncObject(ctx: Ctx, object: CrmObject, cursors: CrmCursorsJson): Promise<void> {
    const c = (cursors[object] ??= {});
    if (object === "deal" && !ctx.stageMappingComplete) {
      ctx.run.count("deal", "waiting_for_stage_mapping");
      return;
    }
    const custom = customKeys(ctx.mappings, object);
    // No CRM record seen yet (empty account at import): read from the start.
    const base = c.remote ? new Date(c.remote) : new Date(0);
    const since = new Date(base.getTime() - CURSOR_OVERLAP_MS);

    // 1. CRM → Openline (and conflicts) for records changed in the CRM.
    let maxRemote = base.getTime();
    let after: string | undefined;
    let seen = 0;
    for (;;) {
      if (outOfTime(ctx)) break;
      await ctx.renew();
      const page = await ctx.api.listChanged(object, { since, after, custom });
      for (const rec of page.records) {
        await perRecord(ctx, { object, externalId: rec.id, direction: "from_crm" }, () =>
          handleRemote(ctx, object, rec),
        );
        if (!rec.archived) maxRemote = Math.max(maxRemote, rec.modifiedAt.getTime());
        seen += 1;
      }
      after = page.next;
      if (!after || seen >= maxRecords) break;
    }
    if (object === "deal" && !ctx.stageMappingComplete) {
      // Stage mapping drift found in this pass: the cursor stays, so the waiting changes are
      // read again once the mapping is fixed.
      return;
    }
    // Advance only to what we saw (never to "now": the CRM's clock may differ from ours).
    c.remote = new Date(maxRemote).toISOString();

    // 2. Openline → CRM for records changed here, plus due retries and new opt-outs.
    const localBase = c.local ? new Date(c.local) : ctx.conn.connectedAt;
    const changed = await localChangedSince(
      ctx.ws,
      object,
      new Date(localBase.getTime() - CURSOR_OVERLAP_MS),
      maxRecords,
    );
    const forced = new Set([
      ...(await dueRetries(ctx, object)),
      ...(object === "contact" ? await newOptOutContacts(ctx, cursors) : []),
    ]);
    const ids = [...new Set([...changed.map((r) => r.id), ...forced])];
    let maxLocal = localBase.getTime();
    for (const r of changed) maxLocal = Math.max(maxLocal, r.updatedAt.getTime());
    await syncLocal(ctx, object, ids, custom, forced);
    c.local = new Date(Math.min(maxLocal, now().getTime())).toISOString();
  }

  async function dueRetries(ctx: Ctx, object: CrmObject): Promise<string[]> {
    const rows = await asWs(ctx.ws, (tx) =>
      tx
        .select({ localId: crmSyncErrors.localId })
        .from(crmSyncErrors)
        .where(
          and(
            eq(crmSyncErrors.workspaceId, ctx.ws),
            eq(crmSyncErrors.connectionId, ctx.conn.id),
            eq(crmSyncErrors.object, object),
            isNull(crmSyncErrors.resolvedAt),
            sql`${crmSyncErrors.nextRetryAt} <= ${now()}`,
          ),
        )
        .limit(500),
    );
    return rows.map((r) => r.localId).filter((x): x is string => !!x);
  }

  async function newOptOutContacts(ctx: Ctx, cursors: CrmCursorsJson): Promise<string[]> {
    const since = cursors.optOuts ? new Date(cursors.optOuts) : ctx.conn.connectedAt;
    const rows = rowsOf<{ id: string; at: Date | string }>(
      await asWs(ctx.ws, (tx) =>
        tx.execute(sql`
          SELECT c.id, s.created_at AS at FROM suppressions s
            JOIN contacts c ON c.workspace_id = s.workspace_id
                           AND (c.email = s.value
                                OR (left(s.value, 1) = '@' AND lower(c.email) LIKE '%' || s.value))
           WHERE s.workspace_id = ${ctx.ws} AND s.created_at >= ${since}
             AND s.reason IN ('unsubscribed', 'asked_not_to_contact')
           ORDER BY s.created_at LIMIT 1000`),
      ),
    );
    if (rows.length)
      cursors.optOuts = new Date(
        Math.max(...rows.map((r) => new Date(r.at).getTime())),
      ).toISOString();
    return rows.map((r) => r.id);
  }

  async function syncLocal(
    ctx: Ctx,
    object: CrmObject,
    ids: string[],
    custom: string[],
    forced: Set<string> = new Set(),
  ): Promise<void> {
    for (let i = 0; i < ids.length; i += 100) {
      if (outOfTime(ctx)) return;
      await maybeRenew(ctx);
      const chunk = ids.slice(i, i + 100);
      const rows = await asWs(ctx.ws, (tx) => localRows(tx, ctx.ws, object, chunk));
      const links = await linksByLocal(ctx, object, chunk);
      const toFetch: { row: LocalRow; link: CrmLinkRow }[] = [];
      const unlinked: LocalRow[] = [];
      for (const row of rows) {
        const link = links.get(row.id);
        if (!link) unlinked.push(row);
        else if (
          link.state === "linked" &&
          link.externalId &&
          !ctx.handled.has(`${object}:${link.externalId}`)
        ) {
          // Our own pull was the last write: nothing changed here since (echo suppression).
          if (
            !forced.has(row.id) &&
            link.syncedAt &&
            row.updatedAt.getTime() <= link.syncedAt.getTime()
          )
            continue;
          toFetch.push({ row, link });
        }
      }
      if (toFetch.length) {
        const got = await ctx.api.getMany(
          object,
          toFetch.map((t) => t.link.externalId!),
          custom,
        );
        const byId = new Map(got.found.map((r) => [r.id, r]));
        for (const { row, link } of toFetch) {
          const ext = link.externalId!;
          ctx.handled.add(`${object}:${ext}`);
          await perRecord(
            ctx,
            { object, localId: row.id, externalId: ext, direction: "to_crm" },
            async () => {
              if (got.merged[ext]) await handleGone(ctx, object, link, got.merged[ext]!);
              else if (got.missing.includes(ext)) await handleGone(ctx, object, link, null);
              else {
                const rec = byId.get(ext);
                if (!rec) return;
                if (object === "deal" && rec.pipelineId !== ctx.conn.pipelineId) return;
                await syncPair(ctx, object, link, row, rec);
              }
            },
          );
        }
      }
      if (unlinked.length) {
        const allowed =
          object === "contact"
            ? await eligibleContacts(
                ctx,
                unlinked.map((r) => r.id),
              )
            : new Set(unlinked.map((r) => r.id));
        for (const row of unlinked) {
          // Companies are pushed only when a synced contact or deal needs one.
          if (object === "company" || !allowed.has(row.id)) continue;
          await perRecord(ctx, { object, localId: row.id, direction: "to_crm" }, () =>
            pushNew(ctx, object, row),
          );
        }
      }
    }
  }

  /** Once a day: re-read linked ids in batches to catch deletes and merges the feeds miss. */
  async function reconcile(ctx: Ctx): Promise<void> {
    for (const object of OBJECTS) {
      if (object === "deal" && !ctx.stageMappingComplete) continue;
      const links = await asWs(ctx.ws, (tx) =>
        tx
          .select()
          .from(crmLinks)
          .where(
            and(
              eq(crmLinks.workspaceId, ctx.ws),
              eq(crmLinks.connectionId, ctx.conn.id),
              eq(crmLinks.object, object),
              eq(crmLinks.state, "linked"),
            ),
          ),
      );
      const custom = customKeys(ctx.mappings, object);
      for (let i = 0; i < links.length; i += 100) {
        if (outOfTime(ctx)) return;
        await maybeRenew(ctx);
        const chunk = links
          .slice(i, i + 100)
          .filter((l) => l.externalId && !ctx.handled.has(`${object}:${l.externalId}`));
        if (!chunk.length) continue;
        const got = await ctx.api.getMany(
          object,
          chunk.map((l) => l.externalId!),
          custom,
        );
        for (const link of chunk) {
          const ext = link.externalId!;
          if (got.merged[ext]) await handleGone(ctx, object, link, got.merged[ext]!);
          else if (got.missing.includes(ext)) await handleGone(ctx, object, link, null);
        }
      }
    }
    // Retention: runs 90 days, resolved errors 30 days.
    await asWs(ctx.ws, async (tx) => {
      await tx
        .delete(crmSyncRuns)
        .where(
          and(
            eq(crmSyncRuns.workspaceId, ctx.ws),
            lt(crmSyncRuns.startedAt, new Date(now().getTime() - 90 * 86_400_000)),
          ),
        );
      await tx
        .delete(crmSyncErrors)
        .where(
          and(
            eq(crmSyncErrors.workspaceId, ctx.ws),
            lt(crmSyncErrors.resolvedAt, new Date(now().getTime() - 30 * 86_400_000)),
          ),
        );
    });
    ctx.conn.lastReconcileAt = now();
    await patchConn(ctx.ws, ctx.conn.id, { lastReconcileAt: ctx.conn.lastReconcileAt });
  }

  /** Opt-in activity notes: subject-free (S6 teammate-mailbox rule), never pulled back. */
  async function activityNotes(ctx: Ctx, cursors: CrmCursorsJson): Promise<void> {
    if (!ctx.options.activityNotes) return;
    // Cursor "<iso ms>|<message id>": keyset on (time truncated to ms, id), so microsecond
    // timestamps never make the last message look new again.
    const [sinceIso, sinceId] = (cursors.notes ?? "").split("|");
    const since = sinceIso ? new Date(sinceIso) : ctx.conn.connectedAt;
    const afterId =
      sinceId && /^[0-9a-f-]{36}$/.test(sinceId) ? sinceId : "00000000-0000-0000-0000-000000000000";
    const rows = rowsOf<{
      id: string;
      contact_id: string;
      direction: string;
      label: string | null;
      at: Date | string;
      step_position: number | null;
      sequence_name: string | null;
      owner_name: string | null;
    }>(
      await asWs(ctx.ws, (tx) =>
        tx.execute(sql`
          SELECT m.id, m.contact_id, m.direction, m.label,
                 date_trunc('milliseconds', coalesce(m.received_at, m.sent_at)) AS at,
                 m.step_position, s.name AS sequence_name, u.name AS owner_name
            FROM ${messages} m
            JOIN ${crmLinks} l ON l.workspace_id = m.workspace_id AND l.contact_id = m.contact_id
                              AND l.connection_id = ${ctx.conn.id} AND l.state = 'linked'
            LEFT JOIN ${enrollments} e ON e.id = m.enrollment_id AND e.workspace_id = m.workspace_id
            LEFT JOIN ${sequences} s ON s.id = e.sequence_id AND s.workspace_id = m.workspace_id
            LEFT JOIN ${mailboxes} mb ON mb.id = m.mailbox_id AND mb.workspace_id = m.workspace_id
            LEFT JOIN ${users} u ON u.id = mb.user_id
           WHERE m.workspace_id = ${ctx.ws}
             AND (date_trunc('milliseconds', coalesce(m.received_at, m.sent_at)), m.id) > (${since}::timestamptz, ${afterId}::uuid)
             AND ((m.direction = 'outbound' AND m.status = 'sent' AND m.enrollment_id IS NOT NULL)
                  OR (m.direction = 'inbound' AND m.status = 'received' AND m.auto_submitted = false))
           ORDER BY 5, m.id LIMIT 100`),
      ),
    );
    for (const r of rows) {
      if (outOfTime(ctx)) break;
      const contactRemote = ctx.lk.remoteIdOf("contact", r.contact_id);
      if (!contactRemote) continue;
      const dealRows = rowsOf<{ id: string }>(
        await asWs(ctx.ws, (tx) =>
          tx.execute(sql`
            SELECT d.id FROM deals d
             WHERE d.workspace_id = ${ctx.ws} AND d.closed_at IS NULL
               AND (d.primary_contact_id = ${r.contact_id}
                    OR EXISTS (SELECT 1 FROM deal_contacts dc WHERE dc.workspace_id = d.workspace_id
                                 AND dc.deal_id = d.id AND dc.contact_id = ${r.contact_id}))
             ORDER BY d.updated_at DESC LIMIT 1`),
        ),
      );
      const dealRemote = dealRows[0] ? ctx.lk.remoteIdOf("deal", dealRows[0].id) : null;
      await ctx.renew();
      const owner = cleanText(r.owner_name, 60) ?? "a teammate";
      const seq = cleanText(r.sequence_name, 80);
      const text =
        r.direction === "outbound"
          ? `Openline: email sent from ${owner}'s mailbox${r.step_position ? `, step ${r.step_position}` : ""}${seq ? ` of '${seq}'` : ""}`
          : `Openline: reply received${r.label ? ` (${r.label.replace(/_/g, " ")})` : ""}`;
      await ctx.api.addNote({ contactId: contactRemote, dealId: dealRemote ?? undefined }, text);
      ctx.run.count("contact", "notes");
      cursors.notes = `${new Date(r.at).toISOString()}|${r.id}`;
    }
  }

  // --------------------------------------------------------------------------- orchestration

  async function startRun(
    ws: string,
    conn: CrmConnectionRow,
    kind: RunState["kind"],
  ): Promise<RunState> {
    // Previews and imports are created by the API (with their options); reuse the open one.
    if (kind === "preview" || kind === "import") {
      const [open] = await asWs(ws, (tx) =>
        tx
          .select()
          .from(crmSyncRuns)
          .where(
            and(
              eq(crmSyncRuns.workspaceId, ws),
              eq(crmSyncRuns.connectionId, conn.id),
              eq(crmSyncRuns.kind, kind),
              eq(crmSyncRuns.status, "running"),
            ),
          )
          .orderBy(sql`${crmSyncRuns.startedAt} DESC`)
          .limit(1),
      );
      if (open) {
        const st = new RunState(open.id, kind);
        st.counts = open.counts;
        return st;
      }
    }
    // An import whose last run failed (runs never stay running after a failure) continues in a
    // new run with the same options and the original start time.
    let carried: Partial<typeof crmSyncRuns.$inferInsert> = {};
    if (kind === "import") {
      const [last] = await asWs(ws, (tx) =>
        tx
          .select()
          .from(crmSyncRuns)
          .where(
            and(
              eq(crmSyncRuns.workspaceId, ws),
              eq(crmSyncRuns.connectionId, conn.id),
              eq(crmSyncRuns.kind, "import"),
            ),
          )
          .orderBy(sql`${crmSyncRuns.startedAt} DESC`)
          .limit(1),
      );
      if (last) {
        carried = {
          startedBy: last.startedBy,
          options: {
            ...last.options,
            importStartedAt:
              typeof last.options.importStartedAt === "string"
                ? last.options.importStartedAt
                : last.startedAt.toISOString(),
          },
        };
      }
    }
    const [row] = await asWs(ws, (tx) =>
      tx
        .insert(crmSyncRuns)
        .values({ workspaceId: ws, connectionId: conn.id, kind, startedAt: now(), ...carried })
        .returning(),
    );
    return new RunState(row!.id, kind);
  }

  async function finishRun(
    ws: string,
    run: RunState,
    meter: CallMeter,
    status: "succeeded" | "partial" | "failed" | "running",
    errorCode: string | null,
    extra: Partial<typeof crmSyncRuns.$inferInsert> = {},
  ) {
    const [row] = await asWs(ws, (tx) =>
      tx
        .select({
          startedAt: crmSyncRuns.startedAt,
          apiCalls: crmSyncRuns.apiCalls,
          tokens: crmSyncRuns.tokens,
        })
        .from(crmSyncRuns)
        .where(and(eq(crmSyncRuns.id, run.id), eq(crmSyncRuns.workspaceId, ws))),
    );
    const t = now();
    await asWs(ws, (tx) =>
      tx
        .update(crmSyncRuns)
        .set({
          status,
          counts: run.counts,
          examples: run.examples,
          conflicts: run.conflicts,
          conflictCount: run.conflictCount,
          apiCalls: (row?.apiCalls ?? 0) + meter.calls,
          tokens: (row?.tokens ?? 0) + meter.tokens,
          ...(status === "running"
            ? {}
            : { finishedAt: t, durationMs: row ? t.getTime() - row.startedAt.getTime() : null }),
          errorCode,
          ...extra,
        })
        .where(and(eq(crmSyncRuns.id, run.id), eq(crmSyncRuns.workspaceId, ws))),
    );
  }

  async function audit(
    ws: string,
    action: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ) {
    await asWs(ws, (tx) =>
      tx.insert(auditLog).values({
        workspaceId: ws,
        actorId: null,
        action,
        entity: "crm_connection",
        entityId,
        metadata,
      }),
    );
  }

  async function reconnectRequired(conn: CrmConnectionRow, why: string): Promise<void> {
    const label = CRM_PROVIDER_LABELS[conn.provider];
    // Only the status the run saw becomes "error": a disconnect or pause meanwhile wins.
    const wrote = await patchConn(
      conn.workspaceId,
      conn.id,
      {
        status: "error",
        nextSyncAt: null,
        syncLockedUntil: null,
        lastError: `Reconnect ${label}: ${why}`,
      },
      conn.status,
    );
    if (!wrote) return;
    await audit(conn.workspaceId, "crm.reconnect_required", conn.id, { provider: conn.provider });
    if (!conn.reconnectNotifiedAt) {
      await patchConn(conn.workspaceId, conn.id, { reconnectNotifiedAt: now() });
      await options
        .notifyReconnect?.({ workspaceId: conn.workspaceId, provider: conn.provider })
        .catch((e: unknown) => {
          log.warn(`crm-sync: reconnect email failed: ${describe(e)}`);
        });
    }
  }

  function interval(conn: CrmConnectionRow): number {
    return conn.provider === "hubspot"
      ? options.config.intervals.hubspot
      : options.config.intervals.pipedrive;
  }

  async function entitled(ws: string): Promise<boolean> {
    const [row] = await asWs(ws, (tx) =>
      tx
        .execute(sql`SELECT plan, crm_sync_enabled FROM workspaces WHERE id = ${ws}`)
        .then((r) => rowsOf<{ plan: string; crm_sync_enabled: boolean | null }>(r)),
    );
    return !!row && crmSyncEntitled({ plan: row.plan, crmSyncEnabled: row.crm_sync_enabled });
  }

  async function syncConnection(ws: string, id: string): Promise<RunOutcome> {
    const conn = await loadConn(ws, id);
    if (!conn) return "skipped";
    const release = () => patchConn(ws, id, { syncLockedUntil: null });
    if (
      !["previewing", "importing", "active", "paused"].includes(conn.status) ||
      !conn.secretSealed
    ) {
      await release();
      return "skipped";
    }
    // Plan downgraded (e.g. to Solo): nothing syncs, nothing changes; it resumes on upgrade.
    if (!(await entitled(ws))) {
      await release();
      return "skipped";
    }

    const t0 = Date.now();
    let s: Awaited<ReturnType<typeof session>>;
    try {
      s = await session(conn);
    } catch (error) {
      if (error instanceof LeaseLost) return "lease_lost";
      if (error instanceof CrmError && error.kind === "auth") {
        await reconnectRequired(conn, "access was revoked or expired");
        return "reconnect";
      }
      const failures = conn.failureCount + 1;
      await patchConn(ws, id, {
        failureCount: failures,
        nextSyncAt: new Date(now().getTime() + runBackoffMs(failures)),
        syncLockedUntil: null,
        lastError: `We couldn't reach ${CRM_PROVIDER_LABELS[conn.provider]}; we'll try again.`,
      });
      log.warn(`crm-sync: connection ${id} session failed: ${describe(error)}`);
      return "failed";
    }

    if (conn.status === "paused") {
      // Nothing syncs while paused; only keep the refresh token alive.
      await patchConn(
        ws,
        id,
        {
          nextSyncAt: new Date(now().getTime() + CRM_SYNC_DEFAULTS.pausedRefreshMs),
          syncLockedUntil: null,
        },
        "paused",
      );
      return "refreshed";
    }

    const kind: RunState["kind"] =
      conn.status === "previewing"
        ? "preview"
        : conn.status === "importing"
          ? "import"
          : "incremental";
    const run = await startRun(ws, conn, kind);
    const deadline = t0 + (kind === "incremental" ? maxRunMs : maxImportMs);
    const cursors: CrmCursorsJson = structuredClone(conn.cursors ?? {});
    let refreshed = false;
    let ctx: Ctx | undefined;

    const body = async (): Promise<RunOutcome> => {
      ctx = await buildCtx(conn, s, run, kind === "preview", deadline);
      if (kind === "preview") {
        const done = await walkAll(ctx, cursors);
        if (done) await onlyInOpenline(ctx);
        // A preview cut short by its time budget says so: its counts cover part of the account.
        await finishRun(
          ws,
          run,
          s.meter,
          done ? "succeeded" : "partial",
          done ? null : "time_budget",
          {
            expiresAt: new Date(now().getTime() + CRM_LIMITS.previewTtlMs),
          },
        );
        await patchConn(
          ws,
          id,
          {
            nextSyncAt: null,
            syncLockedUntil: null,
            lastError: null,
            failureCount: 0,
            ...budgetPatch(s),
          },
          "previewing",
        );
        await audit(ws, "crm.import_previewed", id, {
          runId: run.id,
          counts: run.counts,
          partial: !done,
        });
        return "previewed";
      }
      if (ctx.stageMappingComplete) {
        // The mapping is whole again: earlier drift errors are fixed.
        await resolveStageDrift(ctx);
      } else if (ctx.unmappedStages.length) {
        await flagStageDrift(ctx, { localStageIds: ctx.unmappedStages });
      }
      await recoverReservations(ctx);
      if (kind === "import") {
        const [row] = await asWs(ws, (tx) =>
          tx
            .select({ options: crmSyncRuns.options, startedAt: crmSyncRuns.startedAt })
            .from(crmSyncRuns)
            .where(and(eq(crmSyncRuns.id, run.id), eq(crmSyncRuns.workspaceId, ws))),
        );
        const carried = row?.options.importStartedAt;
        const importStartedAt =
          typeof carried === "string" ? new Date(carried) : (row?.startedAt ?? now());
        ctx.importStartedAt = importStartedAt;
        const done = await walkAll(ctx, cursors);
        if (!done) {
          await finishRun(ws, run, s.meter, "running", null);
          await patchConn(
            ws,
            id,
            { cursors, nextSyncAt: now(), syncLockedUntil: null, ...budgetPatch(s) },
            "importing",
          );
          return "import_continues";
        }
        if (row?.options.pushLocalOnly === true) await pushLocalOnly(ctx);
        cursors.optOuts = importStartedAt.toISOString();
        cursors.notes = importStartedAt.toISOString();
        await finishRun(ws, run, s.meter, "succeeded", null);
        // Only an importing connection becomes active (a disconnect meanwhile wins).
        const activated = await patchConn(
          ws,
          id,
          {
            status: "active",
            cursors,
            nextSyncAt: new Date(now().getTime() + interval(conn)),
            syncLockedUntil: null,
            lastSyncAt: now(),
            lastReconcileAt: now(),
            lastError: null,
            failureCount: 0,
            emptyPolls: 0,
            ...budgetPatch(s),
          },
          "importing",
        );
        if (!activated) return "lease_lost";
        await audit(ws, "crm.import_completed", id, { runId: run.id, counts: run.counts });
        return "imported";
      }

      for (const object of OBJECTS) {
        await syncObject(ctx, object, cursors);
        await patchConn(ws, id, { cursors }, "active");
      }
      await activityNotes(ctx, cursors);
      if (!conn.lastReconcileAt || now().getTime() - conn.lastReconcileAt.getTime() > 86_400_000) {
        await reconcile(ctx);
      }
      const empty = run.changed === 0;
      const emptyPolls = empty ? conn.emptyPolls + 1 : 0;
      const next =
        emptyPolls >= CRM_SYNC_DEFAULTS.emptyPollsBeforeIdle
          ? options.config.intervals.idle
          : interval(conn);
      await finishRun(ws, run, s.meter, "succeeded", null);
      // A status change made meanwhile (pause, disconnect) wins: only an active row is updated.
      await patchConn(
        ws,
        id,
        {
          cursors,
          nextSyncAt: new Date(now().getTime() + next),
          syncLockedUntil: null,
          lastSyncAt: now(),
          lastError: null,
          resumesAt: null,
          failureCount: 0,
          emptyPolls,
          ...budgetPatch(s),
        },
        "active",
      );
      return "synced";
    };

    const leaseLost = async (): Promise<RunOutcome> => {
      log.warn(`crm-sync: connection ${id} lease lost or status changed; stopping`);
      await finishRun(ws, run, s.meter, "partial", "lease_lost").catch(() => undefined);
      // The spend is real even when the run stops early (never resurrects a disconnected row).
      await patchConn(ws, id, budgetPatch(s)).catch(() => undefined);
      return "lease_lost";
    };

    for (;;) {
      try {
        return await body();
      } catch (caught) {
        let error = caught;
        if (error instanceof LeaseLost) return leaseLost();
        const label = CRM_PROVIDER_LABELS[conn.provider];
        if (error instanceof CrmError && error.kind === "auth" && !refreshed) {
          // One refresh, then the step runs again (pulls are idempotent; pushes are reserved).
          refreshed = true;
          try {
            s = await session(conn, true);
            continue;
          } catch (e) {
            if (e instanceof LeaseLost) return leaseLost();
            error = e;
          }
        }
        const persist: ConnPatch = { cursors, ...budgetPatch(s) };
        // A preview that fails is not retried by itself: the admin runs it again.
        const retryAt = (at: Date | null) => (kind === "preview" ? null : at);
        if (error instanceof CrmError && (error.kind === "auth" || error.kind === "scope")) {
          await finishRun(
            ws,
            run,
            s.meter,
            "failed",
            error.kind === "auth" ? "reconnect_required" : "missing_scope",
          );
          await patchConn(ws, id, persist);
          await reconnectRequired(
            conn,
            error.kind === "auth"
              ? "access was revoked or expired"
              : "a required permission is missing",
          );
          return "reconnect";
        }
        if (
          error instanceof CrmError &&
          (error.kind === "rate_limited" || error.kind === "budget")
        ) {
          const resumesAt =
            error.kind === "budget"
              ? DailyBudget.resetAt(now())
              : new Date(now().getTime() + Math.max(error.retryAfterMs ?? 60_000, 10_000));
          await finishRun(
            ws,
            run,
            s.meter,
            "partial",
            error.kind === "budget" ? "daily_budget" : "rate_limited",
          );
          await patchConn(ws, id, {
            ...persist,
            nextSyncAt: retryAt(resumesAt),
            resumesAt,
            syncLockedUntil: null,
            lastError:
              error.kind === "budget"
                ? "Paused until tomorrow: daily API budget"
                : `${label} asked us to slow down; sync resumes shortly.`,
          });
          return error.kind === "budget" ? "budget" : "rate_limited";
        }
        const failures = conn.failureCount + 1;
        log.warn(`crm-sync: connection ${id} run failed: ${describe(error)}`);
        // Runs never stay "running" after a failure; an import continues in a new run.
        await finishRun(
          ws,
          run,
          s.meter,
          "failed",
          error instanceof CrmError ? error.kind : "internal",
        ).catch(() => undefined);
        await patchConn(ws, id, {
          ...persist,
          failureCount: failures,
          nextSyncAt: retryAt(new Date(now().getTime() + runBackoffMs(failures))),
          syncLockedUntil: null,
          lastError: `Sync with ${label} hit a problem; we'll try again.`,
        }).catch(() => undefined);
        return "failed";
      }
    }
  }

  async function runOnce(batch = 10): Promise<CrmSyncSummary> {
    const claimed = rowsOf<{ workspace_id: string; connection_id: string }>(
      await withIdentity(db, (tx) => tx.execute(sql`SELECT * FROM claim_due_crm_syncs(${batch})`)),
    );
    const outcomes: RunOutcome[] = [];
    for (const row of claimed) {
      if (stopped && timer === undefined && running === undefined) {
        // stop() called mid-batch: leases run out and the rest is picked up later
      }
      try {
        outcomes.push(await syncConnection(row.workspace_id, row.connection_id));
      } catch (error) {
        // One bad connection never stops the batch (or any other job).
        outcomes.push("failed");
        log.error(`crm-sync: connection ${row.connection_id} failed: ${describe(error)}`);
      }
    }
    return { claimed: claimed.length, outcomes };
  }

  function schedule(ms: number) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), ms);
  }
  async function tick() {
    timer = undefined;
    if (stopped || running) return;
    try {
      running = runOnce();
      await running;
    } catch (error) {
      log.error(`crm-sync: run failed: ${describe(error)}`);
    } finally {
      running = undefined;
      schedule(pollEvery);
    }
  }

  return {
    runOnce,
    syncConnection,
    kick() {
      if (!stopped && !running) schedule(50);
    },
    start(pollMs = 15_000) {
      stopped = false;
      pollEvery = pollMs;
      schedule(2_000);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (running) await running.catch(() => undefined);
    },
  };
}
