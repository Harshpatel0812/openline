import { Logger } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { CaptureAdapter } from "@openline/email";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestApp, sentTo } from "./helpers";

const INBOX = "hello@openline.example";
const URL = "/v1/public/contact";

let ipCounter = 0;
/** A fresh client IP per test (X-Forwarded-For is honoured from loopback by default). */
const nextIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

let emailCounter = 0;
const nextEmail = () => `visitor${++emailCounter}-${Date.now()}@example.com`;

function enquiry(overrides: Record<string, unknown> = {}) {
  return {
    name: "Jane Doe",
    email: nextEmail(),
    company: "Acme Sales",
    teamSize: "6-15",
    message: "We have eight reps and want compliant sequences.",
    ...overrides,
  };
}

describe("public contact form", () => {
  let app: NestExpressApplication;
  const post = (body: object, ip = nextIp()) =>
    request(app.getHttpServer()).post(URL).set("x-forwarded-for", ip).send(body);
  const inbox = () => sentTo(INBOX);

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emails one enquiry to CONTACT_INBOX with Reply-To set to the visitor", async () => {
    const before = inbox().length;
    const body = enquiry({ name: "Unique Sender One" });
    const res = await post(body).expect(202);
    expect(res.body).toEqual({ ok: true });

    const mails = inbox().slice(before);
    expect(mails).toHaveLength(1);
    const mail = mails[0]!;
    expect(mail.subject).toBe("Website enquiry from Unique Sender One");
    expect(mail.replyTo).toBe(body.email);
    expect(mail.text).toContain(`Email: ${body.email}`);
    expect(mail.text).toContain("Company: Acme Sales");
    expect(mail.text).toContain("Team size: 6-15");
    expect(mail.text).toContain(body.message);
  });

  it("works without the CSRF header and without a session (exempt like unsubscribe)", async () => {
    const res = await request(app.getHttpServer())
      .post(URL)
      .set("x-forwarded-for", nextIp())
      .send(enquiry());
    expect(res.status).toBe(202);
    // The exemption is exact: other public-looking paths still need the header.
    await request(app.getHttpServer()).post("/v1/public/contact/x").send({}).expect(403);
    await request(app.getHttpServer()).post("/v1/auth/logout").send({}).expect(403);
  });

  it("silently drops bots that fill the honeypot (202, nothing sent)", async () => {
    const before = CaptureAdapter.outbox.length;
    await post(enquiry({ website: "http://spam.example" })).expect(202, { ok: true });
    // Even with otherwise invalid fields: a bot learns nothing from field errors.
    await post({ website: "x", email: "nope" }).expect(202, { ok: true });
    expect(CaptureAdapter.outbox.length).toBe(before);
    // An empty honeypot (what a person's browser sends) is a normal enquiry.
    await post(enquiry({ website: "" })).expect(202);
    expect(CaptureAdapter.outbox.length).toBe(before + 1);
  });

  it("rejects invalid input with the standard error shape", async () => {
    const before = inbox().length;
    const res = await post({
      name: "",
      email: "not-an-email",
      teamSize: "1000",
      message: "short",
      company: "x".repeat(121),
    }).expect(400);
    expect(res.body.code).toBe("validation_error");
    expect(res.body.message).toEqual(expect.any(String));
    const fields = res.body.details.map((d: { path: string }) => d.path);
    expect(fields).toEqual(
      expect.arrayContaining(["name", "email", "teamSize", "message", "company"]),
    );
    await post(enquiry({ message: "x".repeat(5001) })).expect(400);
    await post(enquiry({ name: "x".repeat(101) })).expect(400);
    await post(enquiry({ email: `${"a".repeat(250)}@b.co` })).expect(400);
    expect(inbox().length).toBe(before);
  });

  it("refuses header injection in the email and strips it from the name", async () => {
    const before = inbox().length;
    const injected = await post(
      enquiry({ email: "jane@acme.com\r\nBcc: victim@example.com" }),
    ).expect(400);
    expect(injected.body.details[0].path).toBe("email");
    expect(inbox().length).toBe(before);

    await post(
      enquiry({ name: "Mallory\r\nBcc: victim@example.com\nX-Evil: 1" + "z".repeat(50) }),
    ).expect(202);
    const mail = inbox().at(-1)!;
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.subject.startsWith("Website enquiry from Mallory Bcc:")).toBe(true);
    expect(mail.subject.length).toBeLessThanOrEqual(78);
    expect(mail.replyTo).not.toMatch(/[\r\n]/);
    // The body can't be forged either: the name stays on its own line.
    expect(mail.text).not.toMatch(/^X-Evil/m);
    expect(mail.text).not.toMatch(/^Bcc:/m);
  });

  it("rate-limits 5 enquiries per IP per hour", async () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i++) await post(enquiry(), ip).expect(202);
    const res = await post(enquiry(), ip).expect(429);
    expect(res.body.code).toBe("rate_limited");
    // Honeypot hits count too, so bots can't hammer the endpoint for free.
    await post(enquiry({ website: "x" }), ip).expect(429);
    await post(enquiry()).expect(202);
  });

  it("rate-limits 3 enquiries per email per day, across IPs and letter case", async () => {
    const email = nextEmail();
    for (let i = 0; i < 3; i++) await post(enquiry({ email })).expect(202);
    const res = await post(enquiry({ email: email.toUpperCase() })).expect(429);
    expect(res.body.code).toBe("rate_limited");
  });

  it("never logs the name, email, company or message (event names only)", async () => {
    const calls: unknown[][] = [];
    const record = (...args: unknown[]) => {
      calls.push(args);
    };
    for (const method of ["log", "warn", "error", "debug", "verbose"] as const) {
      vi.spyOn(Logger.prototype, method).mockImplementation(record);
      vi.spyOn(Logger, method).mockImplementation(record);
    }
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation(record);
    }
    const body = enquiry({
      name: "Privatename Person",
      company: "Secretco Ltd",
      message: "Confidential message body text",
    });
    await post(body).expect(202);
    await post({ ...body, website: "bot" }).expect(202);
    await post({ ...body, message: "short" }).expect(400);

    const logged = JSON.stringify(calls);
    for (const pii of [body.email, "Privatename", "Secretco", "Confidential"]) {
      expect(logged).not.toContain(pii);
    }
    expect(logged).toContain("contact.enquiry_sent");
    expect(logged).toContain("contact.honeypot_dropped");
  });

  it("returns 503 contact_unavailable (and logs no details) when the mail can't be sent", async () => {
    const spy = vi
      .spyOn(CaptureAdapter.prototype, "send")
      .mockRejectedValueOnce(new Error("smtp down for jane@acme.com"));
    const errors = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const res = await post(enquiry()).expect(503);
    expect(res.body.code).toBe("contact_unavailable");
    expect(spy).toHaveBeenCalledOnce();
    expect(JSON.stringify(errors.mock.calls)).not.toContain("jane@acme.com");
  });
});

describe("public contact form behind an untrusted hop", () => {
  let app: NestExpressApplication;
  const previous = process.env.TRUST_PROXY;

  beforeAll(async () => {
    app = await createTestApp({ TRUST_PROXY: "192.0.2.1" });
  });
  afterAll(async () => {
    await app.close();
    if (previous === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previous;
  });

  // Only 192.0.2.1 may set X-Forwarded-For; the test client (loopback) is not that hop.
  it("ignores a spoofed X-Forwarded-For when the hop isn't trusted", async () => {
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post(URL)
        .set("x-forwarded-for", `203.0.113.${i}`)
        .send(enquiry())
        .expect(202);
    }
    await request(app.getHttpServer())
      .post(URL)
      .set("x-forwarded-for", "203.0.113.99")
      .send(enquiry())
      .expect(429);
  });
});
