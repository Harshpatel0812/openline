/**
 * Pipeline Reality Check runner (OL-E7 §4): gathers a deal's evidence, asks Scout's small model
 * (packages/ai extractDealEvidence: fenced, quotes verified in code) when allowed, runs the
 * deterministic assessDeal(), stores a deal_checks row and keeps the deal's single open
 * "Move to <evidence stage>" proposal (ai_actions kind deal_stage_move) up to date. Nothing moves
 * on its own: the API's accept endpoint does that (Scout rule 1).
 *
 * Used by the API ("Check now") and by the worker / in-process scheduler (daily, via
 * claim_due_reality_checks — the one cross-tenant query, ids only).
 *
 * Model use is gated per workspace: Scout on, a provider configured, and the run's worst-case cost
 * (realityMaxCredits) fitting both in the month's credits and in REALITY_BUDGET_SHARE of them,
 * counting what is spent (ai_usage) and what running checks have reserved. Otherwise only the
 * deterministic flags (dates, stale, no next step) run. Spend is recorded in ai_usage as feature
 * "reality_check". The model is called outside any transaction; a model failure never fails the
 * check (it falls back to deterministic only).
 *
 * Concurrency (SEC-M1): the first transaction locks the deal row (FOR UPDATE), runs the caller's
 * `authorize` hook (the API's permission and daily-limit check) and, under a per-workspace
 * advisory lock, checks the budget and inserts the run as a `pending` deal_checks row holding its
 * reserved credits. Concurrent runs therefore see each other in both limits. The last transaction
 * completes that row (`done`); a run that throws is marked `failed` (its reservation released).
 * A deterministic-only run (Scout off, budget, model error) never touches the open stage-move
 * proposal (QA-L1).
 *
 * Stored email text is limited to the verified quotes (≤ 300 characters each).
 */
import {
  AiError,
  assessDeal,
  creditsFor,
  extractDealEvidence,
  monthStart,
  realityMaxCredits,
  trimQuoted,
  type DealAssessment,
  type DealEvidence,
  type ExtractDealEvidenceInput,
  type LlmProvider,
  type LlmUsage,
  type RealityFlagCode,
  type RealityStage,
} from "@openline/ai";
import {
  aiActions,
  aiUsage,
  and,
  contacts,
  dealChecks,
  dealContacts,
  dealFlagDismissals,
  deals,
  desc,
  eq,
  gte,
  isNull,
  messages,
  ne,
  pipelineStages,
  sql,
  withIdentity,
  withTenant,
  workspaces,
  type DealEvidenceItemJson,
  type DealFlagJson,
  type DealRow,
  type Db,
  type Tx,
} from "@openline/db";

export const REALITY_FEATURE = "reality_check";
/** Share of the monthly credits the Reality Check may use. */
export const REALITY_BUDGET_SHARE = 0.25;
export const REALITY_LOOKBACK_DAYS = 90;
/** Messages read from the database (packages/ai caps again at 30 / 30k characters). */
const MESSAGE_LIMIT = 30;
/** Per-message text read before the cap (stored inbound bodies are ≤ 20k already). */
const MESSAGE_TEXT_MAX = 20_000;
export const REALITY_POLL_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const SUPERSEDED = "Superseded by a newer Reality Check";

export type RealityTrigger = "manual" | "scheduled";
export type DeterministicReason =
  "scout_off" | "no_provider" | "budget" | "no_emails" | "model_error";

export interface RealityRunResult {
  checkId: string;
  deterministicOnly: boolean;
  deterministicReason?: DeterministicReason;
  /** The open stage-move proposal after this run, if any. */
  proposalId?: string;
}

export interface RealitySummary {
  claimed: number;
  checked: number;
  failed: number;
}

export interface RealityCheckerOptions {
  db: Db;
  /** Scout's model; null/undefined = deterministic only. */
  provider?: LlmProvider | null;
  now?: () => Date;
  logger?: Pick<Console, "warn" | "error">;
}

