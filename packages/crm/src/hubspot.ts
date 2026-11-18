/**
 * HubSpot client. Every HubSpot path and version lives in this one module (PRD §5: "HubSpot
 * object APIs pinned to one dated version in one module"): dated OAuth endpoints (2026-03, not the
 * v1 endpoints deprecated on Feb 16, 2027), CRM objects v3, associations v4, search with the
 * 10,000-result window re-anchored, batch ≤ 100.
 */
import type { CrmObject } from "@openline/shared";
import type { CrmConfig, CrmProviderConfig, HubSpotEndpoints } from "./config";
import { CrmError } from "./errors";
import { arr, crmRequest, obj, str, type HttpContext } from "./http";
import { HUBSPOT_LIMITS, TokenBucket } from "./limiter";
import { cleanDate, cleanTimestamp } from "./sanitize";
import type {
  AccountInfo,
  CallMeter,
  CreateAssociations,
  CrmApi,
  CrmOAuth,
  OptOutResult,
  RemoteField,
  RemoteOwner,
  RemotePage,
  RemotePipeline,
  RemoteRecord,
  TokenSet,
} from "./types";

export const HUBSPOT_OAUTH_VERSION = "2026-03";

export const HUBSPOT_SCOPES = {
  required: [
    "oauth",
    "crm.objects.contacts.read",
    "crm.objects.contacts.write",
    "crm.objects.companies.read",
    "crm.objects.companies.write",
    "crm.objects.deals.read",
    "crm.objects.deals.write",
    "crm.objects.owners.read",
    "crm.schemas.contacts.read",
    "crm.schemas.companies.read",
    "crm.schemas.deals.read",
  ],
  optional: ["communication_preferences.write"],
};

const TYPE: Record<CrmObject, string> = {
  contact: "contacts",
  company: "companies",
  deal: "deals",
};
const UI_TYPE: Record<CrmObject, string> = { contact: "0-1", company: "0-2", deal: "0-3" };
/** HubSpot-defined association type ids (v4). */
const ASSOC = {
  contactToCompany: 1, // primary
  dealToCompany: 5, // primary
  dealToContact: 3,
  noteToContact: 202,
  noteToDeal: 214,
} as const;

/** canonical → HubSpot property. */
const PROPS: Record<CrmObject, Record<string, string>> = {
  contact: {
    email: "email",
    firstName: "firstname",
    lastName: "lastname",
    title: "jobtitle",
    phone: "phone",
    ownerId: "hubspot_owner_id",
  },
  company: { name: "name", domain: "domain" },
  deal: {
    name: "dealname",
    amount: "amount",
    currency: "deal_currency_code",
    stage: "dealstage",
    expectedCloseDate: "closedate",
    lostReason: "closed_lost_reason",
    ownerId: "hubspot_owner_id",
  },
};
const MODIFIED: Record<CrmObject, string> = {
  contact: "lastmodifieddate",
  company: "hs_lastmodifieddate",
  deal: "hs_lastmodifieddate",
};
const EXTRA_READ: Record<CrmObject, string[]> = {
  contact: ["hs_email_optout", "createdate", "hs_merged_object_ids"],
  company: ["createdate", "hs_merged_object_ids"],
  deal: ["pipeline", "createdate", "hs_merged_object_ids"],
};

/** Search window cap (HubSpot returns at most 10,000 results per query). */
export const HUBSPOT_SEARCH_CAP = 10_000;
const SEARCH_PAGE = 200;
const LIST_PAGE = 100;
const BATCH = 100;

const limiters = new Map<string, { general: TokenBucket; search: TokenBucket }>();
function limiterFor(key: string) {
  let l = limiters.get(key);
  if (!l) {
    l = {
      general: new TokenBucket(HUBSPOT_LIMITS.general.capacity, HUBSPOT_LIMITS.general.windowMs),
      search: new TokenBucket(HUBSPOT_LIMITS.search.capacity, HUBSPOT_LIMITS.search.windowMs),
    };
    if (limiters.size > 10_000) limiters.clear();
    limiters.set(key, l);
  }
  return l;
}

