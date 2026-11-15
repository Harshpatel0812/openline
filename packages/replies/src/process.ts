/**
 * One inbound message: match it to our outreach, classify it, store it and apply its effects.
 *
 * Order matters for privacy and cost: matching happens BEFORE classification, so a message that
 * isn't a reply to our outreach is never stored and never shown to a model. Storing and effects run
 * in one transaction, idempotent by the (mailbox_id, Message-ID) unique index.
 */
import {
  and,
  auditLog,
  companies,
  consents,
  contacts,
  desc,
  enrollments,
  eq,
  inArray,
  isNull,
  messages,
  sql,
  suppressions,
  withTenant,
  type Db,
  type Mailbox,
  type Tx,
} from "@openline/db";
import { maybeAutoPauseMailbox } from "@openline/sequencer";
import { FREE_MAIL_DOMAINS, type MatchKind } from "@openline/shared";
import {
  anchorDate,
  classifyReply,
  deterministicLabel,
  resumeAfterOutOfOffice,
  type Classification,
} from "./classify";
import { parseInbound, type ParsedInbound } from "./parse";
import type { RawInbound, ReplyClassifier } from "./types";

const DAY = 86_400_000;
const SENDER_WINDOW_DAYS = 30;

export type ProcessOutcome = "stored" | "duplicate" | "unmatched" | "ignored";

export interface Match {
  kind: MatchKind;
  contactId: string;
  contactEmail: string;
  enrollmentId: string | null;
  /** The outbound message this answers, when known. */
  outboundId: string | null;
  stepPosition: number | null;
}

export interface ProcessContext {
  db: Db;
  workspaceId: string;
  mailbox: Mailbox;
  classifier: ReplyClassifier;
  now: Date;
}

function domainOf(email: string): string {
  return (email.split("@")[1] ?? "").toLowerCase();
}

// ------------------------------------------------------------------ matching

/** Rule 1: In-Reply-To / References (or a bounce's original Message-ID) name a message we sent. */
async function matchByThread(tx: Tx, workspaceId: string, ids: string[]): Promise<Match | null> {
  if (!ids.length) return null;
  const [row] = await tx
    .select({
      id: messages.id,
      contactId: messages.contactId,
      enrollmentId: messages.enrollmentId,
      stepPosition: messages.stepPosition,
      replyToId: messages.replyToId,
      contactEmail: contacts.email,
    })
    .from(messages)
    .innerJoin(
      contacts,
      and(eq(contacts.id, messages.contactId), eq(contacts.workspaceId, workspaceId)),
    )
    .where(
      and(
        eq(messages.workspaceId, workspaceId),
        eq(messages.direction, "outbound"),
        inArray(messages.messageIdHeader, ids),
      ),
    )
    .orderBy(desc(messages.sentAt))
    .limit(1);
  if (!row || !row.contactId) return null;
  let enrollmentId = row.enrollmentId;
  if (!enrollmentId && row.replyToId) {
    // A reply to a reply we sent from the inbox: continue that conversation's enrollment.
    const [parent] = await tx
      .select({ enrollmentId: messages.enrollmentId })
      .from(messages)
      .where(and(eq(messages.id, row.replyToId), eq(messages.workspaceId, workspaceId)));
    enrollmentId = parent?.enrollmentId ?? null;
  }
  return {
    kind: "thread",
    contactId: row.contactId,
    contactEmail: row.contactEmail,
    enrollmentId,
    outboundId: row.id,
    stepPosition: row.stepPosition,
  };
}

/**
 * Rules 2 and 3: a contact with an active/paused enrollment that sent from this mailbox in the last
 * 30 days, whose email (or whose company's domain) is the sender's.
 */
