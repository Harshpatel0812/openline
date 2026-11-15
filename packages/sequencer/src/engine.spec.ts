import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  consents,
  contacts,
  createDatabase,
  enrollments,
  eq,
  mailboxes,
  messages,
  migrate,
  sequenceSteps,
  sequences,
  suppressions,
  users,
  withIdentity,
  withTenant,
  workspaceMembers,
  workspaces,
  type DatabaseHandle,
  type Enrollment,
} from "@openline/db";
import { RULESET_VERSION } from "@openline/compliance";
import { CaptureAdapter, SendError, sealJson, type MailAdapter } from "@openline/email";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSequencer } from "./engine";
import type { SequencerOptions } from "./types";

const KEY = randomBytes(32);
const SECRET = "test-unsubscribe-secret";
/** Wednesday 2026-11-18 10:00 in New York. */
const WED_10AM_NY = new Date("2026-11-18T15:00:00Z");

let handle: DatabaseHandle;

beforeAll(async () => {
  handle = createDatabase("pglite://memory");
  await migrate(handle);
});
afterAll(async () => {
  await handle.close();
});
beforeEach(() => {
  CaptureAdapter.outbox.length = 0;
});

interface SeedOptions {
  mailingAddress?: string | null;
  country?: string | null;
  email?: string;
  timeZone?: string | null;
  dailyCap?: number;
  sequenceStatus?: "active" | "paused" | "draft";
  steps?: { delayDays: number; subject: string; body: string; threadWithPrevious?: boolean }[];
}

async function seed(opts: SeedOptions = {}) {
  const workspaceId = randomUUID();
  const userId = await withIdentity(handle.db, async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({ email: `rep-${randomUUID()}@acme.com`, name: "Riley Rep", passwordHash: "x" })
      .returning();
    return u!.id;
  });
  return withTenant(handle.db, { workspaceId }, async (tx) => {
    await tx.insert(workspaces).values({
      id: workspaceId,
      name: "Acme Tools",
      trialEndsAt: new Date(),
      mailingAddress:
        opts.mailingAddress === undefined
          ? "1 Main St, Jersey City, NJ 07302"
          : opts.mailingAddress,
    });
    await tx.insert(workspaceMembers).values({ workspaceId, userId, role: "owner" });
    const [mailbox] = await tx
      .insert(mailboxes)
      .values({
        workspaceId,
        userId,
        provider: "smtp",
        email: "riley@acme.com",
        displayName: "Riley from Acme",
        dailyCap: opts.dailyCap ?? 50,
        smtpHost: "smtp.acme.com",
        smtpPort: 587,
        smtpSecure: false,
        secretSealed: sealJson({ kind: "smtp", username: "u", password: "p" }, KEY, workspaceId),
      })
      .returning();
    const [contact] = await tx
      .insert(contacts)
      .values({
        workspaceId,
        email: opts.email ?? "jane@buyer.com",
        firstName: "Jane",
        country: opts.country === undefined ? "US" : opts.country,
        timeZone: opts.timeZone === undefined ? "America/New_York" : opts.timeZone,
      })
      .returning();
    const [sequence] = await tx
      .insert(sequences)
      .values({ workspaceId, name: "Intro", status: opts.sequenceStatus ?? "active" })
      .returning();
    const steps = opts.steps ?? [
      {
        delayDays: 0,
        subject: "Quick question, {{firstName|there}}",
        body: "Hi {{firstName}}, ...",
      },
      { delayDays: 3, subject: "Following up", body: "Bumping this up.", threadWithPrevious: true },
    ];
    await tx.insert(sequenceSteps).values(
      steps.map((s, i) => ({
        workspaceId,
        sequenceId: sequence!.id,
        position: i + 1,
        delayDays: s.delayDays,
        subject: s.subject,
        body: s.body,
        threadWithPrevious: s.threadWithPrevious ?? true,
      })),
    );
    const [enrollment] = await tx
      .insert(enrollments)
      .values({
        workspaceId,
        sequenceId: sequence!.id,
        contactId: contact!.id,
        mailboxId: mailbox!.id,
        nextRunAt: new Date(Date.now() - 60_000),
      })
      .returning();
    return { workspaceId, userId, mailbox: mailbox!, contact: contact!, enrollment: enrollment! };
  });
}

