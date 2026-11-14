import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import {
  AcceptInviteInputSchema,
  InviteInputSchema,
  UpdateMemberRoleInputSchema,
  type InviteDto,
  type InviteLookupDto,
  type MemberDto,
} from "@openline/shared";
import type { Request, Response } from "express";
import { z } from "zod";
import {
  Auth,
  Public,
  Roles,
  type AuthContext,
  type AuthedRequest,
} from "../../common/auth-context";
import { parse } from "../../common/http";
import { RateLimiter } from "../../common/rate-limit";
import { SessionService } from "../auth/session.service";
import { MembersService } from "./members.service";

const TokenQuery = z.object({ token: z.string().min(20).max(200) });

@Controller()
export class MembersController {
  private readonly inviteLookups = new RateLimiter(60, 15 * 60 * 1000);

  constructor(
    private readonly members: MembersService,
    private readonly sessions: SessionService,
  ) {}

  @Get("members")
  list(@Auth() auth: AuthContext): Promise<MemberDto[]> {
    return this.members.list(auth);
  }

  @Roles("owner", "admin")
  @Patch("members/:userId")
  async changeRole(
    @Auth() auth: AuthContext,
    @Param("userId", ParseUUIDPipe) userId: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const { role } = parse(UpdateMemberRoleInputSchema, body);
    await this.members.changeRole(auth, userId, role);
    return { ok: true };
  }

  /** Owners/admins remove others; anyone can remove themselves (leave). Checked in the service. */
  @Delete("members/:userId")
  async remove(
    @Auth() auth: AuthContext,
    @Param("userId", ParseUUIDPipe) userId: string,
  ): Promise<{ ok: true }> {
    await this.members.remove(auth, userId);
    return { ok: true };
  }

  @Roles("owner", "admin")
  @Get("invites")
  listInvites(@Auth() auth: AuthContext): Promise<InviteDto[]> {
    return this.members.listInvites(auth);
  }

  @Roles("owner", "admin")
  @Post("invites")
  invite(
    @Auth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<{ invite: InviteDto; inviteUrl: string }> {
    return this.members.invite(auth, parse(InviteInputSchema, body));
  }

  @Roles("owner", "admin")
  @Delete("invites/:id")
  async revoke(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{ ok: true }> {
    await this.members.revokeInvite(auth, id);
    return { ok: true };
  }

  @Public()
  @Get("invites/lookup")
  lookup(@Query() query: unknown, @Req() req: Request): Promise<InviteLookupDto> {
    this.inviteLookups.consume(req.ip ?? "unknown");
    const { token } = parse(TokenQuery, query);
    return this.members.lookup(token);
  }

  @Public()
  @Post("invites/accept")
  @HttpCode(200)
  async accept(
    @Body() body: unknown,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    this.inviteLookups.consume(req.ip ?? "unknown");
    const input = parse(AcceptInviteInputSchema, body);
    const token = await this.members.accept(input, req.auth, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    if (token) this.sessions.setCookie(res, token);
    return { ok: true };
  }
}
