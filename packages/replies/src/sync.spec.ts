import { randomBytes, randomUUID } from "node:crypto";
import {
  aiUsage,
  and,
  auditLog,
  companies,
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
} from "@openline/db";
import { AiError, FakeProvider } from "@openline/ai";
import { sealJson } from "@openline/email";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bounceReport, rawEmail } from "./__fixtures__/mail";
import { createScoutReplyClassifier } from "./scout";
import { createReplySync } from "./sync";
import {
  ReadError,
  type MailboxReader,
  type RawInbound,
  type ReplyClassifier,
  type ReplySyncOptions,
  type SyncCursor,
} from "./types";

const KEY = randomBytes(32);
/** Wednesday 2026-11-18 16:00 UTC. */
const NOW = new Date("2026-11-18T16:00:00Z");
const quiet = { warn: () => undefined, error: () => undefined };

let handle: DatabaseHandle;
beforeAll(async () => {
  handle = createDatabase("pglite://memory");
  await migrate(handle);
});
afterAll(async () => {
  await handle.close();
});

/** What the fake reader returns per mailbox id. */
const inboxes = new Map<string, { messages: RawInbound[]; cursor?: SyncCursor; error?: Error }>();
const reads: { mailboxId: string; cursor: SyncCursor }[] = [];
const fakeReaderFor = (mailbox: { id: string }): MailboxReader => ({
  async read(cursor) {
    reads.push({ mailboxId: mailbox.id, cursor });
    const box = inboxes.get(mailbox.id);
    if (box?.error) throw box.error;
    return {
      messages: box?.messages ?? [],
      cursor: box?.cursor ?? { uidValidity: 1, lastUid: 99 },
    };
  },
});

function sync(overrides: Partial<ReplySyncOptions> = {}) {
  return createReplySync({
    db: handle.db,
    secretsKey: KEY,
    readerFor: fakeReaderFor,
    now: () => NOW,
    logger: quiet,
    ...overrides,
  });
}

async function seed(
  opts: { contactEmail?: string; companyDomain?: string; secondSequence?: boolean } = {},
) {
  const workspaceId = randomUUID();
  const userId = await withIdentity(handle.db, async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({ email: `rep-${randomUUID()}@acme.com`, name: "Riley", passwordHash: "x" })
      .returning();
    return u!.id;
  });
  return withTenant(handle.db, { workspaceId }, async (tx) => {
    await tx.insert(workspaces).values({ id: workspaceId, name: "Acme", trialEndsAt: NOW });
    await tx.insert(workspaceMembers).values({ workspaceId, userId, role: "owner" });
    const [mailbox] = await tx
      .insert(mailboxes)
      .values({
        workspaceId,
        userId,
        provider: "smtp",
        email: "riley@acme.com",
        smtpHost: "smtp.acme.com",
        smtpPort: 587,
        smtpSecure: false,
        imapHost: "imap.acme.com",
        imapPort: 993,
        imapSecure: true,
        replyDetection: "on",
        secretSealed: sealJson({ kind: "smtp", username: "u", password: "p" }, KEY, workspaceId),
      })
      .returning();
    const [company] = await tx
      .insert(companies)
      .values({ workspaceId, name: "Buyer Inc", domain: opts.companyDomain ?? "buyer.com" })
      .returning();
    const [contact] = await tx
      .insert(contacts)
      .values({
        workspaceId,
        email: opts.contactEmail ?? "jane@buyer.com",
        firstName: "Jane",
        companyId: company!.id,
        country: "US",
      })
      .returning();
    await tx.insert(consents).values({
      workspaceId,
      contactId: contact!.id,
      basis: "legitimate_interest",
      source: "test",
      obtainedAt: NOW,
    });

    const enroll = async (name: string) => {
      const [sequence] = await tx
        .insert(sequences)
        .values({ workspaceId, name, status: "active" })
        .returning();
      await tx.insert(sequenceSteps).values([
        { workspaceId, sequenceId: sequence!.id, position: 1, subject: "Hi", body: "Hi" },
        {
          workspaceId,
          sequenceId: sequence!.id,
          position: 2,
          delayDays: 3,
          subject: "F",
          body: "F",
        },
      ]);
      const [enrollment] = await tx
        .insert(enrollments)
        .values({
          workspaceId,
          sequenceId: sequence!.id,
          contactId: contact!.id,
          mailboxId: mailbox!.id,
          nextPosition: 2,
          nextRunAt: new Date(NOW.getTime() + 2 * 86_400_000),
        })
        .returning();
      const messageId = `<ol.${randomUUID()}@acme.com>`;
      const [sent] = await tx
        .insert(messages)
        .values({
          workspaceId,
          enrollmentId: enrollment!.id,
          contactId: contact!.id,
          mailboxId: mailbox!.id,
          stepPosition: 1,
          messageIdHeader: messageId,
          subject: "Hi",
          sentAt: new Date(NOW.getTime() - 86_400_000),
        })
        .returning();
      return { enrollment: enrollment!, messageId, sentId: sent!.id };
    };
    const first = await enroll("Intro");
    const second = opts.secondSequence ? await enroll("Webinar") : null;
    return { workspaceId, userId, mailbox: mailbox!, contact: contact!, first, second };
  });
}

