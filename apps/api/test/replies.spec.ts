/**
 * Sprint 4 part A: reply detection settings (IMAP, Gmail incremental consent) and the reply inbox.
 * Replies are fed through the real reply-sync pipeline with a fake mailbox reader.
 */
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  and,
  enrollments,
  eq,
  mailboxes,
  messages,
  suppressions,
  withTenant,
  type DatabaseHandle,
} from "@openline/db";
import { CaptureAdapter, openJson, type MailboxSecret } from "@openline/email";
import { createReplySync, ReadError, type RawInbound } from "@openline/replies";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CONFIG, type AppConfig } from "../src/config";
import { DB } from "../src/database/database.module";
import { MailboxesService } from "../src/modules/mailboxes/mailboxes.service";
import { createOAuthState } from "../src/modules/mailboxes/oauth-state";
import {
  createTestApp,
  joinVerifiedAs,
  uniqueEmail,
  verifiedSignup,
  type Browser,
} from "./helpers";

const ADDRESS = "1 Main St, Jersey City, NJ 07302";
const SMTP = {
  host: "smtp.acme.com",
  port: 587,
  secure: false,
  username: "sender@acme.com",
  password: "app-password-123",
};
const IMAP = { host: "imap.acme.com", port: 993 };
const missingId = "00000000-0000-4000-8000-000000000000";

function rawReply(opts: { from: string; inReplyTo?: string; text: string; id?: string }): Buffer {
  return Buffer.from(
    [
      `From: Jane <${opts.from}>`,
      "To: rep@acme.com",
      "Subject: Re: Hi Jane",
      "Date: Fri, 13 Nov 2026 16:00:00 +0000",
      `Message-ID: ${opts.id ?? `<r${Math.random().toString(36).slice(2)}@buyer.com>`}`,
      ...(opts.inReplyTo
        ? [`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`]
        : []),
      "Content-Type: text/plain; charset=utf-8",
      "",
      opts.text,
      "",
    ].join("\r\n"),
  );
}

