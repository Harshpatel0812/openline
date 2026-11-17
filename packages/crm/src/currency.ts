/**
 * Money conversion between the CRM's decimal strings and Openline's integer minor units (OL-E7).
 * ISO 4217 minor digits; string arithmetic only (never floats); extra precision rounds half-up.
 * No FX conversion, ever.
 */
const ZERO_DIGITS = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "UYI",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);
const THREE_DIGITS = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

/** The deals.amount_minor CHECK cap. */
export const MAX_AMOUNT_MINOR = 999_999_999_999;

export function minorDigits(currency: string): number {
  const c = currency.toUpperCase();
  if (ZERO_DIGITS.has(c)) return 0;
  if (THREE_DIGITS.has(c)) return 3;
  return 2;
}

export function isCurrencyCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

/**
 * "1234.567" USD → { minor: 123457, rounded: true }. Null for invalid input or out of range.
 */
export function decimalToMinor(
  decimal: string,
  currency: string,
): { minor: number; rounded: boolean } | null {
  const m = /^(\d{1,15})(?:\.(\d{1,12}))?$/.exec(decimal.trim());
  if (!m) return null;
  const digits = minorDigits(currency);
  const whole = m[1]!;
  const frac = m[2] ?? "";
  const kept = frac.slice(0, digits).padEnd(digits, "0");
  const rest = frac.slice(digits);
  let minor = BigInt(whole + kept);
  const rounded = /[1-9]/.test(rest);
  if (rest.length > 0 && rest[0]! >= "5") minor += 1n;
  if (minor > BigInt(MAX_AMOUNT_MINOR)) return null;
  return { minor: Number(minor), rounded };
}

/** 123457 USD → "1234.57"; 5000 JPY → "5000"; 1234 KWD → "1.234". */
export function minorToDecimal(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error("Invalid amount");
  const digits = minorDigits(currency);
  if (digits === 0) return String(minor);
  const s = String(minor).padStart(digits + 1, "0");
  return `${s.slice(0, -digits)}.${s.slice(-digits)}`;
}
