/**
 * Reply classification. Deterministic first (bounce and auto-reply headers decide with no AI), then
 * the injected classifier (Scout's model), with this file's keyword fallback when no model is
 * configured or the model fails. Labels from the fallback carry source "rule".
 */
import { FOOTER_UNSUBSCRIBE_PROMPT } from "@openline/email";
import { ReplyClassificationSchema, type ReplyLabel } from "@openline/shared";
import type { ParsedInbound } from "./parse";
import type { ClassifierInput, ClassifierResult, ReplyClassifier } from "./types";

const UNSUBSCRIBE =
  /\b(unsubscribe|remove me|take me off|stop (?:e-?mailing|contacting|sending)|do not (?:contact|e-?mail) me|don'?t (?:contact|e-?mail) me)\b/i;
const OUT_OF_OFFICE =
  /\b(out of (?:the )?office|on (?:vacation|holiday|annual leave|parental leave|leave)|away from (?:the |my )?(?:office|desk)|limited access to (?:my )?e-?mail|automatic reply|auto-?reply)\b/i;
const NOT_INTERESTED = /\b(not interested|no thanks|no, thanks|no thank you|no, thank you)\b/i;

const FOOTER_PROMPT = new RegExp(
  FOOTER_UNSUBSCRIBE_PROMPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("'", "['’]"),
  "i",
);
/** Our own one-click unsubscribe links (WEB_URL/u/<token>, /api/v1/public/unsubscribe/<token>). */
const UNSUBSCRIBE_URL = /\S*\/(?:u|api\/v1\/public\/unsubscribe)\/[A-Za-z0-9._~%-]{8,}\S*/g;

/**
 * The reply's own words: drops `>`-quoted lines, quoted copies of our compliance footer and our
 * unsubscribe links (the text is already cut at the quoted history by parseInbound's trimQuoted).
 * Intent such as "unsubscribe" is only ever read from what's left.
 */
export function ownText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*>/.test(line) && !FOOTER_PROMPT.test(line))
    .map((line) => line.replace(UNSUBSCRIBE_URL, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The keyword fallback (OL-E4 §2.3). Never throws. */
export const keywordClassifier: ReplyClassifier = async (input) => {
  const text = ownText(input.text);
  const haystack = `${input.subject}\n${text}`;
  let label: ReplyLabel = "other";
  if (UNSUBSCRIBE.test(haystack)) label = "unsubscribe";
  else if (OUT_OF_OFFICE.test(haystack)) label = "out_of_office";
  else if (NOT_INTERESTED.test(haystack)) label = "not_interested";
  const result: ClassifierResult = {
    label,
    confidence: label === "other" ? 0.3 : 0.6,
    source: "rule",
  };
  if (label === "out_of_office") {
    const back = parseReturnDate(text, input.sentAt ?? new Date());
    if (back) result.returnDate = back;
  }
  return result;
};

export interface Classification {
  label: ReplyLabel;
  source: "rule" | "model";
  confidence: number;
  summary: string | null;
  returnDate: string | null;
  referral: { name?: string; email?: string } | null;
}

/**
 * The deterministic part: a permanent bounce report → bounce; auto-reply headers → out_of_office.
 * Returns "ignore" for bounce reports that aren't permanent (4.x.x / no status): those are not
 * stored. Returns null when the classifier has to decide.
 */
export function deterministicLabel(
  parsed: ParsedInbound,
  now: Date = new Date(),
): Classification | "ignore" | null {
  if (parsed.bounce) {
    if (!parsed.bounce.permanent) return "ignore";
    return {
      label: "bounce",
      source: "rule",
      confidence: 1,
      summary: null,
      returnDate: null,
      referral: null,
    };
  }
  if (parsed.autoReply) {
    return {
      label: "out_of_office",
      source: "rule",
      confidence: 1,
      summary: null,
      returnDate: parseReturnDate(parsed.text, anchorDate(parsed.date, now)),
      referral: null,
    };
  }
  return null;
}

/**
 * The date relative dates in a message are read against: the message's own Date header (an
 * out-of-office read days later still means the date it was written), never later than now.
 */
export function anchorDate(date: Date | null, now: Date): Date {
  return date && !Number.isNaN(date.getTime()) && date.getTime() <= now.getTime() + 5 * 60_000
    ? date
    : now;
}

/** A YYYY-MM-DD return date within (anchor - 1 day) … (anchor + 366 days), else null. */
export function clampReturnDate(value: string | null | undefined, anchor: Date): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(at)) return null;
  const day = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  return at < day - 86_400_000 || at > day + 366 * 86_400_000 ? null : value;
}

