/**
 * Suppression list check, run before EVERY send.
 * Entries are either a full email ("jane@acme.com") or a whole domain ("@acme.com").
 */
export function isSuppressed(email: string, suppressions: ReadonlySet<string>): boolean {
  const normalised = email.trim().toLowerCase();
  const at = normalised.lastIndexOf("@");
  if (at < 1) return true; // malformed address: never send
  const domain = normalised.slice(at);
  return suppressions.has(normalised) || suppressions.has(domain);
}