describe("replies (Sprint 4)", () => {
  let app: NestExpressApplication;
  let config: AppConfig;
  let handle: DatabaseHandle;
  let mailboxesService: MailboxesService;

  beforeAll(async () => {
    app = await createTestApp({ MAIL_TRANSPORT: "capture", OUTREACH_TRANSPORT: "capture" });
    config = app.get<AppConfig>(CONFIG);
    handle = app.get<DatabaseHandle>(DB);
    mailboxesService = app.get(MailboxesService);
  });
  afterEach(() => {
    mailboxesService.imapVerifier = async () => undefined;
  });
  afterAll(async () => {
    await app.close();
  });

  const workspaceIdOf = async (b: Browser) =>
    (await b.get("/v1/auth/me").expect(200)).body.workspace.id as string;

  async function connectMailbox(b: Browser) {
    const res = await b.post("/v1/mailboxes/smtp", { ...SMTP, email: uniqueEmail("mbox") });
    expect(res.status).toBe(201);
    return res.body as { id: string; email: string };
  }

  /**
   * A mailbox with reply detection on, a contact enrolled in an active sequence and step 1 sent
   * (recorded directly: the test runs on any weekday/hour, so we don't wait for the send window).
   */
  async function outreach(b: Browser, contactEmail = "jane@buyer.com") {
    const workspaceId = await workspaceIdOf(b);
    const mailbox = await connectMailbox(b);
    await b.put(`/v1/mailboxes/${mailbox.id}/imap`, IMAP).expect(200);
    await b.patch("/v1/workspace", { mailingAddress: ADDRESS }).expect(200);
    const seq = await b
      .post("/v1/sequences", {
        name: "Outbound",
        steps: [
          { delayDays: 0, subject: "Hi {{firstName}}", body: "Hello" },
          { delayDays: 3, subject: "Following up", body: "Any thoughts?" },
        ],
      })
      .expect(201);
    await b.post(`/v1/sequences/${seq.body.id as string}/status`, { status: "active" }).expect(200);
    const contact = await b
      .post("/v1/contacts", { email: contactEmail, firstName: "Jane" })
      .expect(201);
    const contactId = contact.body.id as string;
    await b
      .post(`/v1/sequences/${seq.body.id as string}/enroll`, {
        contactIds: [contactId],
        mailboxId: mailbox.id,
      })
      .expect(200);
    const messageId = `<ol.${Math.random().toString(36).slice(2)}@acme.com>`;
    const enrollmentId = await withTenant(handle.db, { workspaceId }, async (tx) => {
      const [e] = await tx.select().from(enrollments).where(eq(enrollments.contactId, contactId));
      await tx.insert(messages).values({
        workspaceId,
        enrollmentId: e!.id,
        contactId,
        mailboxId: mailbox.id,
        stepPosition: 1,
        messageIdHeader: messageId,
        subject: "Hi Jane",
        sentAt: new Date(Date.now() - 86_400_000),
      });
      await tx
        .update(enrollments)
        .set({ nextPosition: 2, nextRunAt: new Date(Date.now() + 86_400_000) })
        .where(eq(enrollments.id, e!.id));
      return e!.id;
    });
    return { workspaceId, mailbox, contactId, enrollmentId, messageId, sequenceId: seq.body.id };
  }

  /** Runs reply sync for one mailbox with these messages in its inbox. */
  async function deliver(workspaceId: string, mailboxId: string, raws: Buffer[]) {
    const sync = createReplySync({
      db: handle.db,
      secretsKey: config.secretsKey,
      logger: { warn: () => undefined, error: () => undefined },
      readerFor: () => ({
        read: async () => ({
          messages: raws.map((raw): RawInbound => ({ raw })),
          cursor: { uidValidity: 1, lastUid: raws.length },
        }),
      }),
    });
    return sync.syncMailbox(workspaceId, mailboxId);
  }

  // ---------------------------------------------------------------- IMAP settings

  describe("PUT/DELETE /mailboxes/:id/imap", () => {
    it("verifies the login, keeps the password sealed, and turns reply detection on", async () => {
      const { b } = await verifiedSignup(app);
      const workspaceId = await workspaceIdOf(b);
      const mailbox = await connectMailbox(b);
      expect((await b.get("/v1/mailboxes").expect(200)).body[0]).toMatchObject({
        replyDetection: "off",
        lastSyncedAt: null,
        lastSyncError: null,
      });

      const verified: unknown[] = [];
      mailboxesService.imapVerifier = async (s) => {
        verified.push(s);
      };
      const res = await b
        .put(`/v1/mailboxes/${mailbox.id}/imap`, {
          ...IMAP,
          username: "imap-user",
          password: "imap-secret",
        })
        .expect(200);
      expect(res.body).toMatchObject({ id: mailbox.id, replyDetection: "on" });
      expect(JSON.stringify(res.body)).not.toMatch(/imap-secret|imap\.acme\.com/);
      expect(verified[0]).toMatchObject({
        host: "imap.acme.com",
        port: 993,
        username: "imap-user",
        password: "imap-secret",
      });

      const row = await withTenant(handle.db, { workspaceId }, async (tx) => {
        const [m] = await tx.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id));
        return m!;
      });
      expect(row).toMatchObject({ imapHost: "imap.acme.com", imapPort: 993, imapSecure: true });
      expect(row.secretSealed).not.toContain("imap-secret");
      const secret = openJson<MailboxSecret>(row.secretSealed, config.secretsKey, workspaceId);
      expect(secret).toMatchObject({
        kind: "smtp",
        username: SMTP.username,
        imap: { username: "imap-user", password: "imap-secret" },
      });

      // Same login as SMTP by default.
      await b.put(`/v1/mailboxes/${mailbox.id}/imap`, { ...IMAP, port: 143 }).expect(200);
      expect(verified[1]).toMatchObject({ port: 143, username: SMTP.username });

      const off = await b.delete(`/v1/mailboxes/${mailbox.id}/imap`).expect(200);
      expect(off.body.replyDetection).toBe("off");
      const cleared = await withTenant(handle.db, { workspaceId }, async (tx) => {
        const [m] = await tx.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id));
        return m!;
      });
      expect(cleared.imapHost).toBeNull();
      expect(openJson<MailboxSecret>(cleared.secretSealed, config.secretsKey, workspaceId)).toEqual(
        { kind: "smtp", username: SMTP.username, password: SMTP.password },
      );
    });

    it("maps login failures to imap_auth_failed / imap_unreachable and saves nothing", async () => {
      const { b } = await verifiedSignup(app);
      const mailbox = await connectMailbox(b);
      mailboxesService.imapVerifier = async () => {
        throw new ReadError("nope", "auth");
      };
      const auth = await b.put(`/v1/mailboxes/${mailbox.id}/imap`, IMAP).expect(400);
      expect(auth.body.code).toBe("imap_auth_failed");
      mailboxesService.imapVerifier = async () => {
        throw new ReadError("refused", "unreachable");
      };
      const down = await b.put(`/v1/mailboxes/${mailbox.id}/imap`, IMAP).expect(400);
      expect(down.body.code).toBe("imap_unreachable");
      expect((await b.get("/v1/mailboxes").expect(200)).body[0].replyDetection).toBe("off");
    });

    it("refuses private IMAP addresses outside development (SSRF) with the real verifier", async () => {
      const { b } = await verifiedSignup(app);
      const mailbox = await connectMailbox(b);
      const { verifyImapLogin } = await import("@openline/replies");
      mailboxesService.imapVerifier = (s) => verifyImapLogin({ ...s, allowPrivate: false });
      const res = await b
        .put(`/v1/mailboxes/${mailbox.id}/imap`, { host: "localhost", port: 993 })
        .expect(400);
      expect(res.body.code).toBe("imap_unreachable");
    });

    it("an admin can't send a rep's SMTP login to an IMAP host on another domain (S1)", async () => {
      const { b: owner } = await verifiedSignup(app);
      const { b: rep } = await joinVerifiedAs(app, owner, "rep");
      const { b: admin } = await joinVerifiedAs(app, owner, "admin");
      const mailbox = await connectMailbox(rep);
      const seen: { host: string; username: string; password: string }[] = [];
      mailboxesService.imapVerifier = async (s) => {
        seen.push({ host: s.host, username: s.username, password: s.password });
      };
      const refused = await admin
        .put(`/v1/mailboxes/${mailbox.id}/imap`, { host: "imap.evil.example", port: 993 })
        .expect(400);
      expect(refused.body.code).toBe("imap_credentials_required");
      expect(seen).toHaveLength(0);

      // With its own login, or on the SMTP server's domain, it's fine.
      await admin
        .put(`/v1/mailboxes/${mailbox.id}/imap`, {
          host: "imap.evil.example",
          port: 993,
          username: "imap-user",
          password: "imap-secret",
        })
        .expect(200);
      await admin.put(`/v1/mailboxes/${mailbox.id}/imap`, IMAP).expect(200);
      expect(seen.map((s) => [s.host, s.password])).toEqual([
        ["imap.evil.example", "imap-secret"],
        ["imap.acme.com", SMTP.password],
      ]);
      // The mailbox's owner may reuse their own login anywhere.
      await rep
        .put(`/v1/mailboxes/${mailbox.id}/imap`, { host: "mail.other-host.net", port: 993 })
        .expect(200);
    });

    it("validates input, applies mailbox permissions and hides other workspaces", async () => {
      const { b: owner } = await verifiedSignup(app);
      const mailbox = await connectMailbox(owner);
      const bad = await owner
        .put(`/v1/mailboxes/${mailbox.id}/imap`, { host: "imap.acme.com", port: 25 })
        .expect(400);
      expect(bad.body.code).toBe("validation_error");
      await owner
        .put(`/v1/mailboxes/${mailbox.id}/imap`, { ...IMAP, username: "only-user" })
        .expect(400);

      const { b: rep } = await joinVerifiedAs(app, owner, "rep");
      expect((await rep.put(`/v1/mailboxes/${mailbox.id}/imap`, IMAP).expect(403)).body.code).toBe(
        "forbidden",
      );
      await rep.delete(`/v1/mailboxes/${mailbox.id}/imap`).expect(403);

      const { b: stranger } = await verifiedSignup(app);
      await stranger.put(`/v1/mailboxes/${mailbox.id}/imap`, IMAP).expect(404);
      await stranger.delete(`/v1/mailboxes/${mailbox.id}/imap`).expect(404);
      await owner.put(`/v1/mailboxes/${missingId}/imap`, IMAP).expect(404);
    });
  });

  // ---------------------------------------------------------------- inbox

  describe("inbox", () => {
    it("a detected reply stops the sequence and shows in the inbox as plain text", async () => {
      const { b } = await verifiedSignup(app);
      const o = await outreach(b);
      const summary = await deliver(o.workspaceId, o.mailbox.id, [
        rawReply({
          from: "jane@buyer.com",
          inReplyTo: o.messageId,
          text: "Interesting <script>alert(1)</script> - can we talk?\n\nOn Tue, Rep wrote:\n> Hello",
        }),
      ]);
      expect(summary.stored).toBe(1);

      const [enrollment] = (await b.get(`/v1/contacts/${o.contactId}/enrollments`).expect(200))
        .body;
      expect(enrollment).toMatchObject({ state: "replied", lastDecision: "reply_received" });

      const page = await b.get("/v1/inbox").expect(200);
      expect(page.body.items).toHaveLength(1);
      const item = page.body.items[0];
      expect(item).toMatchObject({
        from: { email: "jane@buyer.com", name: "Jane" },
        contact: { id: o.contactId, email: "jane@buyer.com" },
        mailbox: { id: o.mailbox.id },
        sequence: { id: o.sequenceId, name: "Outbound" },
        stepPosition: 1,
        label: "other",
        labelSource: "rule",
        matchedBy: "thread",
        needsAction: true,
      });
      expect(item.snippet).toContain("can we talk?");

      const detail = await b.get(`/v1/inbox/${item.id as string}`).expect(200);
      expect(detail.headers["content-type"]).toMatch(/application\/json/);
      expect(detail.body.text).toBe("Interesting <script>alert(1)</script> - can we talk?");
      expect(detail.body.original).toMatchObject({ subject: "Hi Jane", stepPosition: 1 });
      expect(detail.body.enrollment).toMatchObject({ id: o.enrollmentId, state: "replied" });

      const counts = await b.get("/v1/inbox/counts").expect(200);
      expect(counts.body.needsAction).toBe(1);
      expect(counts.body.byLabel.other).toBe(1);

      // The contact's timeline marks the reply as inbound.
      const timeline = (await b.get(`/v1/contacts/${o.contactId}/messages`).expect(200)).body;
      expect(timeline.map((m: { direction: string }) => m.direction).sort()).toEqual([
        "inbound",
        "outbound",
      ]);
    });

    it("filters, paginates, relabels and marks handled", async () => {
      const { b } = await verifiedSignup(app);
      const o = await outreach(b);
      await deliver(o.workspaceId, o.mailbox.id, [
        rawReply({ from: "jane@buyer.com", inReplyTo: o.messageId, text: "Tell me more" }),
        rawReply({ from: "jane@buyer.com", inReplyTo: o.messageId, text: "Not interested." }),
        rawReply({ from: "jane@buyer.com", inReplyTo: o.messageId, text: "Also: pricing?" }),
      ]);
      // Default "needs action" hides not_interested.
      expect((await b.get("/v1/inbox").expect(200)).body.items).toHaveLength(2);
      const all = await b.get("/v1/inbox?needsAction=false&limit=2").expect(200);
      expect(all.body.items).toHaveLength(2);
      const next = await b
        .get(`/v1/inbox?needsAction=false&limit=2&cursor=${all.body.nextCursor as string}`)
        .expect(200);
      expect(next.body.items).toHaveLength(1);
      expect(next.body.nextCursor).toBeNull();
      const notInterested = await b.get("/v1/inbox?label=not_interested").expect(200);
      expect(notInterested.body.items).toHaveLength(1);
      await b.get("/v1/inbox?label=nope").expect(400);
      await b.get("/v1/inbox?cursor=garbage").expect(400);

      const id = (await b.get("/v1/inbox").expect(200)).body.items[0].id as string;
      const relabelled = await b.patch(`/v1/inbox/${id}`, { label: "interested" }).expect(200);
      expect(relabelled.body).toMatchObject({
        label: "interested",
        labelSource: "user",
        labelConfidence: null,
      });
      const handled = await b.patch(`/v1/inbox/${id}`, { handled: true }).expect(200);
      expect(handled.body.needsAction).toBe(false);
      expect(handled.body.handledAt).not.toBeNull();
      expect((await b.get("/v1/inbox/counts").expect(200)).body.needsAction).toBe(1);
      await b.patch(`/v1/inbox/${id}`, {}).expect(400);
    });

    it("relabelling as unsubscribe suppresses the contact (and relabelling back doesn't undo it)", async () => {
      const { b } = await verifiedSignup(app);
      const o = await outreach(b);
      await deliver(o.workspaceId, o.mailbox.id, [
        rawReply({ from: "jane@buyer.com", inReplyTo: o.messageId, text: "Hmm, ok." }),
      ]);
      const id = (await b.get("/v1/inbox").expect(200)).body.items[0].id as string;
      await b.patch(`/v1/inbox/${id}`, { label: "unsubscribe" }).expect(200);
      await b.patch(`/v1/inbox/${id}`, { label: "other" }).expect(200);
      const rows = await withTenant(handle.db, { workspaceId: o.workspaceId }, (tx) =>
        tx.select().from(suppressions).where(eq(suppressions.value, "jane@buyer.com")),
      );
      expect(rows).toHaveLength(1);
      expect((await b.get(`/v1/contacts/${o.contactId}`).expect(200)).body.status).toBe(
        "unsubscribed",
      );
    });

    it("replies in the thread from the same mailbox, with the compliance footer", async () => {
      const { b } = await verifiedSignup(app);
      const o = await outreach(b);
      await deliver(o.workspaceId, o.mailbox.id, [
        rawReply({
          from: "jane@buyer.com",
          inReplyTo: o.messageId,
          id: "<jane-1@buyer.com>",
          text: "Can we talk?",
        }),
      ]);
      const id = (await b.get("/v1/inbox").expect(200)).body.items[0].id as string;
      CaptureAdapter.outbox.length = 0;
      await b.post(`/v1/inbox/${id}/reply`, { body: "" }).expect(400);
      const res = await b
        .post(`/v1/inbox/${id}/reply`, { body: "Sure — Tuesday at 10?" })
        .expect(201);
      expect(res.body.replies).toHaveLength(1);
      expect(res.body.replies[0]).toMatchObject({ subject: "Re: Hi Jane", status: "sent" });
      expect(res.body.handledAt).not.toBeNull();

      const [sent] = CaptureAdapter.outbox;
      expect(sent).toMatchObject({
        from: { email: o.mailbox.email },
        to: "jane@buyer.com",
        subject: "Re: Hi Jane",
        inReplyTo: "<jane-1@buyer.com>",
      });
      expect(sent!.references).toContain(o.messageId);
      expect(sent!.references).toContain("<jane-1@buyer.com>");
      expect(sent!.text).toContain(ADDRESS);
      expect(sent!.headers["List-Unsubscribe"]).toBeTruthy();

      // The 1:1 reply is not a sequence step: it never reopens or advances the enrollment.
      const outbound = await withTenant(handle.db, { workspaceId: o.workspaceId }, (tx) =>
        tx
          .select()
          .from(messages)
          .where(and(eq(messages.direction, "outbound"), eq(messages.replyToId, id))),
      );
      expect(outbound[0]).toMatchObject({ stepPosition: null, enrollmentId: null, status: "sent" });
    });

    it("refuses to reply to a suppressed address", async () => {
      const { b } = await verifiedSignup(app);
      const o = await outreach(b);
      await deliver(o.workspaceId, o.mailbox.id, [
        rawReply({ from: "jane@buyer.com", inReplyTo: o.messageId, text: "Please remove me" }),
      ]);
      const page = await b.get("/v1/inbox?label=unsubscribe").expect(200);
      const res = await b
        .post(`/v1/inbox/${page.body.items[0].id as string}/reply`, { body: "Sorry!" })
        .expect(409);
      expect(["unsubscribed", "suppressed"]).toContain(res.body.code);
    });

    it("refuses to reply to a colleague who asked to be removed, though the contact isn't (M6)", async () => {
      const { b } = await verifiedSignup(app);
      const o = await outreach(b);
      await deliver(o.workspaceId, o.mailbox.id, [
        rawReply({ from: "bob@buyer.com", inReplyTo: o.messageId, text: "Please remove me" }),
      ]);
      const page = await b.get("/v1/inbox?label=unsubscribe").expect(200);
      expect(page.body.items).toHaveLength(1);
      CaptureAdapter.outbox.length = 0;
      const res = await b
        .post(`/v1/inbox/${page.body.items[0].id as string}/reply`, { body: "Sorry!" })
        .expect(409);
      expect(res.body.code).toBe("suppressed");
      expect(CaptureAdapter.outbox).toHaveLength(0);
    });

    it("never replies to a bounce report or an auto-reply (409 reply_not_allowed, M6)", async () => {
      const { b } = await verifiedSignup(app);
      const o = await outreach(b);
      const bounce = Buffer.from(
        [
          "From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
          "To: rep@acme.com",
          "Subject: Delivery Status Notification (Failure)",
          "Date: Fri, 13 Nov 2026 16:00:00 +0000",
          "Message-ID: <dsn-m6@googlemail.com>",
          "MIME-Version: 1.0",
          'Content-Type: multipart/report; report-type=delivery-status; boundary="r1"',
          "",
          "--r1",
          "Content-Type: text/plain",
          "",
          "Not delivered.",
          "--r1",
          "Content-Type: message/delivery-status",
          "",
          "Reporting-MTA: dns; googlemail.com",
          "",
          "Final-Recipient: rfc822; jane@buyer.com",
          "Action: failed",
          "Status: 5.1.1",
          "--r1",
          "Content-Type: text/rfc822-headers",
          "",
          `Message-ID: ${o.messageId}`,
          "--r1--",
          "",
        ].join("\r\n"),
      );
      const autoReply = Buffer.from(
        rawReply({ from: "jane@buyer.com", inReplyTo: o.messageId, text: "Ticket received." })
          .toString()
          .replace("Subject:", "Auto-Submitted: auto-generated\r\nSubject:"),
      );
      await deliver(o.workspaceId, o.mailbox.id, [bounce, autoReply]);
      const items = (await b.get("/v1/inbox?needsAction=false").expect(200)).body.items as {
        id: string;
        label: string;
      }[];
      expect(items).toHaveLength(2);
      CaptureAdapter.outbox.length = 0;
      for (const item of items) {
        const res = await b.post(`/v1/inbox/${item.id}/reply`, { body: "Hello?" }).expect(409);
        expect(res.body.code).toBe("reply_not_allowed");
      }
      expect(CaptureAdapter.outbox).toHaveLength(0);
    });

    it("reps see only their own mailboxes' replies; managers see all; other workspaces get 404", async () => {
      const { b: owner } = await verifiedSignup(app);
      const o = await outreach(owner);
      await deliver(o.workspaceId, o.mailbox.id, [
        rawReply({ from: "jane@buyer.com", inReplyTo: o.messageId, text: "Yes please" }),
      ]);
      const id = (await owner.get("/v1/inbox").expect(200)).body.items[0].id as string;

      const { b: rep } = await joinVerifiedAs(app, owner, "rep");
      expect((await rep.get("/v1/inbox").expect(200)).body.items).toHaveLength(0);
      expect((await rep.get("/v1/inbox/counts").expect(200)).body.needsAction).toBe(0);
      await rep.get(`/v1/inbox/${id}`).expect(404);
      await rep.patch(`/v1/inbox/${id}`, { handled: true }).expect(404);
      await rep.post(`/v1/inbox/${id}/reply`, { body: "hi" }).expect(404);

      const { b: manager } = await joinVerifiedAs(app, owner, "manager");
      expect((await manager.get("/v1/inbox").expect(200)).body.items).toHaveLength(1);
      await manager.get(`/v1/inbox/${id}`).expect(200);

      const { b: stranger } = await verifiedSignup(app);
      expect((await stranger.get("/v1/inbox").expect(200)).body.items).toHaveLength(0);
      await stranger.get(`/v1/inbox/${id}`).expect(404);
      await stranger.patch(`/v1/inbox/${id}`, { handled: true }).expect(404);
      await stranger.post(`/v1/inbox/${id}/reply`, { body: "hi" }).expect(404);

      // An outbound message id is not an inbox item either.
      const [outboundRow] = await withTenant(handle.db, { workspaceId: o.workspaceId }, (tx) =>
        tx.select().from(messages).where(eq(messages.messageIdHeader, o.messageId)),
      );
      await owner.get(`/v1/inbox/${outboundRow!.id}`).expect(404);
      await owner.get("/v1/inbox/not-a-uuid").expect(400);
    });
  });

  // ---------------------------------------------------------------- Gmail consent

  describe("Gmail reply detection (incremental consent)", () => {
    const GOOGLE_ENV = {
      GOOGLE_OAUTH_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
      GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
    };
    let gapp: NestExpressApplication;
    let gconfig: AppConfig;

    beforeAll(async () => {
      gapp = await createTestApp({ ...GOOGLE_ENV, OUTREACH_TRANSPORT: "capture" });
      gconfig = gapp.get<AppConfig>(CONFIG);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });
    afterAll(async () => {
      await gapp.close();
      for (const key of Object.keys(GOOGLE_ENV)) delete process.env[key];
    });

    function fakeGoogle(email: string, scope: string) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.startsWith("https://oauth2.googleapis.com/token")) {
            return Response.json({ access_token: "a", refresh_token: `rt-${scope.length}`, scope });
          }
          return Response.json({ email, email_verified: true });
        }),
      );
    }
    const SEND = "https://www.googleapis.com/auth/gmail.send openid";
    const READ = `${SEND} https://www.googleapis.com/auth/gmail.readonly`;

    async function gmailMailbox() {
      const { b, email } = await verifiedSignup(gapp);
      const me = (await b.get("/v1/auth/me").expect(200)).body;
      fakeGoogle(email, SEND);
      const state = createOAuthState(
        { workspaceId: me.workspace.id, userId: me.user.id },
        gconfig.UNSUBSCRIBE_SECRET,
      );
      await b.get(`/v1/mailboxes/google/callback?code=c&state=${state}`).expect(302);
      const [mailbox] = (await b.get("/v1/mailboxes").expect(200)).body;
      return { b, email, me, mailbox };
    }

    it("redirects to Google asking for gmail.readonly on top of what was granted", async () => {
      const { b, email, mailbox } = await gmailMailbox();
      expect(mailbox.replyDetection).toBe("off");
      const res = await b
        .get(`/v1/mailboxes/${mailbox.id as string}/google/reply-detection`)
        .expect(302);
      const url = new URL(res.headers.location as string);
      expect(url.hostname).toBe("accounts.google.com");
      expect(url.searchParams.get("scope")).toContain(
        "https://www.googleapis.com/auth/gmail.readonly",
      );
      expect(url.searchParams.get("include_granted_scopes")).toBe("true");
      expect(url.searchParams.get("login_hint")).toBe(email);

      // The callback with read access stores the new token and turns reply detection on.
      fakeGoogle(email, READ);
      const done = await b
        .get(
          `/v1/mailboxes/google/callback?code=c2&state=${encodeURIComponent(url.searchParams.get("state")!)}`,
        )
        .expect(302);
      expect(done.headers.location).toMatch(/reply_detection=on$/);
      expect((await b.get("/v1/mailboxes").expect(200)).body[0].replyDetection).toBe("on");
    });

    it("declined read access or the wrong Google account leaves it off", async () => {
      const { b, email, me, mailbox } = await gmailMailbox();
      const state = createOAuthState(
        { workspaceId: me.workspace.id, userId: me.user.id, mailboxId: mailbox.id },
        gconfig.UNSUBSCRIBE_SECRET,
      );
      fakeGoogle(email, SEND);
      const denied = await b.get(`/v1/mailboxes/google/callback?code=c&state=${state}`).expect(302);
      expect(denied.headers.location).toMatch(/error=reply_access_denied/);
      fakeGoogle("someone-else@gmail.com", READ);
      const wrong = await b.get(`/v1/mailboxes/google/callback?code=c&state=${state}`).expect(302);
      expect(wrong.headers.location).toMatch(/error=wrong_google_account/);
      expect((await b.get("/v1/mailboxes").expect(200)).body[0].replyDetection).toBe("off");
    });

    it("only the owner of a Gmail mailbox can start it; SMTP mailboxes get 409", async () => {
      const { b: owner, mailbox } = await gmailMailbox();
      const { b: admin } = await joinVerifiedAs(gapp, owner, "admin");
      await admin.get(`/v1/mailboxes/${mailbox.id as string}/google/reply-detection`).expect(403);
      const { b: stranger } = await verifiedSignup(gapp);
      await stranger
        .get(`/v1/mailboxes/${mailbox.id as string}/google/reply-detection`)
        .expect(404);

      const smtp = await owner
        .post("/v1/mailboxes/smtp", { ...SMTP, email: uniqueEmail("smtp") })
        .expect(201);
      const res = await owner
        .get(`/v1/mailboxes/${smtp.body.id as string}/google/reply-detection`)
        .expect(409);
      expect(res.body.code).toBe("reply_detection_unavailable");
      const imapOnGmail = await owner
        .put(`/v1/mailboxes/${mailbox.id as string}/imap`, IMAP)
        .expect(409);
      expect(imapOnGmail.body.code).toBe("reply_detection_unavailable");
    });
  });
});
