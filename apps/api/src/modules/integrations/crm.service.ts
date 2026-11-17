import { HttpStatus, Inject, Injectable, Logger, Optional } from "@nestjs/common";
import {
  accountAllowed,
  availableProviders,
  createOAuth,
  createPkcePair,
  CrmError,
  crmOptions,
  defaultMappings,
  hubspotRecordUrl,
  pipedriveRecordUrl,
  PipedriveOAuth,
  reservedRemoteField,
  type CrmApi,
  type CrmOAuth,
  type CrmSecret,
  type RemoteField,
  type RemotePipeline,
} from "@openline/crm";
import {
  and,
  count,
  crmConnections,
  crmFieldMappings,
  crmLinks,
  crmStageMappings,
  crmSyncErrors,
  crmSyncRuns,
  desc,
  eq,
  isNull,
  pipelineStages,
  sql,
  users,
  withIdentity,
  withTenant,
  workspaceMembers,
  workspaces,
  type CrmConnectionRow,
  type CrmSyncErrorRow,
  type CrmSyncRunRow,
  type DatabaseHandle,
  type Tx,
} from "@openline/db";
import { open, openJson, seal, sealJson } from "@openline/email";
import {
  CRM_PROVIDER_LABELS,
  CRM_SYNC_DEFAULTS,
  CRM_LIMITS,
  crmSyncEntitled,
  type CrmConnectionDto,
  type CrmConnectionPatch,
  type CrmFieldMappingDto,
  type CrmFieldMappingInput,
  type CrmImportInput,
  type CrmObject,
  type CrmPage,
  type CrmPipelineDto,
  type CrmProvider,
  type CrmRemoteFieldDto,
  type CrmRunDetailDto,
  type CrmRunDto,
  type CrmStageMappingsDto,
  type CrmStageMappingsInput,
  type CrmStatusDto,
  type CrmSyncErrorDto,
} from "@openline/shared";
import type { AuthContext } from "../../common/auth-context";
import { ApiException, notFound } from "../../common/http";
import { RateLimiter } from "../../common/rate-limit";
import { requireVerified } from "../../common/verified";
import { CONFIG, type AppConfig } from "../../config";
import { DB } from "../../database/database.module";
import { AuditService } from "../audit/audit.service";
import { CrmSchedulerService } from "./crm-scheduler.service";
import { createCrmState, verifyCrmState } from "./crm-oauth-state";

const MINUTE = 60_000;

/** An API-side CRM session for setup calls, with the token spend it hasn't saved yet. */
interface RemoteSession {
  api: CrmApi;
  conn: CrmConnectionRow;
  meter: { calls: number; tokens: number };
  charged: number;
}
const notConnected = () =>
  new ApiException(HttpStatus.NOT_FOUND, "crm_not_connected", "No CRM is connected");
const conflict = (code: string, message: string) =>
  new ApiException(HttpStatus.CONFLICT, code, message);

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");
}
function decodeCursor(cursor: string): { at: string; id: string } {
  const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\|([0-9a-f-]{36})$/i.exec(
    Buffer.from(cursor, "base64url").toString("utf8"),
  );
  if (!m || Number.isNaN(Date.parse(m[1]!))) {
    throw new ApiException(HttpStatus.BAD_REQUEST, "validation_error", "Some fields are invalid", [
      { path: "cursor", message: "Invalid cursor" },
    ]);
  }
  return { at: m[1]!, id: m[2]! };
}

function runDto(r: CrmSyncRunRow): CrmRunDto {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    counts: r.counts,
    apiCalls: r.apiCalls,
    tokens: r.tokens,
    conflicts: r.conflictCount,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    durationMs: r.durationMs,
    errorCode: r.errorCode,
    expiresAt: r.expiresAt?.toISOString() ?? null,
  };
}

/**
 * CRM sync (OL-E8): connect (OAuth with signed state + PKCE where supported), setup and mappings,
 * preview / import, control, disconnect, and the sync log. Tokens are sealed, never returned or
 * logged; every security-relevant change is audited in the same transaction.
 */
