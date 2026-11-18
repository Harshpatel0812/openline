/** Pure rules: sanitizer, currency, domains, conflict matrix, retries, limiter, PKCE. */
import { describe, expect, it } from "vitest";
import { decideField, type FieldState } from "./conflict";
import { decimalToMinor, minorDigits, minorToDecimal } from "./currency";
import { nameKey, normalizeDomain } from "./domain";
import { fieldHash } from "./hash";
import { DailyBudget, TokenBucket } from "./limiter";
import { createPkcePair, pkceChallenge } from "./pkce";
import { recordRetryAt, retryAfterMs, runBackoffMs } from "./retry";
import { cleanDate, cleanDecimal, cleanEmail, cleanExternalId, cleanText } from "./sanitize";

describe("untrusted CRM text", () => {
  it("a pulled name with <script> and 5,000 characters becomes plain text cut to 120", () => {
    const name = `<script>alert('x')</script><b>Ana</b> ${"x".repeat(5000)}`;
    const out = cleanText(name, 120)!;
    expect(out).not.toMatch(/[<>]/);
    expect(out).not.toContain("alert");
    expect(out.startsWith("Ana x")).toBe(true);
    expect([...out].length).toBe(120);
  });

  it("strips control and bidi characters, decodes entities, normalizes NFC and trims", () => {
    expect(cleanText("  A\u0000B‮C​  ", 50)).toBe("A B C");
    expect(cleanText("Café", 50)).toBe("Café");
    expect(cleanText("Tom &amp; Jerry &lt;b&gt;x&lt;/b&gt;", 50)).toBe("Tom & Jerry x");
    expect(cleanText("<img src=x onerror=alert(1)>", 50)).toBeNull();
    expect(cleanText({ toString: () => "x" }, 50)).toBeNull();
    expect(cleanText(42, 50)).toBe("42");
  });

  it("emails use the shared schema; numbers and dates parse strictly", () => {
    expect(cleanEmail(" Ana@Acme.COM ")).toBe("ana@acme.com");
    expect(cleanEmail("not an email")).toBeNull();
    expect(cleanDecimal("1234.50")).toBe("1234.50");
    expect(cleanDecimal("1e5")).toBeNull();
    expect(cleanDecimal("1,000")).toBeNull();
    expect(cleanDecimal("-5")).toBeNull();
    expect(cleanDate("2026-02-30")).toBeNull();
    expect(cleanDate("2026-11-16T10:00:00.000Z")).toBe("2026-11-16");
    expect(cleanDate("1763251200000")).toBe("2025-11-16");
    expect(cleanExternalId("12345")).toBe("12345");
    expect(cleanExternalId("../etc")).toBeNull();
  });
});

describe("currency (ISO 4217 minor digits, string arithmetic, no FX)", () => {
  it.each([
    ["1234.56", "USD", 123456, false],
    ["1234.5", "USD", 123450, false],
    ["1234.565", "USD", 123457, true],
    ["1234.564", "USD", 123456, true],
    ["5000", "JPY", 5000, false],
    ["5000.5", "JPY", 5001, true],
    ["1.2345", "KWD", 1235, true],
    ["0.1", "EUR", 10, false],
  ])("%s %s → %i minor (rounded: %s)", (dec, cur, minor, rounded) => {
    expect(decimalToMinor(dec, cur)).toEqual({ minor, rounded });
  });

  it("round-trips minor units back to a decimal string", () => {
    expect(minorToDecimal(123456, "USD")).toBe("1234.56");
    expect(minorToDecimal(5, "USD")).toBe("0.05");
    expect(minorToDecimal(5000, "JPY")).toBe("5000");
    expect(minorToDecimal(1234, "KWD")).toBe("1.234");
    expect(minorDigits("BHD")).toBe(3);
  });

  it("refuses invalid or out-of-range amounts", () => {
    expect(decimalToMinor("abc", "USD")).toBeNull();
    expect(decimalToMinor("99999999999999", "USD")).toBeNull();
  });
});

describe("company domain normalization", () => {
  it.each([
    ["https://www.Acme.com/about?x=1", "acme.com"],
    ["ACME.COM:8443", "acme.com"],
    ["http://user:pw@shop.acme.co.uk/", "shop.acme.co.uk"],
    ["www2.acme.io.", "acme.io"],
    ["acme", null],
    ["javascript:alert(1)", null],
    ["", null],
  ])("%s → %s", (input, out) => {
    expect(normalizeDomain(input)).toBe(out);
  });

  it("name keys ignore case and spacing", () => {
    expect(nameKey("  Acme   Tools ")).toBe("acme tools");
  });
});

