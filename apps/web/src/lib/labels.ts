/** Plain-language labels for Sprint 3 codes (mailboxes, sequences, enrollments, consent). */
import type {
  ConsentDto,
  EnrollResultDto,
  EnrollmentDto,
  MailboxDto,
  SequenceDto,
} from "@openline/shared";
import type { BadgeTone } from "@/components/ui";
import { ApiError, errorMessage } from "./api";
import { titleCase } from "./format";

export const CONSENT_LABELS: Record<ConsentDto["basis"], string> = {
  express: "Express consent",
  implied_purchase: "Implied — existing customer",
  implied_inquiry: "Implied — recent inquiry",
  legitimate_interest: "Legitimate interest",
  none: "None recorded",
};

export const PROVIDER_LABELS: Record<MailboxDto["provider"], string> = {
  gmail: "Gmail",
  smtp: "SMTP",
  graph: "Microsoft 365",
};

export const MAILBOX_STATUS_TONES: Record<MailboxDto["status"], BadgeTone> = {
  active: "success",
  paused: "neutral",
  error: "danger",
  disconnected: "warning",
};

export const SEQUENCE_STATUS_TONES: Record<SequenceDto["status"], BadgeTone> = {
  draft: "neutral",
  active: "success",
  paused: "warning",
  archived: "neutral",
};

export const ENROLLMENT_STATE_TONES: Record<EnrollmentDto["state"], BadgeTone> = {
  active: "success",
  paused: "warning",
  completed: "accent",
  replied: "info",
  bounced: "danger",
  unsubscribed: "warning",
  stopped: "neutral",
  error: "danger",
};

export const SKIP_REASON_LABELS: Record<EnrollResultDto["skipped"][number]["reason"], string> = {
  already_enrolled: "Already in this sequence",
  suppressed: "On your suppression list",
  unsubscribed: "Unsubscribed",
  bounced: "Email bounced before",
  no_consent: "Needs consent (Canada/EU rules)",
  not_found: "Contact no longer exists",
};

/** Why the engine did (or didn't) send — `EnrollmentDto.lastDecision`. */
const DECISION_LABELS: Record<string, string> = {
  outside_send_window: "Waiting for the contact's business hours",
  mailbox_daily_cap: "Mailbox hit today's limit",
  mailbox_spacing: "Spacing sends out from this mailbox",
  mailbox_paused: "Mailbox is paused",
  mailbox_error: "Mailbox has a problem — check Settings → Mailboxes",
  mailbox_disconnected: "Mailbox is disconnected — reconnect it in Settings → Mailboxes",
  mailbox_removed: "Stopped — the mailbox was removed",
  sequence_paused: "Sequence is paused",
  sequence_archived: "Stopped — the sequence was archived",
  mailing_address_missing: "Held — add a mailing address in workspace settings",
  sent: "Email sent — waiting for the next step",
  completed: "All steps sent",
  suppressed: "Stopped — on your suppression list",
  unsubscribed: "Stopped — contact unsubscribed",
  bounced: "Stopped — email bounced",
  no_consent: "Stopped — needs consent (Canada/EU rules)",
  contact_deleted: "Stopped — contact was deleted",
  contact_archived: "Stopped — contact was archived",
  send_failed: "Sending failed",
  retrying: "Sending failed — will retry",
  internal_error: "Something went wrong — we'll retry",
  replied: "Contact replied",
  paused_by_user: "Paused by a teammate",
  stopped_by_user: "Stopped by a teammate",
  marked_replied: "Marked as replied",
  resumed: "Resumed by a teammate",
  // Older codes, kept so existing rows still read well.
  paused: "Paused by a teammate",
  stopped: "Stopped by a teammate",
  mark_replied: "Marked as replied",
};

export function decisionLabel(code: string | null): string {
  if (!code) return "—";
  return DECISION_LABELS[code] ?? titleCase(code);
}

/**
 * What an enrollment row shows: the decision as its status, and only a real failure as an error.
 * Rows written before stop reasons moved to `lastDecision` carry them in `lastError`; those are
 * shown as the status too, never in red.
 */
export function enrollmentStatus(e: { lastDecision: string | null; lastError: string | null }): {
  label: string;
  error: string | null;
} {
  if (e.lastError && e.lastError in DECISION_LABELS) {
    return { label: decisionLabel(e.lastError), error: null };
  }
  return { label: decisionLabel(e.lastDecision), error: e.lastError };
}

/** Plain words for mailbox connection errors (API codes and ?error= query values). */
const MAILBOX_ERRORS: Record<string, string> = {
  mailbox_auth_failed:
    "The mail server rejected the username or password. Check them — Google Workspace and Microsoft 365 usually need an app password, not your normal password.",
  mailbox_unreachable:
    "We couldn't reach that mail server. Check the host name and port, and that the server accepts connections from the internet.",
  google_not_configured: "Gmail connection isn't set up on this server yet.",
  access_denied: "Google access wasn't granted, so the mailbox wasn't connected.",
  google_failed: "Google didn't complete the connection. Please try again.",
  signed_out: "Your session ended during the connection. Sign in and try again.",
  state_invalid: "The connection link expired. Please try connecting again.",
  state_expired: "The connection link expired. Please try connecting again.",
  state_mismatch: "That connection was started by a different account. Please try again.",
  mailbox_taken: "That Gmail address is already connected in this workspace.",
  email_not_verified: "Verify your email address before connecting a mailbox.",
  conflict: "That mailbox is already connected to this workspace.",
};

export function mailboxErrorMessage(codeOrErr: unknown): string {
  const code = codeOrErr instanceof ApiError ? codeOrErr.code : String(codeOrErr);
  const known = MAILBOX_ERRORS[code];
  if (known) return known;
  return codeOrErr instanceof ApiError
    ? errorMessage(codeOrErr)
    : "Something went wrong while connecting the mailbox. Please try again.";
}

/** "Jane Doe" or the email. */
export function enrollmentContactName(c: EnrollmentDto["contact"]): string {
  const n = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
  return n || c.email;
}

const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** Local date and time in the viewer's own time zone. */
export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : dateTimeFmt.format(d);
}

const dayUtcFmt = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** Calendar dates stored as UTC midnight (e.g. consent "obtained on"): don't shift by time zone. */
export function formatDay(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : dayUtcFmt.format(d);
}

export { titleCase };