function sequencer(overrides: Partial<SequencerOptions> = {}) {
  return createSequencer({
    db: handle.db,
    secretsKey: KEY,
    unsubscribeSecret: SECRET,
    webUrl: "https://app.openline.test",
    outreach: { mode: "capture" },
    now: () => WED_10AM_NY,
    random: () => 0,
    logger: { warn: () => undefined, error: () => undefined },
    ...overrides,
  });
}

async function enrollment(workspaceId: string, id: string): Promise<Enrollment> {
  return withTenant(handle.db, { workspaceId }, async (tx) => {
    const [row] = await tx.select().from(enrollments).where(eq(enrollments.id, id));
    return row!;
  });
}

/** Runs the engine until it has nothing due for this test (other tests' rows may be due too). */
async function runFor(s: ReturnType<typeof sequencer>) {
  await s.runOnce(500);
}

describe("sending engine", () => {
  it("sends step 1 with the compliance footer and one-click unsubscribe, then schedules step 2", async () => {
    const { workspaceId, enrollment: e } = await seed();
    await runFor(sequencer());

    const sent = CaptureAdapter.outbox.find((m) => m.to === "jane@buyer.com");
    expect(sent).toBeDefined();
    expect(sent!.subject).toBe("Quick question, Jane");
    expect(sent!.from).toEqual({ email: "riley@acme.com", name: "Riley from Acme" });
    expect(sent!.text).toContain("1 Main St, Jersey City, NJ 07302");
    expect(sent!.text).toContain("https://app.openline.test/u/");
    expect(sent!.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(sent!.headers["List-Unsubscribe"]).toContain("/api/v1/public/unsubscribe/");

    const after = await enrollment(workspaceId, e.id);
    expect(after.state).toBe("active");
    expect(after.nextPosition).toBe(2);
    expect(after.nextRunAt?.toISOString()).toBe("2026-11-21T15:00:00.000Z"); // +3 days
    expect(after.threadMessageId).toBe(sent!.messageId);
  });

  it("threads follow-ups as a reply and completes after the last step", async () => {
    const { workspaceId, enrollment: e } = await seed({ email: "thread@buyer.com" });
    const s = sequencer();
    await runFor(s);
    const first = CaptureAdapter.outbox.find((m) => m.to === "thread@buyer.com")!;

    // Make step 2 due now.
    await withTenant(handle.db, { workspaceId }, (tx) =>
      tx
        .update(enrollments)
        .set({ nextRunAt: new Date(Date.now() - 1000) })
        .where(eq(enrollments.id, e.id)),
    );
    await runFor(
      sequencer({ now: () => new Date(WED_10AM_NY.getTime() + 6 * 86_400_000) /* next Tuesday */ }),
    );
    const second = CaptureAdapter.outbox.filter((m) => m.to === "thread@buyer.com")[1]!;
    expect(second.subject).toBe(`Re: ${first.subject}`);
    expect(second.inReplyTo).toBe(first.messageId);

    const after = await enrollment(workspaceId, e.id);
    expect(after.state).toBe("completed");
    expect(after.nextRunAt).toBeNull();
  });

  it("waits for the contact's business hours (Saturday → Monday 9:00 local)", async () => {
    const { workspaceId, enrollment: e } = await seed({ email: "weekend@buyer.com" });
    await runFor(sequencer({ now: () => new Date("2026-11-21T17:00:00Z") })); // Sat noon NY
    expect(CaptureAdapter.outbox.some((m) => m.to === "weekend@buyer.com")).toBe(false);
    const after = await enrollment(workspaceId, e.id);
    expect(after.lastDecision).toBe("outside_send_window");
    expect(after.nextRunAt?.toISOString()).toBe("2026-11-23T14:00:00.000Z");
    expect(after.lockedUntil).toBeNull();
  });

  it("never emails a suppressed domain", async () => {
    const { workspaceId, enrollment: e } = await seed({ email: "ceo@blocked.io" });
    await withTenant(handle.db, { workspaceId }, (tx) =>
      tx.insert(suppressions).values({ workspaceId, value: "@blocked.io", reason: "competitor" }),
    );
    await runFor(sequencer());
    expect(CaptureAdapter.outbox.some((m) => m.to === "ceo@blocked.io")).toBe(false);
    const after = await enrollment(workspaceId, e.id);
    expect(after.state).toBe("stopped");
    expect(after.lastDecision).toBe("suppressed");
  });

  it("requires consent for Canadian contacts (CASL), and sends once it's recorded", async () => {
    const blocked = await seed({ email: "a@shop.ca", country: null, timeZone: "America/Toronto" });
    await runFor(sequencer());
    expect((await enrollment(blocked.workspaceId, blocked.enrollment.id)).lastDecision).toBe(
      "no_consent",
    );

    const ok = await seed({ email: "b@shop.ca", country: "CA", timeZone: "America/Toronto" });
    await withTenant(handle.db, { workspaceId: ok.workspaceId }, (tx) =>
      tx.insert(consents).values({
        workspaceId: ok.workspaceId,
        contactId: ok.contact.id,
        basis: "express",
        source: "Signed up at trade show",
        obtainedAt: new Date("2026-10-01T00:00:00Z"),
      }),
    );
    await runFor(sequencer());
    expect(CaptureAdapter.outbox.some((m) => m.to === "b@shop.ca")).toBe(true);
  });

  it("holds sending until the workspace has a postal address (CAN-SPAM)", async () => {
    const { workspaceId, enrollment: e } = await seed({
      email: "noaddr@buyer.com",
      mailingAddress: null,
    });
    await runFor(sequencer());
    expect(CaptureAdapter.outbox.some((m) => m.to === "noaddr@buyer.com")).toBe(false);
    expect((await enrollment(workspaceId, e.id)).lastDecision).toBe("mailing_address_missing");
  });

  it("respects the mailbox daily cap and spacing between sends", async () => {
    const capped = await seed({ email: "cap@buyer.com", dailyCap: 1 });
    await withTenant(handle.db, { workspaceId: capped.workspaceId }, (tx) =>
      tx.insert(messages).values({
        workspaceId: capped.workspaceId,
        mailboxId: capped.mailbox.id,
        messageIdHeader: "<x@acme.com>",
        subject: "earlier",
        sentAt: new Date(WED_10AM_NY.getTime() - 2 * 3600_000),
      }),
    );
    await runFor(sequencer());
    expect((await enrollment(capped.workspaceId, capped.enrollment.id)).lastDecision).toBe(
      "mailbox_daily_cap",
    );

    const spaced = await seed({ email: "space@buyer.com" });
    await withTenant(handle.db, { workspaceId: spaced.workspaceId }, (tx) =>
      tx.insert(messages).values({
        workspaceId: spaced.workspaceId,
        mailboxId: spaced.mailbox.id,
        messageIdHeader: "<y@acme.com>",
        subject: "just now",
        sentAt: new Date(WED_10AM_NY.getTime() - 20_000),
      }),
    );
    await runFor(sequencer());
    const after = await enrollment(spaced.workspaceId, spaced.enrollment.id);
    expect(after.lastDecision).toBe("mailbox_spacing");
    expect(after.nextRunAt!.getTime()).toBe(WED_10AM_NY.getTime() - 20_000 + 60_000);
  });

  it("defers while the sequence is paused", async () => {
    const { workspaceId, enrollment: e } = await seed({
      email: "paused@buyer.com",
      sequenceStatus: "paused",
    });
    await runFor(sequencer());
    expect((await enrollment(workspaceId, e.id)).lastDecision).toBe("sequence_paused");
  });

  it("marks hard bounces, pauses mailboxes on auth failure, and backs off on temporary errors", async () => {
    const failing = (kind: SendError["kind"]): MailAdapter => ({
      provider: "smtp",
      verify: async () => undefined,
      send: async () => {
        throw new SendError(`fail ${kind}`, kind);
      },
    });

    const bounce = await seed({ email: "nobody@buyer.com" });
    await runFor(sequencer({ adapterFor: () => failing("permanent") }));
    expect((await enrollment(bounce.workspaceId, bounce.enrollment.id)).state).toBe("bounced");
    const [c] = await withTenant(handle.db, { workspaceId: bounce.workspaceId }, (tx) =>
      tx.select().from(contacts).where(eq(contacts.id, bounce.contact.id)),
    );
    expect(c!.status).toBe("bounced");

    const auth = await seed({ email: "auth@buyer.com" });
    await runFor(sequencer({ adapterFor: () => failing("auth") }));
    expect((await enrollment(auth.workspaceId, auth.enrollment.id)).lastDecision).toBe(
      "mailbox_error",
    );
    const [mb] = await withTenant(handle.db, { workspaceId: auth.workspaceId }, (tx) =>
      tx.select().from(mailboxes).where(eq(mailboxes.id, auth.mailbox.id)),
    );
    expect(mb!.status).toBe("error");

    const flaky = await seed({ email: "flaky@buyer.com" });
    await runFor(sequencer({ adapterFor: () => failing("transient") }));
    const after = await enrollment(flaky.workspaceId, flaky.enrollment.id);
    expect(after.state).toBe("active");
    expect(after.attempts).toBe(1);
    expect(after.lastDecision).toBe("retrying");
    expect(after.nextRunAt!.getTime()).toBe(WED_10AM_NY.getTime() + 5 * 60_000);
  });

  it("never sends the same step twice when two runs overlap", async () => {
    await seed({ email: "once@buyer.com" });
    const s = sequencer();
    await Promise.all([s.runOnce(500), s.runOnce(500), s.runOnce(500)]);
    expect(CaptureAdapter.outbox.filter((m) => m.to === "once@buyer.com")).toHaveLength(1);
  });

  /** Sends like CaptureAdapter, but runs `during` first for one recipient (simulates a slow send). */
  function adapterWith(to: string, during: () => Promise<void>): MailAdapter {
    const capture = new CaptureAdapter();
    return {
      provider: "smtp",
      verify: async () => undefined,
      send: async (email) => {
        if (email.to === to) await during();
        return capture.send(email);
      },
    };
  }

  async function messagesFor(workspaceId: string) {
    return withTenant(handle.db, { workspaceId }, (tx) => tx.select().from(messages));
  }

  it.each(["stopped", "replied", "paused"] as const)(
    "a %s made while a step is being sent wins, and the step is never repeated",
    async (state) => {
      const email = `race-${state}@buyer.com`;
      const { workspaceId, enrollment: e } = await seed({ email });
      await runFor(
        sequencer({
          adapterFor: () =>
            adapterWith(email, () =>
              withTenant(handle.db, { workspaceId }, async (tx) => {
                await tx.update(enrollments).set({ state }).where(eq(enrollments.id, e.id));
              }),
            ),
        }),
      );
      const after = await enrollment(workspaceId, e.id);
      expect(after.state).toBe(state);
      expect(after.nextPosition).toBe(2); // resuming continues with step 2, not step 1 again
      expect(after.lockedUntil).toBeNull();
      expect((await messagesFor(workspaceId)).map((m) => m.status)).toEqual(["sent"]);
    },
  );

  it("records the send and keeps going when the contact is deleted mid-send", async () => {
    const gone = await seed({ email: "deleted-mid-send@buyer.com" });
    const other = await seed({ email: "still-here@buyer.com" });
    await runFor(
      sequencer({
        adapterFor: () =>
          adapterWith("deleted-mid-send@buyer.com", () =>
            withTenant(handle.db, { workspaceId: gone.workspaceId }, async (tx) => {
              await tx.delete(contacts).where(eq(contacts.id, gone.contact.id));
            }),
          ),
      }),
    );
    const recorded = await messagesFor(gone.workspaceId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ status: "sent", contactId: null });
    expect((await enrollment(other.workspaceId, other.enrollment.id)).nextPosition).toBe(2);
  });

  it("a second worker can't send a step whose lease ran out during a slow send", async () => {
    const email = "slow-send@buyer.com";
    const { workspaceId, enrollment: e } = await seed({ email });
    const second = sequencer();
    await runFor(
      sequencer({
        adapterFor: () =>
          adapterWith(email, async () => {
            await withTenant(handle.db, { workspaceId }, (tx) =>
              tx
                .update(enrollments)
                .set({ lockedUntil: new Date(Date.now() - 1000) })
                .where(eq(enrollments.id, e.id)),
            );
            await second.runOnce(500); // claims it again while the first send is in flight
          }),
      }),
    );
    expect(CaptureAdapter.outbox.filter((m) => m.to === email)).toHaveLength(1);
    expect(await messagesFor(workspaceId)).toHaveLength(1);
    const after = await enrollment(workspaceId, e.id);
    expect(after.nextPosition).toBe(2);
    expect(after.lastDecision).toBe("sent");
  });

  it("an out-of-office recorded during an in-flight send keeps its later resume date (M1)", async () => {
    const email = "ooo-mid-send@buyer.com";
    const { workspaceId, enrollment: e } = await seed({ email });
    const resume = new Date("2026-12-08T12:00:00Z");
    await runFor(
      sequencer({
        adapterFor: () =>
          adapterWith(email, () =>
            // What reply detection does when the auto-reply lands while step 1 is being sent.
            withTenant(handle.db, { workspaceId }, async (tx) => {
              await tx
                .update(enrollments)
                .set({ nextRunAt: resume, lastDecision: "out_of_office" })
                .where(eq(enrollments.id, e.id));
            }),
          ),
      }),
    );
    const after = await enrollment(workspaceId, e.id);
    expect(after.nextPosition).toBe(2);
    expect(after.state).toBe("active");
    expect(after.lastDecision).toBe("out_of_office");
    expect(after.nextRunAt?.toISOString()).toBe(resume.toISOString());
  });

  it("never re-sends a step whose sender died mid-send; flags it for a person instead", async () => {
    const email = "unconfirmed@buyer.com";
    const { workspaceId, enrollment: e, contact, mailbox } = await seed({ email });
    await withTenant(handle.db, { workspaceId }, (tx) =>
      tx.insert(messages).values({
        workspaceId,
        enrollmentId: e.id,
        contactId: contact.id,
        mailboxId: mailbox.id,
        stepPosition: 1,
        messageIdHeader: "<ol.dead@acme.com>",
        subject: "Quick question, Jane",
        sentAt: new Date(WED_10AM_NY.getTime() - 20 * 60_000),
        status: "sending",
      }),
    );
    await runFor(sequencer());
    expect(CaptureAdapter.outbox.filter((m) => m.to === email)).toHaveLength(0);
    const after = await enrollment(workspaceId, e.id);
    expect(after).toMatchObject({ state: "error", lastDecision: "send_unconfirmed" });
    expect((await messagesFor(workspaceId))[0]!.status).toBe("unconfirmed");
  });

  it("moves on without re-sending when a step was sent but not yet recorded", async () => {
    const email = "sent-not-advanced@buyer.com";
    const { workspaceId, enrollment: e, contact, mailbox } = await seed({ email });
    await withTenant(handle.db, { workspaceId }, (tx) =>
      tx.insert(messages).values({
        workspaceId,
        enrollmentId: e.id,
        contactId: contact.id,
        mailboxId: mailbox.id,
        stepPosition: 1,
        messageIdHeader: "<ol.done@acme.com>",
        subject: "Quick question, Jane",
        status: "sent",
      }),
    );
    await runFor(sequencer());
    expect(CaptureAdapter.outbox.filter((m) => m.to === email)).toHaveLength(0);
    const after = await enrollment(workspaceId, e.id);
    expect(after).toMatchObject({ state: "active", nextPosition: 2, lastDecision: "sent" });
    expect(after.threadMessageId).toBe("<ol.done@acme.com>");
  });

  it("refuses to connect to an SMTP host on a private address in real mode (SSRF)", async () => {
    const { workspaceId, enrollment: e, mailbox } = await seed({ email: "ssrf@buyer.com" });
    await withTenant(handle.db, { workspaceId }, (tx) =>
      tx.update(mailboxes).set({ smtpHost: "127.0.0.1" }).where(eq(mailboxes.id, mailbox.id)),
    );
    await runFor(sequencer({ outreach: { mode: "real" } }));
    expect((await enrollment(workspaceId, e.id)).lastDecision).toBe("mailbox_error");
    const [mb] = await withTenant(handle.db, { workspaceId }, (tx) =>
      tx.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id)),
    );
    expect(mb!.status).toBe("error");
    expect(await messagesFor(workspaceId)).toHaveLength(0); // reservation handed back
  });
});

