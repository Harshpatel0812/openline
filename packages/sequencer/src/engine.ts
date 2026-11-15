/**
 * The sending engine.
 *
 * Each run: claim due enrollments (the one cross-tenant query, via claim_due_enrollments), then for
 * each one, inside withTenant() for its workspace:
 *   1. DECIDE  — every compliance and safety check, in a short transaction.
 *   2. SEND    — the network call, outside any transaction.
 *   3. RECORD  — store the message and schedule the next step, in a short transaction.
 * DECIDE ends by reserving the step (an outbound `messages` row with status 'sending', unique per
 * enrollment and step), so even two workers holding the same enrollment can't both send a step.
 * Changes a person makes while a send is in flight (pause, stop, replied, unsubscribe) win: the
 * engine only moves an enrollment's state forward while it is still 'active'.
 * Anything that blocks sending either DEFERS (try again later) or ENDS the enrollment, and the reason
 * is written to enrollments.last_decision so the UI can explain it.
 *
 * Safety rules enforced here (never left to the UI):
 *   suppression list · contact unsubscribed/bounced · consent where the law requires it (CASL, GDPR)
 *   · postal address present (CAN-SPAM) · contact's local business hours · mailbox daily cap ·
 *   random spacing between sends · mailbox health (auth failures pause, bounce-rate auto-pause).
 */
import {
  canSendCommercialEmail,
  isSuppressed,
  isWithinSendWindow,
  jurisdictionFor,
  nextSendWindowStart,
  type SendWindow,
} from "@openline/compliance";
import {
  and,
  companies,
  consents,
  contacts,
  desc,
  enrollments,
  eq,
  inArray,
  mailboxes,
  messages,
  sequenceSteps,
  sequences,
  sql,
  suppressions,
  users,
  withIdentity,
  withTenant,
  workspaces,
  type Contact,
  type Enrollment,
  type Mailbox,
  type Tx,
} from "@openline/db";
import {
  buildUnsubscribeHeaders,
  createUnsubscribeToken,
  newMessageId,
  renderEmail,
  SendError,
  type MailAdapter,
  type OutgoingEmail,
} from "@openline/email";
import { SENDING_DEFAULTS } from "@openline/shared";
import { createMailAdapter, hasReplyAfterLastStep, maybeAutoPauseMailbox } from "./mailbox";
import type { RunSummary, Sequencer, SequencerOptions } from "./types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_ATTEMPTS = 5;

/** How long a 'sending' reservation is trusted before we assume its worker died mid-send. */
const RESERVATION_TIMEOUT_MS = 10 * MINUTE;

type Decision =
  | { kind: "send"; plan: SendPlan }
  | { kind: "already_sent"; advance: Advance }
  | { kind: "defer"; until: Date; reason: string }
  | { kind: "end"; state: Enrollment["state"]; reason: string; error?: string };

/** What moving an enrollment past a sent step needs. */
interface Advance {
  enrollment: Enrollment;
  stepPosition: number;
  nextStep: { delayDays: number } | null;
  messageId: string;
  subject: string;
  /** Set when the step was a threaded reply. */
  inReplyTo?: string;
}

interface SendPlan {
  /** The reserved outbound messages row. */
  reservationId: string;
  enrollment: Enrollment;
  mailbox: Mailbox;
  contact: Contact;
  stepPosition: number;
  nextStep: { delayDays: number } | null;
  email: OutgoingEmail;
  firstSubject: string;
}

/**
 * Error text that is safe to log: database errors carry queries and bound parameters (personal
 * data), so only their code is logged; our own errors are logged with their message.
 */
function describe(error: unknown): string {
  const e = error as {
    name?: string;
    message?: string;
    code?: string;
    query?: unknown;
    cause?: { code?: string };
  };
  if (e?.query !== undefined || e?.cause?.code || (e?.code && /^[0-9A-Z]{5}$/.test(e.code))) {
    return `${e?.name ?? "DatabaseError"} ${e?.cause?.code ?? e?.code ?? ""}`.trim();
  }
  return `${e?.name ?? "Error"}: ${String(e?.message ?? "").slice(0, 200)}`;
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}

