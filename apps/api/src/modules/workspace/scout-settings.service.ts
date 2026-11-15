import { Inject, Injectable } from "@nestjs/common";
import { eq, withTenant, workspaces, type DatabaseHandle, type Tx } from "@openline/db";
import type { ScoutSettingsDto, ScoutSettingsInput } from "@openline/shared";
import type { AuthContext } from "../../common/auth-context";
import { DB } from "../../database/database.module";
import { AuditService } from "../audit/audit.service";
import { ScoutBudgetService } from "../scout/budget.service";
import { ScoutModelService } from "../scout/scout-model.service";
import { loadWorkspace } from "./workspace.service";

/** Workspace settings → Scout: on/off, monthly credits, web research, about us, value prop. */
@Injectable()
export class ScoutSettingsService {
  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    private readonly audit: AuditService,
    private readonly budget: ScoutBudgetService,
    private readonly model: ScoutModelService,
  ) {}

  private scope<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, { workspaceId: auth.workspaceId, userId: auth.userId }, fn);
  }

  private async dto(tx: Tx, auth: AuthContext): Promise<ScoutSettingsDto> {
    const ws = await loadWorkspace(tx, auth.workspaceId);
    return {
      enabled: ws.scoutEnabled,
      monthlyCredits: ws.scoutMonthlyCredits,
      webResearch: ws.scoutWebResearch,
      aboutUs: ws.aboutUs,
      valueProposition: ws.valueProposition,
      providerConfigured: this.model.configured,
      available: ws.scoutEnabled && this.model.configured,
      usage: await this.budget.usage(tx, auth.workspaceId, ws.scoutMonthlyCredits),
    };
  }

  get(auth: AuthContext): Promise<ScoutSettingsDto> {
    return this.scope(auth, (tx) => this.dto(tx, auth));
  }

  update(auth: AuthContext, input: ScoutSettingsInput): Promise<ScoutSettingsDto> {
    return this.scope(auth, async (tx) => {
      const patch: Partial<typeof workspaces.$inferInsert> = {};
      if (input.enabled !== undefined) patch.scoutEnabled = input.enabled;
      if (input.monthlyCredits !== undefined) patch.scoutMonthlyCredits = input.monthlyCredits;
      if (input.webResearch !== undefined) patch.scoutWebResearch = input.webResearch;
      if (input.aboutUs !== undefined) patch.aboutUs = input.aboutUs;
      if (input.valueProposition !== undefined) patch.valueProposition = input.valueProposition;
      const fields = Object.keys(patch);
      if (fields.length) {
        await tx.update(workspaces).set(patch).where(eq(workspaces.id, auth.workspaceId));
        // Switches and the budget are logged with values; free text only by field name.
        await this.audit.record(tx, {
          workspaceId: auth.workspaceId,
          actorId: auth.userId,
          action: "workspace.scout_updated",
          entity: "workspace",
          entityId: auth.workspaceId,
          metadata: {
            fields,
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            ...(input.monthlyCredits !== undefined ? { monthlyCredits: input.monthlyCredits } : {}),
            ...(input.webResearch !== undefined ? { webResearch: input.webResearch } : {}),
          },
        });
      }
      return this.dto(tx, auth);
    });
  }
}
