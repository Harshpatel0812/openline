/**
 * Deterministic date resolution for Promise Keeper (OL-E6 §2).
 *
 * The model (or the rule-based extractor) only returns the words someone used ("by Friday",
 * "after budget in March", "Q2"). This module turns those words into dates from the message's own
 * date in the workspace's time zone. A model-computed absolute date is never trusted.
 *
 * Conventions (also in docs/api/README.md, "Promise Keeper"):
 * - Weeks run Monday–Sunday. A plain weekday ("Friday") is its next occurrence strictly after the
 *   message day; "this Friday" is this week's if not yet past; "next Friday" is the Friday of next
 *   week. On a Saturday or Sunday, "this week" / "end of the week" mean the coming week.
 * - A month (or quarter) named without a year is the next one that hasn't ended: "March" written
 *   in November is next March; "November" written in November is this month.
 * - Numeric dates are US order (month/day) unless the first number can't be a month.
 * - Quarters are calendar quarters. Seasons are northern-hemisphere (spring = March–May…); a
 *   season named is the one in progress or the next ("winter" in January is the winter that
 *   began in December); "next <season>" while that season is in progress is next year's.
 * - "may" is a month only with a day number ("May 4") or after in/by/until/after/early/late/mid.
 * - A due date is never more than 18 months after the message (PROMISE_HORIZON_MONTHS).
 * - Business days are Monday–Friday; public holidays are not modelled.
 */

export type WhenPrecision = "day" | "week" | "month" | "quarter" | "year";

export interface ResolvedWhen {
  /** First local day of the period (YYYY-MM-DD). */
  start: string;
  /** Last local day of the period (YYYY-MM-DD). */
  end: string;
  precision: WhenPrecision;
}

// ------------------------------------------------------------------ local dates

/** A calendar day with no time zone (month 1–12). */
interface Day {
  y: number;
  m: number;
  d: number;
}

const toUtc = (day: Day) => Date.UTC(day.y, day.m - 1, day.d);
const fromUtc = (ms: number): Day => {
  const t = new Date(ms);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const addDays = (day: Day, n: number): Day => fromUtc(toUtc(day) + n * 86_400_000);
/** 0 = Sunday … 6 = Saturday. */
const weekday = (day: Day) => new Date(toUtc(day)).getUTCDay();
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const iso = (day: Day) =>
  `${day.y}-${String(day.m).padStart(2, "0")}-${String(day.d).padStart(2, "0")}`;
const parseIso = (s: string): Day => {
  const [y, m, d] = s.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
};
const cmp = (a: Day, b: Day) => toUtc(a) - toUtc(b);
const isBusinessDay = (day: Day) => weekday(day) >= 1 && weekday(day) <= 5;

function addMonths(day: Day, n: number): Day {
  const index = day.y * 12 + (day.m - 1) + n;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return { y, m, d: Math.min(day.d, daysInMonth(y, m)) };
}

function businessDayOnOrAfter(day: Day): Day {
  let d = day;
  while (!isBusinessDay(d)) d = addDays(d, 1);
  return d;
}

function businessDayOnOrBefore(day: Day): Day {
  let d = day;
  while (!isBusinessDay(d)) d = addDays(d, -1);
  return d;
}

/** `n` business days after `day` (n ≥ 1). */
function addBusinessDays(day: Day, n: number): Day {
  let d = day;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (isBusinessDay(d)) left -= 1;
  }
  return d;
}

// ------------------------------------------------------------------ time zones

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** A valid IANA zone, or UTC. */
export function safeTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return "UTC";
  try {
    formatter(timeZone);
    return timeZone;
  } catch {
    return "UTC";
  }
}

function wallClock(at: Date, timeZone: string) {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** The local calendar day of an instant. */
function localDay(at: Date, timeZone: string): Day {
  const w = wallClock(at, timeZone);
  return { y: w.y, m: w.m, d: w.d };
}

/** The instant a local wall-clock time happens in `timeZone` (DST-correct). */
export function zonedTime(day: string, hour: number, minute: number, timeZone: string): Date {
  const { y, m, d } = parseIso(day);
  const wanted = Date.UTC(y, m - 1, d, hour, minute);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const w = wallClock(new Date(guess), timeZone);
    const seen = Date.UTC(w.y, w.m - 1, w.d, w.hour, w.minute, w.second);
    const next = guess + (wanted - seen);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

/** The local day (YYYY-MM-DD) of an instant in a time zone. */
export function localDateOf(at: Date, timeZone: string): string {
  return iso(localDay(at, safeTimeZone(timeZone)));
}

// ------------------------------------------------------------------ vocabulary

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};
const MONTH_RE =
  "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)";

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};
const WEEKDAY_RE =
  "(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|weds|wed|thurs|thur|thu|fri|sat|sun)";

const NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  "a couple of": 2,
  "a couple": 2,
  couple: 2,
  "couple of": 2,
  "a few": 3,
  few: 3,
};
const COUNT_RE =
  "(\\d{1,2}|a couple of|a couple|couple of|a few|few|an|a|one|two|three|four|five|six|seven|eight|nine|ten)";

const ORDINAL_QUARTER: Record<string, number> = {
  first: 1,
  "1st": 1,
  second: 2,
  "2nd": 2,
  third: 3,
  "3rd": 3,
  fourth: 4,
  "4th": 4,
  last: 4,
};

// ------------------------------------------------------------------ periods

interface Period {
  start: Day;
  end: Day;
  precision: WhenPrecision;
}

const dayPeriod = (day: Day): Period => ({ start: day, end: day, precision: "day" });

function monthPeriod(y: number, m: number, part?: string): Period {
  const last = daysInMonth(y, m);
  switch (part) {
    case "early":
    case "beginning of":
    case "start of":
      return { start: { y, m, d: 1 }, end: { y, m, d: 10 }, precision: "month" };
    case "mid":
    case "middle of":
      return { start: { y, m, d: 11 }, end: { y, m, d: 20 }, precision: "month" };
    case "late":
      return { start: { y, m, d: 21 }, end: { y, m, d: last }, precision: "month" };
    case "end of":
      return dayPeriod({ y, m, d: last });
    default:
      return { start: { y, m, d: 1 }, end: { y, m, d: last }, precision: "month" };
  }
}

function quarterPeriod(y: number, q: number, part?: string): Period {
  const m = (q - 1) * 3 + 1;
  const end: Day = { y, m: m + 2, d: daysInMonth(y, m + 2) };
  if (part === "end of") return dayPeriod(end);
  if (part === "early" || part === "beginning of" || part === "start of") {
    return { start: { y, m, d: 1 }, end: { y, m, d: daysInMonth(y, m) }, precision: "quarter" };
  }
  if (part === "late") {
    return { start: { y, m: m + 2, d: 1 }, end, precision: "quarter" };
  }
  return { start: { y, m, d: 1 }, end, precision: "quarter" };
}

/** Monday of the week containing `day`. */
const mondayOf = (day: Day) => addDays(day, -((weekday(day) + 6) % 7));

function weekPeriod(monday: Day): Period {
  return { start: monday, end: addDays(monday, 4), precision: "week" };
}

/** The current week for "this week" phrases: the coming one on a weekend. */
function thisWeekMonday(today: Day): Day {
  const wd = weekday(today);
  return wd === 0 || wd === 6 ? mondayOf(addDays(today, 7)) : mondayOf(today);
}

/** The period right after `p`, of the same size. */
function after(p: Period): Period {
  switch (p.precision) {
    case "day":
      return dayPeriod(addDays(p.end, 1));
    case "week":
      return weekPeriod(mondayOf(addDays(p.end, 7)));
    case "month": {
      const next = addMonths({ y: p.end.y, m: p.end.m, d: 1 }, 1);
      return monthPeriod(next.y, next.m);
    }
    case "quarter": {
      const next = addMonths({ y: p.end.y, m: p.end.m, d: 1 }, 1);
      return quarterPeriod(next.y, Math.ceil(next.m / 3));
    }
    case "year":
      return {
        start: { y: p.end.y + 1, m: 1, d: 1 },
        end: { y: p.end.y + 1, m: 12, d: 31 },
        precision: "year",
      };
  }
}

/** Year for a month named without one: the next month by that name that hasn't ended. */
const yearForMonth = (today: Day, m: number) => (m < today.m ? today.y + 1 : today.y);

function count(word: string): number {
  return /^\d+$/.test(word) ? Number(word) : (NUMBERS[word] ?? 1);
}

function fullYear(text: string | undefined, fallback: number): number {
  if (!text) return fallback;
  const n = Number(text);
  return n < 100 ? 2000 + n : n;
}

