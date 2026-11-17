/**
 * One local HTTP server hosting both fake CRMs (tests and e2e; never production):
 *   /hubspot/*          HubSpot API (api.hubapi.com)
 *   /hubspot-app/*      HubSpot consent screen + record pages (app.hubspot.com)
 *   /pipedrive-oauth/*  Pipedrive OAuth (oauth.pipedrive.com)
 *   /pipedrive/*        Pipedrive company API domain (<company>.pipedrive.com)
 *   /_fake/*            control plane for e2e: state, knobs, records "edited in the CRM"
 *   /health
 * Point the API at it with CRM_MODE=fake and CRM_FAKE_BASE_URL=http://127.0.0.1:<port>.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  DEFAULT_KNOBS,
  readBody,
  send,
  type FakeKnobs,
  type FakeRequestLog,
  type Json,
} from "./common";
import { FakeHubSpot } from "./fake-hubspot";
import { FakePipedrive } from "./fake-pipedrive";

export { FAKE_HUBSPOT } from "./fake-hubspot";
export { FAKE_PIPEDRIVE } from "./fake-pipedrive";
export type { FakeHubSpot } from "./fake-hubspot";
export type { FakePipedrive } from "./fake-pipedrive";
export type { FakeKnobs, FakeRequestLog } from "./common";

export class FakeCrmServer {
  knobs: FakeKnobs = { ...DEFAULT_KNOBS };
  log: FakeRequestLog[] = [];
  hubspot = new FakeHubSpot(this.knobs, this.log);
  pipedrive = new FakePipedrive(this.knobs, this.log);
  /** Called before every request is answered (tests: "something happens mid-run"). */
  onRequest?: (method: string, path: string) => void | Promise<void>;
  private server?: Server;
  url = "";

  async start(port = 0, host = "127.0.0.1"): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) send(res, 500, { error: "fake_crm_error" });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    const addr = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${addr.port}`;
    this.pipedrive.apiDomain = `${this.url}/pipedrive`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }

  /** Fresh state (same URL). */
  reset(): void {
    Object.assign(this.knobs, DEFAULT_KNOBS);
    this.log.length = 0;
    this.onRequest = undefined;
    this.hubspot = new FakeHubSpot(this.knobs, this.log);
    this.pipedrive = new FakePipedrive(this.knobs, this.log);
    this.pipedrive.apiDomain = `${this.url}/pipedrive`;
  }

  /** API writes received (assert "nothing was written to the CRM"). */
  writes(): FakeRequestLog[] {
    return [...this.hubspot.writes(this.log), ...this.pipedrive.writes(this.log)];
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    if (this.knobs.latencyMs) await new Promise((r) => setTimeout(r, this.knobs.latencyMs));
    if (this.onRequest) await this.onRequest(req.method ?? "GET", url.pathname);
    const strip = (prefix: string) =>
      new URL(url.pathname.slice(prefix.length) + url.search, "http://fake");
    if (url.pathname === "/health") return send(res, 200, { ok: true });
    if (url.pathname.startsWith("/hubspot-app/"))
      return this.hubspot.handleApp(req, res, strip("/hubspot-app"));
    if (url.pathname.startsWith("/hubspot/"))
      return this.hubspot.handleApi(req, res, strip("/hubspot"));
    if (url.pathname.startsWith("/pipedrive-oauth/"))
      return this.pipedrive.handleOAuth(req, res, strip("/pipedrive-oauth"));
    if (url.pathname.startsWith("/pipedrive/"))
      return this.pipedrive.handleApi(req, res, strip("/pipedrive"));
    if (url.pathname.startsWith("/_fake/")) return this.control(req, res, url);
    return send(res, 404, { error: "not_found" });
  }

  /**
   * Control plane (e2e):
   *   GET  /_fake/state                       records, notes, opt-outs, revocations, writes
   *   POST /_fake/reset
   *   POST /_fake/knobs                       { fail429?, latencyMs?, ... }
   *   POST /_fake/expire-tokens               every access token stops working
   *   POST /_fake/:provider/:type             create  { ...fields }  → { id }
   *   PATCH /_fake/:provider/:type/:id        edit (bumps the modified time)
   *   DELETE /_fake/:provider/:type/:id       delete (HubSpot archive / Pipedrive delete)
   *   POST /_fake/:provider/:type/:id/restore
   *   POST /_fake/:provider/:type/merge       { loserId, survivorId }
   * :type is contacts | companies | deals for both providers.
   */
  private async control(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const body = ((await readBody(req)) ?? {}) as Json;
    const parts = url.pathname.split("/").filter(Boolean).slice(1);
    const method = req.method ?? "GET";
    if (parts[0] === "state" && method === "GET") {
      const dump = (m: Map<unknown, unknown>) => [...m.values()];
      return send(res, 200, {
        hubspot: {
          contacts: dump(this.hubspot.records.contacts),
          companies: dump(this.hubspot.records.companies),
          deals: dump(this.hubspot.records.deals),
          notes: this.hubspot.notes,
          unsubscribed: this.hubspot.unsubscribed,
          revoked: this.hubspot.oauth.revoked.length,
        },
        pipedrive: {
          contacts: dump(this.pipedrive.records.persons),
          companies: dump(this.pipedrive.records.organizations),
          deals: dump(this.pipedrive.records.deals),
          notes: this.pipedrive.notes,
          tokensSpent: this.pipedrive.tokensSpent,
          revoked: this.pipedrive.oauth.revoked.length,
        },
        writes: this.writes().length,
      });
    }
    if (parts[0] === "reset" && method === "POST") {
      this.reset();
      return send(res, 200, { ok: true });
    }
    if (parts[0] === "knobs" && method === "POST") {
      for (const [k, v] of Object.entries(body)) {
        if (k in this.knobs) (this.knobs as unknown as Json)[k] = v;
      }
      return send(res, 200, this.knobs);
    }
    if (parts[0] === "expire-tokens" && method === "POST") {
      this.hubspot.oauth.expireAll();
      this.pipedrive.oauth.expireAll();
      return send(res, 200, { ok: true });
    }
    const [provider, type, id, action] = parts;
    const pdType = { contacts: "persons", companies: "organizations", deals: "deals" } as const;
    if (
      provider === "hubspot" &&
      (type === "contacts" || type === "companies" || type === "deals")
    ) {
      const hs = this.hubspot;
      if (id === "merge" && method === "POST") {
        hs.merge(type, String(body.loserId), String(body.survivorId));
        return send(res, 200, { ok: true });
      }
      if (!id && method === "POST") {
        const { associations, ...props } = body as {
          associations?: Record<string, string[]>;
        } & Json;
        return send(res, 201, {
          id: hs.create(type, props as Record<string, string>, associations as never),
        });
      }
      if (id && action === "restore") hs.restore(type, id);
      else if (id && method === "PATCH") hs.edit(type, id, body as Record<string, string>);
      else if (id && method === "DELETE") hs.remove(type, id);
      else return send(res, 404, { error: "not_found" });
      return send(res, 200, { ok: true });
    }
    if (
      provider === "pipedrive" &&
      (type === "contacts" || type === "companies" || type === "deals")
    ) {
      const pd = this.pipedrive;
      const t = pdType[type];
      if (id === "merge" && method === "POST") {
        pd.merge(t, Number(body.loserId), Number(body.survivorId));
        return send(res, 200, { ok: true });
      }
      if (!id && method === "POST") return send(res, 201, { id: String(pd.create(t, body)) });
      if (id && action === "restore") pd.restore(t, Number(id));
      else if (id && method === "PATCH") pd.edit(t, Number(id), body);
      else if (id && method === "DELETE") pd.remove(t, Number(id));
      else return send(res, 404, { error: "not_found" });
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "not_found" });
  }
}
