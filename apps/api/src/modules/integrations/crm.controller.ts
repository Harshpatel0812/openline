import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import {
  CrmConnectionPatchSchema,
  CrmErrorsQuerySchema,
  CrmFieldMappingsInputSchema,
  CrmImportInputSchema,
  CrmPageQuerySchema,
  CrmProviderSchema,
  CrmRemoteFieldsQuerySchema,
  CrmStageMappingsInputSchema,
  type CrmConnectionDto,
  type CrmFieldMappingDto,
  type CrmPage,
  type CrmPipelineDto,
  type CrmRemoteFieldDto,
  type CrmRunDetailDto,
  type CrmRunDto,
  type CrmStageMappingsDto,
  type CrmStatusDto,
  type CrmSyncErrorDto,
} from "@openline/shared";
import type { Request, Response } from "express";
import { z } from "zod";
import {
  Auth,
  Public,
  Roles,
  type AuthContext,
  type AuthedRequest,
} from "../../common/auth-context";
import { parse } from "../../common/http";
import { CrmService } from "./crm.service";

const CallbackQuery = z.object({
  code: z.string().max(2000).optional(),
  state: z.string().max(1500).optional(),
  error: z.string().max(200).optional(),
});
const DisconnectQuery = z.object({ forgetLinks: z.enum(["true", "false"]).default("false") });

/**
 * CRM sync (OL-E8). Owner/admin connect, map, import, control and disconnect; managers read the
 * sync log; every member reads the status (record badges come on the record DTOs).
 */
@Controller("integrations/crm")
export class CrmController {
  constructor(private readonly crm: CrmService) {}

  @Get()
  status(@Auth() auth: AuthContext): Promise<CrmStatusDto> {
    return this.crm.status(auth);
  }

  @Roles("owner", "admin")
  @Patch()
  update(@Auth() auth: AuthContext, @Body() body: unknown): Promise<CrmConnectionDto> {
    return this.crm.update(auth, parse(CrmConnectionPatchSchema, body));
  }

  @Roles("owner", "admin")
  @Delete()
  @HttpCode(200)
  async disconnect(@Auth() auth: AuthContext, @Query() query: unknown): Promise<{ ok: true }> {
    await this.crm.disconnect(auth, parse(DisconnectQuery, query).forgetLinks === "true");
    return { ok: true };
  }

  @Roles("owner", "admin")
  @Get("remote/pipelines")
  pipelines(@Auth() auth: AuthContext): Promise<CrmPipelineDto[]> {
    return this.crm.pipelines(auth);
  }

  @Roles("owner", "admin")
  @Get("remote/fields")
  fields(@Auth() auth: AuthContext, @Query() query: unknown): Promise<CrmRemoteFieldDto[]> {
    return this.crm.fields(auth, parse(CrmRemoteFieldsQuerySchema, query).object);
  }

  @Roles("owner", "admin")
  @Get("field-mappings")
  fieldMappings(@Auth() auth: AuthContext): Promise<CrmFieldMappingDto[]> {
    return this.crm.fieldMappings(auth);
  }

  @Roles("owner", "admin")
  @Put("field-mappings")
  replaceFieldMappings(
    @Auth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<CrmFieldMappingDto[]> {
    return this.crm.replaceFieldMappings(auth, parse(CrmFieldMappingsInputSchema, body));
  }

  @Roles("owner", "admin")
  @Get("stage-mappings")
  stageMappings(@Auth() auth: AuthContext): Promise<CrmStageMappingsDto> {
    return this.crm.stageMappings(auth);
  }

  @Roles("owner", "admin")
  @Put("stage-mappings")
  replaceStageMappings(
    @Auth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<CrmStageMappingsDto> {
    return this.crm.replaceStageMappings(auth, parse(CrmStageMappingsInputSchema, body));
  }

  @Roles("owner", "admin")
  @Post("import/preview")
  @HttpCode(202)
  preview(@Auth() auth: AuthContext): Promise<{ runId: string }> {
    return this.crm.preview(auth);
  }

  @Roles("owner", "admin")
  @Post("import")
  @HttpCode(202)
  startImport(@Auth() auth: AuthContext, @Body() body: unknown): Promise<{ runId: string }> {
    return this.crm.startImport(auth, parse(CrmImportInputSchema, body));
  }

  @Roles("owner", "admin")
  @Post("sync-now")
  @HttpCode(202)
  syncNow(@Auth() auth: AuthContext): Promise<CrmConnectionDto> {
    return this.crm.syncNowRequest(auth);
  }

  @Roles("owner", "admin")
  @Post("pause")
  @HttpCode(200)
  pause(@Auth() auth: AuthContext): Promise<CrmConnectionDto> {
    return this.crm.pause(auth);
  }

  @Roles("owner", "admin")
  @Post("resume")
  @HttpCode(200)
  resume(@Auth() auth: AuthContext): Promise<CrmConnectionDto> {
    return this.crm.resume(auth);
  }

  @Roles("owner", "admin", "manager")
  @Get("runs")
  runs(@Auth() auth: AuthContext, @Query() query: unknown): Promise<CrmPage<CrmRunDto>> {
    return this.crm.runs(auth, parse(CrmPageQuerySchema, query));
  }

  @Roles("owner", "admin", "manager")
  @Get("runs/:id")
  run(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string): Promise<CrmRunDetailDto> {
    return this.crm.run(auth, id);
  }

  @Roles("owner", "admin", "manager")
  @Get("errors")
  errors(@Auth() auth: AuthContext, @Query() query: unknown): Promise<CrmPage<CrmSyncErrorDto>> {
    return this.crm.errors(auth, parse(CrmErrorsQuerySchema, query));
  }

  @Roles("owner", "admin")
  @Post("errors/:id/retry")
  @HttpCode(200)
  retry(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<CrmSyncErrorDto> {
    return this.crm.retryError(auth, id);
  }

  @Roles("owner", "admin")
  @Post("errors/:id/dismiss")
  @HttpCode(200)
  dismiss(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<CrmSyncErrorDto> {
    return this.crm.dismissError(auth, id);
  }

  /** Pipedrive's app uninstall callback: Basic auth with our client credentials, no session. */
  @Public()
  @Delete("pipedrive/uninstall")
  async uninstall(@Req() req: Request, @Body() body: unknown, @Res() res: Response): Promise<void> {
    const ok = await this.crm.pipedriveUninstalled(req.headers.authorization, body);
    res
      .status(ok ? 200 : 401)
      .json(ok ? { ok: true } : { code: "unauthorized", message: "Unauthorized" });
  }

  @Roles("owner", "admin")
  @Get(":provider/authorize")
  authorize(
    @Auth() auth: AuthContext,
    @Param("provider") provider: string,
  ): Promise<{ url: string }> {
    return this.crm.authorize(auth, parse(CrmProviderSchema, provider));
  }

  /**
   * Browser redirect from the CRM. Public so a missing session becomes ?error=signed_out instead
   * of a JSON 401; the signed state binds it to the signed-in user, workspace and provider.
   */
  @Public()
  @Get(":provider/callback")
  async callback(
    @Req() req: AuthedRequest,
    @Param("provider") provider: string,
    @Query() query: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const p = CrmProviderSchema.safeParse(provider);
    const parsed = CallbackQuery.safeParse(query);
    const location = p.success
      ? await this.crm.callback(
          req.auth,
          p.data,
          parsed.success ? parsed.data : { error: "invalid_request" },
        )
      : `${this.crm.integrationsPage()}?error=state_invalid`;
    res.redirect(302, location);
  }
}
