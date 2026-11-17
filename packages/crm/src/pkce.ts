import { createHash, randomBytes } from "node:crypto";

/** RFC 7636 S256 pair. The verifier travels inside the signed (and encrypted) OAuth state. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
