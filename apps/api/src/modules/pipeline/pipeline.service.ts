import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import {
  and,
  asc,
  deals,
  eq,
  inArray,
  isNull,
  lockPipeline,
  pipelineStages,
  seedDefaultStages,
  sql,
  withTenant,
  type DatabaseHandle,
  type PipelineStageRow,
  type Tx,
} from "@openline/db";
import type { PipelineStageDto, ReplaceStagesInput } from "@openline/shared";
import type { AuthContext } from "../../common/auth-context";
import { ApiException } from "../../common/http";
import { DB } from "../../database/database.module";
import { AuditService } from "../audit/audit.service";

const toDto = (s: PipelineStageRow, dealCount: number): PipelineStageDto => ({
  id: s.id,
  name: s.name,
  position: s.position,
  probability: s.probability,
  kind: s.kind,
  staleAfterDays: s.staleAfterDays,
  entryCriteria: s.entryCriteria,
  dealCount,
});

/**
 * The workspace's active stages in board order. Seeds the defaults the first time for a
 * workspace that has none (workspaces created before 0011 got them in the migration; signup seeds
 * them too — this is the safety net).
 */
export async function activeStages(tx: Tx, workspaceId: string): Promise<PipelineStageRow[]> {
  const load = () =>
    tx
      .select()
      .from(pipelineStages)
      .where(and(eq(pipelineStages.workspaceId, workspaceId), isNull(pipelineStages.archivedAt)))
      .orderBy(asc(pipelineStages.position), asc(pipelineStages.createdAt));
  const rows = await load();
  if (rows.length > 0) return rows;
  await seedDefaultStages(tx, workspaceId);
  return load();
}

async function dealCounts(tx: Tx, workspaceId: string): Promise<Map<string, number>> {
  const rows = await tx
    .select({ stageId: deals.stageId, n: sql<number>`count(*)::int` })
    .from(deals)
    .where(eq(deals.workspaceId, workspaceId))
    .groupBy(deals.stageId);
  return new Map(rows.map((r) => [r.stageId, Number(r.n)]));
}

@Injectable()
export class PipelineService {
  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    private readonly audit: AuditService,
  ) {}

  private scope<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, { workspaceId: auth.workspaceId, userId: auth.userId }, fn);
  }

  private async list(tx: Tx, workspaceId: string): Promise<PipelineStageDto[]> {
    const stages = await activeStages(tx, workspaceId);
    const counts = await dealCounts(tx, workspaceId);
    return stages.map((s) => toDto(s, counts.get(s.id) ?? 0));
  }

  stages(auth: AuthContext): Promise<PipelineStageDto[]> {
    return this.scope(auth, (tx) => this.list(tx, auth.workspaceId));
  }

  /**
   * Replaces the stage list (the schema already checked names, one won + one lost, order).
   * Stages left out are archived — only when empty; a stage with deals can't change kind either
   * (its deals' closed state would no longer match). Serialised per workspace.
   */
  replace(auth: AuthContext, input: ReplaceStagesInput): Promise<PipelineStageDto[]> {
    const ws = auth.workspaceId;
    return this.scope(auth, async (tx) => {
      await lockPipeline(tx, ws);
      const current = await activeStages(tx, ws);
      const counts = await dealCounts(tx, ws);
      const byId = new Map(current.map((s) => [s.id, s]));

      const unknown = input.stages.filter((s) => s.id && !byId.has(s.id));
      if (unknown.length) {
        throw new ApiException(HttpStatus.NOT_FOUND, "not_found", "Stage not found", {
          stageIds: unknown.map((s) => s.id),
        });
      }
      const kept = new Set(input.stages.flatMap((s) => (s.id ? [s.id] : [])));
      const removed = current.filter((s) => !kept.has(s.id));
      const kindChanged = input.stages.filter(
        (s) => s.id && byId.get(s.id)!.kind !== s.kind,
      ) as (ReplaceStagesInput["stages"][number] & { id: string })[];
      const blocked = [
        ...removed.filter((s) => (counts.get(s.id) ?? 0) > 0),
        ...kindChanged.map((s) => byId.get(s.id)!).filter((s) => (counts.get(s.id) ?? 0) > 0),
      ];
      if (blocked.length) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          "stage_has_deals",
          "Move this stage's deals to another stage first.",
          { stages: blocked.map((s) => ({ id: s.id, name: s.name, deals: counts.get(s.id) })) },
        );
      }

      const now = new Date();
      // Order matters for the one-won / one-lost unique indexes: archive, park changed kinds as
      // open, then write the final values, then add new stages.
      if (removed.length) {
        await tx
          .update(pipelineStages)
          .set({ archivedAt: now, updatedAt: now })
          .where(
            and(
              eq(pipelineStages.workspaceId, ws),
              inArray(
                pipelineStages.id,
                removed.map((s) => s.id),
              ),
            ),
          );
      }
      if (kindChanged.length) {
        await tx
          .update(pipelineStages)
          .set({ kind: "open" })
          .where(
            and(
              eq(pipelineStages.workspaceId, ws),
              inArray(
                pipelineStages.id,
                kindChanged.map((s) => s.id),
              ),
            ),
          );
      }
      let added = 0;
      let updated = 0;
      for (const [position, s] of input.stages.entries()) {
        const values = {
          name: s.name,
          position,
          probability: s.probability,
          kind: s.kind,
          staleAfterDays: s.staleAfterDays,
          entryCriteria: s.entryCriteria,
        };
        if (s.id) {
          const before = byId.get(s.id)!;
          const changed =
            before.name !== s.name ||
            before.position !== position ||
            before.probability !== s.probability ||
            before.kind !== s.kind ||
            before.staleAfterDays !== s.staleAfterDays ||
            JSON.stringify(before.entryCriteria) !== JSON.stringify(s.entryCriteria);
          if (!changed) continue;
          updated += 1;
          await tx
            .update(pipelineStages)
            .set({ ...values, updatedAt: now })
            .where(and(eq(pipelineStages.id, s.id), eq(pipelineStages.workspaceId, ws)));
        }
      }
      const fresh = input.stages
        .map((s, position) => ({ s, position }))
        .filter(({ s }) => !s.id)
        .map(({ s, position }) => ({
          workspaceId: ws,
          name: s.name,
          position,
          probability: s.probability,
          kind: s.kind,
          staleAfterDays: s.staleAfterDays,
          entryCriteria: s.entryCriteria,
        }));
      if (fresh.length) {
        await tx.insert(pipelineStages).values(fresh);
        added = fresh.length;
      }
      if (added || updated || removed.length) {
        await this.audit.record(tx, {
          workspaceId: ws,
          actorId: auth.userId,
          action: "pipeline.stages_updated",
          entity: "pipeline",
          entityId: ws,
          metadata: { added, updated, archived: removed.length, stages: input.stages.length },
        });
      }
      return this.list(tx, ws);
    });
  }
}
