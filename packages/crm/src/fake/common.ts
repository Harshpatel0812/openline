/**
 * Shared pieces of the fake CRM servers (tests and e2e only; never reachable in production:
 * CRM_MODE=live refuses loopback URLs and production refuses every other mode).
 */
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface FakeRequestLog {
  provider: "hubspot" | "pipedrive";
  method: string;
  path: string;
  /** Request body as JSON or form fields (tests assert request shapes). */
  body: unknown;
  at: number;
}

export interface FakeKnobs {
  /** The next n API calls (not OAuth) answer 429 with Retry-After. */
  fail429: number;
  retryAfterSec: number;
  /** The next n API calls answer 503. */
  fail5xx: number;
  /** Delay every response. */
  latencyMs: number;
  /** Search / changed-since lists miss records modified within this window (indexing lag). */
  indexLagMs: number;
  /** Added to every timestamp the fake reports (the CRM's clock is off). */
  clockSkewMs: number;
  /** HubSpot search window cap (10,000 in the real API). */
  searchCap: number;
  /** Next authorize answers with ?error=… instead of a code. */
  authorizeError: string | null;
  /** HubSpot: grant the optional communication_preferences.write scope. */
  grantOptionalScopes: boolean;
  /** Pipedrive: Campaigns on (marketing_status can be set). */
  campaigns: boolean;
  /** Pipedrive: company-wide daily token budget (429 once spent). */
  dailyTokenBudget: number;
}

export const DEFAULT_KNOBS: FakeKnobs = {
  fail429: 0,
  retryAfterSec: 1,
  fail5xx: 0,
  latencyMs: 0,
  indexLagMs: 0,
  clockSkewMs: 0,
  searchCap: 10_000,
  authorizeError: null,
  grantOptionalScopes: true,
  campaigns: true,
  dailyTokenBudget: 1_000_000,
};

export interface OAuthGrant {
  clientId: string;
  redirectUri: string;
  challenge?: string;
  scopes: string[];
}

/** Codes, rotating refresh tokens and access tokens for one provider. */
export class FakeOAuth {
  codes = new Map<string, OAuthGrant>();
  refresh = new Map<string, { scopes: string[] }>();
  access = new Map<string, { scopes: string[]; expiresAt: number }>();
  revoked: string[] = [];

  issueCode(grant: OAuthGrant): string {
    const code = `code-${randomBytes(8).toString("hex")}`;
    this.codes.set(code, grant);
    return code;
  }

  /** authorization_code → tokens. Null if the code, redirect or PKCE verifier don't match. */
  redeem(code: string, redirectUri: string, verifier?: string) {
    const grant = this.codes.get(code);
    this.codes.delete(code);
    if (!grant || grant.redirectUri !== redirectUri) return null;
    if (grant.challenge) {
      if (!verifier) return null;
      const expected = createHash("sha256").update(verifier).digest("base64url");
      if (expected !== grant.challenge) return null;
    }
    return this.mint(grant.scopes);
  }

  /** Rotates: the old refresh token stops working. */
  rotate(refreshToken: string) {
    const r = this.refresh.get(refreshToken);
    if (!r) return null;
    this.refresh.delete(refreshToken);
    return this.mint(r.scopes);
  }

  mint(scopes: string[], ttlSec = 1800) {
    const accessToken = `at-${randomBytes(12).toString("hex")}`;
    const refreshToken = `rt-${randomBytes(12).toString("hex")}`;
    this.access.set(accessToken, { scopes, expiresAt: Date.now() + ttlSec * 1000 });
    this.refresh.set(refreshToken, { scopes });
    return { accessToken, refreshToken, scopes, ttlSec };
  }

  revoke(token: string): void {
    this.refresh.delete(token);
    this.access.clear();
    this.revoked.push(token);
  }

  bearer(req: IncomingMessage): { scopes: string[] } | null {
    const h = req.headers.authorization ?? "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    const a = this.access.get(token);
    return a && a.expiresAt > Date.now() ? a : null;
  }

  /** Every issued access token stops working (forces a refresh). */
  expireAll(): void {
    for (const a of this.access.values()) a.expiresAt = 0;
  }
}

export async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return null;
  const type = req.headers["content-type"] ?? "";
  if (type.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function send(
  res: ServerResponse,
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location });
  res.end();
}

export type Json = Record<string, unknown>;