@Injectable()
export class CrmService {
  private readonly logger = new Logger("Crm");
  private readonly connects: RateLimiter;
  private readonly syncNow = new RateLimiter(CRM_LIMITS.syncNowPerHour, 60 * MINUTE);
  private readonly previews = new RateLimiter(20, 60 * MINUTE);
  private readonly remoteReads = new RateLimiter(120, 60 * MINUTE);
  /** Replaces the provider OAuth clients (tests). */
  oauthOverride?: (provider: CrmProvider) => CrmOAuth | undefined;

  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
    @Optional() private readonly scheduler?: CrmSchedulerService,
  ) {
    this.connects = new RateLimiter(config.CRM_CONNECTS_PER_USER_PER_HOUR, 60 * MINUTE);
  }

  private oauth(provider: CrmProvider): CrmOAuth {
    const o = this.oauthOverride
      ? this.oauthOverride(provider)
      : createOAuth(this.config.crm, provider);
    if (!o) {
      throw new ApiException(
        HttpStatus.NOT_IMPLEMENTED,
        "crm_not_configured",
        `${CRM_PROVIDER_LABELS[provider]} isn't set up on this server yet`,
      );
    }
    return o;
  }

  private scope<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, { workspaceId: auth.workspaceId, userId: auth.userId }, fn);
  }

  integrationsPage(): string {
    return `${this.config.WEB_URL.replace(/\/$/, "")}/app/settings/integrations`;
  }

  private redirectUri(provider: CrmProvider): string {
    return `${this.config.WEB_URL.replace(/\/$/, "")}/api/v1/integrations/crm/${provider}/callback`;
  }

  private async entitled(tx: Tx, workspaceId: string): Promise<boolean> {
    const [ws] = await tx
      .select({ plan: workspaces.plan, crmSyncEnabled: workspaces.crmSyncEnabled })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    return !!ws && crmSyncEntitled(ws);
  }

  private async requireEntitled(tx: Tx, workspaceId: string): Promise<void> {
    if (!(await this.entitled(tx, workspaceId))) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        "plan_upgrade_required",
        "CRM sync is part of the Team plan and up",
      );
    }
  }

  private async conn(tx: Tx, workspaceId: string): Promise<CrmConnectionRow | undefined> {
    const [row] = await tx
      .select()
      .from(crmConnections)
      .where(eq(crmConnections.workspaceId, workspaceId));
    return row;
  }

  /**
   * The live connection (not disconnected), else 404. Connecting, setup / mappings, import and
   * running a sync need the plan; status, the log, pause, dismiss and disconnect never do, so a
   * workspace that moved to a plan without CRM sync can still see and stop its connection.
   */
  private async live(tx: Tx, auth: AuthContext, needsPlan = true): Promise<CrmConnectionRow> {
    if (needsPlan) await this.requireEntitled(tx, auth.workspaceId);
    const row = await this.conn(tx, auth.workspaceId);
    if (!row || row.status === "disconnected" || !row.secretSealed) throw notConnected();
    return row;
  }

  private async patch(
    tx: Tx,
    conn: CrmConnectionRow,
    values: Partial<typeof crmConnections.$inferInsert>,
  ) {
    const [row] = await tx
      .update(crmConnections)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(crmConnections.id, conn.id), eq(crmConnections.workspaceId, conn.workspaceId)))
      .returning();
    return row!;
  }

  private record(
    tx: Tx,
    auth: AuthContext,
    action: string,
    entityId: string,
    metadata: Record<string, unknown> = {},
  ) {
    return this.audit.record(tx, {
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      action,
      entity: "crm_connection",
      entityId,
      metadata,
    });
  }

  private async toDto(tx: Tx, c: CrmConnectionRow): Promise<CrmConnectionDto> {
    const [errors] = await tx
      .select({ n: count() })
      .from(crmSyncErrors)
      .where(
        and(
          eq(crmSyncErrors.workspaceId, c.workspaceId),
          eq(crmSyncErrors.connectionId, c.id),
          isNull(crmSyncErrors.resolvedAt),
        ),
      );
    const [by] = c.connectedBy
      ? await tx
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(eq(users.id, c.connectedBy))
      : [];
    const options = crmOptions(c.options);
    // Field by field: secret_sealed, cursors and scopes' raw values never leave the API.
    return {
      id: c.id,
      provider: c.provider,
      status: c.status,
      accountId: c.accountId,
      accountName: c.accountName,
      connectedBy: by ?? null,
      connectedAt: c.connectedAt.toISOString(),
      pipelineId: c.pipelineId,
      defaultOwnerId: c.defaultOwnerId,
      options,
      canPushOptOuts:
        c.provider !== "hubspot" || c.scopes.includes("communication_preferences.write"),
      warnings: [
        ...c.warnings,
        ...(c.provider === "hubspot" &&
        !c.scopes.includes("communication_preferences.write") &&
        !c.warnings.length
          ? ["Opt-outs are not being sent to HubSpot"]
          : []),
        ...(c.pipelineId && !c.stageMappingComplete ? ["Stage mapping needs attention"] : []),
      ],
      stageMappingComplete: c.stageMappingComplete,
      lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
      nextSyncAt: c.nextSyncAt?.toISOString() ?? null,
      lastError: c.lastError,
      resumesAt: c.resumesAt && c.resumesAt > new Date() ? c.resumesAt.toISOString() : null,
      openErrors: Number(errors?.n ?? 0),
      budget:
        c.provider === "pipedrive"
          ? {
              day: c.budgetDay,
              spent: c.budgetDay === new Date().toISOString().slice(0, 10) ? c.budgetSpent : 0,
              cap: options.pipedriveDailyCap,
            }
          : null,
    };
  }

  // --------------------------------------------------------------------------- status

  status(auth: AuthContext): Promise<CrmStatusDto> {
    return this.scope(auth, async (tx) => {
      const entitled = await this.entitled(tx, auth.workspaceId);
      const row = await this.conn(tx, auth.workspaceId);
      return {
        entitled,
        available: availableProviders(this.config.crm),
        // Shown without the plan too (with an upgrade note in the UI), so it can be paused or
        // disconnected after a downgrade.
        connection: row && row.status !== "disconnected" ? await this.toDto(tx, row) : null,
      };
    });
  }

  // --------------------------------------------------------------------------- connect

  async authorize(auth: AuthContext, provider: CrmProvider): Promise<{ url: string }> {
    requireVerified(auth);
    const oauth = this.oauth(provider);
    try {
      await this.scope(auth, async (tx) => {
        await this.requireEntitled(tx, auth.workspaceId);
        const row = await this.conn(tx, auth.workspaceId);
        if (row && row.status !== "disconnected" && row.provider !== provider) {
          throw conflict(
            "crm_already_connected",
            `${CRM_PROVIDER_LABELS[row.provider]} is already connected. Disconnect it first.`,
          );
        }
      });
    } catch (error) {
      // A refused connect is audited (its own transaction: the check's was rolled back).
      if (error instanceof ApiException) {
        const reason = (error.getResponse() as { code?: string }).code ?? "refused";
        await this.scope(auth, (tx) =>
          this.audit.record(tx, {
            workspaceId: auth.workspaceId,
            actorId: auth.userId,
            action: "crm.connect_failed",
            entity: "crm_connection",
            entityId: null,
            metadata: { provider, reason },
          }),
        );
      }
      throw error;
    }
    this.connects.consume(`crm-connect:${auth.userId}`);
    let challenge: string | undefined;
    let sealedVerifier: string | undefined;
    if (oauth.supportsPkce) {
      const pair = createPkcePair();
      challenge = pair.challenge;
      sealedVerifier = seal(pair.verifier, this.config.secretsKey, auth.workspaceId);
    }
    const state = createCrmState(
      { workspaceId: auth.workspaceId, userId: auth.userId, provider, sealedVerifier },
      this.config.UNSUBSCRIBE_SECRET,
    );
    return {
      url: oauth.authorizeUrl({
        state,
        redirectUri: this.redirectUri(provider),
        codeChallenge: challenge,
      }),
    };
  }

  /** Returns where to send the browser: Settings → Integrations with ?connected= or ?error=. */
  async callback(
    auth: AuthContext | undefined,
    provider: CrmProvider,
    query: { code?: string; state?: string; error?: string },
  ): Promise<string> {
    const page = this.integrationsPage();
    const redirectTo = (code: string) => `${page}?error=${encodeURIComponent(code)}`;
    // Failed and refused connects are audited in the signed-in user's own workspace (never in
    // the one a state claims): reason code only, never the state, code or tokens.
    const fail = async (code: string) => {
      if (auth) {
        await this.scope(auth, (tx) =>
          this.audit.record(tx, {
            workspaceId: auth.workspaceId,
            actorId: auth.userId,
            action: "crm.connect_failed",
            entity: "crm_connection",
            entityId: null,
            metadata: { provider, reason: code },
          }),
        ).catch(() => undefined);
      }
      return redirectTo(code);
    };
    let oauth: CrmOAuth;
    try {
      oauth = this.oauth(provider);
    } catch {
      return fail("crm_not_configured");
    }
    if (!auth) return redirectTo("signed_out");
    if (query.error) return fail(query.error === "access_denied" ? "access_denied" : "crm_failed");
    if (!query.state || !query.code) return fail("state_invalid");
    const check = verifyCrmState(query.state, this.config.UNSUBSCRIBE_SECRET);
    if (!check.ok) return fail(check.error);
    const st = check.state;
    if (st.u !== auth.userId || st.w !== auth.workspaceId || st.p !== provider)
      return fail("state_mismatch");
    if (auth.role !== "owner" && auth.role !== "admin") return fail("forbidden");
    if (!auth.emailVerified) return fail("email_not_verified");

    let verifier: string | undefined;
    if (st.v) {
      try {
        verifier = open(st.v, this.config.secretsKey, auth.workspaceId);
      } catch {
        return fail("state_invalid");
      }
    }

    let result: Awaited<ReturnType<CrmOAuth["exchangeCode"]>>;
    try {
      result = await oauth.exchangeCode({
        code: query.code,
        redirectUri: this.redirectUri(provider),
        codeVerifier: verifier,
      });
    } catch (error) {
      this.logger.warn(
        `CRM code exchange failed (${error instanceof CrmError ? error.kind : "error"})`,
      );
      return fail("crm_failed");
    }
    const { tokens, account } = result;
    const revokeNew = () =>
      oauth.revoke({ refreshToken: tokens.refreshToken }).catch(() => undefined);
    if (!accountAllowed(this.config.crm, account.accountId)) {
      await revokeNew();
      return fail("crm_account_not_allowed");
    }
    const missing = oauth.scopes.required.filter((s) => !tokens.scopes.includes(s));
    if (provider === "hubspot" && missing.length) {
      await revokeNew();
      return fail("missing_scope");
    }

    const secret: CrmSecret = {
      kind: "oauth",
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessExpiresAt: tokens.accessExpiresAt,
    };
    const sealed = sealJson(secret, this.config.secretsKey, auth.workspaceId);
    const outcome = await this.scope(auth, async (tx) => {
      if (!(await this.entitled(tx, auth.workspaceId))) return "plan_upgrade_required";
      const existing = await this.conn(tx, auth.workspaceId);
      if (existing && existing.status !== "disconnected" && existing.provider !== provider)
        return "crm_already_connected";
      const meta = {
        currencies: account.currencies ?? undefined,
        defaultCurrency: account.defaultCurrency ?? undefined,
        portalId: account.portalId,
      };
      const base = {
        provider,
        accountId: account.accountId,
        accountName: account.accountName,
        apiDomain: account.apiDomain ?? null,
        scopes: tokens.scopes,
        secretSealed: sealed,
        accountMeta: meta,
        lastError: null,
        reconnectNotifiedAt: null,
        warnings: [],
        syncLockedUntil: null,
        failureCount: 0,
        updatedAt: new Date(),
      };
      let id: string;
      let reconnect = false;
      if (!existing) {
        const [row] = await tx
          .insert(crmConnections)
          .values({
            ...base,
            workspaceId: auth.workspaceId,
            connectedBy: auth.userId,
            defaultOwnerId: auth.userId,
            status: "needs_setup",
          })
          .returning();
        id = row!.id;
        await this.seedMappings(tx, auth.workspaceId, id, provider);
      } else {
        id = existing.id;
        const sameAccount =
          existing.provider === provider && existing.accountId === account.accountId;
        if (sameAccount) {
          // Reconnecting the same account resumes from the kept links and cursors (no duplicates).
          reconnect = true;
          const imported = !!existing.cursors.contact?.local;
          await this.patch(tx, existing, {
            ...base,
            status: imported ? "active" : "needs_setup",
            nextSyncAt: imported ? new Date() : null,
          });
        } else {
          // A different account: links, mappings and cursors from the old one don't apply.
          await this.clearAccountData(tx, auth.workspaceId, id);
          await this.patch(tx, existing, {
            ...base,
            status: "needs_setup",
            connectedBy: auth.userId,
            connectedAt: new Date(),
            defaultOwnerId: auth.userId,
            pipelineId: null,
            stageMappingComplete: false,
            cursors: {},
            nextSyncAt: null,
            lastSyncAt: null,
            lastReconcileAt: null,
            resumesAt: null,
            emptyPolls: 0,
            budgetDay: null,
            budgetSpent: 0,
          });
          await this.seedMappings(tx, auth.workspaceId, id, provider);
        }
      }
      await this.record(tx, auth, "crm.connected", id, {
        provider,
        reconnect,
        scopes: tokens.scopes.length,
      });
      return "ok";
    });
    if (outcome !== "ok") {
      await revokeNew();
      return fail(outcome);
    }
    this.scheduler?.kick();
    return `${page}?connected=${provider}`;
  }

  private async seedMappings(
    tx: Tx,
    workspaceId: string,
    connectionId: string,
    provider: CrmProvider,
  ) {
    await tx
      .delete(crmFieldMappings)
      .where(
        and(
          eq(crmFieldMappings.workspaceId, workspaceId),
          eq(crmFieldMappings.connectionId, connectionId),
        ),
      );
    await tx
      .insert(crmFieldMappings)
      .values(defaultMappings(provider).map((m) => ({ ...m, workspaceId, connectionId })));
  }

  private async clearAccountData(tx: Tx, workspaceId: string, connectionId: string) {
    for (const table of [crmLinks, crmSyncErrors, crmStageMappings] as const) {
      await tx
        .delete(table)
        .where(and(eq(table.workspaceId, workspaceId), eq(table.connectionId, connectionId)));
    }
  }

  /** Pipedrive's uninstall callback (DELETE, Basic auth with our client credentials). */
  async pipedriveUninstalled(authorization: string | undefined, body: unknown): Promise<boolean> {
    let oauth: CrmOAuth;
    try {
      oauth = this.oauth("pipedrive");
    } catch {
      return false;
    }
    if (!(oauth instanceof PipedriveOAuth) || !oauth.verifyBasicAuth(authorization)) return false;
    const companyId = (body as { company_id?: unknown } | null)?.company_id;
    const account =
      typeof companyId === "number" || typeof companyId === "string" ? String(companyId) : null;
    if (!account || !/^[0-9]{1,20}$/.test(account)) return true;
    const rows = rowsOf<{ workspace_id: string; connection_id: string }>(
      await withIdentity(this.handle.db, (tx) =>
        tx.execute(sql`SELECT * FROM mark_crm_uninstalled('pipedrive', ${account})`),
      ),
    );
    for (const r of rows) {
      await withTenant(this.handle.db, { workspaceId: r.workspace_id }, (tx) =>
        this.audit.record(tx, {
          workspaceId: r.workspace_id,
          actorId: null,
          action: "crm.disconnected",
          entity: "crm_connection",
          entityId: r.connection_id,
          metadata: { provider: "pipedrive", source: "uninstalled_in_pipedrive" },
        }),
      );
    }
    return true;
  }

  // --------------------------------------------------------------------------- remote metadata

  /**
   * An API session for setup calls. The access token is used while valid; a refresh happens only
   * under the connection's lease, so the API never races the worker on a rotating refresh token.
   */
  private async remote(auth: AuthContext): Promise<RemoteSession> {
    this.remoteReads.consume(`crm-remote:${auth.workspaceId}`);
    const conn = await this.scope(auth, (tx) => this.live(tx, auth));
    if (conn.status === "error")
      throw conflict("crm_reconnect_required", "Reconnect the CRM first");
    const oauth = this.oauth(conn.provider);
    let secret = openJson<CrmSecret>(conn.secretSealed, this.config.secretsKey, conn.workspaceId);
    if (secret.accessExpiresAt - Date.now() < 2 * MINUTE) {
      const leased = await this.scope(auth, (tx) =>
        tx
          .update(crmConnections)
          .set({ syncLockedUntil: sql`now() + interval '1 minute'` })
          .where(
            and(
              eq(crmConnections.id, conn.id),
              eq(crmConnections.workspaceId, auth.workspaceId),
              sql`(${crmConnections.syncLockedUntil} IS NULL OR ${crmConnections.syncLockedUntil} < now())`,
            ),
          )
          .returning({ id: crmConnections.id }),
      );
      if (!leased.length) throw conflict("crm_busy", "A sync is running; try again in a minute");
      try {
        const t = await oauth.refresh(secret.refreshToken);
        secret = {
          kind: "oauth",
          refreshToken: t.refreshToken,
          accessToken: t.accessToken,
          accessExpiresAt: t.accessExpiresAt,
        };
        await this.scope(auth, (tx) =>
          this.patch(tx, conn, {
            secretSealed: sealJson(secret, this.config.secretsKey, conn.workspaceId),
            syncLockedUntil: null,
          }),
        );
      } catch (error) {
        await this.scope(auth, (tx) => this.patch(tx, conn, { syncLockedUntil: null }));
        throw this.remoteError(error);
      }
    }
    const meter = { calls: 0, tokens: 0 };
    const api = oauth.api({
      accessToken: secret.accessToken,
      apiDomain: conn.apiDomain,
      portalId: conn.accountMeta.portalId ?? null,
      meter,
      limiterKey: conn.id,
    });
    return { api, conn, meter, charged: 0 };
  }

  /**
   * Setup calls spend the same Pipedrive daily budget as the sync: the tokens are added to the
   * connection's counter (an increment, so a sync running meanwhile keeps its own spend).
   */
  private async charge(r: RemoteSession): Promise<void> {
    const n = r.meter.tokens - r.charged;
    if (r.conn.provider !== "pipedrive" || n <= 0) return;
    r.charged = r.meter.tokens;
    const today = new Date().toISOString().slice(0, 10);
    await withTenant(this.handle.db, { workspaceId: r.conn.workspaceId }, (tx) =>
      tx
        .update(crmConnections)
        .set({
          budgetDay: today,
          budgetSpent: sql`CASE WHEN ${crmConnections.budgetDay} = ${today}::date THEN ${crmConnections.budgetSpent} + ${n} ELSE ${n} END`,
        })
        .where(
          and(eq(crmConnections.id, r.conn.id), eq(crmConnections.workspaceId, r.conn.workspaceId)),
        ),
    );
  }

  private remoteError(error: unknown): ApiException {
    if (error instanceof CrmError && (error.kind === "auth" || error.kind === "scope")) {
      return new ApiException(
        HttpStatus.CONFLICT,
        "crm_reconnect_required",
        "Reconnect the CRM: access was revoked or expired",
      );
    }
    if (error instanceof CrmError && (error.kind === "rate_limited" || error.kind === "budget")) {
      return new ApiException(
        HttpStatus.TOO_MANY_REQUESTS,
        "crm_rate_limited",
        "The CRM asked us to slow down; try again shortly",
      );
    }
    return new ApiException(
      HttpStatus.BAD_GATEWAY,
      "crm_unavailable",
      "We couldn't reach the CRM; try again",
    );
  }

  private async call<T>(r: RemoteSession, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw this.remoteError(error);
    } finally {
      await this.charge(r);
    }
  }

  async pipelines(auth: AuthContext): Promise<CrmPipelineDto[]> {
    const r = await this.remote(auth);
    const list = await this.call(r, () => r.api.pipelines());
    return list.map((p) => ({
      id: p.id,
      name: p.name.slice(0, 120),
      stages: p.stages.map((s) => ({ ...s, name: s.name.slice(0, 120) })),
    }));
  }

  async fields(auth: AuthContext, object: CrmObject): Promise<CrmRemoteFieldDto[]> {
    const r = await this.remote(auth);
    const { conn } = r;
    const list = await this.call(r, () => r.api.fields(object));
    return (
      list
        .filter((f) => /^[A-Za-z0-9_.:-]{1,100}$/.test(f.key))
        // The key (email) and opt-out fields can't be mapped, so they aren't offered.
        .filter((f) => !reservedRemoteField(conn.provider, object, f.key))
        .map((f) => ({ ...f, label: f.label.slice(0, 120) }))
    );
  }

  // --------------------------------------------------------------------------- setup

  async update(auth: AuthContext, input: CrmConnectionPatch): Promise<CrmConnectionDto> {
    let pipeline: RemotePipeline | undefined;
    if (input.pipelineId !== undefined) {
      const r = await this.remote(auth);
      pipeline = (await this.call(r, () => r.api.pipelines())).find(
        (p) => p.id === input.pipelineId,
      );
      if (!pipeline) {
        throw new ApiException(
          HttpStatus.BAD_REQUEST,
          "validation_error",
          "Some fields are invalid",
          [{ path: "pipelineId", message: "Unknown CRM pipeline" }],
        );
      }
    }
    return this.scope(auth, async (tx) => {
      const conn = await this.live(tx, auth);
      const values: Partial<typeof crmConnections.$inferInsert> = {};
      if (input.defaultOwnerId !== undefined) {
        const [member] = await tx
          .select({ userId: workspaceMembers.userId })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, auth.workspaceId),
              eq(workspaceMembers.userId, input.defaultOwnerId),
            ),
          );
        if (!member) {
          throw new ApiException(
            HttpStatus.BAD_REQUEST,
            "validation_error",
            "Some fields are invalid",
            [{ path: "defaultOwnerId", message: "Not a member of this workspace" }],
          );
        }
        values.defaultOwnerId = input.defaultOwnerId;
      }
      if (input.options) values.options = { ...crmOptions(conn.options), ...input.options };
      if (pipeline && pipeline.id !== conn.pipelineId) {
        // One pipeline in v1: a new pipeline needs a new stage mapping.
        values.pipelineId = pipeline.id;
        values.stageMappingComplete = false;
        await tx
          .delete(crmStageMappings)
          .where(
            and(
              eq(crmStageMappings.workspaceId, auth.workspaceId),
              eq(crmStageMappings.connectionId, conn.id),
            ),
          );
      }
      const row = await this.patch(tx, conn, values);
      await this.record(tx, auth, "crm.options_changed", conn.id, {
        fields: Object.keys(input),
        options: input.options ? Object.keys(input.options) : [],
      });
      return this.toDto(tx, row);
    });
  }

  async fieldMappings(auth: AuthContext): Promise<CrmFieldMappingDto[]> {
    return this.scope(auth, async (tx) => {
      const conn = await this.live(tx, auth);
      const rows = await tx
        .select()
        .from(crmFieldMappings)
        .where(
          and(
            eq(crmFieldMappings.workspaceId, auth.workspaceId),
            eq(crmFieldMappings.connectionId, conn.id),
          ),
        )
        .orderBy(crmFieldMappings.object, crmFieldMappings.standard, crmFieldMappings.localField);
      return rows.map((r) => ({
        id: r.id,
        object: r.object,
        localField: r.localField,
        remoteField: r.remoteField,
        direction: r.direction,
        sourceOfTruth: r.sourceOfTruth,
        standard: r.standard,
      }));
    });
  }

  async replaceFieldMappings(
    auth: AuthContext,
    input: { mappings: CrmFieldMappingInput[] },
  ): Promise<CrmFieldMappingDto[]> {
    // Checked before any CRM call: the key / opt-out fields and one CRM field per mapping.
    const current = await this.scope(auth, (tx) => this.live(tx, auth));
    const early: { path: string; message: string }[] = [];
    const seenRemote = new Set<string>();
    input.mappings.forEach((m, i) => {
      if (!m.remoteField) return;
      if (reservedRemoteField(current.provider, m.object, m.remoteField)) {
        early.push({
          path: `mappings.${i}.remoteField`,
          message:
            "The email and opt-out fields can't be mapped: email is the key, opt-outs sync on their own",
        });
      }
      const key = `${m.object}:${m.remoteField.toLowerCase()}`;
      if (seenRemote.has(key))
        early.push({
          path: `mappings.${i}.remoteField`,
          message: "This CRM field is already mapped",
        });
      seenRemote.add(key);
    });
    if (early.length)
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        "validation_error",
        "Some fields are invalid",
        early,
      );
    const needsRemote = input.mappings.filter((m) => m.remoteField);
    const remoteFields = new Map<CrmObject, RemoteField[]>();
    if (needsRemote.length) {
      const r = await this.remote(auth);
      for (const object of new Set(needsRemote.map((m) => m.object))) {
        remoteFields.set(object, await this.call(r, () => r.api.fields(object)));
      }
    }
    const details: { path: string; message: string }[] = [];
    const mappings = input.mappings.map((m, i) => {
      if (!m.remoteField) return m;
      const f = remoteFields.get(m.object)?.find((x) => x.key === m.remoteField);
      if (!f) {
        details.push({ path: `mappings.${i}.remoteField`, message: "Unknown CRM field" });
        return m;
      }
      // Enumerations (by label) and read-only / calculated properties only map from the CRM.
      if (
        (f.type === "enumeration" || f.readOnly) &&
        (m.direction === "both" || m.direction === "to_crm")
      ) {
        details.push({
          path: `mappings.${i}.direction`,
          message: "This CRM field can only sync into Openline",
        });
      }
      return m;
    });
    if (details.length)
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        "validation_error",
        "Some fields are invalid",
        details,
      );
    await this.scope(auth, async (tx) => {
      const conn = await this.live(tx, auth);
      const provided = new Set(mappings.map((m) => `${m.object}:${m.localField}`));
      // Standard rows not sent keep their defaults; custom rows not sent are removed.
      const keep = defaultMappings(conn.provider).filter(
        (d) => !provided.has(`${d.object}:${d.localField}`),
      );
      const existing = await tx
        .select()
        .from(crmFieldMappings)
        .where(
          and(
            eq(crmFieldMappings.workspaceId, auth.workspaceId),
            eq(crmFieldMappings.connectionId, conn.id),
            eq(crmFieldMappings.standard, true),
          ),
        );
      await tx
        .delete(crmFieldMappings)
        .where(
          and(
            eq(crmFieldMappings.workspaceId, auth.workspaceId),
            eq(crmFieldMappings.connectionId, conn.id),
          ),
        );
      const rows = [
        ...keep.map(
          (d) => existing.find((e) => e.object === d.object && e.localField === d.localField) ?? d,
        ),
        ...mappings.map((m) => ({
          ...m,
          standard: !m.localField.startsWith("custom."),
        })),
      ].map((m) => ({
        workspaceId: auth.workspaceId,
        connectionId: conn.id,
        object: m.object,
        localField: m.localField,
        remoteField: m.remoteField,
        direction: m.direction,
        sourceOfTruth: m.sourceOfTruth,
        standard: m.standard,
      }));
      await tx.insert(crmFieldMappings).values(rows);
      await this.record(tx, auth, "crm.field_mapping_changed", conn.id, {
        mappings: rows.length,
        custom: rows.filter((r) => !r.standard).length,
      });
    });
    return this.fieldMappings(auth);
  }

  async stageMappings(auth: AuthContext): Promise<CrmStageMappingsDto & { suggested?: boolean }> {
    const saved = await this.scope(auth, async (tx) => {
      const conn = await this.live(tx, auth);
      const rows = await tx
        .select()
        .from(crmStageMappings)
        .where(
          and(
            eq(crmStageMappings.workspaceId, auth.workspaceId),
            eq(crmStageMappings.connectionId, conn.id),
          ),
        );
      return { conn, rows };
    });
    if (saved.rows.length || !saved.conn.pipelineId) {
      return {
        fromCrm: saved.rows
          .filter((r) => r.direction === "from_crm")
          .map((r) => ({ remoteStageId: r.remoteStageId, stageId: r.stageId })),
        toCrm: saved.rows
          .filter((r) => r.direction === "to_crm")
          .map((r) => ({ stageId: r.stageId, remoteStageId: r.remoteStageId })),
        complete: saved.conn.stageMappingComplete,
      };
    }
    // Nothing saved yet: pre-fill by name, then by won / lost kind.
    const pipes = await this.pipelines(auth);
    const pipe = pipes.find((p) => p.id === saved.conn.pipelineId);
    const stages = await this.scope(auth, (tx) => this.activeStages(tx, auth.workspaceId));
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const pick = <T extends { name: string; kind: string }>(
      list: T[],
      name: string,
      kind: string,
      fallback: T | undefined,
    ) =>
      list.find((x) => norm(x.name) === norm(name)) ??
      (kind !== "open" ? list.find((x) => x.kind === kind) : undefined) ??
      fallback;
    const firstOpen = stages.find((s) => s.kind === "open");
    const remote = pipe?.stages ?? [];
    return {
      fromCrm: remote
        .map((r) => ({
          remoteStageId: r.id,
          stageId: pick(stages, r.name, r.kind, r.kind === "open" ? firstOpen : undefined)?.id,
        }))
        .filter((m): m is { remoteStageId: string; stageId: string } => !!m.stageId),
      toCrm: stages
        .map((s) => ({
          stageId: s.id,
          remoteStageId: pick(
            remote,
            s.name,
            s.kind,
            s.kind === "open" ? remote.find((r) => r.kind === "open") : undefined,
          )?.id,
        }))
        .filter((m): m is { stageId: string; remoteStageId: string } => !!m.remoteStageId),
      complete: false,
      suggested: true,
    };
  }

  private activeStages(tx: Tx, workspaceId: string) {
    return tx
      .select({ id: pipelineStages.id, name: pipelineStages.name, kind: pipelineStages.kind })
      .from(pipelineStages)
      .where(and(eq(pipelineStages.workspaceId, workspaceId), isNull(pipelineStages.archivedAt)))
      .orderBy(pipelineStages.position);
  }

  async replaceStageMappings(
    auth: AuthContext,
    input: CrmStageMappingsInput,
  ): Promise<CrmStageMappingsDto> {
    const { conn } = await this.remote(auth);
    if (!conn.pipelineId) throw conflict("crm_pipeline_required", "Pick the CRM pipeline first");
    const pipe = (await this.pipelines(auth)).find((p) => p.id === conn.pipelineId);
    if (!pipe)
      throw conflict(
        "crm_pipeline_missing",
        "The chosen CRM pipeline no longer exists; pick another",
      );
    return this.scope(auth, async (tx) => {
      const live = await this.live(tx, auth);
      const stages = await this.activeStages(tx, auth.workspaceId);
      const kindOf = new Map(stages.map((s) => [s.id, s.kind]));
      const remoteKind = new Map(pipe.stages.map((s) => [s.id, s.kind]));
      const details: { path: string; message: string }[] = [];
      input.fromCrm.forEach((m, i) => {
        if (!remoteKind.has(m.remoteStageId))
          details.push({
            path: `fromCrm.${i}.remoteStageId`,
            message: "Not a stage of the chosen pipeline",
          });
        else if (!kindOf.has(m.stageId))
          details.push({ path: `fromCrm.${i}.stageId`, message: "Unknown Openline stage" });
        else if (
          remoteKind.get(m.remoteStageId) !== "open" &&
          kindOf.get(m.stageId) !== remoteKind.get(m.remoteStageId)
        ) {
          details.push({
            path: `fromCrm.${i}.stageId`,
            message: "Won and lost stages map to won and lost stages",
          });
        }
      });
      input.toCrm.forEach((m, i) => {
        if (!kindOf.has(m.stageId))
          details.push({ path: `toCrm.${i}.stageId`, message: "Unknown Openline stage" });
        else if (!remoteKind.has(m.remoteStageId))
          details.push({
            path: `toCrm.${i}.remoteStageId`,
            message: "Not a stage of the chosen pipeline",
          });
        else if (
          kindOf.get(m.stageId) !== "open" &&
          kindOf.get(m.stageId) !== remoteKind.get(m.remoteStageId)
        ) {
          details.push({
            path: `toCrm.${i}.remoteStageId`,
            message: "Won and lost stages map to won and lost stages",
          });
        }
      });
      const dupFrom = input.fromCrm.map((m) => m.remoteStageId);
      const dupTo = input.toCrm.map((m) => m.stageId);
      if (new Set(dupFrom).size !== dupFrom.length || new Set(dupTo).size !== dupTo.length) {
        details.push({ path: "", message: "Each stage maps once" });
      }
      if (details.length)
        throw new ApiException(
          HttpStatus.BAD_REQUEST,
          "validation_error",
          "Some fields are invalid",
          details,
        );
      await tx
        .delete(crmStageMappings)
        .where(
          and(
            eq(crmStageMappings.workspaceId, auth.workspaceId),
            eq(crmStageMappings.connectionId, live.id),
          ),
        );
      const rows = [
        ...input.fromCrm.map((m) => ({ direction: "from_crm" as const, ...m })),
        ...input.toCrm.map((m) => ({ direction: "to_crm" as const, ...m })),
      ].map((m) => ({
        workspaceId: auth.workspaceId,
        connectionId: live.id,
        direction: m.direction,
        remoteStageId: m.remoteStageId,
        stageId: m.stageId,
      }));
      if (rows.length) await tx.insert(crmStageMappings).values(rows);
      // Complete = every CRM stage of the pipeline and every active Openline stage is mapped.
      const complete =
        pipe.stages.every((s) => dupFrom.includes(s.id)) &&
        stages.every((s) => dupTo.includes(s.id));
      await this.patch(tx, live, { stageMappingComplete: complete });
      if (complete) {
        // "Stage mapping needs attention" is answered: its error rows are fixed.
        await tx
          .update(crmSyncErrors)
          .set({ resolvedAt: new Date(), resolvedBy: auth.userId, resolution: "fixed" })
          .where(
            and(
              eq(crmSyncErrors.workspaceId, auth.workspaceId),
              eq(crmSyncErrors.connectionId, live.id),
              eq(crmSyncErrors.code, "stage_unmapped"),
              isNull(crmSyncErrors.resolvedAt),
            ),
          );
        // Deals waiting for the mapping sync soon.
        if (live.status === "active") await this.patch(tx, live, { nextSyncAt: new Date() });
      }
      await this.record(tx, auth, "crm.stage_mapping_changed", live.id, {
        fromCrm: input.fromCrm.length,
        toCrm: input.toCrm.length,
        complete,
      });
      return { fromCrm: input.fromCrm, toCrm: input.toCrm, complete };
    });
  }

  // --------------------------------------------------------------------------- import + control

  async preview(auth: AuthContext): Promise<{ runId: string }> {
    this.previews.consume(`crm-preview:${auth.workspaceId}`);
    const runId = await this.scope(auth, async (tx) => {
      const conn = await this.live(tx, auth);
      if (conn.status !== "needs_setup" && conn.status !== "previewing") {
        throw conflict("crm_import_done", "The import already ran for this connection");
      }
      if (!conn.pipelineId || !conn.stageMappingComplete) {
        throw conflict("crm_stage_mapping_incomplete", "Finish the stage mapping first");
      }
      await tx
        .update(crmSyncRuns)
        .set({ status: "failed", errorCode: "superseded", finishedAt: new Date() })
        .where(
          and(
            eq(crmSyncRuns.workspaceId, auth.workspaceId),
            eq(crmSyncRuns.connectionId, conn.id),
            eq(crmSyncRuns.kind, "preview"),
            eq(crmSyncRuns.status, "running"),
          ),
        );
      const [run] = await tx
        .insert(crmSyncRuns)
        .values({
          workspaceId: auth.workspaceId,
          connectionId: conn.id,
          kind: "preview",
          startedBy: auth.userId,
        })
        .returning();
      await this.patch(tx, conn, { status: "previewing", nextSyncAt: new Date() });
      return run!.id;
    });
    this.scheduler?.kick();
    return { runId };
  }

  async startImport(auth: AuthContext, input: CrmImportInput): Promise<{ runId: string }> {
    const runId = await this.scope(auth, async (tx) => {
      const conn = await this.live(tx, auth);
      if (conn.status !== "previewing")
        throw conflict("crm_preview_required", "Run the preview first");
      const [preview] = await tx
        .select()
        .from(crmSyncRuns)
        .where(
          and(
            eq(crmSyncRuns.id, input.previewId),
            eq(crmSyncRuns.workspaceId, auth.workspaceId),
            eq(crmSyncRuns.connectionId, conn.id),
            eq(crmSyncRuns.kind, "preview"),
          ),
        );
      if (!preview) throw notFound("Preview");
      // A partial preview (cut short by its time budget) may be imported: the UI says its counts
      // cover part of the account. A failed or superseded one may not.
      if (
        (preview.status !== "succeeded" && preview.status !== "partial") ||
        !preview.expiresAt ||
        preview.expiresAt <= new Date()
      ) {
        throw conflict("crm_preview_expired", "This preview is no longer valid; run it again");
      }
      if (!conn.stageMappingComplete)
        throw conflict("crm_stage_mapping_incomplete", "Finish the stage mapping first");
      const [run] = await tx
        .insert(crmSyncRuns)
        .values({
          workspaceId: auth.workspaceId,
          connectionId: conn.id,
          kind: "import",
          startedBy: auth.userId,
          options: {
            previewId: preview.id,
            pushLocalOnly: input.pushLocalOnly,
            lawfulBasisConfirmed: true,
          },
        })
        .returning();
      await this.patch(tx, conn, { status: "importing", nextSyncAt: new Date(), cursors: {} });
      await this.record(tx, auth, "crm.import_started", conn.id, {
        runId: run!.id,
        pushLocalOnly: input.pushLocalOnly,
        lawfulBasisConfirmed: true,
      });
      return run!.id;
    });
    this.scheduler?.kick();
    return { runId };
  }

  async syncNowRequest(auth: AuthContext): Promise<CrmConnectionDto> {
    const dto = await this.scope(auth, async (tx) => {
      const conn = await this.live(tx, auth);
      if (conn.status !== "active")
        throw conflict("crm_not_active", "Sync isn't running for this connection");
      this.syncNow.consume(`crm-sync-now:${conn.id}`);
      const row = await this.patch(tx, conn, { nextSyncAt: new Date(), emptyPolls: 0 });
      await this.record(tx, auth, "crm.sync_requested", conn.id, { provider: conn.provider });
      return this.toDto(tx, row);
    });
    this.scheduler?.kick();
    return dto;
  }

  pause(auth: AuthContext): Promise<CrmConnectionDto> {
    return this.scope(auth, async (tx) => {
      const conn = await this.live(tx, auth, false);
      if (conn.status === "paused") return this.toDto(tx, conn);
      if (conn.status !== "active")
        throw conflict("crm_not_active", "Only a running sync can be paused");
      // Both directions stop; cursors are kept. The token is still refreshed weekly.
      const row = await this.patch(tx, conn, {
        status: "paused",
        nextSyncAt: new Date(Date.now() + CRM_SYNC_DEFAULTS.pausedRefreshMs),
      });
      await this.record(tx, auth, "crm.paused", conn.id);
      return this.toDto(tx, row);
    });
  }

  async resume(auth: AuthContext): Promise<CrmConnectionDto> {
    const dto = await this.scope(auth, async (tx) => {
      const conn = await this.live(tx, auth);
      if (conn.status !== "paused") throw conflict("crm_not_paused", "Sync isn't paused");
      const row = await this.patch(tx, conn, {
        status: "active",
        nextSyncAt: new Date(),
        emptyPolls: 0,
      });
      await this.record(tx, auth, "crm.resumed", conn.id);
      return this.toDto(tx, row);
    });
    this.scheduler?.kick();
    return dto;
  }

  /**
   * Revokes at the provider (best effort: a failed revoke never blocks the local disconnect),
   * erases the tokens, stops the schedule and keeps the id links unless forgetLinks.
   * Nothing is deleted in either system.
   */
  async disconnect(auth: AuthContext, forgetLinks: boolean): Promise<void> {
    const conn = await this.scope(auth, (tx) => this.live(tx, auth, false));
    let revoked = false;
    try {
      const secret = openJson<CrmSecret>(
        conn.secretSealed,
        this.config.secretsKey,
        conn.workspaceId,
      );
      await this.oauth(conn.provider).revoke({
        refreshToken: secret.refreshToken,
        accessToken: secret.accessToken,
      });
      revoked = true;
    } catch (error) {
      this.logger.warn(
        `CRM revoke failed (${error instanceof CrmError ? error.kind : "error"}); disconnecting locally`,
      );
    }
    await this.scope(auth, async (tx) => {
      const live = await this.live(tx, auth, false);
      await this.patch(tx, live, {
        status: "disconnected",
        secretSealed: "",
        nextSyncAt: null,
        syncLockedUntil: null,
        resumesAt: null,
      });
      if (forgetLinks) {
        // Tombstones stay: people erased in Openline must never be re-imported (SEC-S4).
        await tx
          .delete(crmLinks)
          .where(
            and(
              eq(crmLinks.workspaceId, auth.workspaceId),
              eq(crmLinks.connectionId, live.id),
              sql`${crmLinks.state} <> 'tombstone'`,
            ),
          );
        await tx
          .delete(crmSyncErrors)
          .where(
            and(
              eq(crmSyncErrors.workspaceId, auth.workspaceId),
              eq(crmSyncErrors.connectionId, live.id),
            ),
          );
        await this.patch(tx, live, { cursors: {} });
      }
      await this.record(tx, auth, "crm.disconnected", live.id, {
        provider: live.provider,
        forgetLinks,
        revoked,
      });
    });
  }

  // --------------------------------------------------------------------------- sync log

  async runs(
    auth: AuthContext,
    q: { limit: number; cursor?: string },
  ): Promise<CrmPage<CrmRunDto>> {
    return this.scope(auth, async (tx) => {
      const conn = await this.conn(tx, auth.workspaceId);
      if (!conn) return { items: [], nextCursor: null };
      const after = q.cursor ? decodeCursor(q.cursor) : null;
      const rows = await tx
        .select()
        .from(crmSyncRuns)
        .where(
          and(
            eq(crmSyncRuns.workspaceId, auth.workspaceId),
            eq(crmSyncRuns.connectionId, conn.id),
            after
              ? sql`(${crmSyncRuns.startedAt}, ${crmSyncRuns.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(crmSyncRuns.startedAt), desc(crmSyncRuns.id))
        .limit(q.limit + 1);
      const items = rows.slice(0, q.limit);
      const last = items[items.length - 1];
      return {
        items: items.map(runDto),
        nextCursor: rows.length > q.limit && last ? encodeCursor(last.startedAt, last.id) : null,
      };
    });
  }

  async run(auth: AuthContext, id: string): Promise<CrmRunDetailDto> {
    return this.scope(auth, async (tx) => {
      const [r] = await tx
        .select()
        .from(crmSyncRuns)
        .where(and(eq(crmSyncRuns.id, id), eq(crmSyncRuns.workspaceId, auth.workspaceId)));
      if (!r) throw notFound("Sync run");
      return { ...runDto(r), examples: r.examples, conflictLog: r.conflicts };
    });
  }

  async errors(
    auth: AuthContext,
    q: {
      limit: number;
      cursor?: string;
      object?: CrmObject;
      code?: string;
      open: "true" | "false";
    },
  ): Promise<CrmPage<CrmSyncErrorDto>> {
    return this.scope(auth, async (tx) => {
      const conn = await this.conn(tx, auth.workspaceId);
      if (!conn) return { items: [], nextCursor: null };
      const after = q.cursor ? decodeCursor(q.cursor) : null;
      const rows = await tx
        .select()
        .from(crmSyncErrors)
        .where(
          and(
            eq(crmSyncErrors.workspaceId, auth.workspaceId),
            eq(crmSyncErrors.connectionId, conn.id),
            q.object ? eq(crmSyncErrors.object, q.object) : undefined,
            q.code ? eq(crmSyncErrors.code, q.code) : undefined,
            q.open === "true" ? isNull(crmSyncErrors.resolvedAt) : undefined,
            after
              ? sql`(${crmSyncErrors.createdAt}, ${crmSyncErrors.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(crmSyncErrors.createdAt), desc(crmSyncErrors.id))
        .limit(q.limit + 1);
      const items = rows.slice(0, q.limit);
      const last = items[items.length - 1];
      return {
        items: items.map((e) => this.errorDto(conn, e)),
        nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    });
  }

  private errorDto(conn: CrmConnectionRow, e: CrmSyncErrorRow): CrmSyncErrorDto {
    const url = !e.externalId
      ? null
      : conn.provider === "hubspot"
        ? hubspotRecordUrl(
            this.config.crm.hubspot?.appBase ?? "https://app.hubspot.com",
            conn.accountMeta.portalId,
            e.object,
            e.externalId,
          )
        : pipedriveRecordUrl(conn.apiDomain, e.object, e.externalId);
    return {
      id: e.id,
      runId: e.runId,
      object: e.object,
      localId: e.localId,
      externalId: e.externalId,
      externalUrl: url,
      direction: e.direction,
      code: e.code,
      message: e.message,
      attempts: e.attempts,
      nextRetryAt: e.nextRetryAt?.toISOString() ?? null,
      createdAt: e.createdAt.toISOString(),
      resolvedAt: e.resolvedAt?.toISOString() ?? null,
      resolution: e.resolution,
    };
  }

  private async openError(
    tx: Tx,
    auth: AuthContext,
    id: string,
    needsPlan = true,
  ): Promise<{ conn: CrmConnectionRow; error: CrmSyncErrorRow }> {
    const conn = await this.live(tx, auth, needsPlan);
    const [error] = await tx
      .select()
      .from(crmSyncErrors)
      .where(
        and(
          eq(crmSyncErrors.id, id),
          eq(crmSyncErrors.workspaceId, auth.workspaceId),
          eq(crmSyncErrors.connectionId, conn.id),
        ),
      );
    if (!error) throw notFound("Sync error");
    if (error.resolvedAt) throw conflict("crm_error_resolved", "This error is already resolved");
    return { conn, error };
  }

  async retryError(auth: AuthContext, id: string): Promise<CrmSyncErrorDto> {
    const dto = await this.scope(auth, async (tx) => {
      const { conn, error } = await this.openError(tx, auth, id);
      if (error.code === "merge_conflict") {
        throw conflict(
          "crm_merge_conflict",
          "Resolve the duplicate in the CRM, then dismiss this error",
        );
      }
      let resolved = false;
      if (error.code === "unconfirmed" && error.localId) {
        // The admin checked the CRM: the record isn't there. Release the reservation so the
        // next run creates it.
        const col =
          error.object === "contact"
            ? crmLinks.contactId
            : error.object === "company"
              ? crmLinks.companyId
              : crmLinks.dealId;
        await tx
          .delete(crmLinks)
          .where(
            and(
              eq(crmLinks.workspaceId, auth.workspaceId),
              eq(crmLinks.connectionId, conn.id),
              eq(col, error.localId),
              eq(crmLinks.state, "unconfirmed"),
            ),
          );
        resolved = true;
      }
      const [row] = await tx
        .update(crmSyncErrors)
        .set(
          resolved
            ? { resolvedAt: new Date(), resolvedBy: auth.userId, resolution: "fixed" }
            : { nextRetryAt: new Date() },
        )
        .where(and(eq(crmSyncErrors.id, id), eq(crmSyncErrors.workspaceId, auth.workspaceId)))
        .returning();
      if (conn.status === "active") await this.patch(tx, conn, { nextSyncAt: new Date() });
      await this.record(tx, auth, "crm.error_retried", conn.id, {
        errorId: id,
        code: row!.code,
        released: resolved,
      });
      return this.errorDto(conn, row!);
    });
    this.scheduler?.kick();
    return dto;
  }

  dismissError(auth: AuthContext, id: string): Promise<CrmSyncErrorDto> {
    return this.scope(auth, async (tx) => {
      const { conn } = await this.openError(tx, auth, id, false);
      const [row] = await tx
        .update(crmSyncErrors)
        .set({
          resolvedAt: new Date(),
          resolvedBy: auth.userId,
          resolution: "dismissed",
          nextRetryAt: null,
        })
        .where(and(eq(crmSyncErrors.id, id), eq(crmSyncErrors.workspaceId, auth.workspaceId)))
        .returning();
      await this.record(tx, auth, "crm.error_dismissed", conn.id, { errorId: id, code: row!.code });
      return this.errorDto(conn, row!);
    });
  }
}
