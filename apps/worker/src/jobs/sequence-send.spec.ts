import { describe, expect, it } from "vitest";
import { preSendCheck, type SequenceSendJob } from "./sequence-send";

const weekdayMorningNy = new Date("2026-11-18T15:00:00Z"); // Wed 10:00 New York

const job: SequenceSendJob = {
  workspaceId: "w1",
  enrollmentId: "e1",
  contactEmail: "buyer@acme.com",
  contactTimeZone: "America/New_York",
  mailboxSentToday: 0,
};

describe("preSendCheck", () => {
  it("sends when every check passes", () => {
    expect(preSendCheck(job, new Set(), weekdayMorningNy)).toEqual({ action: "send" });
  });

  it("skips suppressed contacts", () => {
    expect(preSendCheck(job, new Set(["@acme.com"]), weekdayMorningNy).action).toBe("skip");
  });

  it("defers when the mailbox hit its daily cap", () => {
    const result = preSendCheck({ ...job, mailboxSentToday: 50 }, new Set(), weekdayMorningNy);
    expect(result).toEqual({ action: "defer", reason: "mailbox_daily_cap" });
  });

  it("defers outside the contact's business hours", () => {
    const result = preSendCheck(
      { ...job, contactTimeZone: "Asia/Tokyo" },
      new Set(),
      weekdayMorningNy,
    );
    expect(result).toEqual({ action: "defer", reason: "outside_send_window" });
  });
});
