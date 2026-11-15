import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { failed, type Check, type SendWindow } from "@openline/compliance";
import {
  and,
  contacts,
  desc,
  enrollments,
  eq,
  inArray,
  mailboxes,
  messages,
  sql,
  withTenant,
  type DatabaseHandle,
  type Tx,
} from "@openline/db";
import type {
  ContactComplianceSummaryDto,
  ENROLL_SKIP_REASONS,
  EnrollInputSchema,
  EnrollmentDto,
  EnrollPreviewDto,
  EnrollPreviewInput,
  EnrollPreviewItemDto,
  EnrollResultDto,
  ENROLLMENT_STATES,
  MessageDto,
} from "@openline/shared";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth-context";
import { ApiException, forbidden, notFound } from "../../common/http";
import { requireVerified } from "../../common/verified";
import { DB } from "../../database/database.module";
import { AuditService } from "../audit/audit.service";
import { decodeCursor, encodeCursor } from "../contacts/contacts.service";
import { evaluateAll, loadEmailFacts, summarise } from "../compliance/compliance.facts";
import { MailboxesService } from "../mailboxes/mailboxes.service";
import { SequencesService } from "./sequences.service";

type EnrollInput = z.infer<typeof EnrollInputSchema>;
type EnrollmentState = (typeof ENROLLMENT_STATES)[number];
type EnrollSkipReason = (typeof ENROLL_SKIP_REASONS)[number];

/** Skip reasons that come from a compliance rule (they carry the failing check). */
const COMPLIANCE_SKIPS = new Set<EnrollSkipReason>([
  "unsubscribed",
  "bounced",
  "suppressed",
  "no_consent",
]);
export type EnrollmentAction = "pause" | "resume" | "stop" | "mark_replied";