type Seeded = Awaited<ReturnType<typeof seed>>;

const inbound = (s: Seeded) =>
  withTenant(handle.db, { workspaceId: s.workspaceId }, (tx) =>
    tx
      .select()
      .from(messages)
      .where(and(eq(messages.workspaceId, s.workspaceId), eq(messages.direction, "inbound"))),
  );
const enrollmentState = (s: Seeded, id: string) =>
  withTenant(handle.db, { workspaceId: s.workspaceId }, async (tx) => {
    const [row] = await tx.select().from(enrollments).where(eq(enrollments.id, id));
    return row!;
  });
const mailboxRow = (s: Seeded) =>
  withTenant(handle.db, { workspaceId: s.workspaceId }, async (tx) => {
    const [row] = await tx.select().from(mailboxes).where(eq(mailboxes.id, s.mailbox.id));
    return row!;
  });
const contactRow = (s: Seeded) =>
  withTenant(handle.db, { workspaceId: s.workspaceId }, async (tx) => {
    const [row] = await tx.select().from(contacts).where(eq(contacts.id, s.contact.id));
    return row!;
  });

const mail = (raw: Buffer, checkpoint?: SyncCursor): RawInbound => ({ raw, checkpoint });

describe("reply sync", () => {
  it("a threaded reply stops every open enrollment of the contact, once (idempotent)", async () => {
    const s = await seed({ secondSequence: true });
    const reply = rawEmail({
      messageId: "<jane-reply-1@buyer.com>",
      inReplyTo: s.first.messageId,
      references: s.first.messageId,
      text: "Yes, let's talk Tuesday.\n\nOn Tue, Riley wrote:\n> Hi Jane",
    });
    inboxes.set(s.mailbox.id, { messages: [mail(reply)], cursor: { uidValidity: 3, lastUid: 41 } });

    const summary = await sync().syncMailbox(s.workspaceId, s.mailbox.id);
    expect(summary).toMatchObject({ stored: 1, synced: 1 });

    const [row] = await inbound(s);
    expect(row).toMatchObject({
      enrollmentId: s.first.enrollment.id,
      contactId: s.contact.id,
      stepPosition: 1,
      matchKind: "thread",
      replyToId: s.first.sentId,
      fromEmail: "jane@buyer.com",
      bodyText: "Yes, let's talk Tuesday.",
      label: "other",
      labelSource: "rule",
      status: "received",
      handledAt: null,
    });
    for (const id of [s.first.enrollment.id, s.second!.enrollment.id]) {
      const e = await enrollmentState(s, id);
      expect(e).toMatchObject({
        state: "replied",
        lastDecision: "reply_received",
        nextRunAt: null,
      });
    }
    const mb = await mailboxRow(s);
    expect(mb).toMatchObject({ syncUidValidity: 3, syncLastUid: 41, lastSyncError: null });
    expect(mb.lastSyncedAt?.toISOString()).toBe(NOW.toISOString());

    // Read again (e.g. the cursor was lost): nothing new is stored, nothing changes.
    const again = await sync().syncMailbox(s.workspaceId, s.mailbox.id);
    expect(again).toMatchObject({ stored: 0, duplicates: 1 });
    expect(await inbound(s)).toHaveLength(1);
    const audits = await withTenant(handle.db, { workspaceId: s.workspaceId }, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, "reply.received")),
    );
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.metadata)).not.toMatch(/jane|Tuesday/i);
  });

  it("matches by sender address when the reply lost its thread headers", async () => {
    const s = await seed();
    inboxes.set(s.mailbox.id, {
      messages: [mail(rawEmail({ subject: "Your email", text: "Interested — call me" }))],
    });
    await sync().syncMailbox(s.workspaceId, s.mailbox.id);
    const [row] = await inbound(s);
    expect(row).toMatchObject({ matchKind: "sender", enrollmentId: s.first.enrollment.id });
    expect((await enrollmentState(s, s.first.enrollment.id)).state).toBe("replied");
  });

  it("a colleague at the contact's company counts as a reply ('From a colleague')", async () => {
    const s = await seed();
    inboxes.set(s.mailbox.id, {
      messages: [
        mail(rawEmail({ from: "Sam <sam@buyer.com>", text: "Jane left; I handle this now." })),
      ],
    });
    await sync().syncMailbox(s.workspaceId, s.mailbox.id);
    const [row] = await inbound(s);
    expect(row).toMatchObject({ matchKind: "colleague", contactId: s.contact.id });
    expect((await enrollmentState(s, s.first.enrollment.id)).state).toBe("replied");
  });

  it("unmatched mail is never stored (and never classified)", async () => {
    const s = await seed();
    let classified = 0;
    const classifier: ReplyClassifier = async () => {
      classified += 1;
      return { label: "interested", confidence: 1 };
    };
    inboxes.set(s.mailbox.id, {
      messages: [
        mail(rawEmail({ from: "news@newsletter.io", text: "Weekly digest" })),
        mail(rawEmail({ from: "friend@gmail.com", text: "Lunch?" })),
        mail(rawEmail({ from: "colleague@acme.com", text: "internal" })),
      ],
    });
    const summary = await sync({ classifier }).syncMailbox(s.workspaceId, s.mailbox.id);
    expect(summary).toMatchObject({ unmatched: 3, stored: 0 });
    expect(await inbound(s)).toHaveLength(0);
    expect(classified).toBe(0);
    expect((await enrollmentState(s, s.first.enrollment.id)).state).toBe("active");
  });

  it("an out-of-office keeps the enrollment active and moves it past the return date", async () => {
    const s = await seed();
    inboxes.set(s.mailbox.id, {
      messages: [
        mail(
          rawEmail({
            inReplyTo: s.first.messageId,
            subject: "Automatic reply: Hi",
            headers: { "Auto-Submitted": "auto-replied" },
            text: "I'm out of the office and back on Monday, November 30.",
          }),
        ),
      ],
    });
    await sync().syncMailbox(s.workspaceId, s.mailbox.id);
    const e = await enrollmentState(s, s.first.enrollment.id);
    expect(e.state).toBe("active");
    expect(e.lastDecision).toBe("out_of_office");
    expect(e.nextRunAt?.toISOString()).toBe("2026-12-01T12:00:00.000Z");
    const [row] = await inbound(s);
    expect(row).toMatchObject({ label: "out_of_office", labelSource: "rule", labelConfidence: 1 });
    expect(row!.handledAt).not.toBeNull();
  });

  it("a 5.x.x bounce report marks the contact and enrollment bounced; 4.x.x is ignored", async () => {
    const s = await seed();
    inboxes.set(s.mailbox.id, {
      messages: [
        mail(bounceReport({ recipient: "jane@buyer.com", status: "4.2.2" })),
        mail(
          bounceReport({
            recipient: "jane@buyer.com",
            status: "5.1.1",
            originalMessageId: s.first.messageId,
          }),
        ),
      ],
    });
    const summary = await sync().syncMailbox(s.workspaceId, s.mailbox.id);
    expect(summary).toMatchObject({ ignored: 1, stored: 1 });
    expect((await contactRow(s)).status).toBe("bounced");
    const e = await enrollmentState(s, s.first.enrollment.id);
    expect(e.state).toBe("bounced");
    expect(e.lastError).toContain("5.1.1");
    expect((await inbound(s))[0]).toMatchObject({ label: "bounce", matchKind: "thread" });
  });

  it("a bounce report that names no message we sent is not stored and changes nothing (S2)", async () => {
    const s = await seed();
    inboxes.set(s.mailbox.id, {
      messages: [
        // Address only: anyone can write this.
        mail(bounceReport({ recipient: "jane@buyer.com", status: "5.1.1" })),
        // A forged report naming a Message-ID we never sent.
        mail(
          bounceReport({
            recipient: "jane@buyer.com",
            status: "5.1.1",
            originalMessageId: "<forged@acme.com>",
            from: "MAILER-DAEMON@evil.example",
          }),
        ),
      ],
    });
    const summary = await sync().syncMailbox(s.workspaceId, s.mailbox.id);
    expect(summary).toMatchObject({ unmatched: 2, stored: 0 });
    expect(await inbound(s)).toHaveLength(0);
    expect((await contactRow(s)).status).toBe("active");
    expect((await enrollmentState(s, s.first.enrollment.id)).state).toBe("active");
  });

  it("a bounce for another address (a forward) than the contact's changes nothing (M4)", async () => {
    const s = await seed();
    inboxes.set(s.mailbox.id, {
      messages: [
        mail(
          bounceReport({
            recipient: "jane@oldforward.com",
            status: "5.1.1",
            originalMessageId: s.first.messageId,
          }),
        ),
      ],
    });
    await sync().syncMailbox(s.workspaceId, s.mailbox.id);
    expect((await contactRow(s)).status).toBe("active");
    expect((await enrollmentState(s, s.first.enrollment.id)).state).toBe("active");
    expect(await inbound(s)).toHaveLength(0);
  });

  it.each([
    [
      "German Outlook header block",
      "Ja, gerne. Dienstag passt.\n\nVon: Riley <riley@acme.com>\nGesendet: Montag, 16. November 2026 09:00\nAn: Jane\nBetreff: Hi\n\nHi Jane\n--\nAcme · 1 Main St\nDon't want to hear from us? Unsubscribe: https://app.openline.test/u/tok123456789",
    ],
    [
      "Spanish attribution",
      "Claro, hablemos el martes.\n\nEl lun, 16 nov 2026 a las 9:00, Riley (<riley@acme.com>) escribió:\n> Hi Jane\n> --\n> Acme · 1 Main St\n> Don't want to hear from us? Unsubscribe: https://app.openline.test/u/tok123456789\n\nSaludos",
    ],
    [
      "inline answer between quoted lines",
      "> Hi Jane,\n> Short pitch.\nYes, interested!\n> --\n> Acme · 1 Main St\n> Don't want to hear from us? Unsubscribe: https://app.openline.test/u/tok123456789\n\nJane",
    ],
    [
      "Gmail attribution wrapped over three lines",
      "Sounds great\n\nOn Mon, Nov 16, 2026 at 9:00 AM Riley Smith from Acme Corporation Sales Team\n<riley@acme.com>\nwrote:\nHi Jane\n--\nAcme · 1 Main St\nDon't want to hear from us? Unsubscribe: https://app.openline.test/u/tok123456789",
    ],
  ])(
    "a reply quoting our unsubscribe footer is a reply, not an unsubscribe (H1: %s)",
    async (_name, text) => {
      const s = await seed();
      inboxes.set(s.mailbox.id, {
        messages: [mail(rawEmail({ inReplyTo: s.first.messageId, text }))],
      });
      await sync().syncMailbox(s.workspaceId, s.mailbox.id);
      const [row] = await inbound(s);
      expect(row).toMatchObject({ label: "other", labelSource: "rule" });
      expect((await enrollmentState(s, s.first.enrollment.id)).state).toBe("replied");
      expect((await contactRow(s)).status).toBe("active");
    },
  );

  it("reads return dates against the message's own date; past ones mean +7 days (M2)", async () => {
    const stale = await seed();
    inboxes.set(stale.mailbox.id, {
      messages: [
        mail(
          rawEmail({
            inReplyTo: stale.first.messageId,
            headers: { "Auto-Submitted": "auto-replied" },
            text: "I'm out of the office until Nov 16.",
          }),
        ),
      ],
    });
    await sync().syncMailbox(stale.workspaceId, stale.mailbox.id);
    expect((await enrollmentState(stale, stale.first.enrollment.id)).nextRunAt?.toISOString()).toBe(
      new Date(NOW.getTime() + 7 * 86_400_000).toISOString(),
    );

    // Written on Nov 11, read on Nov 18: "back Nov 13" is this year's, not next year's.
    const late = await seed();
    inboxes.set(late.mailbox.id, {
      messages: [
        mail(
          rawEmail({
            inReplyTo: late.first.messageId,
            date: "Wed, 11 Nov 2026 09:00:00 +0000",
            headers: { "Auto-Submitted": "auto-replied" },
            text: "Out of office, back on Nov 13.",
          }),
        ),
      ],
    });
    await sync().syncMailbox(late.workspaceId, late.mailbox.id);
    const e = await enrollmentState(late, late.first.enrollment.id);
    expect(e.lastDecision).toBe("out_of_office");
    // The resume date already passed: the existing schedule (NOW + 2 days) stands.
    expect(e.nextRunAt?.toISOString()).toBe(new Date(NOW.getTime() + 2 * 86_400_000).toISOString());
  });

  it("an implausible model return date falls back to +7 days (S3)", async () => {
    const s = await seed();
    const classifier: ReplyClassifier = async () => ({
      label: "out_of_office",
      confidence: 0.9,
      returnDate: "2099-01-01",
    });
    inboxes.set(s.mailbox.id, {
      messages: [mail(rawEmail({ inReplyTo: s.first.messageId, text: "Away for a while" }))],
    });
    await sync({ classifier }).syncMailbox(s.workspaceId, s.mailbox.id);
    expect((await enrollmentState(s, s.first.enrollment.id)).nextRunAt?.toISOString()).toBe(
      new Date(NOW.getTime() + 7 * 86_400_000).toISOString(),
    );
  });

  it("newsletters and notifications from the company's domain are not replies (M3)", async () => {
    const s = await seed();
    inboxes.set(s.mailbox.id, {
      messages: [
        mail(
          rawEmail({
            from: "Buyer Inc News <newsletter@buyer.com>",
            subject: "November product update",
            headers: {
              Precedence: "bulk",
              "List-Unsubscribe": "<https://buyer.com/u>",
              "List-Id": "news.buyer.com",
            },
            text: "Our November release is here!",
          }),
        ),
        mail(
          rawEmail({
            from: "Support <noreply@buyer.com>",
            subject: "[Ticket #123] We received your request",
            headers: { "Auto-Submitted": "auto-generated" },
            text: "Thanks, a ticket was created.",
          }),
        ),
        mail(
          rawEmail({ from: "Pat <pat@buyer.com>", headers: { "Auto-Submitted": "auto-replied" } }),
        ),
        mail(rawEmail({ from: "Jane <jane@buyer.com>", headers: { "List-Id": "jane.buyer.com" } })),
      ],
    });
    const summary = await sync().syncMailbox(s.workspaceId, s.mailbox.id);
    expect(summary).toMatchObject({ unmatched: 4, stored: 0 });
    expect((await enrollmentState(s, s.first.enrollment.id)).state).toBe("active");

    // In the thread, an auto-generated message is kept as "other", handled, and stops nothing.
    inboxes.set(s.mailbox.id, {
      messages: [
        mail(
          rawEmail({
            from: "Helpdesk <help@buyer.com>",
            inReplyTo: s.first.messageId,
            headers: { "Auto-Submitted": "auto-generated" },
            text: "Your message was received. Please remove me is not a command.",
          }),
        ),
      ],
    });
    await sync().syncMailbox(s.workspaceId, s.mailbox.id);
    const [row] = await inbound(s);
    expect(row).toMatchObject({ label: "other", labelSource: "rule", autoSubmitted: true });
    expect(row!.handledAt).not.toBeNull();
    expect((await enrollmentState(s, s.first.enrollment.id)).state).toBe("active");
  });

  it("a colleague's 'remove me' inside the thread suppresses only the colleague (M5)", async () => {
    const s = await seed();
    inboxes.set(s.mailbox.id, {
      messages: [
        mail(
          rawEmail({
            from: "Bob <bob@buyer.com>",
            inReplyTo: s.first.messageId,
            text: "Please remove me from your list.",
          }),
        ),
      ],
    });
    await sync().syncMailbox(s.workspaceId, s.mailbox.id);
    expect((await contactRow(s)).status).toBe("active");
    expect((await enrollmentState(s, s.first.enrollment.id)).state).toBe("replied");
    const sup = await withTenant(handle.db, { workspaceId: s.workspaceId }, (tx) =>
      tx.select().from(suppressions).where(eq(suppressions.workspaceId, s.workspaceId)),
    );
    expect(sup.map((x) => x.value)).toEqual(["bob@buyer.com"]);
  });

  it("stops at the deadline and saves the cursor up to the last processed message (S6)", async () => {
    const s = await seed();
    const slow: ReplyClassifier = async () => {
      await new Promise((r) => setTimeout(r, 40));
      return { label: "interested", confidence: 1 };
    };
    const other = await seed({ contactEmail: "kim@kimco.com", companyDomain: "kimco.com" });
    inboxes.set(s.mailbox.id, {
      messages: [
        mail(rawEmail({ inReplyTo: s.first.messageId }), { uidValidity: 1, lastUid: 10 }),
        mail(rawEmail({ inReplyTo: s.first.messageId }), { uidValidity: 1, lastUid: 11 }),
        mail(rawEmail({ inReplyTo: other.first.messageId }), { uidValidity: 1, lastUid: 12 }),
      ],
      cursor: { uidValidity: 1, lastUid: 12 },
    });
    const summary = await sync({ classifier: slow, maxDurationMs: 30 }).syncMailbox(
      s.workspaceId,
      s.mailbox.id,
    );
    expect(summary.stored).toBe(1);
    const mb = await mailboxRow(s);
    expect(mb.syncLastUid).toBe(10);
    expect(mb.lastSyncError).toBeNull();
    // More to read: due again right away, and the lease is released.
    expect(mb.nextSyncAt!.getTime()).toBe(NOW.getTime());
    expect(mb.syncLockedUntil).toBeNull();
  });

  it("renews the lease while processing, and stops without writing when it was lost (S6)", async () => {
    const s = await seed();
    let leaseDuringProcessing: Date | null = null;
    const classifier: ReplyClassifier = async () => {
      leaseDuringProcessing = (await mailboxRow(s)).syncLockedUntil;
      return { label: "interested", confidence: 1 };
    };
    inboxes.set(s.mailbox.id, {
      messages: [mail(rawEmail({ inReplyTo: s.first.messageId }), { uidValidity: 1, lastUid: 5 })],
    });
    await sync({ classifier }).syncMailbox(s.workspaceId, s.mailbox.id);
    expect(leaseDuringProcessing!.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);

    // The lease ran out before processing began (another worker may hold it): nothing is written.
    const lost = await seed();
    inboxes.set(lost.mailbox.id, {
      messages: [
        mail(rawEmail({ inReplyTo: lost.first.messageId }), { uidValidity: 1, lastUid: 5 }),
      ],
    });
    const expire: MailboxReader = {
      async read() {
        await withTenant(handle.db, { workspaceId: lost.workspaceId }, (tx) =>
          tx
            .update(mailboxes)
            .set({ syncLockedUntil: new Date(Date.now() - 1000) })
            .where(eq(mailboxes.id, lost.mailbox.id)),
        );
        return { messages: inboxes.get(lost.mailbox.id)!.messages, cursor: { lastUid: 5 } };
      },
    };
    const summary = await sync({ readerFor: () => expire }).syncMailbox(
      lost.workspaceId,
      lost.mailbox.id,
    );
    expect(summary).toMatchObject({ stored: 0, failed: 1 });
    expect(await inbound(lost)).toHaveLength(0);
    expect((await mailboxRow(lost)).syncLastUid).toBeNull();
  });

  it("'remove me' unsubscribes exactly like the link: suppression, contact, enrollments, consent", async () => {
    const s = await seed({ secondSequence: true });
    inboxes.set(s.mailbox.id, {
      messages: [mail(rawEmail({ inReplyTo: s.first.messageId, text: "Please remove me." }))],
    });
    await sync().syncMailbox(s.workspaceId, s.mailbox.id);
    expect((await contactRow(s)).status).toBe("unsubscribed");
    for (const id of [s.first.enrollment.id, s.second!.enrollment.id]) {
      expect((await enrollmentState(s, id)).state).toBe("unsubscribed");
    }
    await withTenant(handle.db, { workspaceId: s.workspaceId }, async (tx) => {
      const [sup] = await tx.select().from(suppressions);
      expect(sup).toMatchObject({ value: "jane@buyer.com", reason: "unsubscribed" });
      const [consent] = await tx.select().from(consents);
      expect(consent!.withdrawnAt).not.toBeNull();
    });
  });

  it("uses the injected classifier (validated), stores its summary and source", async () => {
    const s = await seed();
    const classifier: ReplyClassifier = async ({ text }) => {
      expect(text).toBe("Can you send pricing?");
      return { label: "interested", confidence: 0.92, summary: "Asks for pricing" };
    };
    inboxes.set(s.mailbox.id, {
      messages: [mail(rawEmail({ inReplyTo: s.first.messageId, text: "Can you send pricing?" }))],
    });
    await sync({ classifier }).syncMailbox(s.workspaceId, s.mailbox.id);
    const [row] = await inbound(s);
    expect(row).toMatchObject({
      label: "interested",
      labelSource: "model",
      summary: "Asks for pricing",
    });
    expect(row!.labelConfidence).toBeCloseTo(0.92);
  });

  it("never matches another workspace's outreach (tenant isolation)", async () => {
    const a = await seed({ contactEmail: "pat@other.com", companyDomain: "other.com" });
    const b = await seed();
    // A reply in A's mailbox that quotes B's Message-ID, from B's contact.
    inboxes.set(a.mailbox.id, {
      messages: [mail(rawEmail({ inReplyTo: b.first.messageId, references: b.first.messageId }))],
    });
    const summary = await sync().syncMailbox(a.workspaceId, a.mailbox.id);
    expect(summary.unmatched).toBe(1);
    expect(await inbound(a)).toHaveLength(0);
    expect(await inbound(b)).toHaveLength(0);
    expect((await enrollmentState(b, b.first.enrollment.id)).state).toBe("active");
  });

  it("a rejected login turns reply detection to 'error' and stops claiming the mailbox", async () => {
    const s = await seed();
    inboxes.set(s.mailbox.id, {
      messages: [],
      error: new ReadError("The IMAP server rejected the username or password.", "auth"),
    });
    await sync().syncMailbox(s.workspaceId, s.mailbox.id);
    const mb = await mailboxRow(s);
    expect(mb).toMatchObject({ replyDetection: "error", nextSyncAt: null });
    expect(mb.lastSyncError).toContain("rejected");

    const transient = await seed();
    inboxes.set(transient.mailbox.id, {
      messages: [],
      error: new ReadError("Google is temporarily unavailable", "transient"),
    });
    await sync().syncMailbox(transient.workspaceId, transient.mailbox.id);
    const t = await mailboxRow(transient);
    expect(t.replyDetection).toBe("on");
    expect(t.nextSyncAt!.getTime()).toBe(NOW.getTime() + 120_000);
  });

  it("keeps the cursor at the last processed message when processing fails part-way", async () => {
    const s = await seed();
    let calls = 0;
    const classifier: ReplyClassifier = async () => ({ label: "interested", confidence: 1 });
    const failing = createReplySync({
      db: handle.db,
      secretsKey: KEY,
      now: () => NOW,
      logger: quiet,
      classifier,
      readerFor: () => ({
        async read() {
          return {
            messages: [
              mail(rawEmail({ inReplyTo: s.first.messageId }), { uidValidity: 1, lastUid: 10 }),
              // Not an email at all: skipped ("ignored"), still checkpointed.
              mail(Buffer.from(""), { uidValidity: 1, lastUid: 11 }),
              {
                raw: rawEmail({ inReplyTo: s.first.messageId }),
                // Blows up while storing (after matching), like a database error would.
                get providerMessageId(): string {
                  calls += 1;
                  throw new Error("disk on fire");
                },
                checkpoint: { uidValidity: 1, lastUid: 12 },
              },
            ],
            cursor: { uidValidity: 1, lastUid: 12 },
          };
        },
      }),
    });
    const summary = await failing.syncMailbox(s.workspaceId, s.mailbox.id);
    expect(calls).toBe(1);
    expect(summary).toMatchObject({ stored: 1, failed: 1 });
    const mb = await mailboxRow(s);
    expect(mb.syncLastUid).toBe(11);
    expect(mb.lastSyncError).toMatch(/try again/);
  });

  it("runOnce claims due mailboxes across workspaces, once each (lease)", async () => {
    const s1 = await seed();
    const s2 = await seed();
    reads.length = 0;
    const runner = sync();
    await runner.runOnce(500);
    const ids = reads.map((r) => r.mailboxId);
    expect(ids).toContain(s1.mailbox.id);
    expect(ids).toContain(s2.mailbox.id);
    // Synced now; the next sync is due in REPLY_SYNC_INTERVAL_MS, so nothing to claim right away.
    reads.length = 0;
    await runner.runOnce(500);
    expect(reads.map((r) => r.mailboxId)).not.toContain(s1.mailbox.id);
  });

  it("skips mailboxes whose reply detection was turned off", async () => {
    const s = await seed();
    await withTenant(handle.db, { workspaceId: s.workspaceId }, (tx) =>
      tx.update(mailboxes).set({ replyDetection: "off" }).where(eq(mailboxes.id, s.mailbox.id)),
    );
    reads.length = 0;
    await sync().syncMailbox(s.workspaceId, s.mailbox.id);
    expect(reads).toHaveLength(0);
  });
});

