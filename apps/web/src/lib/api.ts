/**
 * Typed fetch wrapper for the Openline API. The web app calls `/api/v1/...` on its own origin;
 * Next.js rewrites `/api/*` to the API (see next.config.mjs).
 */

export interface ApiErrorDetail {
  path: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

export interface ApiOptions {
  method?: Method;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** Redirect to /login on 401. Defaults to true on /app pages. */
  redirectOn401?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Builds a safe /login URL that returns the user to the current page. */
export function loginUrl(next?: string): string {
  const target =
    next ??
    (typeof window === "undefined" ? "/app" : window.location.pathname + window.location.search);
  return `/login?next=${encodeURIComponent(target)}`;
}

/** Only allow same-origin relative paths as redirect targets (no open redirects). */
export function safeNext(next: string | null | undefined, fallback = "/app/contacts"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return fallback;
  }
  return next;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  const qs = params.toString();
  const url = `/api/v1${path}${qs ? `?${qs}` : ""}`;

  const headers: Record<string, string> = { accept: "application/json" };
  if (method !== "GET") headers["x-openline-csrf"] = "1";
  if (options.body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      credentials: "include",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "network_error", "Can't reach Openline. Check your connection.");
  }

  const text = await response.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }

  if (!response.ok) {
    const code = isRecord(data) && typeof data.code === "string" ? data.code : "http_error";
    const message =
      isRecord(data) && typeof data.message === "string"
        ? data.message
        : `Something went wrong (HTTP ${response.status}).`;
    const details = isRecord(data) ? data.details : undefined;

    const redirect =
      options.redirectOn401 ??
      (typeof window !== "undefined" && window.location.pathname.startsWith("/app"));
    if (response.status === 401 && redirect && typeof window !== "undefined") {
      window.location.assign(loginUrl());
    }
    throw new ApiError(response.status, code, message, details);
  }

  return data as T;
}

/** Maps API validation `details` (`[{ path, message }]`) to `{ field: message }`. */
export function fieldErrorsFrom(err: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!(err instanceof ApiError) || !Array.isArray(err.details)) return out;
  for (const item of err.details as unknown[]) {
    if (!isRecord(item) || typeof item.message !== "string") continue;
    const rawPath = item.path;
    const key = Array.isArray(rawPath)
      ? rawPath.map(String).join(".")
      : typeof rawPath === "string"
        ? rawPath
        : "";
    if (key && !(key in out)) out[key] = item.message;
  }
  return out;
}

/** Human-readable message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return "Too many attempts. Please wait a minute and try again.";
    return err.message;
  }
  return "Something went wrong. Please try again.";
}
