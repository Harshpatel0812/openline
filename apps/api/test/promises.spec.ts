/**
 * Sprint 5 (OL-E6 §2): Promise Keeper end to end — a reply arrives through the real reply-sync
 * pipeline, proposals appear, and only the mailbox owner (or a manager) accepts or dismisses them.
 */
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  aiActions,
  and,
  auditLog,
  enrollments,
  eq,
  messages,
  sequences,
  withTenant,
  type DatabaseHandle,
} from "@openline/db";
import { createReplySync, type RawInbound } from "@openline/replies";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONFIG, type AppConfig } from "../src/config";
import { DB } from "../src/database/database.module";
import { MailboxesService } from "../src/modules/mailboxes/mailboxes.service";
import { PromiseKeeperService } from "../src/modules/promises/promise-keeper.service";
import {
  joinVerifiedAs,
  signedUp,
  uniqueEmail,
  verifiedSignup,
  createTestApp,
  browser,
  type Browser,
} from "./helpers";

const ADDRESS = "1 Main St, Jersey City, NJ 07302";
const missingId = "00000000-0000-4000-8000-000000000000";

function rawReply(opts: { inReplyTo: string; text: string }): Buffer {
  return Buffer.from(
    [
      "From: Jane <jane@buyer.com>",
      "To: rep@acme.com",
      "Subject: Re: Hi Jane",
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <r${Math.random().toString(36).slice(2)}@buyer.com>`,
      `In-Reply-To: ${opts.inReplyTo}`,
      `References: ${opts.inReplyTo}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      opts.text,
      "",
    ].join("\r\n"),
  );
}

