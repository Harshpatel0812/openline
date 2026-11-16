import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import {
  AcceptPromiseInputSchema,
  DismissPromiseInputSchema,
  PromiseQuerySchema,
  type AcceptPromiseResultDto,
  type PromiseProposalDto,
} from "@openline/shared";
import { Auth, type AuthContext } from "../../common/auth-context";
import { parse } from "../../common/http";
import { PromisesService } from "./promises.service";

/** Promise Keeper proposals (OL-E6 §2). All roles; ownership rules in PromisesService. */
@Controller("promises")
export class PromisesController {
  constructor(private readonly promises: PromisesService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query() query: unknown): Promise<PromiseProposalDto[]> {
    return this.promises.list(auth, parse(PromiseQuerySchema, query));
  }

  @Post(":id/accept")
  @HttpCode(200)
  accept(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<AcceptPromiseResultDto> {
    return this.promises.accept(auth, id, parse(AcceptPromiseInputSchema, body ?? {}));
  }

  @Post(":id/dismiss")
  @HttpCode(200)
  dismiss(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<PromiseProposalDto> {
    return this.promises.dismiss(auth, id, parse(DismissPromiseInputSchema, body ?? {}));
  }
}
