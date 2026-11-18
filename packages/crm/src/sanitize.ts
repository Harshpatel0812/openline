/**
 * Untrusted CRM input (PRD "Untrusted CRM data"): every pulled string is HTML-stripped, control
 * characters removed, NFC-normalized, whitespace collapsed, trimmed and cut to Openline's limits.
 * Numbers and dates are parsed strictly. Raw payloads are never stored.
 */
import { ContactInputSchema } from "@openline/shared";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

/** Plain text from untrusted CRM text, at most `max` characters (code points); null if empty. */
export function cleanText(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return null;
  }
  let text = String(value);
  // Bound the work before any regex runs (a CRM value can be megabytes).
  if (text.length > max * 20 + 10_000) text = text.slice(0, max * 20 + 10_000);
  text = text
    // Whole script / style blocks go, content included.
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(script|style)\b[\s\S]*$/gi, " ")
    // Then every tag.
    .replace(/<\/?[a-zA-Z!][^>]*>/g, " ")
    .replace(/&(#\d{1,6}|#x[0-9a-f]{1,6}|[a-z]{2,6}|#39);/gi, (m, e: string) => {
      const key = e.toLowerCase();
      if (ENTITIES[key] !== undefined) return ENTITIES[key];
      const code = key.startsWith("#x")
        ? Number.parseInt(key.slice(2), 16)
        : key.startsWith("#")
          ? Number.parseInt(key.slice(1), 10)
          : NaN;
      return Number.isFinite(code) && code > 31 && code < 0x110000 && code !== 127
        ? String.fromCodePoint(code)
        : m;
    })
    // Decoded markup is still not ours to render: drop anything tag-like again.
    .replace(/<\/?[a-zA-Z!][^>]*>/g, " ")
    // eslint-disable-next-line no-control-regex -- stripping control characters on purpose
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, " ")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
  const cut = [...text].slice(0, max).join("").trim();
  return cut === "" ? null : cut;
}

/** A valid, lower-cased email (the shared Zod rule), or null. */
export function cleanEmail(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 320) return null;
  const parsed = ContactInputSchema.shape.email.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A decimal number string like "1234.50"; null for anything else (no exponents, no commas). */
export function cleanDecimal(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    value = String(value);
  }
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!/^\d{1,15}(\.\d{1,12})?$/.test(v)) return null;
  return v.replace(/^0+(?=\d)/, "");
}

/** YYYY-MM-DD from a date or ISO date-time string / epoch milliseconds; null if invalid. */
export function cleanDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || (typeof value === "string" && /^\d{10,14}$/.test(value))) {
    const d = new Date(Number(value));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(value.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== `${m[1]}-${m[2]}-${m[3]}`) {
    return null;
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** A timestamp from an ISO string or epoch ms; null if invalid. */
export function cleanTimestamp(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d =
    typeof value === "number" || (typeof value === "string" && /^\d{10,14}$/.test(value))
      ? new Date(Number(value))
      : typeof value === "string"
        ? new Date(value)
        : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

/** An external id we accept (also the DB CHECK): 1–64 of [A-Za-z0-9_:.-]. */
export function cleanExternalId(value: unknown): string | null {
  const v = typeof value === "number" ? String(value) : value;
  return typeof v === "string" && /^[A-Za-z0-9_:.-]{1,64}$/.test(v) ? v : null;
}

export function cleanBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return null;
}
