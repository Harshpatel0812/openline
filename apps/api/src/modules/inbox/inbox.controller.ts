import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import {
  InboxQuerySchema,
  InboxReplyInputSchema,
  InboxUpdateInputSchema,
  type InboxCountsDto,
  type InboxMessageDto,
  type InboxPageDto,
} from "@openline/shared";
import { Auth, type AuthContext } from "../../common/auth-context";
import { parse } from "../../common/http";
import { InboxService } from "./inbox.service";

/** The reply inbox (OL-E4 §3). Reps see replies to their own mailboxes; managers+ see all. */
@Controller("inbox")
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query() query: unknown): Promise<InboxPageDto> {
    return this.inbox.list(auth, parse(InboxQuerySchema, query));
  }

  @Get("counts")
  counts(@Auth() auth: AuthContext): Promise<InboxCountsDto> {
    return this.inbox.counts(auth);
  }

  @Get(":id")
  get(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string): Promise<InboxMessageDto> {
    return this.inbox.get(auth, id);
  }

  @Patch(":id")
  update(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<InboxMessageDto> {
    return this.inbox.update(auth, id, parse(InboxUpdateInputSchema, body));
  }

  @Post(":id/reply")
  reply(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<InboxMessageDto> {
    return this.inbox.reply(auth, id, parse(InboxReplyInputSchema, body));
  }
}
