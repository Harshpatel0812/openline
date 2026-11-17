/**
 * Client-side rate limiting (PRD §5 "Rate limits"). HubSpot: 110 requests / 10 s per installed
 * account, shared with the customer's other apps — we use at most half; search 5 req/s — we use
 * 2. Pipedrive: a per-2-second burst limit read from x-ratelimit-* headers, plus a company-wide
 * daily token budget, of which we spend at most our per-connection cap.
 */

export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
    now = Date.now(),
  ) {
    this.tokens = capacity;
    this.updatedAt = now;
  }

  /** Takes one token; returns how long to wait first (0 = go now). */
  take(now = Date.now()): number {
    const elapsed = Math.max(0, now - this.updatedAt);
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.capacity) / this.windowMs);
    this.updatedAt = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    const wait = Math.ceil(((1 - this.tokens) * this.windowMs) / this.capacity);
    this.tokens -= 1;
    return wait;
  }

  /** The server says only `remaining` are left in the window: never assume more. */
  clamp(remaining: number): void {
    if (Number.isFinite(remaining)) this.tokens = Math.min(this.tokens, Math.max(remaining, 0));
  }
}

export const HUBSPOT_LIMITS = {
  /** Half of 110 / 10 s. */
  general: { capacity: 55, windowMs: 10_000 },
  /** Below the 5 req/s search limit. */
  search: { capacity: 2, windowMs: 1_000 },
  /** Slow down when the account (all apps) has fewer than this left in the window. */
  remainingFloor: 10,
} as const;

/** Pipedrive token cost per request kind (API v2 list 10, update 10, search 40). */
export const PIPEDRIVE_TOKEN_COST = {
  list: 10,
  get: 2,
  create: 10,
  update: 10,
  search: 40,
  note: 10,
  meta: 10,
} as const;
export type PipedriveCostKind = keyof typeof PIPEDRIVE_TOKEN_COST;

/** Our own daily token spend for one Pipedrive connection (UTC day). */
export class DailyBudget {
  constructor(
    public day: string,
    public spent: number,
    public readonly cap: number,
  ) {}

  static today(now: Date): string {
    return now.toISOString().slice(0, 10);
  }

  /** Rolls over at UTC midnight. */
  roll(now: Date): void {
    const today = DailyBudget.today(now);
    if (today !== this.day) {
      this.day = today;
      this.spent = 0;
    }
  }

  canSpend(cost: number): boolean {
    return this.spent + cost <= this.cap;
  }

  spend(cost: number): void {
    this.spent += cost;
  }

  /** Next UTC midnight: when a budget pause ends. */
  static resetAt(now: Date): Date {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return d;
  }
}
