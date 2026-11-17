/**
 * In-memory HubSpot for tests and e2e: OAuth (auto-approve authorize, token, rotating refresh,
 * revoke), account info, CRM objects v3 (list / search / batch read / create / update), merges,
 * deletes and restores, associations v4, pipelines, properties, owners, notes and
 * unsubscribe-all. Request and response shapes follow HubSpot's documented examples.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  FakeOAuth,
  readBody,
  redirect,
  send,
  type FakeKnobs,
  type FakeRequestLog,
  type Json,
} from "./common";

type HsType = "contacts" | "companies" | "deals";
const TYPES: HsType[] = ["contacts", "companies", "deals"];
const MODIFIED: Record<HsType, string> = {
  contacts: "lastmodifieddate",
  companies: "hs_lastmodifieddate",
  deals: "hs_lastmodifieddate",
};

export interface HsRecord {
  id: string;
  properties: Record<string, string | null>;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  mergedInto?: string;
  mergedIds: string[];
}

export const FAKE_HUBSPOT = {
  clientId: "fake-hubspot-client",
  clientSecret: "fake-secret",
  portalId: "900123",
};

export class FakeHubSpot {
  oauth = new FakeOAuth();
  records: Record<HsType, Map<string, HsRecord>> = {
    contacts: new Map(),
    companies: new Map(),
    deals: new Map(),
  };
  /** "<fromType>:<id>" → "<toType>" → ids */
  assoc = new Map<string, Map<string, Set<string>>>();
  notes: { body: string; contactIds: string[]; dealIds: string[] }[] = [];
  unsubscribed: string[] = [];
  currencies = ["USD"];
  owners = [{ id: "501", email: "owner@acme.test" }];
  pipelines = [
    {
      id: "default",
      label: "Sales Pipeline",
      stages: [
        {
          id: "appointmentscheduled",
          label: "Appointment Scheduled",
          metadata: { isClosed: "false", probability: "0.2" },
        },
        {
          id: "qualifiedtobuy",
          label: "Qualified To Buy",
          metadata: { isClosed: "false", probability: "0.4" },
        },
        {
          id: "presentationscheduled",
          label: "Presentation Scheduled",
          metadata: { isClosed: "false", probability: "0.6" },
        },
        {
          id: "contractsent",
          label: "Contract Sent",
          metadata: { isClosed: "false", probability: "0.9" },
        },
        {
          id: "closedwon",
          label: "Closed Won",
          metadata: { isClosed: "true", probability: "1.0" },
        },
        {
          id: "closedlost",
          label: "Closed Lost",
          metadata: { isClosed: "true", probability: "0.0" },
        },
      ],
    },
    {
      id: "renewals",
      label: "Renewals",
      stages: [
        { id: "r1", label: "Renewal open", metadata: { isClosed: "false", probability: "0.5" } },
      ],
    },
  ];
  customProperties: Record<
    HsType,
    { name: string; label: string; type: string; readOnly?: boolean }[]
  > = {
    contacts: [{ name: "tier", label: "Tier", type: "string" }],
    companies: [{ name: "industry", label: "Industry", type: "string" }],
    deals: [{ name: "forecast_note", label: "Forecast note", type: "string" }],
  };
  private nextId = 1000;

  constructor(
    private readonly knobs: FakeKnobs,
    private readonly log: FakeRequestLog[],
  ) {}

  private now(): number {
    return Date.now();
  }
  private reported(ms: number): string {
    return new Date(ms + this.knobs.clockSkewMs).toISOString();
  }

  // ------------------------------------------------------------ test helpers (also via /_fake)

  /** Creates a record directly in the "CRM" (as if a user typed it there). */
  create(
    type: HsType,
    properties: Record<string, string | null>,
    assoc: Partial<Record<HsType, string[]>> = {},
  ): string {
    const id = String(this.nextId++);
    const t = this.now();
    this.records[type].set(id, {
      id,
      properties: { ...properties },
      createdAt: t,
      updatedAt: t,
      archived: false,
      mergedIds: [],
    });
    for (const [to, ids] of Object.entries(assoc))
      for (const toId of ids ?? []) this.link(type, id, to as HsType, toId);
    return id;
  }

  edit(type: HsType, id: string, properties: Record<string, string | null>): void {
    const r = this.records[type].get(id);
    if (!r) throw new Error(`fake hubspot: no ${type} ${id}`);
    Object.assign(r.properties, properties);
    r.updatedAt = Math.max(this.now(), r.updatedAt + 1);
  }

  remove(type: HsType, id: string): void {
    const r = this.records[type].get(id);
    if (r) {
      r.archived = true;
      r.updatedAt = this.now();
    }
  }

  restore(type: HsType, id: string): void {
    const r = this.records[type].get(id);
    if (r) {
      r.archived = false;
      r.updatedAt = Math.max(this.now(), r.updatedAt + 1);
    }
  }

  /** HubSpot merge: the loser disappears; reading it returns the survivor. */
  merge(type: HsType, loserId: string, survivorId: string): void {
    const loser = this.records[type].get(loserId);
    const survivor = this.records[type].get(survivorId);
    if (!loser || !survivor) throw new Error("fake hubspot: merge of unknown records");
    loser.mergedInto = survivorId;
    loser.archived = true;
    survivor.mergedIds.push(loserId, ...loser.mergedIds);
    survivor.updatedAt = Math.max(this.now(), survivor.updatedAt + 1);
  }

  link(from: HsType, id: string, to: HsType, toId: string): void {
    const add = (a: HsType, aId: string, b: HsType, bId: string) => {
      const key = `${a}:${aId}`;
      if (!this.assoc.has(key)) this.assoc.set(key, new Map());
      const m = this.assoc.get(key)!;
      if (!m.has(b)) m.set(b, new Set());
      m.get(b)!.add(bId);
    };
    add(from, id, to, toId);
    add(to, toId, from, id);
  }

  associations(from: HsType, id: string, to: HsType): string[] {
    return [...(this.assoc.get(`${from}:${id}`)?.get(to) ?? [])];
  }

  find(type: HsType, prop: string, value: string): HsRecord | undefined {
    return [...this.records[type].values()].find(
      (r) => !r.archived && r.properties[prop] === value,
    );
  }

  // ------------------------------------------------------------ HTTP

  private view(
    type: HsType,
    r: HsRecord,
    properties: string[] | null,
    assocTypes: HsType[] = [],
  ): Json {
    const props: Record<string, string | null> = {};
    const keys = properties ?? Object.keys(r.properties);
    for (const k of keys) props[k] = r.properties[k] ?? null;
    props[MODIFIED[type]] = this.reported(r.updatedAt);
    props.createdate = this.reported(r.createdAt);
    props.hs_object_id = r.id;
    if (r.mergedIds.length) props.hs_merged_object_ids = r.mergedIds.join(";");
    const out: Json = {
      id: r.id,
      properties: props,
      createdAt: this.reported(r.createdAt),
      updatedAt: this.reported(r.updatedAt),
      archived: r.archived,
    };
    if (assocTypes.length) {
      const a: Json = {};
      for (const t of assocTypes) {
        const ids = this.associations(type, r.id, t);
        if (ids.length) a[t] = { results: ids.map((x) => ({ id: x, type: `${type}_to_${t}` })) };
      }
      out.associations = a;
    }
    return out;
  }

  /** Handles /hubspot-app/* (consent screen, record pages). */
  async handleApp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (url.pathname === "/oauth/authorize") {
      const clientId = url.searchParams.get("client_id");
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state") ?? "";
      if (clientId !== FAKE_HUBSPOT.clientId || !redirectUri)
        return send(res, 400, { error: "invalid_request" });
      const target = new URL(redirectUri);
      if (this.knobs.authorizeError) {
        target.searchParams.set("error", this.knobs.authorizeError);
        this.knobs.authorizeError = null;
      } else {
        const scopes = (url.searchParams.get("scope") ?? "").split(" ").filter(Boolean);
        if (this.knobs.grantOptionalScopes) {
          scopes.push(...(url.searchParams.get("optional_scope") ?? "").split(" ").filter(Boolean));
        }
        target.searchParams.set(
          "code",
          this.oauth.issueCode({
            clientId,
            redirectUri,
            scopes,
            challenge: url.searchParams.get("code_challenge") ?? undefined,
          }),
        );
      }
      target.searchParams.set("state", state);
      return redirect(res, target.toString());
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("Fake HubSpot record page");
  }

  /** Handles /hubspot/* (API). */
  async handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const body = await readBody(req);
    const path = url.pathname;
    const method = req.method ?? "GET";
    this.log.push({ provider: "hubspot", method, path, body, at: Date.now() });

    if (path === "/oauth/2026-03/token" && method === "POST") {
      const f = (body ?? {}) as Record<string, string>;
      if (f.client_id !== FAKE_HUBSPOT.clientId || f.client_secret !== FAKE_HUBSPOT.clientSecret) {
        return send(res, 401, { error: "invalid_client" });
      }
      const t =
        f.grant_type === "authorization_code"
          ? this.oauth.redeem(f.code ?? "", f.redirect_uri ?? "", f.code_verifier)
          : f.grant_type === "refresh_token"
            ? this.oauth.rotate(f.refresh_token ?? "")
            : null;
      if (!t) return send(res, 400, { error: "invalid_grant" });
      return send(res, 200, {
        access_token: t.accessToken,
        refresh_token: t.refreshToken,
        expires_in: t.ttlSec,
        token_type: "bearer",
        scopes: t.scopes,
        hub_id: Number(FAKE_HUBSPOT.portalId),
      });
    }
    if (path === "/oauth/2026-03/token/revoke" && method === "POST") {
      const f = (body ?? {}) as Record<string, string>;
      if (f.client_id !== FAKE_HUBSPOT.clientId || f.client_secret !== FAKE_HUBSPOT.clientSecret) {
        return send(res, 401, { error: "invalid_client" });
      }
      this.oauth.revoke(f.token ?? "");
      return send(res, 204);
    }

    const auth = this.oauth.bearer(req);
    if (!auth) return send(res, 401, { status: "error", category: "INVALID_AUTHENTICATION" });
    if (this.knobs.fail429 > 0) {
      this.knobs.fail429 -= 1;
      return send(
        res,
        429,
        { status: "error", category: "RATE_LIMITS" },
        { "retry-after": String(this.knobs.retryAfterSec) },
      );
    }
    if (this.knobs.fail5xx > 0) {
      this.knobs.fail5xx -= 1;
      return send(res, 503, { status: "error" });
    }
    const headers = { "x-hubspot-ratelimit-remaining": "100", "x-hubspot-ratelimit-max": "110" };
    const ok = (b: unknown, status = 200) => send(res, status, b, headers);
    const json = (body ?? {}) as Json;

    if (path === "/account-info/v3/details") {
      return ok({
        portalId: Number(FAKE_HUBSPOT.portalId),
        uiDomain: "app.hubspot.com",
        companyCurrency: this.currencies[0],
        additionalCurrencies: this.currencies.slice(1),
        timeZone: "US/Eastern",
      });
    }
    if (path === "/crm/v3/pipelines/deals") return ok({ results: this.pipelines });
    let m = /^\/crm\/v3\/properties\/(contacts|companies|deals)$/.exec(path);
    if (m) {
      const type = m[1] as HsType;
      const std: Record<HsType, string[]> = {
        contacts: [
          "email",
          "firstname",
          "lastname",
          "jobtitle",
          "phone",
          "hubspot_owner_id",
          "hs_email_optout",
        ],
        companies: ["name", "domain"],
        deals: [
          "dealname",
          "amount",
          "deal_currency_code",
          "dealstage",
          "pipeline",
          "closedate",
          "closed_lost_reason",
        ],
      };
      return ok({
        results: [
          ...std[type].map((name) => ({
            name,
            label: name,
            type: "string",
            modificationMetadata: { readOnlyValue: false },
          })),
          ...this.customProperties[type].map((p) => ({
            name: p.name,
            label: p.label,
            type: p.type,
            modificationMetadata: { readOnlyValue: p.readOnly === true },
          })),
          {
            name: "hs_calculated_score",
            label: "Score",
            type: "number",
            calculated: true,
            modificationMetadata: { readOnlyValue: true },
          },
        ],
      });
    }
    if (path === "/crm/v3/owners")
      return ok({ results: this.owners.map((o) => ({ ...o, firstName: "O", lastName: "Wner" })) });

    m = /^\/communication-preferences\/v4\/statuses\/([^/]+)\/unsubscribe-all$/.exec(path);
    if (m && method === "POST") {
      if (!auth.scopes.includes("communication_preferences.write")) {
        return send(res, 403, { status: "error", category: "MISSING_SCOPES" });
      }
      const email = decodeURIComponent(m[1]!);
      this.unsubscribed.push(email);
      const c = this.find("contacts", "email", email);
      if (c) this.edit("contacts", c.id, { hs_email_optout: "true" });
      return ok({ results: [] });
    }

    if (path === "/crm/v3/objects/notes" && method === "POST") {
      const assoc =
        (json.associations as { to: { id: string }; types: { associationTypeId: number }[] }[]) ??
        [];
      this.notes.push({
        body: String((json.properties as Json)?.hs_note_body ?? ""),
        contactIds: assoc.filter((a) => a.types[0]?.associationTypeId === 202).map((a) => a.to.id),
        dealIds: assoc.filter((a) => a.types[0]?.associationTypeId === 214).map((a) => a.to.id),
      });
      return ok({ id: String(this.nextId++) }, 201);
    }

    m =
      /^\/crm\/v4\/associations\/(contacts|companies|deals)\/(contacts|companies|deals)\/batch\/read$/.exec(
        path,
      );
    if (m && method === "POST") {
      const from = m[1] as HsType;
      const to = m[2] as HsType;
      const inputs = (json.inputs as { id: string }[]) ?? [];
      return ok({
        results: inputs
          .filter((i) => this.records[from].has(i.id))
          .map((i) => ({
            from: { id: i.id },
            to: this.associations(from, i.id, to).map((x) => ({
              toObjectId: Number(x),
              associationTypes: [],
            })),
          })),
      });
    }
    m =
      /^\/crm\/v4\/objects\/(contacts|companies|deals)\/([^/]+)\/associations\/default\/(contacts|companies|deals)\/([^/]+)$/.exec(
        path,
      );
    if (m && method === "PUT") {
      const from = m[1] as HsType;
      const to = m[3] as HsType;
      // Primary company: replace the previous one.
      if (to === "companies" || (from === "deals" && to === "contacts")) {
        for (const old of this.associations(from, m[2]!, to)) {
          this.assoc.get(`${from}:${m[2]}`)?.get(to)?.delete(old);
          this.assoc.get(`${to}:${old}`)?.get(from)?.delete(m[2]!);
        }
      }
      this.link(from, m[2]!, to, m[4]!);
      const r = this.records[from].get(m[2]!);
      if (r) r.updatedAt = Math.max(this.now(), r.updatedAt + 1);
      return ok({ status: "COMPLETE" });
    }

    m = /^\/crm\/v3\/objects\/(contacts|companies|deals)(?:\/(search|batch\/read|[^/]+))?$/.exec(
      path,
    );
    if (!m) return send(res, 404, { status: "error", category: "OBJECT_NOT_FOUND" });
    const type = m[1] as HsType;
    const sub = m[2];
    const store = this.records[type];

    if (!sub && method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 10), 100);
      const after = Number(url.searchParams.get("after") ?? 0);
      const props = url.searchParams.get("properties")?.split(",") ?? null;
      const assocTypes = (url.searchParams.get("associations")?.split(",") ?? []).filter(
        (t): t is HsType => TYPES.includes(t as HsType),
      );
      const all = [...store.values()]
        .filter((r) => !r.archived)
        .sort((a, b) => Number(a.id) - Number(b.id));
      const page = all.slice(after, after + limit);
      return ok({
        results: page.map((r) => this.view(type, r, props, assocTypes)),
        ...(after + limit < all.length
          ? { paging: { next: { after: String(after + limit) } } }
          : {}),
      });
    }
    if (!sub && method === "POST") {
      const props = (json.properties ?? {}) as Record<string, string>;
      if (type === "contacts" && props.email && this.find("contacts", "email", props.email)) {
        return send(res, 409, {
          status: "error",
          category: "CONFLICT",
          message: "Contact already exists",
        });
      }
      if (
        type === "deals" &&
        props.deal_currency_code &&
        !this.currencies.includes(props.deal_currency_code)
      ) {
        return send(res, 400, { status: "error", category: "VALIDATION_ERROR" });
      }
      const id = this.create(type, props);
      for (const a of (json.associations as {
        to: { id: string };
        types: { associationTypeId: number }[];
      }[]) ?? []) {
        const typeId = a.types[0]?.associationTypeId;
        const to: HsType = typeId === 3 ? "contacts" : "companies";
        this.link(type, id, to, a.to.id);
      }
      return ok(this.view(type, store.get(id)!, null), 201);
    }
    if (sub === "search" && method === "POST") {
      const limit = Math.min(Number(json.limit ?? 10), 200);
      const after = Number(json.after ?? 0);
      if (after + limit > this.knobs.searchCap) {
        return send(res, 400, {
          status: "error",
          category: "VALIDATION_ERROR",
          message: "Search window exceeded",
        });
      }
      const filters =
        ((json.filterGroups as {
          filters: { propertyName: string; operator: string; value: string }[];
        }[]) ?? [])[0]?.filters ?? [];
      const lagCutoff = this.now() - this.knobs.indexLagMs;
      let rows = [...store.values()].filter(
        (r) => !r.archived && (!this.knobs.indexLagMs || r.updatedAt <= lagCutoff),
      );
      for (const f of filters) {
        rows = rows.filter((r) => {
          if (f.propertyName === MODIFIED[type])
            return r.updatedAt + this.knobs.clockSkewMs >= Number(f.value);
          if (f.propertyName === "createdate")
            return r.createdAt + this.knobs.clockSkewMs >= Number(f.value);
          const v = r.properties[f.propertyName];
          return f.operator === "EQ" ? (v ?? "").toLowerCase() === f.value.toLowerCase() : true;
        });
      }
      rows.sort((a, b) => a.updatedAt - b.updatedAt || Number(a.id) - Number(b.id));
      const page = rows.slice(after, after + limit);
      return ok({
        total: rows.length,
        results: page.map((r) => this.view(type, r, (json.properties as string[]) ?? null)),
        ...(after + limit < rows.length
          ? { paging: { next: { after: String(after + limit) } } }
          : {}),
      });
    }
    if (sub === "batch/read" && method === "POST") {
      const inputs = (json.inputs as { id: string }[]) ?? [];
      if (inputs.length > 100)
        return send(res, 400, { status: "error", category: "VALIDATION_ERROR" });
      const out = new Map<string, HsRecord>();
      for (const { id } of inputs) {
        let r = store.get(id);
        while (r?.mergedInto) r = store.get(r.mergedInto);
        if (r && !r.archived) out.set(r.id, r);
      }
      return ok({
        status: "COMPLETE",
        results: [...out.values()].map((r) =>
          this.view(type, r, (json.properties as string[]) ?? null),
        ),
      });
    }
    if (sub && method === "PATCH") {
      const r = store.get(sub);
      if (!r || r.archived)
        return send(res, 404, { status: "error", category: "OBJECT_NOT_FOUND" });
      const props = (json.properties ?? {}) as Record<string, string>;
      if (
        type === "deals" &&
        props.deal_currency_code &&
        !this.currencies.includes(props.deal_currency_code)
      ) {
        return send(res, 400, { status: "error", category: "VALIDATION_ERROR" });
      }
      // HubSpot never re-subscribes through a property write.
      if (props.hs_email_optout === "false" && r.properties.hs_email_optout === "true")
        delete props.hs_email_optout;
      this.edit(type, sub, props);
      return ok(this.view(type, r, null));
    }
    if (sub && method === "GET") {
      const r = store.get(sub);
      if (!r || r.archived)
        return send(res, 404, { status: "error", category: "OBJECT_NOT_FOUND" });
      return ok(this.view(type, r, null));
    }
    return send(res, 405, { status: "error" });
  }

  /** Every API write this fake received (create / update / associate / note / unsubscribe). */
  writes(log: FakeRequestLog[]): FakeRequestLog[] {
    return log.filter(
      (l) =>
        l.provider === "hubspot" &&
        !l.path.startsWith("/oauth") &&
        ((l.method === "POST" && !/\/(search|batch\/read)$/.test(l.path)) ||
          l.method === "PATCH" ||
          l.method === "PUT" ||
          l.method === "DELETE"),
    );
  }
}