describe("Scout's model as the classifier (per-workspace gate + usage ledger)", () => {
  const answer = JSON.stringify({ label: "interested", confidence: 0.9, summary: "Wants a demo" });

  async function run(s: Seeded, provider: FakeProvider) {
    inboxes.set(s.mailbox.id, {
      messages: [mail(rawEmail({ inReplyTo: s.first.messageId, text: "Please remove me" }))],
    });
    const classifier = createScoutReplyClassifier({ db: handle.db, provider, now: () => NOW });
    await sync({ classifier }).syncMailbox(s.workspaceId, s.mailbox.id);
    const [row] = await inbound(s);
    const usage = await withTenant(handle.db, { workspaceId: s.workspaceId }, (tx) =>
      tx.select().from(aiUsage),
    );
    return { row: row!, usage };
  }

  it("uses the model and records its tokens as classify_reply", async () => {
    const s = await seed();
    const provider = new FakeProvider([answer]);
    const { row, usage } = await run(s, provider);
    expect(row).toMatchObject({
      label: "interested",
      labelSource: "model",
      summary: "Wants a demo",
    });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ feature: "classify_reply", userId: null });
    expect(usage[0]!.credits).toBeGreaterThan(0);
    // The reply reached the model fenced as untrusted data.
    expect(provider.calls[0]!.messages[0]!.content).toMatch(/UNTRUSTED/i);
  });

  it("falls back to keyword rules when the model answers invalidly twice (usage still counts)", async () => {
    const s = await seed();
    const { row, usage } = await run(s, new FakeProvider(["nonsense", "still nonsense"]));
    expect(row).toMatchObject({ label: "unsubscribe", labelSource: "rule" });
    expect(usage).toHaveLength(1);
  });

  it("records the first attempt's tokens when the retry throws, then uses keyword rules (L2)", async () => {
    const s = await seed();
    const { row, usage } = await run(
      s,
      new FakeProvider(["nonsense", new AiError("unavailable", "down")]),
    );
    expect(row).toMatchObject({ label: "unsubscribe", labelSource: "rule" });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ feature: "classify_reply", mailboxId: s.mailbox.id });
  });

  it("caps model classifications per mailbox per day and at half the monthly credits (S4)", async () => {
    const s = await seed();
    const provider = new FakeProvider([answer, answer, answer]);
    const classifier = createScoutReplyClassifier({
      db: handle.db,
      provider,
      now: () => NOW,
      dailyCapPerMailbox: 1,
    });
    inboxes.set(s.mailbox.id, {
      messages: [
        mail(rawEmail({ inReplyTo: s.first.messageId, text: "Tell me more" })),
        mail(rawEmail({ inReplyTo: s.first.messageId, text: "Please remove me" })),
      ],
    });
    await sync({ classifier }).syncMailbox(s.workspaceId, s.mailbox.id);
    const rows = await inbound(s);
    expect(rows.map((r) => r.labelSource).sort()).toEqual(["model", "rule"]);
    expect(provider.calls).toHaveLength(1);

    // Classification already used half the month's credits: keyword rules, credits left for drafts.
    const half = await seed();
    await withTenant(handle.db, { workspaceId: half.workspaceId }, async (tx) => {
      await tx
        .update(workspaces)
        .set({ scoutMonthlyCredits: 100 })
        .where(eq(workspaces.id, half.workspaceId));
      await tx.insert(aiUsage).values({
        workspaceId: half.workspaceId,
        feature: "classify_reply",
        model: "fake-small",
        inputTokens: 1,
        outputTokens: 1,
        credits: 50,
        createdAt: NOW,
      });
    });
    const p2 = new FakeProvider([answer]);
    const result = await run(half, p2);
    expect(result.row.labelSource).toBe("rule");
    expect(p2.calls).toHaveLength(0);
  });

  it("never calls the model when Scout is off for the workspace or the budget is used up", async () => {
    const off = await seed();
    await withTenant(handle.db, { workspaceId: off.workspaceId }, (tx) =>
      tx.update(workspaces).set({ scoutEnabled: false }).where(eq(workspaces.id, off.workspaceId)),
    );
    const p1 = new FakeProvider([answer]);
    expect((await run(off, p1)).row.labelSource).toBe("rule");
    expect(p1.calls).toHaveLength(0);

    const broke = await seed();
    await withTenant(handle.db, { workspaceId: broke.workspaceId }, (tx) =>
      tx
        .update(workspaces)
        .set({ scoutMonthlyCredits: 0 })
        .where(eq(workspaces.id, broke.workspaceId)),
    );
    const p2 = new FakeProvider([answer]);
    const result = await run(broke, p2);
    expect(result.row).toMatchObject({ label: "unsubscribe", labelSource: "rule" });
    expect(p2.calls).toHaveLength(0);
    expect(result.usage).toHaveLength(0);
  });
});
