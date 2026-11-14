import { describe, expect, it } from "vitest";
import { isValidSendWindow, jurisdictionFor, nextSendWindowStart } from "./index";

describe("nextSendWindowStart", () => {
  it.each([
    // Wed 06:00 local in each zone → Wed 09:00 local (not 09:30 / 09:45)
    ["Asia/Kolkata", "2026-11-18T00:30:00Z", "2026-11-18T03:30:00.000Z"], // UTC+5:30
    ["Asia/Kathmandu", "2026-11-18T00:15:00Z", "2026-11-18T03:15:00.000Z"], // UTC+5:45
    ["America/St_Johns", "2026-11-18T09:30:00Z", "2026-11-18T12:30:00.000Z"], // UTC−3:30
  ])("opens at 9:00 sharp in %s", (zone, from, expected) => {
    expect(nextSendWindowStart(new Date(from), zone).toISOString()).toBe(expected);
  });

  it("returns the same instant when already inside the window", () => {
    const t = new Date("2026-11-18T15:30:00Z"); // Wed 10:30 New York
    expect(nextSendWindowStart(t, "America/New_York")).toEqual(t);
  });

  it("moves Friday evening to Monday 9:00 local time", () => {
    const fridayEvening = new Date("2026-11-20T23:00:00Z"); // Fri 18:00 New York
    expect(nextSendWindowStart(fridayEvening, "America/New_York").toISOString()).toBe(
      "2026-11-23T14:00:00.000Z", // Mon 09:00 EST
    );
  });

  it("respects the contact's own time zone", () => {
    const t = new Date("2026-11-18T15:00:00Z"); // Wed 07:00 in Los Angeles
    expect(nextSendWindowStart(t, "America/Los_Angeles").toISOString()).toBe(
      "2026-11-18T17:00:00.000Z", // 09:00 PST
    );
  });

  it("handles the DST change (Nov 1, 2026 in the US)", () => {
    const sat = new Date("2026-10-31T16:00:00Z"); // Sat noon EDT
    expect(nextSendWindowStart(sat, "America/New_York").toISOString()).toBe(
      "2026-11-02T14:00:00.000Z", // Mon 09:00 EST (UTC-5 after the change)
    );
  });
});

describe("isValidSendWindow", () => {
  it("rejects empty days and inverted hours", () => {
    expect(isValidSendWindow({ days: [], startHour: 9, endHour: 17 })).toBe(false);
    expect(isValidSendWindow({ days: [1], startHour: 17, endHour: 9 })).toBe(false);
    expect(isValidSendWindow({ days: [1, 2], startHour: 8, endHour: 20 })).toBe(true);
  });
});

describe("jurisdictionFor", () => {
  it("uses the country when known", () => {
    expect(jurisdictionFor("CA", "a@b.com")).toBe("CA");
    expect(jurisdictionFor("de", "a@b.com")).toBe("EU");
    expect(jurisdictionFor("US", "a@b.ca")).toBe("US");
  });

  it("falls back to the email domain, then US", () => {
    expect(jurisdictionFor(null, "a@shop.ca")).toBe("CA");
    expect(jurisdictionFor(undefined, "a@firma.de")).toBe("EU");
    expect(jurisdictionFor(null, "a@acme.com")).toBe("US");
  });
});
