import { describe, expect, it } from "vitest";
import {
  canSendCommercialEmail,
  consentExpiresAt,
  isSuppressed,
  isWithinSendWindow,
} from "./index";

describe("isWithinSendWindow", () => {
  // Wednesday 2026-11-18 15:00 UTC = 10:00 in New York, 07:00 in Los Angeles.
  const wedAfternoonUtc = new Date("2026-11-18T15:00:00Z");

  it("allows 10:00 on a weekday in New York", () => {
    expect(isWithinSendWindow(wedAfternoonUtc, "America/New_York")).toBe(true);
  });

  it("blocks 07:00 in Los Angeles", () => {
    expect(isWithinSendWindow(wedAfternoonUtc, "America/Los_Angeles")).toBe(false);
  });

  it("blocks weekends", () => {
    const saturdayNoonNy = new Date("2026-11-21T17:00:00Z");
    expect(isWithinSendWindow(saturdayNoonNy, "America/New_York")).toBe(false);
  });
});

describe("consent", () => {
  it("implied inquiry consent expires after 6 months", () => {
    const expires = consentExpiresAt({
      basis: "implied_inquiry",
      obtainedAt: new Date("2026-01-15T00:00:00Z"),
    });
    expect(expires?.toISOString().slice(0, 10)).toBe("2026-07-15");
  });

  it("blocks Canadian contacts with expired implied consent", () => {
    const result = canSendCommercialEmail(
      "CA",
      { basis: "implied_inquiry", obtainedAt: new Date("2025-01-01T00:00:00Z") },
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("expired");
  });

  it("blocks anyone who unsubscribed, in every jurisdiction", () => {
    const record = {
      basis: "express" as const,
      obtainedAt: new Date("2025-01-01T00:00:00Z"),
      withdrawnAt: new Date("2025-06-01T00:00:00Z"),
    };
    for (const j of ["CA", "US", "EU", "OTHER"] as const) {
      expect(canSendCommercialEmail(j, record).allowed).toBe(false);
    }
  });

  it("allows US contacts without prior consent (CAN-SPAM is opt-out)", () => {
    expect(canSendCommercialEmail("US", undefined).allowed).toBe(true);
  });
});

describe("isSuppressed", () => {
  const list = new Set(["jane@acme.com", "@blocked.io"]);

  it("matches exact emails case-insensitively", () => {
    expect(isSuppressed("Jane@Acme.com", list)).toBe(true);
  });

  it("matches whole suppressed domains", () => {
    expect(isSuppressed("anyone@blocked.io", list)).toBe(true);
  });

  it("treats malformed addresses as suppressed", () => {
    expect(isSuppressed("no-at-sign", list)).toBe(true);
  });

  it("allows everyone else", () => {
    expect(isSuppressed("bob@acme.com", list)).toBe(false);
  });
});
