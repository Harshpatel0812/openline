/**
 * Quiet hours: only contact people during business hours in THEIR time zone.
 * Default: Monday–Friday, 9:00–18:00 local time.
 */
export interface SendWindow {
  /** ISO weekdays allowed: 1 = Monday ... 7 = Sunday. */
  days: number[];
  /** First allowed hour (inclusive), 0–23. */
  startHour: number;
  /** Last allowed hour (exclusive), 1–24. */
  endHour: number;
}

export const DEFAULT_SEND_WINDOW: SendWindow = {
  days: [1, 2, 3, 4, 5],
  startHour: 9,
  endHour: 18,
};

const WEEKDAY_TO_ISO: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "numeric",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Local weekday (ISO) and hour for an instant in a given IANA time zone. */
export function localDayAndHour(at: Date, timeZone: string): { day: number; hour: number } {
  const parts = formatterFor(timeZone).formatToParts(at);

  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const day = WEEKDAY_TO_ISO[weekday];

  if (day === undefined || Number.isNaN(hour)) {
    throw new Error(`Could not resolve local time for time zone "${timeZone}"`);
  }
  return { day, hour };
}

/** True when `at` falls inside the contact's allowed send window. */
export function isWithinSendWindow(
  at: Date,
  timeZone: string,
  window: SendWindow = DEFAULT_SEND_WINDOW,
): boolean {
  const { day, hour } = localDayAndHour(at, timeZone);
  return window.days.includes(day) && hour >= window.startHour && hour < window.endHour;
}

/**
 * The earliest instant at or after `from` that is inside the send window for `timeZone`,
 * at the top of a local hour when it has to move. Walks in 15-minute steps, because some zones
 * are offset by :30 or :45 (St John's, India, Nepal); DST-safe; a valid window always has a slot
 * within 8 days.
 */
export function nextSendWindowStart(
  from: Date,
  timeZone: string,
  window: SendWindow = DEFAULT_SEND_WINDOW,
): Date {
  if (isWithinSendWindow(from, timeZone, window)) return from;
  const stepMs = 15 * 60 * 1000;
  let t = Math.ceil(from.getTime() / stepMs) * stepMs;
  for (let i = 0; i < 4 * 24 * 8; i += 1, t += stepMs) {
    const candidate = new Date(t);
    if (isWithinSendWindow(candidate, timeZone, window)) return candidate;
  }
  throw new Error("Send window has no allowed hours");
}

/** Validates a window coming from user input. */
export function isValidSendWindow(window: SendWindow): boolean {
  return (
    window.days.length > 0 &&
    window.days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7) &&
    Number.isInteger(window.startHour) &&
    Number.isInteger(window.endHour) &&
    window.startHour >= 0 &&
    window.endHour <= 24 &&
    window.startHour < window.endHour
  );
}