describe("promises (Sprint 5)", () => {
  let app: NestExpressApplication;
  let config: AppConfig;
  let handle: DatabaseHandle;
  let keeper: PromiseKeeperService["keeper"];

  beforeAll(async () => {
    app = await createTestApp({ MAIL_TRANSPORT: "capture", OUTREACH_TRANSPORT: "capture" });
    config = app.get<AppConfig>(CONFIG);
    handle = app.get<DatabaseHandle>(DB);
    keeper = app.get(PromiseKeeperService).keeper;
    app.get(MailboxesService).imapVerifier = async () => undefined;
  });
  afterAll(async () => {
    await app.close();
  });

  const me = async (b: Browser) => (await b.get("/v1/auth/me").expect(200)).body;

  /** Owner + a rep whose mailbox wrote to Jane (step 1 recorded as sent). */
  async function team() {
    const { b: owner } = await verifiedSignup(app);
    await owner.patch("/v1/workspace", { mailingAddress: ADDRESS }).expect(200);
    const { b: rep } = await joinVerifiedAs(app, owner, "rep");
    const { b: rep2 } = await joinVerifiedAs(app, owner, "rep");
    const { b: manager } = await joinVerifiedAs(app, owner, "manager");
    const workspaceId = (await me(owner)).workspace.id as string;
    const mailbox = await rep
      .post("/v1/mailboxes/smtp", {
        host: "smtp.acme.com",
        port: 587,
        secure: false,
        username: "sender@acme.com",
        password: "app-password-123",
        email: uniqueEmail("mbox"),
      })
      .expect(201);
    await rep
      .put(`/v1/mailboxes/${mailbox.body.id as string}/imap`, { host: "imap.acme.com", port: 993 })
      .expect(200);
    const contact = await rep
      .post("/v1/contacts", { email: "jane@buyer.com", firstName: "Jane", country: "US" })
      .expect(201);
    const header = `<ol.${Math.random().toString(36).slice(2)}@acme.com>`;
    const userId = (await me(rep)).user.id as string;
    const enrollmentId = await withTenant(handle.db, { workspaceId }, async (tx) => {
      const [seq] = await tx
        .insert(sequences)
        .values({ workspaceId, name: "Intro", status: "active", createdBy: userId })
        .returning();
      const [e] = await tx
        .insert(enrollments)
        .values({
          workspaceId,
          sequenceId: seq!.id,
          contactId: contact.body.id,
          mailboxId: mailbox.body.id,
          nextPosition: 2,
          nextRunAt: new Date(Date.now() + 86_400_000),
        })
        .returning();
      await tx.insert(messages).values({
        workspaceId,
        enrollmentId: e!.id,
        contactId: contact.body.id,
        mailboxId: mailbox.body.id,
        stepPosition: 1,
        messageIdHeader: header,
        subject: "Hi Jane",
        sentAt: new Date(Date.now() - 86_400_000),
      });
      return e!.id;
    });
    return {
      owner,
      rep,
      rep2,
      manager,
      workspaceId,
      userId,
      mailboxId: mailbox.body.id as string,
      contactId: contact.body.id as string,
      header,
      enrollmentId,
    };
  }
  type Team = Awaited<ReturnType<typeof team>>;

  /** Delivers Jane's reply through reply sync (with Promise Keeper) and waits for it. */
  async function deliver(t: Team, text: string, withKeeper = true) {
    const sync = createReplySync({
      db: handle.db,
      secretsKey: config.secretsKey,
      logger: { warn: () => undefined, error: () => undefined },
      promiseKeeper: withKeeper ? keeper : undefined,
      readerFor: () => ({
        read: async () => ({
          messages: [{ raw: rawReply({ inReplyTo: t.header, text }) } as RawInbound],
          cursor: { uidValidity: 1, lastUid: 1 },
        }),
      }),
    });
    await sync.syncMailbox(t.workspaceId, t.mailboxId);
    await keeper.idle();
  }

  it("a reply's promise is proposed to the mailbox owner; accept creates the task (idempotent)", async () => {
    const t = await team();
    await deliver(t, "Thanks Sam. I'll check with my boss and get back to you next week.");

    const list = await t.rep.get("/v1/promises").expect(200);
    expect(list.body).toHaveLength(1);
    const p = list.body[0];
    expect(p).toMatchObject({
      kind: "promise_task",
      status: "proposed",
      userId: t.userId,
      contactId: t.contactId,
      type: "their_promise",
      who: "them",
      direction: "inbound",
      taskKind: "follow_up",
      source: "rule",
      taskId: null,
    });
    expect(p.title).toMatch(/^Nudge if nothing arrives: /);
    expect(
      (await t.rep.get(`/v1/promises?contactId=${t.contactId}`).expect(200)).body,
    ).toHaveLength(1);
    expect(
      (await t.rep.get(`/v1/promises?messageId=${p.messageId as string}`).expect(200)).body,
    ).toHaveLength(1);
    // Nothing exists before the click.
    expect((await t.rep.get("/v1/tasks").expect(200)).body).toEqual([]);

    await t.rep.post(`/v1/promises/${p.id as string}/accept`, { dueAt: "next week" }).expect(400);
    await t.rep.post(`/v1/promises/${p.id as string}/accept`, { title: "" }).expect(400);
    const dueAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const accepted = await t.rep
      .post(`/v1/promises/${p.id as string}/accept`, { title: "Nudge Jane", dueAt })
      .expect(200);
    expect(accepted.body.promise).toMatchObject({ status: "accepted", title: "Nudge Jane" });
    expect(accepted.body.task).toMatchObject({
      title: "Nudge Jane",
      dueAt,
      kind: "follow_up",
      source: "promise",
      sourceMessageId: p.messageId,
      promiseId: p.id,
      owner: { id: t.userId },
      contact: { id: t.contactId },
    });
    expect(accepted.body.promise.taskId).toBe(accepted.body.task.id);

    // Accepting again changes nothing and returns the same task.
    const again = await t.rep.post(`/v1/promises/${p.id as string}/accept`, {}).expect(200);
    expect(again.body.task.id).toBe(accepted.body.task.id);
    expect((await t.rep.get("/v1/tasks").expect(200)).body).toHaveLength(1);
    expect((await t.rep.post(`/v1/promises/${p.id as string}/dismiss`).expect(409)).body.code).toBe(
      "invalid_transition",
    );
    expect((await t.rep.get("/v1/promises").expect(200)).body).toEqual([]);
    expect((await t.rep.get("/v1/promises?status=accepted").expect(200)).body).toHaveLength(1);

    const audit = await withTenant(handle.db, { workspaceId: t.workspaceId }, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, "promise.accepted")),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({
      kind: "promise_task",
      editedTitle: true,
      byOwner: true,
    });
    expect(JSON.stringify(audit[0]!.metadata)).not.toMatch(/boss|Jane/);
  });

  it("dismiss is idempotent and final", async () => {
    const t = await team();
    await deliver(t, "Sure, I'll send you our vendor list by Friday.");
    const [p] = (await t.rep.get("/v1/promises").expect(200)).body;
    await t.rep
      .post(`/v1/promises/${p.id as string}/dismiss`, { reason: "x".repeat(501) })
      .expect(400);
    const res = await t.rep
      .post(`/v1/promises/${p.id as string}/dismiss`, { reason: "Not a real promise" })
      .expect(200);
    expect(res.body.status).toBe("dismissed");
    await t.rep.post(`/v1/promises/${p.id as string}/dismiss`).expect(200);
    await t.rep.post(`/v1/promises/${p.id as string}/accept`).expect(409);
    expect((await t.rep.get("/v1/tasks").expect(200)).body).toEqual([]);
    const audit = await withTenant(handle.db, { workspaceId: t.workspaceId }, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, "promise.dismissed")),
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.metadata)).not.toMatch(/real promise/);
  });

  it("other reps can't see or decide; managers can (the task stays the owner's)", async () => {
    const t = await team();
    await deliver(t, "I'll forward this to our IT lead tomorrow.");
    const [p] = (await t.rep.get("/v1/promises").expect(200)).body;
    const id = p.id as string;
    expect((await t.rep2.get("/v1/promises").expect(200)).body).toEqual([]);
    await t.rep2.post(`/v1/promises/${id}/accept`).expect(404);
    await t.rep2.post(`/v1/promises/${id}/dismiss`).expect(404);
    expect((await t.manager.get("/v1/promises").expect(200)).body).toHaveLength(1);
    const res = await t.manager.post(`/v1/promises/${id}/accept`).expect(200);
    expect(res.body.task.owner.id).toBe(t.userId);
    expect(res.body.task.dueDateMissing).toBe(false);
  });

  it("another workspace's promises look like 404; Scout's draft endpoints don't touch them", async () => {
    const t = await team();
    await deliver(t, "I'll send the signed NDA tomorrow.");
    const [p] = (await t.rep.get("/v1/promises").expect(200)).body;
    const { b: other } = await signedUp(app);
    expect((await other.get("/v1/promises").expect(200)).body).toEqual([]);
    await other.post(`/v1/promises/${p.id as string}/accept`).expect(404);
    await other.post(`/v1/promises/${p.id as string}/dismiss`).expect(404);
    await t.rep.post(`/v1/promises/${missingId}/accept`).expect(404);
    await t.rep.post("/v1/promises/not-a-uuid/accept").expect(400);
    await t.rep.get(`/v1/scout/actions/${p.id as string}`).expect(404);
    await t.rep.post(`/v1/scout/actions/${p.id as string}/approve`, {}).expect(404);
    await t.rep.get("/v1/promises?status=maybe").expect(400);
    await browser(app).get("/v1/promises").expect(401);
  });

  it("'reach out in Q2' proposes only a follow_up task on that date — never a pause", async () => {
    const t = await team();
    await deliver(t, "Not now. Please reach out in Q2.");
    const list = (await t.rep.get("/v1/promises").expect(200)).body as {
      kind: string;
      type: string;
      taskKind: string;
      dueAt: string;
    }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      kind: "promise_task",
      type: "their_request",
      taskKind: "follow_up",
    });
    const rows = await withTenant(handle.db, { workspaceId: t.workspaceId }, (tx) =>
      tx.select().from(aiActions).where(eq(aiActions.workspaceId, t.workspaceId)),
    );
    expect(rows.map((r) => r.kind)).toEqual(["promise_task"]);
    // The human reply itself stopped the sequence.
    const [e] = await withTenant(handle.db, { workspaceId: t.workspaceId }, (tx) =>
      tx.select().from(enrollments).where(eq(enrollments.id, t.enrollmentId)),
    );
    expect(e!.state).not.toBe("active");
  });

  it("a legacy pause_enrollments proposal is hidden and can't be accepted (409 unsupported_proposal)", async () => {
    const t = await team();
    await deliver(t, "Thanks, noted.", false);
    const [inbound] = await withTenant(handle.db, { workspaceId: t.workspaceId }, (tx) =>
      tx
        .select()
        .from(messages)
        .where(and(eq(messages.workspaceId, t.workspaceId), eq(messages.direction, "inbound"))),
    );
    const before = await withTenant(handle.db, { workspaceId: t.workspaceId }, async (tx) => {
      const [row] = await tx
        .insert(aiActions)
        .values({
          workspaceId: t.workspaceId,
          userId: t.userId,
          contactId: t.contactId,
          messageId: inbound!.id,
          kind: "pause_enrollments",
          inputSummary: {},
          sources: [{ id: inbound!.id, kind: "message", label: "Email" }],
          model: "rules",
          proposal: {
            body: "Pause sequences until 2027-04-01",
            citations: [],
            promise: {
              type: "their_request",
              who: "them",
              kind: "contact_later",
              what: "Reach out in Q2",
              whenPhrase: "in Q2",
              taskKind: "follow_up",
              dueAt: "2027-04-01T14:00:00.000Z",
              dueDateMissing: false,
              confidence: 0.6,
              source: "rule",
              direction: "inbound",
            },
          },
        })
        .returning();
      const [e] = await tx.select().from(enrollments).where(eq(enrollments.id, t.enrollmentId));
      return { id: row!.id, enrollment: e! };
    });
    expect((await t.rep.get("/v1/promises").expect(200)).body).toEqual([]);
    const res = await t.rep.post(`/v1/promises/${before.id}/accept`).expect(409);
    expect(res.body.code).toBe("unsupported_proposal");
    await t.manager.post(`/v1/promises/${before.id}/accept`).expect(409);
    // Another rep still gets 404, not a hint that it exists.
    await t.rep2.post(`/v1/promises/${before.id}/accept`).expect(404);
    const [after] = await withTenant(handle.db, { workspaceId: t.workspaceId }, (tx) =>
      tx.select().from(enrollments).where(eq(enrollments.id, t.enrollmentId)),
    );
    expect(after).toMatchObject({
      state: before.enrollment.state,
      lastDecision: before.enrollment.lastDecision,
      nextRunAt: before.enrollment.nextRunAt,
    });
    const [row] = await withTenant(handle.db, { workspaceId: t.workspaceId }, (tx) =>
      tx.select().from(aiActions).where(eq(aiActions.id, before.id)),
    );
    expect(row!.status).toBe("proposed");
  });

  it("an inbox reply's own promise is proposed; a later reply in the thread suggests it done", async () => {
    const t = await team();
    await deliver(t, "Can you send pricing for 8 reps?");
    expect((await t.rep.get("/v1/promises").expect(200)).body).toEqual([]);
    const inboxId = (await t.rep.get("/v1/inbox").expect(200)).body.items[0].id as string;

    await t.rep
      .post(`/v1/inbox/${inboxId}/reply`, { body: "Happy to. I'll send the pricing by Friday." })
      .expect(201);
    await keeper.idle();
    const [p] = (await t.rep.get("/v1/promises").expect(200)).body;
    expect(p).toMatchObject({
      type: "our_promise",
      direction: "outbound",
      taskKind: "send_promised",
      title: "Send the pricing by Friday",
    });
    const outbound = await withTenant(handle.db, { workspaceId: t.workspaceId }, (tx) =>
      tx.select().from(aiActions).where(eq(aiActions.id, p.id)),
    );
    expect(outbound[0]!.messageId).not.toBe(inboxId);
    const { body } = await t.rep.post(`/v1/promises/${p.id as string}/accept`).expect(200);
    expect(body.task).toMatchObject({ kind: "send_promised", suggestDoneAt: null });

    await t.rep
      .post(`/v1/inbox/${inboxId}/reply`, { body: "Here is the pricing, attached." })
      .expect(201);
    await keeper.idle();
    const task = (await t.rep.get(`/v1/tasks/${body.task.id as string}`).expect(200)).body;
    expect(task.status).toBe("open");
    expect(task.suggestDoneAt).not.toBeNull();
    const cleared = await t.rep
      .patch(`/v1/tasks/${body.task.id as string}`, { suggestDone: false })
      .expect(200);
    expect(cleared.body.suggestDoneAt).toBeNull();
  });
});
