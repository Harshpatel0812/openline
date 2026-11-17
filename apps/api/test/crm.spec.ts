/** CRM sync API (OL-E8): connect, setup, preview / import, control, log, badges, isolation. */
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createOAuth, resolveCrmConfig } from "@openline/crm";
import { FakeCrmServer } from "@openline/crm/dist/fake";
import {
  auditLog,
  contacts,
  crmConnections,
  crmLinks,
  crmSyncErrors,
  crmSyncRuns,
  eq,
  sql,
  suppressions,
  withTenant,
  workspaces,
  type DatabaseHandle,
} from "@openline/db";
import { openJson } from "@openline/email";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CONFIG, type AppConfig } from "../src/config";
import { DB } from "../src/database/database.module";
import { CrmSchedulerService } from "../src/modules/integrations/crm-scheduler.service";
import { createCrmState } from "../src/modules/integrations/crm-oauth-state";
import { CrmService } from "../src/modules/integrations/crm.service";
import {
  browser,
  createTestApp,
  joinVerifiedAs,
  signedUp,
  verifiedSignup,
  type Browser,
} from "./helpers";

const PAGE = "http://localhost:3000/app/settings/integrations";

describe("CRM sync API", () => {
  const fake = new FakeCrmServer();
  let app: NestExpressApplication;
  let handle: DatabaseHandle;
  let config: AppConfig;

  beforeAll(async () => {
    const url = await fake.start();
    app = await createTestApp({ CRM_FAKE_BASE_URL: url });
    handle = app.get<DatabaseHandle>(DB);
    config = app.get<AppConfig>(CONFIG);
  });
  afterAll(async () => {
    await app.close();
    await fake.stop();
    delete process.env.CRM_FAKE_BASE_URL;
  });
  beforeEach(() => fake.reset());

  const me = async (b: Browser) =>
    (await b.get("/v1/auth/me").expect(200)).body as {
      user: { id: string };
      workspace: { id: string };
    };
  const engine = () => app.get(CrmSchedulerService).engine;
  const asWs = <T>(ws: string, fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(handle.db, { workspaceId: ws }, fn);

  /** Follows the consent URL on the fake (auto-approve) and returns the callback path + query. */
  async function consent(b: Browser, provider = "hubspot"): Promise<string> {
    const { url } = (await b.get(`/v1/integrations/crm/${provider}/authorize`).expect(200))
      .body as { url: string };
    const res = await fetch(url, { redirect: "manual" });
    const back = new URL(res.headers.get("location")!);
    return `${back.pathname.replace(/^\/api/, "")}${back.search}`;
  }

  async function connect(b: Browser, provider = "hubspot"): Promise<string> {
    const res = await b.get(await consent(b, provider)).expect(302);
    expect(res.headers.location).toBe(`${PAGE}?connected=${provider}`);
    return (await me(b)).workspace.id;
  }

  /** Connect → pipeline → suggested stage mapping saved → preview → import, through the API. */
  async function connectAndImport(b: Browser): Promise<{ ws: string; previewId: string }> {
    const ws = await connect(b);
    await b.patch("/v1/integrations/crm", { pipelineId: "default" }).expect(200);
    const suggestion = (await b.get("/v1/integrations/crm/stage-mappings").expect(200)).body;
    const saved = (
      await b
        .put("/v1/integrations/crm/stage-mappings", {
          fromCrm: suggestion.fromCrm,
          toCrm: suggestion.toCrm,
        })
        .expect(200)
    ).body;
    expect(saved.complete).toBe(true);
    const { runId } = (await b.post("/v1/integrations/crm/import/preview").expect(202)).body;
    const [conn] = await asWs(ws, (tx) => tx.select().from(crmConnections));
    expect(await engine().syncConnection(ws, conn!.id)).toBe("previewed");
    await b
      .post("/v1/integrations/crm/import", { previewId: runId, confirmLawfulBasis: true })
      .expect(202);
    expect(await engine().syncConnection(ws, conn!.id)).toBe("imported");
    return { ws, previewId: runId };
  }

  describe("connect", () => {
    it("an admin connects HubSpot: minimal scopes, sealed tokens, audited; manager / rep → 403", async () => {
      const { b } = await verifiedSignup(app);
      const { url } = (await b.get("/v1/integrations/crm/hubspot/authorize").expect(200)).body;
      const consentUrl = new URL(url);
      expect(consentUrl.origin).toBe(fake.url);
      expect(consentUrl.searchParams.get("redirect_uri")).toBe(
        "http://localhost:3000/api/v1/integrations/crm/hubspot/callback",
      );
      const scopes = consentUrl.searchParams.get("scope")!.split(" ");
      expect(scopes.filter((x) => /admin|webhook|mail|^crm\.schemas\..*\.write$/.test(x))).toEqual(
        [],
      );
      expect(consentUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const ws = await connect(b);
      const [row] = await asWs(ws, (tx) => tx.select().from(crmConnections));
      expect(row).toMatchObject({
        provider: "hubspot",
        status: "needs_setup",
        accountId: "900123",
      });
      expect(row!.secretSealed).toMatch(/^v1\./);
      expect(row!.secretSealed).not.toContain("rt-");
      expect(
        openJson<{ refreshToken: string }>(row!.secretSealed, config.secretsKey, ws).refreshToken,
      ).toMatch(/^rt-/);
      const audits = await asWs(ws, (tx) =>
        tx.select().from(auditLog).where(eq(auditLog.action, "crm.connected")),
      );
      expect(audits).toHaveLength(1);
      expect(JSON.stringify(audits)).not.toMatch(/rt-|at-/);

      const status = (await b.get("/v1/integrations/crm").expect(200)).body;
      expect(status).toMatchObject({
        entitled: true,
        available: ["hubspot", "pipedrive"],
        connection: { provider: "hubspot", status: "needs_setup", canPushOptOuts: true },
      });
      expect(JSON.stringify(status)).not.toMatch(/secret|rt-|at-|cursors/);

      const manager = await joinVerifiedAs(app, b, "manager");
      const rep = await joinVerifiedAs(app, b, "rep");
      await manager.b.get("/v1/integrations/crm/hubspot/authorize").expect(403);
      await rep.b.get("/v1/integrations/crm/hubspot/authorize").expect(403);
      await rep.b.post("/v1/integrations/crm/pause").expect(403);
      await rep.b.get("/v1/integrations/crm/runs").expect(403);
      await manager.b.get("/v1/integrations/crm/runs").expect(200);
      expect((await rep.b.get("/v1/integrations/crm").expect(200)).body.connection.provider).toBe(
        "hubspot",
      );
    });

    it("tampered, expired, other-user or other-provider state: nothing stored, matching ?error=", async () => {
      const { b } = await verifiedSignup(app);
      const ws = (await me(b)).workspace.id;
      const path = await consent(b);
      const state = new URL(`http://x${path}`).searchParams.get("state")!;
      const code = new URL(`http://x${path}`).searchParams.get("code")!;
      const call = async (s: string, provider = "hubspot") =>
        (
          await b
            .get(
              `/v1/integrations/crm/${provider}/callback?code=${code}&state=${encodeURIComponent(s)}`,
            )
            .expect(302)
        ).headers.location;

      expect(await call(`${state.slice(0, -2)}xx`)).toBe(`${PAGE}?error=state_invalid`);
      const user = (await me(b)).user.id;
      expect(
        await call(
          createCrmState(
            { workspaceId: ws, userId: user, provider: "hubspot" },
            config.UNSUBSCRIBE_SECRET,
            Date.now() - 11 * 60_000,
          ),
        ),
      ).toBe(`${PAGE}?error=state_expired`);
      expect(
        await call(
          createCrmState(
            {
              workspaceId: ws,
              userId: "00000000-0000-4000-8000-000000000000",
              provider: "hubspot",
            },
            config.UNSUBSCRIBE_SECRET,
          ),
        ),
      ).toBe(`${PAGE}?error=state_mismatch`);
      expect(await call(state, "pipedrive")).toBe(`${PAGE}?error=state_mismatch`);
      // A Google mailbox state (other derivation label) is refused.
      const { createOAuthState } = await import("../src/modules/mailboxes/oauth-state");
      expect(
        await call(createOAuthState({ workspaceId: ws, userId: user }, config.UNSUBSCRIBE_SECRET)),
      ).toBe(`${PAGE}?error=state_invalid`);
      expect(await call("")).toBe(`${PAGE}?error=state_invalid`);
      const denied = (
        await b.get("/v1/integrations/crm/hubspot/callback?error=access_denied").expect(302)
      ).headers.location;
      expect(denied).toBe(`${PAGE}?error=access_denied`);
      const signedOut = (
        await browser(app)
          .get(`/v1/integrations/crm/hubspot/callback?code=x&state=${encodeURIComponent(state)}`)
          .expect(302)
      ).headers.location;
      expect(signedOut).toBe(`${PAGE}?error=signed_out`);
      expect(await asWs(ws, (tx) => tx.select().from(crmConnections))).toEqual([]);
    });

    it("staging-style sandbox mode refuses accounts not on the allowlist", async () => {
      const sandbox = await createTestApp({
        CRM_MODE: "sandbox",
        CRM_SANDBOX_ACCOUNT_IDS: "111",
        CRM_HUBSPOT_CLIENT_ID: "id",
        CRM_HUBSPOT_CLIENT_SECRET: "secret",
      });
      try {
        // The real-host clients are swapped for the fakes; the allowlist check is the app's.
        const fakeConfig = resolveCrmConfig("test", { CRM_FAKE_BASE_URL: fake.url });
        sandbox.get(CrmService).oauthOverride = (p) => createOAuth(fakeConfig, p);
        const { b } = await verifiedSignup(sandbox);
        const { url } = (await b.get("/v1/integrations/crm/hubspot/authorize").expect(200)).body;
        const back = new URL((await fetch(url, { redirect: "manual" })).headers.get("location")!);
        const res = await b.get(`${back.pathname.replace(/^\/api/, "")}${back.search}`).expect(302);
        expect(res.headers.location).toBe(`${PAGE}?error=crm_account_not_allowed`);
        expect(fake.hubspot.oauth.revoked).toHaveLength(1);
      } finally {
        await sandbox.close();
        for (const k of [
          "CRM_MODE",
          "CRM_SANDBOX_ACCOUNT_IDS",
          "CRM_HUBSPOT_CLIENT_ID",
          "CRM_HUBSPOT_CLIENT_SECRET",
        ])
          delete process.env[k];
      }
    });

    it("one CRM per workspace: a second provider → 409 crm_already_connected", async () => {
      const { b } = await verifiedSignup(app);
      await connect(b);
      const res = await b.get("/v1/integrations/crm/pipedrive/authorize").expect(409);
      expect(res.body.code).toBe("crm_already_connected");
    });

    it("CRM sync is Team plan and up (workspace feature flag overrides)", async () => {
      const { b } = await verifiedSignup(app);
      const ws = (await me(b)).workspace.id;
      await asWs(ws, (tx) =>
        tx.update(workspaces).set({ plan: "solo" }).where(eq(workspaces.id, ws)),
      );
      expect((await b.get("/v1/integrations/crm/hubspot/authorize").expect(403)).body.code).toBe(
        "plan_upgrade_required",
      );
      expect((await b.get("/v1/integrations/crm").expect(200)).body).toMatchObject({
        entitled: false,
        connection: null,
      });
      await asWs(ws, (tx) =>
        tx.update(workspaces).set({ crmSyncEnabled: true }).where(eq(workspaces.id, ws)),
      );
      await b.get("/v1/integrations/crm/hubspot/authorize").expect(200);
    });

    it("unverified users can't start a connection; unknown providers are a validation error", async () => {
      const { b } = await signedUp(app);
      expect((await b.get("/v1/integrations/crm/hubspot/authorize").expect(403)).body.code).toBe(
        "email_not_verified",
      );
      const { b: v } = await verifiedSignup(app);
      expect((await v.get("/v1/integrations/crm/salesforce/authorize").expect(400)).body.code).toBe(
        "validation_error",
      );
    });
  });

  describe("setup, preview and import", () => {
    it("validates the pipeline, stage and field mappings", async () => {
      const { b } = await verifiedSignup(app);
      await connect(b);
      expect((await b.post("/v1/integrations/crm/import/preview").expect(409)).body.code).toBe(
        "crm_stage_mapping_incomplete",
      );
      expect(
        (await b.patch("/v1/integrations/crm", { pipelineId: "nope" }).expect(400)).body.code,
      ).toBe("validation_error");
      await b
        .patch("/v1/integrations/crm", {
          pipelineId: "default",
          options: { contactPush: "all", activityNotes: true },
        })
        .expect(200);
      expect(
        (await b.patch("/v1/integrations/crm", { secretSealed: "x" }).expect(400)).body.code,
      ).toBe("validation_error");

      const pipelines = (await b.get("/v1/integrations/crm/remote/pipelines").expect(200)).body;
      expect(pipelines[0].stages.map((s: { kind: string }) => s.kind)).toContain("won");
      const suggestion = (await b.get("/v1/integrations/crm/stage-mappings").expect(200)).body;
      expect(suggestion).toMatchObject({ suggested: true, complete: false });
      const won = suggestion.toCrm.find(
        (m: { remoteStageId: string }) => m.remoteStageId === "closedwon",
      );
      // Openline Won can't map to an open CRM stage.
      const bad = await b
        .put("/v1/integrations/crm/stage-mappings", {
          fromCrm: suggestion.fromCrm,
          toCrm: suggestion.toCrm.map((m: { stageId: string }) =>
            m.stageId === won.stageId ? { ...m, remoteStageId: "qualifiedtobuy" } : m,
          ),
        })
        .expect(400);
      expect(bad.body.code).toBe("validation_error");
      const partial = (
        await b
          .put("/v1/integrations/crm/stage-mappings", {
            fromCrm: suggestion.fromCrm.slice(1),
            toCrm: suggestion.toCrm,
          })
          .expect(200)
      ).body;
      expect(partial.complete).toBe(false);

      const fields = (await b.get("/v1/integrations/crm/remote/fields?object=contact").expect(200))
        .body;
      expect(fields.map((f: { key: string }) => f.key)).toContain("tier");
      await b
        .put("/v1/integrations/crm/field-mappings", {
          mappings: [
            {
              object: "contact",
              localField: "custom.tier",
              remoteField: "nope",
              direction: "both",
            },
          ],
        })
        .expect(400);
      await b
        .put("/v1/integrations/crm/field-mappings", {
          mappings: [
            {
              object: "contact",
              localField: "custom.score",
              remoteField: "hs_calculated_score",
              direction: "both",
            },
          ],
        })
        .expect(400);
      const saved = (
        await b
          .put("/v1/integrations/crm/field-mappings", {
            mappings: [
              {
                object: "contact",
                localField: "custom.tier",
                remoteField: "tier",
                direction: "from_crm",
                sourceOfTruth: "crm",
              },
              { object: "contact", localField: "title", remoteField: null, direction: "off" },
            ],
          })
          .expect(200)
      ).body;
      expect(
        saved.find((m: { localField: string }) => m.localField === "custom.tier"),
      ).toMatchObject({ standard: false, direction: "from_crm" });
      expect(saved.find((m: { localField: string }) => m.localField === "title")).toMatchObject({
        direction: "off",
      });
      expect(saved.find((m: { localField: string }) => m.localField === "firstName")).toMatchObject(
        { direction: "both", standard: true },
      );
    });

    it("preview counts without writing anywhere; import needs the lawful-basis box; badges appear", async () => {
      const { b } = await verifiedSignup(app);
      fake.hubspot.create("contacts", { email: "ana@acme.com", firstname: "Ana" });
      fake.hubspot.create("deals", {
        dealname: "Big",
        amount: "10",
        dealstage: "closedwon",
        pipeline: "default",
      });
      const ws = await connect(b);
      await b.patch("/v1/integrations/crm", { pipelineId: "default" }).expect(200);
      const s = (await b.get("/v1/integrations/crm/stage-mappings").expect(200)).body;
      await b
        .put("/v1/integrations/crm/stage-mappings", { fromCrm: s.fromCrm, toCrm: s.toCrm })
        .expect(200);
      const { runId } = (await b.post("/v1/integrations/crm/import/preview").expect(202)).body;
      const [conn] = await asWs(ws, (tx) => tx.select().from(crmConnections));
      await engine().syncConnection(ws, conn!.id);
      const run = (await b.get(`/v1/integrations/crm/runs/${runId}`).expect(200)).body;
      expect(run).toMatchObject({
        kind: "preview",
        status: "succeeded",
        counts: { contact: { create: 1 }, deal: { create: 1 } },
      });
      expect(fake.writes()).toEqual([]);
      expect((await b.get("/v1/contacts").expect(200)).body.items).toEqual([]);

      expect(
        (await b.post("/v1/integrations/crm/import", { previewId: runId }).expect(400)).body.code,
      ).toBe("validation_error");
      await b
        .post("/v1/integrations/crm/import", { previewId: runId, confirmLawfulBasis: true })
        .expect(202);
      await engine().syncConnection(ws, conn!.id);
      const list = (await b.get("/v1/contacts").expect(200)).body.items;
      expect(list[0]).toMatchObject({
        email: "ana@acme.com",
        consentBasis: "none",
        crm: { provider: "hubspot", state: "linked" },
      });
      expect(list[0].crm.url).toMatch(/\/contacts\/900123\/record\/0-1\//);
      const deal = (await b.get("/v1/deals").expect(200)).body.items[0];
      expect(deal.crm).toMatchObject({ provider: "hubspot", state: "linked" });
      expect((await b.get(`/v1/deals/${deal.id}`).expect(200)).body.crm.state).toBe("linked");
      expect((await b.get("/v1/integrations/crm").expect(200)).body.connection.status).toBe(
        "active",
      );
      const actions = (await asWs(ws, (tx) => tx.select().from(auditLog))).map((a) => a.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          "crm.import_previewed",
          "crm.import_started",
          "crm.import_completed",
          "crm.stage_mapping_changed",
          "crm.options_changed",
        ]),
      );
      // A used preview can't start a second import.
      expect(
        (
          await b
            .post("/v1/integrations/crm/import", { previewId: runId, confirmLawfulBasis: true })
            .expect(409)
        ).body.code,
      ).toBe("crm_preview_required");
    });

    it("an expired preview can't be imported", async () => {
      const { b } = await verifiedSignup(app);
      const ws = await connect(b);
      await b.patch("/v1/integrations/crm", { pipelineId: "default" }).expect(200);
      const s = (await b.get("/v1/integrations/crm/stage-mappings").expect(200)).body;
      await b
        .put("/v1/integrations/crm/stage-mappings", { fromCrm: s.fromCrm, toCrm: s.toCrm })
        .expect(200);
      const { runId } = (await b.post("/v1/integrations/crm/import/preview").expect(202)).body;
      const [conn] = await asWs(ws, (tx) => tx.select().from(crmConnections));
      await engine().syncConnection(ws, conn!.id);
      await asWs(ws, (tx) =>
        tx.execute(sql`UPDATE crm_sync_runs SET expires_at = now() - interval '1 minute'`),
      );
      expect(
        (
          await b
            .post("/v1/integrations/crm/import", { previewId: runId, confirmLawfulBasis: true })
            .expect(409)
        ).body.code,
      ).toBe("crm_preview_expired");
    });
  });

  describe("control and the sync log", () => {
    it("pause / resume / sync now (6 per hour), audited", async () => {
      const { b } = await verifiedSignup(app);
      const { ws } = await connectAndImport(b);
      expect((await b.post("/v1/integrations/crm/pause").expect(200)).body.status).toBe("paused");
      expect((await b.post("/v1/integrations/crm/sync-now").expect(409)).body.code).toBe(
        "crm_not_active",
      );
      expect((await b.post("/v1/integrations/crm/resume").expect(200)).body.status).toBe("active");
      for (let i = 0; i < 6; i += 1) await b.post("/v1/integrations/crm/sync-now").expect(202);
      expect((await b.post("/v1/integrations/crm/sync-now").expect(429)).body.code).toBe(
        "rate_limited",
      );
      const actions = (await asWs(ws, (tx) => tx.select().from(auditLog))).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(["crm.paused", "crm.resumed"]));
    });

    it("lists runs with paging, errors with filters, and lets an admin retry or dismiss", async () => {
      const { b } = await verifiedSignup(app);
      const { ws } = await connectAndImport(b);
      const [conn] = await asWs(ws, (tx) => tx.select().from(crmConnections));
      await engine().syncConnection(ws, conn!.id);
      const page1 = (await b.get("/v1/integrations/crm/runs?limit=2").expect(200)).body;
      expect(page1.items).toHaveLength(2);
      const page2 = (
        await b.get(`/v1/integrations/crm/runs?limit=2&cursor=${page1.nextCursor}`).expect(200)
      ).body;
      expect(page2.items.length).toBeGreaterThan(0);
      expect(page2.items[0].id).not.toBe(page1.items[1].id);
      await b.get("/v1/integrations/crm/runs?cursor=bogus").expect(400);

      const [err] = await asWs(ws, (tx) =>
        tx
          .insert(crmSyncErrors)
          .values({
            workspaceId: ws,
            connectionId: conn!.id,
            object: "deal",
            externalId: "42",
            direction: "to_crm",
            code: "currency_mismatch",
            message: "We couldn't sync the amount.",
          })
          .returning(),
      );
      const listed = (
        await b.get("/v1/integrations/crm/errors?object=deal&code=currency_mismatch").expect(200)
      ).body.items;
      expect(listed).toEqual([
        expect.objectContaining({
          id: err!.id,
          externalUrl: expect.stringContaining("/record/0-3/42"),
        }),
      ]);
      expect(
        (await b.post(`/v1/integrations/crm/errors/${err!.id}/retry`).expect(200)).body.nextRetryAt,
      ).not.toBeNull();
      expect(
        (await b.post(`/v1/integrations/crm/errors/${err!.id}/dismiss`).expect(200)).body
          .resolution,
      ).toBe("dismissed");
      expect(
        (await b.post(`/v1/integrations/crm/errors/${err!.id}/dismiss`).expect(409)).body.code,
      ).toBe("crm_error_resolved");
      expect((await b.get("/v1/integrations/crm/errors").expect(200)).body.items).toEqual([]);
      expect(
        (await b.get("/v1/integrations/crm/errors?open=false").expect(200)).body.items,
      ).toHaveLength(1);
    });

    it("disconnect revokes, erases the secret, keeps links (or forgets them); nothing deleted", async () => {
      const { b } = await verifiedSignup(app);
      fake.hubspot.create("contacts", { email: "keep@acme.com" });
      const { ws } = await connectAndImport(b);
      await b.delete("/v1/integrations/crm").expect(200);
      expect(fake.hubspot.oauth.revoked).toHaveLength(1);
      const [conn] = await asWs(ws, (tx) => tx.select().from(crmConnections));
      expect(conn).toMatchObject({ status: "disconnected", secretSealed: "", nextSyncAt: null });
      expect(await asWs(ws, (tx) => tx.select().from(crmLinks))).toHaveLength(1);
      expect(await asWs(ws, (tx) => tx.select().from(contacts))).toHaveLength(1);
      expect(fake.hubspot.records.contacts.size).toBe(1);
      expect((await b.get("/v1/integrations/crm").expect(200)).body.connection).toBeNull();
      expect((await b.get("/v1/contacts").expect(200)).body.items[0].crm).toBeUndefined();

      // Reconnecting the same account resumes without duplicates.
      await connect(b);
      expect((await b.get("/v1/integrations/crm").expect(200)).body.connection.status).toBe(
        "active",
      );
      expect(await asWs(ws, (tx) => tx.select().from(crmLinks))).toHaveLength(1);

      // A failed revoke never blocks the local disconnect; forgetLinks clears the id map.
      const service = app.get(CrmService);
      const fakeConfig = resolveCrmConfig("test", { CRM_FAKE_BASE_URL: fake.url });
      service.oauthOverride = (p) => {
        const real = createOAuth(fakeConfig, p)!;
        return Object.assign(
          Object.create(Object.getPrototypeOf(real) as object) as typeof real,
          real,
          {
            revoke: async () => {
              throw new Error("network down");
            },
          },
        );
      };
      try {
        await b.delete("/v1/integrations/crm?forgetLinks=true").expect(200);
      } finally {
        service.oauthOverride = undefined;
      }
      expect(await asWs(ws, (tx) => tx.select().from(crmLinks))).toEqual([]);
      const audit = await asWs(ws, (tx) =>
        tx.select().from(auditLog).where(eq(auditLog.action, "crm.disconnected")),
      );
      expect(audit.map((a) => a.metadata)).toEqual([
        expect.objectContaining({ forgetLinks: false, revoked: true }),
        expect.objectContaining({ forgetLinks: true, revoked: false }),
      ]);
    });

    it("Pipedrive's uninstall callback needs our client credentials and disconnects", async () => {
      const { b } = await verifiedSignup(app);
      const ws = await connect(b, "pipedrive");
      await browser(app)
        .agent.delete("/v1/integrations/crm/pipedrive/uninstall")
        .set("authorization", "Basic d3Jvbmc6d3Jvbmc=")
        .send({ company_id: 7001 })
        .expect(401);
      const basic = `Basic ${Buffer.from("fake-pipedrive-client:fake-secret").toString("base64")}`;
      await browser(app)
        .agent.delete("/v1/integrations/crm/pipedrive/uninstall")
        .set("authorization", basic)
        .send({ company_id: 7001, user_id: 11 })
        .expect(200);
      const [conn] = await asWs(ws, (tx) => tx.select().from(crmConnections));
      expect(conn).toMatchObject({ status: "disconnected", secretSealed: "" });
      expect(
        (
          await asWs(ws, (tx) =>
            tx.select().from(auditLog).where(eq(auditLog.action, "crm.disconnected")),
          )
        )[0]!.metadata,
      ).toMatchObject({ source: "uninstalled_in_pipedrive" });
    });

    it("crm_unsubscribed suppressions are locked like other opt-outs", async () => {
      const { b } = await verifiedSignup(app);
      const ws = (await me(b)).workspace.id;
      const [s] = await asWs(ws, (tx) =>
        tx
          .insert(suppressions)
          .values({ workspaceId: ws, value: "x@acme.com", reason: "crm_unsubscribed" })
          .returning(),
      );
      expect((await b.delete(`/v1/suppressions/${s!.id}`).expect(409)).body.code).toBe(
        "suppression_locked",
      );
    });
  });

  describe("Sprint 7 review regressions", () => {
    const connOf = async (ws: string) =>
      (await asWs(ws, (tx) => tx.select().from(crmConnections)))[0]!;

    it("Q3 after a downgrade to Solo the connection still shows and can be paused or disconnected; setup and import need the plan", async () => {
      const { b } = await verifiedSignup(app);
      const { ws } = await connectAndImport(b);
      await asWs(ws, (tx) =>
        tx.update(workspaces).set({ plan: "solo" }).where(eq(workspaces.id, ws)),
      );
      expect((await b.get("/v1/integrations/crm").expect(200)).body).toMatchObject({
        entitled: false,
        connection: { status: "active", provider: "hubspot" },
      });
      for (const res of [
        await b.put("/v1/integrations/crm/field-mappings", { mappings: [] }).expect(403),
        await b.post("/v1/integrations/crm/import/preview").expect(403),
        await b.get("/v1/integrations/crm/hubspot/authorize").expect(403),
      ])
        expect(res.body.code).toBe("plan_upgrade_required");
      expect((await b.post("/v1/integrations/crm/pause").expect(200)).body.status).toBe("paused");
      await b.get("/v1/integrations/crm/runs").expect(200);
      await b.delete("/v1/integrations/crm").expect(200);
      expect((await connOf(ws)).status).toBe("disconnected");
    });

    it("Q4 stage mapping drift: a warning, paused deal badges, and a complete mapping fixes the error rows", async () => {
      const { b } = await verifiedSignup(app);
      fake.hubspot.create("deals", {
        dealname: "Drifting",
        pipeline: "default",
        dealstage: "qualifiedtobuy",
      });
      const { ws } = await connectAndImport(b);
      const conn = await connOf(ws);
      await asWs(ws, async (tx) => {
        await tx.update(crmConnections).set({ stageMappingComplete: false });
        await tx.insert(crmSyncErrors).values({
          workspaceId: ws,
          connectionId: conn.id,
          object: "deal",
          externalId: "9",
          direction: "from_crm",
          code: "stage_unmapped",
          message: "A deal is in a stage that isn't mapped.",
        });
      });
      const status = (await b.get("/v1/integrations/crm").expect(200)).body.connection;
      expect(status.warnings).toContain("Stage mapping needs attention");
      const [deal] = (await b.get("/v1/deals").expect(200)).body.items;
      expect(deal.crm).toMatchObject({ state: "paused", reason: "stage_mapping" });
      const saved = (await b.get("/v1/integrations/crm/stage-mappings").expect(200)).body;
      await b
        .put("/v1/integrations/crm/stage-mappings", { fromCrm: saved.fromCrm, toCrm: saved.toCrm })
        .expect(200);
      expect((await b.get("/v1/integrations/crm/errors").expect(200)).body.items).toEqual([]);
      expect((await b.get("/v1/deals").expect(200)).body.items[0].crm.state).toBe("linked");
    });

    it("Q5 mappings can't use the email or opt-out fields, nor one CRM field twice (400)", async () => {
      const { b } = await verifiedSignup(app);
      await connectAndImport(b);
      const put = (mappings: unknown[]) =>
        b.put("/v1/integrations/crm/field-mappings", { mappings });
      const row = (localField: string, remoteField: string) => ({
        object: "contact",
        localField,
        remoteField,
        direction: "from_crm",
        sourceOfTruth: "newest",
      });
      for (const mapping of [
        row("custom.x", "email"),
        row("custom.x", "hs_email_optout"),
        row("title", "email"),
      ]) {
        const res = await put([mapping]).expect(400);
        expect(res.body.details[0].path).toBe("mappings.0.remoteField");
      }
      const dup = await put([row("custom.a", "tier"), row("custom.b", "tier")]).expect(400);
      expect(dup.body.details[0]).toMatchObject({ path: "mappings.1.remoteField" });
      const offered = (
        await b.get("/v1/integrations/crm/remote/fields?object=contact").expect(200)
      ).body.map((f: { key: string }) => f.key);
      expect(offered).not.toContain("email");
      expect(offered).not.toContain("hs_email_optout");
      await put([row("custom.a", "tier")]).expect(200);
    });

    it("Q8 company domains are stored normalized (lower case, www. stripped)", async () => {
      const { b } = await verifiedSignup(app);
      await b
        .post("/v1/contacts", { email: "bob@beta.io", companyDomain: "www.Beta.io" })
        .expect(201);
      await b.post("/v1/contacts", { email: "ann@www.zeta.io" }).expect(201);
      await b.post("/v1/contacts", { email: "cy@beta.io" }).expect(201);
      const domains = (await b.get("/v1/companies").expect(200)).body.items
        .map((c: { domain: string }) => c.domain)
        .sort();
      expect(domains).toEqual(["beta.io", "zeta.io"]);
    });

    it("Q11 Pipedrive setup calls made through the API count against the daily budget", async () => {
      const { b } = await verifiedSignup(app);
      const ws = await connect(b, "pipedrive");
      const before = fake.pipedrive.tokensSpent;
      await b.get("/v1/integrations/crm/remote/pipelines").expect(200);
      await b.get("/v1/integrations/crm/remote/fields?object=contact").expect(200);
      const conn = await connOf(ws);
      expect(conn.budgetSpent).toBeGreaterThan(0);
      expect(conn.budgetSpent).toBe(fake.pipedrive.tokensSpent - before);
    });

    it("Q12 a partial preview (cut short) can still be imported", async () => {
      const { b } = await verifiedSignup(app);
      const ws = await connect(b);
      await b.patch("/v1/integrations/crm", { pipelineId: "default" }).expect(200);
      const s = (await b.get("/v1/integrations/crm/stage-mappings").expect(200)).body;
      await b
        .put("/v1/integrations/crm/stage-mappings", { fromCrm: s.fromCrm, toCrm: s.toCrm })
        .expect(200);
      const { runId } = (await b.post("/v1/integrations/crm/import/preview").expect(202)).body;
      await engine().syncConnection(ws, (await connOf(ws)).id);
      await asWs(ws, (tx) =>
        tx
          .update(crmSyncRuns)
          .set({ status: "partial", errorCode: "time_budget" })
          .where(eq(crmSyncRuns.id, runId)),
      );
      expect((await b.get(`/v1/integrations/crm/runs/${runId}`).expect(200)).body.status).toBe(
        "partial",
      );
      await b
        .post("/v1/integrations/crm/import", { previewId: runId, confirmLawfulBasis: true })
        .expect(202);
    });

    it("S2 a Pipedrive uninstall also drops the sync lease", async () => {
      const { b } = await verifiedSignup(app);
      const ws = await connect(b, "pipedrive");
      await asWs(ws, (tx) =>
        tx.update(crmConnections).set({ syncLockedUntil: new Date(Date.now() + 600_000) }),
      );
      const basic = `Basic ${Buffer.from("fake-pipedrive-client:fake-secret").toString("base64")}`;
      await browser(app)
        .agent.delete("/v1/integrations/crm/pipedrive/uninstall")
        .set("authorization", basic)
        .send({ company_id: 7001 })
        .expect(200);
      expect(await connOf(ws)).toMatchObject({ status: "disconnected", syncLockedUntil: null });
    });

    it("S4 'forget links' keeps tombstones: an erased person is never re-imported", async () => {
      const { b } = await verifiedSignup(app);
      fake.hubspot.create("contacts", { email: "erase@acme.com" });
      fake.hubspot.create("contacts", { email: "keep@acme.com" });
      const { ws } = await connectAndImport(b);
      const erase = (await b.get("/v1/contacts").expect(200)).body.items.find(
        (c: { email: string }) => c.email === "erase@acme.com",
      );
      await b.delete(`/v1/contacts/${erase.id}`).expect(200);
      await b.delete("/v1/integrations/crm?forgetLinks=true").expect(200);
      expect((await asWs(ws, (tx) => tx.select().from(crmLinks))).map((l) => l.state)).toEqual([
        "tombstone",
      ]);
      await connectAndImport(b);
      expect(
        (await b.get("/v1/contacts").expect(200)).body.items.map((c: { email: string }) => c.email),
      ).toEqual(["keep@acme.com"]);
    });

    it("S6 sync-now, retry and failed or refused connects are audited", async () => {
      const { b } = await verifiedSignup(app);
      const { ws } = await connectAndImport(b);
      const conn = await connOf(ws);
      await b.post("/v1/integrations/crm/sync-now").expect(202);
      const [err] = await asWs(ws, (tx) =>
        tx
          .insert(crmSyncErrors)
          .values({
            workspaceId: ws,
            connectionId: conn.id,
            object: "deal",
            externalId: "42",
            direction: "to_crm",
            code: "remote_rejected",
            message: "Rejected.",
          })
          .returning(),
      );
      await b.post(`/v1/integrations/crm/errors/${err!.id}/retry`).expect(200);
      await b.get("/v1/integrations/crm/hubspot/callback?code=x&state=bogus").expect(302);
      await b.get("/v1/integrations/crm/pipedrive/authorize").expect(409);
      const audit = await asWs(ws, (tx) => tx.select().from(auditLog));
      const actions = audit.map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(["crm.sync_requested", "crm.error_retried"]));
      expect(audit.filter((a) => a.action === "crm.connect_failed").map((a) => a.metadata)).toEqual(
        expect.arrayContaining([
          { provider: "hubspot", reason: "state_invalid" },
          { provider: "pipedrive", reason: "crm_already_connected" },
        ]),
      );
      expect(JSON.stringify(audit.map((a) => a.metadata))).not.toContain("bogus");
    });
  });

  it("workspace B can't see workspace A's connection, runs, errors or links (404 / empty)", async () => {
    const { b: a } = await verifiedSignup(app);
    fake.hubspot.create("contacts", { email: "secret@acme.com" });
    const { ws, previewId } = await connectAndImport(a);
    const [conn] = await asWs(ws, (tx) => tx.select().from(crmConnections));
    const [err] = await asWs(ws, (tx) =>
      tx
        .insert(crmSyncErrors)
        .values({
          workspaceId: ws,
          connectionId: conn!.id,
          object: "contact",
          externalId: "1",
          direction: "from_crm",
          code: "validation",
          message: "x",
        })
        .returning(),
    );
    const { b: other } = await verifiedSignup(app);
    await other.get(`/v1/integrations/crm/runs/${previewId}`).expect(404);
    await other.post(`/v1/integrations/crm/errors/${err!.id}/dismiss`).expect(404);
    await other.post(`/v1/integrations/crm/errors/${err!.id}/retry`).expect(404);
    expect((await other.get("/v1/integrations/crm").expect(200)).body.connection).toBeNull();
    expect((await other.get("/v1/integrations/crm/runs").expect(200)).body.items).toEqual([]);
    expect((await other.get("/v1/integrations/crm/errors").expect(200)).body.items).toEqual([]);
    expect((await other.post("/v1/integrations/crm/pause").expect(404)).body.code).toBe(
      "crm_not_connected",
    );
    await other.delete("/v1/integrations/crm").expect(404);
    expect((await other.get("/v1/contacts").expect(200)).body.items).toEqual([]);
  });
});
