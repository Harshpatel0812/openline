/**
 * Pieces of the engine that other senders reuse: building a mailbox's adapter (the inbox's 1:1
 * replies), the bounce-rate auto-pause (bounce reports found by reply detection) and the "has this
 * enrollment been answered?" check.
 */
import {
  and,
  enrollments,
  eq,
  mailboxes,
  messages,
  sql,
  type Mailbox,
  type Tx,
} from "@openline/db";
import {
  CaptureAdapter,
  GmailAdapter,
  openJson,
  pinSmtpConfig,
  SendError,
  SmtpAdapter,
  type GoogleOAuthConfig,
  type MailAdapter,
  type MailboxSecret,
} from "@openline/email";
import { SENDING_DEFAULTS } from "@openline/shared";
import type { OutreachTransport } from "./types";

const DAY = 24 * 60 * 60_000;
/** Auto-pause a mailbox when more than this share of its last 24h sends hard-bounced. */
const BOUNCE_PAUSE_RATE = SENDING_DEFAULTS.bounceRatePauseThreshold;
const BOUNCE_MIN_SAMPLE = 20;

export interface MailAdapterOptions {
  outreach: OutreachTransport;
  secretsKey: Buffer;
  google?: GoogleOAuthConfig;
  allowPrivateSmtpHosts?: boolean;
}

/** The adapter that sends as `mailbox`, honouring the outreach transport (capture/sandbox/real). */
export async function createMailAdapter(
  mailbox: Mailbox,
  options: MailAdapterOptions,
): Promise<MailAdapter> {
  const transport = options.outreach;
  if (transport.mode === "capture") return new CaptureAdapter();
  if (transport.mode === "sandbox") return new SmtpAdapter(transport.smtp);

  const secret = openJson<MailboxSecret>(
    mailbox.secretSealed,
    options.secretsKey,
    mailbox.workspaceId,
  );
  if (mailbox.provider === "smtp" && secret.kind === "smtp") {
    // Re-resolved and checked on every send, then connected by address: a DNS answer that
    // changed since the mailbox was connected can't point us at our own network.
    const smtp = await pinSmtpConfig(
      {
        host: mailbox.smtpHost ?? "",
        port: mailbox.smtpPort ?? 587,
        secure: mailbox.smtpSecure ?? false,
        username: secret.username,
        password: secret.password,
      },
      { allowPrivate: options.allowPrivateSmtpHosts === true },
    );
    return new SmtpAdapter(smtp);
  }
  if (mailbox.provider === "gmail" && secret.kind === "oauth" && options.google) {
    return new GmailAdapter(options.google, secret.refreshToken);
  }
  throw new SendError(`No way to send from a ${mailbox.provider} mailbox here`, "auth");
}

/** Pauses a mailbox whose hard-bounce rate over the last 24 h is too high. */
export async function maybeAutoPauseMailbox(
  tx: Tx,
  workspaceId: string,
  mailboxId: string,
  t: Date,
): Promise<boolean> {
  const since = new Date(t.getTime() - DAY);
  const [sent] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.workspaceId, workspaceId),
        eq(messages.mailboxId, mailboxId),
        eq(messages.direction, "outbound"),
        sql`${messages.sentAt} > ${since}`,
      ),
    );
  const [bounced] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.workspaceId, workspaceId),
        eq(enrollments.mailboxId, mailboxId),
        eq(enrollments.state, "bounced"),
        sql`${enrollments.updatedAt} > ${since}`,
      ),
    );
  const total = (sent?.n ?? 0) + (bounced?.n ?? 0);
  if (total >= BOUNCE_MIN_SAMPLE && (bounced?.n ?? 0) / total > BOUNCE_PAUSE_RATE) {
    await tx
      .update(mailboxes)
      .set({
        status: "paused",
        lastError:
          "Paused automatically: too many bounces in 24 hours. Clean your list, then resume.",
        updatedAt: t,
      })
      .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.workspaceId, workspaceId)));
    return true;
  }
  return false;
}

/**
 * True when a human reply (anything but an out-of-office or a bounce report) for this enrollment
 * arrived after its last sequence step went out. Inbox replies (step_position NULL) don't count as
 * steps, so answering the prospect never re-opens the sequence.
 */
export async function hasReplyAfterLastStep(
  tx: Tx,
  workspaceId: string,
  enrollmentId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.workspaceId, workspaceId),
        eq(messages.enrollmentId, enrollmentId),
        eq(messages.direction, "inbound"),
        sql`coalesce(${messages.label}, 'other') NOT IN ('out_of_office', 'bounce')`,
        sql`${messages.receivedAt} > coalesce((
          SELECT max(o.sent_at) FROM messages o
           WHERE o.workspace_id = ${workspaceId}
             AND o.enrollment_id = ${enrollmentId}
             AND o.direction = 'outbound'
             AND o.step_position IS NOT NULL
        ), '-infinity'::timestamptz)`,
      ),
    )
    .limit(1);
  return Boolean(row);
}
