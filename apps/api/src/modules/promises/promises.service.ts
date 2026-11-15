import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { editDistance, transition, type AiActionStatus } from "@openline/ai";
import {
  aiActions,
  and,
  contacts,
  desc,
  eq,
  inArray,
  tasks,
  withTenant,
  type AiActionRow,
  type DatabaseHandle,
  type Tx,
} from "@openline/db";
import {
  LEGACY_PROMISE_ACTION_KINDS,
  PROMISE_ACTION_KINDS,
  type AcceptPromiseInput,
  type AcceptPromiseResultDto,
  type DismissPromiseInput,
  type PromiseProposalDto,
  type PromiseQuery,
  type PromiseStatus,
} from "@openline/shared";
import type { AuthContext } from "../../common/auth-context";
import { ApiException, notFound } from "../../common/http";
import { DB } from "../../database/database.module";
import { AuditService } from "../audit/audit.service";
import { MANAGERS, taskForPromise } from "../tasks/tasks.service";

const STATUS_OF: Partial<Record<AiActionStatus, PromiseStatus>> = {
  proposed: "proposed",
  approved: "accepted",
  executed: "accepted",
  rejected: "dismissed",
};
const STORED_STATUSES: Record<PromiseStatus, AiActionStatus[]> = {
  proposed: ["proposed"],
  accepted: ["approved", "executed"],
  dismissed: ["rejected"],
};

function toDto(row: AiActionRow, taskId: string | null): PromiseProposalDto {
  const p = row.proposal.promise;
  return {
    id: row.id,
    kind: row.kind as PromiseProposalDto["kind"],
    status: STATUS_OF[row.status] ?? "dismissed",
    userId: row.userId,
    contactId: row.contactId,
    messageId: row.messageId,
    type: p?.type ?? "our_promise",
    who: p?.who ?? "us",
    direction: p?.direction ?? "inbound",
    what: p?.what ?? "",
    whenPhrase: p?.whenPhrase ?? null,
    title: row.finalText ?? row.proposal.body,
    taskKind: p?.taskKind ?? "follow_up",
    dueAt: p?.dueAt ?? row.createdAt.toISOString(),
    dueDateMissing: p?.dueDateMissing ?? false,
    confidence: p?.confidence ?? 0,
    source: p?.source ?? "rule",
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    taskId,
  };
}

const conflict = (message: string) =>
  new ApiException(HttpStatus.CONFLICT, "invalid_transition", message);

/**
 * Promise Keeper proposals (OL-E6 §2): list, accept (creates the follow-up task), dismiss. Only the person whose mailbox received or
 * sent the email (or a manager) decides; reps never see other reps' proposals (404). Accept and
 * dismiss are idempotent; every decision is audited.
 */