export function createSequencer(options: SequencerOptions): Sequencer {
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const log = options.logger ?? console;
  const db = options.db;

  let timer: NodeJS.Timeout | undefined;
  let running: Promise<RunSummary> | undefined;
  let stopped = false;

  // ------------------------------------------------------------------ adapters

  async function adapterFor(mailbox: Mailbox): Promise<MailAdapter> {
    const custom = options.adapterFor?.(mailbox);
    if (custom) return custom;
    return createMailAdapter(mailbox, {
      outreach: options.outreach,
      secretsKey: options.secretsKey,
      google: options.google,
      allowPrivateSmtpHosts: options.allowPrivateSmtpHosts,
    });
  }

  // ------------------------------------------------------------------ helpers

  async function defer(
    workspaceId: string,
    id: string,
    until: Date,
    reason: string,
    error?: string,
  ) {
    await withTenant(db, { workspaceId }, (tx) =>
      tx
        .update(enrollments)
        .set({
          nextRunAt: until,
          lastDecision: reason,
          lastError: error ?? null,
          lockedUntil: null,
          updatedAt: now(),
        })
        .where(activeEnrollment(workspaceId, id)),
    );
    await releaseLease(workspaceId, id);
  }

  async function end(
    workspaceId: string,
    id: string,
    state: Enrollment["state"],
    reason: string,
    error?: string,
  ) {
    await withTenant(db, { workspaceId }, (tx) =>
      tx
        .update(enrollments)
        .set({
          state,
          nextRunAt: null,
          lastDecision: reason,
          lastError: error ?? null,
          lockedUntil: null,
          updatedAt: now(),
        })
        .where(activeEnrollment(workspaceId, id)),
    );
    await releaseLease(workspaceId, id);
  }

  /** WHERE for "this enrollment, only if still active" — a person's pause/stop always wins. */
  function activeEnrollment(workspaceId: string, id: string) {
    return and(
      eq(enrollments.id, id),
      eq(enrollments.workspaceId, workspaceId),
      eq(enrollments.state, "active"),
    );
  }

  async function releaseLease(workspaceId: string, id: string) {
    await withTenant(db, { workspaceId }, (tx) =>
      tx
        .update(enrollments)
        .set({ lockedUntil: null })
        .where(and(eq(enrollments.id, id), eq(enrollments.workspaceId, workspaceId))),
    );
  }

  function jitter(maxMs: number): number {
    return Math.floor(random() * maxMs);
  }

  // ------------------------------------------------------------------ 1. decide

  async function decide(
    tx: Tx,
    workspaceId: string,
    enrollmentId: string,
  ): Promise<Decision | null> {
    const t = now();
    const [enrollment] = await tx
      .select()
      .from(enrollments)
      .where(and(eq(enrollments.id, enrollmentId), eq(enrollments.workspaceId, workspaceId)));
    if (!enrollment || enrollment.state !== "active") return null;

    const [sequence] = await tx
      .select()
      .from(sequences)
      .where(and(eq(sequences.id, enrollment.sequenceId), eq(sequences.workspaceId, workspaceId)));
    if (!sequence || sequence.status === "archived") {
      return { kind: "end", state: "stopped", reason: "sequence_archived" };
    }
    if (sequence.status !== "active") {
      return { kind: "defer", until: new Date(t.getTime() + HOUR), reason: "sequence_paused" };
    }

    const steps = await tx
      .select()
      .from(sequenceSteps)
      .where(
        and(eq(sequenceSteps.sequenceId, sequence.id), eq(sequenceSteps.workspaceId, workspaceId)),
      )
      .orderBy(sequenceSteps.position);
    const step = steps.find((s) => s.position === enrollment.nextPosition);
    if (!step) return { kind: "end", state: "completed", reason: "completed" };
    const nextStep = steps.find((s) => s.position === enrollment.nextPosition + 1) ?? null;
    const firstStep = steps[0]!;

    // Was this step already reserved (another worker, or a run that died part-way)?
    const [reserved] = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.workspaceId, workspaceId),
          eq(messages.enrollmentId, enrollment.id),
          eq(messages.stepPosition, step.position),
          eq(messages.direction, "outbound"),
        ),
      );
    if (reserved) {
      if (reserved.status === "sent") {
        // Sent, but the run stopped before the enrollment moved on: just move it on.
        return {
          kind: "already_sent",
          advance: {
            enrollment,
            stepPosition: step.position,
            nextStep,
            messageId: reserved.messageIdHeader,
            subject: reserved.subject,
            inReplyTo: step.position > 1 && step.threadWithPrevious ? "threaded" : undefined,
          },
        };
      }
      if (
        reserved.status === "sending" &&
        t.getTime() - reserved.sentAt.getTime() < RESERVATION_TIMEOUT_MS
      ) {
        return {
          kind: "defer",
          until: new Date(reserved.sentAt.getTime() + RESERVATION_TIMEOUT_MS),
          reason: "send_in_progress",
        };
      }
      // Its worker died mid-send: it may or may not have gone out. Never guess by re-sending.
      await tx
        .update(messages)
        .set({ status: "unconfirmed" })
        .where(and(eq(messages.id, reserved.id), eq(messages.workspaceId, workspaceId)));
      return {
        kind: "end",
        state: "error",
        reason: "send_unconfirmed",
        error: "We couldn't confirm whether this step was sent. Check the mailbox's Sent folder.",
      };
    }

    // A reply that arrived after the last step ends the sequence, even if reply sync's own update
    // of the enrollment hasn't landed yet (or a person resumed it): never follow up on a reply.
    if (await hasReplyAfterLastStep(tx, workspaceId, enrollment.id)) {
      return { kind: "end", state: "replied", reason: "reply_received" };
    }

    const [contact] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, enrollment.contactId), eq(contacts.workspaceId, workspaceId)));
    if (!contact) return { kind: "end", state: "stopped", reason: "contact_deleted" };
    if (contact.status === "unsubscribed")
      return { kind: "end", state: "unsubscribed", reason: "unsubscribed" };
    if (contact.status === "bounced") return { kind: "end", state: "bounced", reason: "bounced" };
    if (contact.status === "archived")
      return { kind: "end", state: "stopped", reason: "contact_archived" };

    // Suppression list: the exact email or the whole domain.
    const domain = `@${contact.email.split("@")[1] ?? ""}`;
    const hits = await tx
      .select({ value: suppressions.value, reason: suppressions.reason })
      .from(suppressions)
      .where(
        and(
          eq(suppressions.workspaceId, workspaceId),
          inArray(suppressions.value, [contact.email, domain]),
        ),
      );
    if (isSuppressed(contact.email, new Set(hits.map((h) => h.value)))) {
      const unsub = hits.some((h) => h.reason === "unsubscribed");
      return { kind: "end", state: unsub ? "unsubscribed" : "stopped", reason: "suppressed" };
    }

    // Consent where the law requires it before the first email (CASL, GDPR).
    const jurisdiction = jurisdictionFor(contact.country, contact.email);
    if (jurisdiction === "CA" || jurisdiction === "EU") {
      const [record] = await tx
        .select()
        .from(consents)
        .where(and(eq(consents.workspaceId, workspaceId), eq(consents.contactId, contact.id)))
        .orderBy(desc(consents.createdAt))
        .limit(1);
      const permission = canSendCommercialEmail(
        jurisdiction,
        record
          ? {
              basis: record.basis,
              obtainedAt: record.obtainedAt,
              withdrawnAt: record.withdrawnAt ?? undefined,
            }
          : undefined,
        t,
      );
      if (!permission.allowed) {
        return { kind: "end", state: "stopped", reason: "no_consent", error: permission.reason };
      }
    }

    const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    if (!workspace?.mailingAddress) {
      return {
        kind: "defer",
        until: new Date(t.getTime() + HOUR),
        reason: "mailing_address_missing",
      };
    }

    const [mailbox] = await tx
      .select()
      .from(mailboxes)
      .where(and(eq(mailboxes.id, enrollment.mailboxId), eq(mailboxes.workspaceId, workspaceId)));
    if (!mailbox || mailbox.status === "disconnected") {
      return { kind: "end", state: "stopped", reason: "mailbox_removed" };
    }
    if (mailbox.status !== "active") {
      const wait = mailbox.status === "error" ? 6 * HOUR : HOUR;
      return {
        kind: "defer",
        until: new Date(t.getTime() + wait),
        reason: `mailbox_${mailbox.status}`,
      };
    }

    // The contact's business hours.
    const timeZone = contact.timeZone ?? workspace.defaultTimeZone;
    const window = sequence.sendWindow as SendWindow;
    if (!isWithinSendWindow(t, timeZone, window)) {
      const start = nextSendWindowStart(t, timeZone, window);
      return {
        kind: "defer",
        until: new Date(start.getTime() + jitter(20 * MINUTE)),
        reason: "outside_send_window",
      };
    }

    // Mailbox daily cap (rolling 24 hours) and spacing between sends.
    const since = new Date(t.getTime() - DAY);
    const recent = await tx
      .select({ sentAt: messages.sentAt })
      .from(messages)
      .where(
        and(
          eq(messages.workspaceId, workspaceId),
          eq(messages.mailboxId, mailbox.id),
          eq(messages.direction, "outbound"),
          sql`${messages.sentAt} > ${since}`,
        ),
      )
      .orderBy(desc(messages.sentAt));
    if (recent.length >= mailbox.dailyCap) {
      const oldest = recent[recent.length - 1]!.sentAt;
      return {
        kind: "defer",
        until: new Date(oldest.getTime() + DAY + jitter(30 * MINUTE)),
        reason: "mailbox_daily_cap",
      };
    }
    const last = recent[0]?.sentAt;
    const gap =
      SENDING_DEFAULTS.minSpacingSeconds * 1000 +
      jitter((SENDING_DEFAULTS.maxSpacingSeconds - SENDING_DEFAULTS.minSpacingSeconds) * 1000);
    if (last && t.getTime() - last.getTime() < gap) {
      return { kind: "defer", until: new Date(last.getTime() + gap), reason: "mailbox_spacing" };
    }

    // Render.
    const [company] = contact.companyId
      ? await tx
          .select({ name: companies.name })
          .from(companies)
          .where(and(eq(companies.id, contact.companyId), eq(companies.workspaceId, workspaceId)))
      : [];
    const [sender] = await tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, mailbox.userId));
    const unsubscribeToken = createUnsubscribeToken(
      { workspaceId, contactId: contact.id },
      options.unsubscribeSecret,
    );
    const base = options.webUrl.replace(/\/$/, "");
    const vars = {
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      title: contact.title,
      company: company?.name ?? null,
      senderName: mailbox.displayName ?? sender?.name ?? null,
    };
    const rendered = renderEmail(step.subject, step.body, vars, {
      mailingAddress: workspace.mailingAddress,
      senderCompany: workspace.name,
      unsubscribeUrl: `${base}/u/${unsubscribeToken}`,
    });
    const firstSubject = renderEmail(firstStep.subject, "", vars, {
      mailingAddress: "-",
      senderCompany: "-",
      unsubscribeUrl: "https://x",
    }).subject;

    const threaded = step.position > 1 && step.threadWithPrevious && enrollment.threadMessageId;
    const subject = threaded
      ? `Re: ${(enrollment.threadSubject ?? firstSubject).replace(/^re:\s*/i, "")}`
      : rendered.subject;
    const messageId = newMessageId(mailbox.email);

    // Reserve the step. The unique index makes this the single point where a send is granted.
    const [reservation] = await tx
      .insert(messages)
      .values({
        workspaceId,
        enrollmentId: enrollment.id,
        contactId: contact.id,
        mailboxId: mailbox.id,
        stepPosition: step.position,
        direction: "outbound",
        messageIdHeader: messageId,
        subject,
        sentAt: t,
        status: "sending",
      })
      .onConflictDoNothing()
      .returning({ id: messages.id });
    if (!reservation) {
      return {
        kind: "defer",
        until: new Date(t.getTime() + RESERVATION_TIMEOUT_MS),
        reason: "send_in_progress",
      };
    }

    return {
      kind: "send",
      plan: {
        reservationId: reservation.id,
        enrollment,
        mailbox,
        contact,
        stepPosition: step.position,
        nextStep,
        firstSubject,
        email: {
          from: { email: mailbox.email, name: mailbox.displayName ?? sender?.name ?? null },
          to: contact.email,
          subject,
          text: rendered.text,
          html: rendered.html,
          headers: buildUnsubscribeHeaders(`${base}/api/v1/public/unsubscribe/${unsubscribeToken}`),
          messageId,
          inReplyTo: threaded ? (enrollment.threadMessageId ?? undefined) : undefined,
        },
      },
    };
  }

  // ------------------------------------------------------------------ 3. record

  /**
   * Moves an enrollment past a sent step. Position and thread always move (so a resumed enrollment
   * never repeats the step); state and schedule only change while the enrollment is still active.
   */
  async function advance(tx: Tx, workspaceId: string, a: Advance, t: Date) {
    const isFirstOfThread = !a.enrollment.threadMessageId || !a.inReplyTo;
    await tx
      .update(enrollments)
      .set({
        nextPosition: a.stepPosition + 1,
        attempts: 0,
        lockedUntil: null,
        threadMessageId: isFirstOfThread ? a.messageId : a.enrollment.threadMessageId,
        threadSubject: isFirstOfThread ? a.subject : a.enrollment.threadSubject,
        updatedAt: t,
      })
      .where(and(eq(enrollments.id, a.enrollment.id), eq(enrollments.workspaceId, workspaceId)));
    if (!a.nextStep) {
      await tx
        .update(enrollments)
        .set({ state: "completed", nextRunAt: null, lastDecision: "completed", lastError: null })
        .where(activeEnrollment(workspaceId, a.enrollment.id));
      return;
    }
    // An out-of-office that arrived while this step was in flight already moved the schedule past
    // the return date: never pull it earlier (GREATEST semantics), and keep its decision.
    const next = new Date(t.getTime() + a.nextStep.delayDays * DAY).toISOString();
    const keepOutOfOffice = sql`(${enrollments.lastDecision} = 'out_of_office' AND ${enrollments.nextRunAt} > ${next}::timestamptz)`;
    await tx
      .update(enrollments)
      .set({
        state: "active",
        nextRunAt: sql`CASE WHEN ${keepOutOfOffice} THEN ${enrollments.nextRunAt} ELSE ${next}::timestamptz END`,
        lastDecision: sql`CASE WHEN ${keepOutOfOffice} THEN 'out_of_office' ELSE 'sent' END`,
        lastError: null,
      })
      .where(activeEnrollment(workspaceId, a.enrollment.id));
  }

  async function recordSent(workspaceId: string, plan: SendPlan, providerMessageId: string) {
    const t = now();
    await withTenant(db, { workspaceId }, async (tx) => {
      await tx
        .update(messages)
        .set({ status: "sent", providerMessageId, sentAt: t })
        .where(and(eq(messages.id, plan.reservationId), eq(messages.workspaceId, workspaceId)));
      await advance(
        tx,
        workspaceId,
        {
          enrollment: plan.enrollment,
          stepPosition: plan.stepPosition,
          nextStep: plan.nextStep,
          messageId: plan.email.messageId,
          subject: plan.email.subject,
          inReplyTo: plan.email.inReplyTo,
        },
        t,
      );
    });
  }

  async function recordFailure(workspaceId: string, plan: SendPlan, error: unknown) {
    const t = now();
    const sendError =
      error instanceof SendError ? error : new SendError("Unexpected sending error", "transient");
    const id = plan.enrollment.id;

    // Nothing went out: give the step back so a later attempt can reserve it again.
    await withTenant(db, { workspaceId }, (tx) =>
      tx
        .delete(messages)
        .where(and(eq(messages.id, plan.reservationId), eq(messages.workspaceId, workspaceId))),
    );

    if (sendError.kind === "auth") {
      await withTenant(db, { workspaceId }, (tx) =>
        tx
          .update(mailboxes)
          .set({ status: "error", lastError: sendError.message, updatedAt: t })
          .where(and(eq(mailboxes.id, plan.mailbox.id), eq(mailboxes.workspaceId, workspaceId))),
      );
      await defer(
        workspaceId,
        id,
        new Date(t.getTime() + 6 * HOUR),
        "mailbox_error",
        sendError.message,
      );
      return;
    }

    if (sendError.kind === "permanent") {
      await withTenant(db, { workspaceId }, async (tx) => {
        await tx
          .update(contacts)
          .set({ status: "bounced", updatedAt: t })
          .where(and(eq(contacts.id, plan.contact.id), eq(contacts.workspaceId, workspaceId)));
        await tx
          .update(enrollments)
          .set({
            state: "bounced",
            nextRunAt: null,
            lastDecision: "bounced",
            lastError: sendError.message,
            updatedAt: t,
          })
          .where(activeEnrollment(workspaceId, id));
        await maybeAutoPauseMailbox(tx, workspaceId, plan.mailbox.id, t);
      });
      await releaseLease(workspaceId, id);
      return;
    }

    const attempts = plan.enrollment.attempts + 1;
    const giveUp = attempts >= MAX_ATTEMPTS;
    await withTenant(db, { workspaceId }, (tx) =>
      tx
        .update(enrollments)
        .set(
          giveUp
            ? {
                state: "error",
                attempts,
                nextRunAt: null,
                lastDecision: "send_failed",
                lastError: sendError.message,
                updatedAt: t,
              }
            : {
                attempts,
                nextRunAt: new Date(t.getTime() + 5 * MINUTE * 2 ** (attempts - 1)),
                lastDecision: "retrying",
                lastError: sendError.message,
                updatedAt: t,
              },
        )
        .where(activeEnrollment(workspaceId, id)),
    );
    await releaseLease(workspaceId, id);
  }

  // ------------------------------------------------------------------ one enrollment

  async function processOne(workspaceId: string, enrollmentId: string, summary: RunSummary) {
    let decision: Decision | null;
    try {
      decision = await withTenant(db, { workspaceId }, (tx) =>
        decide(tx, workspaceId, enrollmentId),
      );
    } catch (error) {
      summary.failed += 1;
      log.error(`sequencer: decide failed for enrollment ${enrollmentId}: ${describe(error)}`);
      await defer(
        workspaceId,
        enrollmentId,
        new Date(now().getTime() + 15 * MINUTE),
        "internal_error",
      );
      return;
    }

    if (!decision) {
      // No longer active (paused/stopped meanwhile): just release the lease.
      await withTenant(db, { workspaceId }, (tx) =>
        tx
          .update(enrollments)
          .set({ lockedUntil: null })
          .where(and(eq(enrollments.id, enrollmentId), eq(enrollments.workspaceId, workspaceId))),
      );
      return;
    }
    if (decision.kind === "defer") {
      summary.deferred += 1;
      await defer(workspaceId, enrollmentId, decision.until, decision.reason);
      return;
    }
    if (decision.kind === "end") {
      summary.finished += 1;
      await end(workspaceId, enrollmentId, decision.state, decision.reason, decision.error);
      return;
    }
    if (decision.kind === "already_sent") {
      const a = decision.advance;
      await withTenant(db, { workspaceId }, (tx) => advance(tx, workspaceId, a, now()));
      if (!a.nextStep) summary.finished += 1;
      return;
    }

    const plan = decision.plan;
    let providerMessageId: string;
    try {
      const adapter = await adapterFor(plan.mailbox);
      providerMessageId = (await adapter.send(plan.email)).providerMessageId;
    } catch (error) {
      summary.failed += 1;
      await recordFailure(workspaceId, plan, error);
      return;
    }
    summary.sent += 1;
    if (!plan.nextStep) summary.finished += 1;
    try {
      await recordSent(workspaceId, plan, providerMessageId);
    } catch (error) {
      // The email went out. The reservation stays 'sending', so no run will ever send this step
      // again; after the timeout the enrollment is flagged for a person to check.
      log.error(
        `sequencer: sent but could not record enrollment ${enrollmentId}: ${describe(error)}`,
      );
    }
  }

  // ------------------------------------------------------------------ public API

  async function runOnce(batch = 50): Promise<RunSummary> {
    const summary: RunSummary = { claimed: 0, sent: 0, deferred: 0, finished: 0, failed: 0 };
    const claimed = rowsOf<{ workspace_id: string; enrollment_id: string }>(
      await withIdentity(db, (tx) =>
        tx.execute(sql`SELECT * FROM claim_due_enrollments(${batch})`),
      ),
    );
    summary.claimed = claimed.length;
    // Sequential on purpose: spacing and daily caps are checked against committed sends.
    for (const row of claimed) {
      if (stopped) break;
      try {
        await processOne(row.workspace_id, row.enrollment_id, summary);
      } catch (error) {
        // One bad row must never stop the batch; its lease simply runs out and it is retried.
        summary.failed += 1;
        log.error(`sequencer: enrollment ${row.enrollment_id} failed: ${describe(error)}`);
      }
    }
    return summary;
  }

  return {
    runOnce: (batch?: number) => {
      const run = runOnce(batch);
      running = run;
      return run;
    },
    start(intervalMs = 15_000) {
      stopped = false;
      const tick = async () => {
        if (stopped) return;
        try {
          running = runOnce();
          await running;
        } catch (error) {
          log.error(`sequencer: run failed: ${describe(error)}`);
        } finally {
          running = undefined;
          if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
        }
      };
      timer = setTimeout(() => void tick(), 1_000);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (running) await running.catch(() => undefined);
    },
  };
}