/** Runs the classifier with validation; any failure or invalid output → keyword fallback. */
export async function classifyReply(
  input: ClassifierInput,
  classifier: ReplyClassifier,
  now: Date = new Date(),
): Promise<Classification> {
  let result: ClassifierResult | undefined;
  let source: "rule" | "model" = "rule";
  const anchor = input.sentAt ?? now;
  // Classify only what the sender wrote: quoted history and our own footer say nothing about them.
  input = { ...input, text: ownText(input.text), sentAt: anchor };
  if (classifier !== keywordClassifier) {
    try {
      const raw = await classifier(input);
      const checked = ReplyClassificationSchema.safeParse(raw);
      if (checked.success) {
        result = checked.data;
        source = raw.source ?? "model";
      }
    } catch {
      // Fall through to the keyword fallback (the reply is never lost to a model error).
    }
  }
  if (!result) result = await keywordClassifier(input);
  // A bounce label can only come from the deterministic DSN check (it has effects on the contact).
  const label: ReplyLabel = result.label === "bounce" ? "other" : result.label;
  return {
    label,
    source,
    confidence: result.confidence,
    summary: result.summary?.slice(0, 140) || null,
    // A model's date is checked like a parsed one; an implausible date means "+7 days" (S3).
    returnDate:
      label !== "out_of_office"
        ? null
        : result.returnDate
          ? clampReturnDate(result.returnDate, anchor)
          : parseReturnDate(input.text, anchor),
    referral: label === "referral" && result.referral ? result.referral : null,
  };
}

// ------------------------------------------------------------------ return dates

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const DAY = String.raw`(\d{1,2})(?:st|nd|rd|th)?`;
const KEYWORD = String.raw`(?:back|return(?:ing)?|returns|until|till|through)`;

function iso(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m, d));
  if (date.getUTCMonth() !== m || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** How far before the message a date without a year still reads as "already past". */
const PAST_WINDOW_DAYS = 60;

/**
 * The year for a month/day without one, read against the message's date: on or after (anchor - 1
 * day) → this year; up to 60 days before → a date already past (null: resume in 7 days); further
 * back → next year ("back Jan 5" written in November).
 */
function withYear(m: number, d: number, year: number | null, anchor: Date): string | null {
  if (year) return iso(year < 100 ? 2000 + year : year, m, d);
  const day = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  const y = anchor.getUTCFullYear();
  const at = Date.UTC(y, m, d);
  if (at >= day - 86_400_000) return iso(y, m, d);
  if (at >= day - PAST_WINDOW_DAYS * 86_400_000) return null;
  return iso(y + 1, m, d);
}

/**
 * Finds the date an out-of-office sender is back ("back on Monday, November 24", "returning
 * 24 Nov", "until 2026-11-24", "out until 11/24"). Returns YYYY-MM-DD or null. `now` is the
 * anchor (pass the message's date): the result is within (anchor - 1 day) … (anchor + 366 days).
 */
export function parseReturnDate(text: string, now: Date = new Date()): string | null {
  const sample = text.slice(0, 4000);
  const window = String.raw`${KEYWORD}\b[^.\n]{0,40}?`;
  const patterns: { re: RegExp; build: (m: RegExpExecArray) => string | null }[] = [
    {
      re: new RegExp(String.raw`${window}\b(\d{4})-(\d{2})-(\d{2})\b`, "i"),
      build: (m) => iso(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
    },
    {
      re: new RegExp(String.raw`${window}\b${MONTH}\s+${DAY}\b(?:,?\s+(\d{4}))?`, "i"),
      build: (m) => withYear(monthIndex(m[1]!), Number(m[2]), m[3] ? Number(m[3]) : null, now),
    },
    {
      re: new RegExp(String.raw`${window}\b${DAY}\s+(?:of\s+)?${MONTH}(?:,?\s+(\d{4}))?`, "i"),
      build: (m) => withYear(monthIndex(m[2]!), Number(m[1]), m[3] ? Number(m[3]) : null, now),
    },
    {
      re: new RegExp(String.raw`${window}\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b`, "i"),
      build: (m) => {
        let month = Number(m[1]);
        let day = Number(m[2]);
        if (month > 12 && day <= 12) [month, day] = [day, month]; // 24/11 → day first
        return withYear(month - 1, day, m[3] ? Number(m[3]) : null, now);
      },
    },
    {
      re: new RegExp(
        String.raw`${window}\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b`,
        "i",
      ),
      build: (m) => {
        const target = WEEKDAYS.indexOf(m[1]!.toLowerCase());
        const ahead = (target - now.getUTCDay() + 7) % 7 || 7;
        const d = new Date(now.getTime() + ahead * 86_400_000);
        return d.toISOString().slice(0, 10);
      },
    },
  ];
  let best: { index: number; value: string } | null = null;
  for (const { re, build } of patterns) {
    const m = re.exec(sample);
    if (!m) continue;
    const value = build(m);
    if (value && (!best || m.index < best.index)) best = { index: m.index, value };
  }
  if (!best) return null;
  return clampReturnDate(best.value, now);
}

function monthIndex(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase() as (typeof MONTHS)[number]);
}

/**
 * When to resume after an out-of-office: the business day after the return date (noon UTC; the
 * engine then waits for the contact's own send window), or +7 days when no date was found.
 */
export function resumeAfterOutOfOffice(returnDate: string | null, now: Date): Date {
  if (!returnDate) return new Date(now.getTime() + 7 * 86_400_000);
  const d = new Date(`${returnDate}T12:00:00Z`);
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.getTime() > now.getTime() ? d : new Date(now.getTime() + 86_400_000);
}
