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
import { aiActions, aiUsage, tasks, websiteCache } from "./schema";

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

/** Scout tables (0007): drafts, the usage ledger and the website cache are per workspace. */
describe("tenant isolation: Scout tables", () => {
  let handle: DatabaseHandle;
  const wsA = randomUUID();
  const wsB = randomUUID();
  let user = "";
  const contactOf: Record<string, string> = {};

  beforeAll(async () => {
    handle = createDatabase(process.env.TEST_DATABASE_URL ?? "pglite://memory");
    await migrate(handle);
    user = await withIdentity(handle.db, async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({ email: `scout-${randomUUID()}@a.com`, name: "S", passwordHash: "x" })
        .returning();
      return u!.id;
    });
    for (const ws of [wsA, wsB]) {
      await withTenant(handle.db, { workspaceId: ws }, async (tx) => {
        await tx.insert(workspaces).values({ id: ws, name: ws, trialEndsAt: new Date() });
        const [c] = await tx
          .insert(contacts)
          .values({ workspaceId: ws, email: `lead@${ws.slice(0, 8)}.com` })
          .returning();
        contactOf[ws] = c!.id;
        await tx.insert(aiActions).values({
          workspaceId: ws,
          userId: user,
          kind: "draft_email",
          contactId: c!.id,
          proposal: { subject: "Hi", body: "Hello", citations: [] },
          model: "fake-large",
        });
        await tx.insert(aiUsage).values({
          workspaceId: ws,
          userId: user,
          feature: "draft_email",
          model: "fake-large",
          inputTokens: 10,
          outputTokens: 5,
          credits: 1,
        });
        await tx.insert(websiteCache).values({ workspaceId: ws, domain: "acme.com", pages: [] });
      });
    }
  });

  afterAll(async () => {
    await handle.close();
  });

  it("each workspace sees only its own drafts, usage and cached pages", async () => {
    await withTenant(handle.db, { workspaceId: wsA }, async (tx) => {
      for (const table of [aiActions, aiUsage, websiteCache]) {
        const rows = await tx.select().from(table);
        expect(rows.map((r) => r.workspaceId)).toEqual([wsA]);
      }
    });
    const none = await withIdentity(handle.db, (tx) => tx.select().from(aiActions));
    expect(none).toHaveLength(0);
  });

  it("refuses writes into another workspace", async () => {
    await expect(
      withTenant(handle.db, { workspaceId: wsA }, (tx) =>
        tx.insert(aiUsage).values({
          workspaceId: wsB,
          feature: "draft_email",
          model: "m",
          inputTokens: 0,
          outputTokens: 0,
          credits: 0,
        }),
      ),
    ).rejects.toThrow();
    await withTenant(handle.db, { workspaceId: wsA }, async (tx) => {
      await tx.update(aiActions).set({ status: "rejected" });
      await tx.update(websiteCache).set({ ok: false });
      await tx.delete(websiteCache);
    });
    await withTenant(handle.db, { workspaceId: wsB }, async (tx) => {
      expect((await tx.select().from(aiActions))[0]!.status).toBe("proposed");
      expect((await tx.select().from(websiteCache))[0]!.ok).toBe(true);
    });
  });

  it("the usage ledger is append-only and drafts can't be deleted by the app role", async () => {
    await expect(
      withTenant(handle.db, { workspaceId: wsB }, (tx) =>
        tx.execute(sql`UPDATE ai_usage SET credits = 0`),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(handle.db, { workspaceId: wsB }, (tx) => tx.execute(sql`DELETE FROM ai_usage`)),
    ).rejects.toThrow();
    await expect(
      withTenant(handle.db, { workspaceId: wsB }, (tx) => tx.execute(sql`DELETE FROM ai_actions`)),
    ).rejects.toThrow();
  });

  it("deleting a contact deletes the drafts about them", async () => {
    await withTenant(handle.db, { workspaceId: wsB }, async (tx) => {
      await tx.delete(contacts).where(sql`id = ${contactOf[wsB]!}`);
      expect(await tx.select().from(aiActions)).toHaveLength(0);
    });
  });
});