async function matchByEnrollment(
  tx: Tx,
  workspaceId: string,
  mailboxId: string,
  by: { email: string } | { domain: string },
  now: Date,
): Promise<Match | null> {
  const since = new Date(now.getTime() - SENDER_WINDOW_DAYS * DAY);
  const lastSent = sql<Date>`max(${messages.sentAt})`;
  const query = tx
    .select({
      enrollmentId: enrollments.id,
      contactId: contacts.id,
      contactEmail: contacts.email,
      lastSent,
    })
    .from(enrollments)
    .innerJoin(
      contacts,
      and(eq(contacts.id, enrollments.contactId), eq(contacts.workspaceId, workspaceId)),
    )
    .innerJoin(
      messages,
      and(
        eq(messages.enrollmentId, enrollments.id),
        eq(messages.workspaceId, workspaceId),
        eq(messages.direction, "outbound"),
        eq(messages.mailboxId, mailboxId),
        sql`${messages.sentAt} > ${since}`,
      ),
    );
  const filtered =
    "email" in by
      ? query.where(
          and(
            eq(enrollments.workspaceId, workspaceId),
            eq(enrollments.mailboxId, mailboxId),
            inArray(enrollments.state, ["active", "paused"]),
            eq(contacts.email, by.email),
          ),
        )
      : query
          .innerJoin(
            companies,
            and(eq(companies.id, contacts.companyId), eq(companies.workspaceId, workspaceId)),
          )
          .where(
            and(
              eq(enrollments.workspaceId, workspaceId),
              eq(enrollments.mailboxId, mailboxId),
              inArray(enrollments.state, ["active", "paused"]),
              eq(companies.domain, by.domain),
            ),
          );
  const [row] = await filtered
    .groupBy(enrollments.id, contacts.id, contacts.email)
    .orderBy(desc(lastSent))
    .limit(1);
  if (!row) return null;

  const [last] = await tx
    .select({ id: messages.id, stepPosition: messages.stepPosition })
    .from(messages)
    .where(
      and(
        eq(messages.workspaceId, workspaceId),
        eq(messages.enrollmentId, row.enrollmentId),
        eq(messages.direction, "outbound"),
      ),
    )
    .orderBy(desc(messages.sentAt))
    .limit(1);
  return {
    kind: "email" in by ? "sender" : "colleague",
    contactId: row.contactId,
    contactEmail: row.contactEmail,
    enrollmentId: row.enrollmentId,
    outboundId: last?.id ?? null,
    stepPosition: last?.stepPosition ?? null,
  };
}

/** Matches an inbound message to our outreach (OL-E4 §1, "Matching"), or null. */
export async function matchInbound(
  tx: Tx,
  workspaceId: string,
  mailbox: Mailbox,
  parsed: ParsedInbound,
  now: Date,
): Promise<Match | null> {
  if (parsed.bounce) {
    // A bounce report counts only when it names a message we actually sent (rule 1): anyone can
    // send a "mailer-daemon" report naming an address, so the address alone never matches.
    const byThread = await matchByThread(
      tx,
      workspaceId,
      [parsed.bounce.originalMessageId, ...parsed.references].filter((v): v is string => !!v),
    );
    if (!byThread) return null;
    // The report is about some other address (a forward, an alias): not about this contact.
    if (
      parsed.bounce.recipient &&
      parsed.bounce.recipient !== byThread.contactEmail.toLowerCase()
    ) {
      return null;
    }
    return byThread;
  }

  const byThread = await matchByThread(tx, workspaceId, parsed.references);
  if (byThread) return byThread;
  if (!parsed.from.email) return null;
  // Without thread headers, machine mail (newsletters, notifications, no-reply senders) is never
  // a reply: a contact's own out-of-office ("auto-replied") is the one exception.
  const machine =
    parsed.bulk ||
    parsed.machineSender ||
    (parsed.autoSubmitted !== null && parsed.autoSubmitted !== "auto-replied");
  if (machine) return null;
  const bySender = await matchByEnrollment(
    tx,
    workspaceId,
    mailbox.id,
    { email: parsed.from.email },
    now,
  );
  if (bySender) return bySender;

  if (parsed.autoSubmitted !== null) return null; // a colleague's auto-reply says nothing
  const domain = domainOf(parsed.from.email);
  if (!domain || FREE_MAIL_DOMAINS.has(domain) || domain === domainOf(mailbox.email)) return null;
  return matchByEnrollment(tx, workspaceId, mailbox.id, { domain }, now);
}

// ------------------------------------------------------------------ effects

const OPEN_STATES = ["active", "paused"] as const;

async function stopContactEnrollments(
  tx: Tx,
  workspaceId: string,
  contactId: string,
  state: "replied" | "bounced" | "unsubscribed",
  decision: string,
  now: Date,
  error?: string,
): Promise<number> {
  const rows = await tx
    .update(enrollments)
    .set({
      state,
      nextRunAt: null,
      lastDecision: decision,
      lastError: error ?? null,
      updatedAt: now,
    })
    .where(
      and(
        eq(enrollments.workspaceId, workspaceId),
        eq(enrollments.contactId, contactId),
        inArray(enrollments.state, [...OPEN_STATES]),
      ),
    )
    .returning({ id: enrollments.id });
  return rows.length;
}

/**
 * Adds a locked "unsubscribed" suppression for `email` (upgrading a removable one), like the
 * unsubscribe link does. Returns true when something changed.
 */
