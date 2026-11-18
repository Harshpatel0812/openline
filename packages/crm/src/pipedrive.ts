/**
 * Pipedrive client: OAuth at oauth.pipedrive.com (Basic client auth, rotating refresh tokens),
 * API v2 lists with updated_since / sort_by=update_time / cursor (≤ 500 per page), v1 only where
 * v2 has no equivalent (fields, users, notes). Calls go to the token response's api_domain, accepted
 * only when it matches the allowlist. Every request is costed against our daily token budget.
 * Won / lost are deal statuses here, surfaced as the canonical stages "@won" / "@lost".
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { CrmObject } from "@openline/shared";
import {
  checkPipedriveDomain,
  type CrmConfig,
  type CrmProviderConfig,
  type PipedriveEndpoints,
} from "./config";
import { CrmError } from "./errors";
import { arr, crmRequest, obj, str, type HttpContext } from "./http";
import { PIPEDRIVE_TOKEN_COST, TokenBucket, type PipedriveCostKind } from "./limiter";
import { cleanTimestamp } from "./sanitize";
import {
  LOST,
  WON,
  type AccountInfo,
  type CallMeter,
  type CreateAssociations,
  type CrmApi,
  type CrmOAuth,
  type OptOutResult,
  type RemoteField,
  type RemoteOwner,
  type RemotePage,
  type RemotePipeline,
  type RemoteRecord,
  type SpendHook,
  type TokenSet,
} from "./types";

const PATH: Record<CrmObject, string> = {
  contact: "persons",
  company: "organizations",
  deal: "deals",
};
const FIELDS_PATH: Record<CrmObject, string> = {
  contact: "personFields",
  company: "organizationFields",
  deal: "dealFields",
};
const UI: Record<CrmObject, string> = { contact: "person", company: "organization", deal: "deal" };
const PAGE = 500;
const GET_MANY = 100;

type PipedriveConfig = CrmProviderConfig & PipedriveEndpoints;

/** Burst limiter per connection, clamped from x-ratelimit-remaining. */
const bursts = new Map<string, TokenBucket>();
function burstFor(key: string): TokenBucket {
  let b = bursts.get(key);
  if (!b) {
    b = new TokenBucket(20, 2_000);
    if (bursts.size > 10_000) bursts.clear();
    bursts.set(key, b);
  }
  return b;
}

function tokens(body: unknown, previousRefresh?: string): TokenSet & { apiDomain: string | null } {
  const b = obj(body);
  const access = str(b.access_token);
  const refresh = str(b.refresh_token) ?? previousRefresh;
  if (!access || !refresh) throw new CrmError("auth", "Pipedrive did not return tokens");
  const expiresIn = Number(b.expires_in);
  return {
    accessToken: access,
    refreshToken: refresh,
    accessExpiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
    scopes: (str(b.scope) ?? "").split(/[ ,]+/).filter(Boolean),
    apiDomain: str(b.api_domain),
  };
}

export class PipedriveOAuth implements CrmOAuth {
  readonly provider = "pipedrive" as const;
  /** Fixed on the app in Developer Hub, not per URL (PRD §1). */
  readonly scopes = {
    required: ["base", "contacts:full", "deals:full", "users:read"],
    optional: [],
  };

  constructor(
    private readonly cfg: PipedriveConfig,
    private readonly crm: CrmConfig,
    private readonly http: Omit<HttpContext, "allow" | "meter"> = {},
  ) {}

  get supportsPkce(): boolean {
    return this.cfg.pkce;
  }

  /** Fixed OAuth host, or a company API domain that matches the allowlist. */
  private allow = (u: URL): boolean =>
    this.crm.allowedOrigins.has(u.origin) || this.cfg.apiDomainPattern.test(u.origin);

  private ctx(meter: CallMeter = { calls: 0, tokens: 0 }, spend?: SpendHook): HttpContext {
    return { ...this.http, meter, spend, allow: this.allow };
  }

  private basic(): string {
    return `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64")}`;
  }

  /**
   * True when a request's Basic credentials are ours (the uninstall callback). Compared in
   * constant time over SHA-256 digests, so neither content nor length leaks through timing.
   */
  verifyBasicAuth(header: string | undefined): boolean {
    if (typeof header !== "string") return false;
    const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();
    return timingSafeEqual(digest(header), digest(this.basic()));
  }

