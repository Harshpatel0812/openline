import { createHmac, timingSafeEqual } from "node:crypto";
import { CRM_PROVIDERS, type CrmProvider } from "@openline/shared";

/**
 * Signed OAuth `state` for CRM connections: binds the callback to one workspace + user + provider
 * for 10 minutes. Its own derivation label, so it can never be swapped with a Google mailbox state
 * (or an unsubscribe token) signed from the same secret. `v` is the PKCE verifier, sealed
 * (AES-256-GCM) — the state travels through the browser and the CRM.
 */
export interface CrmOAuthState {
  w: string;
  u: string;
  p: CrmProvider;
  exp: number;
  v?: string;
}

export const CRM_STATE_TTL_MS = 10 * 60 * 1000;
const LABEL = "openline.crm-oauth-state.v1";

function key(secret: string): Buffer {
  return createHmac("sha256", secret).update(LABEL).digest();
}

function sign(payload: string, secret: string): Buffer {
  return createHmac("sha256", key(secret)).update(payload).digest();
}

export function createCrmState(
  claims: { workspaceId: string; userId: string; provider: CrmProvider; sealedVerifier?: string },
  secret: string,
  now = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({
      w: claims.workspaceId,
      u: claims.userId,
      p: claims.provider,
      exp: now + CRM_STATE_TTL_MS,
      ...(claims.sealedVerifier ? { v: claims.sealedVerifier } : {}),
    }),
  ).toString("base64url");
  return `${payload}.${sign(payload, secret).toString("base64url")}`;
}

export type CrmStateCheck =
  { ok: true; state: CrmOAuthState } | { ok: false; error: "state_invalid" | "state_expired" };

export function verifyCrmState(token: string, secret: string, now = Date.now()): CrmStateCheck {
  if (token.length > 1500) return { ok: false, error: "state_invalid" };
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return { ok: false, error: "state_invalid" };
  const expected = sign(payload, secret);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, error: "state_invalid" };
  }
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as CrmOAuthState;
    if (
      typeof s.w !== "string" ||
      typeof s.u !== "string" ||
      typeof s.exp !== "number" ||
      !(CRM_PROVIDERS as readonly string[]).includes(s.p) ||
      (s.v !== undefined && typeof s.v !== "string")
    ) {
      return { ok: false, error: "state_invalid" };
    }
    if (s.exp <= now) return { ok: false, error: "state_expired" };
    return { ok: true, state: s };
  } catch {
    return { ok: false, error: "state_invalid" };
  }
}