async function suppress(tx: Tx, workspaceId: string, email: string): Promise<boolean> {
  const value = email.toLowerCase();
  const [existing] = await tx
    .select({ id: suppressions.id, reason: suppressions.reason })
    .from(suppressions)
    .where(and(eq(suppressions.workspaceId, workspaceId), eq(suppressions.value, value)))
    .limit(1);
  if (!existing) {
    await tx
      .insert(suppressions)
      .values({ workspaceId, value, reason: "unsubscribed" })
      .onConflictDoNothing();
    return true;
  }
  if (existing.reason !== "unsubscribed" && existing.reason !== "asked_not_to_contact") {
    await tx
      .update(suppressions)
      .set({ reason: "unsubscribed" })
      .where(and(eq(suppressions.id, existing.id), eq(suppressions.workspaceId, workspaceId)));
    return true;
  }
  return false;
}

/**
 * The same as clicking the unsubscribe link (UnsubscribeService.unsubscribe): suppress the address,
 * mark the contact unsubscribed, end its active/paused enrollments, withdraw its consent records.
 */
export async function unsubscribeContact(
  tx: Tx,
  workspaceId: string,
  contactId: string,
  now: Date,
): Promise<number> {
  const [contact] = await tx
    .select({ id: contacts.id, email: contacts.email, status: contacts.status })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.workspaceId, workspaceId)))
    .limit(1);
  if (!contact) return 0;
  await suppress(tx, workspaceId, contact.email);
  if (contact.status !== "unsubscribed") {
    await tx
      .update(contacts)
      .set({ status: "unsubscribed", updatedAt: now })
      .where(and(eq(contacts.id, contact.id), eq(contacts.workspaceId, workspaceId)));
  }
  const ended = await stopContactEnrollments(
    tx,
    workspaceId,
    contact.id,
    "unsubscribed",
    "unsubscribed",
    now,
  );
  await tx
    .update(consents)
    .set({ withdrawnAt: now })
    .where(
      and(
        eq(consents.workspaceId, workspaceId),
        eq(consents.contactId, contact.id),
        isNull(consents.withdrawnAt),
      ),
    );
  return ended;
}

/** Applies a stored reply's effects (OL-E4 §1, "Effects"). Returns enrollments changed. */
export async function applyEffects(
  tx: Tx,
  ctx: { workspaceId: string; mailboxId: string; now: Date },
  match: Match,
  classification: Classification,
  sender: string,
  bounceStatus: string | null,
): Promise<number> {
  const { workspaceId, now } = ctx;
  switch (classification.label) {
    case "bounce": {
      await tx
        .update(contacts)
        .set({ status: "bounced", updatedAt: now })
        .where(
          and(
            eq(contacts.id, match.contactId),
            eq(contacts.workspaceId, workspaceId),
            eq(contacts.status, "active"),
          ),
        );
      const n = await stopContactEnrollments(
        tx,
        workspaceId,
        match.contactId,
        "bounced",
        "bounced",
        now,
        `The receiving server reported a permanent failure (${bounceStatus ?? "5.x.x"})`,
      );
      await maybeAutoPauseMailbox(tx, workspaceId, ctx.mailboxId, now);
      return n;
    }
    case "out_of_office": {
      // A colleague's auto-reply says nothing about the contact.
      if (match.kind === "colleague") return 0;
      const resume = resumeAfterOutOfOffice(classification.returnDate, now);
      const rows = await tx
        .update(enrollments)
        .set({
          // Only ever later: an out-of-office never makes a step go out sooner.
          nextRunAt: sql`greatest(coalesce(${enrollments.nextRunAt}, ${resume}::timestamptz), ${resume}::timestamptz)`,
          lastDecision: "out_of_office",
          updatedAt: now,
        })
        .where(
          and(
            eq(enrollments.workspaceId, workspaceId),
            eq(enrollments.contactId, match.contactId),
            eq(enrollments.state, "active"),
          ),
        )
        .returning({ id: enrollments.id });
      return rows.length;
    }
    case "unsubscribe": {
      if (sender.toLowerCase() === match.contactEmail.toLowerCase()) {
        return unsubscribeContact(tx, workspaceId, match.contactId, now);
      }
      // Someone else asked to stop (a colleague, also inside the thread): suppress them, and stop
      // the contact's sequence as answered; the contact's own choice is theirs to make.
      await suppress(tx, workspaceId, sender);
      return stopContactEnrollments(
        tx,
        workspaceId,
        match.contactId,
        "replied",
        "reply_received",
        now,
      );
    }
    default:
      // A human reply (also from a colleague) stops every open enrollment of the contact.
      return stopContactEnrollments(
        tx,
        workspaceId,
        match.contactId,
        "replied",
        "reply_received",
        now,
      );
  }
}

