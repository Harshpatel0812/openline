import { describe, expect, it } from "vitest";
import { localDateOf, promiseDueAt, resolveWhen, zonedTime } from "./when";

const NY = "America/New_York";
/** Wednesday 11 Nov 2026, 15:00 in New York. */
const WED = new Date("2026-11-11T20:00:00Z");

const at = (phrase: string, date = WED, tz = NY) => {
  const r = resolveWhen(phrase, date, tz);
  return r ? (r.start === r.end ? r.start : `${r.start}..${r.end}`) : null;
};

describe("resolveWhen: phrase table (message Wed 2026-11-11, New York)", () => {
  it.each([
    // days
    ["today", "2026-11-11"],
    ["by EOD", "2026-11-11"],
    ["end of day", "2026-11-11"],
    ["tomorrow", "2026-11-12"],
    ["tmrw morning", "2026-11-12"],
    ["the day after tomorrow", "2026-11-13"],
    // weekdays
    ["by Friday", "2026-11-13"],
    ["Friday", "2026-11-13"],
    ["on Monday", "2026-11-16"],
    ["Wednesday", "2026-11-18"],
    ["this Friday", "2026-11-13"],
    ["this Monday", "2026-11-16"],
    ["next Friday", "2026-11-20"],
    ["next Tuesday", "2026-11-17"],
    ["Friday next week", "2026-11-20"],
    ["thurs", "2026-11-12"],
    ["before Friday", "2026-11-12"],
    // weeks
    ["end of the week", "2026-11-13"],
    ["later this week", "2026-11-13"],
    ["this week", "2026-11-11..2026-11-13"],
    ["next week", "2026-11-16..2026-11-20"],
    ["early next week", "2026-11-16..2026-11-20"],
    ["end of next week", "2026-11-20"],
    ["beginning of next week", "2026-11-16"],
    ["the week after next", "2026-11-23..2026-11-27"],
    ["in two weeks", "2026-11-25"],
    ["in a fortnight", "2026-11-25"],
    ["in a couple of weeks", "2026-11-25"],
    ["in 3 days", "2026-11-14"],
    ["within the next few days", "2026-11-14"],
    ["in 2 business days", "2026-11-13"],
    ["3 weeks from now", "2026-12-02"],
    // months
    ["end of month", "2026-11-30"],
    ["by the end of this month", "2026-11-30"],
    ["next month", "2026-12-01..2026-12-31"],
    ["early next month", "2026-12-01..2026-12-10"],
    ["end of next month", "2026-12-31"],
    ["in a month", "2026-12-11"],
    ["in March", "2027-03-01..2027-03-31"],
    ["March", "2027-03-01..2027-03-31"],
    ["after budget in March", "2027-04-01..2027-04-30"],
    ["after March", "2027-04-01..2027-04-30"],
    ["early March", "2027-03-01..2027-03-10"],
    ["mid-March", "2027-03-11..2027-03-20"],
    ["late January", "2027-01-21..2027-01-31"],
    ["end of February", "2027-02-28"],
    ["in May", "2027-05-01..2027-05-31"],
    ["November", "2026-11-01..2026-11-30"],
    ["after November", "2026-12-01..2026-12-31"],
    ["December 2027", "2027-12-01..2027-12-31"],
    // quarters
    ["Q1", "2027-01-01..2027-03-31"],
    ["circle back in Q2", "2027-04-01..2027-06-30"],
    ["Q4", "2026-10-01..2026-12-31"],
    ["after Q2", "2027-07-01..2027-09-30"],
    ["Q3 2027", "2027-07-01..2027-09-30"],
    ["end of Q1", "2027-03-31"],
    ["end of quarter", "2026-12-31"],
    ["next quarter", "2027-01-01..2027-03-31"],
    ["second quarter", "2027-04-01..2027-06-30"],
    // years and seasons
    ["next year", "2027-01-01..2027-12-31"],
    ["end of the year", "2026-12-31"],
    ["after the holidays", "2027-01-02"],
    ["in the new year", "2027-01-02"],
    ["in the spring", "2027-03-01..2027-05-31"],
    ["this summer", "2027-06-01..2027-08-31"],
    // explicit dates
    ["2026-12-03", "2026-12-03"],
    ["by 12/3", "2026-12-03"],
    ["12/3/2027", "2027-12-03"],
    ["25/12", "2026-12-25"],
    ["December 3rd", "2026-12-03"],
    ["Dec 3, 2027", "2027-12-03"],
    ["3 December", "2026-12-03"],
    ["the 2nd of January", "2027-01-02"],
    ["Nov 11", "2026-11-11"],
    ["Nov 10", "2027-11-10"],
    ["the 20th", "2026-11-20"],
    ["the 5th", "2026-12-05"],
  ])("%s → %s", (phrase, expected) => {
    expect(at(phrase)).toBe(expected);
  });

  it.each([
    [""],
    ["soon"],
    ["when the time is right"],
    ["asap"],
    ["I may be able to"],
    ["2026-02-30"],
    ["13/13"],
  ])("%j names no date", (phrase) => {
    expect(at(phrase)).toBeNull();
  });
});

