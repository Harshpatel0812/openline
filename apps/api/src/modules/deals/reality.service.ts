import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { realityFlagId, type RealityFlagCode as AiFlagCode } from "@openline/ai";
import {
  aiActions,
  and,
  dealChecks,
  dealContacts,
  dealFlagDismissals,
  deals,
  desc,
  eq,
  gte,
  inArray,
  mailboxes,
  messages,
  ne,
  pipelineStages,
  sql,
  users,
  withTenant,
  type AiActionRow,
  type DatabaseHandle,
  type DealCheckRow,
  type Tx,
} from "@openline/db";
import { createRealityChecker, type RealityChecker } from "@openline/replies";
import {
  REALITY_LIMITS,
  type DealDetailDto,
  type RealityCheckDto,
  type RealityCheckResponseDto,
  type RealityEvidenceItemDto,
  type RealityFlagDismissInput,
  type RealityFlagDto,
  type RealitySuggestionDismissInput,
  type RealitySuggestionDto,
} from "@openline/shared";
import type { AuthContext } from "../../common/auth-context";
import { ApiException, forbidden, notFound } from "../../common/http";
import { DB } from "../../database/database.module";
import { AuditService } from "../audit/audit.service";
import { ScoutModelService } from "../scout/scout-model.service";
import { DealsService } from "./deals.service";

const MANAGERS = new Set(["owner", "admin", "manager"]);
const DAY_MS = 86_400_000;

const utcDayStart = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

const conflict = (code: string, message: string) =>
  new ApiException(HttpStatus.CONFLICT, code, message);

/** Holds this process's Reality Check runner (packages/replies), shared with the scheduler. */
@Injectable()
export class RealityCheckerService implements OnApplicationShutdown {
  private readonly logger = new Logger("RealityCheck");
  readonly checker: RealityChecker;

