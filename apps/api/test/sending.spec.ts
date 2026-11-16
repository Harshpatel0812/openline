/**
 * Sprint 3: account emails, workspace settings, mailboxes, sequences, enrollments, consent
 * records and public unsubscribe. Emails are captured in memory (CaptureAdapter.outbox).
 */
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  and,
  consents,
  eq,
  mailboxes,
  messages,
  withTenant,
  type DatabaseHandle,
} from "@openline/db";
import { createUnsubscribeToken, openJson, type MailboxSecret } from "@openline/email";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONFIG, type AppConfig } from "../src/config";
import { DB } from "../src/database/database.module";
import { AuthService } from "../src/modules/auth/auth.service";
import { safeDisplayText } from "../src/modules/mail/transactional-mail.service";
import {
  browser,
  createTestApp,
  joinAs,
  joinVerifiedAs,
  PASSWORD,
  sentTo,
  signedUp,
  tokenFromEmail,
  uniqueEmail,
  verifiedSignup,
  type Browser,
} from "./helpers";

const ADDRESS = "100 King St W, Toronto, ON M5X 1A9, Canada";
const SMTP = {
  host: "smtp.acme.com",
  port: 587,
  secure: false,
  username: "sender@acme.com",
  password: "app-password-123",
};
const STEPS = [
  { delayDays: 0, subject: "Hi {{firstName|there}}", body: "Hello {{firstName}} at {{company}}." },
  { delayDays: 3, subject: "Following up", body: "Any thoughts, {{firstName|there}}?" },
];
const missingId = "00000000-0000-4000-8000-000000000000";