  authorizeUrl(p: { state: string; redirectUri: string; codeChallenge?: string }): string {
    const u = new URL(`${this.cfg.oauthBase}/oauth/authorize`);
    u.searchParams.set("client_id", this.cfg.clientId);
    u.searchParams.set("redirect_uri", p.redirectUri);
    u.searchParams.set("state", p.state);
    if (p.codeChallenge && this.supportsPkce) {
      u.searchParams.set("code_challenge", p.codeChallenge);
      u.searchParams.set("code_challenge_method", "S256");
    }
    return u.toString();
  }

  async exchangeCode(p: { code: string; redirectUri: string; codeVerifier?: string }) {
    const res = await crmRequest(this.ctx(), {
      method: "POST",
      url: `${this.cfg.oauthBase}/oauth/token`,
      headers: { authorization: this.basic() },
      form: {
        grant_type: "authorization_code",
        code: p.code,
        redirect_uri: p.redirectUri,
        ...(p.codeVerifier && this.supportsPkce ? { code_verifier: p.codeVerifier } : {}),
      },
    });
    const t = tokens(res.body);
    const apiDomain = checkPipedriveDomain(this.crm, t.apiDomain);
    const account = await this.api({
      accessToken: t.accessToken,
      apiDomain,
      meter: { calls: 0, tokens: 0 },
      limiterKey: "oauth",
    }).account();
    return { tokens: t, account: { ...account, apiDomain } };
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    const res = await crmRequest(this.ctx(), {
      method: "POST",
      url: `${this.cfg.oauthBase}/oauth/token`,
      headers: { authorization: this.basic() },
      form: { grant_type: "refresh_token", refresh_token: refreshToken },
    });
    return tokens(res.body, refreshToken);
  }

  /** Revoking the refresh token uninstalls the app (PRD §1). */
  async revoke(t: { refreshToken: string }): Promise<void> {
    await crmRequest(this.ctx(), {
      method: "POST",
      url: `${this.cfg.oauthBase}/oauth/revoke`,
      headers: { authorization: this.basic() },
      form: { token: t.refreshToken, token_type_hint: "refresh_token" },
    });
  }

  api(p: {
    accessToken: string;
    apiDomain?: string | null;
    meter: CallMeter;
    spend?: SpendHook;
    limiterKey: string;
  }): CrmApi {
    const domain = checkPipedriveDomain(this.crm, p.apiDomain);
    return new PipedriveApi(
      this.ctx(p.meter, p.spend),
      domain,
      p.accessToken,
      burstFor(p.limiterKey),
    );
  }
}

class PipedriveApi implements CrmApi {
  readonly provider = "pipedrive" as const;

  constructor(
    private readonly ctx: HttpContext,
    private readonly domain: string,
    private readonly token: string,
    private readonly burst: TokenBucket,
  ) {}

  nativeFields(object: CrmObject): readonly string[] {
    if (object === "contact")
      return ["email", "firstName", "lastName", "phone", "companyId", "ownerId"];
    // No standard domain field on organizations: it comes from a mapped website field.
    if (object === "company") return ["name"];
    return [
      "name",
      "amount",
      "currency",
      "stage",
      "expectedCloseDate",
      "lostReason",
      "companyId",
      "primaryContactId",
      "ownerId",
    ];
  }

  private async call(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    kind: PipedriveCostKind,
    json?: unknown,
  ): Promise<unknown> {
    const res = await crmRequest(this.ctx, {
      method,
      url: `${this.domain}${path}`,
      headers: { authorization: `Bearer ${this.token}` },
      json,
      cost: PIPEDRIVE_TOKEN_COST[kind],
      limiter: this.burst,
      onHeaders: (h) => {
        if (h.has("x-ratelimit-remaining"))
          this.burst.clamp(Number(h.get("x-ratelimit-remaining")));
      },
    });
    const body = obj(res.body);
    if (body.success === false) throw new CrmError("validation", "Pipedrive rejected this request");
    return res.body;
  }

  async account(): Promise<AccountInfo> {
    const d = obj(obj(await this.call("GET", "/api/v1/users/me", "meta")).data);
    const id = str(d.company_id);
    if (!id) throw new CrmError("validation", "Pipedrive did not return the company id");
    const currency = str(d.default_currency);
    return {
      accountId: id,
      accountName: str(d.company_name),
      currencies: await this.currencies(),
      defaultCurrency: currency,
    };
  }

