import { Body, Controller, Get, Patch } from "@nestjs/common";
import { WorkspaceSettingsInputSchema, type WorkspaceSettingsDto } from "@openline/shared";
import { Auth, Roles, type AuthContext } from "../../common/auth-context";
import { parse } from "../../common/http";
import { WorkspaceService } from "./workspace.service";

@Controller("workspace")
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService) {}

  @Get()
  get(@Auth() auth: AuthContext): Promise<WorkspaceSettingsDto> {
    return this.workspace.get(auth);
  }

  @Roles("owner", "admin")
  @Patch()
  update(@Auth() auth: AuthContext, @Body() body: unknown): Promise<WorkspaceSettingsDto> {
    return this.workspace.update(auth, parse(WorkspaceSettingsInputSchema, body));
  }
}
