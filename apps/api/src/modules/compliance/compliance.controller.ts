import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { Public } from "../../common/auth-context";
import { isWithinSendWindow } from "@openline/compliance";

/**
 * First slice of the Compliance Copilot: "Can I contact this person right now?"
 * Example: GET /v1/compliance/send-window?timeZone=America/New_York
 */
@Public()
@Controller("compliance")
export class ComplianceController {
  @Get("send-window")
  sendWindow(@Query("timeZone") timeZone?: string): { timeZone: string; allowedNow: boolean } {
    if (!timeZone) {
      throw new BadRequestException({ code: "missing_time_zone", message: "timeZone is required" });
    }
    try {
      return { timeZone, allowedNow: isWithinSendWindow(new Date(), timeZone) };
    } catch {
      throw new BadRequestException({ code: "invalid_time_zone", message: "Unknown time zone" });
    }
  }
}
