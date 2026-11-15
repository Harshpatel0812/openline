/**
 * Every mail provider (SMTP, Gmail API, Microsoft Graph) implements MailAdapter, so the sequence
 * engine never depends on one provider.
 */
import { randomBytes } from "node:crypto";

export interface OutgoingEmail {
  from: { email: string; name?: string | null };
  to: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  /** Our generated Message-ID (stored so replies can be matched to the enrollment). */
  messageId: string;
  /** Message-ID of the first email in the thread, for follow-ups. */
  inReplyTo?: string;
  /** Full References chain (space-separated Message-IDs); defaults to inReplyTo. */
  references?: string;
  /** Gmail thread id, when continuing a thread on Gmail. */
  providerThreadId?: string;
}

export interface SendResult {
  providerMessageId: string;
  providerThreadId?: string;
}

/** A send failure, classified so the engine knows whether to retry. */
export class SendError extends Error {
  constructor(
    message: string,
    /** "transient" → retry later; "permanent" → this recipient will never work (hard bounce);
     *  "auth" → the mailbox credentials are broken (pause the mailbox, tell the user). */
    readonly kind: "transient" | "permanent" | "auth",
  ) {
    super(message);
    this.name = "SendError";
  }
}

export interface MailAdapter {
  readonly provider: "gmail" | "graph" | "smtp" | "capture";
  send(email: OutgoingEmail): Promise<SendResult>;
  /** Checks credentials without sending (used when a mailbox is connected). */
  verify(): Promise<void>;
}

/** RFC 5322 Message-ID on the sender's domain, e.g. <ol.abc123@acme.com>. */
export function newMessageId(fromEmail: string): string {
  const domain = fromEmail.split("@")[1] ?? "openline.app";
  return `<ol.${randomBytes(12).toString("hex")}@${domain}>`;
}

/**
 * Test/dev adapter that keeps sent emails in memory. Used by integration tests and by local
 * development when no SMTP server is running.
 */
export class CaptureAdapter implements MailAdapter {
  readonly provider = "capture" as const;
  static readonly outbox: OutgoingEmail[] = [];

  async send(email: OutgoingEmail): Promise<SendResult> {
    CaptureAdapter.outbox.push(email);
    return { providerMessageId: email.messageId };
  }

  async verify(): Promise<void> {}
}
