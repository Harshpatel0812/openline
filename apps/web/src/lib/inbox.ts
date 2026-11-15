/** Plain-language labels and helpers for the reply inbox (Sprint 4, OL-E4 §2–3). */
import type { InboxItemDto, ReplyLabel } from "@openline/shared";
import type { BadgeTone } from "@/components/ui";
import { ApiError, errorMessage } from "./api";

export const REPLY_LABEL_TEXT: Record<ReplyLabel, string> = {
  interested: "Interested",
  not_now: "Not now",
  referral: "Referral",
  not_interested: "Not interested",
  unsubscribe: "Unsubscribe",
  out_of_office: "Out of office",
  bounce: "Bounce",
  other: "Other",
};

/**
 * One colour per label, always next to the label's name (colour is never the only signal). The
 * Badge tones are AA on their own backgrounds in light and dark mode.
 */
export const REPLY_LABEL_TONES: Record<ReplyLabel, BadgeTone> = {
  interested: "success",
  referral: "info",
  not_now: "warning",
  other: "accent",
  not_interested: "neutral",
  out_of_office: "neutral",
  unsubscribe: "danger",
  bounce: "danger",
};

/** "Jane Doe", the sender's name, or the email. */
export function senderName(item: Pick<InboxItemDto, "contact" | "from">): string {
  const c = item.contact;
  const name = c ? [c.firstName, c.lastName].filter(Boolean).join(" ").trim() : "";
  return name || item.from.name?.trim() || c?.email || item.from.email;
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });
const fullFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const shortDayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** "5 min. ago", "yesterday", or "Nov 3" after a week. */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const sec = Math.round((t - now) / 1000);
  const abs = Math.abs(sec);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(sec / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(sec / 3600), "hour");
  if (abs < 7 * 86_400) return rtf.format(Math.round(sec / 86_400), "day");
  return shortDayFmt.format(new Date(t));
}

export function fullDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : fullFmt.format(d);
}

/** Only http(s) links are ever rendered from API data. */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Why a reply from the inbox wasn't sent: a title plus what to do next. */
export function replySendError(err: unknown): { title: string; body: string } {
  const code = err instanceof ApiError ? err.code : "";
  const known: Record<string, { title: string; body: string }> = {
    unsubscribed: {
      title: "This contact unsubscribed",
      body: "The law doesn't allow more email to them, so nothing was sent.",
    },
    bounced: {
      title: "This address bounced before",
      body: "Email to it can't be delivered, so nothing was sent.",
    },
    suppressed: {
      title: "This address is on your suppression list",
      body: "Nothing was sent. An admin can review it in Settings → Suppressions.",
    },
    no_consent: {
      title: "Consent needed",
      body: "Canadian and EU rules need a consent record for this contact before you email them. Add one on the contact's page.",
    },
    mailing_address_missing: {
      title: "Add your mailing address first",
      body: "Every email needs your postal address. An owner or admin can add it in Settings → Workspace.",
    },
    mailbox_unavailable: {
      title: "The mailbox can't send right now",
      body: "Reconnect or fix it in Settings → Mailboxes, then try again.",
    },
    contact_missing: {
      title: "The contact no longer exists",
      body: "It was deleted, so there's no one to reply to.",
    },
    send_failed: {
      title: "The mail server didn't accept the reply",
      body: "Nothing was sent. Try again in a minute; if it keeps failing, check the mailbox in Settings → Mailboxes.",
    },
  };
  const k = known[code];
  if (k) return k;
  if (err instanceof ApiError && err.status === 429) {
    return {
      title: "Too many replies at once",
      body: "Please wait a minute and try again.",
    };
  }
  return { title: "Reply not sent", body: errorMessage(err) };
}

/** Tells the app shell to refresh the inbox badge (after a reply is handled, relabelled…). */
export const INBOX_CHANGED_EVENT = "openline:inbox-changed";
export function notifyInboxChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(INBOX_CHANGED_EVENT));
}