  private async currencies(): Promise<string[] | null> {
    const body = obj(await this.call("GET", "/api/v1/currencies", "meta"));
    const list = arr(body.data)
      .map((c) => obj(c))
      .filter((c) => c.active_flag !== false)
      .map((c) => str(c.code))
      .filter((c): c is string => !!c && /^[A-Z]{3}$/.test(c));
    return list.length ? list : null;
  }

  async pipelines(): Promise<RemotePipeline[]> {
    const pipes = arr(obj(await this.call("GET", "/api/v2/pipelines", "list")).data).map((p) =>
      obj(p),
    );
    const stages = arr(obj(await this.call("GET", "/api/v2/stages?limit=500", "list")).data).map(
      (s) => obj(s),
    );
    return pipes.map((p) => ({
      id: str(p.id) ?? "",
      name: str(p.name) ?? "",
      stages: [
        ...stages
          .filter((s) => str(s.pipeline_id) === str(p.id) && s.is_deleted !== true)
          .sort((a, b) => Number(a.order_nr) - Number(b.order_nr))
          .map((s) => ({ id: str(s.id) ?? "", name: str(s.name) ?? "", kind: "open" as const })),
        // Won / lost are deal statuses in Pipedrive.
        { id: WON, name: "Won (status)", kind: "won" as const },
        { id: LOST, name: "Lost (status)", kind: "lost" as const },
      ],
    }));
  }

  async fields(object: CrmObject): Promise<RemoteField[]> {
    const body = obj(await this.call("GET", `/api/v1/${FIELDS_PATH[object]}?limit=500`, "meta"));
    return arr(body.data).map((f) => {
      const o = obj(f);
      const t = str(o.field_type);
      return {
        key: str(o.key) ?? "",
        label: str(o.name) ?? "",
        type:
          t === "double" || t === "monetary" || t === "int"
            ? "number"
            : t === "date"
              ? "date"
              : t === "enum" || t === "set"
                ? "enumeration"
                : "text",
        readOnly: o.edit_flag === false && o.bulk_edit_allowed === false,
      };
    });
  }

  async owners(): Promise<RemoteOwner[]> {
    const body = obj(await this.call("GET", "/api/v1/users", "meta"));
    return arr(body.data)
      .map((u) => obj(u))
      .map((u) => ({ id: str(u.id) ?? "", email: (str(u.email) ?? "").toLowerCase() }))
      .filter((u) => u.id && u.email);
  }

  private toRecord(object: CrmObject, raw: unknown, custom: string[]): RemoteRecord {
    const o = obj(raw);
    const cf = obj(o.custom_fields);
    const fields: Record<string, string | null> = {};
    if (object === "contact") {
      const emails = arr(o.emails).map((e) => obj(e));
      const primary = emails.find((e) => e.primary === true) ?? emails[0];
      const phones = arr(o.phones).map((e) => obj(e));
      const phone = phones.find((e) => e.primary === true) ?? phones[0];
      fields.email = primary ? str(primary.value) : null;
      fields.firstName = str(o.first_name);
      fields.lastName = str(o.last_name);
      fields.phone = phone ? str(phone.value) : null;
      fields.companyId = str(o.org_id);
      fields.ownerId = str(o.owner_id);
    } else if (object === "company") {
      fields.name = str(o.name);
    } else {
      const status = str(o.status);
      fields.name = str(o.title);
      fields.amount = o.value === null || o.value === undefined ? null : str(o.value);
      fields.currency = str(o.currency);
      fields.stage = status === "won" ? WON : status === "lost" ? LOST : str(o.stage_id);
      fields.expectedCloseDate = str(o.expected_close_date);
      fields.lostReason = str(o.lost_reason);
      fields.companyId = str(o.org_id);
      fields.primaryContactId = str(o.person_id);
      fields.ownerId = str(o.owner_id);
    }
    for (const c of custom) {
      const key = c.replace(/^custom:/, "");
      const v = cf[key];
      fields[c] = v && typeof v === "object" ? str(obj(v).value) : str(v);
    }
    return {
      id: str(o.id) ?? "",
      object,
      modifiedAt: cleanTimestamp(o.update_time) ?? new Date(0),
      createdAt: cleanTimestamp(o.add_time) ?? undefined,
      fields,
      pipelineId: object === "deal" ? str(o.pipeline_id) : undefined,
      optedOut: object === "contact" ? str(o.marketing_status) === "unsubscribed" : undefined,
      archived: o.is_deleted === true || str(o.status) === "deleted",
    };
  }

