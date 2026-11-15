import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import {
  ApproveAiActionInputSchema,
  FirstTouchDraftInputSchema,
  RejectAiActionInputSchema,
  ReplyDraftInputSchema,
  type AiActionDto,
} from "@openline/shared";
import { Auth, type AuthContext } from "../../common/auth-context";
import { parse } from "../../common/http";
import { ScoutService } from "./scout.service";

/** Scout drafts and their approval flow (all roles; ownership rules in ScoutService). */
@Controller("scout")
export class ScoutController {
  constructor(private readonly scout: ScoutService) {}

  @Post("drafts/first-touch")
  firstTouch(@Auth() auth: AuthContext, @Body() body: unknown): Promise<AiActionDto> {
    return this.scout.draftFirstTouch(auth, parse(FirstTouchDraftInputSchema, body));
  }

  @Post("drafts/reply")
  reply(@Auth() auth: AuthContext, @Body() body: unknown): Promise<AiActionDto> {
    return this.scout.draftReply(auth, parse(ReplyDraftInputSchema, body));
  }

  @Get("actions/:id")
  get(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string): Promise<AiActionDto> {
    return this.scout.get(auth, id);
  }

  @Post("actions/:id/approve")
  @HttpCode(200)
  approve(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<AiActionDto> {
    return this.scout.approve(auth, id, parse(ApproveAiActionInputSchema, body));
  }

  @Post("actions/:id/reject")
  @HttpCode(200)
  reject(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<AiActionDto> {
    return this.scout.reject(auth, id, parse(RejectAiActionInputSchema, body));
  }
}
