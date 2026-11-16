import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { eq, withTenant, workspaces, type DatabaseHandle, type Tx } from "@openline/db";
import type {
  PlanChoiceDto,
  PlanChoiceInput,
  WorkspaceSettingsDto,
  WorkspaceSettingsInputSchema,
} from "@openline/shared";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth-context";
import { ApiException, notFound } from "../../common/http";
import { DB } from "../../database/database.module";
import { AuditService } from "../audit/audit.service";
import { isValidTimeZone } from "../contacts/contacts.service";

type WorkspaceSettingsInput = z.infer<typeof WorkspaceSettingsInputSchema>;

export async function loadWorkspace(tx: Tx, workspaceId: string) {
  const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!ws) throw notFound("Workspace");
  return ws;
}

const toDto = (ws: typeof workspaces.$inferSelect): WorkspaceSettingsDto => ({
  id: ws.id,
  name: ws.name,
  mailingAddress: ws.mailingAddress,
  defaultTimeZone: ws.defaultTimeZone,
});

@Injectable()
export class WorkspaceService {
  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    private readonly audit: AuditService,
  ) {}

  private scope<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, { workspaceId: auth.workspaceId, userId: auth.userId }, fn);
  }

  get(auth: AuthContext): Promise<WorkspaceSettingsDto> {
    return this.scope(auth, async (tx) => toDto(await loadWorkspace(tx, auth.workspaceId)));
  }

  update(auth: AuthContext, input: WorkspaceSettingsInput): Promise<WorkspaceSettingsDto> {
    if (input.defaultTimeZone !== undefined && !isValidTimeZone(input.defaultTimeZone)) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        "validation_error",
        "Some fields are invalid",
        [{ path: "defaultTimeZone", message: "Use an IANA time zone like America/New_York" }],
      );
    }
    return this.scope(auth, async (tx) => {
      const patch: Partial<typeof workspaces.$inferInsert> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.mailingAddress !== undefined) patch.mailingAddress = input.mailingAddress;
      if (input.defaultTimeZone !== undefined) patch.defaultTimeZone = input.defaultTimeZone;
      const fields = Object.keys(patch);
      if (fields.length) {
        await tx.update(workspaces).set(patch).where(eq(workspaces.id, auth.workspaceId));
        // Field names only: values (address) stay out of the audit log.
        await this.audit.record(tx, {
          workspaceId: auth.workspaceId,
          actorId: auth.userId,
          action: "workspace.updated",
          entity: "workspace",
          entityId: auth.workspaceId,
          metadata: { fields },
        });
      }
      return toDto(await loadWorkspace(tx, auth.workspaceId));
    });
  }

  /**
   * Sets or changes the plan the team intends to move to after the trial (owner/admin). Billing
   * isn't switched on, so this only records intent; it never changes `plan` or the trial end.
   */
  setPlanChoice(auth: AuthContext, input: PlanChoiceInput): Promise<PlanChoiceDto> {
    return this.scope(auth, async (tx) => {
      const before = await loadWorkspace(tx, auth.workspaceId);
      await tx
        .update(workspaces)
        .set({ chosenPlan: input.plan, chosenBilling: input.billing })
        .where(eq(workspaces.id, auth.workspaceId));
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "workspace.plan_choice_changed",
        entity: "workspace",
        entityId: auth.workspaceId,
        metadata: {
          from: before.chosenPlan
            ? { plan: before.chosenPlan, billing: before.chosenBilling }
            : null,
          to: { plan: input.plan, billing: input.billing },
        },
      });
      return { chosenPlan: input.plan, chosenBilling: input.billing };
    });
  }
}