describe("per-field conflict rule", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 16, 10, 0, s));
  const base = (over: Partial<FieldState>): FieldState => ({
    shadow: "S",
    localHash: "S",
    remoteHash: "S",
    localEmpty: false,
    remoteEmpty: false,
    direction: "both",
    sourceOfTruth: "newest",
    localAt: at(0),
    remoteAt: at(0),
    ...over,
  });

  // here / there / both × source of truth
  it.each([
    ["unchanged", {}, "none", undefined],
    ["only Openline changed", { localHash: "L" }, "push", undefined],
    ["only the CRM changed", { remoteHash: "R" }, "pull", undefined],
    [
      "both, Openline newer",
      { localHash: "L", remoteHash: "R", localAt: at(9), remoteAt: at(1) },
      "push",
      "openline",
    ],
    [
      "both, CRM newer",
      { localHash: "L", remoteHash: "R", localAt: at(1), remoteAt: at(9) },
      "pull",
      "crm",
    ],
    [
      "both, tie → CRM",
      { localHash: "L", remoteHash: "R", localAt: at(5), remoteAt: at(5) },
      "pull",
      "crm",
    ],
    [
      "both, pinned to Openline",
      { localHash: "L", remoteHash: "R", sourceOfTruth: "openline", remoteAt: at(9) },
      "push",
      "openline",
    ],
    [
      "both, pinned to CRM",
      { localHash: "L", remoteHash: "R", sourceOfTruth: "crm", localAt: at(9) },
      "pull",
      "crm",
    ],
    ["both changed to the same value", { localHash: "X", remoteHash: "X" }, "adopt", undefined],
  ] as const)("%s", (_name, over, action, winner) => {
    const d = decideField(base(over as Partial<FieldState>));
    expect(d.action).toBe(action);
    expect(d.conflict?.winner).toBe(winner);
  });

  it("direction limits what flows", () => {
    expect(decideField(base({ localHash: "L", direction: "from_crm" })).action).toBe("none");
    expect(decideField(base({ remoteHash: "R", direction: "to_crm" })).action).toBe("none");
    expect(
      decideField(base({ localHash: "L", remoteHash: "R", direction: "from_crm", localAt: at(9) }))
        .action,
    ).toBe("pull");
    expect(decideField(base({ localHash: "L", remoteHash: "R", direction: "to_crm" })).action).toBe(
      "push",
    );
    expect(decideField(base({ localHash: "L", direction: "off" })).action).toBe("none");
  });

  it("first link: the CRM wins unless its value is empty or the field is pinned to Openline", () => {
    const first = { shadow: undefined, localHash: "L", remoteHash: "R" };
    expect(decideField(base(first)).action).toBe("pull");
    expect(decideField(base({ ...first, remoteEmpty: true })).action).toBe("push");
    expect(decideField(base({ ...first, sourceOfTruth: "openline" })).action).toBe("push");
  });

  it("echo suppression: after a write both sides hash to the shadow, so nothing is written again", () => {
    const value = "Ana";
    const h = fieldHash("firstName", value);
    expect(
      decideField(base({ shadow: h, localHash: h, remoteHash: fieldHash("firstName", value) }))
        .action,
    ).toBe("none");
    expect(fieldHash("firstName", "Ana")).not.toBe(fieldHash("lastName", "Ana"));
    expect(fieldHash("firstName", null)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("retry schedule", () => {
  it("run failures back off 1, 5, 30 minutes, then hourly (with jitter)", () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4, 9].map((n) => runBackoffMs(n, mid) / 60_000)).toEqual([1, 5, 30, 60, 60]);
    expect(runBackoffMs(1, () => 0)).toBe(54_000);
    expect(runBackoffMs(1, () => 1)).toBe(66_000);
  });

  it("record errors retry at 5 min, 30 min, 2 h, then need attention", () => {
    const now = new Date(0);
    expect([1, 2, 3].map((a) => recordRetryAt(a, now)!.getTime() / 60_000)).toEqual([5, 30, 120]);
    expect(recordRetryAt(4, now)).toBeNull();
  });

  it("reads Retry-After in seconds or as a date, bounded", () => {
    expect(retryAfterMs("3")).toBe(3000);
    expect(retryAfterMs("0")).toBe(1000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 0)).toBe(10_000);
    expect(retryAfterMs("soon")).toBeNull();
    expect(retryAfterMs("999999")).toBe(86_400_000);
  });
});

describe("limiters", () => {
  it("a token bucket spaces requests once the window's share is used", () => {
    const b = new TokenBucket(2, 1000, 0);
    expect(b.take(0)).toBe(0);
    expect(b.take(0)).toBe(0);
    expect(b.take(0)).toBe(500);
    expect(b.take(2000)).toBe(0);
    b.clamp(0);
    expect(b.take(2000)).toBeGreaterThan(0);
  });

  it("the daily budget stops at the cap and rolls over at UTC midnight", () => {
    const b = new DailyBudget("2026-11-16", 14_990, 15_000);
    expect(b.canSpend(10)).toBe(true);
    b.spend(10);
    expect(b.canSpend(10)).toBe(false);
    b.roll(new Date("2026-11-17T00:00:01Z"));
    expect(b.spent).toBe(0);
    expect(DailyBudget.resetAt(new Date("2026-11-16T23:00:00Z")).toISOString()).toBe(
      "2026-11-17T00:00:00.000Z",
    );
  });
});

describe("PKCE", () => {
  it("S256 challenge from a random verifier", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkceChallenge(verifier)).toBe(challenge);
    // RFC 7636 appendix B
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});
