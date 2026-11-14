import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import {
  and,
  desc,
  eq,
  suppressions,
  withTenant,
  type DatabaseHandle,
  type Tx,
} from "@openline/db";
import type { SuppressionCreateSchema, SuppressionDto } from "@openline/shared";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth-context";
import { ApiException, notFound } from "../../common/http";
import { DB } from "../../database/database.module";
import { AuditService } from "../audit/audit.service";

/** Opt-outs the law requires us to honour permanently; they cannot be removed. */
export const LOCKED_REASONS = new Set(["unsubscribed", "asked_not_to_contact"]);

type SuppressionCreate = z.infer<typeof SuppressionCreateSchema>;

const toDto = (r: typeof suppressions.$inferSelect): SuppressionDto => ({
  id: r.id,
  value: r.value,
  reason: r.reason,
  createdAt: r.createdAt.toISOString(),
});

@Injectable()
export class SuppressionsService {
  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    private readonly audit: AuditService,
  ) {}

  private scope<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, { workspaceId: auth.workspaceId, userId: auth.userId }, fn);
  }

  list(auth: AuthContext): Promise<SuppressionDto[]> {
    return this.scope(auth, async (tx) => {
      const rows = await tx
        .select()
        .from(suppressions)
        .where(eq(suppressions.workspaceId, auth.workspaceId))
        .orderBy(desc(suppressions.createdAt), desc(suppressions.id));
      return rows.map(toDto);
    });
  }

  create(auth: AuthContext, input: SuppressionCreate): Promise<SuppressionDto> {
    return this.scope(auth, async (tx) => {
      const [created] = await tx
        .insert(suppressions)
        .values({
          workspaceId: auth.workspaceId,
          value: input.value,
          reason: input.reason,
          createdBy: auth.userId,
        })
        .onConflictDoNothing({ target: [suppressions.workspaceId, suppressions.value] })
        .returning();
      if (!created) {
        throw new ApiException(HttpStatus.CONFLICT, "conflict", "This value is already suppressed");
      }
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "suppression.created",
        entity: "suppression",
        entityId: created.id,
        metadata: { reason: created.reason },
      });
      return toDto(created);
    });
  }

  async remove(auth: AuthContext, id: string): Promise<void> {
    await this.scope(auth, async (tx) => {
      const [row] = await tx
        .select()
        .from(suppressions)
        .where(and(eq(suppressions.id, id), eq(suppressions.workspaceId, auth.workspaceId)))
        .limit(1);
      if (!row) throw notFound("Suppression");
      if (LOCKED_REASONS.has(row.reason)) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          "suppression_locked",
          "People who opted out or asked not to be contacted can't be removed from the list.",
        );
      }
      await tx
        .delete(suppressions)
        .where(and(eq(suppressions.id, id), eq(suppressions.workspaceId, auth.workspaceId)));
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "suppression.deleted",
        entity: "suppression",
        entityId: id,
        metadata: { reason: row.reason },
      });
    });
  }
}
