import type { Jurisdiction } from "./consent";

/** EU/EEA member states (GDPR applies). */
const EEA = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "IS",
  "LI",
  "NO",
]);

/**
 * Which email law applies to a contact. Uses the contact's country when known; otherwise falls back
 * to the email's country-code domain (.ca, .de, ...); otherwise US (CAN-SPAM).
 * When in doubt between rules, we pick the STRICTER one only when there is a signal for it.
 */
export function jurisdictionFor(country: string | null | undefined, email: string): Jurisdiction {
  const code = country?.trim().toUpperCase();
  if (code) {
    if (code === "CA") return "CA";
    if (code === "US") return "US";
    if (EEA.has(code) || code === "GB" || code === "UK") return "EU";
    return "OTHER";
  }
  const tld = email.toLowerCase().split(".").pop() ?? "";
  if (tld === "ca") return "CA";
  if (tld === "uk" || EEA.has(tld.toUpperCase())) return "EU";
  return "US";
}