  private listQuery(object: CrmObject, extra: Record<string, string>): URLSearchParams {
    const q = new URLSearchParams({ limit: String(PAGE), ...extra });
    if (object === "contact") q.set("include_fields", "marketing_status");
    return q;
  }

  async listAll(
    object: CrmObject,
    opts: { after?: string; custom: string[] },
  ): Promise<RemotePage> {
    const q = this.listQuery(object, { sort_by: "id", sort_direction: "asc" });
    if (opts.after) q.set("cursor", opts.after);
    const body = obj(await this.call("GET", `/api/v2/${PATH[object]}?${q}`, "list"));
    return {
      records: arr(body.data).map((r) => this.toRecord(object, r, opts.custom)),
      next: str(obj(body.additional_data).next_cursor) ?? undefined,
    };
  }

  /**
   * Changed since `since` ascending by update_time. Deals also read status=deleted (deletes are
   * otherwise invisible to the change feed): the cursor "d:<cursor>" walks that second list.
   */
  async listChanged(
    object: CrmObject,
    opts: { since: Date; after?: string; custom: string[] },
  ): Promise<RemotePage> {
    const deleted = opts.after?.startsWith("d:") ?? false;
    const cursor = deleted ? opts.after!.slice(2) : opts.after;
    const q = this.listQuery(object, {
      updated_since: opts.since.toISOString().replace(/\.\d{3}Z$/, "Z"),
      sort_by: "update_time",
      sort_direction: "asc",
    });
    if (deleted) q.set("status", "deleted");
    if (cursor) q.set("cursor", cursor);
    const body = obj(await this.call("GET", `/api/v2/${PATH[object]}?${q}`, "list"));
    const next = str(obj(body.additional_data).next_cursor);
    const records = arr(body.data).map((r) => this.toRecord(object, r, opts.custom));
    if (next) return { records, next: deleted ? `d:${next}` : next };
    if (object === "deal" && !deleted) return { records, next: "d:" };
    return { records };
  }

  async getMany(object: CrmObject, ids: string[], custom: string[]) {
    const found: RemoteRecord[] = [];
    for (let i = 0; i < ids.length; i += GET_MANY) {
      const chunk = ids.slice(i, i + GET_MANY);
      const q = this.listQuery(object, { ids: chunk.join(",") });
      const body = obj(await this.call("GET", `/api/v2/${PATH[object]}?${q}`, "list"));
      for (const r of arr(body.data)) found.push(this.toRecord(object, r, custom));
    }
    const live = new Set(found.filter((r) => !r.archived).map((r) => r.id));
    // A Pipedrive merge deletes the losing record and reports no survivor: it reads as missing,
    // and the engine re-matches by key.
    return {
      found: found.filter((r) => !r.archived),
      missing: ids.filter((id) => !live.has(id)),
      merged: {},
    };
  }

