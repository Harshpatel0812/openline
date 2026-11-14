import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { SuppressionCreateSchema, type SuppressionDto } from "@openline/shared";
import { Auth, Roles, type AuthContext } from "../../common/auth-context";
import { parse } from "../../common/http";
import { SuppressionsService } from "./suppressions.service";

@Controller("suppressions")
export class SuppressionsController {
  constructor(private readonly suppressions: SuppressionsService) {}

  @Get()
  list(@Auth() auth: AuthContext): Promise<SuppressionDto[]> {
    return this.suppressions.list(auth);
  }

  @Roles("owner", "admin")
  @Post()
  create(@Auth() auth: AuthContext, @Body() body: unknown): Promise<SuppressionDto> {
    return this.suppressions.create(auth, parse(SuppressionCreateSchema, body));
  }

  @Roles("owner", "admin")
  @Delete(":id")
  async remove(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{ ok: true }> {
    await this.suppressions.remove(auth, id);
    return { ok: true };
  }
}
