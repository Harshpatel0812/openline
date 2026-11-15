import { Injectable } from "@nestjs/common";
import {
  assertWithinBudget,
  budgetResetsAt,
  creditsFor,
  monthKey,
  monthStart,
  type LlmUsage,
} from "@openline/ai";
import { aiUsage, and, eq, sql, type Tx } from "@openline/db";
import type { ScoutUsageDto } from "@openline/shared";

export interface UsageEntry {
  workspaceId: string;
  userId: string | null;
  feature: string;
  aiActionId?: string | null;
  model: string;
  usage: LlmUsage;
}

/**
 * Monthly AI credit budgets from the append-only ai_usage ledger. The check runs before a model
 * call and the spend is recorded after it, so one in-flight request can overshoot slightly; the
 * next one is refused.
 */
@Injectable()
export class ScoutBudgetService {
  async creditsUsed(tx: Tx, workspaceId: string, now = new Date()): Promise<number> {
    const [row] = await tx
      .select({ used: sql<number>`coalesce(sum(${aiUsage.credits}), 0)::int` })
      .from(aiUsage)
      .where(
        and(
          eq(aiUsage.workspaceId, workspaceId),
          sql`${aiUsage.createdAt} >= ${monthStart(now).toISOString()}`,
        ),
      );
    return Number(row?.used ?? 0);
  }

  async usage(
    tx: Tx,
    workspaceId: string,
    monthlyCredits: number,
    now = new Date(),
  ): Promise<ScoutUsageDto> {
    const used = await this.creditsUsed(tx, workspaceId, now);
    return {
      month: monthKey(now),
      creditsUsed: used,
      creditsRemaining: Math.max(0, monthlyCredits - used),
      resetsAt: budgetResetsAt(now).toISOString(),
    };
  }

  /** Throws AiError("budget") when the month's credits are used up. */
  async assertAvailable(
    tx: Tx,
    workspaceId: string,
    monthlyCredits: number,
    now = new Date(),
  ): Promise<void> {
    assertWithinBudget(await this.creditsUsed(tx, workspaceId, now), monthlyCredits, now);
  }

  async record(tx: Tx, entry: UsageEntry): Promise<number> {
    const credits = creditsFor(entry.usage);
    if (entry.usage.inputTokens + entry.usage.outputTokens === 0) return 0;
    await tx.insert(aiUsage).values({
      workspaceId: entry.workspaceId,
      userId: entry.userId,
      feature: entry.feature,
      aiActionId: entry.aiActionId ?? null,
      model: entry.model || "unknown",
      inputTokens: entry.usage.inputTokens,
      outputTokens: entry.usage.outputTokens,
      credits,
    });
    return credits;
  }
}
