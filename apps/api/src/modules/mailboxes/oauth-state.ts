import { createHmac, timingSafeEqual } from "node:crypto";

/** Signed OAuth `state` binding the Gmail connection to one workspace + user for 10 minutes. */
export interface OAuthState {
  w: string;
  u: string;
  exp: number;
}

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// A key derived from UNSUBSCRIBE_SECRET, so a state can never be confused with an unsubscribe token.
function key(secret: string): Buffer {
  return createHmac("sha256", secret).update("openline.google-oauth-state.v1").digest();
}

function sign(payload: string, secret: string): Buffer {
  return createHmac("sha256", key(secret)).update(payload).digest();
}

export function createOAuthState(
  claims: { workspaceId: string; userId: string },
  secret: string,
  now = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({ w: claims.workspaceId, u: claims.userId, exp: now + OAUTH_STATE_TTL_MS }),
  ).toString("base64url");
  return `${payload}.${sign(payload, secret).toString("base64url")}`;
}

export type StateCheck = { ok: true; state: OAuthState } | { ok: false; error: string };

export function verifyOAuthState(token: string, secret: string, now = Date.now()): StateCheck {
  const [payload, sig] = token.split(".");
  if (!payload || !sig || token.length > 500) return { ok: false, error: "state_invalid" };
  const expected = sign(payload, secret);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, error: "state_invalid" };
  }
  try {
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
    if (typeof state.w !== "string" || typeof state.u !== "string" || typeof state.exp !== "number")
      return { ok: false, error: "state_invalid" };
    if (state.exp <= now) return { ok: false, error: "state_expired" };
    return { ok: true, state };
  } catch {
    return { ok: false, error: "state_invalid" };
  }
}