function validDay(y: number, m: number, d: number): Day | null {
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

/** A date without a year: this year if it's still ahead (or today), else next year. */
function upcoming(today: Day, m: number, d: number): Day | null {
  const thisYear = validDay(today.y, m, d);
  if (thisYear && cmp(thisYear, today) >= 0) return thisYear;
  return validDay(today.y + 1, m, d);
}

// ------------------------------------------------------------------ matchers

type Matcher = (text: string, today: Day) => Period | null;

const PART = "(early|mid|middle of|late|end of|beginning of|start of)";
/** "may" is also a verb: a month only after one of these (or with a day number). */
const MAY_PREFIXES = new Set(["in", "by", "until", "after", "early", "late", "mid"]);

const MATCHERS: Matcher[] = [
  // 2026-12-03
  (t) => {
    const x = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(t);
    if (!x) return null;
    const day = validDay(Number(x[1]), Number(x[2]), Number(x[3]));
    return day ? dayPeriod(day) : null;
  },
  // 12/3, 12/3/2026, 25/12 (day first only when it can't be a month)
  (t, today) => {
    const x = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t);
    if (!x) return null;
    let a = Number(x[1]);
    let b = Number(x[2]);
    if (a > 12 && b <= 12) [a, b] = [b, a];
    if (x[3]) {
      const day = validDay(fullYear(x[3], today.y), a, b);
      return day ? dayPeriod(day) : null;
    }
    const day = upcoming(today, a, b);
    return day ? dayPeriod(day) : null;
  },
  // December 3rd, Dec 3, 2026
  (t, today) => {
    const x = new RegExp(`\\b${MONTH_RE}\\.? (\\d{1,2})(?:st|nd|rd|th)?\\b(?:,? (\\d{4}))?`).exec(
      t,
    );
    if (!x) return null;
    const m = MONTHS[x[1]!]!;
    const d = Number(x[2]);
    const day = x[3] ? validDay(Number(x[3]), m, d) : upcoming(today, m, d);
    return day ? dayPeriod(day) : null;
  },
  // 3 December, 3rd of Dec 2026
  (t, today) => {
    const x = new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)? (?:of )?${MONTH_RE}\\b(?:,? (\\d{4}))?`,
    ).exec(t);
    if (!x) return null;
    const m = MONTHS[x[2]!]!;
    const d = Number(x[1]);
    const day = x[3] ? validDay(Number(x[3]), m, d) : upcoming(today, m, d);
    return day ? dayPeriod(day) : null;
  },
  // day after tomorrow / tomorrow / today
  (t, today) => (/\bday after tomorrow\b/.test(t) ? dayPeriod(addDays(today, 2)) : null),
  (t, today) => (/\b(tomorrow|tmrw|tmr)\b/.test(t) ? dayPeriod(addDays(today, 1)) : null),
  (t, today) =>
    /\b(today|tonight|eod|cob|end of (the )?day|close of business|this (morning|afternoon|evening)|later today)\b/.test(
      t,
    )
      ? dayPeriod(today)
      : null,
  // end of next week / beginning of next week
  (t, today) => {
    const x = /\b(end|beginning|start|middle) of next week\b/.exec(t);
    if (!x) return null;
    const monday = mondayOf(addDays(today, 7));
    return dayPeriod(
      x[1] === "end" ? addDays(monday, 4) : x[1] === "middle" ? addDays(monday, 2) : monday,
    );
  },
  // end of (this/the) week, eow, later this week, by the weekend
  (t, today) =>
    /\b(end of (the |this )?week|eow|later this week|by the weekend|before the weekend)\b/.test(t)
      ? dayPeriod(addDays(thisWeekMonday(today), 4))
      : null,
  // Friday next week / next week on Friday
  (t, today) => {
    const x = new RegExp(
      `\\b${WEEKDAY_RE} next week\\b|\\bnext week (?:on )?${WEEKDAY_RE}\\b`,
    ).exec(t);
    if (!x) return null;
    const target = WEEKDAYS[(x[1] ?? x[2])!]!;
    return dayPeriod(addDays(mondayOf(addDays(today, 7)), (target + 6) % 7));
  },
  // the week after next
  (t, today) => (/\bweek after next\b/.test(t) ? weekPeriod(mondayOf(addDays(today, 14))) : null),
  // next week / this week
  (t, today) => (/\bnext week\b/.test(t) ? weekPeriod(mondayOf(addDays(today, 7))) : null),
  (t, today) =>
    /\bthis week\b/.test(t)
      ? { start: today, end: addDays(thisWeekMonday(today), 4), precision: "week" }
      : null,
  // in 3 days / in a couple of weeks / in two months
  (t, today) => {
    const x = new RegExp(
      `\\b(?:in|within|over|next) (?:the next )?${COUNT_RE} (day|business day|week|month|year)s?\\b`,
    ).exec(t);
    if (!x) return null;
    const n = count(x[1]!);
    switch (x[2]) {
      case "day":
        return dayPeriod(addDays(today, n));
      case "business day":
        return dayPeriod(addBusinessDays(today, n));
      case "week":
        return dayPeriod(addDays(today, 7 * n));
      case "month":
        return dayPeriod(addMonths(today, n));
      default:
        return dayPeriod({
          y: today.y + n,
          m: today.m,
          d: Math.min(today.d, daysInMonth(today.y + n, today.m)),
        });
    }
  },
  // 3 weeks from now / a month from today
  (t, today) => {
    const x = new RegExp(`\\b${COUNT_RE} (day|week|month)s? from (now|today)\\b`).exec(t);
    if (!x) return null;
    const n = count(x[1]!);
    if (x[2] === "day") return dayPeriod(addDays(today, n));
    if (x[2] === "week") return dayPeriod(addDays(today, 7 * n));
    return dayPeriod(addMonths(today, n));
  },
  // end of (this) month / eom / month end / beginning of next month / next month
  (t, today) =>
    /\b(end of (the |this )?month|eom|month end|month-end)\b/.test(t)
      ? dayPeriod({ y: today.y, m: today.m, d: daysInMonth(today.y, today.m) })
      : null,
  (t, today) => {
    const x = new RegExp(`\\b(?:${PART} )?next month\\b`).exec(t);
    if (!x) return null;
    const next = addMonths({ ...today, d: 1 }, 1);
    return monthPeriod(next.y, next.m, x[1]);
  },
  (t, today) => {
    const x = new RegExp(`\\b(?:${PART} )?this month\\b`).exec(t);
    return x ? monthPeriod(today.y, today.m, x[1]) : null;
  },
  // Q2, Q2 2027, early Q3, end of Q4
  (t, today) => {
    const x = new RegExp(`\\b(?:${PART} )?q([1-4])\\b(?:[ ']?(\\d{4}|\\d{2}))?`).exec(t);
    if (!x) return null;
    const q = Number(x[2]);
    const current = Math.ceil(today.m / 3);
    const y = x[3] ? fullYear(x[3], today.y) : q < current ? today.y + 1 : today.y;
    return quarterPeriod(y, q, x[1]);
  },
  // second quarter, the last quarter of 2026
  (t, today) => {
    const x = new RegExp(
      `\\b(?:${PART} )?(?:the )?(first|1st|second|2nd|third|3rd|fourth|4th|last) quarter\\b(?: (?:of )?(\\d{4}))?`,
    ).exec(t);
    if (!x) return null;
    const q = ORDINAL_QUARTER[x[2]!]!;
    const current = Math.ceil(today.m / 3);
    const y = x[3] ? Number(x[3]) : q < current ? today.y + 1 : today.y;
    return quarterPeriod(y, q, x[1]);
  },
  // next quarter / this quarter / end of quarter
  (t, today) => {
    const x = new RegExp(`\\b(?:${PART} )?(?:(next|this|the) )?quarter\\b|\\beoq\\b`).exec(t);
    if (!x || (x[0] !== "eoq" && !x[1] && !x[2])) return null;
    const current = Math.ceil(today.m / 3);
    if (x[0] === "eoq") return quarterPeriod(today.y, current, "end of");
    if (x[2] === "next") {
      const y = current === 4 ? today.y + 1 : today.y;
      return quarterPeriod(y, current === 4 ? 1 : current + 1, x[1]);
    }
    return quarterPeriod(today.y, current, x[1]);
  },
  // after the holidays / in the new year / after new year's
  (t, today) =>
    /\b(after the holidays|new year|new years|new year's)\b/.test(t)
      ? dayPeriod(validDay(today.m === 1 && today.d <= 2 ? today.y : today.y + 1, 1, 2)!)
      : null,
  // end of (the) year / eoy / next year / early next year
  (t, today) =>
    /\b(end of (the |this )?year|eoy|year end|year-end)\b/.test(t)
      ? dayPeriod({ y: today.y, m: 12, d: 31 })
      : null,
  (t, today) => {
    const x = new RegExp(`\\b(?:${PART} )?next year\\b`).exec(t);
    if (!x) return null;
    const y = today.y + 1;
    if (x[1] === "early" || x[1] === "beginning of" || x[1] === "start of") {
      return { start: { y, m: 1, d: 1 }, end: { y, m: 2, d: 28 }, precision: "year" };
    }
    if (x[1] === "end of") return dayPeriod({ y, m: 12, d: 31 });
    return { start: { y, m: 1, d: 1 }, end: { y, m: 12, d: 31 }, precision: "year" };
  },
  // seasons (northern hemisphere): the one in progress or the next; "next" skips a current one
  (t, today) => {
    const x =
      /\b(?:(?:early|late) )?(?:(this|next|the) )?(spring|summer|fall|autumn|winter)\b/.exec(t);
    if (!x) return null;
    const startMonth = { spring: 3, summer: 6, fall: 9, autumn: 9, winter: 12 }[x[2]!]!;
    const season = (y: number): Period => {
      const start: Day = { y, m: startMonth, d: 1 };
      const endMonth = addMonths(start, 2);
      const end: Day = { y: endMonth.y, m: endMonth.m, d: daysInMonth(endMonth.y, endMonth.m) };
      return { start, end, precision: "quarter" };
    };
    // Winter starts in December: in January it's still last year's winter.
    let p = season(today.y - 1);
    while (cmp(p.end, today) < 0) p = season(p.start.y + 1);
    if (x[1] === "next" && cmp(p.start, today) <= 0) p = season(p.start.y + 1);
    return p;
  },
  // this/next Friday, Friday
  (t, today) => {
    const x = new RegExp(`\\b(?:(this|next|coming|on|by) )?${WEEKDAY_RE}\\b`).exec(t);
    if (!x) return null;
    const target = WEEKDAYS[x[2]!]!;
    const wd = weekday(today);
    if (x[1] === "next") {
      const monday = mondayOf(addDays(today, 7));
      return dayPeriod(addDays(monday, (target + 6) % 7));
    }
    if (x[1] === "this") {
      const candidate = addDays(mondayOf(today), (target + 6) % 7);
      if (cmp(candidate, today) >= 0) return dayPeriod(candidate);
    }
    const ahead = (target - wd + 7) % 7 || 7;
    return dayPeriod(addDays(today, ahead));
  },
  // early March, end of March 2027, in March ("may" needs a preposition: it's also a verb)
  (t, today) => {
    const x = new RegExp(
      `\\b(?:(in|by|until|till|before|after|around|during|${PART.slice(1, -1)}) )?${MONTH_RE}\\b(?: (\\d{4}))?`,
    ).exec(t);
    if (!x) return null;
    const word = x[2]!;
    if (word === "may" && !MAY_PREFIXES.has(x[1] ?? "")) return null;
    if (word === "mar" && !x[1] && !x[3]) return null;
    const m = MONTHS[word]!;
    const y = x[3] ? Number(x[3]) : yearForMonth(today, m);
    const part = [
      "early",
      "mid",
      "middle of",
      "late",
      "end of",
      "beginning of",
      "start of",
    ].includes(x[1] ?? "")
      ? x[1]
      : undefined;
    return monthPeriod(y, m, part);
  },
  // the 15th
  (t, today) => {
    const x = /\b(?:the )(\d{1,2})(?:st|nd|rd|th)\b/.exec(t);
    if (!x) return null;
    const d = Number(x[1]);
    for (let i = 0; i < 3; i++) {
      const month = addMonths({ ...today, d: 1 }, i);
      const day = validDay(month.y, month.m, d);
      if (day && cmp(day, today) > 0) return dayPeriod(day);
    }
    return null;
  },
];

/** The normalised form of a date phrase (also used to check a phrase is in the source text). */
export function normalizePhrase(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/\b(a|one) fortnight\b/g, "two weeks")
    .replace(/\bfortnight\b/g, "two weeks")
    .replace(/[’`]/g, "'")
    .replace(/([a-z])-([a-z])/g, "$1 $2")
    .replace(/[^a-z0-9/.'\- ]+/g, " ")
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolves the words of a date ("by Friday", "after budget in March", "Q2", "2026-12-03") against
 * the message's date in `timeZone`. Returns null when the phrase names no date we understand.
 */
export function resolveWhen(
  phrase: string | null | undefined,
  messageDate: Date,
  timeZone: string,
): ResolvedWhen | null {
  if (!phrase) return null;
  const text = normalizePhrase(phrase).slice(0, 200);
  if (!text) return null;
  const today = localDay(messageDate, safeTimeZone(timeZone));
  let found: Period | null = null;
  for (const match of MATCHERS) {
    found = match(text, today);
    if (found) break;
  }
  if (!found) return null;
  // "after March", "once Q2 is over": the period that follows. "before Friday": the day before.
  const fixed = /\b(day after tomorrow|week after next|after the holidays|after new year)/;
  if (/\b(after|once|following|beyond)\b/.test(text) && !fixed.test(text)) {
    found = after(found);
  } else if (/\bbefore\b/.test(text) && !/\bbefore the weekend\b/.test(text)) {
    found = dayPeriod(addDays(found.start, -1));
  }
  return { start: iso(found.start), end: iso(found.end), precision: found.precision };
}

// ------------------------------------------------------------------ due dates

/** Whose commitment it is decides when the task is due. */
export type PromiseType = "our_promise" | "their_request" | "their_promise";

/** Local hour a "start of period" task is due (spec: "next week" → next Monday 10:00). */
export const FOLLOW_UP_HOUR = 10;
/** Local hour that counts as the end of a business day. */
export const END_OF_DAY_HOUR = 17;
/** No date given: due this many business days after the message. */
export const DEFAULT_BUSINESS_DAYS = 2;
/** A due date is never later than this many months after the message. */
export const PROMISE_HORIZON_MONTHS = 18;
/** A message date older than this (or in the future) isn't trusted as the anchor. */
export const MAX_MESSAGE_AGE_DAYS = 7;
/** Clock skew allowed before a message date counts as "in the future". */
const FUTURE_SKEW_MS = 5 * 60_000;

/**
 * The date relative phrases are read against: the message's own date, unless `now` is given and
 * that date is more than 7 days old or in the future (a forged or broken Date header) — then now.
 */
export function anchorMessageDate(messageDate: Date, now?: Date): Date {
  if (!now) return messageDate;
  const t = messageDate.getTime();
  if (
    Number.isNaN(t) ||
    t > now.getTime() + FUTURE_SKEW_MS ||
    t < now.getTime() - MAX_MESSAGE_AGE_DAYS * 86_400_000
  ) {
    return now;
  }
  return messageDate;
}

export interface PromiseDue {
  dueAt: Date;
  /** The words named no date we understand: dueAt is the +2 business days default. */
  dueDateMissing: boolean;
}

/**
 * When the task for a promise is due:
 * - our promise: end of that business day (a weekend day rolls back to Friday, so the promise is
 *   kept); a week/month/quarter → its first business day at 10:00 ("next week" → Monday 10:00).
 * - their request ("try me in March"): the first business day of that period at 10:00 (a
 *   weekend day rolls forward: nobody is contacted on a Saturday).
 * - their promise ("I'll get back to you next week"): the business day after their period ends,
 *   at 10:00 — the nudge if nothing arrived.
 * - no date: +2 business days (end of day for our promises, 10:00 otherwise), flagged.
 * Never before the message: anything in the past moves to the next business day. Never more than
 * 18 months after it: a later date becomes the last business day of that horizon.
 */
export function promiseDueAt(
  type: PromiseType,
  when: ResolvedWhen | null,
  messageDate: Date,
  timeZone: string,
): PromiseDue {
  const tz = safeTimeZone(timeZone);
  const today = localDay(messageDate, tz);
  const hourFor = (precise: boolean) =>
    type === "our_promise" && precise ? END_OF_DAY_HOUR : FOLLOW_UP_HOUR;

  let day: Day;
  let hour: number;
  let missing = false;
  if (!when) {
    day = addBusinessDays(today, DEFAULT_BUSINESS_DAYS);
    hour = type === "our_promise" ? END_OF_DAY_HOUR : FOLLOW_UP_HOUR;
    missing = true;
  } else if (type === "their_promise") {
    day = addBusinessDays(parseIso(when.end), 1);
    hour = FOLLOW_UP_HOUR;
  } else if (type === "our_promise" && when.precision === "day") {
    day = businessDayOnOrBefore(parseIso(when.start));
    hour = hourFor(true);
  } else {
    day = businessDayOnOrAfter(parseIso(when.start));
    hour = hourFor(false);
  }

  const horizon = businessDayOnOrBefore(addMonths(today, PROMISE_HORIZON_MONTHS));
  if (cmp(day, horizon) > 0) day = horizon;

  let dueAt = zonedTime(iso(day), hour, 0, tz);
  if (dueAt.getTime() <= messageDate.getTime()) {
    day = addBusinessDays(today, 1);
    dueAt = zonedTime(iso(day), hour, 0, tz);
  }
  return { dueAt, dueDateMissing: missing };
}
