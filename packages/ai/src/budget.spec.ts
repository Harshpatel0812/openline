import { describe, expect, it } from "vitest";
import {
  AiError,
  assertWithinBudget,
  budgetResetsAt,
  creditsFor,
  editDistance,
  monthKey,
  monthStart,
} from "./index";

describe("AI credits and budgets", () => {
  it("1 credit = 1,000 tokens, rounded up", () => {
    expect(creditsFor({ inputTokens: 0, outputTokens: 0 })).toBe(0);
    expect(creditsFor({ inputTokens: 1, outputTokens: 0 })).toBe(1);
    expect(creditsFor({ inputTokens: 700, outputTokens: 300 })).toBe(1);
    expect(creditsFor({ inputTokens: 700, outputTokens: 301 })).toBe(2);
  });

  it("months are calendar months in UTC", () => {
    const now = new Date("2026-12-31T23:30:00-05:00"); // already January 1 in UTC
    expect(monthKey(now)).toBe("2027-01");
    expect(monthStart(new Date("2026-11-14T10:00:00Z")).toISOString()).toBe(
      "2026-11-01T00:00:00.000Z",
    );
    expect(budgetResetsAt(new Date("2026-12-14T10:00:00Z")).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });

  it("throws a budget error with the reset date once credits are used up", () => {
    const now = new Date("2026-11-14T10:00:00Z");
    expect(() => assertWithinBudget(1999, 2000, now)).not.toThrow();
    const err = (() => {
      try {
        assertWithinBudget(2000, 2000, now);
      } catch (e) {
        return e as AiError;
      }
    })();
    expect(err).toBeInstanceOf(AiError);
    expect(err!.code).toBe("budget");
    expect(err!.details.resetsAt!.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it("edit distance counts character edits", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("same", "same")).toBe(0);
    expect(editDistance("", "abc")).toBe(3);
  });
});
