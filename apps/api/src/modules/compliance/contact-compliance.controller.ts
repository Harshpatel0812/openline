import { Controller, Get, Param, ParseUUIDPipe, Query, Res } from "@nestjs/common";
import {
  ComplianceQuerySchema,
  type ComplianceRecordDto,
  type ContactComplianceDto,
} from "@openline/shared";
import type { Response } from "express";
import { Auth, Roles, type AuthContext } from "../../common/auth-context";
import { parse } from "../../common/http";
import { ContactComplianceService } from "./contact-compliance.service";

/** Compliance Copilot for one contact: the evaluation now, and the proof export. */
@Controller("contacts/:id/compliance")
export class ContactComplianceController {
  constructor(private readonly compliance: ContactComplianceService) {}

  /** `?channel=email[&sequenceId=]` — every member of the workspace. */
  @Get()
  evaluate(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ): Promise<ContactComplianceDto> {
    return this.compliance.evaluate(auth, id, parse(ComplianceQuerySchema, query));
  }

  /** JSON download for a regulator or a complaint. Managers and up; audited. */
  @Roles("owner", "admin", "manager")
  @Get("record")
  async record(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ComplianceRecordDto> {
    const record = await this.compliance.record(auth, id);
    // The file name carries the contact id only, never the address.
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="openline-compliance-record-${record.contact.id}.json"`,
    );
    res.setHeader("Cache-Control", "no-store");
    return record;
  }
}
