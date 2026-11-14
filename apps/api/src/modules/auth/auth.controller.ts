import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import {
  ForgotPasswordInputSchema,
  LoginInputSchema,
  ResetPasswordInputSchema,
  SignupInputSchema,
  SwitchWorkspaceInputSchema,
  VerifyEmailInputSchema,
  type MeResponse,
} from "@openline/shared";
import type { Request, Response } from "express";
import { Auth, Public, type AuthContext, type AuthedRequest } from "../../common/auth-context";
import { CONFIG, type AppConfig } from "../../config";
import { parse } from "../../common/http";
import { RateLimiter } from "../../common/rate-limit";
import { AuthService, type ClientInfo } from "./auth.service";
import { SessionService } from "./session.service";

const FIFTEEN_MIN = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

@Controller("auth")
export class AuthController {
  // Per email+IP stops password guessing on one account; per IP stops spraying many accounts.
  private readonly loginPerAccount = new RateLimiter(10, FIFTEEN_MIN);
  private readonly loginPerIp = new RateLimiter(50, FIFTEEN_MIN);
  // Caps guessing on one account even when the attacker rotates IPs.
  private readonly loginPerEmail = new RateLimiter(30, 60 * 60 * 1000);
  private readonly signupPerIp: RateLimiter;
  private readonly resendPerUser = new RateLimiter(5, HOUR);
  private readonly forgotPerIp = new RateLimiter(20, HOUR);
  private readonly forgotPerEmail = new RateLimiter(5, HOUR);
  private readonly tokenPerIp = new RateLimiter(30, FIFTEEN_MIN);

  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    @Inject(CONFIG) config: AppConfig,
  ) {
    this.signupPerIp = new RateLimiter(config.SIGNUPS_PER_IP_PER_HOUR, 60 * 60 * 1000);
  }

  @Public()
  @Post("signup")
  async signup(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    this.signupPerIp.consume(clientIp(req));
    const input = parse(SignupInputSchema, body);
    const token = await this.auth.signup(input, client(req));
    this.sessions.setCookie(res, token);
    return { ok: true };
  }

  @Public()
  @Post("login")
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const input = parse(LoginInputSchema, body);
    const ip = clientIp(req);
    this.loginPerIp.consume(ip);
    this.loginPerAccount.consume(`${ip}|${input.email}`);
    this.loginPerEmail.consume(input.email);
    const token = await this.auth.login(input, client(req));
    this.loginPerAccount.reset(`${ip}|${input.email}`);
    this.sessions.setCookie(res, token);
    return { ok: true };
  }

  @Public()
  @Post("logout")
  @HttpCode(200)
  async logout(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    if (req.auth) await this.auth.recordLogout(req.auth);
    const token = this.sessions.readCookie(req.cookies as Record<string, string> | undefined);
    if (token) await this.sessions.revoke(token);
    this.sessions.clearCookie(res);
    return { ok: true };
  }

  @Public()
  @Post("verify-email")
  @HttpCode(200)
  async verifyEmail(@Body() body: unknown, @Req() req: Request): Promise<{ ok: true }> {
    this.tokenPerIp.consume(clientIp(req));
    const { token } = parse(VerifyEmailInputSchema, body);
    await this.auth.verifyEmail(token);
    return { ok: true };
  }

  @Post("resend-verification")
  @HttpCode(200)
  async resendVerification(@Auth() auth: AuthContext): Promise<{ ok: true }> {
    this.resendPerUser.consume(auth.userId);
    await this.auth.resendVerification(auth);
    return { ok: true };
  }

  /** Always 200 for any well-formed email (no account enumeration). */
  @Public()
  @Post("forgot-password")
  @HttpCode(200)
  async forgotPassword(@Body() body: unknown, @Req() req: Request): Promise<{ ok: true }> {
    this.forgotPerIp.consume(clientIp(req));
    const { email } = parse(ForgotPasswordInputSchema, body);
    this.forgotPerEmail.consume(email);
    await this.auth.forgotPassword(email);
    return { ok: true };
  }

  @Public()
  @Post("reset-password")
  @HttpCode(200)
  async resetPassword(@Body() body: unknown, @Req() req: Request): Promise<{ ok: true }> {
    this.tokenPerIp.consume(clientIp(req));
    const { token, password } = parse(ResetPasswordInputSchema, body);
    await this.auth.resetPassword(token, password);
    return { ok: true };
  }

  @Get("me")
  me(@Auth() auth: AuthContext): Promise<MeResponse> {
    return this.auth.me(auth);
  }

  @Post("switch-workspace")
  @HttpCode(200)
  async switchWorkspace(@Auth() auth: AuthContext, @Body() body: unknown): Promise<{ ok: true }> {
    const { workspaceId } = parse(SwitchWorkspaceInputSchema, body);
    await this.auth.switchWorkspace(auth, workspaceId);
    return { ok: true };
  }
}

function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

function client(req: Request): ClientInfo {
  return { ip: clientIp(req), userAgent: req.headers["user-agent"] };
}
