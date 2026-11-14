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

/** Local weekday (ISO) and hour for an instant in a given IANA time zone. */
export function localDayAndHour(at: Date, timeZone: string): { day: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(at);

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