export interface RealityCheckInput {
  workspaceId: string;
  dealId: string;
  trigger: RealityTrigger;
  userId?: string | null;
  /**
   * Runs in the first transaction with the deal row locked, before the run is recorded; throw to
   * refuse (the API checks who may run it and the daily limit here, so concurrent requests can't
   * both pass).
   */
  authorize?: (tx: Tx, deal: DealRow) => Promise<void>;
}

export interface RealityChecker {
  /** Runs one check now. null when the deal isn't in the workspace. */
  check(input: RealityCheckInput): Promise<RealityRunResult | null>;
  /** One scheduler pass: claims due deals (≤ batch) and checks each; never throws per deal. */
  runOnce(batch?: number): Promise<RealitySummary>;
  start(pollMs?: number): void;
  stop(): Promise<void>;
}

function describe(error: unknown): string {
  const e = error as { name?: string; code?: string; cause?: { code?: string } };
  return `${e?.name ?? "Error"}${e?.cause?.code || e?.code ? ` ${e?.cause?.code ?? e?.code}` : ""}`;
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}

/** Reservations of running checks older than this are ignored (a crashed run's lease). */
const RESERVATION_TTL_MS = 15 * 60_000;

/**
 * Why the model step may not run for this workspace now (null = it may). `reserve` is the run's
 * worst-case cost; spend and the reservations of other running checks count against both limits.
 * Call it under the workspace's reality lock (lockWorkspaceBudget) when reserving.
 */
export async function realityModelGate(
  tx: Tx,
  workspaceId: string,
  provider: LlmProvider | null | undefined,
  now: Date,
  reserve = 0,
): Promise<Exclude<DeterministicReason, "no_emails" | "model_error"> | null> {
  const [ws] = await tx
    .select({ enabled: workspaces.scoutEnabled, credits: workspaces.scoutMonthlyCredits })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!ws?.enabled) return "scout_off";
  if (!provider) return "no_provider";
  const [row] = await tx
    .select({
      used: sql<number>`coalesce(sum(${aiUsage.credits}), 0)::int`,
      reality: sql<number>`coalesce(sum(${aiUsage.credits}) filter (where ${aiUsage.feature} = ${REALITY_FEATURE}), 0)::int`,
    })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.workspaceId, workspaceId),
        sql`${aiUsage.createdAt} >= ${monthStart(now).toISOString()}`,
      ),
    );
  const [held] = await tx
    .select({ credits: sql<number>`coalesce(sum(${dealChecks.reservedCredits}), 0)::int` })
    .from(dealChecks)
    .where(
      and(
        eq(dealChecks.workspaceId, workspaceId),
        eq(dealChecks.status, "pending"),
        gte(dealChecks.ranAt, new Date(now.getTime() - RESERVATION_TTL_MS)),
      ),
    );
  const reserved = Number(held?.credits ?? 0);
  const used = Number(row?.used ?? 0) + reserved;
  const reality = Number(row?.reality ?? 0) + reserved;
  if (used >= ws.credits || used + reserve > ws.credits) return "budget";
  const share = ws.credits * REALITY_BUDGET_SHARE;
  if (reality >= share || reality + reserve > share) return "budget";
  return null;
}