@Injectable()
export class PromisesService {
  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    private readonly audit: AuditService,
  ) {}

  private scope<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, { workspaceId: auth.workspaceId, userId: auth.userId }, fn);
  }

  list(auth: AuthContext, query: PromiseQuery): Promise<PromiseProposalDto[]> {
    return this.scope(auth, async (tx) => {
      const rows = await tx
        .select({ a: aiActions, taskId: tasks.id })
        .from(aiActions)
        .leftJoin(
          tasks,
          and(eq(tasks.aiActionId, aiActions.id), eq(tasks.workspaceId, auth.workspaceId)),
        )
        .where(
          and(
            eq(aiActions.workspaceId, auth.workspaceId),
            // Legacy pause_enrollments rows are never listed.
            inArray(aiActions.kind, [...PROMISE_ACTION_KINDS]),
            inArray(aiActions.status, STORED_STATUSES[query.status]),
            MANAGERS.has(auth.role) ? undefined : eq(aiActions.userId, auth.userId),
            query.contactId ? eq(aiActions.contactId, query.contactId) : undefined,
            query.messageId ? eq(aiActions.messageId, query.messageId) : undefined,
          ),
        )
        .orderBy(desc(aiActions.createdAt))
        .limit(query.limit);
      return rows.map((r) => toDto(r.a, r.taskId));
    });
  }

  /** The proposal, locked for this transaction; another rep's looks like 404. */
  private async load(tx: Tx, auth: AuthContext, id: string): Promise<AiActionRow> {
    const [row] = await tx
      .select()
      .from(aiActions)
      .where(
        and(
          eq(aiActions.id, id),
          eq(aiActions.workspaceId, auth.workspaceId),
          inArray(aiActions.kind, [...PROMISE_ACTION_KINDS, ...LEGACY_PROMISE_ACTION_KINDS]),
        ),
      )
      .for("update")
      .limit(1);
    if (!row || (row.userId !== auth.userId && !MANAGERS.has(auth.role))) {
      throw notFound("Promise");
    }
    return row;
  }

  private checked(row: AiActionRow, next: AiActionStatus): void {
    try {
      transition(
        {
          id: row.id,
          workspaceId: row.workspaceId,
          userId: row.userId,
          kind: row.kind,
          proposal: row.proposal,
          sources: row.sources.map((s) => s.id),
          status: row.status,
        },
        next,
      );
    } catch {
      throw conflict(`This promise is already ${STATUS_OF[row.status] ?? row.status}.`);
    }
  }

  accept(
    auth: AuthContext,
    id: string,
    input: AcceptPromiseInput,
  ): Promise<AcceptPromiseResultDto> {
    return this.scope(auth, async (tx) => {
      const row = await this.load(tx, auth, id);
      // Idempotent: accepting again returns what the first accept did.
      if (row.status === "executed" || row.status === "approved") {
        const task = await taskForPromise(tx, auth.workspaceId, row.id);
        return { promise: toDto(row, task?.id ?? null), task };
      }
      // Product decision (Sprint 5): Promise Keeper only proposes tasks. A legacy
      // pause_enrollments row (never created any more) can't be accepted.
      if (row.kind !== "promise_task") {
        throw new ApiException(
          HttpStatus.CONFLICT,
          "unsupported_proposal",
          "This kind of proposal is no longer supported; dismiss it instead.",
        );
      }
      // proposed → approved (a person clicked) → executed (we did it), in one transaction.
      this.checked(row, "approved");
      const promise = row.proposal.promise;
      if (!promise) throw conflict("This proposal can't be accepted.");
      const now = new Date();

      // promise_task: create the task for the mailbox owner.
      const title = input.title ?? row.proposal.body;
      const dueAt = new Date(input.dueAt ?? promise.dueAt);
      const [contact] = row.contactId
        ? await tx
            .select({ id: contacts.id, companyId: contacts.companyId })
            .from(contacts)
            .where(and(eq(contacts.id, row.contactId), eq(contacts.workspaceId, auth.workspaceId)))
        : [];
      const [task] = await tx
        .insert(tasks)
        .values({
          workspaceId: auth.workspaceId,
          ownerId: row.userId,
          contactId: contact?.id ?? null,
          companyId: contact?.companyId ?? null,
          title: title.slice(0, 200),
          dueAt,
          dueDateMissing: input.dueAt === undefined && promise.dueDateMissing,
          kind: promise.taskKind,
          source: "promise",
          sourceMessageId: row.messageId,
          aiActionId: row.id,
          createdBy: auth.userId,
        })
        .returning({ id: tasks.id });
      const distance = editDistance(row.proposal.body, title);
      const [updated] = await tx
        .update(aiActions)
        .set({ status: "executed", decidedAt: now, finalText: title, editDistance: distance })
        .where(and(eq(aiActions.id, row.id), eq(aiActions.workspaceId, auth.workspaceId)))
        .returning();
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "promise.accepted",
        entity: "ai_action",
        entityId: row.id,
        metadata: {
          kind: row.kind,
          type: promise.type,
          source: promise.source,
          taskId: task!.id,
          editedTitle: distance > 0,
          editedDueAt: input.dueAt !== undefined,
          byOwner: row.userId === auth.userId,
        },
      });
      return {
        promise: toDto(updated!, task!.id),
        task: await taskForPromise(tx, auth.workspaceId, row.id),
      };
    });
  }

  dismiss(auth: AuthContext, id: string, input: DismissPromiseInput): Promise<PromiseProposalDto> {
    return this.scope(auth, async (tx) => {
      const row = await this.load(tx, auth, id);
      if (row.status === "rejected") return toDto(row, null);
      this.checked(row, "rejected");
      const [updated] = await tx
        .update(aiActions)
        .set({ status: "rejected", decidedAt: new Date(), rejectReason: input.reason || null })
        .where(and(eq(aiActions.id, row.id), eq(aiActions.workspaceId, auth.workspaceId)))
        .returning();
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "promise.dismissed",
        entity: "ai_action",
        entityId: row.id,
        // The reason is free text: kept out of the audit log.
        metadata: {
          kind: row.kind,
          type: row.proposal.promise?.type ?? null,
          hasReason: Boolean(input.reason),
          byOwner: row.userId === auth.userId,
        },
      });
      return toDto(updated!, null);
    });
  }
}
