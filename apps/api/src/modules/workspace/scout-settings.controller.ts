import { Body, Controller, Get, Patch } from "@nestjs/common";
import { ScoutSettingsInputSchema, type ScoutSettingsDto } from "@openline/shared";
import { Auth, Roles, type AuthContext } from "../../common/auth-context";
import { parse } from "../../common/http";
import { ScoutSettingsService } from "./scout-settings.service";

@Controller("workspace/scout")
export class ScoutSettingsController {
  constructor(private readonly settings: ScoutSettingsService) {}

  @Get()
  get(@Auth() auth: AuthContext): Promise<ScoutSettingsDto> {
    return this.settings.get(auth);
  }

  @Roles("owner", "admin")
  @Patch()
  update(@Auth() auth: AuthContext, @Body() body: unknown): Promise<ScoutSettingsDto> {
    return this.settings.update(auth, parse(ScoutSettingsInputSchema, body));
  }
}
