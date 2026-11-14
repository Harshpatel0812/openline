/**
 * Every mail provider (Gmail API, Microsoft Graph, SMTP) implements this interface,
 * so the sequence engine never depends on one provider. Implementations arrive in Sprints 2–4.
 */
export interface OutgoingEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  /** Message-ID of the previous email in the thread, for follow-ups. */
  inReplyTo?: string;
}

export interface SendResult {
  providerMessageId: string;
  messageIdHeader: string;
  threadId?: string;
}

export interface MailAdapter {
  readonly provider: "gmail" | "graph" | "smtp";
  send(email: OutgoingEmail): Promise<SendResult>;
}
