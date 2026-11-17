/**
 * The sync engine end to end against PGlite (real migrations, RLS) and the fake CRMs: preview,
 * import, two-way incremental sync, conflicts, echo suppression, opt-outs, deletes, merges,
 * erasure, reservations, limits, pause / resume.
 */
import { randomUUID } from "node:crypto";
import {
  and,
  auditLog,
  companies,
  contacts,
  createDatabase,
  crmConnections,
  crmFieldMappings,
  crmLinks,
  crmStageMappings,
  crmSyncErrors,
  crmSyncRuns,
  deals,
  eq,
  migrate,
  pipelineStages,
  seedDefaultStages,
  sql,
  suppressions,
  users,
  withIdentity,
  withTenant,
  workspaceMembers,
  workspaces,
  type DatabaseHandle,
  type Tx,
} from "@openline/db";
import { openJson, sealJson } from "@openline/email";
import type { CrmProvider } from "@openline/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCrmConfig, type CrmConfig } from "./config";
import { createCrmSync, type CrmSync } from "./engine";
import { FakeCrmServer } from "./fake";
import { defaultMappings } from "./mapping";
import { createOAuth } from "./providers";
import { LOST, WON, type CrmSecret } from "./types";

const KEY = Buffer.alloc(32, 7);
const noSleep = { sleep: async () => undefined };

