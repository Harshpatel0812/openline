/** Company match key (PRD §2): lower-case host, no scheme, `www.`, path, query or port. */
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let v = value.trim().toLowerCase();
  if (!v || v.length > 2048) return null;
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  v = v.replace(/^[^@/]*@/, ""); // user:pass@
  v = v.split(/[/?#]/, 1)[0]!;
  v = v.replace(/:\d+$/, "").replace(/\.$/, "");
  v = v.replace(/^www\d?\./, "");
  return DOMAIN_RE.test(v) ? v : null;
}

/** Case- and space-insensitive name key for Pipedrive organizations without a website field. */
export function nameKey(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}
