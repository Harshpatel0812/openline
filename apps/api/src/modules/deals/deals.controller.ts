import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import {
  CreateDealInputSchema,
  DealAttentionQuerySchema,
  DealQuerySchema,
  DealSummaryQuerySchema,
  MoveDealInputSchema,
  UpdateDealInputSchema,
  type DealAttentionDto,
  type DealDetailDto,
  type DealDto,
  type DealPageDto,
  type DealSummaryDto,
  type DealTimelineDto,
} from "@openline/shared";
import { Auth, type AuthContext } from "../../common/auth-context";
import { parse } from "../../common/http";
import { DealsService } from "./deals.service";

/**
 * Deals (OL-E7 §2–3). Every role reads every deal in the workspace; reps change only their own,
 * managers and above all (checked in the service: someone else's deal is 403, another
 * workspace's is 404).
 */
@Controller("deals")
export class DealsController {
  constructor(private readonly deals: DealsService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query() query: unknown): Promise<DealPageDto> {
    return this.deals.list(auth, parse(DealQuerySchema, query));
  }

  @Get("summary")
  summary(@Auth() auth: AuthContext, @Query() query: unknown): Promise<DealSummaryDto> {
    return this.deals.summary(auth, parse(DealSummaryQuerySchema, query));
  }

  @Get("attention")
  attention(@Auth() auth: AuthContext, @Query() query: unknown): Promise<DealAttentionDto> {
    return this.deals.attention(auth, parse(DealAttentionQuerySchema, query));
  }

  @Post()
  create(@Auth() auth: AuthContext, @Body() body: unknown): Promise<DealDetailDto> {
    return this.deals.create(auth, parse(CreateDealInputSchema, body));
  }

  @Get(":id")
  get(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string): Promise<DealDetailDto> {
    return this.deals.get(auth, id);
  }

  @Patch(":id")
  update(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<DealDetailDto> {
    return this.deals.update(auth, id, parse(UpdateDealInputSchema, body));
  }

  @Post(":id/move")
  @HttpCode(200)
  move(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<DealDetailDto> {
    return this.deals.move(auth, id, parse(MoveDealInputSchema, body));
  }

  @Get(":id/timeline")
  timeline(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<DealTimelineDto> {
    return this.deals.timeline(auth, id);
  }
}

/** Contact and company pages list their deals. */
@Controller()
export class RelatedDealsController {
  constructor(private readonly deals: DealsService) {}

  @Get("contacts/:id/deals")
  forContact(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<DealDto[]> {
    return this.deals.listFor(auth, "contact", id);
  }

  @Get("companies/:id/deals")
  forCompany(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<DealDto[]> {
    return this.deals.listFor(auth, "company", id);
  }
}
