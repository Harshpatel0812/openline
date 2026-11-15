/**
 * AI credits: 1 credit = 1,000 tokens (input + output), rounded up per call. Budgets are per
 * workspace per calendar month (UTC).
 */
import { AiError, type LlmUsage } from "./provider";

export const TOKENS_PER_CREDIT = 1_000;
export const DEFAULT_MONTHLY_CREDITS = 2_000;

export function creditsFor(usage: LlmUsage): number {
  const tokens = Math.max(0, usage.inputTokens) + Math.max(0, usage.outputTokens);
  return Math.ceil(tokens / TOKENS_PER_CREDIT);
}

/** First instant of the month containing `now` (UTC). */
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** When this month's budget resets: the first instant of next month (UTC). */
export function budgetResetsAt(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** "2026-11" */
export function monthKey(now: Date): string {
  return monthStart(now).toISOString().slice(0, 7);
}

/** Throws AiError("budget") once the month's credits are used up. */
export function assertWithinBudget(usedCredits: number, monthlyCredits: number, now: Date): void {
  if (usedCredits >= monthlyCredits) {
    throw new AiError("budget", "This workspace has used its Scout credits for the month.", {
      resetsAt: budgetResetsAt(now),
    });
  }
}

/**
 * Levenshtein distance (characters) between the draft and what the rep approved — the
 * "approved with light edits" metric. Inputs are capped, so the cost stays bounded.
 */
export function editDistance(a: string, b: string, cap = 10_000): number {
  const s = a.slice(0, cap);
  const t = b.slice(0, cap);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  let curr = new Array<number>(t.length + 1).fill(0);
  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;
    const si = s.charCodeAt(i - 1);
    for (let j = 1; j <= t.length; j++) {
      const cost = si === t.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[t.length]!;
}
