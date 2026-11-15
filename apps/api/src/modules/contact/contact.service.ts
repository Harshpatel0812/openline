import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import type { ContactFormInput } from "@openline/shared";
import { ApiException } from "../../common/http";
import { CONFIG, type AppConfig } from "../../config";
import { safeDisplayText, TransactionalMailService } from "../mail/transactional-mail.service";

/** Longest subject we build (RFC 5322 recommends lines under 78 characters). */
export const MAX_SUBJECT = 78;

/** One line of visitor text: no control characters (so no CR/LF), collapsed whitespace. */
export function oneLine(value: string, max: number): string {
  const cleaned = value
    // eslint-disable-next-line no-control-regex -- stripping control characters on purpose
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...cleaned].slice(0, max).join("").trim();
}

/** Multi-line visitor text: keeps line breaks (normalised to \n), drops other control characters. */
export function multiLine(value: string): string {
  return (
    value
      .replace(/\r\n?/g, "\n")
      // eslint-disable-next-line no-control-regex -- stripping control characters on purpose
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
      .trim()
  );
}

/** A bare address for Reply-To: anything that could start a new header or a display name goes. */
export function replyToAddress(email: string): string | undefined {
  const cleaned = email.replace(/[\s<>"',;()\\]/g, "");
  return /^[^@]+@[^@]+$/.test(cleaned) ? cleaned : undefined;
}

export function enquirySubject(name: string): string {
  const prefix = "Website enquiry from ";
  const who = safeDisplayText(name) || "a visitor";
  return oneLine(`${prefix}${who}`, MAX_SUBJECT);
}

export function enquiryText(input: ContactFormInput): string {
  const lines = [
    "New enquiry from the Openline website contact form.",
    "",
    `Name: ${oneLine(input.name, 100)}`,
    `Email: ${oneLine(input.email, 254)}`,
    `Company: ${input.company ? oneLine(input.company, 120) : "-"}`,
    `Team size: ${input.teamSize ?? "-"}`,
    "",
    "Message:",
    multiLine(input.message),
    "",
    "Reply to this email to answer the visitor directly.",
  ];
  return `${lines.join("\n")}\n`;
}

/** Website enquiries become one email to CONTACT_INBOX; nothing is stored. */
@Injectable()
export class ContactService {
  private readonly logger = new Logger("Contact");

  constructor(
    private readonly mail: TransactionalMailService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async submit(input: ContactFormInput): Promise<void> {
    const sent = await this.mail.sendToTeam({
      kind: "contact_enquiry",
      to: this.config.CONTACT_INBOX,
      subject: enquirySubject(input.name),
      text: enquiryText(input),
      replyTo: replyToAddress(input.email),
    });
    if (!sent) {
      this.logger.warn("contact.enquiry_failed");
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        "contact_unavailable",
        "We couldn't send your message just now. Please try again in a few minutes.",
      );
    }
    this.logger.log("contact.enquiry_sent");
  }

  /** Honeypot hit: nothing is sent; only the event is logged. */
  dropped(): void {
    this.logger.log("contact.honeypot_dropped");
  }
}
