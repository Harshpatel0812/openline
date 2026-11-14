import { Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../../common/auth-context";
import { RateLimiter } from "../../common/rate-limit";
import { UnsubscribeService } from "./unsubscribe.service";

/**
 * Public, no session, no CSRF header (exempt in app.factory.ts): RFC 8058 one-click POSTs come
 * from mail providers' servers as `List-Unsubscribe=One-Click` (form-encoded). The token is an
 * HMAC, so the only thing a forged request could do is unsubscribe the link's own recipient.
 */
@Public()
@Controller("public/unsubscribe")
export class UnsubscribeController {
  // Generous: Gmail/Yahoo one-click requests share a few provider IPs.
  private readonly perIp = new RateLimiter(300, 15 * 60 * 1000);

  constructor(private readonly unsubscribe: UnsubscribeService) {}

  @Get(":token")
  lookup(
    @Param("token") token: string,
    @Req() req: Request,
  ): Promise<{ email: string; workspaceName: string; alreadyUnsubscribed: boolean }> {
    this.perIp.consume(req.ip ?? "unknown");
    return this.unsubscribe.lookup(token);
  }

  /** Accepts a one-click form body, JSON or no body at all; the body is not needed. */
  @Post(":token")
  @HttpCode(200)
  async confirm(@Param("token") token: string, @Req() req: Request): Promise<{ ok: true }> {
    this.perIp.consume(req.ip ?? "unknown");
    await this.unsubscribe.unsubscribe(token);
    return { ok: true };
  }
}