type HubSpotConfig = CrmProviderConfig & HubSpotEndpoints;

function tokenSet(body: unknown, previousRefresh?: string): TokenSet {
  const b = obj(body);
  const access = str(b.access_token);
  const refresh = str(b.refresh_token) ?? previousRefresh;
  const expiresIn = Number(b.expires_in);
  if (!access || !refresh) throw new CrmError("auth", "HubSpot did not return tokens");
  const scopes = Array.isArray(b.scopes)
    ? b.scopes.filter((s): s is string => typeof s === "string")
    : (str(b.scope) ?? "").split(/[ ,]+/).filter(Boolean);
  return {
    accessToken: access,
    refreshToken: refresh,
    accessExpiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 1800) * 1000,
    scopes,
  };
}

export class HubSpotOAuth implements CrmOAuth {
  readonly provider = "hubspot" as const;
  readonly scopes = HUBSPOT_SCOPES;

  constructor(
    private readonly cfg: HubSpotConfig,
    private readonly crm: CrmConfig,
    private readonly http: Omit<HttpContext, "allow" | "meter"> = {},
    /** HubSpot's search window (10,000); lowered only by tests. */
    private readonly searchCap = HUBSPOT_SEARCH_CAP,
  ) {}

  get supportsPkce(): boolean {
    return this.cfg.pkce;
  }

  private ctx(meter: CallMeter = { calls: 0, tokens: 0 }): HttpContext {
    return { ...this.http, meter, allow: (u) => this.crm.allowedOrigins.has(u.origin) };
  }

  authorizeUrl(p: { state: string; redirectUri: string; codeChallenge?: string }): string {
    const u = new URL(`${this.cfg.appBase}/oauth/authorize`);
    u.searchParams.set("client_id", this.cfg.clientId);
    u.searchParams.set("redirect_uri", p.redirectUri);
    u.searchParams.set("scope", this.scopes.required.join(" "));
    u.searchParams.set("optional_scope", this.scopes.optional.join(" "));
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
      url: `${this.cfg.apiBase}/oauth/${HUBSPOT_OAUTH_VERSION}/token`,
      form: {
        grant_type: "authorization_code",
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        redirect_uri: p.redirectUri,
        code: p.code,
        ...(p.codeVerifier && this.supportsPkce ? { code_verifier: p.codeVerifier } : {}),
      },
    });
    const tokens = tokenSet(res.body);
    const account = await this.api({
      accessToken: tokens.accessToken,
      meter: { calls: 0, tokens: 0 },
      limiterKey: "oauth",
    }).account();
    return { tokens, account };
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    const res = await crmRequest(this.ctx(), {
      method: "POST",
      url: `${this.cfg.apiBase}/oauth/${HUBSPOT_OAUTH_VERSION}/token`,
      form: {
        grant_type: "refresh_token",
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        refresh_token: refreshToken,
      },
    });
    return tokenSet(res.body, refreshToken);
  }

  async revoke(tokens: { refreshToken: string }): Promise<void> {
    await crmRequest(this.ctx(), {
      method: "POST",
      url: `${this.cfg.apiBase}/oauth/${HUBSPOT_OAUTH_VERSION}/token/revoke`,
      form: {
        token: tokens.refreshToken,
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
      },
    });
  }

  api(p: {
    accessToken: string;
    portalId?: string | null;
    meter: CallMeter;
    limiterKey: string;
  }): CrmApi {
    return new HubSpotApi(
      this.cfg,
      this.ctx(p.meter),
      p.accessToken,
      p.portalId ?? null,
      p.limiterKey,
      this.searchCap,
    );
  }
}

class HubSpotApi implements CrmApi {
  readonly provider = "hubspot" as const;
  private readonly limits: { general: TokenBucket; search: TokenBucket };

  constructor(
    private readonly cfg: HubSpotConfig,
    private readonly ctx: HttpContext,
    private readonly token: string,
    private portalId: string | null,
    limiterKey: string,
    private readonly searchCap: number,
  ) {
    this.limits = limiterFor(limiterKey);
  }

