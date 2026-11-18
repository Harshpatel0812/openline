/**
 * The one HTTP path to a CRM. Fixed hosts only (SSRF guard: no redirects followed, origins
 * checked), timeouts, bounded in-call waits for 429 and short retries for 5xx / network, call and
 * token metering. Never logs or returns response text: CRM responses are untrusted and may hold
 * personal data; errors carry our own messages and the status only.
 */
import { CrmError } from "./errors";
import { retryAfterMs } from "./retry";
import type { TokenBucket } from "./limiter";
import type { CallMeter, SpendHook } from "./types";

export interface HttpContext {
  /** True when a URL may be called (fixed hosts from config, validated Pipedrive domains). */
  allow: (url: URL) => boolean;
  meter: CallMeter;
  spend?: SpendHook;
  /** Per-request timeout (default 20 s). */
  timeoutMs?: number;
  /** Longest wait we sit out inside one call (429 / limiter); longer → CrmError rate_limited. */
  maxWaitMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface HttpRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  /** Pipedrive token cost of this request (0 elsewhere). */
  cost?: number;
  limiter?: TokenBucket;
  /** Response headers hook (rate-limit headers). */
  onHeaders?: (headers: Headers) => void;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

const MAX_BODY = 10 * 1024 * 1024;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function statusError(status: number, retry?: number): CrmError {
  if (status === 401) return new CrmError("auth", "The CRM rejected our access token", { status });
  if (status === 403)
    return new CrmError("scope", "The CRM refused this request (missing permission)", { status });
  if (status === 404) return new CrmError("not_found", "The CRM record was not found", { status });
  if (status === 429) {
    return new CrmError("rate_limited", "The CRM asked us to slow down", {
      status,
      retryAfterMs: retry,
    });
  }
  if (status >= 500)
    return new CrmError("transient", "The CRM had a temporary problem", { status });
  return new CrmError("validation", "The CRM rejected this request", { status });
}

export async function crmRequest(ctx: HttpContext, req: HttpRequest): Promise<HttpResponse> {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    throw new CrmError("forbidden_host", "Invalid CRM URL");
  }
  if (!ctx.allow(url)) throw new CrmError("forbidden_host", "That CRM host is not allowed");

  const doFetch = ctx.fetch ?? fetch;
  const sleep = ctx.sleep ?? defaultSleep;
  const maxWait = ctx.maxWaitMs ?? 15_000;
  const headers: Record<string, string> = { accept: "application/json", ...req.headers };
  let body: string | undefined;
  if (req.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(req.json);
  } else if (req.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(req.form).toString();
  }

  for (let attempt = 0; ; attempt += 1) {
    if (req.limiter) {
      const wait = req.limiter.take();
      if (wait > maxWait) {
        throw new CrmError("rate_limited", "Our share of the CRM's rate limit is used up", {
          retryAfterMs: wait,
        });
      }
      if (wait > 0) await sleep(wait);
    }
    // Budget before the call: a request we can't afford is never sent.
    if (req.cost) ctx.spend?.(req.cost);

    let res: Response;
    try {
      ctx.meter.calls += 1;
      if (req.cost) ctx.meter.tokens += req.cost;
      res = await doFetch(url, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(ctx.timeoutMs ?? 20_000),
      });
    } catch {
      if (attempt < 2) {
        await sleep(attempt === 0 ? 250 : 1000);
        continue;
      }
      throw new CrmError("transient", "We couldn't reach the CRM");
    }
    req.onHeaders?.(res.headers);

    if (res.status >= 300 && res.status < 400) {
      // Redirects are never followed: a fixed host must answer itself.
      throw new CrmError("forbidden_host", "The CRM answered with a redirect", {
        status: res.status,
      });
    }
    if (res.status === 429) {
      const retry = retryAfterMs(res.headers.get("retry-after")) ?? 10_000;
      await res.body?.cancel().catch(() => undefined);
      if (attempt < 2 && retry <= maxWait) {
        await sleep(retry);
        continue;
      }
      throw statusError(429, retry);
    }
    if (res.status >= 500) {
      await res.body?.cancel().catch(() => undefined);
      if (attempt < 2) {
        await sleep(attempt === 0 ? 250 : 1000);
        continue;
      }
      throw statusError(res.status);
    }
    const text = await res.text();
    if (text.length > MAX_BODY) throw new CrmError("transient", "The CRM response was too large");
    if (res.status >= 400) {
      let code: string | undefined;
      try {
        const parsed = JSON.parse(text) as { error?: unknown; category?: unknown };
        // OAuth errors: only well-known machine codes, never free text.
        const e = typeof parsed.error === "string" ? parsed.error : undefined;
        if (e && /^[a-z_]{1,40}$/.test(e)) code = e;
        if (
          !code &&
          typeof parsed.category === "string" &&
          /^[A-Z_]{1,40}$/.test(parsed.category)
        ) {
          code = parsed.category.toLowerCase();
        }
      } catch {
        // not JSON: ignore the text
      }
      const err = statusError(res.status);
      if (code === "invalid_grant") {
        throw new CrmError("auth", "The CRM connection was revoked or expired", {
          status: res.status,
          code,
        });
      }
      throw new CrmError(err.kind, err.message, { status: res.status, code });
    }
    if (!text) return { status: res.status, body: null };
    try {
      return { status: res.status, body: JSON.parse(text) as unknown };
    } catch {
      throw new CrmError("transient", "The CRM sent a response we couldn't read");
    }
  }
}

/** Narrowing helpers for untrusted JSON. */
export function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
export function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}