describe("CRM sync engine", () => {
  const fake = new FakeCrmServer();
  let handle: DatabaseHandle;
  let config: CrmConfig;
  let engine: CrmSync;
  const notify = vi.fn(async () => undefined);

  beforeAll(async () => {
    const url = await fake.start();
    config = resolveCrmConfig("test", { CRM_FAKE_BASE_URL: url });
    handle = createDatabase(process.env.TEST_DATABASE_URL ?? "pglite://memory");
    await migrate(handle);
    engine = createCrmSync({
      db: handle.db,
      secretsKey: KEY,
      config,
      oauthFor: (p) => createOAuth(config, p, noSleep),
      notifyReconnect: notify,
      logger: { warn: () => undefined, error: () => undefined },
    });
  });
  afterAll(async () => {
    await fake.stop();
    await handle.close();
  });
  beforeEach(() => {
    fake.reset();
    notify.mockClear();
  });

  interface Setup {
    ws: string;
    user: string;
    conn: string;
    stages: { id: string; name: string; kind: string }[];
    as: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  }

  /** What the API does on connect + setup, condensed: a connection with mappings, ready to preview. */
  async function setup(
    provider: CrmProvider,
    opts: { optionalScopes?: boolean; options?: Record<string, unknown> } = {},
  ): Promise<Setup> {
    const ws = randomUUID();
    const email = `owner-${ws.slice(0, 6)}@acme.test`;
    const user = await withIdentity(handle.db, async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({ email, name: "Ana", passwordHash: "x" })
        .returning();
      return u!.id;
    });
    const as = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(handle.db, { workspaceId: ws }, fn);
    await as(async (tx) => {
      await tx.insert(workspaces).values({ id: ws, name: "Acme", trialEndsAt: new Date() });
      await tx.insert(workspaceMembers).values({ workspaceId: ws, userId: user, role: "owner" });
      await seedDefaultStages(tx, ws);
    });
    // The CRM's owner shares this email, so owners match.
    fake.hubspot.owners = [{ id: "501", email }];
    fake.pipedrive.users = [{ id: 11, email, name: "Ana", active_flag: true }];
    fake.knobs.grantOptionalScopes = opts.optionalScopes ?? true;

    const oauth = createOAuth(config, provider, noSleep)!;
    const redirectUri = `http://localhost:3000/api/v1/integrations/crm/${provider}/callback`;
    const res = await fetch(oauth.authorizeUrl({ state: "s", redirectUri }), {
      redirect: "manual",
    });
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
    const { tokens, account } = await oauth.exchangeCode({ code, redirectUri });

    const stages = await as((tx) =>
      tx
        .select({ id: pipelineStages.id, name: pipelineStages.name, kind: pipelineStages.kind })
        .from(pipelineStages)
        .orderBy(pipelineStages.position),
    );
    const open = stages.filter((s) => s.kind === "open");
    const won = stages.find((s) => s.kind === "won")!;
    const lost = stages.find((s) => s.kind === "lost")!;
    const remote =
      provider === "hubspot"
        ? {
            open: [
              "appointmentscheduled",
              "qualifiedtobuy",
              "presentationscheduled",
              "contractsent",
            ],
            won: "closedwon",
            lost: "closedlost",
            pipeline: "default",
          }
        : { open: ["1", "2", "3", "4"], won: WON, lost: LOST, pipeline: "1" };

    const conn = await as(async (tx) => {
      const [c] = await tx
        .insert(crmConnections)
        .values({
          workspaceId: ws,
          provider,
          status: "needs_setup",
          accountId: account.accountId,
          accountName: account.accountName,
          apiDomain: account.apiDomain ?? null,
          scopes: tokens.scopes,
          secretSealed: sealJson(
            {
              kind: "oauth",
              refreshToken: tokens.refreshToken,
              accessToken: tokens.accessToken,
              accessExpiresAt: tokens.accessExpiresAt,
            },
            KEY,
            ws,
          ),
          pipelineId: remote.pipeline,
          defaultOwnerId: user,
          connectedBy: user,
          options: opts.options ?? {},
          accountMeta: {
            currencies: account.currencies ?? undefined,
            defaultCurrency: account.defaultCurrency ?? undefined,
            portalId: account.portalId,
          },
          stageMappingComplete: true,
        })
        .returning();
      await tx
        .insert(crmFieldMappings)
        .values(
          defaultMappings(provider).map((m) => ({ ...m, workspaceId: ws, connectionId: c!.id })),
        );
      const from = [
        ...remote.open.map((r, i) => ({ r, s: open[Math.min(i, open.length - 1)]!.id })),
        { r: remote.won, s: won.id },
        { r: remote.lost, s: lost.id },
      ];
      const to = [
        ...open.map((s, i) => ({ s: s.id, r: remote.open[Math.min(i, remote.open.length - 1)]! })),
        { s: won.id, r: remote.won },
        { s: lost.id, r: remote.lost },
      ];
      await tx.insert(crmStageMappings).values([
        ...from.map((m) => ({
          workspaceId: ws,
          connectionId: c!.id,
          direction: "from_crm" as const,
          remoteStageId: m.r,
          stageId: m.s,
        })),
        ...to.map((m) => ({
          workspaceId: ws,
          connectionId: c!.id,
          direction: "to_crm" as const,
          remoteStageId: m.r,
          stageId: m.s,
        })),
      ]);
      return c!.id;
    });
    return { ws, user, conn, stages, as };
  }

  async function preview(s: Setup) {
    await s.as(async (tx) => {
      await tx
        .update(crmConnections)
        .set({ status: "previewing" })
        .where(eq(crmConnections.id, s.conn));
      await tx
        .insert(crmSyncRuns)
        .values({ workspaceId: s.ws, connectionId: s.conn, kind: "preview" });
    });
    expect(await engine.syncConnection(s.ws, s.conn)).toBe("previewed");
    const [run] = await s.as((tx) =>
      tx.select().from(crmSyncRuns).where(eq(crmSyncRuns.kind, "preview")),
    );
    return run!;
  }

  async function importAll(s: Setup, pushLocalOnly = false) {
    await s.as(async (tx) => {
      await tx
        .update(crmConnections)
        .set({ status: "importing" })
        .where(eq(crmConnections.id, s.conn));
      await tx.insert(crmSyncRuns).values({
        workspaceId: s.ws,
        connectionId: s.conn,
        kind: "import",
        options: { pushLocalOnly },
      });
    });
    expect(await engine.syncConnection(s.ws, s.conn)).toBe("imported");
  }

  const sync = async (s: Setup) => expect(await engine.syncConnection(s.ws, s.conn)).toBe("synced");
  const contactBy = async (s: Setup, email: string) =>
    (await s.as((tx) => tx.select().from(contacts).where(eq(contacts.email, email))))[0];
  const linkOf = async (s: Setup, where: ReturnType<typeof eq>) =>
    (await s.as((tx) => tx.select().from(crmLinks).where(where)))[0];
  const lastRun = async (s: Setup) =>
    (
      await s.as((tx) =>
        tx
          .select()
          .from(crmSyncRuns)
          .orderBy(sql`${crmSyncRuns.startedAt} DESC`)
          .limit(1),
      )
    )[0]!;
  const openErrors = (s: Setup) =>
    s.as((tx) =>
      tx
        .select()
        .from(crmSyncErrors)
        .where(sql`resolved_at IS NULL`),
    );
  /** Waits past the CRM's clock tick so a later edit has a later modified time. */
  const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

  /** A small HubSpot account plus a few Openline records. */
  async function seedHubSpot(s: Setup) {
    const acme = fake.hubspot.create("companies", { name: "Acme Inc", domain: "acme.com" });
    const globex = fake.hubspot.create("companies", { name: "Globex", domain: "www.globex.io" });
    const ana = fake.hubspot.create(
      "contacts",
      { email: "ana@acme.com", firstname: "Ana", lastname: "Lima", jobtitle: "CTO" },
      { companies: [acme] },
    );
    const ben = fake.hubspot.create(
      "contacts",
      { email: "BEN@globex.io", firstname: "Ben" },
      { companies: [globex] },
    );
    const noEmail = fake.hubspot.create("contacts", { firstname: "Nobody" });
    const supp = fake.hubspot.create("contacts", { email: "gone@acme.com", firstname: "Gone" });
    const deal = fake.hubspot.create(
      "deals",
      {
        dealname: "Acme rollout",
        amount: "1200.50",
        deal_currency_code: "USD",
        dealstage: "qualifiedtobuy",
        pipeline: "default",
        closedate: "2026-12-31T00:00:00Z",
      },
      { companies: [acme], contacts: [ana] },
    );
    const otherPipe = fake.hubspot.create("deals", {
      dealname: "Renewal",
      dealstage: "r1",
      pipeline: "renewals",
    });
    await s.as(async (tx) => {
      // Ana already exists in Openline, and someone is suppressed.
      await tx
        .insert(contacts)
        .values({ workspaceId: s.ws, email: "ana@acme.com", firstName: "Ana", status: "active" });
      await tx
        .insert(contacts)
        .values({ workspaceId: s.ws, email: "local-only@acme.com", firstName: "Lou" });
      await tx.insert(suppressions).values([
        { workspaceId: s.ws, value: "gone@acme.com", reason: "unsubscribed" },
        { workspaceId: s.ws, value: "ana@acme.com", reason: "manual" },
      ]);
    });
    return { acme, globex, ana, ben, noEmail, supp, deal, otherPipe };
  }

  it("preview counts every bucket and changes nothing on either side", async () => {
    const s = await setup("hubspot");
    const ids = await seedHubSpot(s);
    const before = await s.as((tx) => tx.select().from(contacts));
    const run = await preview(s);
    expect(run.counts.contact).toMatchObject({
      link: 1,
      create: 1,
      skipped_no_email: 1,
      skipped_suppressed_new: 1,
      only_in_openline: 1,
    });
    expect(run.counts.company).toMatchObject({ create: 2 });
    expect(run.counts.deal).toMatchObject({ create: 1, skipped_other_pipeline: 1 });
    expect(run.examples.contact!.skipped_no_email).toEqual([ids.noEmail]);
    expect(JSON.stringify(run.examples)).not.toContain("Ana");
    expect(run.expiresAt!.getTime() - Date.now()).toBeGreaterThan(55 * 60_000);
    expect(fake.writes()).toEqual([]);
    expect(await s.as((tx) => tx.select().from(contacts))).toEqual(before);
    expect(await s.as((tx) => tx.select().from(crmLinks))).toEqual([]);
  });

  it("import links by email (no duplicate, suppression kept), creates the rest, maps stages", async () => {
    const s = await setup("hubspot");
    const ids = await seedHubSpot(s);
    await importAll(s);
    const all = await s.as((tx) => tx.select().from(contacts));
    expect(all.map((c) => c.email).sort()).toEqual([
      "ana@acme.com",
      "ben@globex.io",
      "local-only@acme.com",
    ]);
    const ana = all.find((c) => c.email === "ana@acme.com")!;
    expect(ana).toMatchObject({ lastName: "Lima", title: "CTO" });
    expect(
      (
        await s.as((tx) =>
          tx.select().from(suppressions).where(eq(suppressions.value, "ana@acme.com")),
        )
      )[0]!.reason,
    ).toBe("manual");
    const ben = all.find((c) => c.email === "ben@globex.io")!;
    expect(ben.consentBasis).toBe("none");
    const comps = await s.as((tx) => tx.select().from(companies));
    expect(comps.map((c) => c.domain).sort()).toEqual(["acme.com", "globex.io"]);
    expect(ben.companyId).toBe(comps.find((c) => c.domain === "globex.io")!.id);
    const [deal] = await s.as((tx) => tx.select().from(deals));
    expect(deal).toMatchObject({
      name: "Acme rollout",
      amountMinor: 120050,
      currency: "USD",
      expectedCloseDate: "2026-12-31",
      primaryContactId: ana.id,
    });
    expect(s.stages.find((st) => st.id === deal!.stageId)!.name).toBe("Qualified");
    expect((await linkOf(s, eq(crmLinks.externalId, ids.ana)))!.contactId).toBe(ana.id);
    // Nothing was pushed (Openline-only push not chosen) and the import was audited.
    expect(fake.writes().map((w) => [w.method, w.path, JSON.stringify(w.body)])).toEqual([]);
    const [conn] = await s.as((tx) => tx.select().from(crmConnections));
    expect(conn!.status).toBe("active");
    expect(
      (
        await s.as((tx) =>
          tx.select().from(auditLog).where(eq(auditLog.action, "crm.import_completed")),
        )
      ).length,
    ).toBe(1);
  });

  it("a field changed only in the CRM is pulled, and the poll after writes nothing anywhere", async () => {
    const s = await setup("hubspot");
    const ids = await seedHubSpot(s);
    await importAll(s);
    await tick();
    fake.hubspot.edit("contacts", ids.ben, { jobtitle: "<b>VP</b> Sales" });
    await sync(s);
    const ben = await contactBy(s, "ben@globex.io");
    expect(ben!.title).toBe("VP Sales");
    const writes = fake.writes().length;
    await sync(s);
    await sync(s);
    expect(fake.writes().length).toBe(writes);
    expect((await contactBy(s, "ben@globex.io"))!.updatedAt).toEqual(ben!.updatedAt);
    expect((await lastRun(s)).counts.contact?.pulled ?? 0).toBe(0);
  });

  it("a field changed only in Openline is pushed once (echo suppressed)", async () => {
    const s = await setup("hubspot");
    const ids = await seedHubSpot(s);
    await importAll(s);
    await s.as((tx) =>
      tx
        .update(contacts)
        .set({ firstName: "Benjamin", updatedAt: new Date() })
        .where(eq(contacts.email, "ben@globex.io")),
    );
    await sync(s);
    expect(fake.hubspot.records.contacts.get(ids.ben)!.properties.firstname).toBe("Benjamin");
    const writes = fake.writes().length;
    await sync(s);
    await sync(s);
    expect(fake.writes().length).toBe(writes);
  });

  it("both sides changed: the later edit wins per field, pins override, and the log records it", async () => {
    const s = await setup("hubspot");
    const ids = await seedHubSpot(s);
    await importAll(s);
    // Openline edits first, then the CRM: the CRM is newer.
    await s.as((tx) =>
      tx
        .update(contacts)
        .set({ firstName: "Local", lastName: "LocalLast", updatedAt: new Date(Date.now() - 5000) })
        .where(eq(contacts.email, "ben@globex.io")),
    );
    await tick();
    fake.hubspot.edit("contacts", ids.ben, { firstname: "Remote", phone: "+1 555" });
    // lastName is pinned to Openline.
    await s.as((tx) =>
      tx
        .update(crmFieldMappings)
        .set({ sourceOfTruth: "openline" })
        .where(
          and(eq(crmFieldMappings.object, "contact"), eq(crmFieldMappings.localField, "lastName")),
        ),
    );
    fake.hubspot.edit("contacts", ids.ben, { lastname: "RemoteLast" });
    await sync(s);
    const ben = await contactBy(s, "ben@globex.io");
    expect(ben).toMatchObject({ firstName: "Remote", phone: "+1 555", lastName: "LocalLast" });
    expect(fake.hubspot.records.contacts.get(ids.ben)!.properties.lastname).toBe("LocalLast");
    const run = await lastRun(s);
    expect(run.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          object: "contact",
          field: "firstName",
          winner: "crm",
          rule: "newest",
        }),
        expect.objectContaining({
          object: "contact",
          field: "lastName",
          winner: "openline",
          rule: "openline",
        }),
      ]),
    );
    expect(JSON.stringify(run.conflicts)).not.toContain("Remote");
  });

  it("an EUR deal on a USD-only HubSpot keeps its amount local (currency_mismatch), other fields sync", async () => {
    const s = await setup("hubspot");
    const ids = await seedHubSpot(s);
    await importAll(s);
    await s.as((tx) =>
      tx.update(deals).set({
        amountMinor: 50000,
        currency: "EUR",
        name: "Acme rollout EU",
        updatedAt: new Date(),
      }),
    );
    await sync(s);
    const remote = fake.hubspot.records.deals.get(ids.deal)!.properties;
    expect(remote).toMatchObject({ dealname: "Acme rollout EU", amount: "1200.50" });
    const errors = await openErrors(s);
    expect(errors.map((e) => e.code)).toEqual(["currency_mismatch"]);
    expect(errors[0]!.message).not.toContain("500");
  });

  it("opt-outs travel both ways; re-subscribes never do", async () => {
    const s = await setup("hubspot");
    const ids = await seedHubSpot(s);
    await importAll(s);
    // Openline unsubscribe → HubSpot unsubscribe-all.
    await s.as((tx) =>
      tx
        .insert(suppressions)
        .values({ workspaceId: s.ws, value: "ben@globex.io", reason: "unsubscribed" }),
    );
    await sync(s);
    expect(fake.hubspot.unsubscribed).toEqual(["ben@globex.io"]);
    await sync(s);
    expect(fake.hubspot.unsubscribed).toHaveLength(1);
    // CRM opt-out → locked crm_unsubscribed suppression.
    await tick();
    fake.hubspot.edit("contacts", ids.ana, { hs_email_optout: "true" });
    await sync(s);
    // Ana had a manual suppression: the CRM opt-out upgrades it to the locked reason (S1).
    const supp = await s.as((tx) => tx.select().from(suppressions));
    expect(supp.find((x) => x.value === "ana@acme.com")!.reason).toBe("crm_unsubscribed");
    // A brand-new CRM opt-out on an unsuppressed contact.
    const cara = fake.hubspot.create("contacts", { email: "cara@acme.com", firstname: "Cara" });
    await sync(s);
    await tick();
    fake.hubspot.edit("contacts", cara, { hs_email_optout: "true" });
    await sync(s);
    const caraSupp = (
      await s.as((tx) =>
        tx.select().from(suppressions).where(eq(suppressions.value, "cara@acme.com")),
      )
    )[0];
    expect(caraSupp!.reason).toBe("crm_unsubscribed");
    expect((await contactBy(s, "cara@acme.com"))!.status).toBe("unsubscribed");
    expect(
      (
        await s.as((tx) =>
          tx.select().from(auditLog).where(eq(auditLog.action, "contact.suppressed")),
        )
      )[0]!.metadata,
    ).toMatchObject({ source: "crm" });
    // Re-subscribed in the CRM: Openline changes nothing.
    await tick();
    fake.hubspot.records.contacts.get(cara)!.properties.hs_email_optout = "false";
    fake.hubspot.edit("contacts", cara, { firstname: "Cara2" });
    await sync(s);
    expect((await contactBy(s, "cara@acme.com"))!.status).toBe("unsubscribed");
    expect(
      await s.as((tx) =>
        tx.select().from(suppressions).where(eq(suppressions.value, "cara@acme.com")),
      ),
    ).toHaveLength(1);
  });

  it("without the optional scope, opt-outs aren't sent and a standing warning shows", async () => {
    const s = await setup("hubspot", { optionalScopes: false });
    await seedHubSpot(s);
    await importAll(s);
    await s.as((tx) =>
      tx
        .insert(suppressions)
        .values({ workspaceId: s.ws, value: "ben@globex.io", reason: "asked_not_to_contact" }),
    );
    await sync(s);
    expect(fake.hubspot.unsubscribed).toEqual([]);
    const [conn] = await s.as((tx) => tx.select().from(crmConnections));
    expect(conn!.warnings).toEqual(["Opt-outs are not being sent to HubSpot"]);
  });

  it("an erased contact leaves a tombstone: never re-created, nothing deleted in the CRM", async () => {
    const s = await setup("hubspot");
    const ids = await seedHubSpot(s);
    await importAll(s);
    await s.as((tx) => tx.delete(contacts).where(eq(contacts.email, "ben@globex.io")));
    expect((await linkOf(s, eq(crmLinks.externalId, ids.ben)))!.state).toBe("tombstone");
    await tick();
    fake.hubspot.edit("contacts", ids.ben, { firstname: "Changed" });
    await sync(s);
    expect(await contactBy(s, "ben@globex.io")).toBeUndefined();
    expect(fake.hubspot.records.contacts.get(ids.ben)!.archived).toBe(false);
    expect(fake.log.some((l) => l.method === "DELETE")).toBe(false);
  });

  it("deleted in the CRM: kept and unlinked ('Deleted in HubSpot'); a restore re-links", async () => {
    const s = await setup("hubspot");
    const ids = await seedHubSpot(s);
    await importAll(s);
    fake.hubspot.remove("contacts", ids.ben);
    // Deletes don't show in the search feed: the local edit (or the daily reconcile) finds it.
    await s.as((tx) =>
      tx
        .update(contacts)
        .set({ title: "x", updatedAt: new Date() })
        .where(eq(contacts.email, "ben@globex.io")),
    );
    await sync(s);
    expect(await contactBy(s, "ben@globex.io")).toBeDefined();
    expect(await linkOf(s, eq(crmLinks.externalId, ids.ben))).toMatchObject({
      state: "unlinked",
      reason: "deleted_in_crm",
    });
    fake.hubspot.restore("contacts", ids.ben);
    await sync(s);
    expect(await linkOf(s, eq(crmLinks.externalId, ids.ben))).toMatchObject({
      state: "linked",
      reason: null,
    });
  });

  it("the daily reconcile catches deletes the change feed misses", async () => {
    const s = await setup("hubspot");
    const ids = await seedHubSpot(s);
    await importAll(s);
    fake.hubspot.remove("companies", ids.globex);
    await s.as((tx) =>
      tx.update(crmConnections).set({ lastReconcileAt: new Date(Date.now() - 2 * 86_400_000) }),
    );
    await sync(s);
    expect(await linkOf(s, eq(crmLinks.externalId, ids.globex))).toMatchObject({
      state: "unlinked",
      reason: "deleted_in_crm",
    });
  });

  it("a CRM merge keeps the key-matching link; the other Openline record gets merge_conflict", async () => {
    const s = await setup("hubspot");
    const ids = await seedHubSpot(s);
    const dup = fake.hubspot.create("contacts", { email: "ana.lima@acme.com", firstname: "Ana L" });
    await importAll(s);
    // In HubSpot "ana.lima" is merged into "ana": the survivor keeps ana@acme.com.
    fake.hubspot.merge("contacts", dup, ids.ana);
    await s.as((tx) => tx.update(crmConnections).set({ lastReconcileAt: new Date(0) }));
    await sync(s);
    const ana = await contactBy(s, "ana@acme.com");
    const anaLima = await contactBy(s, "ana.lima@acme.com");
    expect(ana && anaLima).toBeTruthy(); // never merged in Openline
    expect((await linkOf(s, eq(crmLinks.externalId, ids.ana)))!.contactId).toBe(ana!.id);
    const errors = await openErrors(s);
    expect(errors).toEqual([
      expect.objectContaining({ code: "merge_conflict", localId: anaLima!.id }),
    ]);
  });

  it("a merge with one key match repoints the link ('merged in CRM')", async () => {
    const s = await setup("hubspot");
    const a = fake.hubspot.create("contacts", { email: "solo@acme.com", firstname: "Solo" });
    await importAll(s);
    const survivor = fake.hubspot.create("contacts", { email: "solo2@acme.com" });
    fake.hubspot.merge("contacts", a, survivor);
    fake.hubspot.records.contacts.get(survivor)!.properties.email = "solo@acme.com";
    await s.as((tx) => tx.update(crmConnections).set({ lastReconcileAt: new Date(0) }));
    await sync(s);
    const solo = await contactBy(s, "solo@acme.com");
    expect((await linkOf(s, eq(crmLinks.contactId, solo!.id)))!.externalId).toBe(survivor);
    expect((await lastRun(s)).counts.contact?.merged_in_crm).toBe(1);
  });

  it("pushes engaged contacts and every deal (with company) by default; never suppressed ones", async () => {
    const s = await setup("hubspot");
    await importAll(s);
    const won = s.stages.find((x) => x.kind === "won")!;
    await s.as(async (tx) => {
      const [co] = await tx
        .insert(companies)
        .values({ workspaceId: s.ws, name: "Initech", domain: "initech.com" })
        .returning();
      const [eng] = await tx
        .insert(contacts)
        .values({
          workspaceId: s.ws,
          email: "peter@initech.com",
          firstName: "Peter",
          companyId: co!.id,
        })
        .returning();
      await tx.insert(contacts).values({ workspaceId: s.ws, email: "idle@initech.com" });
      await tx
        .insert(contacts)
        .values({ workspaceId: s.ws, email: "nope@initech.com", status: "unsubscribed" });
      await tx
        .insert(suppressions)
        .values({ workspaceId: s.ws, value: "nope@initech.com", reason: "unsubscribed" });
      await tx.insert(deals).values({
        workspaceId: s.ws,
        name: "Initech TPS",
        ownerId: s.user,
        stageId: won.id,
        currency: "USD",
        amountMinor: 99900,
        companyId: co!.id,
        primaryContactId: eng!.id,
      });
    });
    await sync(s);
    const emails = [...fake.hubspot.records.contacts.values()].map((r) => r.properties.email);
    expect(emails).toEqual(["peter@initech.com"]);
    const [deal] = [...fake.hubspot.records.deals.values()];
    expect(deal!.properties).toMatchObject({
      dealname: "Initech TPS",
      dealstage: "closedwon",
      amount: "999.00",
      pipeline: "default",
      hubspot_owner_id: "501",
    });
    expect(fake.hubspot.associations("deals", deal!.id, "companies")).toHaveLength(1);
    expect(fake.hubspot.records.companies.size).toBe(1);
    // Next poll: no second copy, no writes.
    const writes = fake.writes().length;
    await sync(s);
    expect(fake.writes().length).toBe(writes);
  });

  it("a worker that died mid-create: recovery links by key or marks unconfirmed — never a second copy", async () => {
    const s = await setup("hubspot");
    await importAll(s);
    const open = s.stages.find((x) => x.kind === "open")!;
    const old = new Date(Date.now() - 20 * 60_000);
    const [d1, d2] = await s.as(async (tx) => {
      const rows = await tx
        .insert(deals)
        .values([
          {
            workspaceId: s.ws,
            name: "Created then crashed",
            ownerId: s.user,
            stageId: open.id,
            currency: "USD",
            updatedAt: old,
          },
          {
            workspaceId: s.ws,
            name: "Unknown fate",
            ownerId: s.user,
            stageId: open.id,
            currency: "USD",
            updatedAt: old,
          },
        ])
        .returning();
      for (const d of rows) {
        await tx.insert(crmLinks).values({
          workspaceId: s.ws,
          connectionId: s.conn,
          object: "deal",
          dealId: d.id,
          state: "creating",
          reservedAt: old,
        });
      }
      return rows;
    });
    // The first one did reach HubSpot before the crash.
    const remote = fake.hubspot.create("deals", {
      dealname: "Created then crashed",
      pipeline: "default",
      dealstage: "appointmentscheduled",
    });
    fake.hubspot.records.deals.get(remote)!.updatedAt = old.getTime();
    fake.hubspot.records.deals.get(remote)!.createdAt = old.getTime() + 1000;
    await sync(s);
    expect(await linkOf(s, eq(crmLinks.dealId, d1!.id))).toMatchObject({
      state: "linked",
      externalId: remote,
    });
    expect(await linkOf(s, eq(crmLinks.dealId, d2!.id))).toMatchObject({ state: "unconfirmed" });
    expect((await openErrors(s)).map((e) => e.code)).toEqual(["unconfirmed"]);
    expect(
      [...fake.hubspot.records.deals.values()].filter(
        (r) => r.properties.dealname === "Created then crashed",
      ),
    ).toHaveLength(1);
    expect(
      [...fake.hubspot.records.deals.values()].filter(
        (r) => r.properties.dealname === "Unknown fate",
      ),
    ).toHaveLength(0);
  });

  it("repeated 429s back off and the status says when it resumes", async () => {
    const s = await setup("hubspot");
    await importAll(s);
    fake.knobs.fail429 = 10;
    fake.knobs.retryAfterSec = 120;
    expect(await engine.syncConnection(s.ws, s.conn)).toBe("rate_limited");
    const [conn] = await s.as((tx) => tx.select().from(crmConnections));
    expect(conn!.resumesAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(conn!.nextSyncAt).toEqual(conn!.resumesAt);
    expect(conn!.status).toBe("active");
  });

  it("invalid_grant: one refresh, then error + Reconnect and exactly one admin email", async () => {
    const s = await setup("hubspot");
    await importAll(s);
    fake.hubspot.oauth.refresh.clear(); // refresh token revoked at HubSpot
    fake.hubspot.oauth.expireAll();
    expect(await engine.syncConnection(s.ws, s.conn)).toBe("reconnect");
    const [conn] = await s.as((tx) => tx.select().from(crmConnections));
    expect(conn).toMatchObject({ status: "error", nextSyncAt: null });
    expect(conn!.lastError).toMatch(/Reconnect HubSpot/);
    expect(notify).toHaveBeenCalledTimes(1);
    await s.as((tx) => tx.update(crmConnections).set({ status: "active" }));
    await engine.syncConnection(s.ws, s.conn);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(
      (
        await s.as((tx) =>
          tx.select().from(auditLog).where(eq(auditLog.action, "crm.reconnect_required")),
        )
      ).length,
    ).toBe(2);
  });

  it("an expired access token is refreshed and the rotated refresh token stored", async () => {
    const s = await setup("hubspot");
    await importAll(s);
    const before = (await s.as((tx) => tx.select().from(crmConnections)))[0]!.secretSealed;
    fake.hubspot.oauth.expireAll();
    await sync(s);
    const after = (await s.as((tx) => tx.select().from(crmConnections)))[0]!.secretSealed;
    expect(after).not.toBe(before);
    expect(after).not.toContain("rt-");
  });

  it("paused: nothing syncs either way; on resume each change syncs once", async () => {
    const s = await setup("hubspot");
    const ids = await seedHubSpot(s);
    await importAll(s);
    await s.as((tx) => tx.update(crmConnections).set({ status: "paused" }));
    await tick();
    fake.hubspot.edit("contacts", ids.ben, { jobtitle: "Paused title" });
    await s.as((tx) =>
      tx
        .update(contacts)
        .set({ firstName: "Anita", updatedAt: new Date() })
        .where(eq(contacts.email, "ana@acme.com")),
    );
    const writes = fake.writes().length;
    expect(await engine.syncConnection(s.ws, s.conn)).toBe("refreshed");
    expect(fake.writes().length).toBe(writes);
    expect((await contactBy(s, "ben@globex.io"))!.title).toBeNull();
    const [paused] = await s.as((tx) => tx.select().from(crmConnections));
    expect(paused!.nextSyncAt!.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    await s.as((tx) => tx.update(crmConnections).set({ status: "active" }));
    await sync(s);
    expect((await contactBy(s, "ben@globex.io"))!.title).toBe("Paused title");
    expect(fake.hubspot.records.contacts.get(ids.ana)!.properties.firstname).toBe("Anita");
    const afterResume = fake.writes().length;
    expect(afterResume).toBe(writes + 1);
    await sync(s);
    expect(fake.writes().length).toBe(afterResume);
  });

  it("indexing lag and a skewed CRM clock: a late-indexed change is still pulled on a later poll", async () => {
    const s = await setup("hubspot");
    const ids = await seedHubSpot(s);
    fake.knobs.clockSkewMs = -7 * 60_000; // the CRM's clock is 7 minutes behind ours
    await importAll(s);
    fake.knobs.indexLagMs = 400;
    fake.hubspot.edit("contacts", ids.ben, { jobtitle: "Indexed late" });
    await sync(s); // not in the search index yet
    expect((await contactBy(s, "ben@globex.io"))!.title).toBeNull();
    await tick(450);
    await sync(s);
    expect((await contactBy(s, "ben@globex.io"))!.title).toBe("Indexed late");
    // The cursor follows the CRM's own clock, never ours.
    const [conn] = await s.as((tx) => tx.select().from(crmConnections));
    expect(new Date(conn!.cursors.contact!.remote!).getTime()).toBeLessThan(
      Date.now() - 6 * 60_000,
    );
  });

  it("idle connections back off to 30 minutes after 4 empty polls", async () => {
    const s = await setup("hubspot");
    await importAll(s);
    for (let i = 0; i < 4; i += 1) await sync(s);
    const [conn] = await s.as((tx) => tx.select().from(crmConnections));
    expect(conn!.emptyPolls).toBe(4);
    expect(conn!.nextSyncAt!.getTime() - Date.now()).toBeGreaterThan(25 * 60_000);
  });

  it("activity notes (opt-in) are written once per email, without subjects or bodies", async () => {
    const s = await setup("hubspot", { options: { activityNotes: true } });
    const ids = await seedHubSpot(s);
    await importAll(s);
    const ana = await contactBy(s, "ana@acme.com");
    await s.as((tx) =>
      tx.execute(sql`INSERT INTO messages (workspace_id, contact_id, direction, message_id_header, subject, status, received_at, sent_at, label, body_text)
                     VALUES (${s.ws}, ${ana!.id}, 'inbound', '<r1@x>', 'Secret subject', 'received', now(), now(), 'interested', 'Secret body')`),
    );
    await sync(s);
    await sync(s);
    expect(fake.hubspot.notes).toEqual([
      { body: "Openline: reply received (interested)", contactIds: [ids.ana], dealIds: [ids.deal] },
    ]);
  });

  it("deal sync waits for a complete stage mapping; contacts continue", async () => {
    const s = await setup("hubspot");
    const ids = await seedHubSpot(s);
    await importAll(s);
    await s.as((tx) => tx.update(crmConnections).set({ stageMappingComplete: false }));
    await tick();
    fake.hubspot.edit("deals", ids.deal, { dealname: "Renamed" });
    fake.hubspot.edit("contacts", ids.ben, { jobtitle: "Still syncs" });
    await sync(s);
    expect((await s.as((tx) => tx.select().from(deals)))[0]!.name).toBe("Acme rollout");
    expect((await contactBy(s, "ben@globex.io"))!.title).toBe("Still syncs");
    expect((await lastRun(s)).counts.deal).toMatchObject({ waiting_for_stage_mapping: 1 });
  });

  it("claims due connections across workspaces; one failing connection never stops the others", async () => {
    const a = await setup("hubspot");
    await importAll(a);
    const b = await setup("hubspot");
    await importAll(b);
    // B's sealed secret is broken (cannot be opened).
    await b.as((tx) => tx.update(crmConnections).set({ secretSealed: "v1.broken.x.y" }));
    for (const s of [a, b])
      await s.as((tx) =>
        tx
          .update(crmConnections)
          .set({ nextSyncAt: new Date(Date.now() - 1000), syncLockedUntil: null }),
      );
    const summary = await engine.runOnce(10);
    expect(summary.claimed).toBeGreaterThanOrEqual(2);
    expect(summary.outcomes).toContain("synced");
    expect(summary.outcomes).toContain("failed");
  });

  describe("Pipedrive", () => {
    async function seedPipedrive(s: Setup) {
      const org = fake.pipedrive.create("organizations", { name: "Acme Org" });
      const person = fake.pipedrive.create("persons", {
        name: "Pia P",
        first_name: "Pia",
        last_name: "P",
        emails: [{ value: "pia@acme.com", primary: true }],
        org_id: org,
        owner_id: 11,
      });
      const deal = fake.pipedrive.create("deals", {
        title: "PD deal",
        value: 250,
        currency: "EUR",
        pipeline_id: 1,
        stage_id: 2,
        org_id: org,
        person_id: person,
        owner_id: 11,
      });
      await s.as((tx) => tx.insert(companies).values({ workspaceId: s.ws, name: "acme org" }));
      return { org, person, deal };
    }

    it("imports with name-matched organizations shown separately in the preview", async () => {
      const s = await setup("pipedrive");
      await seedPipedrive(s);
      const run = await preview(s);
      expect(run.counts.company).toMatchObject({ link: 1, matched_by_name: 1 });
      await importAll(s);
      const [d] = await s.as((tx) => tx.select().from(deals));
      expect(d).toMatchObject({ name: "PD deal", amountMinor: 25000, currency: "EUR" });
      expect((await s.as((tx) => tx.select().from(companies))).length).toBe(1);
    });

    it("Won in Openline → status=won; lost in Pipedrive with a reason → Lost with that reason", async () => {
      const s = await setup("pipedrive");
      const ids = await seedPipedrive(s);
      await importAll(s);
      const won = s.stages.find((x) => x.kind === "won")!;
      const lost = s.stages.find((x) => x.kind === "lost")!;
      await s.as((tx) => tx.update(deals).set({ stageId: won.id, updatedAt: new Date() }));
      await sync(s);
      expect(fake.pipedrive.records.deals.get(ids.deal)!.status).toBe("won");
      await new Promise((r) => setTimeout(r, 1100)); // Pipedrive times have 1-second resolution
      fake.pipedrive.edit("deals", ids.deal, {
        status: "lost",
        lost_reason: "Went with a competitor",
      });
      await sync(s);
      const [d] = await s.as((tx) => tx.select().from(deals));
      expect(d).toMatchObject({ stageId: lost.id, lostReason: "Went with a competitor" });
      expect(d!.closedAt).not.toBeNull();
    });

    it("a lost deal without a reason gets 'Not given (from Pipedrive)'", async () => {
      const s = await setup("pipedrive");
      fake.pipedrive.create("deals", {
        title: "Lost one",
        pipeline_id: 1,
        stage_id: 1,
        status: "lost",
      });
      await importAll(s);
      const [d] = await s.as((tx) => tx.select().from(deals));
      expect(d!.lostReason).toBe("Not given (from Pipedrive)");
    });

    it("stops at the per-connection daily token cap: 'Paused until tomorrow'", async () => {
      const s = await setup("pipedrive", { options: { pipedriveDailyCap: 1000 } });
      for (let i = 0; i < 5; i += 1)
        fake.pipedrive.create("persons", {
          name: `P${i}`,
          emails: [{ value: `p${i}@x.com`, primary: true }],
        });
      await importAll(s);
      await s.as((tx) => tx.update(crmConnections).set({ budgetSpent: 995 }));
      expect(await engine.syncConnection(s.ws, s.conn)).toBe("budget");
      const [conn] = await s.as((tx) => tx.select().from(crmConnections));
      expect(conn!.lastError).toBe("Paused until tomorrow: daily API budget");
      expect(conn!.resumesAt!.toISOString()).toMatch(/T00:00:00\.000Z$/);
      expect(conn!.budgetSpent).toBeLessThanOrEqual(1000);
    });

    it("pushes opt-outs as marketing_status=unsubscribed once", async () => {
      const s = await setup("pipedrive");
      const ids = await seedPipedrive(s);
      await importAll(s);
      await s.as((tx) =>
        tx
          .insert(suppressions)
          .values({ workspaceId: s.ws, value: "pia@acme.com", reason: "unsubscribed" }),
      );
      await sync(s);
      expect(fake.pipedrive.records.persons.get(ids.person)!.marketing_status).toBe("unsubscribed");
    });
  });

  it("another workspace's links, runs and errors are invisible to the engine's tenant scope", async () => {
    const a = await setup("hubspot");
    await seedHubSpot(a);
    await importAll(a);
    const b = await setup("hubspot");
    expect(await b.as((tx) => tx.select().from(crmLinks))).toEqual([]);
    expect(
      (await b.as((tx) => tx.select().from(crmSyncRuns))).every((r) => r.workspaceId === b.ws),
    ).toBe(true);
  });
  describe("Sprint 7 review regressions", () => {
    const companyBy = async (s: Setup, name: string) =>
      (await s.as((tx) => tx.select().from(companies).where(eq(companies.name, name))))[0];
    const connRow = async (s: Setup) => (await s.as((tx) => tx.select().from(crmConnections)))[0]!;
    const runsOf = (s: Setup) => s.as((tx) => tx.select().from(crmSyncRuns));

    it("Q1 duplicate CRM domains (gamma.io, www.gamma.io) give a record-level domain_taken; the import completes", async () => {
      const s = await setup("hubspot");
      fake.hubspot.create("companies", { name: "Gamma", domain: "gamma.io" });
      const dup = fake.hubspot.create("companies", { name: "Gamma dup", domain: "www.gamma.io" });
      await importAll(s);
      expect((await companyBy(s, "Gamma"))!.domain).toBe("gamma.io");
      expect((await companyBy(s, "Gamma dup"))!.domain).toBeNull();
      expect((await openErrors(s)).map((e) => [e.object, e.code, e.externalId])).toEqual([
        ["company", "domain_taken", dup],
      ]);
      expect((await runsOf(s)).filter((r) => r.status === "running")).toEqual([]);
    });

    it("Q1 a CRM edit to a domain another company holds keeps the domain (domain_taken); later changes still sync", async () => {
      const s = await setup("hubspot");
      fake.hubspot.create("companies", { name: "One", domain: "one.io" });
      const two = fake.hubspot.create("companies", { name: "Two", domain: "two.io" });
      const a = fake.hubspot.create("contacts", { email: "a@acme.com", firstname: "A" });
      await importAll(s);
      await tick();
      fake.hubspot.edit("companies", two, { domain: "https://www.ONE.io/about" });
      await sync(s);
      expect((await companyBy(s, "Two"))!.domain).toBe("two.io");
      expect((await openErrors(s)).map((e) => [e.code, e.externalId])).toEqual([
        ["domain_taken", two],
      ]);
      await tick();
      fake.hubspot.edit("contacts", a, { firstname: "A2" });
      await sync(s);
      expect((await contactBy(s, "a@acme.com"))!.firstName).toBe("A2");
    });

    it("Q1 any unique violation inside one record is a record-level error, never a failed run", async () => {
      const s = await setup("hubspot");
      fake.hubspot.create("contacts", { email: "a@acme.com", jobtitle: "CEO" });
      const b = fake.hubspot.create("contacts", { email: "b@acme.com", jobtitle: "CEO" });
      // A unique index this workspace alone has (stands in for any 23505 inside one record).
      const index = `crm_test_uq_${s.ws.slice(0, 8)}`;
      await handle.db.execute(
        sql.raw(`CREATE UNIQUE INDEX ${index} ON contacts (title) WHERE workspace_id = '${s.ws}'`),
      );
      try {
        await importAll(s);
      } finally {
        await handle.db.execute(sql.raw(`DROP INDEX ${index}`));
      }
      expect((await openErrors(s)).map((e) => [e.object, e.code, e.externalId])).toEqual([
        ["contact", "duplicate_value", b],
      ]);
      expect((await runsOf(s)).map((r) => r.status)).toEqual(["succeeded"]);
    });

    it("Q1 a run that fails is marked failed (never left running); the import then resumes with its options", async () => {
      const s = await setup("hubspot");
      fake.hubspot.create("contacts", { email: "a@acme.com" });
      await s.as(async (tx) => {
        await tx
          .update(crmConnections)
          .set({ status: "importing" })
          .where(eq(crmConnections.id, s.conn));
        await tx.insert(crmSyncRuns).values({
          workspaceId: s.ws,
          connectionId: s.conn,
          kind: "import",
          options: { pushLocalOnly: true },
        });
      });
      fake.knobs.fail5xx = 50;
      expect(await engine.syncConnection(s.ws, s.conn)).toBe("failed");
      expect((await runsOf(s)).map((r) => [r.status, r.errorCode])).toEqual([
        ["failed", "transient"],
      ]);
      fake.knobs.fail5xx = 0;
      expect(await engine.syncConnection(s.ws, s.conn)).toBe("imported");
      const runs = await runsOf(s);
      expect(runs.map((r) => r.status).sort()).toEqual(["failed", "succeeded"]);
      expect(runs.find((r) => r.status === "succeeded")!.options).toMatchObject({
        pushLocalOnly: true,
      });
    });

    it("Q2 domain suppressions (@blocked.io) count everywhere: preview, import, push, opt-out push", async () => {
      const s = await setup("hubspot");
      fake.hubspot.create("contacts", { email: "new@blocked.io", firstname: "N" });
      fake.hubspot.create("contacts", { email: "old@blocked.io", firstname: "O" });
      await s.as(async (tx) => {
        await tx.insert(contacts).values({ workspaceId: s.ws, email: "old@blocked.io" });
        await tx.insert(suppressions).values({
          workspaceId: s.ws,
          value: "@blocked.io",
          reason: "asked_not_to_contact",
        });
      });
      const run = await preview(s);
      expect(run.counts.contact).toMatchObject({ skipped_suppressed_new: 1, link: 1 });
      await importAll(s);
      expect(await contactBy(s, "new@blocked.io")).toBeUndefined();
      expect(fake.hubspot.unsubscribed).toEqual(["old@blocked.io"]);
      const open = s.stages.find((x) => x.kind === "open")!;
      await s.as(async (tx) => {
        const [c] = await tx
          .insert(contacts)
          .values({ workspaceId: s.ws, email: "dom@blocked.io" })
          .returning();
        await tx.insert(deals).values({
          workspaceId: s.ws,
          name: "D2",
          ownerId: s.user,
          stageId: open.id,
          currency: "USD",
          primaryContactId: c!.id,
        });
      });
      await sync(s);
      expect(fake.hubspot.find("deals", "dealname", "D2")).toBeDefined();
      expect(fake.hubspot.find("contacts", "email", "dom@blocked.io")).toBeUndefined();
    });

    it("Q3 a workspace without the plan is neither claimed nor synced, and resumes on upgrade", async () => {
      const s = await setup("hubspot");
      const ids = await seedHubSpot(s);
      await importAll(s);
      await s.as((tx) =>
        tx.update(workspaces).set({ plan: "solo" }).where(eq(workspaces.id, s.ws)),
      );
      await s.as((tx) =>
        tx
          .update(crmConnections)
          .set({ nextSyncAt: new Date(Date.now() - 1000), syncLockedUntil: null }),
      );
      const claimed = await withIdentity(handle.db, (tx) =>
        tx.execute(sql`SELECT * FROM claim_due_crm_syncs(200)`),
      );
      const rows = ((claimed as { rows?: unknown[] }).rows ?? claimed) as {
        connection_id: string;
      }[];
      expect(rows.map((r) => r.connection_id)).not.toContain(s.conn);
      await tick();
      fake.hubspot.edit("contacts", ids.ben, { jobtitle: "No plan" });
      expect(await engine.syncConnection(s.ws, s.conn)).toBe("skipped");
      expect((await contactBy(s, "ben@globex.io"))!.title).toBeNull();
      expect((await connRow(s)).nextSyncAt).not.toBeNull();
      await s.as((tx) =>
        tx.update(workspaces).set({ plan: "team" }).where(eq(workspaces.id, s.ws)),
      );
      await sync(s);
      expect((await contactBy(s, "ben@globex.io"))!.title).toBe("No plan");
    });

    it("Q4 an unknown CRM stage pauses deal sync: mapping flagged incomplete, an error row names the deal", async () => {
      const s = await setup("hubspot");
      const ids = await seedHubSpot(s);
      await importAll(s);
      await tick();
      fake.hubspot.edit("deals", ids.deal, { dealstage: "brandnewstage", dealname: "Renamed" });
      await sync(s);
      expect((await connRow(s)).stageMappingComplete).toBe(false);
      expect((await openErrors(s)).map((e) => [e.object, e.code, e.externalId])).toEqual([
        ["deal", "stage_unmapped", ids.deal],
      ]);
      expect((await s.as((tx) => tx.select().from(deals)))[0]!.name).toBe("Acme rollout");
      // The deal cursor didn't move past the waiting change.
      await s.as((tx) => tx.update(crmConnections).set({ stageMappingComplete: true }));
      await s.as((tx) =>
        tx.insert(crmStageMappings).values({
          workspaceId: s.ws,
          connectionId: s.conn,
          direction: "from_crm",
          remoteStageId: "brandnewstage",
          stageId: s.stages[0]!.id,
        }),
      );
      await sync(s);
      expect((await s.as((tx) => tx.select().from(deals)))[0]!.name).toBe("Renamed");
    });

    it("Q4 a new Openline stage flags the stage mapping incomplete with an error row", async () => {
      const s = await setup("hubspot");
      await seedHubSpot(s);
      await importAll(s);
      const [stage] = await s.as((tx) =>
        tx
          .insert(pipelineStages)
          .values({ workspaceId: s.ws, name: "Brand new", position: 50, probability: 30 })
          .returning(),
      );
      await sync(s);
      expect((await connRow(s)).stageMappingComplete).toBe(false);
      expect((await openErrors(s)).map((e) => [e.object, e.code, e.localId])).toEqual([
        ["deal", "stage_unmapped", stage!.id],
      ]);
      expect((await lastRun(s)).counts.deal).toMatchObject({ waiting_for_stage_mapping: 1 });
    });

    it("Q6 Pipedrive conflicts compare whole seconds, and a tie goes to the CRM", async () => {
      const s = await setup("pipedrive");
      const pid = fake.pipedrive.create("persons", {
        first_name: "Ann",
        emails: [{ value: "ann@acme.com", primary: true }],
      });
      await importAll(s);
      await new Promise((r) => setTimeout(r, 1100));
      fake.pipedrive.edit("persons", pid, { first_name: "Pipedrive" });
      const remoteAt = Date.parse(String(fake.pipedrive.records.persons.get(pid)!.update_time));
      // Openline's edit lands later within the same Pipedrive second: a tie.
      await s.as((tx) =>
        tx
          .update(contacts)
          .set({ firstName: "Openline", updatedAt: new Date(remoteAt + 600) })
          .where(eq(contacts.email, "ann@acme.com")),
      );
      await sync(s);
      expect((await contactBy(s, "ann@acme.com"))!.firstName).toBe("Pipedrive");
      expect(fake.pipedrive.records.persons.get(pid)!.first_name).toBe("Pipedrive");
      expect((await lastRun(s)).conflicts).toEqual([
        expect.objectContaining({ field: "firstName", winner: "crm" }),
      ]);
    });

    it("Q7 a local write to a linked record or a new suppression brings the next sync within a minute", async () => {
      const s = await setup("hubspot");
      await seedHubSpot(s);
      await importAll(s);
      const later = () =>
        s.as((tx) =>
          tx.update(crmConnections).set({ nextSyncAt: new Date(Date.now() + 30 * 60_000) }),
        );
      const soon = async () =>
        (await connRow(s)).nextSyncAt!.getTime() <= Date.now() + 61_000 ? "soon" : "later";
      await later();
      await s.as((tx) =>
        tx
          .update(contacts)
          .set({ title: "x", updatedAt: new Date() })
          .where(eq(contacts.email, "local-only@acme.com")),
      );
      expect(await soon()).toBe("later"); // not linked
      await s.as((tx) =>
        tx
          .update(contacts)
          .set({ title: "x", updatedAt: new Date() })
          .where(eq(contacts.email, "ben@globex.io")),
      );
      expect(await soon()).toBe("soon");
      await later();
      await s.as((tx) => tx.update(companies).set({ name: "Globex 2", updatedAt: new Date() }));
      expect(await soon()).toBe("soon");
      await later();
      await s.as((tx) => tx.update(deals).set({ name: "Renamed", updatedAt: new Date() }));
      expect(await soon()).toBe("soon");
      await later();
      await s.as((tx) =>
        tx
          .insert(suppressions)
          .values({ workspaceId: s.ws, value: "ben@globex.io", reason: "unsubscribed" }),
      );
      expect(await soon()).toBe("soon");
    });

    it("Q8 company domains match normalized: a stored 'www.beta.io' links to the CRM's beta.io", async () => {
      const s = await setup("hubspot");
      const remote = fake.hubspot.create("companies", { name: "Beta Inc", domain: "beta.io" });
      const [local] = await s.as((tx) =>
        tx
          .insert(companies)
          .values({ workspaceId: s.ws, name: "Beta", domain: "www.beta.io" })
          .returning(),
      );
      await importAll(s);
      expect(await s.as((tx) => tx.select().from(companies))).toHaveLength(1);
      expect((await linkOf(s, eq(crmLinks.externalId, remote)))!.companyId).toBe(local!.id);
    });

    it("Q9 a re-import after 'forget links' matches deals by exact name in the pipeline: no duplicates", async () => {
      const s = await setup("hubspot");
      fake.hubspot.create("deals", {
        dealname: "CRM deal",
        amount: "10",
        deal_currency_code: "USD",
        pipeline: "default",
        dealstage: "qualifiedtobuy",
      });
      const open = s.stages.find((x) => x.kind === "open")!;
      await s.as((tx) =>
        tx.insert(deals).values({
          workspaceId: s.ws,
          name: "Local deal",
          ownerId: s.user,
          stageId: open.id,
          currency: "USD",
        }),
      );
      await importAll(s, true);
      const count = async () => [
        (await s.as((tx) => tx.select().from(deals))).length,
        fake.hubspot.records.deals.size,
      ];
      expect(await count()).toEqual([2, 2]);
      // "Disconnect and forget links", then connect the same account and import again.
      await s.as(async (tx) => {
        await tx.delete(crmLinks).where(sql`state <> 'tombstone'`);
        await tx.update(crmConnections).set({ cursors: {} });
      });
      await importAll(s, true);
      expect(await count()).toEqual([2, 2]);
      expect(
        (await s.as((tx) => tx.select().from(crmLinks))).filter((l) => l.state === "linked"),
      ).toHaveLength(2);
    });

    it("Q10 preview counts match the import when the CRM holds one email twice", async () => {
      const s = await setup("hubspot");
      fake.hubspot.create("contacts", { email: "dup@acme.com" });
      fake.hubspot.create("contacts", { email: "DUP@acme.com" });
      const run = await preview(s);
      await importAll(s);
      const imp = (await runsOf(s)).find((r) => r.kind === "import")!;
      expect(run.counts.contact).toMatchObject({ create: 1, skipped_invalid: 1 });
      expect(imp.counts.contact).toMatchObject({ create: 1, skipped_invalid: 1 });
    });

    it("Q11 Pipedrive token spend is saved on every path (preview too) and matches the real charge", async () => {
      const s = await setup("pipedrive");
      for (let i = 0; i < 3; i += 1)
        fake.pipedrive.create("persons", {
          first_name: `P${i}`,
          emails: [{ value: `p${i}@acme.com`, primary: true }],
        });
      const base = fake.pipedrive.tokensSpent;
      await preview(s);
      expect((await connRow(s)).budgetSpent).toBe(fake.pipedrive.tokensSpent - base);
      await importAll(s);
      expect((await connRow(s)).budgetSpent).toBe(fake.pipedrive.tokensSpent - base);
      await sync(s);
      expect((await connRow(s)).budgetSpent).toBe(fake.pipedrive.tokensSpent - base);
    });

    it("Q12 a preview cut short by its time budget is 'partial', never 'succeeded'", async () => {
      const short = createCrmSync({
        db: handle.db,
        secretsKey: KEY,
        config,
        oauthFor: (p) => createOAuth(config, p, noSleep),
        logger: { warn: () => undefined, error: () => undefined },
        maxRunMs: 1,
        maxImportMs: 1,
      });
      const s = await setup("hubspot");
      await seedHubSpot(s);
      await s.as(async (tx) => {
        await tx
          .update(crmConnections)
          .set({ status: "previewing" })
          .where(eq(crmConnections.id, s.conn));
        await tx
          .insert(crmSyncRuns)
          .values({ workspaceId: s.ws, connectionId: s.conn, kind: "preview" });
      });
      expect(await short.syncConnection(s.ws, s.conn)).toBe("previewed");
      expect((await runsOf(s))[0]!.status).toBe("partial");
    });

    it("S1 a CRM opt-out upgrades an unlocked suppression to crm_unsubscribed and always unsubscribes", async () => {
      const s = await setup("hubspot");
      const ids = await seedHubSpot(s);
      fake.hubspot.create("contacts", { email: "man@acme.com", hs_email_optout: "true" });
      await s.as((tx) =>
        tx
          .insert(suppressions)
          .values({ workspaceId: s.ws, value: "man@acme.com", reason: "manual" }),
      );
      await importAll(s);
      const reason = async (v: string) =>
        (await s.as((tx) => tx.select().from(suppressions).where(eq(suppressions.value, v))))[0]!
          .reason;
      expect(await reason("man@acme.com")).toBe("crm_unsubscribed");
      await tick();
      fake.hubspot.edit("contacts", ids.ana, { hs_email_optout: "true" });
      await sync(s);
      expect(await reason("ana@acme.com")).toBe("crm_unsubscribed");
      expect((await contactBy(s, "ana@acme.com"))!.status).toBe("unsubscribed");
      // Locked reasons are never rewritten.
      expect(await reason("gone@acme.com")).toBe("unsubscribed");
    });

    it("S2 a disconnect mid-import stops every write; the connection stays disconnected", async () => {
      const s = await setup("hubspot");
      fake.hubspot.create("contacts", { email: "a@acme.com" });
      const open = s.stages.find((x) => x.kind === "open")!;
      await s.as((tx) =>
        tx.insert(deals).values({
          workspaceId: s.ws,
          name: "Would be pushed",
          ownerId: s.user,
          stageId: open.id,
          currency: "USD",
        }),
      );
      let disconnected = false;
      fake.onRequest = async (method, path) => {
        if (!disconnected && method === "GET" && path.includes("/objects/contacts")) {
          disconnected = true;
          // What DELETE /integrations/crm does, while the import runs.
          await s.as((tx) =>
            tx.update(crmConnections).set({
              status: "disconnected",
              secretSealed: "",
              nextSyncAt: null,
              syncLockedUntil: null,
            }),
          );
        }
      };
      await s.as(async (tx) => {
        await tx
          .update(crmConnections)
          .set({ status: "importing" })
          .where(eq(crmConnections.id, s.conn));
        await tx.insert(crmSyncRuns).values({
          workspaceId: s.ws,
          connectionId: s.conn,
          kind: "import",
          options: { pushLocalOnly: true },
        });
      });
      expect(await engine.syncConnection(s.ws, s.conn)).toBe("lease_lost");
      expect(await connRow(s)).toMatchObject({
        status: "disconnected",
        secretSealed: "",
        nextSyncAt: null,
        syncLockedUntil: null,
      });
      expect(fake.writes()).toEqual([]);
      expect((await runsOf(s)).map((r) => r.status)).toEqual(["partial"]);
    });

    it("S2 a token refresh racing a disconnect never writes the secret back", async () => {
      const s = await setup("hubspot");
      await importAll(s);
      // The stored access token is about to expire, so the run starts with a refresh.
      const [row] = await s.as((tx) => tx.select().from(crmConnections));
      const secret = openJson<CrmSecret>(row!.secretSealed, KEY, s.ws);
      await s.as((tx) =>
        tx
          .update(crmConnections)
          .set({ secretSealed: sealJson({ ...secret, accessExpiresAt: 0 }, KEY, s.ws) }),
      );
      fake.onRequest = async (method, path) => {
        if (method === "POST" && path.includes("/oauth/")) {
          await s.as((tx) =>
            tx
              .update(crmConnections)
              .set({ status: "disconnected", secretSealed: "", syncLockedUntil: null }),
          );
        }
      };
      await engine.syncConnection(s.ws, s.conn);
      expect(await connRow(s)).toMatchObject({ status: "disconnected", secretSealed: "" });
    });
  });
});
