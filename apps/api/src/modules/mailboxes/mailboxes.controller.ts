import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import {
  MailboxUpdateInputSchema,
  SmtpMailboxInputSchema,
  type MailboxDto,
} from "@openline/shared";
import type { Response } from "express";
import { z } from "zod";
import { Auth, Public, type AuthContext, type AuthedRequest } from "../../common/auth-context";
import { parse } from "../../common/http";
import { MailboxesService } from "./mailboxes.service";

const CallbackQuery = z.object({
  code: z.string().max(2000).optional(),
  state: z.string().max(500).optional(),
  error: z.string().max(200).optional(),
});

@Controller("mailboxes")
export class MailboxesController {
  constructor(private readonly mailboxes: MailboxesService) {}

  @Get()
  list(@Auth() auth: AuthContext): Promise<MailboxDto[]> {
    return this.mailboxes.list(auth);
  }

  @Post("smtp")
  connectSmtp(@Auth() auth: AuthContext, @Body() body: unknown): Promise<MailboxDto> {
    return this.mailboxes.connectSmtp(auth, parse(SmtpMailboxInputSchema, body));
  }

  @Get("google/authorize")
  googleAuthorize(@Auth() auth: AuthContext): { url: string } {
    return this.mailboxes.googleAuthorize(auth);
  }

  /**
   * Browser redirect from Google. Public so a missing session becomes a redirect with
   * ?error=signed_out instead of a JSON 401; the signed state binds it to the signed-in user.
   */
  @Public()
  @Get("google/callback")
  async googleCallback(
    @Req() req: AuthedRequest,
    @Query() query: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const parsed = CallbackQuery.safeParse(query);
    const location = await this.mailboxes.googleCallback(
      req.auth,
      parsed.success ? parsed.data : { error: "invalid_request" },
    );
    res.redirect(302, location);
  }

  @Patch(":id")
  update(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<MailboxDto> {
    return this.mailboxes.update(auth, id, parse(MailboxUpdateInputSchema, body));
  }

  @Delete(":id")
  async remove(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{ ok: true }> {
    await this.mailboxes.remove(auth, id);
    return { ok: true };
  }
}