describe("sending (Sprint 3)", () => {
  let app: NestExpressApplication;
  let config: AppConfig;
  let handle: DatabaseHandle;

  beforeAll(async () => {
    app = await createTestApp({ MAIL_TRANSPORT: "capture", OUTREACH_TRANSPORT: "capture" });
    config = app.get<AppConfig>(CONFIG);
    handle = app.get<DatabaseHandle>(DB);
  });
  afterAll(async () => {
    await app.close();
  });

  const workspaceIdOf = async (b: Browser) =>
    (await b.get("/v1/auth/me").expect(200)).body.workspace.id as string;

  async function connectMailbox(b: Browser, email = uniqueEmail("mbox")) {
    const res = await b.post("/v1/mailboxes/smtp", { ...SMTP, email }).expect(201);
    return res.body.id as string;
  }

  async function activeSequence(b: Browser) {
    await b.patch("/v1/workspace", { mailingAddress: ADDRESS }).expect(200);
    const seq = await b.post("/v1/sequences", { name: "Outbound", steps: STEPS }).expect(201);
    await b.post(`/v1/sequences/${seq.body.id as string}/status`, { status: "active" }).expect(200);
    return seq.body.id as string;
  }

  async function contact(b: Browser, body: Record<string, unknown>) {
    return (await b.post("/v1/contacts", body).expect(201)).body.id as string;
  }

  /** A verified owner with mailing address, a mailbox and an active sequence. */
  async function sender() {
    const { b, email } = await verifiedSignup(app);
    const mailboxId = await connectMailbox(b);
    const sequenceId = await activeSequence(b);
    return { b, email, mailboxId, sequenceId, workspaceId: await workspaceIdOf(b) };
  }

  // ---------------------------------------------------------------- account emails

  describe("account emails", () => {
    it("the verification email never contains the sign-up name (unverified recipient)", async () => {
      const { email } = await signedUp(app, { name: "Visit https://evil.example now" });
      const [mail] = sentTo(email);
      expect(mail?.text).toMatch(/^Hello,/);
      for (const body of [mail?.text, mail?.html, mail?.subject]) {
        expect(body).not.toContain("evil.example");
        expect(body).not.toContain("Visit");
      }
    });

    it("sign-up emails a verification link; verifying flips emailVerified", async () => {
      const { b, email } = await signedUp(app, { name: "Vera" });
      expect((await b.get("/v1/auth/me").expect(200)).body.user.emailVerified).toBe(false);
      const [mail] = sentTo(email);
      expect(mail?.subject).toMatch(/confirm/i);
      expect(mail?.from.email).toBe("no-reply@openline.local");
      expect(mail?.html).toContain("/verify-email?token=");

      const token = tokenFromEmail(email, "/verify-email");
      await browser(app).post("/v1/auth/verify-email", { token }).expect(200);
      expect((await b.get("/v1/auth/me").expect(200)).body.user.emailVerified).toBe(true);

      // Single use.
      const again = await browser(app).post("/v1/auth/verify-email", { token }).expect(410);
      expect(again.body.code).toBe("token_invalid");
    });

    it("an unknown verification token is 410 token_invalid", async () => {
      const res = await browser(app)
        .post("/v1/auth/verify-email", { token: "x".repeat(43) })
        .expect(410);
      expect(res.body.code).toBe("token_invalid");
    });

    it("resend-verification sends a new link (old one dies) and is limited to 5 per hour", async () => {
      const { b, email } = await signedUp(app);
      const first = tokenFromEmail(email, "/verify-email");
      await b.post("/v1/auth/resend-verification").expect(200);
      const second = tokenFromEmail(email, "/verify-email");
      expect(second).not.toBe(first);
      await browser(app).post("/v1/auth/verify-email", { token: first }).expect(410);

      for (let i = 0; i < 4; i += 1) await b.post("/v1/auth/resend-verification").expect(200);
      const limited = await b.post("/v1/auth/resend-verification").expect(429);
      expect(limited.body.code).toBe("rate_limited");

      await browser(app).post("/v1/auth/resend-verification").expect(401);
    });

    it("forgot-password answers 200 for unknown emails and sends nothing", async () => {
      const email = uniqueEmail("nobody");
      const res = await browser(app).post("/v1/auth/forgot-password", { email }).expect(200);
      expect(res.body).toEqual({ ok: true });
      expect(sentTo(email)).toHaveLength(0);
      await browser(app).post("/v1/auth/forgot-password", { email: "nope" }).expect(400);
    });

    it("reset-password changes the password, ends every session and is single use", async () => {
      const { b, email } = await signedUp(app);
      const other = browser(app);
      await other.post("/v1/auth/login", { email, password: PASSWORD }).expect(200);

      const res = await browser(app).post("/v1/auth/forgot-password", { email }).expect(200);
      expect(res.body).toEqual({ ok: true });
      await app.get(AuthService).settled();
      const token = tokenFromEmail(email, "/reset-password");

      const newPassword = "a brand new long passphrase";
      await browser(app)
        .post("/v1/auth/reset-password", { token, password: newPassword })
        .expect(200);
      await b.get("/v1/auth/me").expect(401);
      await other.get("/v1/auth/me").expect(401);

      const reused = await browser(app)
        .post("/v1/auth/reset-password", { token, password: "yet another passphrase!" })
        .expect(410);
      expect(reused.body.code).toBe("token_invalid");

      await browser(app).post("/v1/auth/login", { email, password: PASSWORD }).expect(401);
      const fresh = browser(app);
      await fresh.post("/v1/auth/login", { email, password: newPassword }).expect(200);
      // The emailed link proves the address too.
      expect((await fresh.get("/v1/auth/me").expect(200)).body.user.emailVerified).toBe(true);
    });

    it("forgot-password issues the token and email in the background for a known email", async () => {
      const { email } = await signedUp(app);
      const auth = app.get(AuthService);
      await auth.settled();
      const before = sentTo(email).length;
      await browser(app).post("/v1/auth/forgot-password", { email }).expect(200);
      await auth.settled();
      expect(sentTo(email)).toHaveLength(before + 1);
      expect(tokenFromEmail(email, "/reset-password")).toBeTruthy();
    });

    it("forgot-password is rate-limited per email", async () => {
      const { email } = await signedUp(app);
      for (let i = 0; i < 5; i += 1) {
        await browser(app).post("/v1/auth/forgot-password", { email }).expect(200);
      }
      await browser(app).post("/v1/auth/forgot-password", { email }).expect(429);
    });

    it("invites are emailed with the invite link", async () => {
      const { b } = await signedUp(app, { name: "Olive", workspaceName: "Mail Team" });
      const email = uniqueEmail("invitee");
      const res = await b.post("/v1/invites", { email, role: "rep" }).expect(201);
      const [mail] = sentTo(email);
      expect(mail?.subject).toBe("Olive invited you to Mail Team on Openline");
      expect(mail?.text).toContain(res.body.inviteUrl as string);
    });

    it("invite emails strip links from names and cap them at 60 characters", async () => {
      const { b } = await signedUp(app, {
        name: "Olive http://evil.example/login",
        workspaceName: `Go to www.evil.example ${"W".repeat(70)}`,
      });
      const email = uniqueEmail("invitee");
      const res = await b.post("/v1/invites", { email, role: "rep" }).expect(201);
      const [mail] = sentTo(email);
      expect(mail?.subject).toBe(`Olive invited you to Go to ${"W".repeat(54)} on Openline`);
      for (const body of [mail?.subject, mail?.text, mail?.html]) {
        expect(body).not.toContain("evil.example");
      }
      expect(mail?.text).toContain(res.body.inviteUrl as string);
    });

    it("safeDisplayText removes URLs and control characters and caps the length", () => {
      expect(safeDisplayText("Acme HTTPS://x.y/z Sales")).toBe("Acme Sales");
      expect(safeDisplayText("www.phish.example")).toBe("");
      expect(safeDisplayText("a\u0000b\nc")).toBe("a b c");
      expect(safeDisplayText("x".repeat(100))).toHaveLength(60);
    });

    it("unverified users get 403 email_not_verified for mailbox, activate and enroll", async () => {
      const { b } = await signedUp(app);
      const mb = await b
        .post("/v1/mailboxes/smtp", { ...SMTP, email: uniqueEmail("mb") })
        .expect(403);
      expect(mb.body.code).toBe("email_not_verified");

      await b.patch("/v1/workspace", { mailingAddress: ADDRESS }).expect(200);
      const seq = await b.post("/v1/sequences", { name: "Draft", steps: STEPS }).expect(201);
      const act = await b
        .post(`/v1/sequences/${seq.body.id as string}/status`, { status: "active" })
        .expect(403);
      expect(act.body.code).toBe("email_not_verified");

      const enroll = await b
        .post(`/v1/sequences/${seq.body.id as string}/enroll`, {
          contactIds: [missingId],
          mailboxId: missingId,
        })
        .expect(403);
      expect(enroll.body.code).toBe("email_not_verified");
    });
  });

  // ---------------------------------------------------------------- workspace settings

  describe("workspace settings", () => {
    it("everyone reads; only owners and admins change it; time zone is validated", async () => {
      const { b: owner } = await signedUp(app, { workspaceName: "Settings Co" });
      const rep = await joinAs(app, owner, "rep");
      const admin = await joinAs(app, owner, "admin");

      const read = await rep.get("/v1/workspace").expect(200);
      expect(read.body).toMatchObject({
        name: "Settings Co",
        mailingAddress: null,
        defaultTimeZone: "America/New_York",
      });
      expect((await rep.patch("/v1/workspace", { name: "Hijack" }).expect(403)).body.code).toBe(
        "forbidden",
      );

      const updated = await admin
        .patch("/v1/workspace", { mailingAddress: ADDRESS, defaultTimeZone: "America/Toronto" })
        .expect(200);
      expect(updated.body).toMatchObject({
        mailingAddress: ADDRESS,
        defaultTimeZone: "America/Toronto",
      });

      const bad = await owner
        .patch("/v1/workspace", { defaultTimeZone: "Mars/Olympus" })
        .expect(400);
      expect(bad.body.code).toBe("validation_error");
      expect(bad.body.details[0].path).toBe("defaultTimeZone");
      await owner.patch("/v1/workspace", { mailingAddress: "short" }).expect(400);
    });
  });

  // ---------------------------------------------------------------- mailboxes

  describe("mailboxes", () => {
    it("SMTP connect never returns credentials; the sealed secret only opens for its workspace", async () => {
      const { b } = await verifiedSignup(app);
      const workspaceId = await workspaceIdOf(b);
      const email = uniqueEmail("smtp");
      const created = await b
        .post("/v1/mailboxes/smtp", { ...SMTP, email, displayName: "Sam" })
        .expect(201);
      expect(created.body).toMatchObject({
        provider: "smtp",
        email,
        displayName: "Sam",
        status: "active",
        dailyCap: 50,
        sentToday: 0,
      });
      const list = await b.get("/v1/mailboxes").expect(200);
      for (const body of [created.body, list.body]) {
        const raw = JSON.stringify(body);
        expect(raw).not.toContain(SMTP.password);
        expect(raw).not.toContain("secret");
        expect(raw).not.toContain("smtp.acme.com");
      }

      const [row] = await withTenant(handle.db, { workspaceId }, (tx) =>
        tx
          .select()
          .from(mailboxes)
          .where(eq(mailboxes.id, created.body.id as string)),
      );
      expect(row!.secretSealed).not.toContain(SMTP.password);
      const secret = openJson<MailboxSecret>(row!.secretSealed, config.secretsKey, workspaceId);
      expect(secret).toEqual({ kind: "smtp", username: SMTP.username, password: SMTP.password });
      expect(() => openJson(row!.secretSealed, config.secretsKey, missingId)).toThrow();

      const dup = await b.post("/v1/mailboxes/smtp", { ...SMTP, email }).expect(409);
      expect(dup.body.code).toBe("conflict");
      await b.post("/v1/mailboxes/smtp", { ...SMTP, email, port: 22 }).expect(400);
    });

    it("sentToday counts today's outbound messages", async () => {
      const { b, mailboxId, workspaceId } = await sender();
      await withTenant(handle.db, { workspaceId }, (tx) =>
        tx.insert(messages).values([
          { workspaceId, mailboxId, messageIdHeader: "<a@x>", subject: "Hi" },
          { workspaceId, mailboxId, messageIdHeader: "<b@x>", subject: "Hi" },
          {
            workspaceId,
            mailboxId,
            messageIdHeader: "<c@x>",
            subject: "Old",
            sentAt: new Date(Date.now() - 3 * 86_400_000),
          },
        ]),
      );
      const list = await b.get("/v1/mailboxes").expect(200);
      expect(list.body.find((m: { id: string }) => m.id === mailboxId).sentToday).toBe(2);
    });

    it("only the mailbox's owner, owners and admins can change or remove it", async () => {
      const { b: owner } = await verifiedSignup(app);
      const { b: rep1 } = await joinVerifiedAs(app, owner, "rep");
      const rep2 = await joinAs(app, owner, "rep");
      const manager = await joinAs(app, owner, "manager");
      const id = await connectMailbox(rep1);

      expect(
        (await rep2.patch(`/v1/mailboxes/${id}`, { dailyCap: 10 }).expect(403)).body.code,
      ).toBe("forbidden");
      await manager.patch(`/v1/mailboxes/${id}`, { dailyCap: 10 }).expect(403);
      await rep2.delete(`/v1/mailboxes/${id}`).expect(403);

      const mine = await rep1.patch(`/v1/mailboxes/${id}`, { dailyCap: 20 }).expect(200);
      expect(mine.body.dailyCap).toBe(20);
      const paused = await owner.patch(`/v1/mailboxes/${id}`, { status: "paused" }).expect(200);
      expect(paused.body.status).toBe("paused");
      await owner.patch(`/v1/mailboxes/${id}`, { dailyCap: 9999 }).expect(400);
      // Everyone can see the team's mailboxes.
      expect((await rep2.get("/v1/mailboxes").expect(200)).body).toHaveLength(1);
    });

    it("removing a mailbox stops its enrollments and hides it", async () => {
      const { b, mailboxId, sequenceId } = await sender();
      const c = await contact(b, { email: "stop-me@acme.com" });
      await b
        .post(`/v1/sequences/${sequenceId}/enroll`, { contactIds: [c], mailboxId })
        .expect(200);

      await b.delete(`/v1/mailboxes/${mailboxId}`).expect(200);
      expect((await b.get("/v1/mailboxes").expect(200)).body).toHaveLength(0);
      await b.patch(`/v1/mailboxes/${mailboxId}`, { dailyCap: 5 }).expect(404);
      const [enrollment] = (await b.get(`/v1/contacts/${c}/enrollments`).expect(200)).body;
      expect(enrollment).toMatchObject({
        state: "stopped",
        lastDecision: "mailbox_removed",
        lastError: null,
        nextRunAt: null,
      });
    });

    it("removing a team member removes their mailboxes and stops what sends from them", async () => {
      const { b: owner, mailboxId: ownerMailbox, sequenceId, workspaceId } = await sender();
      const { b: rep } = await joinVerifiedAs(app, owner, "rep");
      const repMailbox = await connectMailbox(rep);
      const repId = (await rep.get("/v1/auth/me").expect(200)).body.user.id as string;
      const c1 = await contact(owner, { email: "rep-one@acme.com" });
      const c2 = await contact(owner, { email: "rep-two@acme.com" });
      const c3 = await contact(owner, { email: "owner-one@acme.com" });
      await rep
        .post(`/v1/sequences/${sequenceId}/enroll`, { contactIds: [c1, c2], mailboxId: repMailbox })
        .expect(200);
      await owner
        .post(`/v1/sequences/${sequenceId}/enroll`, { contactIds: [c3], mailboxId: ownerMailbox })
        .expect(200);
      const [e2] = (await owner.get(`/v1/contacts/${c2}/enrollments`).expect(200)).body;
      await rep.post(`/v1/enrollments/${e2.id as string}/action`, { action: "pause" }).expect(200);

      await owner.delete(`/v1/members/${repId}`).expect(200);

      for (const c of [c1, c2]) {
        const [e] = (await owner.get(`/v1/contacts/${c}/enrollments`).expect(200)).body;
        expect(e).toMatchObject({
          state: "stopped",
          lastDecision: "mailbox_removed",
          lastError: null,
          nextRunAt: null,
        });
      }
      const [kept] = (await owner.get(`/v1/contacts/${c3}/enrollments`).expect(200)).body;
      expect(kept.state).toBe("active");

      const visible = (await owner.get("/v1/mailboxes").expect(200)).body as { id: string }[];
      expect(visible.map((m) => m.id)).toEqual([ownerMailbox]);
      const [row] = await withTenant(handle.db, { workspaceId }, (tx) =>
        tx.select().from(mailboxes).where(eq(mailboxes.id, repMailbox)),
      );
      expect(row).toMatchObject({ status: "disconnected", secretSealed: "" });
    });

    it("Gmail endpoints return 501 google_not_configured when not configured", async () => {
      const { b } = await verifiedSignup(app);
      const res = await b.get("/v1/mailboxes/google/authorize").expect(501);
      expect(res.body.code).toBe("google_not_configured");
    });
  });

  // ---------------------------------------------------------------- sequences

  describe("sequences", () => {
    it("create, read, list and update; archived are hidden by default", async () => {
      const { b } = await signedUp(app);
      const created = await b.post("/v1/sequences", { name: "Q1", steps: STEPS }).expect(201);
      expect(created.body).toMatchObject({
        name: "Q1",
        status: "draft",
        sendWindow: { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 },
        stats: { active: 0, sent: 0 },
      });
      expect(created.body.steps.map((s: { position: number }) => s.position)).toEqual([1, 2]);
      const id = created.body.id as string;

      const updated = await b
        .patch(`/v1/sequences/${id}`, {
          name: "Q1 renamed",
          sendWindow: { days: [2, 4], startHour: 10, endHour: 12 },
        })
        .expect(200);
      expect(updated.body).toMatchObject({ name: "Q1 renamed", sendWindow: { days: [2, 4] } });
      expect(updated.body.steps).toHaveLength(2);
      expect((await b.get(`/v1/sequences/${id}`).expect(200)).body.name).toBe("Q1 renamed");

      await b.post(`/v1/sequences/${id}/status`, { status: "archived" }).expect(200);
      expect((await b.get("/v1/sequences").expect(200)).body).toHaveLength(0);
      expect((await b.get("/v1/sequences?includeArchived=true").expect(200)).body).toHaveLength(1);
    });

    it("validates steps, unknown variables and the send window", async () => {
      const { b } = await signedUp(app);
      const noSteps = await b.post("/v1/sequences", { name: "Empty" }).expect(400);
      expect(noSteps.body.details[0].path).toBe("steps");

      const unknown = await b
        .post("/v1/sequences", {
          name: "Typo",
          steps: [STEPS[0], { delayDays: 2, subject: "Re", body: "Hi {{frstName}}" }],
        })
        .expect(400);
      expect(unknown.body.code).toBe("validation_error");
      expect(unknown.body.details).toEqual([
        { path: "steps.1.body", message: "Unknown variable: {{frstName}}" },
      ]);

      await b
        .post("/v1/sequences", {
          name: "Window",
          steps: STEPS,
          sendWindow: { days: [1], startHour: 18, endHour: 9 },
        })
        .expect(400);
    });

    it("activation needs a mailing address; only owners, admins and managers change status", async () => {
      const { b } = await verifiedSignup(app);
      const rep = await joinAs(app, b, "rep");
      const seq = await b.post("/v1/sequences", { name: "Go", steps: STEPS }).expect(201);
      const id = seq.body.id as string;

      const noAddress = await b
        .post(`/v1/sequences/${id}/status`, { status: "active" })
        .expect(409);
      expect(noAddress.body.code).toBe("mailing_address_required");
      await rep.post(`/v1/sequences/${id}/status`, { status: "active" }).expect(403);

      await b.patch("/v1/workspace", { mailingAddress: ADDRESS }).expect(200);
      const active = await b.post(`/v1/sequences/${id}/status`, { status: "active" }).expect(200);
      expect(active.body.status).toBe("active");
      const paused = await b.post(`/v1/sequences/${id}/status`, { status: "paused" }).expect(200);
      expect(paused.body.status).toBe("paused");
      await b.post(`/v1/sequences/${id}/status`, { status: "bogus" }).expect(400);
    });

    it("only managers and up can replace the steps of a non-draft sequence", async () => {
      const { b } = await verifiedSignup(app);
      const rep = await joinAs(app, b, "rep");
      const manager = await joinAs(app, b, "manager");
      const draft = (
        await rep.post("/v1/sequences", { name: "Rep draft", steps: STEPS }).expect(201)
      ).body.id as string;
      await rep
        .patch(`/v1/sequences/${draft}`, { name: "Rep draft", steps: [STEPS[0]] })
        .expect(200);

      const live = await activeSequence(b);
      const denied = await rep
        .patch(`/v1/sequences/${live}`, { name: "Outbound", steps: [STEPS[0]] })
        .expect(403);
      expect(denied.body.code).toBe("forbidden");
      // Renaming without touching the steps is still fine for a rep.
      await rep.patch(`/v1/sequences/${live}`, { name: "Renamed by rep" }).expect(200);
      await manager
        .patch(`/v1/sequences/${live}`, { name: "Outbound", steps: [STEPS[0]] })
        .expect(200);
    });

    it("archiving stops active and paused enrollments with lastDecision sequence_archived", async () => {
      const { b, mailboxId, sequenceId } = await sender();
      const c1 = await contact(b, { email: "arch-one@acme.com" });
      const c2 = await contact(b, { email: "arch-two@acme.com" });
      await b
        .post(`/v1/sequences/${sequenceId}/enroll`, { contactIds: [c1, c2], mailboxId })
        .expect(200);
      const [e2] = (await b.get(`/v1/contacts/${c2}/enrollments`).expect(200)).body;
      await b.post(`/v1/enrollments/${e2.id as string}/action`, { action: "pause" }).expect(200);

      await b.post(`/v1/sequences/${sequenceId}/status`, { status: "archived" }).expect(200);
      for (const c of [c1, c2]) {
        const [e] = (await b.get(`/v1/contacts/${c}/enrollments`).expect(200)).body;
        expect(e).toMatchObject({
          state: "stopped",
          lastDecision: "sequence_archived",
          lastError: null,
          nextRunAt: null,
        });
      }
    });

    it("steps can't be replaced while it has active enrollments (409 sequence_in_use)", async () => {
      const { b, mailboxId, sequenceId } = await sender();
      const c = await contact(b, { email: "in-use@acme.com" });
      await b
        .post(`/v1/sequences/${sequenceId}/enroll`, { contactIds: [c], mailboxId })
        .expect(200);

      const res = await b
        .patch(`/v1/sequences/${sequenceId}`, { name: "Outbound", steps: [STEPS[0]] })
        .expect(409);
      expect(res.body.code).toBe("sequence_in_use");
      await b.patch(`/v1/sequences/${sequenceId}`, { name: "Renamed only" }).expect(200);
    });

    it("preview renders each step with the legal footer", async () => {
      const { b } = await signedUp(app, { workspaceName: "Footer Co", name: "Sally Sender" });
      await b.patch("/v1/workspace", { mailingAddress: ADDRESS }).expect(200);
      const seq = await b.post("/v1/sequences", { name: "P", steps: STEPS }).expect(201);
      const id = seq.body.id as string;

      const placeholder = await b.post(`/v1/sequences/${id}/preview`, {}).expect(200);
      expect(placeholder.body.steps).toHaveLength(2);
      const [first, second] = placeholder.body.steps;
      expect(first.subject).toBe("Hi Alex");
      expect(first.text).toContain(ADDRESS);
      expect(first.text).toContain("Footer Co");
      expect(first.html).toContain("Unsubscribe");
      expect(second.subject).toBe("Re: Hi Alex");

      const c = await contact(b, {
        email: "pat@initech.com",
        firstName: "Pat",
        companyName: "Initech",
      });
      const real = await b.post(`/v1/sequences/${id}/preview`, { contactId: c }).expect(200);
      expect(real.body.steps[0].subject).toBe("Hi Pat");
      expect(real.body.steps[0].text).toContain("Hello Pat at Initech.");
      await b.post(`/v1/sequences/${id}/preview`, { contactId: missingId }).expect(404);
    });
  });

  // ---------------------------------------------------------------- enrollments

  describe("enrollment", () => {
    it("skips suppressed, unsubscribed, already enrolled, missing and no-consent contacts", async () => {
      const { b, mailboxId, sequenceId, workspaceId } = await sender();
      const ok = await contact(b, { email: "ok@us-company.com" });
      const supEmail = await contact(b, { email: "blocked@acme.com" });
      const supDomain = await contact(b, { email: "anyone@competitor.com" });
      const unsub = await contact(b, { email: "gone@acme.com" });
      const canadian = await contact(b, { email: "maple@north.com", country: "CA" });
      const dotCa = await contact(b, { email: "hockey@rink.ca" });

      await b.post("/v1/suppressions", { value: "blocked@acme.com", reason: "other" }).expect(201);
      await b
        .post("/v1/suppressions", { value: "@competitor.com", reason: "competitor" })
        .expect(201);
      const token = createUnsubscribeToken(
        { workspaceId, contactId: unsub },
        config.UNSUBSCRIBE_SECRET,
      );
      await request(app.getHttpServer()).post(`/v1/public/unsubscribe/${token}`).expect(200);

      const first = await b
        .post(`/v1/sequences/${sequenceId}/enroll`, {
          contactIds: [ok, supEmail, supDomain, unsub, canadian, dotCa, missingId, ok],
          mailboxId,
        })
        .expect(200);
      expect(first.body.enrolled).toBe(1);
      const reasons = Object.fromEntries(
        (first.body.skipped as { contactId: string; reason: string }[]).map((s) => [
          s.contactId,
          s.reason,
        ]),
      );
      expect(reasons).toEqual({
        [supEmail]: "suppressed",
        [supDomain]: "suppressed",
        [unsub]: "unsubscribed",
        [canadian]: "no_consent",
        [dotCa]: "no_consent",
        [missingId]: "not_found",
      });

      // Express consent recorded with source and date → the Canadian contact can be enrolled.
      await b
        .put(`/v1/contacts/${canadian}/consent`, {
          basis: "express",
          source: "Opted in at a trade show",
          obtainedAt: "2026-10-02",
        })
        .expect(200);
      const second = await b
        .post(`/v1/sequences/${sequenceId}/enroll`, { contactIds: [ok, canadian], mailboxId })
        .expect(200);
      expect(second.body).toEqual({
        enrolled: 1,
        skipped: [{ contactId: ok, reason: "already_enrolled" }],
      });

      const list = await b.get(`/v1/sequences/${sequenceId}/enrollments`).expect(200);
      expect(list.body.items).toHaveLength(2);
      expect(list.body.items[0]).toMatchObject({
        state: "active",
        nextPosition: 1,
        mailbox: { id: mailboxId },
      });
      expect(list.body.items[0].nextRunAt).not.toBeNull();
      expect((await b.get(`/v1/sequences/${sequenceId}`).expect(200)).body.stats.active).toBe(2);
    });

    it("needs an active sequence and an active mailbox; reps can only use their own", async () => {
      const { b, mailboxId, sequenceId } = await sender();
      const { b: rep } = await joinVerifiedAs(app, b, "rep");
      const c = await contact(b, { email: "target@acme.com" });

      const others = await rep
        .post(`/v1/sequences/${sequenceId}/enroll`, { contactIds: [c], mailboxId })
        .expect(403);
      expect(others.body.code).toBe("forbidden");
      const repMailbox = await connectMailbox(rep);
      await rep
        .post(`/v1/sequences/${sequenceId}/enroll`, { contactIds: [c], mailboxId: repMailbox })
        .expect(200);

      await b.patch(`/v1/mailboxes/${mailboxId}`, { status: "paused" }).expect(200);
      const paused = await b
        .post(`/v1/sequences/${sequenceId}/enroll`, { contactIds: [c], mailboxId })
        .expect(409);
      expect(paused.body.code).toBe("mailbox_not_active");

      const draft = await b.post("/v1/sequences", { name: "Draft", steps: STEPS }).expect(201);
      const notActive = await b
        .post(`/v1/sequences/${draft.body.id as string}/enroll`, {
          contactIds: [c],
          mailboxId: repMailbox,
        })
        .expect(409);
      expect(notActive.body.code).toBe("sequence_not_active");
      await b.post(`/v1/sequences/${sequenceId}/enroll`, { contactIds: [], mailboxId }).expect(400);
    });

    it("pause, resume, stop and mark_replied", async () => {
      const { b, mailboxId, sequenceId } = await sender();
      const c1 = await contact(b, { email: "one@acme.com" });
      const c2 = await contact(b, { email: "two@acme.com" });
      await b
        .post(`/v1/sequences/${sequenceId}/enroll`, { contactIds: [c1, c2], mailboxId })
        .expect(200);
      const [e1] = (await b.get(`/v1/contacts/${c1}/enrollments`).expect(200)).body;
      const [e2] = (await b.get(`/v1/contacts/${c2}/enrollments`).expect(200)).body;
      const act = (id: string, action: string) =>
        b.post(`/v1/enrollments/${id}/action`, { action });

      const paused = (await act(e1.id, "pause").expect(200)).body;
      expect(paused).toMatchObject({ state: "paused", lastDecision: "paused_by_user" });
      expect((await act(e1.id, "pause").expect(409)).body.code).toBe("invalid_transition");
      const resumed = await act(e1.id, "resume").expect(200);
      expect(resumed.body).toMatchObject({ state: "active", lastDecision: "resumed" });
      expect(Date.parse(resumed.body.nextRunAt as string)).toBeLessThanOrEqual(Date.now());
      expect((await act(e1.id, "stop").expect(200)).body).toMatchObject({
        state: "stopped",
        lastDecision: "stopped_by_user",
        lastError: null,
        nextRunAt: null,
      });
      await act(e1.id, "resume").expect(409);
      expect((await act(e2.id, "mark_replied").expect(200)).body).toMatchObject({
        state: "replied",
        lastDecision: "marked_replied",
        nextRunAt: null,
      });
      await act(e2.id, "explode").expect(400);

      const stopped = await b
        .get(`/v1/sequences/${sequenceId}/enrollments?state=stopped`)
        .expect(200);
      expect(stopped.body.items.map((e: { id: string }) => e.id)).toEqual([e1.id]);
      const stats = (await b.get(`/v1/sequences/${sequenceId}`).expect(200)).body.stats;
      expect(stats).toMatchObject({ stopped: 1, replied: 1, active: 0 });
    });

    it("reps can only act on enrollments that send from their own mailbox", async () => {
      const { b: owner, mailboxId: ownerMailbox, sequenceId } = await sender();
      const { b: rep } = await joinVerifiedAs(app, owner, "rep");
      const manager = await joinAs(app, owner, "manager");
      const repMailbox = await connectMailbox(rep);
      const mine = await contact(owner, { email: "reps-own@acme.com" });
      const theirs = await contact(owner, { email: "owners-own@acme.com" });
      await rep
        .post(`/v1/sequences/${sequenceId}/enroll`, { contactIds: [mine], mailboxId: repMailbox })
        .expect(200);
      await owner
        .post(`/v1/sequences/${sequenceId}/enroll`, {
          contactIds: [theirs],
          mailboxId: ownerMailbox,
        })
        .expect(200);
      const [own] = (await owner.get(`/v1/contacts/${mine}/enrollments`).expect(200)).body;
      const [other] = (await owner.get(`/v1/contacts/${theirs}/enrollments`).expect(200)).body;
      const act = (who: Browser, id: string, action: string) =>
        who.post(`/v1/enrollments/${id}/action`, { action });

      const denied = await act(rep, other.id as string, "stop").expect(403);
      expect(denied.body.code).toBe("forbidden");
      const [unchanged] = (await owner.get(`/v1/contacts/${theirs}/enrollments`).expect(200)).body;
      expect(unchanged.state).toBe("active");

      await act(rep, own.id as string, "pause").expect(200);
      // Managers, admins and owners may act on anyone's.
      await act(manager, own.id as string, "resume").expect(200);
      await act(manager, other.id as string, "pause").expect(200);
      await act(owner, other.id as string, "resume").expect(200);
    });

    it("enrollment list pages with a cursor; contact messages list sent emails", async () => {
      const { b, mailboxId, sequenceId, workspaceId } = await sender();
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) ids.push(await contact(b, { email: `page${i}@acme.com` }));
      for (const id of ids) {
        await b
          .post(`/v1/sequences/${sequenceId}/enroll`, { contactIds: [id], mailboxId })
          .expect(200);
      }
      const page1 = await b.get(`/v1/sequences/${sequenceId}/enrollments?limit=2`).expect(200);
      expect(page1.body.items).toHaveLength(2);
      const page2 = await b
        .get(`/v1/sequences/${sequenceId}/enrollments?limit=2&cursor=${page1.body.nextCursor}`)
        .expect(200);
      expect(page2.body.items).toHaveLength(1);
      expect(page2.body.nextCursor).toBeNull();
      await b.get(`/v1/sequences/${sequenceId}/enrollments?cursor=garbage`).expect(400);

      const [enrollment] = (await b.get(`/v1/contacts/${ids[0]}/enrollments`).expect(200)).body;
      await withTenant(handle.db, { workspaceId }, (tx) =>
        tx.insert(messages).values({
          workspaceId,
          enrollmentId: enrollment.id,
          contactId: ids[0],
          mailboxId,
          stepPosition: 1,
          messageIdHeader: "<m1@acme.com>",
          subject: "Hi there",
        }),
      );
      const msgs = await b.get(`/v1/contacts/${ids[0]}/messages`).expect(200);
      expect(msgs.body).toEqual([
        expect.objectContaining({ sequenceId, stepPosition: 1, subject: "Hi there" }),
      ]);
      expect((await b.get(`/v1/sequences/${sequenceId}`).expect(200)).body.stats.sent).toBe(1);
    });
  });

  // ---------------------------------------------------------------- consent

  describe("consent records", () => {
    it("PUT needs a source and a past date; history is kept; GET returns the latest", async () => {
      const { b, workspaceId } = await sender();
      const rep = await joinAs(app, b, "rep");
      const c = await contact(b, { email: "consent@north.ca" });

      const empty = await b.get(`/v1/contacts/${c}/consent`).expect(200);
      expect(empty.body).toBeNull();

      const noSource = await b
        .put(`/v1/contacts/${c}/consent`, { basis: "express", obtainedAt: "2026-01-01" })
        .expect(400);
      expect(noSource.body.code).toBe("validation_error");
      await b
        .put(`/v1/contacts/${c}/consent`, { basis: "express", source: "Web form" })
        .expect(400);
      const future = await b
        .put(`/v1/contacts/${c}/consent`, {
          basis: "express",
          source: "Web form",
          obtainedAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        })
        .expect(400);
      expect(future.body.details[0].path).toBe("obtainedAt");
      await rep
        .put(`/v1/contacts/${c}/consent`, {
          basis: "express",
          source: "Web form",
          obtainedAt: "2026-01-01",
        })
        .expect(403);

      const inquiry = await b
        .put(`/v1/contacts/${c}/consent`, {
          basis: "implied_inquiry",
          source: "Asked for a quote by email",
          obtainedAt: "2026-06-01T00:00:00.000Z",
        })
        .expect(200);
      expect(inquiry.body).toMatchObject({
        basis: "implied_inquiry",
        source: "Asked for a quote by email",
        obtainedAt: "2026-06-01T00:00:00.000Z",
        expiresAt: "2026-12-01T00:00:00.000Z",
      });
      await b
        .put(`/v1/contacts/${c}/consent`, {
          basis: "express",
          source: "Ticked the newsletter box",
          obtainedAt: "2026-07-01",
        })
        .expect(200);

      const latest = await rep.get(`/v1/contacts/${c}/consent`).expect(200);
      expect(latest.body).toMatchObject({ basis: "express", expiresAt: null });
      expect((await b.get(`/v1/contacts/${c}`).expect(200)).body.consentBasis).toBe("express");
      const history = await withTenant(handle.db, { workspaceId }, (tx) =>
        tx
          .select()
          .from(consents)
          .where(and(eq(consents.workspaceId, workspaceId), eq(consents.contactId, c))),
      );
      expect(history).toHaveLength(2);
    });

    it("POST/PATCH /v1/contacts with a basis other than none → 400 use_consent_endpoint", async () => {
      const { b } = await signedUp(app);
      const created = await b
        .post("/v1/contacts", { email: "x@acme.com", consentBasis: "express" })
        .expect(400);
      expect(created.body.code).toBe("use_consent_endpoint");
      const c = await contact(b, { email: "y@acme.com", consentBasis: "none" });
      const patched = await b
        .patch(`/v1/contacts/${c}`, { consentBasis: "implied_purchase" })
        .expect(400);
      expect(patched.body.code).toBe("use_consent_endpoint");
    });
  });

  // ---------------------------------------------------------------- unsubscribe

  describe("public unsubscribe", () => {
    it("GET masks the email; one-click POST works without a CSRF header and is idempotent", async () => {
      const { b, mailboxId, sequenceId, workspaceId } = await sender();
      await b.patch("/v1/workspace", { name: "Unsub Co" }).expect(200);
      const c = await contact(b, { email: "jane@acme.com" });
      const recorded = await b
        .put(`/v1/contacts/${c}/consent`, {
          basis: "express",
          source: "Signed up at a webinar",
          obtainedAt: "2026-01-01",
        })
        .expect(200);
      expect(recorded.body.withdrawnAt).toBeNull();
      await b
        .post(`/v1/sequences/${sequenceId}/enroll`, { contactIds: [c], mailboxId })
        .expect(200);
      const token = createUnsubscribeToken(
        { workspaceId, contactId: c },
        config.UNSUBSCRIBE_SECRET,
      );
      const http = () => request(app.getHttpServer());

      const page = await http().get(`/v1/public/unsubscribe/${token}`).expect(200);
      expect(page.body).toEqual({
        email: "j***@acme.com",
        workspaceName: "Unsub Co",
        alreadyUnsubscribed: false,
      });

      await http()
        .post(`/v1/public/unsubscribe/${token}`)
        .type("form")
        .send("List-Unsubscribe=One-Click")
        .expect(200);

      expect((await b.get(`/v1/contacts/${c}`).expect(200)).body.status).toBe("unsubscribed");
      const sup = (await b.get("/v1/suppressions").expect(200)).body.find(
        (s: { value: string }) => s.value === "jane@acme.com",
      );
      expect(sup.reason).toBe("unsubscribed");
      expect((await b.delete(`/v1/suppressions/${sup.id as string}`).expect(409)).body.code).toBe(
        "suppression_locked",
      );
      const [enrollment] = (await b.get(`/v1/contacts/${c}/enrollments`).expect(200)).body;
      expect(enrollment).toMatchObject({
        state: "unsubscribed",
        lastDecision: "unsubscribed",
        lastError: null,
        nextRunAt: null,
      });
      const consent = (await b.get(`/v1/contacts/${c}/consent`).expect(200)).body;
      expect(consent.basis).toBe("express");
      expect(Date.parse(consent.withdrawnAt as string)).toBeLessThanOrEqual(Date.now());

      // Again (JSON this time): still 200, nothing breaks.
      await http().post(`/v1/public/unsubscribe/${token}`).send({}).expect(200);
      expect((await http().get(`/v1/public/unsubscribe/${token}`).expect(200)).body).toMatchObject({
        alreadyUnsubscribed: true,
      });
    });

    it("tampered or unknown tokens are 404; other routes still need the CSRF header", async () => {
      const { b, workspaceId } = await sender();
      const c = await contact(b, { email: "tamper@acme.com" });
      const token = createUnsubscribeToken(
        { workspaceId, contactId: c },
        config.UNSUBSCRIBE_SECRET,
      );
      // Change one character well inside the signature (the last base64 characters carry
      // unused bits, so editing them can leave the decoded signature unchanged).
      const i = token.length - 10;
      const tampered = `${token.slice(0, i)}${token[i] === "A" ? "B" : "A"}${token.slice(i + 1)}`;
      const forged = createUnsubscribeToken({ workspaceId, contactId: c }, "x".repeat(40));
      const http = () => request(app.getHttpServer());
      for (const t of [tampered, forged, "garbage"]) {
        await http().get(`/v1/public/unsubscribe/${t}`).expect(404);
        await http().post(`/v1/public/unsubscribe/${t}`).type("form").send("a=b").expect(404);
      }
      // A valid token for a contact in another workspace id doesn't leak across.
      const crossToken = createUnsubscribeToken(
        { workspaceId: missingId, contactId: c },
        config.UNSUBSCRIBE_SECRET,
      );
      await http().get(`/v1/public/unsubscribe/${crossToken}`).expect(404);
      expect((await b.get(`/v1/contacts/${c}`).expect(200)).body.status).toBe("active");

      const csrf = await b.agent
        .post("/v1/contacts")
        .send({ email: "nocsrf@acme.com" })
        .expect(403);
      expect(csrf.body.code).toBe("csrf");
    });
  });

  // ---------------------------------------------------------------- tenancy

  it("every new :id route returns 404 for another workspace's records", async () => {
    const a = await sender();
    const c = await contact(a.b, { email: "secret@acme.com" });
    await a.b
      .post(`/v1/sequences/${a.sequenceId}/enroll`, { contactIds: [c], mailboxId: a.mailboxId })
      .expect(200);
    const [enrollment] = (await a.b.get(`/v1/contacts/${c}/enrollments`).expect(200)).body;
    const { b: intruder } = await verifiedSignup(app);
    const intruderMailbox = await connectMailbox(intruder);

    const attempts = [
      intruder.patch(`/v1/mailboxes/${a.mailboxId}`, { dailyCap: 1 }),
      intruder.delete(`/v1/mailboxes/${a.mailboxId}`),
      intruder.get(`/v1/sequences/${a.sequenceId}`),
      intruder.patch(`/v1/sequences/${a.sequenceId}`, { name: "Mine now" }),
      intruder.post(`/v1/sequences/${a.sequenceId}/status`, { status: "paused" }),
      intruder.post(`/v1/sequences/${a.sequenceId}/preview`, {}),
      intruder.post(`/v1/sequences/${a.sequenceId}/enroll`, {
        contactIds: [c],
        mailboxId: intruderMailbox,
      }),
      intruder.get(`/v1/sequences/${a.sequenceId}/enrollments`),
      intruder.post(`/v1/enrollments/${enrollment.id as string}/action`, { action: "stop" }),
      intruder.get(`/v1/contacts/${c}/enrollments`),
      intruder.get(`/v1/contacts/${c}/messages`),
      intruder.get(`/v1/contacts/${c}/consent`),
      intruder.put(`/v1/contacts/${c}/consent`, {
        basis: "express",
        source: "Stolen",
        obtainedAt: "2026-01-01",
      }),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(404);

    // Using another workspace's mailbox in your own sequence is 404 too.
    const own = await activeSequence(intruder);
    const ownContact = await contact(intruder, { email: "mine@acme.com" });
    await intruder
      .post(`/v1/sequences/${own}/enroll`, { contactIds: [ownContact], mailboxId: a.mailboxId })
      .expect(404);
    // ...and another workspace's contacts are simply not found.
    const res = await intruder
      .post(`/v1/sequences/${own}/enroll`, { contactIds: [c], mailboxId: intruderMailbox })
      .expect(200);
    expect(res.body.skipped).toEqual([{ contactId: c, reason: "not_found" }]);

    expect((await a.b.get(`/v1/sequences/${a.sequenceId}`).expect(200)).body.name).toBe("Outbound");
    expect((await a.b.get("/v1/mailboxes").expect(200)).body).toHaveLength(1);
  });
});
