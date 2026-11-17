import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "./client";
import { migrate } from "./migrate";
import { seedDefaultStages } from "./pipeline";
import {
  contacts,
  crmConnections,
  crmFieldMappings,
  crmLinks,
  crmStageMappings,
  crmSyncErrors,
  crmSyncRuns,
  deals,
  pipelineStages,
  users,
  workspaces,
} from "./schema";
import { withIdentity, withTenant, type Tx } from "./tenant";

/**
 * CRM sync tables (0014): row-level security on every table, same-workspace composite keys,
 * the erasure tombstone, and the scheduler's claim function. CI also runs this file against a
 * real Postgres 16 (TEST_DATABASE_URL).
 */
describe("CRM sync tables: tenant isolation", () => {
  let handle: DatabaseHandle;
  const wsA = randomUUID();
  const wsB = randomUUID();
  let user = "";
  const ids: Record<
    string,
    { connection: string; contact: string; stage: string; deal: string; run: string }
  > = {};

  const asA = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(handle.db, { workspaceId: wsA }, fn);
  const asB = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(handle.db, { workspaceId: wsB }, fn);
  const rows = <T>(r: unknown) => ((r as { rows?: T[] }).rows ?? (r as T[])) as T[];

  beforeAll(async () => {
    handle = createDatabase(process.env.TEST_DATABASE_URL ?? "pglite://memory");
    await migrate(handle);
    user = await withIdentity(handle.db, async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({ email: `crm-${randomUUID()}@a.com`, name: "Ana", passwordHash: "x" })
        .returning();
      return u!.id;
    });
    for (const ws of [wsA, wsB]) {
      ids[ws] = await withTenant(handle.db, { workspaceId: ws }, async (tx) => {
        await tx.insert(workspaces).values({ id: ws, name: ws, trialEndsAt: new Date() });
        await seedDefaultStages(tx, ws);
        const [contact] = await tx
          .insert(contacts)
          .values({ workspaceId: ws, email: `lead@${ws.slice(0, 8)}.com` })
          .returning();
        const [stage] = await tx.select().from(pipelineStages).limit(1);
        const [deal] = await tx
          .insert(deals)
          .values({
            workspaceId: ws,
            name: "Deal",
            ownerId: user,
            stageId: stage!.id,
            currency: "USD",
          })
          .returning();
        const [connection] = await tx
          .insert(crmConnections)
          .values({
            workspaceId: ws,
            provider: "hubspot",
            status: "active",
            secretSealed: "v1.secret",
            nextSyncAt: new Date(Date.now() - 1000),
          })
          .returning();
        const [run] = await tx
          .insert(crmSyncRuns)
          .values({ workspaceId: ws, connectionId: connection!.id, kind: "incremental" })
          .returning();
        await tx.insert(crmLinks).values({
          workspaceId: ws,
          connectionId: connection!.id,
          object: "contact",
          contactId: contact!.id,
          externalId: "101",
          shadow: { firstName: "0123456789abcdef" },
        });
        await tx.insert(crmFieldMappings).values({
          workspaceId: ws,
          connectionId: connection!.id,
          object: "contact",
          localField: "firstName",
          standard: true,
        });
        await tx.insert(crmStageMappings).values({
          workspaceId: ws,
          connectionId: connection!.id,
          direction: "from_crm",
          remoteStageId: "appointmentscheduled",
          stageId: stage!.id,
        });
        await tx.insert(crmSyncErrors).values({
          workspaceId: ws,
          connectionId: connection!.id,
          runId: run!.id,
          object: "contact",
          localId: contact!.id,
          direction: "to_crm",
          code: "validation",
          message: "The CRM rejected this record.",
        });
        return {
          connection: connection!.id,
          contact: contact!.id,
          stage: stage!.id,
          deal: deal!.id,
          run: run!.id,
        };
      });
    }
  });

  afterAll(async () => {
    await handle.close();
  });

  const tables = [
    ["crm_connections", crmConnections],
    ["crm_links", crmLinks],
    ["crm_field_mappings", crmFieldMappings],
    ["crm_stage_mappings", crmStageMappings],
    ["crm_sync_runs", crmSyncRuns],
    ["crm_sync_errors", crmSyncErrors],
  ] as const;

  it.each(tables)(
    "%s: each workspace sees only its own rows, none without a workspace",
    async (_n, table) => {
      const a = await asA((tx) => tx.select().from(table));
      expect(a.length).toBeGreaterThan(0);
      expect(a.every((r) => r.workspaceId === wsA)).toBe(true);
      expect(await withIdentity(handle.db, (tx) => tx.select().from(table))).toHaveLength(0);
    },
  );

  it.each(tables)("%s: FORCE row-level security is on", async (name) => {
    const [row] = rows<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      await handle.db.execute(
        sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ${name}`,
      ),
    );
    expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("cannot insert rows into another workspace", async () => {
    const b = ids[wsB]!;
    const attempts: ((tx: Tx) => Promise<unknown>)[] = [
      (tx) => tx.insert(crmConnections).values({ workspaceId: wsB, provider: "pipedrive" }),
      (tx) =>
        tx
          .insert(crmSyncRuns)
          .values({ workspaceId: wsB, connectionId: b.connection, kind: "preview" }),
      (tx) =>
        tx.insert(crmLinks).values({
          workspaceId: wsB,
          connectionId: b.connection,
          object: "deal",
          dealId: b.deal,
          externalId: "9",
        }),
    ];
    for (const attempt of attempts) await expect(asA(attempt)).rejects.toThrow();
  });

  it("cannot update or delete another workspace's rows", async () => {
    await asA((tx) => tx.update(crmConnections).set({ accountName: "hacked" }));
    await asA((tx) => tx.delete(crmLinks).where(sql`workspace_id = ${wsB}`));
    const [b] = await asB((tx) => tx.select().from(crmConnections));
    expect(b!.accountName).toBeNull();
    expect(await asB((tx) => tx.select().from(crmLinks))).toHaveLength(1);
    await asA((tx) => tx.update(crmConnections).set({ accountName: null }));
  });

  it("composite keys: a row can never point at another workspace's records", async () => {
    const a = ids[wsA]!;
    const b = ids[wsB]!;
    const attempts: ((tx: Tx) => Promise<unknown>)[] = [
      // A's connection, B's contact.
      (tx) =>
        tx.insert(crmLinks).values({
          workspaceId: wsA,
          connectionId: a.connection,
          object: "contact",
          contactId: b.contact,
          externalId: "x1",
        }),
      // B's connection under A's workspace id.
      (tx) =>
        tx.insert(crmFieldMappings).values({
          workspaceId: wsA,
          connectionId: b.connection,
          object: "deal",
          localField: "name",
        }),
      // B's stage.
      (tx) =>
        tx.insert(crmStageMappings).values({
          workspaceId: wsA,
          connectionId: a.connection,
          direction: "to_crm",
          remoteStageId: "s1",
          stageId: b.stage,
        }),
      // B's run.
      (tx) =>
        tx.insert(crmSyncErrors).values({
          workspaceId: wsA,
          connectionId: a.connection,
          runId: b.run,
          object: "deal",
          externalId: "1",
          direction: "from_crm",
          code: "validation",
          message: "x",
        }),
    ];
    for (const attempt of attempts) await expect(asA(attempt)).rejects.toThrow();
  });

  it("one connection per workspace", async () => {
    await expect(
      asA((tx) => tx.insert(crmConnections).values({ workspaceId: wsA, provider: "pipedrive" })),
    ).rejects.toThrow();
  });

  it("links are unique both ways per connection and hold exactly one record of their type", async () => {
    const a = ids[wsA]!;
    const base = { workspaceId: wsA, connectionId: a.connection };
    // Same external id again.
    await expect(
      asA((tx) =>
        tx.insert(crmLinks).values({ ...base, object: "deal", dealId: a.deal, externalId: "101" }),
      ),
    ).resolves.toBeDefined(); // different object type: allowed
    await expect(
      asA((tx) =>
        tx.insert(crmLinks).values({ ...base, object: "deal", dealId: a.deal, externalId: "102" }),
      ),
    ).rejects.toThrow(); // same deal twice
    await expect(
      asA((tx) =>
        tx
          .insert(crmLinks)
          .values({ ...base, object: "contact", contactId: a.contact, externalId: "555" }),
      ),
    ).rejects.toThrow(); // same contact twice
    await expect(
      asA((tx) =>
        tx
          .insert(crmLinks)
          .values({ ...base, object: "company", contactId: a.contact, externalId: "c" }),
      ),
    ).rejects.toThrow(); // wrong column for the object
    await expect(
      asA((tx) => tx.insert(crmLinks).values({ ...base, object: "company", externalId: "c" })),
    ).rejects.toThrow(); // no record and not a tombstone
    await asA((tx) => tx.delete(crmLinks).where(sql`object = 'deal'`));
  });

  it("deleting (erasing) a linked contact leaves a tombstone with the external id only", async () => {
    const [created] = await asA(async (tx) => {
      const [c] = await tx
        .insert(contacts)
        .values({ workspaceId: wsA, email: `erase-${randomUUID()}@x.com` })
        .returning();
      return tx
        .insert(crmLinks)
        .values({
          workspaceId: wsA,
          connectionId: ids[wsA]!.connection,
          object: "contact",
          contactId: c!.id,
          externalId: "erase-1",
          shadow: { lastName: "abcdefabcdefabcd" },
        })
        .returning();
    });
    await asA((tx) => tx.delete(contacts).where(sql`id = ${created!.contactId}`));
    const [link] = await asA((tx) =>
      tx
        .select()
        .from(crmLinks)
        .where(sql`id = ${created!.id}`),
    );
    expect(link).toMatchObject({
      state: "tombstone",
      reason: "erased_in_openline",
      externalId: "erase-1",
      contactId: null,
      shadow: {},
    });
  });

  it("sync errors: the app may change only resolution and retry fields", async () => {
    await asA((tx) =>
      tx.execute(
        sql`UPDATE crm_sync_errors SET attempts = 2, next_retry_at = now(), resolved_at = now(),
                   resolution = 'dismissed', resolved_by = ${user}`,
      ),
    );
    for (const statement of [
      sql`UPDATE crm_sync_errors SET message = 'changed'`,
      sql`UPDATE crm_sync_errors SET code = 'other'`,
    ]) {
      await expect(asA((tx) => tx.execute(statement))).rejects.toThrow();
    }
  });

  it("claim_due_crm_syncs: due connections across tenants, ids only, leased once", async () => {
    const claim = () =>
      withIdentity(handle.db, (tx) => tx.execute(sql`SELECT * FROM claim_due_crm_syncs(10)`)).then(
        (r) => rows<{ workspace_id: string; connection_id: string }>(r),
      );
    const first = await claim();
    expect(first.map((r) => r.connection_id).sort()).toEqual(
      [ids[wsA]!.connection, ids[wsB]!.connection].sort(),
    );
    expect(Object.keys(first[0]!).sort()).toEqual(["connection_id", "workspace_id"]);
    expect(await claim()).toEqual([]);

    // Disconnected / needs_setup / error connections are never due; not-yet-due ones neither.
    await asA((tx) =>
      tx.update(crmConnections).set({ status: "disconnected", syncLockedUntil: null }),
    );
    await asB((tx) =>
      tx
        .update(crmConnections)
        .set({ syncLockedUntil: null, nextSyncAt: new Date(Date.now() + 60_000) }),
    );
    expect(await claim()).toEqual([]);
    await asB((tx) => tx.update(crmConnections).set({ nextSyncAt: new Date(Date.now() - 1000) }));
    expect((await claim()).map((r) => r.workspace_id)).toEqual([wsB]);
  });

  it("mark_crm_uninstalled disconnects that company's Pipedrive connections only, ids only", async () => {
    // Unique company ids: a shared database (CI's Postgres) holds other suites' connections.
    const company = String(Date.now()).slice(-9);
    await asA((tx) =>
      tx.update(crmConnections).set({
        provider: "pipedrive",
        accountId: company,
        status: "active",
        secretSealed: "v1.x",
        syncLockedUntil: new Date(Date.now() + 600_000),
      }),
    );
    await asB((tx) =>
      tx
        .update(crmConnections)
        .set({ provider: "pipedrive", accountId: `${company}9`, status: "active" }),
    );
    const out = rows<{ workspace_id: string; connection_id: string }>(
      await withIdentity(handle.db, (tx) =>
        tx.execute(sql`SELECT * FROM mark_crm_uninstalled('pipedrive', ${company})`),
      ),
    );
    expect(out).toEqual([{ workspace_id: wsA, connection_id: ids[wsA]!.connection }]);
    const [a] = await asA((tx) => tx.select().from(crmConnections));
    // The lease goes too (SEC-S2): a running sync stops at its next lease check.
    expect(a).toMatchObject({
      status: "disconnected",
      secretSealed: "",
      nextSyncAt: null,
      syncLockedUntil: null,
    });
    const [b] = await asB((tx) => tx.select().from(crmConnections));
    expect(b!.status).toBe("active");
  });

  it("api_domain only holds a Pipedrive company domain (or the loopback fake), by CHECK", async () => {
    for (const bad of [
      "https://evil.example",
      "http://acme.pipedrive.com",
      "https://acme.pipedrive.com.evil.io",
      "http://10.0.0.5/pipedrive",
    ]) {
      await expect(
        asA((tx) => tx.update(crmConnections).set({ apiDomain: bad })),
      ).rejects.toThrow();
    }
    for (const ok of ["https://acme.pipedrive.com", "http://127.0.0.1:4900/pipedrive", null]) {
      await asA((tx) => tx.update(crmConnections).set({ apiDomain: ok }));
    }
  });

  it("the scheduler role can't read tokens, accounts, options or cursors", async () => {
    for (const statement of [
      sql`SELECT secret_sealed FROM crm_connections`,
      sql`SELECT account_name FROM crm_connections`,
      sql`SELECT api_domain FROM crm_connections`,
      sql`SELECT cursors FROM crm_connections`,
      sql`SELECT external_id FROM crm_links`,
    ]) {
      await expect(
        handle.db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE openline_scheduler`);
          await tx.execute(statement);
        }),
      ).rejects.toThrow();
    }
  });
});
