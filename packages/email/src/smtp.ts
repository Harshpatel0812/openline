import nodemailer, { type Transporter } from "nodemailer";
import { SendError, type MailAdapter, type OutgoingEmail, type SendResult } from "./adapter";

export interface SmtpConfig {
  host: string;
  port: number;
  /** true = TLS from the start (465); false = STARTTLS upgrade required (587) or none (local). */
  secure: boolean;
  username?: string;
  password?: string;
  /** Require STARTTLS when not `secure` (always true except for local test servers). */
  requireTls?: boolean;
  /** IP address to connect to (from pinSmtpConfig); `host` is still used for TLS verification. */
  connectAddress?: string;
}

/**
 * Sends through any SMTP server: Google Workspace / Microsoft 365 app passwords, Zoho, Fastmail,
 * custom domains, or Mailpit locally. Also used for Openline's own transactional email.
 */
export class SmtpAdapter implements MailAdapter {
  readonly provider = "smtp" as const;
  private readonly transport: Transporter;

  constructor(config: SmtpConfig) {
    this.transport = nodemailer.createTransport({
      host: config.connectAddress ?? config.host,
      port: config.port,
      secure: config.secure,
      ...(config.connectAddress ? { tls: { servername: config.host } } : {}),
      requireTLS: config.requireTls ?? !config.secure,
      auth: config.username ? { user: config.username, pass: config.password ?? "" } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
  }

  static fromUrl(url: string): SmtpAdapter {
    const u = new URL(url);
    return new SmtpAdapter({
      host: u.hostname,
      port: Number(u.port || (u.protocol === "smtps:" ? 465 : 587)),
      secure: u.protocol === "smtps:",
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      requireTls: u.searchParams.get("requireTLS") !== "false",
    });
  }

  async verify(): Promise<void> {
    try {
      await this.transport.verify();
    } catch (error) {
      throw classify(error);
    }
  }

  async send(email: OutgoingEmail): Promise<SendResult> {
    try {
      const info = await this.transport.sendMail({
        from: email.from.name
          ? { name: email.from.name, address: email.from.email }
          : email.from.email,
        to: email.to,
        subject: email.subject,
        text: email.text,
        html: email.html,
        headers: email.headers,
        messageId: email.messageId,
        replyTo: email.replyTo,
        inReplyTo: email.inReplyTo,
        references: email.inReplyTo,
      });
      return { providerMessageId: String(info.messageId ?? email.messageId) };
    } catch (error) {
      throw classify(error);
    }
  }
}

/** Maps SMTP errors to retry decisions. 5xx on a recipient = permanent; auth failures = auth. */
export function classify(error: unknown): SendError {
  const e = error as { code?: string; responseCode?: number; message?: string };
  const code = e?.responseCode;
  // 530 = authentication required, 534/535 = credentials rejected: a mailbox problem, never a
  // reason to mark the recipient as bounced.
  if (e?.code === "EAUTH" || code === 530 || code === 534 || code === 535) {
    return new SendError("Mailbox sign-in failed — check the username and password", "auth");
  }
  if (code && code >= 500 && code < 600) {
    return new SendError(`Recipient rejected (${code})`, "permanent");
  }
  return new SendError("Temporary sending problem — will retry", "transient");
}
