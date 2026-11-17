/**
 * In-memory Pipedrive for tests and e2e: OAuth (auto-approve authorize, Basic-auth token,
 * rotating refresh, revoke = uninstall), API v2 persons / organizations / deals (cursor lists with
 * updated_since + sort_by=update_time, ids=, status=deleted, search, create, update), v1 users /
 * fields / currencies / notes, pipelines and stages, marketing_status, per-request token costs
 * against a company-wide daily budget, and x-ratelimit-* headers.
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

type PdType = "persons" | "organizations" | "deals";

export interface PdRecord extends Json {
  id: number;
  update_time: string;
  add_time: string;
  is_deleted?: boolean;
  custom_fields: Record<string, unknown>;
}

export const FAKE_PIPEDRIVE = {
  clientId: "fake-pipedrive-client",
  clientSecret: "fake-secret",
  companyId: "7001",
};

/** Same costs as the real API's documented table (v2 list 10, update 10, search 40). */
const COST = { list: 10, get: 2, create: 10, update: 10, search: 40, meta: 10, note: 10 };

function secs(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export class FakePipedrive {
  oauth = new FakeOAuth();
  records: Record<PdType, Map<number, PdRecord>> = {
    persons: new Map(),
    organizations: new Map(),
    deals: new Map(),
  };
  notes: { content: string; person_id?: number; deal_id?: number }[] = [];
  tokensSpent = 0;
  users = [{ id: 11, email: "owner@acme.test", name: "Owner", active_flag: true }];
  currencies = ["USD", "EUR"];
  pipelines = [
    {
      id: 1,
      name: "Sales",
      stages: [
        { id: 1, name: "Qualified", order_nr: 1 },
        { id: 2, name: "Contact Made", order_nr: 2 },
        { id: 3, name: "Proposal Made", order_nr: 3 },
        { id: 4, name: "Negotiations Started", order_nr: 4 },
      ],
    },
    { id: 2, name: "Partners", stages: [{ id: 9, name: "Intro", order_nr: 1 }] },
  ];
  /** Custom field definitions (40-char hash keys in the real API). */
  fields = {
    persons: [
      { key: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", name: "Job title", field_type: "varchar" },
    ],
    organizations: [
      { key: "f0e1d2c3b4a5f0e1d2c3b4a5f0e1d2c3b4a5f0e1", name: "Website", field_type: "varchar" },
    ],
    deals: [
      {
        key: "0f1e2d3c4b5a0f1e2d3c4b5a0f1e2d3c4b5a0f1e",
        name: "Forecast note",
        field_type: "varchar",
      },
    ],
  };
  private nextId = 100;
  apiDomain = "";

  constructor(
    private readonly knobs: FakeKnobs,
    private readonly log: FakeRequestLog[],
  ) {}

  private reported(ms: number): string {
    return secs(ms + this.knobs.clockSkewMs);
  }

  // ------------------------------------------------------------ test helpers (also via /_fake)

  create(type: PdType, fields: Json): number {
    const id = this.nextId++;
    const t = Date.now();
    const rec: PdRecord = {
      custom_fields: {},
      ...fields,
      id,
      add_time: secs(t),
      update_time: secs(t),
    };
    if (type === "deals") rec.status ??= "open";
    if (type === "persons") rec.marketing_status ??= "subscribed";
    this.records[type].set(id, rec);
    return id;
  }

  edit(type: PdType, id: number, fields: Json): void {
    const r = this.records[type].get(id);
    if (!r) throw new Error(`fake pipedrive: no ${type} ${id}`);
    const { custom_fields: cf, ...rest } = fields as { custom_fields?: Json };
    Object.assign(r, rest);
    if (cf) Object.assign(r.custom_fields, cf);
    // Pipedrive's clock has one-second resolution: edits within a second share a timestamp.
    r.update_time = secs(Date.now());
  }

  remove(type: PdType, id: number): void {
    const r = this.records[type].get(id);
    if (!r) return;
    r.is_deleted = true;
    if (type === "deals") r.status = "deleted";
    r.update_time = secs(Date.now());
  }

  restore(type: PdType, id: number): void {
    const r = this.records[type].get(id);
    if (!r) return;
    r.is_deleted = false;
    if (type === "deals") r.status = "open";
    this.edit(type, id, {});
  }

  /** A Pipedrive merge deletes the losing record (no survivor is reported). */
  merge(type: PdType, loserId: number, survivorId: number): void {
    this.records[type].delete(loserId);
    this.edit(type, survivorId, {});
  }

  findPerson(email: string): PdRecord | undefined {
    return [...this.records.persons.values()].find(
      (p) =>
        !p.is_deleted && ((p.emails as { value: string }[]) ?? []).some((e) => e.value === email),
    );
  }

  // ------------------------------------------------------------ HTTP

  private basicOk(req: IncomingMessage): boolean {
    const expected = `Basic ${Buffer.from(`${FAKE_PIPEDRIVE.clientId}:${FAKE_PIPEDRIVE.clientSecret}`).toString("base64")}`;
    return req.headers.authorization === expected;
  }

  /** /pipedrive-oauth/* */
  async handleOAuth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (url.pathname === "/oauth/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      if (url.searchParams.get("client_id") !== FAKE_PIPEDRIVE.clientId || !redirectUri) {
        return send(res, 400, { error: "invalid_request" });
      }
      const target = new URL(redirectUri);
      if (this.knobs.authorizeError) {
        target.searchParams.set("error", this.knobs.authorizeError);
        this.knobs.authorizeError = null;
      } else {
        target.searchParams.set(
          "code",
          this.oauth.issueCode({
            clientId: FAKE_PIPEDRIVE.clientId,
            redirectUri,
            scopes: ["base", "contacts:full", "deals:full", "users:read"],
            challenge: url.searchParams.get("code_challenge") ?? undefined,
          }),
        );
      }
      target.searchParams.set("state", url.searchParams.get("state") ?? "");
      return redirect(res, target.toString());
    }
    const body = (await readBody(req)) as Record<string, string> | null;
    this.log.push({
      provider: "pipedrive",
      method: req.method ?? "",
      path: `/oauth${url.pathname.slice(6)}`,
      body,
      at: Date.now(),
    });
    if (!this.basicOk(req)) return send(res, 401, { error: "invalid_client" });
    const f = body ?? {};
    if (url.pathname === "/oauth/token") {
      const t =
        f.grant_type === "authorization_code"
          ? this.oauth.redeem(f.code ?? "", f.redirect_uri ?? "", f.code_verifier)
          : f.grant_type === "refresh_token"
            ? this.oauth.rotate(f.refresh_token ?? "")
            : null;
      if (!t) return send(res, 400, { error: "invalid_grant" });
      // Pipedrive access tokens last 60 minutes.
      this.oauth.access.get(t.accessToken)!.expiresAt = Date.now() + 3_600_000;
      return send(res, 200, {
        access_token: t.accessToken,
        refresh_token: t.refreshToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope: t.scopes.join(","),
        api_domain: this.apiDomain,
      });
    }
    if (url.pathname === "/oauth/revoke") {
      this.oauth.revoke(f.token ?? "");
      return send(res, 200, { success: true });
    }
    return send(res, 404, { success: false });
  }

  private view(type: PdType, r: PdRecord): Json {
    return {
      ...r,
      update_time: this.reported(Date.parse(r.update_time)),
      add_time: this.reported(Date.parse(r.add_time)),
    };
  }

  /** /pipedrive/* */
  async handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const body = await readBody(req);
    const path = url.pathname;
    const method = req.method ?? "GET";
    this.log.push({ provider: "pipedrive", method, path, body, at: Date.now() });
    if (!this.oauth.bearer(req)) return send(res, 401, { success: false, error: "unauthorized" });

    const kind: keyof typeof COST = path.endsWith("/search")
      ? "search"
      : method === "POST"
        ? path.includes("notes")
          ? "note"
          : "create"
        : method === "PATCH"
          ? "update"
          : path.startsWith("/api/v1")
            ? "meta"
            : "list";
    if (this.tokensSpent + COST[kind] > this.knobs.dailyTokenBudget) {
      return send(
        res,
        429,
        { success: false, error: "Daily token budget exceeded" },
        { "retry-after": "3600" },
      );
    }
    if (this.knobs.fail429 > 0) {
      this.knobs.fail429 -= 1;
      return send(
        res,
        429,
        { success: false, error: "Too many requests" },
        {
          "retry-after": String(this.knobs.retryAfterSec),
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(this.knobs.retryAfterSec),
        },
      );
    }
    if (this.knobs.fail5xx > 0) {
      this.knobs.fail5xx -= 1;
      return send(res, 503, { success: false });
    }
    this.tokensSpent += COST[kind];
    const headers = {
      "x-ratelimit-remaining": "40",
      "x-ratelimit-limit": "40",
      "x-ratelimit-reset": "2",
    };
    const ok = (b: unknown, status = 200) =>
      send(res, status, { success: true, ...(b as Json) }, headers);
    const json = (body ?? {}) as Json;

    if (path === "/api/v1/users/me") {
      return ok({
        data: {
          id: 11,
          company_id: Number(FAKE_PIPEDRIVE.companyId),
          company_name: "Acme (Pipedrive)",
          company_domain: "acme",
          default_currency: this.currencies[0],
        },
      });
    }
    if (path === "/api/v1/users") return ok({ data: this.users });
    if (path === "/api/v1/currencies")
      return ok({ data: this.currencies.map((code) => ({ code, active_flag: true })) });
    let m = /^\/api\/v1\/(personFields|organizationFields|dealFields)$/.exec(path);
    if (m) {
      const type: PdType =
        m[1] === "personFields"
          ? "persons"
          : m[1] === "organizationFields"
            ? "organizations"
            : "deals";
      return ok({
        data: [
          {
            key: "name",
            name: "Name",
            field_type: "varchar",
            edit_flag: false,
            bulk_edit_allowed: true,
          },
          ...this.fields[type].map((f) => ({ ...f, edit_flag: true, bulk_edit_allowed: true })),
        ],
      });
    }
    if (path === "/api/v1/notes" && method === "POST") {
      this.notes.push({
        content: String(json.content ?? ""),
        person_id: json.person_id as number,
        deal_id: json.deal_id as number,
      });
      return ok({ data: { id: this.nextId++ } }, 201);
    }
    if (path === "/api/v2/pipelines")
      return ok({ data: this.pipelines.map(({ id, name }) => ({ id, name })) });
    if (path === "/api/v2/stages") {
      return ok({
        data: this.pipelines.flatMap((p) =>
          p.stages.map((s) => ({ ...s, pipeline_id: p.id, is_deleted: false })),
        ),
      });
    }

    m = /^\/api\/v2\/(persons|organizations|deals)(?:\/(search|\d+))?$/.exec(path);
    if (!m) return send(res, 404, { success: false, error: "Not found" });
    const type = m[1] as PdType;
    const sub = m[2];
    const store = this.records[type];

    if (!sub && method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
      const offset = url.searchParams.get("cursor")
        ? Number(Buffer.from(url.searchParams.get("cursor")!, "base64url").toString())
        : 0;
      const ids = url.searchParams.get("ids")?.split(",").map(Number);
      const since = url.searchParams.get("updated_since");
      const status = url.searchParams.get("status");
      const lagCutoff = Date.now() - this.knobs.indexLagMs;
      let rows = [...store.values()];
      if (ids) rows = rows.filter((r) => ids.includes(r.id));
      else if (type === "deals" && status === "deleted")
        rows = rows.filter((r) => r.status === "deleted");
      else rows = rows.filter((r) => !r.is_deleted);
      if (since)
        rows = rows.filter(
          (r) =>
            Date.parse(r.update_time) + this.knobs.clockSkewMs >= Date.parse(since) &&
            Date.parse(r.update_time) <= lagCutoff,
        );
      const pipeline = url.searchParams.get("pipeline_id");
      if (pipeline) rows = rows.filter((r) => String(r.pipeline_id) === pipeline);
      rows.sort((a, b) =>
        url.searchParams.get("sort_by") === "update_time"
          ? Date.parse(a.update_time) - Date.parse(b.update_time) || a.id - b.id
          : a.id - b.id,
      );
      const page = rows.slice(offset, offset + limit);
      return ok({
        data: page.map((r) => this.view(type, r)),
        additional_data: {
          next_cursor:
            offset + limit < rows.length
              ? Buffer.from(String(offset + limit)).toString("base64url")
              : null,
        },
      });
    }
    if (sub === "search" && method === "GET") {
      const term = (url.searchParams.get("term") ?? "").toLowerCase();
      const field = url.searchParams.get("fields");
      const hits = [...store.values()].filter((r) => {
        if (r.is_deleted) return false;
        if (field === "email")
          return ((r.emails as { value: string }[]) ?? []).some(
            (e) => e.value.toLowerCase() === term,
          );
        if (field === "title") return String(r.title ?? "").toLowerCase() === term;
        if (field === "custom_fields")
          return Object.values(r.custom_fields).some((v) => String(v).toLowerCase() === term);
        return String(r.name ?? "").toLowerCase() === term;
      });
      return ok({ data: { items: hits.map((r) => ({ result_score: 1, item: { id: r.id } })) } });
    }
    if (!sub && method === "POST") {
      if (type === "deals" && json.currency && !this.currencies.includes(String(json.currency))) {
        return send(res, 400, { success: false, error: "Currency not enabled" });
      }
      if (type === "deals") json.status ??= "open";
      const id = this.create(type, json);
      return ok({ data: this.view(type, store.get(id)!) }, 201);
    }
    if (sub && method === "PATCH") {
      const r = store.get(Number(sub));
      if (!r || r.is_deleted) return send(res, 404, { success: false, error: "Not found" });
      if ("marketing_status" in json) {
        // Campaigns off: the field can't be set; and it changes to unsubscribed only once.
        if (!this.knobs.campaigns)
          return send(res, 400, { success: false, error: "Campaigns not enabled" });
        if (r.marketing_status === "unsubscribed" && json.marketing_status !== "unsubscribed") {
          return send(res, 400, { success: false, error: "Can't re-subscribe" });
        }
      }
      if (type === "deals" && json.currency && !this.currencies.includes(String(json.currency))) {
        return send(res, 400, { success: false, error: "Currency not enabled" });
      }
      this.edit(type, r.id, json);
      return ok({ data: this.view(type, r) });
    }
    return send(res, 405, { success: false });
  }

  writes(log: FakeRequestLog[]): FakeRequestLog[] {
    return log.filter(
      (l) =>
        l.provider === "pipedrive" &&
        !l.path.startsWith("/oauth") &&
        (l.method === "POST" ||
          l.method === "PATCH" ||
          l.method === "PUT" ||
          l.method === "DELETE"),
    );
  }
}
