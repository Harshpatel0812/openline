/**
 * Deal rules that need no database: stale / next-step / close-date flags, calendar windows in the
 * workspace time zone, and money totals (integer minor units, rounded once, never floats).
 */
import { localDateOf, safeTimeZone } from "@openline/ai";
import type { CurrencyTotalDto, DealTotalsDto, StageKind } from "@openline/shared";

export const DAY_MS = 86_400_000;

export interface DealFlagInput {
  kind: StageKind;
  /** The stage's position, and the position of the first open stage. */
  stagePosition: number;
  firstOpenPosition: number;
  staleAfterDays: number | null;
  lastActivityAt: Date;
  nextStep: string | null;
  nextStepDate: string | null;
  expectedCloseDate: string | null;
}

export interface DealFlags {
  isStale: boolean;
  nextStepOverdue: boolean;
  closeDateOverdue: boolean;
  missingNextStep: boolean;
}

/**
 * Stale = strictly more than `staleAfterDays` × 24 h since the last activity (an absolute
 * duration, so the time zone doesn't matter). Dates (next step, close) are calendar days: overdue
 * once the workspace's local `today` is after them — on the day itself they are not overdue.
 */
export function dealFlags(d: DealFlagInput, now: Date, today: string): DealFlags {
  const open = d.kind === "open";
  return {
    isStale:
      open &&
      d.staleAfterDays !== null &&
      now.getTime() - d.lastActivityAt.getTime() > d.staleAfterDays * DAY_MS,
    nextStepOverdue: open && d.nextStepDate !== null && d.nextStepDate < today,
    closeDateOverdue: open && d.expectedCloseDate !== null && d.expectedCloseDate < today,
    missingNextStep: open && d.stagePosition > d.firstOpenPosition && !d.nextStep,
  };
}

export interface CalendarWindow {
  today: string;
  monthStart: string;
  nextMonthStart: string;
  quarterStart: string;
  nextQuarterStart: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const firstOf = (y: number, m: number) =>
  m > 12 ? `${y + 1}-${pad(m - 12)}-01` : `${y}-${pad(m)}-01`;

/** Today, this month and this quarter as YYYY-MM-DD bounds ([start, next start)) in `timeZone`. */
export function calendarWindow(timeZone: string, now = new Date()): CalendarWindow {
  const today = localDateOf(now, safeTimeZone(timeZone));
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const q = Math.floor((m - 1) / 3) * 3 + 1;
  return {
    today,
    monthStart: firstOf(y, m),
    nextMonthStart: firstOf(y, m + 1),
    quarterStart: firstOf(y, q),
    nextQuarterStart: firstOf(y, q + 3),
  };
}

/** One aggregated group from the database: sums as decimal strings (bigint-safe). */
export interface MoneyGroup {
  currency: string;
  count: number;
  /** Deals in the group that have an amount. */
  withAmount: number;
  /** Σ amount_minor. */
  amount: string;
  /** Σ amount_minor × probability (percent points), not yet divided by 100. */
  weightedRaw: string;
}

/** Round half up of raw / 100 for non-negative integers, exactly. */
export function roundPercent(raw: bigint): bigint {
  return (raw + 50n) / 100n;
}

function toSafeNumber(v: bigint): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error("Money total exceeds the safe integer range");
  return n;
}

/**
 * Totals for a set of groups. Weighted sums are rounded once per currency (after summing), so
 * the forecast isn't the sum of rounded columns. `amountMinor`/`weightedMinor` are in the
 * workspace currency; every currency (workspace first, then A–Z) is in `byCurrency`.
 */
export function totalsOf(groups: MoneyGroup[], workspaceCurrency: string): DealTotalsDto {
  const per = new Map<string, { count: number; amount: bigint; raw: bigint }>();
  let count = 0;
  for (const g of groups) {
    count += g.count;
    if (g.withAmount === 0) continue;
    const cur = per.get(g.currency) ?? { count: 0, amount: 0n, raw: 0n };
    cur.count += g.withAmount;
    cur.amount += BigInt(g.amount);
    cur.raw += BigInt(g.weightedRaw);
    per.set(g.currency, cur);
  }
  const byCurrency: CurrencyTotalDto[] = [...per.entries()]
    .sort(([a], [b]) =>
      a === workspaceCurrency ? -1 : b === workspaceCurrency ? 1 : a.localeCompare(b),
    )
    .map(([currency, v]) => ({
      currency,
      count: v.count,
      amountMinor: toSafeNumber(v.amount),
      weightedMinor: toSafeNumber(roundPercent(v.raw)),
    }));
  const home = byCurrency.find((c) => c.currency === workspaceCurrency);
  return {
    count,
    amountMinor: home?.amountMinor ?? 0,
    weightedMinor: home?.weightedMinor ?? 0,
    byCurrency,
  };
}