/** Serialises budget checks + reservations of one workspace until the transaction ends. */
export async function lockWorkspaceBudget(tx: Tx, workspaceId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('openline:reality_budget'), hashtext(${workspaceId}))`,
  );
}

/** The deal's latest activity: its own (edits, moves, tasks) or an email with a deal contact. */
async function latestActivity(tx: Tx, workspaceId: string, dealId: string, own: Date) {
  const [row] = await tx
    .select({ at: sql<string | null>`max(${messages.sentAt})::text` })
    .from(messages)
    .innerJoin(
      dealContacts,
      and(
        eq(dealContacts.workspaceId, workspaceId),
        eq(dealContacts.dealId, dealId),
        eq(dealContacts.contactId, messages.contactId),
      ),
    )
    .where(and(eq(messages.workspaceId, workspaceId), ne(messages.status, "sending")));
  const email = row?.at ? new Date(row.at) : null;
  return email && email > own ? email : own;
}

async function loadStages(tx: Tx, workspaceId: string): Promise<RealityStage[]> {
  const rows = await tx
    .select()
    .from(pipelineStages)
    .where(and(eq(pipelineStages.workspaceId, workspaceId), isNull(pipelineStages.archivedAt)));
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    position: s.position,
    kind: s.kind,
    staleAfterDays: s.staleAfterDays,
    entryCriteria: s.entryCriteria,
  }));
}

/** Everything a check needs, read in one transaction (no model call inside it). */
async function gather(tx: Tx, workspaceId: string, deal: DealRow, now: Date) {
  const dealId = deal.id;
  const [ws] = await tx
    .select({ tz: workspaces.defaultTimeZone })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const stages = await loadStages(tx, workspaceId);
  const people = await tx
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      title: contacts.title,
    })
    .from(dealContacts)
    .innerJoin(
      contacts,
      and(eq(contacts.id, dealContacts.contactId), eq(contacts.workspaceId, workspaceId)),
    )
    .where(and(eq(dealContacts.workspaceId, workspaceId), eq(dealContacts.dealId, dealId)));
  const since = new Date(now.getTime() - REALITY_LOOKBACK_DAYS * DAY_MS);
  const mail = await tx
    .select({
      id: messages.id,
      direction: messages.direction,
      sentAt: messages.sentAt,
      subject: messages.subject,
      bodyText: messages.bodyText,
    })
    .from(messages)
    .innerJoin(
      dealContacts,
      and(
        eq(dealContacts.workspaceId, workspaceId),
        eq(dealContacts.dealId, dealId),
        eq(dealContacts.contactId, messages.contactId),
      ),
    )
    .where(
      and(
        eq(messages.workspaceId, workspaceId),
        ne(messages.status, "sending"),
        gte(messages.sentAt, since),
      ),
    )
    .orderBy(desc(messages.sentAt), desc(messages.id))
    .limit(MESSAGE_LIMIT);
  return {
    deal,
    timeZone: ws?.tz ?? "UTC",
    stages,
    contacts: people.map((p) => ({
      id: p.id,
      name: [p.firstName, p.lastName].filter(Boolean).join(" ") || null,
      title: p.title,
    })),
    messages: mail.map((m) => ({
      id: m.id,
      direction: m.direction,
      sentAt: m.sentAt,
      subject: m.subject,
      // Bodies are stored for inbound mail only; outbound counts by subject and date.
      text: m.bodyText ? trimQuoted(m.bodyText, MESSAGE_TEXT_MAX) : "",
    })),
  };
}

/** What the first transaction of a check hands to the rest of it. */
type Gathered = Awaited<ReturnType<typeof gather>> & {
  stage: RealityStage | undefined;
  modelInput: ExtractDealEvidenceInput;
  gate: DeterministicReason | null;
  pendingId: string;
};

/** Only present / quote (≤ 300, verified) / messageId are stored. */
function storedEvidence(evidence: DealEvidence | undefined): Record<string, DealEvidenceItemJson> {
  if (!evidence) return {};
  return Object.fromEntries(
    Object.entries(evidence).map(([type, item]) => [
      type,
      {
        present: item.present,
        ...(item.quote ? { quote: item.quote.slice(0, 300) } : {}),
        ...(item.messageId ? { messageId: item.messageId } : {}),
      },
    ]),
  );
}

/**
 * Keeps one open stage-move proposal per deal: refreshed when the same move is suggested again,
 * replaced (old one rejected as superseded) when a different one is, closed when none is. A move
 * the owner dismissed isn't proposed again until there is new activity after the dismissal.
 */
async function syncProposal(
  tx: Tx,
  args: {
    workspaceId: string;
    deal: { id: string; ownerId: string; stageId: string };
    checkId: string;
    model: string;
    suggestion: DealAssessment["suggestion"];
    latestActivityAt: Date;
    now: Date;
  },
): Promise<string | undefined> {
  const { workspaceId: ws, deal, suggestion, now } = args;
  const open = await tx
    .select()
    .from(aiActions)
    .where(
      and(
        eq(aiActions.workspaceId, ws),
        eq(aiActions.dealId, deal.id),
        eq(aiActions.kind, "deal_stage_move"),
        eq(aiActions.status, "proposed"),
      ),
    )
    .for("update");
  const close = async (id: string) =>
    tx
      .update(aiActions)
      .set({
        status: "rejected",
        rejectReason: SUPERSEDED,
        decidedAt: now,
        inputSummary: sql`${aiActions.inputSummary} || '{"closedBy":"superseded"}'::jsonb`,
      })
      .where(and(eq(aiActions.id, id), eq(aiActions.workspaceId, ws)));

  if (!suggestion) {
    for (const row of open) await close(row.id);
    return undefined;
  }
  const stageMove = {
    checkId: args.checkId,
    fromStageId: deal.stageId,
    toStageId: suggestion.toStageId,
  };
  const same = open.find(
    (r) =>
      r.proposal.stageMove?.toStageId === suggestion.toStageId &&
      r.proposal.stageMove?.fromStageId === deal.stageId,
  );
  for (const row of open) if (row !== same) await close(row.id);
  if (same) {
    await tx
      .update(aiActions)
      .set({ proposal: { body: suggestion.reason, citations: [], stageMove }, model: args.model })
      .where(and(eq(aiActions.id, same.id), eq(aiActions.workspaceId, ws)));
    return same.id;
  }
  // The same move, dismissed by a person after the latest activity → don't ask again yet.
  const dismissed = await tx
    .select({ proposal: aiActions.proposal, decidedAt: aiActions.decidedAt })
    .from(aiActions)
    .where(
      and(
        eq(aiActions.workspaceId, ws),
        eq(aiActions.dealId, deal.id),
        eq(aiActions.kind, "deal_stage_move"),
        eq(aiActions.status, "rejected"),
        sql`coalesce(${aiActions.inputSummary}->>'closedBy', '') = 'user'`,
        sql`${aiActions.decidedAt} >= ${args.latestActivityAt.toISOString()}::timestamptz`,
      ),
    );
  if (
    dismissed.some(
      (d) =>
        d.proposal.stageMove?.toStageId === suggestion.toStageId &&
        d.proposal.stageMove?.fromStageId === deal.stageId,
    )
  ) {
    return undefined;
  }
  const [row] = await tx
    .insert(aiActions)
    .values({
      workspaceId: ws,
      userId: deal.ownerId,
      kind: "deal_stage_move",
      dealId: deal.id,
      inputSummary: { checkId: args.checkId },
      proposal: { body: suggestion.reason, citations: [], stageMove },
      model: args.model,
    })
    .returning({ id: aiActions.id });
  return row?.id;
}

export function createRealityChecker(options: RealityCheckerOptions): RealityChecker {
  const { db } = options;
  const provider = options.provider ?? null;
  const now = options.now ?? (() => new Date());
  const log = options.logger ?? console;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<RealitySummary> | undefined;
  let stopped = false;

  const recordUsage = (
    workspaceId: string,
    userId: string | null,
    usage: LlmUsage,
    model: string,
  ) => {
    if (usage.inputTokens + usage.outputTokens <= 0) return Promise.resolve();
    return withTenant(db, { workspaceId }, async (tx) => {
      await tx.insert(aiUsage).values({
        workspaceId,
        userId,
        feature: REALITY_FEATURE,
        model: model || "unknown",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        credits: creditsFor(usage),
        createdAt: now(),
      });
    });
  };

  async function openProposalId(tx: Tx, workspaceId: string, dealId: string) {
    const [row] = await tx
      .select({ id: aiActions.id })
      .from(aiActions)
      .where(
        and(
          eq(aiActions.workspaceId, workspaceId),
          eq(aiActions.dealId, dealId),
          eq(aiActions.kind, "deal_stage_move"),
          eq(aiActions.status, "proposed"),
        ),
      )
      .limit(1);
    return row?.id;
  }

  async function check(input: RealityCheckInput): Promise<RealityRunResult | null> {
    const { workspaceId, dealId } = input;
    const userId = input.userId ?? null;
    const tenant = { workspaceId, ...(userId ? { userId } : {}) };
    const t = now();
    // 1. Lock the deal, authorize, gather, check the budget and record the run as pending.
    const gathered = await withTenant(db, tenant, async (tx) => {
      const [deal] = await tx
        .select()
        .from(deals)
        .where(and(eq(deals.id, dealId), eq(deals.workspaceId, workspaceId)))
        .limit(1)
        .for("update");
      if (!deal) return null;
      if (input.authorize) await input.authorize(tx, deal);
      const g = await gather(tx, workspaceId, deal, t);
      const stage = g.stages.find((s) => s.id === deal.stageId);
      const modelInput = {
        deal: {
          name: deal.name,
          stageName: stage?.name ?? "",
          nextStep: deal.nextStep,
          nextStepDate: deal.nextStepDate,
        },
        contacts: g.contacts,
        messages: g.messages,
      };
      // Closed deals and deals without emails never call the model: nothing to reserve.
      const wantsModel = stage?.kind === "open" && g.messages.length > 0 && !!provider;
      const reserve = wantsModel ? realityMaxCredits(modelInput) : 0;
      await lockWorkspaceBudget(tx, workspaceId);
      const gate = await realityModelGate(tx, workspaceId, provider, t, reserve);
      const reserved = wantsModel && !gate ? reserve : 0;
      const [pending] = await tx
        .insert(dealChecks)
        .values({
          workspaceId,
          dealId,
          stageId: deal.stageId,
          ranAt: t,
          trigger: input.trigger,
          ranBy: userId,
          status: "pending",
          reservedCredits: reserved,
        })
        .returning({ id: dealChecks.id });
      return { ...g, deal, stage, modelInput, gate, pendingId: pending!.id };
    });
    if (!gathered) return null;
    const { pendingId } = gathered;

    try {
      return await complete(input, gathered, t);
    } catch (error) {
      // Release the reservation (only pending rows hold one); the run still counts toward the
      // daily limit.
      await withTenant(db, tenant, (tx) =>
        tx
          .update(dealChecks)
          .set({ status: "failed" })
          .where(and(eq(dealChecks.id, pendingId), eq(dealChecks.workspaceId, workspaceId))),
      ).catch(() => undefined);
      throw error;
    }
  }

  async function complete(
    input: RealityCheckInput,
    gathered: Gathered,
    t: Date,
  ): Promise<RealityRunResult | null> {
    const { workspaceId, dealId } = input;
    const userId = input.userId ?? null;
    const isOpen = gathered.stage?.kind === "open";
    let reason: DeterministicReason | undefined = gathered.gate ?? undefined;
    if (!reason && !gathered.messages.length) reason = "no_emails";
    let evidence: DealEvidence | undefined;
    let model: string | null = null;
    let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
    // Closed deals get no flags: no reason to spend credits on them.
    if (!reason && isOpen && provider) {
      try {
        const result = await extractDealEvidence(provider, gathered.modelInput);
        usage = result.usage;
        model = result.model || null;
        if (result.valid) evidence = result.evidence;
        else reason = "model_error";
      } catch (error) {
        if (error instanceof AiError && error.details.usage) {
          usage = error.details.usage;
          model = error.details.model || null;
        }
        reason = "model_error";
        log.warn(`reality-check: deal ${dealId} model step failed: ${describe(error)}`);
      }
      // Recorded before the reservation is released: for a moment both count (never neither).
      await recordUsage(workspaceId, userId, usage, model ?? "");
    }

    return withTenant(db, { workspaceId, ...(userId ? { userId } : {}) }, async (tx) => {
      // Re-read the deal: it may have moved or been edited while the model was thinking.
      const [deal] = await tx
        .select()
        .from(deals)
        .where(and(eq(deals.id, dealId), eq(deals.workspaceId, workspaceId)))
        .limit(1)
        .for("update");
      if (!deal) return null;
      const stages = await loadStages(tx, workspaceId);
      const latest = await latestActivity(tx, workspaceId, dealId, deal.lastActivityAt);
      const dismissals = await tx
        .select({
          code: dealFlagDismissals.code,
          criterionKey: dealFlagDismissals.criterionKey,
          dismissedAt: dealFlagDismissals.dismissedAt,
        })
        .from(dealFlagDismissals)
        .where(
          and(
            eq(dealFlagDismissals.workspaceId, workspaceId),
            eq(dealFlagDismissals.dealId, dealId),
          ),
        );
      const base = {
        stages,
        deal: {
          stageId: deal.stageId,
          stageEnteredAt: deal.stageEnteredAt,
          lastActivityAt: latest,
          nextStep: deal.nextStep,
          nextStepDate: deal.nextStepDate,
          expectedCloseDate: deal.expectedCloseDate,
          isOpen: stages.find((s) => s.id === deal.stageId)?.kind === "open",
        },
        evidence: evidence ?? null,
        latestActivityAt: latest,
        timeZone: gathered.timeZone,
      };
      // Stored: every flag (dismissals are applied when reading). Suggestion: respects them.
      const all = assessDeal(base, t);
      const dismissedFlags = dismissals.map((d) => ({
        ...d,
        code: d.code as RealityFlagCode,
      }));
      const visible = assessDeal({ ...base, dismissedFlags }, t);
      const deterministicOnly = !evidence;
      const [row] = await tx
        .update(dealChecks)
        .set({
          status: "done",
          stageId: deal.stageId,
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          evidence: storedEvidence(evidence),
          flags: all.flags as DealFlagJson[],
          evidenceStageId: evidence ? (all.evidenceStageId ?? null) : null,
          deterministicOnly,
          deterministicReason: deterministicOnly ? (reason ?? null) : null,
        })
        .where(
          and(
            eq(dealChecks.id, gathered.pendingId),
            eq(dealChecks.workspaceId, workspaceId),
            eq(dealChecks.status, "pending"),
          ),
        )
        .returning({ id: dealChecks.id });
      if (!row) throw new Error("reality-check: the pending run was already completed");
      const checkId = row.id;
      await tx
        .update(deals)
        .set({ realityCheckedAt: t, realityLockedUntil: null })
        .where(and(eq(deals.id, dealId), eq(deals.workspaceId, workspaceId)));
      // Without the model there is no evidence to judge the stage by: an open proposal from an
      // earlier model run stays as it is (QA-L1).
      const proposalId = deterministicOnly
        ? await openProposalId(tx, workspaceId, dealId)
        : await syncProposal(tx, {
            workspaceId,
            deal,
            checkId,
            model: model ?? "rules",
            suggestion: visible.suggestion,
            latestActivityAt: latest,
            now: t,
          });
      return {
        checkId,
        deterministicOnly,
        ...(deterministicOnly && reason ? { deterministicReason: reason } : {}),
        ...(proposalId ? { proposalId } : {}),
      };
    });
  }

  async function runOnce(batch = 20): Promise<RealitySummary> {
    const summary: RealitySummary = { claimed: 0, checked: 0, failed: 0 };
    const claimed = rowsOf<{ workspace_id: string; deal_id: string }>(
      await withIdentity(db, (tx) =>
        tx.execute(sql`SELECT * FROM claim_due_reality_checks(${batch})`),
      ),
    );
    summary.claimed = claimed.length;
    for (const row of claimed) {
      if (stopped) break;
      try {
        if (
          await check({ workspaceId: row.workspace_id, dealId: row.deal_id, trigger: "scheduled" })
        ) {
          summary.checked += 1;
        }
      } catch (error) {
        // One bad deal never stops the batch; its lease runs out and it is retried.
        summary.failed += 1;
        log.error(`reality-check: deal ${row.deal_id} failed: ${describe(error)}`);
      }
    }
    return summary;
  }

  return {
    check,
    runOnce: (batch?: number) => {
      const run = runOnce(batch);
      running = run;
      return run;
    },
    start(pollMs = REALITY_POLL_MS) {
      stopped = false;
      const tick = async () => {
        if (stopped) return;
        try {
          running = runOnce();
          await running;
        } catch (error) {
          log.error(`reality-check: run failed: ${describe(error)}`);
        } finally {
          running = undefined;
          if (!stopped) timer = setTimeout(() => void tick(), pollMs);
        }
      };
      timer = setTimeout(() => void tick(), 5_000);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (running) await running.catch(() => undefined);
    },
  };
}
