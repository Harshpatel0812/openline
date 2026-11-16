/**
 * Turns a raw inbound email into the few fields reply detection needs. Inbound mail is untrusted:
 * we keep plain text only (HTML is converted, never stored), trim the quoted history and cap the
 * size. Attachments are parsed by mailparser but only DSN parts are read; nothing is stored.
 */
import { createHash } from "node:crypto";
import { trimQuoted as trimQuotedText } from "@openline/ai";
import { convert } from "html-to-text";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";

export const MAX_BODY_CHARS = 20_000;
const MAX_SUBJECT_CHARS = 500;
const MAX_REFERENCES = 50;

export interface BounceInfo {
  /** Enhanced status code, e.g. "5.1.1". */
  status: string | null;
  /** 5.x.x = permanent. 4.x.x (or no status) is ignored. */
  permanent: boolean;
  /** The address that failed (Final-Recipient / Original-Recipient). */
  recipient: string | null;
  /** Message-ID of the email that bounced, from the returned headers. */
  originalMessageId: string | null;
}

export interface ParsedInbound {
  messageId: string;
  inReplyTo: string | null;
  /** References + In-Reply-To, oldest first, de-duplicated. */
  references: string[];
  from: { email: string; name: string | null };
  subject: string;
  date: Date | null;
  /** Trimmed plain text, ≤ MAX_BODY_CHARS. */
  text: string;
  /** Auto-Submitted: auto-replied, X-Autoreply, X-Autorespond, Precedence: auto_reply. */
  autoReply: boolean;
  /** The Auto-Submitted value ("auto-generated", "auto-replied", ...) when present and not "no". */
  autoSubmitted: string | null;
  /** Mailing-list / bulk mail: List-Id, List-Unsubscribe, or Precedence bulk | list | junk. */
  bulk: boolean;
  /** Sent by a mail system (mailer-daemon / postmaster) or a no-reply style address. */
  machineSender: boolean;
  /** Set when this is a delivery status notification (bounce report). */
  bounce: BounceInfo | null;
}

function headerText(mail: ParsedMail, name: string): string {
  const value = mail.headers.get(name);
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && "value" in value && typeof value.value === "string") {
    return value.value;
  }
  return String(value);
}

function firstAddress(from: AddressObject | AddressObject[] | undefined) {
  const list = Array.isArray(from) ? from : from ? [from] : [];
  for (const group of list) {
    for (const entry of group.value) {
      if (entry.address) return { email: entry.address.toLowerCase(), name: entry.name || null };
    }
  }
  return null;
}

const MESSAGE_ID = /<[^<>\s]{1,250}>/g;

function messageIds(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const joined = Array.isArray(value) ? value.join(" ") : value;
  const found = joined.match(MESSAGE_ID);
  if (found) return found;
  // mailparser sometimes strips the brackets.
  return joined
    .split(/\s+/)
    .filter((v) => /^[^<>\s@]+@[^<>\s]+$/.test(v))
    .map((v) => `<${v}>`);
}

/**
 * Cuts the quoted history (see @openline/ai `trimQuoted`, shared with Promise Keeper's fallback so
 * both cut an email at the same place), at most MAX_BODY_CHARS long.
 */
export function trimQuoted(input: string): string {
  return trimQuotedText(input, MAX_BODY_CHARS);
}

const STATUS = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/;

function parseDeliveryStatus(report: string): Pick<BounceInfo, "status" | "recipient"> {
  const status = /^Status:\s*([245]\.\d{1,3}\.\d{1,3})/im.exec(report)?.[1] ?? null;
  const recipient =
    /^Final-Recipient:\s*rfc822;\s*<?([^\s<>;]+@[^\s<>;]+)>?/im.exec(report)?.[1] ??
    /^Original-Recipient:\s*rfc822;\s*<?([^\s<>;]+@[^\s<>;]+)>?/im.exec(report)?.[1] ??
    null;
  return { status, recipient: recipient?.toLowerCase() ?? null };
}

/**
 * multipart/report; report-type=delivery-status. mailparser keeps header parameters apart from the
 * value ({ value, params }), so the string form alone never shows the report type.
 */