describe("reply detection (0006): sync claims, inbound messages", () => {
  let handle: DatabaseHandle;
  const wsA = randomUUID();
  const wsB = randomUUID();
  const mailbox: Record<string, string> = {};
  const contact: Record<string, string> = {};

  beforeAll(async () => {
    handle = createDatabase(process.env.TEST_DATABASE_URL ?? "pglite://memory");
    await migrate(handle);
    const userId = await withIdentity(handle.db, async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({ email: `r-${randomUUID()}@a.com`, name: "R", passwordHash: "x" })
        .returning();
      return u!.id;
    });
    for (const ws of [wsA, wsB]) {
      await withTenant(handle.db, { workspaceId: ws }, async (tx) => {
        await tx.insert(workspaces).values({ id: ws, name: ws, trialEndsAt: new Date() });
        const [c] = await tx
          .insert(contacts)
          .values({ workspaceId: ws, email: `lead@${ws.slice(0, 8)}.com` })
          .returning();
        contact[ws] = c!.id;
        const rows = await tx
          .insert(mailboxes)
          .values([
            {
              workspaceId: ws,
              userId,
              provider: "smtp" as const,
              email: `on@${ws.slice(0, 8)}.com`,
              secretSealed: "sealed-credentials",
              replyDetection: "on" as const,
            },
            {
              workspaceId: ws,
              userId,
              provider: "smtp" as const,
              email: `off@${ws.slice(0, 8)}.com`,
              secretSealed: "sealed-credentials",
            },
            {
              workspaceId: ws,
              userId,
              provider: "smtp" as const,
              email: `gone@${ws.slice(0, 8)}.com`,
              secretSealed: "",
              status: "disconnected" as const,
              replyDetection: "on" as const,
            },
          ])
          .returning();
        mailbox[ws] = rows[0]!.id;
      });
    }
  });

  afterAll(async () => {
    await handle.close();
  });

  const claim = () =>
    withIdentity(handle.db, (tx) =>
      tx.execute(sql`SELECT * FROM claim_due_mailbox_syncs(10)`),
    ).then((r) => (r as unknown as { rows: { workspace_id: string; mailbox_id: string }[] }).rows);

  it("claim_due_mailbox_syncs returns due mailboxes of every workspace once (lease), ids only", async () => {
    const first = await claim();
    expect(first.map((r) => r.mailbox_id).sort()).toEqual([mailbox[wsA], mailbox[wsB]].sort());
    expect(Object.keys(first[0]!).sort()).toEqual(["mailbox_id", "workspace_id"]);
    expect(await claim()).toEqual([]);
  });

  it("the scheduler role can't read mailbox credentials or settings", async () => {
    await expect(
      handle.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE openline_scheduler`);
        await tx.execute(sql`SELECT secret_sealed FROM mailboxes`);
      }),
    ).rejects.toThrow();
    const rows = await handle.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE openline_scheduler`);
      return tx.execute(sql`SELECT id FROM mailboxes WHERE reply_detection = 'on'`);
    });
    expect((rows as unknown as { rows: unknown[] }).rows.length).toBeGreaterThan(0);
  });

  it("the app role still sees only its own workspace's mailboxes", async () => {
    const rows = await withTenant(handle.db, { workspaceId: wsA }, (tx) =>
      tx.select().from(mailboxes),
    );
    expect(rows.every((r) => r.workspaceId === wsA)).toBe(true);
  });

  const reply = (ws: string, messageId: string) =>
    withTenant(handle.db, { workspaceId: ws }, (tx) =>
      tx
        .insert(messages)
        .values({
          workspaceId: ws,
          contactId: contact[ws],
          mailboxId: mailbox[ws],
          direction: "inbound",
          status: "received",
          messageIdHeader: messageId,
          subject: "Re: hi",
          fromEmail: "lead@x.com",
          bodyText: "Thanks",
          receivedAt: new Date(),
          label: "interested",
          labelSource: "rule",
        })
        .onConflictDoNothing()
        .returning(),
    );

  it("stores an inbound message once per (mailbox, Message-ID)", async () => {
    expect(await reply(wsA, "<r1@x.com>")).toHaveLength(1);
    expect(await reply(wsA, "<r1@x.com>")).toHaveLength(0);
    expect(await reply(wsB, "<r1@x.com>")).toHaveLength(1); // another mailbox: its own copy
  });

  it("inbound messages are invisible across workspaces and can't be written into another", async () => {
    const rows = await withTenant(handle.db, { workspaceId: wsA }, (tx) =>
      tx.select().from(messages),
    );
    expect(rows.every((r) => r.workspaceId === wsA)).toBe(true);
    await expect(
      withTenant(handle.db, { workspaceId: wsA }, (tx) =>
        tx.insert(messages).values({
          workspaceId: wsB,
          direction: "inbound",
          messageIdHeader: "<sneaky@x.com>",
          subject: "x",
        }),
      ),
    ).rejects.toThrow();
  });

  it("deleting a contact deletes their inbound messages; outbound history stays", async () => {
    await withTenant(handle.db, { workspaceId: wsB }, async (tx) => {
      await tx.insert(messages).values({
        workspaceId: wsB,
        contactId: contact[wsB],
        mailboxId: mailbox[wsB],
        messageIdHeader: "<ol.out@b.com>",
        subject: "Hi",
      });
      await tx.delete(contacts).where(sql`id = ${contact[wsB]}`);
      const left = await tx.select().from(messages);
      expect(left.map((m) => m.direction)).toEqual(["outbound"]);
      expect(left[0]!.contactId).toBeNull();
    });
  });
});

