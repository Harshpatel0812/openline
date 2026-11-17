/**
 * Errors from a CRM call, by what the engine should do about them. Messages are ours (never CRM
 * response text, which is untrusted and may hold personal data).
 */
export type CrmErrorKind =
  /** 401 / invalid_grant / revoked: one refresh, then reconnect needed. */
  | "auth"
  /** Missing scope (403). */
  | "scope"
  /** 429 or our own limiter: wait until retryAfterMs. */
  | "rate_limited"
  /** Our per-connection daily budget (Pipedrive) is spent. */
  | "budget"
  /** 5xx, network, timeout. */
  | "transient"
  /** 400/422 for one record. */
  | "validation"
  | "not_found"
  /** A host or domain outside the allowlist (SSRF guard), or a config refusal. */
  | "forbidden_host";

export class CrmError extends Error {
  constructor(
    readonly kind: CrmErrorKind,
    message: string,
    readonly options: { status?: number; retryAfterMs?: number; code?: string } = {},
  ) {
    super(message);
    this.name = "CrmError";
  }

  get status(): number | undefined {
    return this.options.status;
  }
  get retryAfterMs(): number | undefined {
    return this.options.retryAfterMs;
  }
}
