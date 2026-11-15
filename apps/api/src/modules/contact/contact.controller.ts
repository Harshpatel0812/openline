import { Body, Controller, HttpCode, Post, Req } from "@nestjs/common";
import {
  ContactFormHoneypotSchema,
  ContactFormInputSchema,
  type ContactFormResponse,
} from "@openline/shared";
import type { Request } from "express";
import { Public } from "../../common/auth-context";
import { parse } from "../../common/http";
import { RateLimiter } from "../../common/rate-limit";
import { ContactService } from "./contact.service";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Public website contact form. No session and no CSRF header (exempt in app.factory.ts): the
 * marketing site posts it cross-site, there is no cookie to ride on, and the only effect is one
 * email to our own inbox, capped per IP and per address.
 */
@Public()
@Controller("public/contact")
export class ContactController {
  private readonly perIp = new RateLimiter(5, HOUR);
  private readonly perEmail = new RateLimiter(3, DAY);

  constructor(private readonly contact: ContactService) {}

  @Post()
  @HttpCode(202)
  async submit(@Body() body: unknown, @Req() req: Request): Promise<ContactFormResponse> {
    // req.ip honours TRUST_PROXY, so a client can't dodge the limit by spoofing X-Forwarded-For.
    this.perIp.consume(req.ip ?? req.socket.remoteAddress ?? "unknown");
    if (ContactFormHoneypotSchema.safeParse(body).success) {
      this.contact.dropped();
      return { ok: true };
    }
    const input = parse(ContactFormInputSchema, body);
    this.perEmail.consume(input.email);
    await this.contact.submit(input);
    return { ok: true };
  }
}