  nativeFields(object: CrmObject): readonly string[] {
    const base = Object.keys(PROPS[object]);
    if (object === "contact") return [...base, "companyId"];
    if (object === "deal") return [...base, "companyId", "primaryContactId"];
    return base;
  }

  private async call(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    json?: unknown,
    search = false,
  ): Promise<unknown> {
    const res = await crmRequest(this.ctx, {
      method,
      url: `${this.cfg.apiBase}${path}`,
      headers: { authorization: `Bearer ${this.token}` },
      json,
      limiter: search ? this.limits.search : this.limits.general,
      onHeaders: (h) => {
        const remaining = Number(h.get("x-hubspot-ratelimit-remaining"));
        // Shared with the customer's other apps: keep a floor for them.
        if (h.has("x-hubspot-ratelimit-remaining") && remaining < HUBSPOT_LIMITS.remainingFloor) {
          this.limits.general.clamp(0);
        }
      },
    });
    return res.body;
  }

  async account(): Promise<AccountInfo> {
    const d = obj(await this.call("GET", "/account-info/v3/details"));
    const portalId = str(d.portalId);
    if (!portalId) throw new CrmError("validation", "HubSpot did not return the account id");
    this.portalId = portalId;
    const main = str(d.companyCurrency);
    const extra = arr(d.additionalCurrencies).filter((c): c is string => typeof c === "string");
    return {
      accountId: portalId,
      accountName: str(d.uiDomain)
        ? `${str(d.uiDomain)} (portal ${portalId})`
        : `Portal ${portalId}`,
      currencies: main ? [main, ...extra] : null,
      defaultCurrency: main,
      portalId,
    };
  }

  async pipelines(): Promise<RemotePipeline[]> {
    const body = obj(await this.call("GET", "/crm/v3/pipelines/deals"));
    return arr(body.results).map((p) => {
      const o = obj(p);
      return {
        id: str(o.id) ?? "",
        name: str(o.label) ?? "",
        stages: arr(o.stages).map((s) => {
          const so = obj(s);
          const meta = obj(so.metadata);
          const closed = str(meta.isClosed) === "true";
          const prob = Number(str(meta.probability) ?? "0");
          return {
            id: str(so.id) ?? "",
            name: str(so.label) ?? "",
            kind: !closed ? ("open" as const) : prob >= 1 ? ("won" as const) : ("lost" as const),
          };
        }),
      };
    });
  }

  async fields(object: CrmObject): Promise<RemoteField[]> {
    const body = obj(await this.call("GET", `/crm/v3/properties/${TYPE[object]}`));
    return arr(body.results).map((r) => {
      const o = obj(r);
      const type = str(o.type);
      const meta = obj(o.modificationMetadata);
      return {
        key: str(o.name) ?? "",
        label: str(o.label) ?? "",
        type:
          type === "number"
            ? "number"
            : type === "date" || type === "datetime"
              ? "date"
              : type === "bool"
                ? "boolean"
                : type === "enumeration"
                  ? "enumeration"
                  : "text",
        readOnly: meta.readOnlyValue === true || o.calculated === true,
      };
    });
  }

  async owners(): Promise<RemoteOwner[]> {
    const out: RemoteOwner[] = [];
    let after: string | undefined;
    for (let i = 0; i < 50; i += 1) {
      const body = obj(
        await this.call(
          "GET",
          `/crm/v3/owners?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`,
        ),
      );
      for (const r of arr(body.results)) {
        const o = obj(r);
        const id = str(o.id);
        const email = str(o.email);
        if (id && email) out.push({ id, email: email.toLowerCase() });
      }
      after = str(obj(obj(body.paging).next).after) ?? undefined;
      if (!after) break;
    }
    return out;
  }