export function isDeliveryReport(mail: ParsedMail): boolean {
  const header = mail.headers.get("content-type") as
    string | { value?: string; params?: Record<string, string> } | undefined;
  if (!header) return false;
  if (typeof header === "string") {
    const v = header.toLowerCase();
    return v.includes("multipart/report") && /report-type\s*=\s*"?delivery-status/.test(v);
  }
  const type = (header.value ?? "").toLowerCase();
  const reportType = (header.params?.["report-type"] ?? "").toLowerCase().replace(/"/g, "");
  return type === "multipart/report" && reportType === "delivery-status";
}

const DAEMON_LOCAL = /^(mailer-daemon|postmaster|mail-daemon|mailerdaemon)$/i;
const NO_REPLY_LOCAL =
  /^(no-?reply|do-?not-?reply|donot-?reply|notifications?|notify|alerts?|mailer|bounces?|newsletters?|news|digest|automated|auto-?confirm|system)([+._-].*)?$/i;

/** True for mail-system and no-reply style sender addresses (never a person answering). */
export function isMachineAddress(email: string): boolean {
  const local = email.split("@")[0] ?? "";
  return DAEMON_LOCAL.test(local) || NO_REPLY_LOCAL.test(local);
}

function bounceInfo(mail: ParsedMail, fromEmail: string, text: string): BounceInfo | null {
  const isReport = isDeliveryReport(mail);
  const local = fromEmail.split("@")[0] ?? "";
  const fromDaemon = DAEMON_LOCAL.test(local);
  if (!isReport && !fromDaemon) return null;

  let status: string | null = null;
  let recipient: string | null = null;
  let originalMessageId: string | null = null;
  for (const part of mail.attachments ?? []) {
    const type = part.contentType.toLowerCase();
    const body = part.content.subarray(0, 64_000).toString("utf8");
    if (type === "message/delivery-status" || type === "message/global-delivery-status") {
      ({ status, recipient } = parseDeliveryStatus(body));
    } else if (
      type === "text/rfc822-headers" ||
      type === "message/rfc822" ||
      type === "message/rfc822-headers" ||
      type === "message/global-headers"
    ) {
      originalMessageId = /^Message-ID:\s*(<[^<>\s]+>)/im.exec(body)?.[1] ?? originalMessageId;
    }
  }
  // Non-standard bounces (plain text from MAILER-DAEMON): look in the text itself.
  if (!status) {
    const fromText = parseDeliveryStatus(text);
    status = fromText.status ?? STATUS.exec(text)?.[0] ?? null;
    recipient ??= fromText.recipient;
  }
  originalMessageId ??= /^Message-ID:\s*(<[^<>\s]+>)/im.exec(text)?.[1] ?? null;
  return {
    status,
    permanent: Boolean(status?.startsWith("5.")),
    recipient,
    originalMessageId,
  };
}

function autoSubmittedValue(mail: ParsedMail): string | null {
  const value = headerText(mail, "auto-submitted").trim().toLowerCase();
  if (!value || value === "no" || value.startsWith("no;")) return null;
  return value.split(";")[0]!.trim() || null;
}

function isBulk(mail: ParsedMail): boolean {
  const precedence = headerText(mail, "precedence").trim().toLowerCase();
  // mailparser folds List-* headers into one "list" header; the raw lines keep their names.
  const lines = new Set((mail.headerLines ?? []).map((h) => h.key.toLowerCase()));
  return (
    lines.has("list-id") ||
    lines.has("list-unsubscribe") ||
    mail.headers.has("list-id") ||
    mail.headers.has("list-unsubscribe") ||
    /^(bulk|list|junk)\b/.test(precedence)
  );
}

function isAutoReply(mail: ParsedMail): boolean {
  const autoSubmitted = headerText(mail, "auto-submitted").toLowerCase();
  const precedence = headerText(mail, "precedence").toLowerCase();
  return (
    autoSubmitted.startsWith("auto-replied") ||
    mail.headers.has("x-autoreply") ||
    mail.headers.has("x-autorespond") ||
    precedence.includes("auto_reply")
  );
}

/** HTML → plain text: no images (tracking pixels), no link targets, no scripts or styles. */
export function htmlToText(html: string): string {
  return convert(html.slice(0, 1_000_000), {
    wordwrap: false,
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "a", options: { ignoreHref: true } },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "head", format: "skip" },
      { selector: "blockquote", format: "skip" },
    ],
  });
}

/** Parses a raw message. Throws on input that isn't an email at all. */
export async function parseInbound(raw: Buffer): Promise<ParsedInbound> {
  const mail = await simpleParser(raw, {
    skipHtmlToText: true,
    skipImageLinks: true,
    skipTextLinks: true,
    skipTextToHtml: true,
    maxHtmlLengthToParse: 1_000_000,
  });
  const from = firstAddress(mail.from) ?? { email: "", name: null };
  // HTML-only mail is converted to text here; HTML itself is never kept.
  const plain = mail.text?.trim() ? mail.text : mail.html ? htmlToText(mail.html) : "";
  const fullText = plain.slice(0, 200_000);
  const inReplyTo = messageIds(mail.inReplyTo)[0] ?? null;
  const references = [
    ...new Set([...messageIds(mail.references), ...(inReplyTo ? [inReplyTo] : [])]),
  ];
  const messageId =
    messageIds(mail.messageId)[0] ??
    // No Message-ID: derive a stable one so re-reading the message stays idempotent.
    `<sha256.${createHash("sha256").update(raw).digest("hex").slice(0, 40)}@openline.invalid>`;

  return {
    messageId,
    inReplyTo,
    references: references.slice(-MAX_REFERENCES),
    from,
    subject: (mail.subject ?? "")
      .replace(/[\r\n]+/g, " ")
      .trim()
      .slice(0, MAX_SUBJECT_CHARS),
    date: mail.date && !Number.isNaN(mail.date.getTime()) ? mail.date : null,
    text: trimQuoted(fullText),
    autoReply: isAutoReply(mail),
    autoSubmitted: autoSubmittedValue(mail),
    bulk: isBulk(mail),
    machineSender: isMachineAddress(from.email),
    bounce: bounceInfo(mail, from.email, fullText),
  };
}

/** First non-empty line, ≤ 200 characters (the inbox snippet). */
export function snippetOf(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.trim().slice(0, 200);
}
