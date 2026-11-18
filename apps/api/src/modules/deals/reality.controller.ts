import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import {
  RealityFlagDismissInputSchema,
  RealityFlagIdSchema,
  RealitySuggestionDismissInputSchema,
  type DealDetailDto,
  type RealityCheckDto,
  type RealityCheckResponseDto,
} from "@openline/shared";
import { Auth, type AuthContext } from "../../common/auth-context";
import { parse } from "../../common/http";
import { RealityService } from "./reality.service";

/**
 * Pipeline Reality Check (OL-E7 §4). Everyone reads the latest check; the deal's owner or a
 * manager runs it ("Check now", 10 per deal per day), dismisses flags and accepts or dismisses
 * the stage-move suggestion (checked in the service: someone else's deal is 403, another
 * workspace's is 404).
 */
@Controller("deals/:id/reality-check")
export class RealityController {
  constructor(private readonly reality: RealityService) {}

  @Post()
  @HttpCode(200)
  run(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string): Promise<RealityCheckDto> {
    return this.reality.run(auth, id);
  }

  @Get()
  latest(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<RealityCheckResponseDto> {
    return this.reality.latest(auth, id);
  }

  @Post("flags/:flagId/dismiss")
  @HttpCode(200)
  dismissFlag(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("flagId") flagId: string,
    @Body() body: unknown,
  ): Promise<RealityCheckDto> {
    return this.reality.dismissFlag(
      auth,
      id,
      parse(RealityFlagIdSchema, flagId),
      parse(RealityFlagDismissInputSchema, body),
    );
  }

  @Post("suggestion/accept")
  @HttpCode(200)
  accept(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{ deal: DealDetailDto; check: RealityCheckDto }> {
    return this.reality.accept(auth, id);
  }

  @Post("suggestion/dismiss")
  @HttpCode(200)
  dismissSuggestion(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<RealityCheckDto> {
    return this.reality.dismissSuggestion(
      auth,
      id,
      parse(RealitySuggestionDismissInputSchema, body),
    );
  }
}
