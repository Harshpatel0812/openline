/** Helpers for deals, the pipeline board and Reality Check (OL-E7). */
import {
  currencyMinorDigits,
  REALITY_EVIDENCE_LABELS,
  type DealContactRefDto,
  type DealDto,
  type DealEvidenceType,
  type PipelineStageDto,
} from "@openline/shared";

/** Fired after a deal is created, edited or moved, so lists on other cards refresh. */
export const DEALS_CHANGED_EVENT = "openline:deals-changed";

export function notifyDealsChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DEALS_CHANGED_EVENT));
}

export const EVIDENCE_TYPE_LABELS: Record<DealEvidenceType, string> = {
  ...REALITY_EVIDENCE_LABELS,
  none: "No evidence check (checklist only)",
};

const moneyFormats = new Map<string, Intl.NumberFormat>();

function moneyFormat(currency: string, compact: boolean): Intl.NumberFormat {
  const key = `${currency}:${compact}`;
  let fmt = moneyFormats.get(key);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        ...(compact ? { notation: "compact", maximumFractionDigits: 1 } : {}),
      });
    } catch {
      fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
    }
    moneyFormats.set(key, fmt);
  }
  return fmt;
}

/** Minor units → "$12,500.00" (or "$12.5K" compact). Integer maths until the final division. */
export function formatMoney(minor: number | null, currency: string, compact = false): string {
  if (minor === null) return "—";
  const digits = currencyMinorDigits(currency);
  return moneyFormat(currency, compact).format(minor / 10 ** digits);
}

/** Minor units → the text for an amount input ("12500.5"), no grouping. */
export function minorToInput(minor: number | null, currency: string): string {
  if (minor === null) return "";
  const digits = currencyMinorDigits(currency);
  if (digits === 0) return String(minor);
  const s = String(minor).padStart(digits + 1, "0");
  const whole = s.slice(0, -digits);
  const frac = s.slice(-digits).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Commonly used ISO 4217 codes first; any other code the runtime knows follows. */
const COMMON_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "INR", "JPY", "CHF", "SGD", "NZD"];

export function currencyOptions(current?: string): string[] {
  let all: string[] = [];
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  try {
    all = supported ? supported("currency") : [];
  } catch {
    all = [];
  }
  const rest = all.filter((c) => !COMMON_CURRENCIES.includes(c));
  const list = [...COMMON_CURRENCIES, ...rest];
  if (current && !list.includes(current)) list.unshift(current);
  return list;
}

let currencyNames: Intl.DisplayNames | null = null;

export function currencyName(code: string): string {
  try {
    currencyNames ??= new Intl.DisplayNames(["en"], { type: "currency" });
    const name = currencyNames.of(code);
    return name && name !== code ? `${code} — ${name}` : code;
  } catch {
    return code;
  }
}

const dayFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** "Nov 30, 2026" for a YYYY-MM-DD calendar date (no time zone shift). */
export function formatCalendarDate(ymd: string | null): string {
  if (!ymd) return "—";
  const d = new Date(`${ymd}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? "—" : dayFmt.format(d);
}

/** Today as YYYY-MM-DD in the viewer's time zone (offset by `days`). */
export function localDate(days = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dealContactName(c: DealContactRefDto): string {
  return [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || c.email;
}

/** The deterministic Reality Check flags carried on every deal, as short words. */
export function dealFlags(d: DealDto): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  if (d.isStale) out.push({ key: "stale", label: "Stale" });
  if (d.nextStepOverdue) out.push({ key: "next", label: "Next step overdue" });
  if (d.closeDateOverdue) out.push({ key: "close", label: "Close date passed" });
  if (d.missingNextStep) out.push({ key: "missing", label: "No next step" });
  return out;
}

/** Reality Check flags shown as the board's flag icon (beyond the separate Stale/overdue badges). */
export function realityFlagged(d: DealDto): boolean {
  return d.closeDateOverdue || d.missingNextStep || hasModelFlags(d);
}

/** Model flags may later be carried on the deal as `realityFlagCount`; read it if present. */
function hasModelFlags(d: DealDto): boolean {
  const extra = (d as DealDto & { realityFlagCount?: number }).realityFlagCount;
  return typeof extra === "number" && extra > 0;
}

export interface Totals {
  count: number;
  /** In the workspace currency. */
  amountMinor: number;
  weightedMinor: number;
  /** Other currencies (not converted). */
  others: { currency: string; amountMinor: number }[];
}

/**
 * Column totals from loaded deals, matching the API: weighted = round half up of
 * Σ(amount × probability) / 100, rounded once per bucket.
 */
export function totalsFor(
  deals: DealDto[],
  currency: string,
  probabilityOf: (d: DealDto) => number,
): Totals {
  let amount = 0;
  let weightedRaw = 0;
  const others = new Map<string, number>();
  for (const d of deals) {
    if (d.amountMinor === null) continue;
    if (d.currency === currency) {
      amount += d.amountMinor;
      weightedRaw += d.amountMinor * probabilityOf(d);
    } else {
      others.set(d.currency, (others.get(d.currency) ?? 0) + d.amountMinor);
    }
  }
  return {
    count: deals.length,
    amountMinor: amount,
    weightedMinor: Math.floor((weightedRaw + 50) / 100),
    others: [...others].map(([c, a]) => ({ currency: c, amountMinor: a })),
  };
}

export function stageOrder(stages: PipelineStageDto[]): PipelineStageDto[] {
  return [...stages].sort((a, b) => a.position - b.position);
}

export function relativeDays(iso: string, now = Date.now()): string {
  const days = Math.floor((now - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}