  private body(object: CrmObject, fields: Record<string, string | null>, forCreate: boolean) {
    const out: Record<string, unknown> = {};
    const custom: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (k.startsWith("custom:")) {
        custom[k.slice(7)] = v;
        continue;
      }
      if (object === "contact") {
        if (k === "email" && v) out.emails = [{ value: v, primary: true, label: "work" }];
        else if (k === "firstName") out.first_name = v;
        else if (k === "lastName") out.last_name = v;
        else if (k === "phone") out.phones = v ? [{ value: v, primary: true, label: "work" }] : [];
        else if (k === "ownerId" && v) out.owner_id = Number(v);
      } else if (object === "company") {
        if (k === "name") out.name = v;
      } else {
        if (k === "name") out.title = v;
        else if (k === "amount") out.value = v === null ? null : Number(v);
        else if (k === "currency") out.currency = v;
        else if (k === "stage") {
          if (v === WON) out.status = "won";
          else if (v === LOST) out.status = "lost";
          else if (v) {
            out.stage_id = Number(v);
            out.status = "open";
          }
        } else if (k === "expectedCloseDate") out.expected_close_date = v;
        else if (k === "lostReason") out.lost_reason = v;
        else if (k === "ownerId" && v) out.owner_id = Number(v);
      }
    }
    if (object === "contact" && forCreate) {
      const name = [fields.firstName, fields.lastName].filter(Boolean).join(" ");
      out.name = name || fields.email || "Unknown";
    }
    if (Object.keys(custom).length) out.custom_fields = custom;
    return out;
  }

  async create(
    object: CrmObject,
    fields: Record<string, string | null>,
    assoc: CreateAssociations,
    pipelineId?: string | null,
  ): Promise<RemoteRecord> {
    const payload = this.body(object, fields, true);
    if (assoc.companyId) payload.org_id = Number(assoc.companyId);
    if (object === "deal") {
      if (assoc.contactId) payload.person_id = Number(assoc.contactId);
      if (pipelineId) payload.pipeline_id = Number(pipelineId);
    }
    const body = obj(await this.call("POST", `/api/v2/${PATH[object]}`, "create", payload));
    return this.toRecord(object, body.data, []);
  }

  async update(
    object: CrmObject,
    id: string,
    fields: Record<string, string | null>,
  ): Promise<void> {
    const payload = this.body(object, fields, false);
    if (!Object.keys(payload).length) return;
    await this.call(
      "PATCH",
      `/api/v2/${PATH[object]}/${encodeURIComponent(id)}`,
      "update",
      payload,
    );
  }

  async associate(object: CrmObject, id: string, assoc: CreateAssociations): Promise<void> {
    const payload: Record<string, unknown> = {};
    if (assoc.companyId && object !== "company") payload.org_id = Number(assoc.companyId);
    if (assoc.contactId && object === "deal") payload.person_id = Number(assoc.contactId);
    if (!Object.keys(payload).length) return;
    await this.call(
      "PATCH",
      `/api/v2/${PATH[object]}/${encodeURIComponent(id)}`,
      "update",
      payload,
    );
  }

  async findByKey(
    object: CrmObject,
    key: {
      email?: string;
      domain?: string;
      name?: string;
      createdAfter?: Date;
      pipelineId?: string;
    },
  ): Promise<RemoteRecord[]> {
    let term: string | undefined;
    let field: string;
    if (object === "contact") {
      term = key.email;
      field = "email";
    } else if (object === "company") {
      term = key.name ?? key.domain;
      field = key.name ? "name" : "custom_fields";
    } else {
      term = key.name;
      field = "title";
    }
    if (!term) return [];
    const q = new URLSearchParams({ term, fields: field, exact_match: "true", limit: "10" });
    const body = obj(await this.call("GET", `/api/v2/${PATH[object]}/search?${q}`, "search"));
    const ids = arr(obj(body.data).items)
      .map((i) => str(obj(obj(i).item).id))
      .filter((x): x is string => !!x);
    if (!ids.length) return [];
    const { found } = await this.getMany(object, ids, []);
    return found.filter(
      (r) =>
        (!key.createdAfter || !r.createdAt || r.createdAt >= key.createdAfter) &&
        (!key.pipelineId || object !== "deal" || r.pipelineId === key.pipelineId),
    );
  }

  /** marketing_status can change to unsubscribed once (Campaigns on); never back. */
  async optOut(contactId: string): Promise<OptOutResult> {
    try {
      await this.call("PATCH", `/api/v2/persons/${encodeURIComponent(contactId)}`, "update", {
        marketing_status: "unsubscribed",
      });
      return "done";
    } catch (error) {
      if (error instanceof CrmError && (error.kind === "validation" || error.kind === "scope")) {
        return "unsupported";
      }
      throw error;
    }
  }

  async addNote(target: { contactId: string; dealId?: string }, text: string): Promise<void> {
    await this.call("POST", "/api/v1/notes", "note", {
      content: text,
      person_id: Number(target.contactId),
      ...(target.dealId ? { deal_id: Number(target.dealId) } : {}),
    });
  }

  recordUrl(object: CrmObject, id: string): string {
    return `${this.domain}/${UI[object]}/${encodeURIComponent(id)}`;
  }
}

export function pipedriveRecordUrl(
  apiDomain: string | null,
  object: CrmObject,
  id: string,
): string | null {
  return apiDomain ? `${apiDomain}/${UI[object]}/${encodeURIComponent(id)}` : null;
}
