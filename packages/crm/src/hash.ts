import { createHash } from "node:crypto";

/**
 * The shadow hash of a field's canonical value (16 hex). Shadows hold hashes, never values, so the
 * log can say which field changed but not from what (ADR 0006).
 */
export function fieldHash(field: string, value: string | null): string {
  return createHash("sha256")
    .update(JSON.stringify([field, value]))
    .digest("hex")
    .slice(0, 16);
}