describe("resolveWhen: boundaries", () => {
  it("month and year rollover: 'tomorrow' on Dec 31, 'next month' in December", () => {
    const nye = new Date("2026-12-31T20:00:00Z");
    expect(at("tomorrow", nye)).toBe("2027-01-01");
    expect(at("next month", nye)).toBe("2027-01-01..2027-01-31");
    expect(at("next week", nye)).toBe("2027-01-04..2027-01-08");
    expect(at("Q1", nye)).toBe("2027-01-01..2027-03-31");
    expect(at("end of month", nye)).toBe("2026-12-31");
  });

  it("'in a month' clamps to the shorter month; leap years", () => {
    expect(at("in a month", new Date("2026-01-30T15:00:00Z"))).toBe("2026-02-28");
    expect(at("in a month", new Date("2028-01-31T15:00:00Z"))).toBe("2028-02-29");
    expect(at("end of month", new Date("2028-02-10T15:00:00Z"))).toBe("2028-02-29");
  });

  it("the message's local day decides, not UTC", () => {
    // 02:00 UTC Thursday is still Wednesday evening in New York, already Thursday in Berlin.
    const lateWed = new Date("2026-11-12T02:00:00Z");
    expect(at("tomorrow", lateWed, NY)).toBe("2026-11-12");
    expect(at("tomorrow", lateWed, "Europe/Berlin")).toBe("2026-11-13");
    expect(at("tomorrow", lateWed, "Not/AZone")).toBe("2026-11-13"); // invalid → UTC
  });

  it("weekends: 'this week' and 'end of the week' mean the coming week", () => {
    const sat = new Date("2026-11-14T15:00:00Z");
    expect(at("end of the week", sat)).toBe("2026-11-20");
    expect(at("next week", sat)).toBe("2026-11-16..2026-11-20");
    expect(at("Monday", sat)).toBe("2026-11-16");
    expect(at("Friday", new Date("2026-11-13T15:00:00Z"))).toBe("2026-11-20");
  });

  it("a month named in that month is this month; in a later month it's next year", () => {
    expect(at("in December", new Date("2026-12-20T15:00:00Z"))).toBe("2026-12-01..2026-12-31");
    expect(at("in October", new Date("2026-12-20T15:00:00Z"))).toBe("2027-10-01..2027-10-31");
    expect(at("after December", new Date("2026-12-20T15:00:00Z"))).toBe("2027-01-01..2027-01-31");
  });
});

describe("zonedTime and DST", () => {
  it("handles the autumn and spring transitions", () => {
    // New York leaves DST on Sun 1 Nov 2026 and enters it on Sun 14 Mar 2027.
    expect(zonedTime("2026-10-30", 17, 0, NY).toISOString()).toBe("2026-10-30T21:00:00.000Z");
    expect(zonedTime("2026-11-02", 17, 0, NY).toISOString()).toBe("2026-11-02T22:00:00.000Z");
    expect(zonedTime("2027-03-12", 10, 0, NY).toISOString()).toBe("2027-03-12T15:00:00.000Z");
    expect(zonedTime("2027-03-15", 10, 0, NY).toISOString()).toBe("2027-03-15T14:00:00.000Z");
    expect(zonedTime("2026-10-26", 10, 0, "Europe/London").toISOString()).toBe(
      "2026-10-26T10:00:00.000Z",
    );
    expect(zonedTime("2026-10-23", 10, 0, "Europe/London").toISOString()).toBe(
      "2026-10-23T09:00:00.000Z",
    );
    expect(localDateOf(new Date("2026-11-01T05:30:00Z"), NY)).toBe("2026-11-01");
  });
});