  private properties(object: CrmObject, custom: string[]): string[] {
    return [
      ...new Set([
        ...Object.values(PROPS[object]),
        ...EXTRA_READ[object],
        MODIFIED[object],
        ...custom.map((c) => c.replace(/^custom:/, "")),
      ]),
    ];
  }

  private toRecord(object: CrmObject, raw: unknown, custom: string[]): RemoteRecord {
    const o = obj(raw);
    const p = obj(o.properties);
    const fields: Record<string, string | null> = {};
    for (const [canon, prop] of Object.entries(PROPS[object])) fields[canon] = str(p[prop]);
    if (object === "deal") fields.expectedCloseDate = cleanDate(fields.expectedCloseDate);
    for (const c of custom) fields[c] = str(p[c.replace(/^custom:/, "")]);
    const assoc = obj(o.associations);
    const ids = (kind: string) =>
      arr(obj(assoc[kind]).results)
        .map((a) => str(obj(a).id))
        .filter((x): x is string => !!x);
    const modifiedAt =
      cleanTimestamp(o.updatedAt) ?? cleanTimestamp(p[MODIFIED[object]]) ?? new Date(0);
    const record: RemoteRecord = {
      id: str(o.id) ?? "",
      object,
      modifiedAt,
      createdAt: cleanTimestamp(o.createdAt) ?? cleanTimestamp(p.createdate) ?? undefined,
      fields,
      archived: o.archived === true,
    };
    if (object === "contact") {
      if (assoc.companies) fields.companyId = ids("companies")[0] ?? null;
      record.optedOut = str(p.hs_email_optout) === "true";
    }
    if (object === "deal") {
      record.pipelineId = str(p.pipeline);
      if (assoc.companies) fields.companyId = ids("companies")[0] ?? null;
      if (assoc.contacts) {
        const contacts = ids("contacts");
        fields.primaryContactId = contacts[0] ?? null;
        record.contactIds = contacts.slice(1);
      }
    }
    return record;
  }

  private assocNames(object: CrmObject): string {
    return object === "contact" ? "companies" : object === "deal" ? "companies,contacts" : "";
  }

  async listAll(
    object: CrmObject,
    opts: { after?: string; custom: string[] },
  ): Promise<RemotePage> {
    const q = new URLSearchParams({ limit: String(LIST_PAGE), archived: "false" });
    q.set("properties", this.properties(object, opts.custom).join(","));
    const assoc = this.assocNames(object);
    if (assoc) q.set("associations", assoc);
    if (opts.after) q.set("after", opts.after);
    const body = obj(await this.call("GET", `/crm/v3/objects/${TYPE[object]}?${q}`));
    return {
      records: arr(body.results).map((r) => this.toRecord(object, r, opts.custom)),
      next: str(obj(obj(body.paging).next).after) ?? undefined,
    };
  }

  /**
   * Search by last-modified ascending from `since`. The opaque cursor is "<sinceMs>:<offset>"; the
   * window is re-anchored at the newest time seen before HubSpot's 10,000-result cap.
   */
  async listChanged(
    object: CrmObject,
    opts: { since: Date; after?: string; custom: string[] },
  ): Promise<RemotePage> {
    let since = opts.since.getTime();
    let offset = 0;
    if (opts.after) {
      const [s, o] = opts.after.split(":");
      since = Number(s);
      offset = Number(o);
      if (!Number.isFinite(since) || !Number.isFinite(offset))
        throw new CrmError("validation", "Bad cursor");
    }
    const body = obj(
      await this.call(
        "POST",
        `/crm/v3/objects/${TYPE[object]}/search`,
        {
          filterGroups: [
            {
              filters: [{ propertyName: MODIFIED[object], operator: "GTE", value: String(since) }],
            },
          ],
          sorts: [{ propertyName: MODIFIED[object], direction: "ASCENDING" }],
          properties: this.properties(object, opts.custom),
          limit: SEARCH_PAGE,
          ...(offset ? { after: String(offset) } : {}),
        },
        true,
      ),
    );
    const records = arr(body.results).map((r) => this.toRecord(object, r, opts.custom));
    await this.fillAssociations(object, records);
    const nextAfter = str(obj(obj(body.paging).next).after);
    let next: string | undefined;
    if (nextAfter) {
      const n = Number(nextAfter);
      if (n + SEARCH_PAGE > this.searchCap && records.length) {
        // Re-anchor: restart the window at the newest modified time on this page.
        const newest = Math.max(...records.map((r) => r.modifiedAt.getTime()));
        next = `${newest > since ? newest : since + 1}:0`;
      } else {
        next = `${since}:${n}`;
      }
    }
    return { records, next };
  }

