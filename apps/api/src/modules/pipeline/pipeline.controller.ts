import { Body, Controller, Get, Put } from "@nestjs/common";
import { ReplaceStagesInputSchema, type PipelineStageDto } from "@openline/shared";
import { Auth, Roles, type AuthContext } from "../../common/auth-context";
import { parse } from "../../common/http";
import { PipelineService } from "./pipeline.service";

/** Pipeline stages (OL-E7 §1). Everyone reads; owner/admin replace the list. */
@Controller("pipeline")
export class PipelineController {
  constructor(private readonly pipeline: PipelineService) {}

  @Get("stages")
  stages(@Auth() auth: AuthContext): Promise<PipelineStageDto[]> {
    return this.pipeline.stages(auth);
  }

  @Roles("owner", "admin")
  @Put("stages")
  replace(@Auth() auth: AuthContext, @Body() body: unknown): Promise<PipelineStageDto[]> {
    return this.pipeline.replace(auth, parse(ReplaceStagesInputSchema, body));
  }
}
