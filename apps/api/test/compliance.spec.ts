/**
 * OL-E6 Compliance Copilot: "Can I email them?", the proof export, proof on inbox replies, and
 * compliance in the enroll dialog (skip reasons + preview).
 */
import type { NestExpressApplication } from "@nestjs/platform-express";
import { RULESET_VERSION } from "@openline/compliance";
import {
  and,
  auditLog,
  consents,
  contacts,
  enrollments,
  eq,
  messages,
  withTenant,
  type DatabaseHandle,
} from "@openline/db";
import { createReplySync, type RawInbound } from "@openline/replies";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CONFIG, type AppConfig } from "../src/config";
import { DB } from "../src/database/database.module";
import { MailboxesService } from "../src/modules/mailboxes/mailboxes.service";
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
/** Wednesday 2026-11-18 10:00 in New York. */
const WED_10AM_NY = new Date("2026-11-18T15:00:00Z");
const missingId = "00000000-0000-4000-8000-000000000000";

describe("compliance copilot (OL-E6)", () => {
  let app: NestExpressApplication;
  let handle: DatabaseHandle;
  let config: AppConfig;

  beforeAll(async () => {
    app = await createTestApp({ MAIL_TRANSPORT: "capture", OUTREACH_TRANSPORT: "capture" });
    handle = app.get<DatabaseHandle>(DB);
    config = app.get<AppConfig>(CONFIG);
    app.get(MailboxesService).imapVerifier = async () => undefined;
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    await app.close();
  });

  /** Freezes only `Date` (timers keep running) so "now" is a known business hour. */
  const at = (date: Date) => vi.useFakeTimers({ toFake: ["Date"], now: date });

  const workspaceIdOf = async (b: Browser) =>
    (await b.get("/v1/auth/me").expect(200)).body.workspace.id as string;

  async function contact(b: Browser, body: Record<string, unknown>) {
    return (await b.post("/v1/contacts", body).expect(201)).body.id as string;
  }

  async function activeSequence(b: Browser, sendWindow?: object) {
    const seq = await b
      .post("/v1/sequences", {
        name: "Outbound",
        ...(sendWindow ? { sendWindow } : {}),
        steps: [{ delayDays: 0, subject: "Hi {{firstName|there}}", body: "Hello" }],
      })
      .expect(201);
    await b.post(`/v1/sequences/${seq.body.id as string}/status`, { status: "active" }).expect(200);
    return seq.body.id as string;
  }

  // ---------------------------------------------------------------- GET /contacts/:id/compliance

  describe("GET /v1/contacts/:id/compliance", () => {
    it("answers for a US contact with every check, citation and the settings used", async () => {
      const { b } = await verifiedSignup(app);
      await b.patch("/v1/workspace", { mailingAddress: ADDRESS }).expect(200);
      const id = await contact(b, { email: "jane@buyer.com", country: "US" });
      at(WED_10AM_NY);
      const res = await b.get(`/v1/contacts/${id}/compliance?channel=email`).expect(200);
      expect(res.body).toMatchObject({
        contactId: id,
        rulesetVersion: RULESET_VERSION,
        channel: "email",
        decision: "allowed",
        jurisdiction: "US",
        evaluatedAt: WED_10AM_NY.toISOString(),
        settings: {
          timeZone: "America/New_York",
          timeZoneSource: "workspace",
          sendWindowSource: "default",
          sequenceId: null,
          mailingAddressOnFile: true,
        },
      });
      expect(res.body.nextAllowedAt).toBeUndefined();
      expect(res.body.checks.map((c: { rule: string }) => c.rule)).toEqual([
        "suppression",
        "contact_status",
        "consent_ca",
        "basis_eu",
        "sender_identity",
        "unsubscribe_mechanism",
        "send_window",
      ]);
      const identity = res.body.checks.find((c: { rule: string }) => c.rule === "sender_identity");
      expect(identity.citation).toContain("15 U.S.C. 7704(a)(5)");
      // channel defaults to email.
      await b.get(`/v1/contacts/${id}/compliance`).expect(200);
    });

    it("blocks a Canadian contact without consent until consent is recorded", async () => {
      const { b } = await verifiedSignup(app);
      await b.patch("/v1/workspace", { mailingAddress: ADDRESS }).expect(200);
      const id = await contact(b, {
        email: "pat@north.ca",
        country: "CA",
        timeZone: "America/Toronto",
      });
      at(WED_10AM_NY);
      const before = await b.get(`/v1/contacts/${id}/compliance`).expect(200);
      expect(before.body.decision).toBe("blocked");
      const casl = before.body.checks.find((c: { rule: string }) => c.rule === "consent_ca");
      expect(casl).toMatchObject({ outcome: "fail" });
      expect(casl.citation).toContain("CASL s. 6");
      expect(before.body.settings.timeZoneSource).toBe("contact");

      vi.useRealTimers();
      await b
        .put(`/v1/contacts/${id}/consent`, {
          basis: "express",
          source: "Web form",
          obtainedAt: "2026-10-01",
        })
        .expect(200);
      at(WED_10AM_NY);
      const after = await b.get(`/v1/contacts/${id}/compliance`).expect(200);
      expect(after.body.decision).toBe("allowed");
    });

    it("explains a missing postal address and a sequence's send window", async () => {
      const { b } = await verifiedSignup(app);
      const id = await contact(b, { email: "sam@buyer.com" });
      const blocked = await b.get(`/v1/contacts/${id}/compliance`).expect(200);
      expect(blocked.body.decision).toBe("blocked");
      expect(blocked.body.settings.mailingAddressOnFile).toBe(false);

      await b.patch("/v1/workspace", { mailingAddress: ADDRESS }).expect(200);
      const seq = await activeSequence(b, { days: [6], startHour: 10, endHour: 12 });
      at(WED_10AM_NY);
      const res = await b.get(`/v1/contacts/${id}/compliance?sequenceId=${seq}`).expect(200);
      expect(res.body.decision).toBe("not_now");
      expect(res.body.nextAllowedAt).toBe("2026-11-21T15:00:00.000Z"); // Saturday 10:00 NY
      expect(res.body.settings).toMatchObject({
        sendWindowSource: "sequence",
        sequenceId: seq,
        sendWindow: { days: [6], startHour: 10, endHour: 12 },
      });
    });

    it("purpose=reply evaluates what an inbox reply enforces: no send window, archived may be answered", async () => {
      const { b } = await verifiedSignup(app);
      await b.patch("/v1/workspace", { mailingAddress: ADDRESS }).expect(200);
      const ws = await workspaceIdOf(b);
      const id = await contact(b, { email: "late@buyer.com", country: "US" });
      at(new Date("2026-11-19T03:00:00Z")); // Wednesday 22:00 in New York
      const send = await b.get(`/v1/contacts/${id}/compliance`).expect(200);
      expect(send.body.decision).toBe("not_now");
      expect(send.body.settings.purpose).toBe("send");
      const reply = await b.get(`/v1/contacts/${id}/compliance?purpose=reply`).expect(200);
      expect(reply.body.decision).toBe("allowed");
      expect(reply.body.nextAllowedAt).toBeUndefined();
      expect(reply.body.settings.purpose).toBe("reply");
      expect(
        reply.body.checks.find((c: { rule: string }) => c.rule === "send_window").outcome,
      ).toBe("not_applicable");

      await withTenant(handle.db, { workspaceId: ws }, (tx) =>
        tx
          .update(contacts)
          .set({ status: "archived" })
          .where(and(eq(contacts.id, id), eq(contacts.workspaceId, ws))),
      );
      const archived = await b.get(`/v1/contacts/${id}/compliance`).expect(200);
      expect(archived.body.decision).toBe("blocked");
      const archivedReply = await b.get(`/v1/contacts/${id}/compliance?purpose=reply`).expect(200);
      expect(archivedReply.body.decision).toBe("allowed");
      expect(
        archivedReply.body.checks.find((c: { rule: string }) => c.rule === "contact_status")
          .outcome,
      ).toBe("pass");

      await b.get(`/v1/contacts/${id}/compliance?purpose=later`).expect(400);
      const seq = await activeSequence(b);
      await b.get(`/v1/contacts/${id}/compliance?purpose=reply&sequenceId=${seq}`).expect(400);
    });

    it("validates input", async () => {
      const { b } = await verifiedSignup(app);
      const id = await contact(b, { email: "v@buyer.com" });
      const bad = await b.get(`/v1/contacts/${id}/compliance?channel=sms`).expect(400);
      expect(bad.body.code).toBe("validation_error");
      await b.get(`/v1/contacts/${id}/compliance?sequenceId=nope`).expect(400);
      await b.get(`/v1/contacts/not-a-uuid/compliance`).expect(400);
      await b.get(`/v1/contacts/${missingId}/compliance`).expect(404);
      await b.get(`/v1/contacts/${id}/compliance?sequenceId=${missingId}`).expect(404);
    });

    it("reps can ask; other workspaces get 404 (contact and sequence)", async () => {
      const { b } = await verifiedSignup(app);
      const id = await contact(b, { email: "r@buyer.com" });
      const rep = await joinVerifiedAs(app, b, "rep");
      await rep.b.get(`/v1/contacts/${id}/compliance`).expect(200);

      const { b: other } = await verifiedSignup(app);
      const res = await other.get(`/v1/contacts/${id}/compliance`).expect(404);
      expect(res.body.code).toBe("not_found");
      const otherContact = await contact(other, { email: "o@buyer.com" });
      await b.patch("/v1/workspace", { mailingAddress: ADDRESS }).expect(200);
      const seq = await activeSequence(b);
      await other.get(`/v1/contacts/${otherContact}/compliance?sequenceId=${seq}`).expect(404);
      await browserless(`/v1/contacts/${id}/compliance`);
    });
  });

  /** Without a session: 401. */
  async function browserless(url: string) {
    const { default: request } = await import("supertest");
    await request(app.getHttpServer()).get(url).expect(401);
  }

  // ---------------------------------------------------------------- inbox reply proof + export

  /** A contact who got step 1 and replied; returns the inbound message id. */
  async function conversation(b: Browser, email: string) {
    const workspaceId = await workspaceIdOf(b);
    const mailbox = (await b.post("/v1/mailboxes/smtp", { ...SMTP, email: uniqueEmail("mb") }))
      .body as { id: string };
    await b.put(`/v1/mailboxes/${mailbox.id}/imap`, { host: "imap.acme.com", port: 993 });
    await b.patch("/v1/workspace", { mailingAddress: ADDRESS }).expect(200);
    const contactId = await contact(b, { email, firstName: "Jane" });
    const messageId = `<ol.${Math.random().toString(36).slice(2)}@acme.com>`;
    await withTenant(handle.db, { workspaceId }, (tx) =>
      tx.insert(messages).values({
        workspaceId,
        contactId,
        mailboxId: mailbox.id,
        messageIdHeader: messageId,
        subject: "Hi Jane",
        sentAt: new Date(Date.now() - 86_400_000),
      }),
    );
    const raw = Buffer.from(
      [
        `From: Jane <${email}>`,
        "To: rep@acme.com",
        "Subject: Re: Hi Jane",
        "Date: Fri, 13 Nov 2026 16:00:00 +0000",
        `Message-ID: <r${Math.random().toString(36).slice(2)}@buyer.com>`,
        `In-Reply-To: ${messageId}`,
        `References: ${messageId}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Can we talk next week?",
        "",
      ].join("\r\n"),
    );
    const sync = createReplySync({
      db: handle.db,
      secretsKey: config.secretsKey,
      logger: { warn: () => undefined, error: () => undefined },
      readerFor: () => ({
        read: async () => ({
          messages: [{ raw } as RawInbound],
          cursor: { uidValidity: 1, lastUid: 1 },
        }),
      }),
    });
    await sync.syncMailbox(workspaceId, mailbox.id);
    const inbound = (await b.get("/v1/inbox").expect(200)).body.items[0].id as string;
    return { workspaceId, contactId, inbound };
  }

  describe("proof on inbox replies and the compliance record", () => {
    it("an inbox reply stores proof (send window not applicable, no body)", async () => {
      const { b } = await verifiedSignup(app);
      const c = await conversation(b, "jane@buyer.com");
      await b.post(`/v1/inbox/${c.inbound}/reply`, { body: "Sure, Tuesday at 10?" }).expect(201);
      const [reply] = await withTenant(handle.db, { workspaceId: c.workspaceId }, (tx) =>
        tx
          .select()
          .from(messages)
          .where(and(eq(messages.direction, "outbound"), eq(messages.replyToId, c.inbound))),
      );
      const proof = reply!.complianceProof!;
      expect(proof.decision).toBe("allowed");
      expect(proof.checks.find((x) => x.rule === "send_window")?.outcome).toBe("not_applicable");
      expect(JSON.stringify(proof)).not.toContain("Tuesday");
      expect(JSON.stringify(proof)).not.toContain("jane@buyer.com");
    });

    it("managers download the record: consent, suppression, history and every proof", async () => {
      const { b } = await verifiedSignup(app);
      const c = await conversation(b, "pat@buyer.com");
      await b.post(`/v1/inbox/${c.inbound}/reply`, { body: "Thanks!" }).expect(201);
      await b
        .put(`/v1/contacts/${c.contactId}/consent`, {
          basis: "express",
          source: "Web form",
          obtainedAt: "2026-10-01",
        })
        .expect(200);
      await b.post("/v1/suppressions", { value: "@buyer.com", reason: "competitor" });
      const manager = await joinVerifiedAs(app, b, "manager");

      const res = await manager.b.get(`/v1/contacts/${c.contactId}/compliance/record`).expect(200);
      expect(res.headers["content-disposition"]).toBe(
        `attachment; filename="openline-compliance-record-${c.contactId}.json"`,
      );
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(res.headers["cache-control"]).toBe("no-store");
      const record = res.body;
      expect(record).toMatchObject({
        kind: "openline.compliance_record",
        rulesetVersion: RULESET_VERSION,
        contact: { id: c.contactId, email: "pat@buyer.com", consentBasis: "express" },
      });
      expect(record.notice).toContain("not legal advice");
      expect(record.consentRecords).toHaveLength(1);
      expect(record.consentRecords[0]).toMatchObject({ basis: "express", source: "Web form" });
      expect(record.history.map((h: { action: string }) => h.action)).toContain(
        "contact.consent_changed",
      );
      // The suppression was added after the reply: the record shows today's state.
      expect(record.suppression.suppressed).toBe(true);
      expect(record.suppression.entries[0]).toMatchObject({
        scope: "domain",
        reason: "competitor",
      });
      expect(record.currentEvaluation.decision).toBe("blocked");
      // Both outbound emails: the earlier step (sent before proofs existed) and the reply.
      expect(record.messages).toHaveLength(2);
      expect(record.messages[0]).toMatchObject({ subject: "Hi Jane", proof: null });
      expect(record.messages[1]).toMatchObject({ kind: "reply", status: "sent" });
      expect(record.messages[1].proof.decision).toBe("allowed");
      expect(JSON.stringify(record)).not.toContain("Thanks!");

      // Audited, with counts only (no personal data).
      const audits = await withTenant(handle.db, { workspaceId: c.workspaceId }, (tx) =>
        tx
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, "contact.compliance_exported"),
              eq(auditLog.entityId, c.contactId),
            ),
          ),
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]!.metadata).toEqual({ consentRecords: 1, messages: 2 });
    });

    it("reps can't export; other workspaces get 404; bad ids are 400", async () => {
      const { b } = await verifiedSignup(app);
      const id = await contact(b, { email: "x@buyer.com" });
      const rep = await joinVerifiedAs(app, b, "rep");
      const denied = await rep.b.get(`/v1/contacts/${id}/compliance/record`).expect(403);
      expect(denied.body.code).toBe("forbidden");
      await b.get(`/v1/contacts/${id}/compliance/record`).expect(200);
      const { b: other } = await verifiedSignup(app);
      await other.get(`/v1/contacts/${id}/compliance/record`).expect(404);
      await b.get(`/v1/contacts/nope/compliance/record`).expect(400);
      await b.get(`/v1/contacts/${missingId}/compliance/record`).expect(404);
    });
  });

  // ---------------------------------------------------------------- enroll

  describe("enroll skip reasons and preview", () => {
    async function setup() {
      const { b } = await verifiedSignup(app);
      await b.patch("/v1/workspace", { mailingAddress: ADDRESS }).expect(200);
      const mailboxId = (
        await b.post("/v1/mailboxes/smtp", { ...SMTP, email: uniqueEmail("mb") }).expect(201)
      ).body.id as string;
      const sequenceId = await activeSequence(b);
      const ok = await contact(b, { email: "ok@buyer.com", country: "US" });
      const canadian = await contact(b, { email: "pat@north.ca", country: "CA" });
      const blockedDomain = await contact(b, { email: "ceo@blocked.io" });
      await b.post("/v1/suppressions", { value: "@blocked.io", reason: "competitor" }).expect(201);
      return { b, mailboxId, sequenceId, ok, canadian, blockedDomain };
    }

    it("preview lists each contact's decision and first failing check, without enrolling", async () => {
      const s = await setup();
      at(WED_10AM_NY);
      const res = await s.b
        .post(`/v1/sequences/${s.sequenceId}/enroll/preview`, {
          contactIds: [s.ok, s.canadian, s.blockedDomain, missingId],
        })
        .expect(200);
      const byId = new Map(
        (res.body.items as { contactId: string }[]).map((i) => [i.contactId, i]),
      );
      expect(byId.get(s.ok)).toEqual({
        contactId: s.ok,
        enrollable: true,
        compliance: { decision: "allowed" },
      });
      expect(byId.get(s.canadian)).toMatchObject({
        enrollable: false,
        skipReason: "no_consent",
        compliance: { decision: "blocked", check: { rule: "consent_ca", outcome: "fail" } },
      });
      expect(byId.get(s.blockedDomain)).toMatchObject({
        skipReason: "suppressed",
        compliance: { decision: "blocked", check: { rule: "suppression" } },
      });
      expect(byId.get(missingId)).toEqual({
        contactId: missingId,
        enrollable: false,
        skipReason: "not_found",
      });
      expect(res.body.counts).toEqual({ enrollable: 1, skipped: 3, blocked: 2 });

      const listed = await s.b.get(`/v1/sequences/${s.sequenceId}/enrollments`).expect(200);
      expect(listed.body.items).toHaveLength(0);
    });

    it("enroll skips are unchanged and carry the failing rule; already enrolled shows in preview", async () => {
      const s = await setup();
      const res = await s.b
        .post(`/v1/sequences/${s.sequenceId}/enroll`, {
          contactIds: [s.ok, s.canadian, s.blockedDomain],
          mailboxId: s.mailboxId,
        })
        .expect(200);
      expect(res.body.enrolled).toBe(1);
      const reasons = Object.fromEntries(
        (res.body.skipped as { contactId: string; reason: string }[]).map((x) => [
          x.contactId,
          x.reason,
        ]),
      );
      expect(reasons).toEqual({ [s.canadian]: "no_consent", [s.blockedDomain]: "suppressed" });
      const canadian = res.body.skipped.find(
        (x: { contactId: string }) => x.contactId === s.canadian,
      );
      expect(canadian.compliance.check.rule).toBe("consent_ca");
      expect(canadian.compliance.check.citation).toContain("CASL");

      const again = await s.b
        .post(`/v1/sequences/${s.sequenceId}/enroll/preview`, { contactIds: [s.ok] })
        .expect(200);
      expect(again.body.items[0]).toMatchObject({
        enrollable: false,
        skipReason: "already_enrolled",
      });
      // Enrolled rows are untouched by the preview.
      const ws = await workspaceIdOf(s.b);
      const rows = await withTenant(handle.db, { workspaceId: ws }, (tx) =>
        tx.select().from(enrollments).where(eq(enrollments.workspaceId, ws)),
      );
      expect(rows).toHaveLength(1);
    });

    it("preview, enroll and the contact page judge consent by the same (latest) record (QA L7)", async () => {
      const s = await setup();
      const ws = await workspaceIdOf(s.b);
      const day = 86_400_000;
      // Express consent last month, then withdrawn in a newer record.
      await withTenant(handle.db, { workspaceId: ws }, (tx) =>
        tx.insert(consents).values([
          {
            workspaceId: ws,
            contactId: s.canadian,
            basis: "express",
            source: "Web form",
            obtainedAt: new Date(Date.now() - 30 * day),
            createdAt: new Date(Date.now() - 30 * day),
          },
          {
            workspaceId: ws,
            contactId: s.canadian,
            basis: "express",
            source: "Web form",
            obtainedAt: new Date(Date.now() - 2 * day),
            createdAt: new Date(Date.now() - day),
            withdrawnAt: new Date(Date.now() - day),
          },
        ]),
      );
      const page = await s.b.get(`/v1/contacts/${s.canadian}/compliance?channel=email`).expect(200);
      expect(page.body.decision).toBe("blocked");
      const pageCheck = page.body.checks.find((c: { rule: string }) => c.rule === "consent_ca");
      expect(pageCheck.outcome).toBe("fail");

      const preview = await s.b
        .post(`/v1/sequences/${s.sequenceId}/enroll/preview`, { contactIds: [s.canadian] })
        .expect(200);
      expect(preview.body.items[0]).toMatchObject({
        enrollable: false,
        skipReason: "no_consent",
        compliance: {
          decision: "blocked",
          check: { rule: "consent_ca", detail: pageCheck.detail },
        },
      });
      const res = await s.b
        .post(`/v1/sequences/${s.sequenceId}/enroll`, {
          contactIds: [s.canadian],
          mailboxId: s.mailboxId,
        })
        .expect(200);
      expect(res.body).toMatchObject({ enrolled: 0, skipped: [{ reason: "no_consent" }] });
    });

    it("preview validates input, lets reps use it, and hides other workspaces", async () => {
      const s = await setup();
      const url = `/v1/sequences/${s.sequenceId}/enroll/preview`;
      await s.b.post(url, { contactIds: [] }).expect(400);
      await s.b.post(url, { contactIds: ["nope"] }).expect(400);
      await s.b.post(url, {}).expect(400);
      const rep = await joinVerifiedAs(app, s.b, "rep");
      await rep.b.post(url, { contactIds: [s.ok] }).expect(200);

      const { b: other } = await verifiedSignup(app);
      await other.post(url, { contactIds: [s.ok] }).expect(404);
      // Another workspace's contacts look like missing ones.
      const otherSeq = await (async () => {
        await other.patch("/v1/workspace", { mailingAddress: ADDRESS }).expect(200);
        return activeSequence(other);
      })();
      const res = await other
        .post(`/v1/sequences/${otherSeq}/enroll/preview`, { contactIds: [s.ok] })
        .expect(200);
      expect(res.body.items[0]).toEqual({
        contactId: s.ok,
        enrollable: false,
        skipReason: "not_found",
      });
    });
  });
});
