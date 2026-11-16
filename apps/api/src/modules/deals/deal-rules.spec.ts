import { describe, expect, it } from "vitest";
import {
  calendarWindow,
  DAY_MS,
  dealFlags,
  roundPercent,
  totalsOf,
  type DealFlagInput,
} from "./deal-rules";

const base: DealFlagInput = {
  kind: "open",
  stagePosition: 1,
  firstOpenPosition: 0,
  staleAfterDays: 14,
  lastActivityAt: new Date("2026-11-01T12:00:00Z"),
  nextStep: "Send proposal",
  nextStepDate: null,
  expectedCloseDate: null,
};

describe("dealFlags", () => {
  it("is stale only strictly after staleAfterDays × 24 h", () => {
    const at = base.lastActivityAt.getTime() + 14 * DAY_MS;
    expect(dealFlags(base, new Date(at), "2026-11-15").isStale).toBe(false);
    expect(dealFlags(base, new Date(at + 1), "2026-11-15").isStale).toBe(true);
    expect(dealFlags(base, new Date(at - 1), "2026-11-15").isStale).toBe(false);
  });

  it("never marks closed deals or stages without a limit as stale", () => {
    const late = new Date(base.lastActivityAt.getTime() + 400 * DAY_MS);
    expect(dealFlags({ ...base, staleAfterDays: null }, late, "2027-12-01").isStale).toBe(false);
    for (const kind of ["won", "lost"] as const) {
      const f = dealFlags(
        {
          ...base,
          kind,
          nextStepDate: "2026-01-01",
          expectedCloseDate: "2026-01-01",
          nextStep: null,
        },
        late,
        "2027-12-01",
      );
      expect(f).toEqual({
        isStale: false,
        nextStepOverdue: false,
        closeDateOverdue: false,
        missingNextStep: false,
      });
    }
  });

  it("dates are overdue the day after, not on the day", () => {
    const now = new Date("2026-11-15T12:00:00Z");
    const on = { ...base, nextStepDate: "2026-11-15", expectedCloseDate: "2026-11-15" };
    expect(dealFlags(on, now, "2026-11-15")).toMatchObject({
      nextStepOverdue: false,
      closeDateOverdue: false,
    });
    expect(dealFlags(on, now, "2026-11-16")).toMatchObject({
      nextStepOverdue: true,
      closeDateOverdue: true,
    });
  });

  it("missing next step only past the first open stage", () => {
    const now = new Date("2026-11-02T00:00:00Z");
    expect(dealFlags({ ...base, nextStep: null }, now, "2026-11-02").missingNextStep).toBe(true);
    expect(
      dealFlags({ ...base, nextStep: null, stagePosition: 0 }, now, "2026-11-02").missingNextStep,
    ).toBe(false);
  });
});

describe("calendarWindow", () => {
  it("uses the workspace time zone for today, month and quarter", () => {
    // 2026-12-31 23:30 in New York is already 2027-01-01 in UTC and in Kiritimati (UTC+14).
    const now = new Date("2027-01-01T04:30:00Z");
    expect(calendarWindow("America/New_York", now)).toEqual({
      today: "2026-12-31",
      monthStart: "2026-12-01",
      nextMonthStart: "2027-01-01",
      quarterStart: "2026-10-01",
      nextQuarterStart: "2027-01-01",
    });
    expect(calendarWindow("Pacific/Kiritimati", now)).toMatchObject({
      today: "2027-01-01",
      monthStart: "2027-01-01",
      nextMonthStart: "2027-02-01",
      quarterStart: "2027-01-01",
      nextQuarterStart: "2027-04-01",
    });
    expect(calendarWindow("Not/AZone", now).today).toBe("2027-01-01");
  });

  it("next-step overdue flips at local midnight, not UTC midnight", () => {
    const deal = { ...base, nextStepDate: "2026-11-15" };
    // 02:00 UTC on Nov 16 = 21:00 Nov 15 in New York: not overdue there, overdue in UTC.
    const now = new Date("2026-11-16T02:00:00Z");
    const ny = calendarWindow("America/New_York", now).today;
    const utc = calendarWindow("UTC", now).today;
    expect(dealFlags(deal, now, ny).nextStepOverdue).toBe(false);
    expect(dealFlags(deal, now, utc).nextStepOverdue).toBe(true);
  });
});

describe("money totals", () => {
  it("rounds half up, exactly, with bigint", () => {
    expect(roundPercent(20_050n)).toBe(201n);
    expect(roundPercent(20_049n)).toBe(200n);
    expect(roundPercent(0n)).toBe(0n);
    expect(roundPercent(99_999_999_999_900n * 3n)).toBe(2_999_999_999_997n);
  });

  it("rounds weighted sums once per currency, keeps other currencies apart", () => {
    const t = totalsOf(
      [
        { currency: "USD", count: 3, withAmount: 2, amount: "2010", weightedRaw: "10050" },
        { currency: "USD", count: 1, withAmount: 1, amount: "1005", weightedRaw: "10050" },
        { currency: "EUR", count: 1, withAmount: 1, amount: "999", weightedRaw: "49950" },
        { currency: "CAD", count: 1, withAmount: 0, amount: "0", weightedRaw: "0" },
      ],
      "USD",
    );
    // 100.5 + 100.5 rounded once = 201 (rounding each would give 202).
    expect(t).toEqual({
      count: 6,
      amountMinor: 3015,
      weightedMinor: 201,
      byCurrency: [
        { currency: "USD", count: 3, amountMinor: 3015, weightedMinor: 201 },
        { currency: "EUR", count: 1, amountMinor: 999, weightedMinor: 500 },
      ],
    });
    expect(totalsOf([], "USD")).toEqual({
      count: 0,
      amountMinor: 0,
      weightedMinor: 0,
      byCurrency: [],
    });
  });
});