/** Tasks and promise proposals (0009): per workspace, closed not deleted. */
describe("tenant isolation: tasks and promise proposals (0009)", () => {
  let handle: DatabaseHandle;
  const wsA = randomUUID();
  const wsB = randomUUID();
  let user = "";
  const contactOf: Record<string, string> = {};
  const taskOf: Record<string, string> = {};

  beforeAll(async () => {
    handle = createDatabase(process.env.TEST_DATABASE_URL ?? "pglite://memory");
    await migrate(handle);
    user = await withIdentity(handle.db, async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({ email: `t-${randomUUID()}@a.com`, name: "T", passwordHash: "x" })
        .returning();
      return u!.id;
    });
    for (const ws of [wsA, wsB]) {
      await withTenant(handle.db, { workspaceId: ws }, async (tx) => {
        await tx.insert(workspaces).values({ id: ws, name: ws, trialEndsAt: new Date() });
        const [c] = await tx
          .insert(contacts)
          .values({ workspaceId: ws, email: `lead@${ws.slice(0, 8)}.com` })
          .returning();
        contactOf[ws] = c!.id;
        const [t] = await tx
          .insert(tasks)
          .values({ workspaceId: ws, ownerId: user, contactId: c!.id, title: "Send pricing" })
          .returning();
        taskOf[ws] = t!.id;
        await tx.insert(aiActions).values({
          workspaceId: ws,
          userId: user,
          kind: "promise_task",
          contactId: c!.id,
          proposal: { body: "Send pricing", citations: [] },
          model: "rules",
        });
      });
    }
  });

  afterAll(async () => {
    await handle.close();
  });

  it("each workspace sees only its own tasks; none without a workspace", async () => {
    const rows = await withTenant(handle.db, { workspaceId: wsA }, (tx) => tx.select().from(tasks));
    expect(rows.map((r) => r.id)).toEqual([taskOf[wsA]]);
    expect(await withIdentity(handle.db, (tx) => tx.select().from(tasks))).toHaveLength(0);
  });

  it("refuses to insert a task into another workspace and can't update its rows", async () => {
    await expect(
      withTenant(handle.db, { workspaceId: wsA }, (tx) =>
        tx.insert(tasks).values({ workspaceId: wsB, ownerId: user, title: "Sneaky" }),
      ),
    ).rejects.toThrow();
    await withTenant(handle.db, { workspaceId: wsA }, (tx) =>
      tx
        .update(tasks)
        .set({ title: "hacked" })
        .where(sql`id = ${taskOf[wsB]!}`),
    );
    const [b] = await withTenant(handle.db, { workspaceId: wsB }, (tx) => tx.select().from(tasks));
    expect(b!.title).toBe("Send pricing");
  });

  it("the app role cannot delete tasks, and closed tasks need a completed_at", async () => {
    await expect(
      withTenant(handle.db, { workspaceId: wsA }, (tx) => tx.execute(sql`DELETE FROM tasks`)),
    ).rejects.toThrow();
    await expect(
      withTenant(handle.db, { workspaceId: wsA }, (tx) =>
        tx
          .update(tasks)
          .set({ status: "done" })
          .where(sql`id = ${taskOf[wsA]!}`),
      ),
    ).rejects.toThrow();
  });

  it("ai_actions accepts the promise kinds (and still the draft kinds), nothing else", async () => {
    await withTenant(handle.db, { workspaceId: wsA }, async (tx) => {
      const kinds = (await tx.select().from(aiActions)).map((r) => r.kind);
      expect(kinds).toEqual(["promise_task"]);
      await tx.insert(aiActions).values({
        workspaceId: wsA,
        userId: user,
        kind: "pause_enrollments",
        proposal: { body: "Pause", citations: [] },
        model: "rules",
      });
    });
    await expect(
      withTenant(handle.db, { workspaceId: wsA }, (tx) =>
        tx.execute(
          sql`INSERT INTO ai_actions (workspace_id, user_id, kind, proposal, model)
              VALUES (${wsA}, ${user}, 'send_email', '{}'::jsonb, 'm')`,
        ),
      ),
    ).rejects.toThrow();
  });

  it("deleting a contact deletes the tasks about them", async () => {
    await withTenant(handle.db, { workspaceId: wsB }, async (tx) => {
      await tx.delete(contacts).where(sql`id = ${contactOf[wsB]!}`);
      expect(await tx.select().from(tasks)).toHaveLength(0);
    });
    const a = await withTenant(handle.db, { workspaceId: wsA }, (tx) => tx.select().from(tasks));
    expect(a).toHaveLength(1);
  });
});
