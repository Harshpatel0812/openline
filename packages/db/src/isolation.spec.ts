import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "./client";
import { migrate } from "./migrate";
import {
  contacts,
  enrollments,
  mailboxes,
  messages,
  sequences,
  users,
  workspaceMembers,
  workspaces,
} from "./schema";
import { withIdentity, withTenant } from "./tenant";

/**
 * The most important test in the codebase: one workspace can never read or write
 * another workspace's data, even if application code forgets a filter.
 */
describe("tenant isolation (row-level security)", () => {
  let handle: DatabaseHandle;
  const wsA = randomUUID();
  const wsB = randomUUID();
  let userA = "";

  beforeAll(async () => {
    // CI also runs this against a real Postgres service via TEST_DATABASE_URL.
    handle = createDatabase(process.env.TEST_DATABASE_URL ?? "pglite://memory");
    await migrate(handle);

    userA = await withIdentity(handle.db, async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({ email: `a-${randomUUID()}@a.com`, name: "A", passwordHash: "x" })
        .returning();
      return u!.id;
    });

    for (const ws of [wsA, wsB]) {
      await withTenant(handle.db, { workspaceId: ws }, async (tx) => {
        await tx.insert(workspaces).values({ id: ws, name: ws, trialEndsAt: new Date() });
        await tx.insert(contacts).values({ workspaceId: ws, email: `lead@${ws.slice(0, 8)}.com` });
      });
    }
    await withTenant(handle.db, { workspaceId: wsA }, (tx) =>
      tx.insert(workspaceMembers).values({ workspaceId: wsA, userId: userA, role: "owner" }),
    );
  });

  afterAll(async () => {
    await handle.close();
  });

  it("migrations are idempotent", async () => {
    expect(await migrate(handle)).toEqual([]);
  });

  it("shows only the current workspace's contacts, even with no WHERE clause", async () => {
    const rows = await withTenant(handle.db, { workspaceId: wsA }, (tx) =>
      tx.select().from(contacts),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workspaceId).toBe(wsA);
  });

  it("shows nothing when no workspace is set", async () => {
    const rows = await withIdentity(handle.db, (tx) => tx.select().from(contacts));
    expect(rows).toHaveLength(0);
  });

  it("refuses to insert a row into another workspace", async () => {
    await expect(
      withTenant(handle.db, { workspaceId: wsA }, (tx) =>
        tx.insert(contacts).values({ workspaceId: wsB, email: "sneaky@b.com" }),
      ),
    ).rejects.toThrow();
  });

  it("cannot update another workspace's rows", async () => {
    await withTenant(handle.db, { workspaceId: wsA }, (tx) =>
      tx.update(contacts).set({ firstName: "hacked" }),
    );
    const bRows = await withTenant(handle.db, { workspaceId: wsB }, (tx) =>
      tx.select().from(contacts),
    );
    expect(bRows[0]!.firstName).toBeNull();
  });

  it("lets a user see their own memberships without a workspace set (login)", async () => {
    const rows = await withTenant(handle.db, { userId: userA }, (tx) =>
      tx.select().from(workspaceMembers),
    );
    expect(rows.map((r) => r.workspaceId)).toEqual([wsA]);
  });

  it("a user cannot delete their membership in another workspace", async () => {
    // userA is a member of wsA; acting from wsB they must not be able to touch wsA rows.
    await withTenant(handle.db, { workspaceId: wsB, userId: userA }, (tx) =>
      tx.delete(workspaceMembers),
    );
    const rows = await withTenant(handle.db, { workspaceId: wsA }, (tx) =>
      tx.select().from(workspaceMembers),
    );
    expect(rows).toHaveLength(1);
  });

  it("the app role cannot delete workspaces", async () => {
    await expect(
      withTenant(handle.db, { workspaceId: wsA }, (tx) => tx.delete(workspaces)),
    ).rejects.toThrow();
  });

  it("claim_due_enrollments is the only cross-tenant path and leases rows once", async () => {
    const claim = () =>
      withIdentity(handle.db, (tx) =>
        tx.execute(sql`SELECT * FROM claim_due_enrollments(10)`),
      ).then(
        (r) => (r as unknown as { rows: { workspace_id: string; enrollment_id: string }[] }).rows,
      );
    // No enrollments yet: nothing to claim, and no error for the restricted role.
    expect(await claim()).toEqual([]);

    // One due enrollment in each workspace. The function runs as openline_scheduler (no
    // superuser, no BYPASSRLS), exactly as in production, so this proves it can see due rows.
    const due: Record<string, string> = {};
    for (const ws of [wsA, wsB]) {
      due[ws] = await withTenant(handle.db, { workspaceId: ws }, async (tx) => {
        const [contact] = await tx.select().from(contacts);
        const [mailbox] = await tx
          .insert(mailboxes)
          .values({
            workspaceId: ws,
            userId: userA,
            provider: "smtp",
            email: `rep@${ws.slice(0, 8)}.com`,
            secretSealed: "x",
          })
          .returning();
        const [sequence] = await tx
          .insert(sequences)
          .values({ workspaceId: ws, name: "Seq", status: "active" })
          .returning();
        const [enrollment] = await tx
          .insert(enrollments)
          .values({
            workspaceId: ws,
            sequenceId: sequence!.id,
            contactId: contact!.id,
            mailboxId: mailbox!.id,
            nextRunAt: new Date(Date.now() - 60_000),
          })
          .returning();
        return enrollment!.id;
      });
    }

    const first = await claim();
    expect(first.map((r) => r.enrollment_id).sort()).toEqual([due[wsA], due[wsB]].sort());
    expect(await claim()).toEqual([]); // leased: a second worker gets nothing
  });

  it("a step can be reserved for sending only once per enrollment", async () => {
    await withTenant(handle.db, { workspaceId: wsA }, async (tx) => {
      const [enrollment] = await tx.select().from(enrollments);
      const reserve = () =>
        tx
          .insert(messages)
          .values({
            workspaceId: wsA,
            enrollmentId: enrollment!.id,
            contactId: enrollment!.contactId,
            mailboxId: enrollment!.mailboxId,
            stepPosition: 1,
            messageIdHeader: `<${randomUUID()}@a.com>`,
            subject: "Hi",
            status: "sending",
          })
          .onConflictDoNothing()
          .returning();
      expect(await reserve()).toHaveLength(1);
      expect(await reserve()).toHaveLength(0);
    });
  });

  it("the app role cannot read enrollments through the scheduler's policy", async () => {
    const rows = await withIdentity(handle.db, (tx) => tx.select().from(enrollments));
    expect(rows).toHaveLength(0);
  });

  it("the audit log cannot be altered by the app role", async () => {
    await expect(
      withTenant(handle.db, { workspaceId: wsA }, async (tx) => {
        // UPDATE privilege is deliberately not granted on audit_log.
        await tx.execute(sql`UPDATE audit_log SET action = 'x'`);
      }),
    ).rejects.toThrow();
  });
});