const createdAtIso = sql<string>`to_char(${enrollments.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function selectEnrollments(tx: Tx, workspaceId: string) {
  return tx
    .select({
      e: enrollments,
      createdAtIso,
      contact: {
        id: contacts.id,
        email: contacts.email,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
      },
      mailbox: { id: mailboxes.id, email: mailboxes.email },
    })
    .from(enrollments)
    .innerJoin(
      contacts,
      and(eq(contacts.id, enrollments.contactId), eq(contacts.workspaceId, workspaceId)),
    )
    .innerJoin(
      mailboxes,
      and(eq(mailboxes.id, enrollments.mailboxId), eq(mailboxes.workspaceId, workspaceId)),
    )
    .$dynamic();
}

type Row = Awaited<ReturnType<typeof selectEnrollments>>[number];

const toDto = (r: Row): EnrollmentDto => ({
  id: r.e.id,
  sequenceId: r.e.sequenceId,
  contact: r.contact,
  mailbox: r.mailbox,
  state: r.e.state,
  nextPosition: r.e.nextPosition,
  nextRunAt: r.e.nextRunAt?.toISOString() ?? null,
  lastDecision: r.e.lastDecision,
  lastError: r.e.lastError,
  createdAt: r.e.createdAt.toISOString(),
});

/** Allowed actions: from which states, to which state. */
const ACTIONS: Record<
  EnrollmentAction,
  { from: EnrollmentState[]; to: EnrollmentState; decision: string }
> = {
  pause: { from: ["active"], to: "paused", decision: "paused_by_user" },
  resume: { from: ["paused"], to: "active", decision: "resumed" },
  stop: { from: ["active", "paused", "error"], to: "stopped", decision: "stopped_by_user" },
  mark_replied: {
    from: ["active", "paused", "completed", "error"],
    to: "replied",
    decision: "marked_replied",
  },
};

@Injectable()
export class EnrollmentsService {
  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    private readonly audit: AuditService,
    private readonly sequences: SequencesService,
    private readonly mailboxes: MailboxesService,
  ) {}

  private scope<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, { workspaceId: auth.workspaceId, userId: auth.userId }, fn);
  }

  /**
   * Enrolls contacts, skipping (never failing on) the ones we must not email: suppressed,
   * unsubscribed, bounced, already enrolled, or without the consent their jurisdiction requires.
   * Compliance skips carry the failing rule from the Compliance Copilot engine.
   */
  enroll(auth: AuthContext, sequenceId: string, input: EnrollInput): Promise<EnrollResultDto> {
    requireVerified(auth);
    return this.scope(auth, async (tx) => {
      const seq = await this.sequences.load(tx, auth.workspaceId, sequenceId);
      if (seq.status !== "active") {
        throw new ApiException(
          HttpStatus.CONFLICT,
          "sequence_not_active",
          "Activate the sequence before enrolling people",
        );
      }
      const mailbox = await this.mailboxes.load(tx, auth.workspaceId, input.mailboxId);
      if (auth.role === "rep" && mailbox.userId !== auth.userId) {
        throw forbidden("Reps can only send from their own mailbox");
      }
      if (mailbox.status !== "active") {
        throw new ApiException(
          HttpStatus.CONFLICT,
          "mailbox_not_active",
          "This mailbox is paused or needs attention. Fix it in Settings → Mailboxes.",
        );
      }

      const ids = [...new Set(input.contactIds)];
      const now = new Date();
      const assessed = await this.assess(tx, auth.workspaceId, seq, ids, now);
      const skipped: EnrollResultDto["skipped"] = [];
      const eligible: string[] = [];
      for (const a of assessed) {
        if (a.skipReason) {
          skipped.push({
            contactId: a.contactId,
            reason: a.skipReason,
            ...(a.compliance && COMPLIANCE_SKIPS.has(a.skipReason)
              ? { compliance: a.compliance }
              : {}),
          });
        } else eligible.push(a.contactId);
      }

      let enrolled = 0;
      if (eligible.length) {
        const inserted = await tx
          .insert(enrollments)
          .values(
            eligible.map((contactId) => ({
              workspaceId: auth.workspaceId,
              sequenceId,
              contactId,
              mailboxId: mailbox.id,
              state: "active" as const,
              nextPosition: 1,
              nextRunAt: now,
              enrolledBy: auth.userId,
            })),
          )
          .onConflictDoNothing({ target: [enrollments.sequenceId, enrollments.contactId] })
          .returning({ contactId: enrollments.contactId });
        enrolled = inserted.length;
        const insertedIds = new Set(inserted.map((r) => r.contactId));
        // Lost a race with a concurrent enroll: already enrolled.
        for (const id of eligible) {
          if (!insertedIds.has(id)) skipped.push({ contactId: id, reason: "already_enrolled" });
        }
      }

      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "sequence.enrolled",
        entity: "sequence",
        entityId: sequenceId,
        metadata: { enrolled, skipped: skipped.length, mailboxId: mailbox.id },
      });
      return { enrolled, skipped };
    });
  }

  /**
   * What enrolling these contacts would do, without enrolling anyone: the same skip reasons as
   * enroll(), plus each contact's compliance decision now and the first check that stops it.
   */
  preview(
    auth: AuthContext,
    sequenceId: string,
    input: EnrollPreviewInput,
  ): Promise<EnrollPreviewDto> {
    return this.scope(auth, async (tx) => {
      const seq = await this.sequences.load(tx, auth.workspaceId, sequenceId);
      const ids = [...new Set(input.contactIds)];
      const assessed = await this.assess(tx, auth.workspaceId, seq, ids, new Date());
      const items: EnrollPreviewItemDto[] = assessed.map((a) => ({
        contactId: a.contactId,
        enrollable: !a.skipReason,
        ...(a.skipReason ? { skipReason: a.skipReason } : {}),
        ...(a.compliance ? { compliance: a.compliance } : {}),
      }));
      return {
        items,
        counts: {
          enrollable: items.filter((i) => i.enrollable).length,
          skipped: items.filter((i) => !i.enrollable).length,
          blocked: items.filter((i) => i.compliance?.decision === "blocked").length,
        },
      };
    });
  }

  /**
   * Per contact: why enrolling would skip them (never changed by the compliance engine: the reasons
   * and their order are the ones enroll() has always used) and their compliance evaluation now.
   */
  private async assess(
    tx: Tx,
    workspaceId: string,
    seq: { id: string; sendWindow: unknown },
    ids: string[],
    now: Date,
  ): Promise<
    {
      contactId: string;
      skipReason?: EnrollSkipReason;
      compliance?: ContactComplianceSummaryDto;
    }[]
  > {
    const found = ids.length
      ? await tx
          .select({
            id: contacts.id,
            email: contacts.email,
            status: contacts.status,
            country: contacts.country,
            timeZone: contacts.timeZone,
          })
          .from(contacts)
          .where(and(eq(contacts.workspaceId, workspaceId), inArray(contacts.id, ids)))
      : [];
    const byId = new Map(found.map((c) => [c.id, c]));

    const already = new Set(
      (
        await tx
          .select({ contactId: enrollments.contactId })
          .from(enrollments)
          .where(
            and(
              eq(enrollments.workspaceId, workspaceId),
              eq(enrollments.sequenceId, seq.id),
              inArray(enrollments.contactId, ids),
            ),
          )
      ).map((r) => r.contactId),
    );

    // The same facts (and consent record) as the sending engine and the contact page.
    const { inputs } = await loadEmailFacts(tx, workspaceId, found, {
      sendWindow: seq.sendWindow as SendWindow,
    });
    const evaluations = evaluateAll(inputs, now);

    return ids.map((id) => {
      const c = byId.get(id);
      const evaluation = evaluations.get(id);
      if (!c || !evaluation || c.status === "archived")
        return { contactId: id, skipReason: "not_found" };
      const summary = summarise(evaluation);
      const because = (check: Check | undefined, reason: EnrollSkipReason) => ({
        contactId: id,
        skipReason: reason,
        compliance: { ...summary, ...(check ? { check: { ...check } } : {}) },
      });
      if (already.has(id))
        return { contactId: id, skipReason: "already_enrolled", compliance: summary };
      const status = failed(evaluation, "contact_status");
      if (status && c.status === "unsubscribed") return because(status, "unsubscribed");
      if (status && c.status === "bounced") return because(status, "bounced");
      const suppression = failed(evaluation, "suppression");
      if (suppression) return because(suppression, "suppressed");
      const consent = failed(evaluation, "consent_ca") ?? failed(evaluation, "basis_eu");
      if (consent) return because(consent, "no_consent");
      return { contactId: id, compliance: summary };
    });
  }

  list(
    auth: AuthContext,
    sequenceId: string,
    query: { state?: EnrollmentState; cursor?: string; limit: number },
  ): Promise<{ items: EnrollmentDto[]; nextCursor: string | null }> {
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    return this.scope(auth, async (tx) => {
      await this.sequences.load(tx, auth.workspaceId, sequenceId);
      const rows = await selectEnrollments(tx, auth.workspaceId)
        .where(
          and(
            eq(enrollments.workspaceId, auth.workspaceId),
            eq(enrollments.sequenceId, sequenceId),
            query.state ? eq(enrollments.state, query.state) : undefined,
            after
              ? sql`(${enrollments.createdAt}, ${enrollments.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(enrollments.createdAt), desc(enrollments.id))
        .limit(query.limit + 1);
      const items = rows.slice(0, query.limit);
      const last = items[items.length - 1];
      return {
        items: items.map(toDto),
        nextCursor:
          rows.length > query.limit && last ? encodeCursor(last.createdAtIso, last.e.id) : null,
      };
    });
  }

  act(auth: AuthContext, id: string, action: EnrollmentAction): Promise<EnrollmentDto> {
    return this.scope(auth, async (tx) => {
      const current = await this.loadRow(tx, auth.workspaceId, id);
      // Same rule as enroll(): reps only manage what sends from their own mailbox.
      if (auth.role === "rep") {
        const [mailbox] = await tx
          .select({ userId: mailboxes.userId })
          .from(mailboxes)
          .where(
            and(eq(mailboxes.id, current.e.mailboxId), eq(mailboxes.workspaceId, auth.workspaceId)),
          )
          .limit(1);
        if (mailbox?.userId !== auth.userId) {
          throw forbidden("Reps can only change enrollments that send from their own mailbox");
        }
      }
      const rule = ACTIONS[action];
      if (!rule.from.includes(current.e.state)) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          "invalid_transition",
          `Can't ${action.replace("_", " ")} an enrollment that is ${current.e.state}`,
        );
      }
      const now = new Date();
      const patch: Partial<typeof enrollments.$inferInsert> = {
        state: rule.to,
        lastDecision: rule.decision,
        updatedAt: now,
      };
      if (action === "resume" && (!current.e.nextRunAt || current.e.nextRunAt < now)) {
        patch.nextRunAt = now;
      }
      if (rule.to === "stopped" || rule.to === "replied") patch.nextRunAt = null;
      await tx
        .update(enrollments)
        .set(patch)
        .where(and(eq(enrollments.id, id), eq(enrollments.workspaceId, auth.workspaceId)));
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: `enrollment.${action}`,
        entity: "enrollment",
        entityId: id,
        metadata: { from: current.e.state, to: rule.to },
      });
      return toDto(await this.loadRow(tx, auth.workspaceId, id));
    });
  }

  forContact(auth: AuthContext, contactId: string): Promise<EnrollmentDto[]> {
    return this.scope(auth, async (tx) => {
      await this.assertContact(tx, auth.workspaceId, contactId);
      const rows = await selectEnrollments(tx, auth.workspaceId)
        .where(
          and(eq(enrollments.workspaceId, auth.workspaceId), eq(enrollments.contactId, contactId)),
        )
        .orderBy(desc(enrollments.createdAt), desc(enrollments.id));
      return rows.map(toDto);
    });
  }

  messagesForContact(auth: AuthContext, contactId: string): Promise<MessageDto[]> {
    return this.scope(auth, async (tx) => {
      await this.assertContact(tx, auth.workspaceId, contactId);
      const rows = await tx
        .select({
          id: messages.id,
          direction: messages.direction,
          sequenceId: enrollments.sequenceId,
          stepPosition: messages.stepPosition,
          subject: messages.subject,
          mailboxEmail: mailboxes.email,
          sentAt: messages.sentAt,
        })
        .from(messages)
        .leftJoin(
          enrollments,
          and(
            eq(enrollments.id, messages.enrollmentId),
            eq(enrollments.workspaceId, auth.workspaceId),
          ),
        )
        .leftJoin(
          mailboxes,
          and(eq(mailboxes.id, messages.mailboxId), eq(mailboxes.workspaceId, auth.workspaceId)),
        )
        .where(and(eq(messages.workspaceId, auth.workspaceId), eq(messages.contactId, contactId)))
        .orderBy(desc(messages.sentAt), desc(messages.id));
      return rows.map((r) => ({ ...r, sentAt: r.sentAt.toISOString() }));
    });
  }

  // ---------------------------------------------------------------- helpers

  private async loadRow(tx: Tx, workspaceId: string, id: string): Promise<Row> {
    const [row] = await selectEnrollments(tx, workspaceId)
      .where(and(eq(enrollments.id, id), eq(enrollments.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw notFound("Enrollment");
    return row;
  }

  private async assertContact(tx: Tx, workspaceId: string, contactId: string): Promise<void> {
    const [c] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.workspaceId, workspaceId)))
      .limit(1);
    if (!c) throw notFound("Contact");
  }
}