describe("promiseDueAt", () => {
  const due = (
    type: Parameters<typeof promiseDueAt>[0],
    phrase: string | null,
    date = WED,
    tz = NY,
  ) => {
    const r = promiseDueAt(type, resolveWhen(phrase, date, tz), date, tz);
    return { at: r.dueAt.toISOString(), missing: r.dueDateMissing };
  };

  it("our promise: end of that business day", () => {
    expect(due("our_promise", "by Friday")).toEqual({
      at: "2026-11-13T22:00:00.000Z",
      missing: false,
    });
  });

  it("our promise across the DST change: Friday Oct 30 → 'Monday' is 17:00 EST", () => {
    const fri = new Date("2026-10-30T14:00:00Z");
    expect(due("our_promise", "Monday", fri).at).toBe("2026-11-02T22:00:00.000Z");
  });

  it("our promise 'next week' → next Monday 10:00", () => {
    expect(due("our_promise", "next week").at).toBe("2026-11-16T15:00:00.000Z");
  });

  it("our promise on a weekend day rolls back to Friday", () => {
    expect(due("our_promise", "Saturday").at).toBe("2026-11-13T22:00:00.000Z");
  });

  it("no date → +2 business days, flagged (skips the weekend)", () => {
    expect(due("our_promise", null)).toEqual({ at: "2026-11-13T22:00:00.000Z", missing: true });
    const thu = new Date("2026-11-12T15:00:00Z");
    expect(due("our_promise", "whenever", thu)).toEqual({
      at: "2026-11-16T22:00:00.000Z",
      missing: true,
    });
  });

  it("'today' after the end of the day moves to the next business day", () => {
    const evening = new Date("2026-11-13T23:30:00Z"); // Fri 18:30 New York
    expect(due("our_promise", "today", evening).at).toBe("2026-11-16T22:00:00.000Z");
  });

  it("their request: first business day of the period at 10:00", () => {
    expect(due("their_request", "after budget in March").at).toBe("2027-04-01T14:00:00.000Z");
    expect(due("their_request", "in Q2").at).toBe("2027-04-01T14:00:00.000Z");
    // 1 Aug 2027 is a Sunday → Monday 2 Aug.
    expect(due("their_request", "in August").at).toBe("2027-08-02T14:00:00.000Z");
    // A weekend day rolls forward.
    expect(due("their_request", "Saturday").at).toBe("2026-11-16T15:00:00.000Z");
  });

  it("their promise: the business day after their period, 10:00", () => {
    expect(due("their_promise", "next week").at).toBe("2026-11-23T15:00:00.000Z");
    expect(due("their_promise", "by Friday").at).toBe("2026-11-16T15:00:00.000Z");
    expect(due("their_promise", "tomorrow").at).toBe("2026-11-13T15:00:00.000Z");
  });

  it("is never before the message", () => {
    expect(due("their_request", "November").at).toBe("2026-11-12T15:00:00.000Z");
  });
});

describe("resolveWhen: seasons (QA L4)", () => {
  const jan = new Date("2027-01-15T15:00:00Z");
  const feb = new Date("2027-02-15T15:00:00Z");
  const apr = new Date("2026-04-15T15:00:00Z");

  it("'winter' / 'this winter' in January or February is the current winter", () => {
    expect(at("this winter", jan)).toBe("2026-12-01..2027-02-28");
    expect(at("winter", feb)).toBe("2026-12-01..2027-02-28");
    expect(at("this winter", WED)).toBe("2026-12-01..2027-02-28");
  });

  it("'next <season>' moves a year forward while that season is current", () => {
    expect(at("next winter", jan)).toBe("2027-12-01..2028-02-29");
    expect(at("next spring", apr)).toBe("2027-03-01..2027-05-31");
    expect(at("this spring", apr)).toBe("2026-03-01..2026-05-31");
    // Not current: the coming one.
    expect(at("next spring", WED)).toBe("2027-03-01..2027-05-31");
    expect(at("next summer", apr)).toBe("2026-06-01..2026-08-31");
  });
});

describe("resolveWhen: 'may' is a month only with a day or a time preposition (QA M3)", () => {
  it.each([
    ["in May", "2027-05-01..2027-05-31"],
    ["by May", "2027-05-01..2027-05-31"],
    ["until May", "2027-05-01..2027-05-31"],
    ["after May", "2027-06-01..2027-06-30"],
    ["early May", "2027-05-01..2027-05-10"],
    ["late May", "2027-05-21..2027-05-31"],
    ["mid May", "2027-05-11..2027-05-20"],
    ["May 4", "2027-05-04"],
    ["4th of May", "2027-05-04"],
  ])("%s → %s", (phrase, expected) => {
    expect(at(phrase)).toBe(expected);
  });

  it.each([["may"], ["May"], ["we may reach out"], ["May 2027"], ["I may get back"]])(
    "%j is not a month",
    (phrase) => {
      expect(at(phrase)).toBeNull();
    },
  );
});

describe("promiseDueAt: clamped to 18 months after the message (security L4)", () => {
  it.each([
    ["9999-12-31"],
    ["december 3, 9999"],
    ["q2 9999"],
    ["after 9999-12-31"],
    ["in 99 years"],
  ])("%s stays within 18 months", (phrase) => {
    const due = promiseDueAt("their_request", resolveWhen(phrase, WED, NY), WED, NY);
    expect(due.dueAt.getTime()).toBeLessThanOrEqual(Date.UTC(2028, 4, 12));
    expect(due.dueAt.getTime()).toBeGreaterThan(WED.getTime());
    expect(localDateOf(due.dueAt, NY) <= "2028-05-11").toBe(true);
  });

  it("a date within 18 months is untouched", () => {
    const due = promiseDueAt("their_request", resolveWhen("in Q2", WED, NY), WED, NY);
    expect(due.dueAt.toISOString()).toBe("2027-04-01T14:00:00.000Z");
  });
});
