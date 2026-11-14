import { HttpStatus } from "@nestjs/common";
import { ApiException } from "./http";

/**
 * Fixed-window in-memory rate limiter. Good enough for one API instance; moves to Redis
 * when we run more than one (tracked in OL-E1 follow-ups).
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Throws 429 when the key has used up its allowance. */
  consume(key: string, now = Date.now()): void {
    if (this.hits.size > 50_000) this.sweep(now);
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    entry.count += 1;
    if (entry.count > this.limit) {
      const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
      throw new ApiException(
        HttpStatus.TOO_MANY_REQUESTS,
        "rate_limited",
        `Too many attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).`,
        { retryAfterSec },
      );
    }
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}