// ------------------------------------------------------------------ one message

async function alreadyStored(tx: Tx, workspaceId: string, mailboxId: string, messageId: string) {
  const [row] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.workspaceId, workspaceId),
        eq(messages.mailboxId, mailboxId),
        eq(messages.direction, "inbound"),
        eq(messages.messageIdHeader, messageId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function processInbound(
  ctx: ProcessContext,
  raw: RawInbound,
): Promise<ProcessOutcome> {
  const { db, workspaceId, mailbox, now } = ctx;
  let parsed: ParsedInbound;
  try {
    parsed = await parseInbound(raw.raw);
  } catch {
    return "ignored"; // not an email we can read; never retried
  }
  if (parsed.from.email === mailbox.email.toLowerCase()) return "ignored"; // our own copy

  const deterministic = deterministicLabel(parsed, now);
  if (deterministic === "ignore") return "ignored"; // temporary delivery delay (4.x.x)

  const found = await withTenant(db, { workspaceId }, async (tx) => {
    if (await alreadyStored(tx, workspaceId, mailbox.id, parsed.messageId)) return "duplicate";
    return matchInbound(tx, workspaceId, mailbox, parsed, now);
  });
  if (found === "duplicate") return "duplicate";
  if (!found) return "unmatched";
  const match = found;

  const receivedAt = anchorDate(parsed.date, now);
  // Machine-generated mail in a thread (ticket acknowledgements, notifications): kept for the
  // record, needs nobody's attention, changes nothing.
  const generated =
    !deterministic && parsed.autoSubmitted !== null && parsed.autoSubmitted !== "auto-replied";

  // Outside any transaction: the model call may take seconds.
  const classification: Classification =
    deterministic ??
    (generated
      ? {
          label: "other",
          source: "rule",
          confidence: 1,
          summary: null,
          returnDate: null,
          referral: null,
        }
      : await classifyReply(
          {
            text: parsed.text,
            subject: parsed.subject,
            from: parsed.from.email,
            workspaceId,
            mailboxId: mailbox.id,
            sentAt: receivedAt,
          },
          ctx.classifier,
          now,
        ));

  return withTenant(db, { workspaceId }, async (tx) => {
    const [stored] = await tx
      .insert(messages)
      .values({
        workspaceId,
        enrollmentId: match.enrollmentId,
        contactId: match.contactId,
        mailboxId: mailbox.id,
        stepPosition: match.stepPosition,
        direction: "inbound",
        status: "received",
        messageIdHeader: parsed.messageId,
        providerMessageId: raw.providerMessageId ?? null,
        providerThreadId: raw.providerThreadId ?? null,
        subject: parsed.subject,
        sentAt: receivedAt,
        receivedAt,
        fromEmail: parsed.from.email,
        fromName: parsed.from.name?.slice(0, 200) ?? null,
        inReplyTo: parsed.inReplyTo,
        referencesHeader: parsed.references.join(" ").slice(0, 4000) || null,
        bodyText: parsed.text,
        matchKind: match.kind,
        replyToId: match.outboundId,
        label: classification.label,
        labelSource: classification.source,
        labelConfidence: classification.confidence,
        summary: classification.summary,
        referral: classification.referral,
        // Bounce reports, auto-replies and machine mail need no one's attention.
        handledAt:
          generated || classification.label === "bounce" || classification.label === "out_of_office"
            ? now
            : null,
        autoSubmitted:
          parsed.autoReply ||
          parsed.autoSubmitted !== null ||
          parsed.machineSender ||
          parsed.bounce !== null,
      })
      .onConflictDoNothing()
      .returning({ id: messages.id });
    if (!stored) return "duplicate";

    const changed = generated
      ? 0
      : await applyEffects(
          tx,
          { workspaceId, mailboxId: mailbox.id, now },
          match,
          classification,
          parsed.from.email,
          parsed.bounce?.status ?? null,
        );
    // No personal data or content in the audit trail: ids, label and counts only.
    await tx.insert(auditLog).values({
      workspaceId,
      actorId: null,
      action: "reply.received",
      entity: "message",
      entityId: stored.id,
      metadata: {
        label: classification.label,
        labelSource: classification.source,
        matchedBy: match.kind,
        enrollmentsChanged: changed,
      },
    });
    return "stored";
  });
}
