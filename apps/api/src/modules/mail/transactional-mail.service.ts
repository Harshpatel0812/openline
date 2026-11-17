import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  CaptureAdapter,
  escapeHtml,
  newMessageId,
  SmtpAdapter,
  type MailAdapter,
} from "@openline/email";
import { CONFIG, type AppConfig } from "../../config";

export type TransactionalKind = "verify_email" | "reset_password" | "invite" | "crm_reconnect";

interface Message {
  kind: TransactionalKind;
  to: string;
  subject: string;
  /** Paragraphs of plain text (no user-controlled markup; escaped for HTML). */
  paragraphs: string[];
  action: { label: string; url: string };
}

interface TeamMessage {
  kind: "contact_enquiry";
  to: string;
  subject: string;
  text: string;
  /** Bare, validated address. */
  replyTo?: string;
}

/** "Openline <no-reply@openline.local>" → { name, email }. */
export function parseFrom(from: string): { email: string; name?: string } {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  if (match) return { name: match[1] || undefined, email: match[2]!.trim() };
  return { email: from.trim() };
}

/** Longest user-chosen name (person or workspace) we put in an email. */
export const MAX_DISPLAY_TEXT = 60;

/**
 * Makes user-chosen text (names) safe to show in an email to someone else: no links (anything
 * like http(s)://… or www.… is removed, so a name can't become a phishing link), no control
 * characters, collapsed whitespace, at most MAX_DISPLAY_TEXT characters.
 */
export function safeDisplayText(value: string): string {
  const cleaned = value
    // eslint-disable-next-line no-control-regex -- stripping control characters on purpose
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/(?:https?:\/\/|www\.)\S*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...cleaned].slice(0, MAX_DISPLAY_TEXT).join("").trim();
}

/**
 * Openline's own emails (verification, password reset, invites) — not outreach.
 * Transport: smtp (SMTP_URL) | log (prints the link; development only) | capture (tests).
 * Never logs links or tokens except in `log` mode during development.
 */
@Injectable()
export class TransactionalMailService {
  private readonly logger = new Logger("Mail");
  private readonly adapter: MailAdapter | null;
  private readonly from: { email: string; name?: string };

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    this.from = parseFrom(config.MAIL_FROM);
    this.adapter =
      config.MAIL_TRANSPORT === "smtp"
        ? SmtpAdapter.fromUrl(config.SMTP_URL!)
        : config.MAIL_TRANSPORT === "capture"
          ? new CaptureAdapter()
          : null;
  }

  /**
   * Goes to an address nobody has proven yet, so it carries no sign-up input (the name could be
   * used to put an attacker's text in front of a stranger): a neutral greeting only.
   */
  sendVerification(to: string, url: string): Promise<void> {
    return this.send({
      kind: "verify_email",
      to,
      subject: "Confirm your email for Openline",
      paragraphs: [
        "Hello,",
        "Please confirm your email address to start sending from Openline. The link works for 24 hours.",
        "If you didn't create an Openline account, you can ignore this email.",
      ],
      action: { label: "Confirm email", url },
    });
  }

  sendPasswordReset(to: string, name: string, url: string): Promise<void> {
    return this.send({
      kind: "reset_password",
      to,
      subject: "Reset your Openline password",
      paragraphs: [
        `Hi ${name},`,
        "Someone asked to reset the password for your Openline account. The link works for 1 hour and can be used once.",
        "If it wasn't you, ignore this email — your password stays the same.",
      ],
      action: { label: "Choose a new password", url },
    });
  }

  sendInvite(
    to: string,
    inviterName: string,
    workspaceName: string,
    url: string,
    validDays: number,
  ): Promise<void> {
    const inviter = safeDisplayText(inviterName) || "A teammate";
    const workspace = safeDisplayText(workspaceName);
    return this.send({
      kind: "invite",
      to,
      subject: workspace
        ? `${inviter} invited you to ${workspace} on Openline`
        : `${inviter} invited you to their team on Openline`,
      paragraphs: [
        workspace
          ? `${inviter} invited you to join the ${workspace} team on Openline.`
          : `${inviter} invited you to join their team on Openline.`,
        `The invite works for ${validDays} days.`,
      ],
      action: { label: "Accept the invite", url },
    });
  }

  /** OL-E8: the CRM connection needs an admin to reconnect it (sent once per incident). */
  sendCrmReconnect(to: string, providerLabel: string, url: string): Promise<void> {
    return this.send({
      kind: "crm_reconnect",
      to,
      subject: `Reconnect ${providerLabel} to keep Openline in sync`,
      paragraphs: [
        "Hello,",
        `Openline can no longer reach your ${providerLabel} account: access was revoked or expired. Sync is stopped until an admin reconnects it. Nothing was deleted on either side.`,
      ],
      action: { label: `Reconnect ${providerLabel}`, url },
    });
  }

  /**
   * A plain-text notification to Openline's own team (e.g. a website enquiry). The caller builds
   * and sanitises the text; it is escaped again for the HTML part. Never logs subject, body or
   * addresses (they carry the visitor's personal data). Returns false when it could not be sent,
   * so the caller can tell the visitor to try again.
   */
  async sendToTeam(message: TeamMessage): Promise<boolean> {
    if (!this.adapter) {
      console.warn(`[mail:${message.kind}] not sent (MAIL_TRANSPORT=log)`);
      return true;
    }
    try {
      await this.adapter.send({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html:
          `<!doctype html><html><body><pre style="font-family:Arial,sans-serif;font-size:14px;` +
          `white-space:pre-wrap">${escapeHtml(message.text)}</pre></body></html>`,
        headers: { "Auto-Submitted": "auto-generated" },
        replyTo: message.replyTo,
        messageId: newMessageId(this.from.email),
      });
      return true;
    } catch (error) {
      this.logger.error(`Could not send ${message.kind} email (${(error as Error).name})`);
      return false;
    }
  }

  /** Never throws: a mail outage must not break sign-up or invites (the user can resend). */
  private async send(message: Message): Promise<void> {
    const text = `${message.paragraphs.join("\n\n")}\n\n${message.action.label}: ${message.action.url}\n\n— Openline\n`;
    const html =
      `<!doctype html><html><body style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">` +
      message.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("") +
      `<p><a href="${escapeHtml(message.action.url)}">${escapeHtml(message.action.label)}</a></p>` +
      `<p style="color:#64748b;font-size:12px">— Openline</p></body></html>`;

    if (!this.adapter) {
      // `log` transport: show the link so a developer can click it. Never outside development.
      if (this.config.NODE_ENV === "development") {
        console.warn(`[mail:${message.kind}] ${message.subject} → ${message.action.url}`);
      } else {
        console.warn(`[mail:${message.kind}] not sent (MAIL_TRANSPORT=log)`);
      }
      return;
    }
    try {
      await this.adapter.send({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text,
        html,
        headers: { "Auto-Submitted": "auto-generated" },
        messageId: newMessageId(this.from.email),
      });
    } catch (error) {
      // No address, link or provider message in logs (personal data / token).
      this.logger.error(`Could not send ${message.kind} email (${(error as Error).name})`);
    }
  }
}