describe("real SMTP delivery (sandbox transport)", () => {
  let server: SMTPServer;
  let port = 0;
  const received: string[] = [];

  beforeAll(async () => {
    server = new SMTPServer({
      authOptional: true,
      disabledCommands: ["STARTTLS"],
      logger: false,
      onData(stream, _session, callback) {
        let raw = "";
        stream.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
        stream.on("end", () => {
          received.push(raw);
          callback();
        });
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("delivers a standards-compliant email over SMTP", async () => {
    await seed({ email: "smtp-test@buyer.com" });
    await sequencer({
      outreach: {
        mode: "sandbox",
        smtp: { host: "127.0.0.1", port, secure: false, requireTls: false },
      },
    }).runOnce(500);

    const raw = received.find((r) => r.includes("smtp-test@buyer.com"));
    expect(raw).toBeDefined();
    expect(raw).toMatch(/^From: "?Riley from Acme"? <riley@acme\.com>/m);
    expect(raw).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m);
    expect(raw).toMatch(/^Message-ID: <ol\.[0-9a-f]+@acme\.com>/m);
    expect(raw).toContain("Jersey City");
  });
});

describe("replies stop the sequence", () => {
  async function inbound(
    workspaceId: string,
    e: Enrollment,
    receivedAt: Date,
    label: "interested" | "out_of_office",
  ) {
    await withTenant(handle.db, { workspaceId }, (tx) =>
      tx.insert(messages).values({
        workspaceId,
        enrollmentId: e.id,
        contactId: e.contactId,
        mailboxId: e.mailboxId,
        direction: "inbound",
        status: "received",
        messageIdHeader: `<${randomUUID()}@buyer.com>`,
        subject: "Re: Quick question",
        fromEmail: "jane@buyer.com",
        receivedAt,
        sentAt: receivedAt,
        label,
        labelSource: "rule",
      }),
    );
  }

  it("ends the enrollment as replied instead of sending when a reply came after the last step", async () => {
    const { workspaceId, enrollment: e } = await seed();
    const s = sequencer();
    await runFor(s); // step 1
    expect(CaptureAdapter.outbox).toHaveLength(1);
    // Step 2 is due, but Jane answered after step 1 (reply sync hasn't moved the enrollment yet).
    await withTenant(handle.db, { workspaceId }, (tx) =>
      tx
        .update(enrollments)
        .set({ nextRunAt: new Date(Date.now() - 60_000) })
        .where(eq(enrollments.id, e.id)),
    );
    await inbound(workspaceId, e, new Date(WED_10AM_NY.getTime() + 1000), "interested");
    await runFor(s);
    expect(CaptureAdapter.outbox).toHaveLength(1);
    const after = await enrollment(workspaceId, e.id);
    expect(after.state).toBe("replied");
    expect(after.lastDecision).toBe("reply_received");
  });

  it("an out-of-office or a reply older than the last step does not stop it", async () => {
    const { workspaceId, enrollment: e } = await seed();
    await inbound(workspaceId, e, new Date(WED_10AM_NY.getTime() - 60 * 60_000), "interested");
    await inbound(workspaceId, e, new Date(WED_10AM_NY.getTime() - 1000), "out_of_office");
    // No step sent yet: any earlier human reply counts, so this one ends it.
    await runFor(sequencer());
    expect((await enrollment(workspaceId, e.id)).state).toBe("replied");

    const second = await seed();
    await inbound(
      second.workspaceId,
      second.enrollment,
      new Date(WED_10AM_NY.getTime() - 1000),
      "out_of_office",
    );
    await runFor(sequencer());
    expect(CaptureAdapter.outbox.filter((m) => m.to === "jane@buyer.com")).toHaveLength(1);
    expect((await enrollment(second.workspaceId, second.enrollment.id)).state).toBe("active");
  });
});

describe("compliance proof (OL-E6)", () => {
  async function outbound(workspaceId: string, enrollmentId: string) {
    return withTenant(handle.db, { workspaceId }, (tx) =>
      tx.select().from(messages).where(eq(messages.enrollmentId, enrollmentId)),
    );
  }

  it("stores the evaluation that allowed the send on the message, without the body or address", async () => {
    const { workspaceId, enrollment: e } = await seed({ email: "proof@buyer.com" });
    await runFor(sequencer());
    const [m] = await outbound(workspaceId, e.id);
    expect(m?.status).toBe("sent");
    const proof = m!.complianceProof!;
    expect(proof.decision).toBe("allowed");
    expect(proof.rulesetVersion).toBe(RULESET_VERSION);
    expect(proof.evaluatedAt).toBe(WED_10AM_NY.toISOString());
    expect(proof.jurisdiction).toBe("US");
    expect(proof.checks.map((c) => [c.rule, c.outcome])).toEqual([
      ["suppression", "pass"],
      ["contact_status", "pass"],
      ["consent_ca", "not_applicable"],
      ["basis_eu", "not_applicable"],
      ["sender_identity", "pass"],
      ["unsubscribe_mechanism", "pass"],
      ["send_window", "pass"],
    ]);
    const json = JSON.stringify(proof);
    expect(json).not.toContain("proof@buyer.com");
    expect(json).not.toContain("Hi Jane");
  });

  it("records the CASL check in the proof once consent is on file", async () => {
    const ok = await seed({ email: "proof@shop.ca", country: "CA", timeZone: "America/Toronto" });
    await withTenant(handle.db, { workspaceId: ok.workspaceId }, (tx) =>
      tx.insert(consents).values({
        workspaceId: ok.workspaceId,
        contactId: ok.contact.id,
        basis: "express",
        source: "Web form",
        obtainedAt: new Date("2026-10-01T00:00:00Z"),
      }),
    );
    await runFor(sequencer());
    const [m] = await outbound(ok.workspaceId, ok.enrollment.id);
    const casl = m!.complianceProof!.checks.find((c) => c.rule === "consent_ca");
    expect(casl?.outcome).toBe("pass");
    expect(casl?.citation).toContain("CASL s. 6");
  });

  it("keeps the no_consent reason text and stores no message when blocked", async () => {
    const blocked = await seed({ email: "noproof@firma.de", country: "DE", timeZone: "UTC" });
    await runFor(sequencer());
    const after = await enrollment(blocked.workspaceId, blocked.enrollment.id);
    expect(after.state).toBe("stopped");
    expect(after.lastDecision).toBe("no_consent");
    expect(after.lastError).toBe(
      "GDPR: record a lawful basis (consent or legitimate interest) first.",
    );
    expect(await outbound(blocked.workspaceId, blocked.enrollment.id)).toEqual([]);
  });

  it.each([
    ["unsubscribed", "unsubscribed", "unsubscribed"],
    ["bounced", "bounced", "bounced"],
    ["archived", "stopped", "contact_archived"],
  ] as const)("a %s contact ends as %s (%s)", async (status, state, decision) => {
    const s = await seed({ email: `${status}-status@buyer.com` });
    await withTenant(handle.db, { workspaceId: s.workspaceId }, (tx) =>
      tx.update(contacts).set({ status }).where(eq(contacts.id, s.contact.id)),
    );
    await runFor(sequencer());
    const after = await enrollment(s.workspaceId, s.enrollment.id);
    expect([after.state, after.lastDecision]).toEqual([state, decision]);
  });

  it("an unsubscribe-reason suppression ends the enrollment as unsubscribed", async () => {
    const s = await seed({ email: "optout@buyer.com" });
    await withTenant(handle.db, { workspaceId: s.workspaceId }, (tx) =>
      tx
        .insert(suppressions)
        .values({ workspaceId: s.workspaceId, value: "optout@buyer.com", reason: "unsubscribed" }),
    );
    await runFor(sequencer());
    const after = await enrollment(s.workspaceId, s.enrollment.id);
    expect([after.state, after.lastDecision]).toEqual(["unsubscribed", "suppressed"]);
  });

  it("an unknown contact time zone is an internal error, retried in 15 minutes", async () => {
    const s = await seed({ email: "badzone@buyer.com", timeZone: "Mars/Olympus" });
    await runFor(sequencer());
    const after = await enrollment(s.workspaceId, s.enrollment.id);
    expect(after.state).toBe("active");
    expect(after.lastDecision).toBe("internal_error");
    expect(after.nextRunAt?.toISOString()).toBe(
      new Date(WED_10AM_NY.getTime() + 15 * 60_000).toISOString(),
    );
  });
});
