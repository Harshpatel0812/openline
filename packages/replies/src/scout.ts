/**
 * Scout's model as the reply classifier, gated per workspace: used only when the workspace has
 * Scout on and credits left this month; otherwise (and when the model's answer was invalid twice)
 * the keyword fallback decides and the label is shown as "(rule)". Token usage is recorded in the
 * ai_usage ledger as feature "classify_reply", so classification counts toward the budget.
 *
 * Inbound mail is attacker-controlled (anyone can send "replies" that match by thread or domain),
 * so classification has caps of its own: at most `dailyCapPerMailbox` model classifications per
 * mailbox per UTC day (REPLY_CLASSIFY_DAILY_CAP, default 200), and at most half of the month's
 * credits. Beyond either, the keyword rules decide; drafting keeps the rest of the budget.
 */
import {
  AiError,
  classifyReply as classifyWithModel,
  creditsFor,
  monthStart,
  type LlmProvider,
} from "@openline/ai";
import { aiUsage, and, eq, sql, withTenant, workspaces, type Db } from "@openline/db";
import { keywordClassifier } from "./classify";
import type { ReplyClassifier } from "./types";

export const CLASSIFY_FEATURE = "classify_reply";
export const DEFAULT_REPLY_CLASSIFY_DAILY_CAP = 200;
/** Share of the monthly credits reply classification may use. */
export const CLASSIFY_BUDGET_SHARE = 0.5;

export function createScoutReplyClassifier(options: {
  db: Db;
  provider: LlmProvider;
  now?: () => Date;
  /** Model classifications per mailbox per UTC day (REPLY_CLASSIFY_DAILY_CAP). */
  dailyCapPerMailbox?: number;
}): ReplyClassifier {
  const { db, provider } = options;
  const now = options.now ?? (() => new Date());
  const dailyCap = options.dailyCapPerMailbox ?? DEFAULT_REPLY_CLASSIFY_DAILY_CAP;

  const record = async (
    workspaceId: string,
    mailboxId: string | undefined,
    usage: { inputTokens: number; outputTokens: number },
    model: string,
  ) => {
    if (usage.inputTokens + usage.outputTokens <= 0) return;
    await withTenant(db, { workspaceId }, (tx) =>
      tx.insert(aiUsage).values({
        workspaceId,
        userId: null,
        mailboxId: mailboxId ?? null,
        feature: CLASSIFY_FEATURE,
        model: model || "unknown",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        credits: creditsFor(usage),
        createdAt: now(),
      }),
    );
  };

  return async (input) => {
    const workspaceId = input.workspaceId;
    if (!workspaceId) return keywordClassifier(input);

    const allowed = await withTenant(db, { workspaceId }, async (tx) => {
      const [ws] = await tx
        .select({ enabled: workspaces.scoutEnabled, credits: workspaces.scoutMonthlyCredits })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      if (!ws?.enabled) return false;
      const t = now();
      const [row] = await tx
        .select({
          used: sql<number>`coalesce(sum(${aiUsage.credits}), 0)::int`,
          classify: sql<number>`coalesce(sum(${aiUsage.credits}) filter (where ${aiUsage.feature} = ${CLASSIFY_FEATURE}), 0)::int`,
        })
        .from(aiUsage)
        .where(
          and(
            eq(aiUsage.workspaceId, workspaceId),
            sql`${aiUsage.createdAt} >= ${monthStart(t).toISOString()}`,
          ),
        );
      if (Number(row?.used ?? 0) >= ws.credits) return false;
      if (Number(row?.classify ?? 0) >= ws.credits * CLASSIFY_BUDGET_SHARE) return false;
      if (input.mailboxId) {
        const dayStart = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
        const [today] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(aiUsage)
          .where(
            and(
              eq(aiUsage.workspaceId, workspaceId),
              eq(aiUsage.mailboxId, input.mailboxId),
              eq(aiUsage.feature, CLASSIFY_FEATURE),
              sql`${aiUsage.createdAt} >= ${dayStart.toISOString()}`,
            ),
          );
        if (Number(today?.n ?? 0) >= dailyCap) return false;
      }
      return true;
    });
    if (!allowed) return keywordClassifier(input);

    // The text is fenced as untrusted inside packages/ai's prompt builder.
    let result;
    try {
      result = await classifyWithModel(provider, {
        text: input.text,
        subject: input.subject,
        from: input.from,
      });
    } catch (error) {
      // Tokens spent before the failure (a first, invalid attempt) still count (L2).
      if (error instanceof AiError && error.details.usage) {
        await record(workspaceId, input.mailboxId, error.details.usage, error.details.model ?? "");
      }
      throw error;
    }
    await record(workspaceId, input.mailboxId, result.usage, result.model);
    if (!result.valid) return keywordClassifier(input);
    return {
      label: result.label,
      confidence: result.confidence,
      ...(result.summary ? { summary: result.summary } : {}),
      ...(result.returnDate ? { returnDate: result.returnDate } : {}),
      ...(result.referral ? { referral: result.referral } : {}),
      source: "model",
    };
  };
}
