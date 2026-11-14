/**
 * Unsubscribe tokens: stateless, signed, unguessable. Put in every outreach email's footer link
 * and List-Unsubscribe header. Format: <payloadB64url>.<hmacB64url>, payload = {w, c}.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface UnsubscribeClaims {
  workspaceId: string;
  contactId: string;
}

function sign(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(`unsubscribe.${payload}`).digest().subarray(0, 16);
}

export function createUnsubscribeToken(claims: UnsubscribeClaims, secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({ w: claims.workspaceId, c: claims.contactId }),
  ).toString("base64url");
  return `${payload}.${sign(payload, secret).toString("base64url")}`;
}

export function verifyUnsubscribeToken(token: string, secret: string): UnsubscribeClaims | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig || token.length > 400) return null;
  const expected = sign(payload, secret);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { w, c } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      w?: unknown;
      c?: unknown;
    };
    const uuid = /^[0-9a-f-]{36}$/i;
    if (typeof w !== "string" || typeof c !== "string" || !uuid.test(w) || !uuid.test(c))
      return null;
    return { workspaceId: w, contactId: c };
  } catch {
    return null;
  }
}