  /** Search results carry no associations: read them in one batch per association type. */
  private async fillAssociations(object: CrmObject, records: RemoteRecord[]): Promise<void> {
    if (!records.length || object === "company") return;
    const targets = object === "contact" ? ["companies"] : ["companies", "contacts"];
    for (const to of targets) {
      const map = await this.readAssociations(
        object,
        to,
        records.map((r) => r.id),
      );
      for (const r of records) {
        const ids = map.get(r.id) ?? [];
        if (to === "companies") r.fields.companyId = ids[0] ?? null;
        else {
          r.fields.primaryContactId = ids[0] ?? null;
          r.contactIds = ids.slice(1);
        }
      }
    }
  }

  private async readAssociations(
    object: CrmObject,
    to: string,
    ids: string[],
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (let i = 0; i < ids.length; i += BATCH) {
      const body = obj(
        await this.call("POST", `/crm/v4/associations/${TYPE[object]}/${to}/batch/read`, {
          inputs: ids.slice(i, i + BATCH).map((id) => ({ id })),
        }),
      );
      for (const r of arr(body.results)) {
        const o = obj(r);
        const from = str(obj(o.from).id);
        if (!from) continue;
        out.set(
          from,
          arr(o.to)
            .map((t) => str(obj(t).toObjectId))
            .filter((x): x is string => !!x),
        );
      }
    }
    return out;
  }