  constructor(@Inject(DB) handle: DatabaseHandle, @Optional() model?: ScoutModelService) {
    this.checker = createRealityChecker({
      db: handle.db,
      provider: model?.provider ?? null,
      logger: {
        warn: (m: string) => this.logger.warn(m),
        error: (m: string) => this.logger.error(m),
      },
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.checker.stop();
  }
}

/**
 * Pipeline Reality Check endpoints (OL-E7 §4). Everyone reads the latest check; the deal's owner
 * or a manager runs it, dismisses flags and accepts / dismisses the stage-move suggestion.
 * Quotes come from emails: a rep sees quotes only from their own mailboxes' mail (same rule as
 * the deal timeline and the inbox); managers and above see all.
 */
@Injectable()
export class RealityService {
  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    private readonly audit: AuditService,
    private readonly deals: DealsService,
    private readonly runner: RealityCheckerService,
  ) {}

  private scope<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, { workspaceId: auth.workspaceId, userId: auth.userId }, fn);
  }

  private async deal(tx: Tx, auth: AuthContext, id: string) {
    const [deal] = await tx
      .select({ id: deals.id, ownerId: deals.ownerId, stageId: deals.stageId })
      .from(deals)
      .where(and(eq(deals.id, id), eq(deals.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!deal) throw notFound("Deal");
    return deal;
  }

  private assertCanAct(auth: AuthContext, ownerId: string): void {
    if (ownerId !== auth.userId && !MANAGERS.has(auth.role)) {
      throw forbidden("Only the deal's owner or a manager can do that");
    }
  }

  private async manualRunsToday(tx: Tx, ws: string, dealId: string, now: Date) {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(dealChecks)
      .where(
        and(
          eq(dealChecks.workspaceId, ws),
          eq(dealChecks.dealId, dealId),
          eq(dealChecks.trigger, "manual"),
          gte(dealChecks.ranAt, utcDayStart(now)),
        ),
      );
    return Number(row?.n ?? 0);
  }

  // ---------------------------------------------------------------- run

  async run(auth: AuthContext, id: string): Promise<RealityCheckDto> {
    const now = new Date();
    await this.scope(auth, async (tx) => {
      const deal = await this.deal(tx, auth, id);
      this.assertCanAct(auth, deal.ownerId);
      if (
        (await this.manualRunsToday(tx, auth.workspaceId, id, now)) >=
        REALITY_LIMITS.runsPerDealPerDay
      ) {
        const retryAfterSec = Math.ceil(
          (utcDayStart(now).getTime() + DAY_MS - now.getTime()) / 1000,
        );
        throw new ApiException(
          HttpStatus.TOO_MANY_REQUESTS,
          "rate_limited",
          `This deal has been checked ${REALITY_LIMITS.runsPerDealPerDay} times today. Try again tomorrow.`,
          { retryAfterSec },
        );
      }
    });
    // The model step runs outside any transaction (packages/replies).
    const result = await this.runner.checker.check({
      workspaceId: auth.workspaceId,
      dealId: id,
      trigger: "manual",
      userId: auth.userId,
    });
    if (!result) throw notFound("Deal");
    const check = await this.scope(auth, (tx) => this.latestDto(tx, auth, id));
    return check!;
  }

  // ---------------------------------------------------------------- read

  async latest(auth: AuthContext, id: string): Promise<RealityCheckResponseDto> {
    return this.scope(auth, async (tx) => {
      await this.deal(tx, auth, id);
      return { check: await this.latestDto(tx, auth, id) };
    });
  }

  private async latestRow(tx: Tx, ws: string, dealId: string): Promise<DealCheckRow | undefined> {
    const [row] = await tx
      .select()
      .from(dealChecks)
      .where(and(eq(dealChecks.workspaceId, ws), eq(dealChecks.dealId, dealId)))
      .orderBy(desc(dealChecks.ranAt), desc(dealChecks.id))
      .limit(1);
    return row;
  }

  /** Latest activity on the deal: its own, or an email with one of its contacts. */
  private async latestActivity(tx: Tx, ws: string, dealId: string): Promise<Date> {
    const [row] = await tx
      .select({
        own: deals.lastActivityAt,
        email: sql<string | null>`(SELECT max(m.sent_at)::text FROM deal_contacts dc
            JOIN messages m ON m.workspace_id = dc.workspace_id AND m.contact_id = dc.contact_id
           WHERE dc.workspace_id = ${ws} AND dc.deal_id = ${dealId} AND m.status <> 'sending')`,
      })
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.workspaceId, ws)));
    const own = row?.own ?? new Date(0);
    const email = row?.email ? new Date(row.email) : null;
    return email && email > own ? email : own;
  }

  /** Messages (of this deal's contacts) whose text the caller may read. */
  private async readableMessages(
    tx: Tx,
    auth: AuthContext,
    dealId: string,
    ids: string[],
  ): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await tx
      .select({ id: messages.id, mailboxUserId: mailboxes.userId })
      .from(messages)
      .innerJoin(
        dealContacts,
        and(
          eq(dealContacts.workspaceId, auth.workspaceId),
          eq(dealContacts.dealId, dealId),
          eq(dealContacts.contactId, messages.contactId),
        ),
      )
      .leftJoin(
        mailboxes,
        and(eq(mailboxes.id, messages.mailboxId), eq(mailboxes.workspaceId, auth.workspaceId)),
      )
      .where(
        and(
          eq(messages.workspaceId, auth.workspaceId),
          inArray(messages.id, ids),
          ne(messages.status, "sending"),
        ),
      );
    const seesAll = MANAGERS.has(auth.role);
    return new Set(rows.filter((r) => seesAll || r.mailboxUserId === auth.userId).map((r) => r.id));
  }

  private async latestDto(
    tx: Tx,
    auth: AuthContext,
    dealId: string,
  ): Promise<RealityCheckDto | null> {
    const ws = auth.workspaceId;
    const row = await this.latestRow(tx, ws, dealId);
    if (!row) return null;
    const now = new Date();
    const latest = await this.latestActivity(tx, ws, dealId);

    const messageIds = [
      ...Object.values(row.evidence).map((e) => e.messageId),
      ...row.flags.map((f) => f.messageId),
    ].filter((v): v is string => !!v);
    const readable = await this.readableMessages(tx, auth, dealId, [...new Set(messageIds)]);
    // A quote is shown only when its message still exists, belongs to the deal and is readable.
    const quoteOf = <T extends { quote?: string; messageId?: string }>(item: T) => {
      if (!item.quote) return {};
      if (item.messageId && readable.has(item.messageId)) {
        return { quote: item.quote, messageId: item.messageId };
      }
      return {
        quoteHidden: true as const,
        ...(item.messageId ? { messageId: item.messageId } : {}),
      };
    };

    const evidence: RealityCheckDto["evidence"] = {};
    for (const [type, item] of Object.entries(row.evidence)) {
      const dto: RealityEvidenceItemDto = { present: item.present, ...quoteOf(item) };
      if (!item.quote && item.messageId) dto.messageId = item.messageId;
      evidence[type as keyof RealityCheckDto["evidence"]] = dto;
    }

    const dismissals = await tx
      .select({ d: dealFlagDismissals, byName: users.name })
      .from(dealFlagDismissals)
      .leftJoin(users, eq(users.id, dealFlagDismissals.dismissedBy))
      .where(and(eq(dealFlagDismissals.workspaceId, ws), eq(dealFlagDismissals.dealId, dealId)))
      .orderBy(desc(dealFlagDismissals.dismissedAt));
    const flags: RealityFlagDto[] = row.flags.map((f) => {
      const { quote: _q, messageId: _m, ...rest } = f;
      void _q;
      void _m;
      const dto = { ...(rest as Omit<RealityFlagDto, "quote" | "messageId">), ...quoteOf(f) };
      if (!f.quote && f.messageId) (dto as RealityFlagDto).messageId = f.messageId;
      // Hidden until there is activity after the dismissal.
      const dismissal = dismissals.find((x) => x.d.flagId === f.id && x.d.dismissedAt >= latest);
      if (dismissal) {
        (dto as RealityFlagDto).dismissed = {
          reason: dismissal.d.reason,
          at: dismissal.d.dismissedAt.toISOString(),
          by: { id: dismissal.d.dismissedBy ?? "", name: dismissal.byName ?? "" },
        };
      }
      return dto as RealityFlagDto;
    });

    const suggestion = await this.suggestionFor(tx, ws, dealId, row.id);
    const runs = await this.manualRunsToday(tx, ws, dealId, now);
    return {
      dealId,
      ranAt: row.ranAt.toISOString(),
      stageId: row.stageId,
      trigger: row.trigger,
      ...(row.model ? { model: row.model } : {}),
      evidence,
      flags,
      ...(row.evidenceStageId ? { evidenceStageId: row.evidenceStageId } : {}),
      ...(suggestion ? { suggestion } : {}),
      deterministicOnly: row.deterministicOnly,
      ...(row.deterministicOnly && row.deterministicReason
        ? { deterministicReason: row.deterministicReason as RealityCheckDto["deterministicReason"] }
        : {}),
      runsLeftToday: Math.max(0, REALITY_LIMITS.runsPerDealPerDay - runs),
    };
  }

  /** The stage-move proposal of this check: the open one, else the one decided last for it. */
  private async suggestionFor(
    tx: Tx,
    ws: string,
    dealId: string,
    checkId: string,
  ): Promise<RealitySuggestionDto | undefined> {
    const rows = await tx
      .select({ a: aiActions, toStageName: pipelineStages.name })
      .from(aiActions)
      .leftJoin(
        pipelineStages,
        and(
          eq(pipelineStages.workspaceId, ws),
          sql`${pipelineStages.id} = (${aiActions.proposal}->'stageMove'->>'toStageId')::uuid`,
        ),
      )
      .where(
        and(
          eq(aiActions.workspaceId, ws),
          eq(aiActions.dealId, dealId),
          eq(aiActions.kind, "deal_stage_move"),
        ),
      )
      .orderBy(desc(aiActions.createdAt))
      .limit(20);
    const pick =
      rows.find((r) => r.a.status === "proposed") ??
      rows.find(
        (r) =>
          r.a.proposal.stageMove?.checkId === checkId && r.a.inputSummary.closedBy !== "superseded",
      );
    if (!pick?.a.proposal.stageMove) return undefined;
    return {
      actionId: pick.a.id,
      toStageId: pick.a.proposal.stageMove.toStageId,
      toStageName: pick.toStageName ?? "",
      reason: pick.a.proposal.body,
      status: pick.a.status,
    };
  }

  // ---------------------------------------------------------------- flags

  async dismissFlag(
    auth: AuthContext,
    id: string,
    flagId: string,
    input: RealityFlagDismissInput,
  ): Promise<RealityCheckDto> {
    const ws = auth.workspaceId;
    return this.scope(auth, async (tx) => {
      const deal = await this.deal(tx, auth, id);
      this.assertCanAct(auth, deal.ownerId);
      const row = await this.latestRow(tx, ws, id);
      const flag = row?.flags.find((f) => f.id === flagId);
      if (!row || !flag) throw notFound("Flag");
      // The id is derived from code + criterion; refuse anything that doesn't match it.
      if (realityFlagId(flag.code as AiFlagCode, flag.criterionKey) !== flag.id) {
        throw notFound("Flag");
      }
      const now = new Date();
      await tx.insert(dealFlagDismissals).values({
        workspaceId: ws,
        dealId: id,
        flagId: flag.id,
        code: flag.code,
        criterionKey: flag.criterionKey ?? null,
        reason: input.reason,
        dismissedBy: auth.userId,
        dismissedAt: now,
      });
      // "Not right" on the stage flag also withdraws the stage-move suggestion.
      if (flag.code === "stage_ahead_of_evidence") {
        const open = await this.openProposal(tx, ws, id);
        if (open) await this.close(tx, open, "user", input.reason, now);
      }
      await this.audit.record(tx, {
        workspaceId: ws,
        actorId: auth.userId,
        action: "deal.reality_flag_dismissed",
        entity: "deal",
        entityId: id,
        // The reason is free text (may hold personal data): not in the audit log.
        metadata: { flagId: flag.id, code: flag.code, byOwner: deal.ownerId === auth.userId },
      });
      return (await this.latestDto(tx, auth, id))!;
    });
  }

  // ---------------------------------------------------------------- suggestion

  private async openProposal(tx: Tx, ws: string, dealId: string): Promise<AiActionRow | undefined> {
    const [row] = await tx
      .select()
      .from(aiActions)
      .where(
        and(
          eq(aiActions.workspaceId, ws),
          eq(aiActions.dealId, dealId),
          eq(aiActions.kind, "deal_stage_move"),
          eq(aiActions.status, "proposed"),
        ),
      )
      .limit(1)
      .for("update");
    return row;
  }

  private async close(
    tx: Tx,
    row: AiActionRow,
    by: "user" | "superseded",
    reason: string | null | undefined,
    now: Date,
  ): Promise<void> {
    await tx
      .update(aiActions)
      .set({
        status: "rejected",
        decidedAt: now,
        rejectReason: reason || null,
        inputSummary: { ...row.inputSummary, closedBy: by },
      })
      .where(and(eq(aiActions.id, row.id), eq(aiActions.workspaceId, row.workspaceId)));
  }

  /** "Move to <evidence stage>": moves the deal with the normal move rules (history + audit). */
  async accept(
    auth: AuthContext,
    id: string,
  ): Promise<{ deal: DealDetailDto; check: RealityCheckDto }> {
    const ws = auth.workspaceId;
    return this.scope(auth, async (tx) => {
      const deal = await this.deals.editableIn(tx, auth, id);
      const row = await this.openProposal(tx, ws, id);
      if (!row?.proposal.stageMove) throw notFound("Suggestion");
      const now = new Date();
      if (row.proposal.stageMove.fromStageId !== deal.stageId) {
        // The deal moved since the check: the suggestion no longer applies.
        await this.close(tx, row, "superseded", null, now);
        throw conflict(
          "suggestion_stale",
          "The deal has moved since this check. Run the Reality Check again.",
        );
      }
      // proposed → approved (a person clicked) → executed (moved), in one transaction.
      const detail = await this.deals.moveIn(
        tx,
        auth,
        id,
        { stageId: row.proposal.stageMove.toStageId },
        { viaRealityCheck: true, aiActionId: row.id },
      );
      await tx
        .update(aiActions)
        .set({ status: "executed", decidedAt: now })
        .where(and(eq(aiActions.id, row.id), eq(aiActions.workspaceId, ws)));
      await this.audit.record(tx, {
        workspaceId: ws,
        actorId: auth.userId,
        action: "ai.stage_move_accepted",
        entity: "ai_action",
        entityId: row.id,
        metadata: {
          dealId: id,
          fromStageId: row.proposal.stageMove.fromStageId,
          toStageId: row.proposal.stageMove.toStageId,
          byOwner: deal.ownerId === auth.userId,
        },
      });
      return { deal: detail, check: (await this.latestDto(tx, auth, id))! };
    });
  }

  async dismissSuggestion(
    auth: AuthContext,
    id: string,
    input: RealitySuggestionDismissInput,
  ): Promise<RealityCheckDto> {
    const ws = auth.workspaceId;
    return this.scope(auth, async (tx) => {
      const deal = await this.deal(tx, auth, id);
      this.assertCanAct(auth, deal.ownerId);
      const row = await this.openProposal(tx, ws, id);
      if (!row) throw notFound("Suggestion");
      await this.close(tx, row, "user", input.reason, new Date());
      await this.audit.record(tx, {
        workspaceId: ws,
        actorId: auth.userId,
        action: "ai.stage_move_dismissed",
        entity: "ai_action",
        entityId: row.id,
        metadata: { dealId: id, byOwner: deal.ownerId === auth.userId },
      });
      return (await this.latestDto(tx, auth, id))!;
    });
  }
}
