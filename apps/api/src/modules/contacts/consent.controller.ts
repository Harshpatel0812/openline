import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Res } from "@nestjs/common";
import { ConsentInputSchema, type ConsentDto } from "@openline/shared";
import type { Response } from "express";
import { Auth, Roles, type AuthContext } from "../../common/auth-context";
import { parse } from "../../common/http";
import { ConsentService } from "./consent.service";

@Controller("contacts/:id/consent")
export class ConsentController {
  constructor(private readonly consent: ConsentService) {}

  /** The latest record, or JSON `null` when none was ever recorded. */
  @Get()
  async latest(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    // Explicit res.json: Nest would send an empty body for a null return value.
    res.status(200).json(await this.consent.latest(auth, id));
  }

  @Roles("owner", "admin", "manager")
  @Put()
  record(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ConsentDto> {
    return this.consent.record(auth, id, parse(ConsentInputSchema, body));
  }
}