  async getMany(object: CrmObject, ids: string[], custom: string[]) {
    const found: RemoteRecord[] = [];
    const merged: Record<string, string> = {};
    const requested = new Set(ids);
    const seen = new Set<string>();
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const body = obj(
        await this.call("POST", `/crm/v3/objects/${TYPE[object]}/batch/read`, {
          properties: this.properties(object, custom),
          inputs: chunk.map((id) => ({ id })),
        }),
      );
      for (const raw of arr(body.results)) {
        const record = this.toRecord(object, raw, custom);
        const mergedIds = (str(obj(obj(raw).properties).hs_merged_object_ids) ?? "")
          .split(";")
          .filter(Boolean);
        if (requested.has(record.id)) seen.add(record.id);
        for (const m of mergedIds) {
          if (requested.has(m) && m !== record.id) {
            merged[m] = record.id;
            seen.add(m);
          }
        }
        if (!found.some((f) => f.id === record.id)) found.push(record);
      }
    }
    await this.fillAssociations(object, found);
    const missing = ids.filter((id) => !seen.has(id));
    return { found, missing, merged };
  }

  private props(object: CrmObject, fields: Record<string, string | null>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [canon, value] of Object.entries(fields)) {
      const prop = canon.startsWith("custom:") ? canon.slice(7) : PROPS[object][canon];
      if (!prop) continue;
      out[prop] = value ?? "";
    }
    return out;
  }

  private assocInputs(object: CrmObject, assoc: CreateAssociations) {
    const list: {
      to: { id: string };
      types: { associationCategory: string; associationTypeId: number }[];
    }[] = [];
    const add = (id: string | null | undefined, typeId: number) => {
      if (id)
        list.push({
          to: { id },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: typeId }],
        });
    };
    if (object === "contact") add(assoc.companyId, ASSOC.contactToCompany);
    if (object === "deal") {
      add(assoc.companyId, ASSOC.dealToCompany);
      add(assoc.contactId, ASSOC.dealToContact);
    }
    return list;
  }

  async create(
    object: CrmObject,
    fields: Record<string, string | null>,
    assoc: CreateAssociations,
    pipelineId?: string | null,
  ): Promise<RemoteRecord> {
    const properties = this.props(object, fields);
    if (object === "deal" && pipelineId) properties.pipeline = pipelineId;
    const body = await this.call("POST", `/crm/v3/objects/${TYPE[object]}`, {
      properties,
      associations: this.assocInputs(object, assoc),
    });
    return this.toRecord(object, body, []);
  }

  async update(
    object: CrmObject,
    id: string,
    fields: Record<string, string | null>,
  ): Promise<void> {
    const properties = this.props(object, fields);
    if (!Object.keys(properties).length) return;
    await this.call("PATCH", `/crm/v3/objects/${TYPE[object]}/${encodeURIComponent(id)}`, {
      properties,
    });
  }

  async associate(object: CrmObject, id: string, assoc: CreateAssociations): Promise<void> {
    const put = (to: string, toId: string) =>
      this.call(
        "PUT",
        `/crm/v4/objects/${TYPE[object]}/${encodeURIComponent(id)}/associations/default/${to}/${encodeURIComponent(toId)}`,
      );
    if (assoc.companyId && object !== "company") await put("companies", assoc.companyId);
    if (assoc.contactId && object === "deal") await put("contacts", assoc.contactId);
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
    const filters: { propertyName: string; operator: string; value: string }[] = [];
    if (object === "contact" && key.email)
      filters.push({ propertyName: "email", operator: "EQ", value: key.email });
    else if (object === "company" && key.domain)
      filters.push({ propertyName: "domain", operator: "EQ", value: key.domain });
    else if (object === "deal" && key.name) {
      filters.push({ propertyName: "dealname", operator: "EQ", value: key.name });
      if (key.pipelineId)
        filters.push({ propertyName: "pipeline", operator: "EQ", value: key.pipelineId });
      if (key.createdAfter) {
        filters.push({
          propertyName: "createdate",
          operator: "GTE",
          value: String(key.createdAfter.getTime()),
        });
      }
    } else return [];
    const body = obj(
      await this.call(
        "POST",
        `/crm/v3/objects/${TYPE[object]}/search`,
        { filterGroups: [{ filters }], properties: this.properties(object, []), limit: 10 },
        true,
      ),
    );
    return arr(body.results).map((r) => this.toRecord(object, r, []));
  }

  async optOut(_contactId: string, email: string): Promise<OptOutResult> {
    try {
      await this.call(
        "POST",
        `/communication-preferences/v4/statuses/${encodeURIComponent(email)}/unsubscribe-all?channel=EMAIL`,
      );
      return "done";
    } catch (error) {
      if (error instanceof CrmError && error.kind === "scope") return "not_permitted";
      throw error;
    }
  }

  async addNote(target: { contactId: string; dealId?: string }, text: string): Promise<void> {
    const associations = [
      {
        to: { id: target.contactId },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: ASSOC.noteToContact }],
      },
      ...(target.dealId
        ? [
            {
              to: { id: target.dealId },
              types: [
                { associationCategory: "HUBSPOT_DEFINED", associationTypeId: ASSOC.noteToDeal },
              ],
            },
          ]
        : []),
    ];
    await this.call("POST", "/crm/v3/objects/notes", {
      properties: { hs_timestamp: new Date().toISOString(), hs_note_body: text },
      associations,
    });
  }

  recordUrl(object: CrmObject, id: string): string | null {
    if (!this.portalId) return null;
    return `${this.cfg.appBase}/contacts/${encodeURIComponent(this.portalId)}/record/${UI_TYPE[object]}/${encodeURIComponent(id)}`;
  }
}

/** Record link without a session (DTO badges). */
export function hubspotRecordUrl(
  appBase: string,
  portalId: string | undefined,
  object: CrmObject,
  id: string,
): string | null {
  if (!portalId) return null;
  return `${appBase}/contacts/${encodeURIComponent(portalId)}/record/${UI_TYPE[object]}/${encodeURIComponent(id)}`;
}
