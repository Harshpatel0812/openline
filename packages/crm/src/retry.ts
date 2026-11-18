/** Retry schedules (PRD §5 "Retries"). */

const MINUTE = 60_000;

/** Run-level failures (5xx, network): 1, 5, 30 minutes, then hourly; ±10 % jitter. */
export function runBackoffMs(failures: number, random: () => number = Math.random): number {
  const steps = [1, 5, 30];
  const base = (failures >= 1 && failures <= steps.length ? steps[failures - 1]! : 60) * MINUTE;
  return Math.round(base * (0.9 + random() * 0.2));
}

/**
 * Per-record errors retry at 5 min, 30 min and 2 h; after the third retry they stay "needs
 * attention" (null) until retried by an admin, fixed or dismissed.
 */
export function recordRetryAt(attempts: number, now: Date): Date | null {
  const steps = [5, 30, 120];
  const step = steps[attempts - 1];
  return step === undefined ? null : new Date(now.getTime() + step * MINUTE);
}

/** Wait from a Retry-After header (seconds or HTTP date), bounded to [1 s, 1 day]. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const secs = Number(header);
  let ms: number;
  if (Number.isFinite(secs)) ms = secs * 1000;
  else {
    const at = Date.parse(header);
    if (Number.isNaN(at)) return null;
    ms = at - now;
  }
  return Math.min(Math.max(ms, 1000), 86_400_000);
}
