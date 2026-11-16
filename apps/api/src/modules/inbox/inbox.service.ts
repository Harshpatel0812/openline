import { HttpStatus, Inject, Injectable, Optional } from "@nestjs/common";
import { currentConsent, evaluateEmailContact, toComplianceProof } from "@openline/compliance";
import {
  and,
  asc,
  companies,
  consents,
  contacts,
  count,
  desc,
  enrollments,
  eq,
  inArray,
  isNull,
  mailboxes,
  messages,
  sequences,
  sql,
  suppressions,
  withTenant,
  workspaces,
  type DatabaseHandle,
  type Tx,
} from "@openline/db";
import {
  buildUnsubscribeHeaders,
  createUnsubscribeToken,
  newMessageId,
  renderEmail,
  SendError,
} from "@openline/email";
import {
  applyEffects,
  gmailOpenUrl,
  isMachineAddress,
  snippetOf,
  type Match,
} from "@openline/replies";
import { createMailAdapter } from "@openline/sequencer";
import {
  NEEDS_ACTION_LABELS,
  REPLY_LABELS,
  type InboxCountsDto,
  type InboxItemDto,
  type InboxMessageDto,
  type InboxPageDto,
  type InboxQuery,
  type InboxReplyInput,
  type InboxUpdateInput,
  type ReplyLabel,
} from "@openline/shared";
import type { AuthContext } from "../../common/auth-context";
import { ApiException, notFound } from "../../common/http";
import { CONFIG, type AppConfig } from "../../config";
import { DB } from "../../database/database.module";
import { AuditService } from "../audit/audit.service";
import { PromiseKeeperService } from "../promises/promise-keeper.service";
import { replyRefusal } from "./reply-compliance";
import { decodeCursor, encodeCursor } from "../contacts/contacts.service";

/** Managers and above see every mailbox's replies; reps only their own mailboxes'. */
const SEES_ALL = new Set(["owner", "admin", "manager"]);

const receivedAtIso = sql<string>`to_char(${messages.receivedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function selectInbox(tx: Tx, workspaceId: string) {
  return tx
    .select({
      m: messages,
      receivedAtIso,
      mailbox: { id: mailboxes.id, email: mailboxes.email, userId: mailboxes.userId },
      contact: {
        id: contacts.id,
        email: contacts.email,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
      },
      company: { id: companies.id, name: companies.name },
      sequence: { id: sequences.id, name: sequences.name },
    })
    .from(messages)
    .innerJoin(
      mailboxes,
      and(eq(mailboxes.id, messages.mailboxId), eq(mailboxes.workspaceId, workspaceId)),
    )
    .leftJoin(
      contacts,
      and(eq(contacts.id, messages.contactId), eq(contacts.workspaceId, workspaceId)),
    )
    .leftJoin(
      companies,
      and(eq(companies.id, contacts.companyId), eq(companies.workspaceId, workspaceId)),
    )
    .leftJoin(
      enrollments,
      and(eq(enrollments.id, messages.enrollmentId), eq(enrollments.workspaceId, workspaceId)),
    )
    .leftJoin(
      sequences,
      and(eq(sequences.id, enrollments.sequenceId), eq(sequences.workspaceId, workspaceId)),
    );
}

type InboxRow = Awaited<ReturnType<ReturnType<typeof selectInbox>["where"]>>[number];

function needsAction(label: ReplyLabel | null, handledAt: Date | null): boolean {
  return !handledAt && (label === null || NEEDS_ACTION_LABELS.includes(label));
}

function toItem(r: InboxRow): InboxItemDto {
  const m = r.m;
  return {
    id: m.id,
    receivedAt: r.receivedAtIso ?? m.sentAt.toISOString(),
    from: { email: m.fromEmail ?? "", name: m.fromName },
    contact: r.contact?.id ? r.contact : null,
    company: r.company?.id ? r.company : null,
    mailbox: { id: r.mailbox.id, email: r.mailbox.email },
    subject: m.subject,
    label: m.label,
    labelSource: m.labelSource,
    labelConfidence: m.labelConfidence,
    summary: m.summary,
    snippet: snippetOf(m.bodyText ?? ""),
    matchedBy: m.matchKind ?? "thread",
    sequence: r.sequence?.id ? r.sequence : null,
    stepPosition: m.stepPosition,
    enrollmentId: m.enrollmentId,
    needsAction: needsAction(m.label, m.handledAt),
    handledAt: m.handledAt?.toISOString() ?? null,
  };
}

@Injectable()
export class InboxService {
  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
    @Optional() private readonly promises?: PromiseKeeperService,
  ) {}

  private scope<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, { workspaceId: auth.workspaceId, userId: auth.userId }, fn);
  }

  /** WHERE for "inbound replies this person may see". */
  private visible(auth: AuthContext) {
    return and(
      eq(messages.workspaceId, auth.workspaceId),
      eq(messages.direction, "inbound"),
      SEES_ALL.has(auth.role) ? undefined : eq(mailboxes.userId, auth.userId),
    );
  }

  list(auth: AuthContext, query: InboxQuery): Promise<InboxPageDto> {
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const onlyNeedsAction = query.needsAction ?? query.label === undefined;
    return this.scope(auth, async (tx) => {
      const rows = await selectInbox(tx, auth.workspaceId)
        .where(
          and(
            this.visible(auth),
            query.label ? eq(messages.label, query.label) : undefined,
            query.mailboxId ? eq(messages.mailboxId, query.mailboxId) : undefined,
            onlyNeedsAction
              ? and(isNull(messages.handledAt), inArray(messages.label, [...NEEDS_ACTION_LABELS]))
              : undefined,
            after
              ? sql`(${messages.receivedAt}, ${messages.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(messages.receivedAt), desc(messages.id))
        .limit(query.limit + 1);
      const items = rows.slice(0, query.limit);
      const last = items[items.length - 1];
      return {
        items: items.map(toItem),
        nextCursor:
          rows.length > query.limit && last?.receivedAtIso
            ? encodeCursor(last.receivedAtIso, last.m.id)
            : null,
      };
    });
  }

  counts(auth: AuthContext): Promise<InboxCountsDto> {
    return this.scope(auth, async (tx) => {
      const rows = await tx
        .select({ label: messages.label, n: count() })
        .from(messages)
        .innerJoin(
          mailboxes,
          and(eq(mailboxes.id, messages.mailboxId), eq(mailboxes.workspaceId, auth.workspaceId)),
        )
        .where(and(this.visible(auth), isNull(messages.handledAt)))
        .groupBy(messages.label);
      const byLabel = Object.fromEntries(REPLY_LABELS.map((l) => [l, 0])) as Record<
        ReplyLabel,
        number
      >;
      for (const r of rows) if (r.label) byLabel[r.label] = Number(r.n);
      return {
        needsAction: NEEDS_ACTION_LABELS.reduce((sum, l) => sum + byLabel[l], 0),
        byLabel,
      };
    });
  }

  private async loadRow(tx: Tx, auth: AuthContext, id: string): Promise<InboxRow> {
    const [row] = await selectInbox(tx, auth.workspaceId)
      .where(and(eq(messages.id, id), this.visible(auth)))
      .limit(1);
    // Another workspace's reply, an outbound message, or another rep's mailbox: all look the same.
    if (!row) throw notFound("Message");
    return row;
  }

  get(auth: AuthContext, id: string): Promise<InboxMessageDto> {
    return this.scope(auth, (tx) => this.detail(tx, auth, id));
  }

  private async detail(tx: Tx, auth: AuthContext, id: string): Promise<InboxMessageDto> {
    const row = await this.loadRow(tx, auth, id);
    const m = row.m;
    const ws = auth.workspaceId;
    const [original] = m.replyToId
      ? await tx
          .select({
            id: messages.id,
            subject: messages.subject,
            stepPosition: messages.stepPosition,
            sentAt: messages.sentAt,
          })
          .from(messages)
          .where(
            and(
              eq(messages.id, m.replyToId),
              eq(messages.workspaceId, ws),
              eq(messages.direction, "outbound"),
            ),
          )
      : [];
    const [enrollment] = m.enrollmentId
      ? await tx
          .select({
            id: enrollments.id,
            state: enrollments.state,
            nextRunAt: enrollments.nextRunAt,
            lastDecision: enrollments.lastDecision,
          })
          .from(enrollments)
          .where(and(eq(enrollments.id, m.enrollmentId), eq(enrollments.workspaceId, ws)))
      : [];
    const replies = await tx
      .select({
        id: messages.id,
        subject: messages.subject,
        sentAt: messages.sentAt,
        status: messages.status,
      })
      .from(messages)
      .where(
        and(
          eq(messages.workspaceId, ws),
          eq(messages.direction, "outbound"),
          eq(messages.replyToId, m.id),
        ),
      )
      .orderBy(asc(messages.sentAt));
    return {
      ...toItem(row),
      text: m.bodyText ?? "",
      original: original ? { ...original, sentAt: original.sentAt.toISOString() } : null,
      enrollment: enrollment
        ? { ...enrollment, nextRunAt: enrollment.nextRunAt?.toISOString() ?? null }
        : null,
      referral: m.referral ?? null,
      replies: replies.map((r) => ({ ...r, sentAt: r.sentAt.toISOString() })),
      openUrl: gmailOpenUrl(row.mailbox.email, m.providerThreadId),
    };
  }

  /**
   * Relabel and/or mark handled. Changing the label TO unsubscribe applies the suppression; changing
   * it away never undoes one (that stays an admin action in Suppressions).
   */
  update(auth: AuthContext, id: string, input: InboxUpdateInput): Promise<InboxMessageDto> {
    return this.scope(auth, async (tx) => {
      const row = await this.loadRow(tx, auth, id);
      const m = row.m;
      const now = new Date();
      const patch: Partial<typeof messages.$inferInsert> = {};
      if (input.label !== undefined && input.label !== m.label) {
        patch.label = input.label;
        patch.labelSource = "user";
        patch.labelConfidence = null;
      }
      if (input.handled !== undefined)
        patch.handledAt = input.handled ? (m.handledAt ?? now) : null;
      if (Object.keys(patch).length) {
        await tx
          .update(messages)
          .set(patch)
          .where(and(eq(messages.id, m.id), eq(messages.workspaceId, auth.workspaceId)));
      }
      let enrollmentsChanged = 0;
      if (patch.label === "unsubscribe" && m.contactId && row.contact?.email) {
        const match: Match = {
          kind: m.matchKind ?? "thread",
          contactId: m.contactId,
          contactEmail: row.contact.email,
          enrollmentId: m.enrollmentId,
          outboundId: m.replyToId,
          stepPosition: m.stepPosition,
        };
        enrollmentsChanged = await applyEffects(
          tx,
          { workspaceId: auth.workspaceId, mailboxId: row.mailbox.id, now },
          match,
          {
            label: "unsubscribe",
            source: "rule",
            confidence: 1,
            summary: null,
            returnDate: null,
            referral: null,
          },
          m.fromEmail ?? row.contact.email,
          null,
        );
      }
      if (Object.keys(patch).length) {
        await this.audit.record(tx, {
          workspaceId: auth.workspaceId,
          actorId: auth.userId,
          action: patch.label ? "reply.relabelled" : "reply.handled",
          entity: "message",
          entityId: m.id,
          metadata: {
            ...(patch.label ? { from: m.label, to: patch.label } : {}),
            ...(input.handled !== undefined ? { handled: input.handled } : {}),
            ...(enrollmentsChanged ? { enrollmentsChanged } : {}),
          },
        });
      }
      return this.detail(tx, auth, id);
    });
  }

  /**
   * Sends a threaded 1:1 reply from the mailbox that received the message. Every compliance check
   * applies (suppression, unsubscribed/bounced, consent where the law requires it, postal address
   * + unsubscribe footer) except the sequence send window: the prospect started this exchange.
   */
  async reply(auth: AuthContext, id: string, input: InboxReplyInput): Promise<InboxMessageDto> {
    const plan = await this.scope(auth, async (tx) => {
      const row = await this.loadRow(tx, auth, id);
      const m = row.m;
      const ws = auth.workspaceId;
      const blocked = (code: string, message: string) =>
        new ApiException(HttpStatus.CONFLICT, code, message);

      // Bounce reports, mail-system senders and machine-generated mail are never answered: the
      // reply would go to a mailer-daemon or a no-reply robot, not a person.
      if (
        m.label === "bounce" ||
        m.autoSubmitted ||
        (m.fromEmail !== null && isMachineAddress(m.fromEmail))
      ) {
        throw blocked(
          "reply_not_allowed",
          "This message was sent automatically (a bounce report or an auto-reply), so there's no one to reply to",
        );
      }
      const [mailbox] = await tx
        .select()
        .from(mailboxes)
        .where(and(eq(mailboxes.id, row.mailbox.id), eq(mailboxes.workspaceId, ws)));
      if (!mailbox || mailbox.status === "disconnected" || !mailbox.secretSealed) {
        throw blocked("mailbox_unavailable", "This mailbox is no longer connected");
      }
      if (mailbox.status === "error") {
        throw blocked("mailbox_unavailable", "Fix this mailbox's connection before replying");
      }
      if (!m.contactId || !row.contact?.id) {
        throw blocked("contact_missing", "The contact for this reply no longer exists");
      }
      const [contact] = await tx
        .select()
        .from(contacts)
        .where(and(eq(contacts.id, m.contactId), eq(contacts.workspaceId, ws)));
      if (!contact) throw blocked("contact_missing", "The contact for this reply no longer exists");

      const to = (m.fromEmail ?? contact.email).toLowerCase();
      const isContact = to === contact.email;
      // The same deterministic rules as the sending engine (packages/compliance), minus the send
      // window; the result is stored on the reply as proof.
      const domain = `@${to.split("@")[1] ?? ""}`;
      const hits = await tx
        .select({ value: suppressions.value })
        .from(suppressions)
        .where(and(eq(suppressions.workspaceId, ws), inArray(suppressions.value, [to, domain])));
      const records = isContact
        ? await tx
            .select()
            .from(consents)
            .where(and(eq(consents.workspaceId, ws), eq(consents.contactId, contact.id)))
        : [];
      const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, ws));
      const evaluation = evaluateEmailContact(
        {
          email: to,
          country: isContact ? contact.country : null,
          status: isContact ? contact.status : null,
          timeZone: contact.timeZone ?? workspace?.defaultTimeZone ?? "UTC",
          consent: currentConsent(records),
          suppressions: new Set(hits.map((h) => h.value)),
          mailingAddress: workspace?.mailingAddress,
          context: "reply",
        },
        new Date(),
      );
      const refusal = replyRefusal(evaluation, contact.status, Boolean(workspace?.mailingAddress));
      if (refusal || !workspace?.mailingAddress) {
        throw blocked(
          refusal?.code ?? "mailing_address_missing",
          refusal?.message ?? "Add your postal address in Workspace settings first",
        );
      }
      const proof = toComplianceProof(evaluation);

      const token = createUnsubscribeToken(
        { workspaceId: ws, contactId: contact.id },
        this.config.UNSUBSCRIBE_SECRET,
      );
      const base = this.config.WEB_URL.replace(/\/$/, "");
      const subject = `Re: ${m.subject.replace(/^(re:\s*)+/i, "")}`.slice(0, 300);
      const senderName = mailbox.displayName ?? auth.user.name;
      const rendered = renderEmail(
        subject,
        input.body,
        {
          firstName: contact.firstName,
          lastName: contact.lastName,
          email: contact.email,
          title: contact.title,
          senderName,
        },
        {
          mailingAddress: workspace.mailingAddress,
          senderCompany: workspace.name,
          unsubscribeUrl: `${base}/u/${token}`,
        },
      );
      const references = [...(m.referencesHeader?.split(/\s+/) ?? []), m.messageIdHeader]
        .filter(Boolean)
        .slice(-20)
        .join(" ");
      const messageId = newMessageId(mailbox.email);
      // Reserve first, like the engine: the row exists before the network send.
      const [reservation] = await tx
        .insert(messages)
        .values({
          workspaceId: ws,
          contactId: contact.id,
          mailboxId: mailbox.id,
          direction: "outbound",
          status: "sending",
          messageIdHeader: messageId,
          subject: rendered.subject,
          inReplyTo: m.messageIdHeader,
          referencesHeader: references.slice(0, 4000),
          providerThreadId: m.providerThreadId,
          replyToId: m.id,
          sentAt: new Date(),
          complianceProof: proof,
        })
        .returning({ id: messages.id });
      return {
        reservationId: reservation!.id,
        mailbox,
        email: {
          from: { email: mailbox.email, name: senderName },
          to,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          headers: buildUnsubscribeHeaders(`${base}/api/v1/public/unsubscribe/${token}`),
          messageId,
          inReplyTo: m.messageIdHeader,
          references,
          providerThreadId:
            mailbox.provider === "gmail" ? (m.providerThreadId ?? undefined) : undefined,
        },
      };
    });

    let providerMessageId: string;
    try {
      const adapter = await createMailAdapter(plan.mailbox, {
        outreach: this.config.outreach,
        secretsKey: this.config.secretsKey,
        google: this.config.google,
        allowPrivateSmtpHosts: this.config.allowPrivateSmtpHosts,
      });
      providerMessageId = (await adapter.send(plan.email)).providerMessageId;
    } catch (error) {
      await this.scope(auth, (tx) =>
        tx
          .delete(messages)
          .where(
            and(eq(messages.id, plan.reservationId), eq(messages.workspaceId, auth.workspaceId)),
          ),
      );
      throw new ApiException(
        HttpStatus.BAD_GATEWAY,
        "send_failed",
        error instanceof SendError ? error.message : "The reply couldn't be sent. Try again.",
      );
    }

    const sent = await this.scope(auth, async (tx) => {
      const now = new Date();
      await tx
        .update(messages)
        .set({ status: "sent", providerMessageId, sentAt: now })
        .where(
          and(eq(messages.id, plan.reservationId), eq(messages.workspaceId, auth.workspaceId)),
        );
      await tx
        .update(messages)
        .set({ handledAt: now })
        .where(
          and(
            eq(messages.id, id),
            eq(messages.workspaceId, auth.workspaceId),
            isNull(messages.handledAt),
          ),
        );
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "reply.sent",
        entity: "message",
        entityId: plan.reservationId,
        metadata: { inReplyTo: id, mailboxId: plan.mailbox.id },
      });
      return this.detail(tx, auth, id);
    });
    // Promise Keeper (OL-E6): in the background, after the send; never affects the reply.
    try {
      this.promises?.keeper.afterOutboundSent({
        workspaceId: auth.workspaceId,
        messageId: plan.reservationId,
        text: input.body,
      });
    } catch {
      // Ignored: the reply was sent.
    }
    return sent;
  }
}
