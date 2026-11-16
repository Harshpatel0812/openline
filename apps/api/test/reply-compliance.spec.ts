/**
 * Security L6: the inbox reply refuses whenever the compliance engine says "blocked", even for a
 * failing check that has no named error code of its own.
 */
import { evaluateEmailContact, type EmailEvaluation } from "@openline/compliance";
import { describe, expect, it } from "vitest";
import { replyRefusal } from "../src/modules/inbox/reply-compliance";

const AT = new Date("2026-11-18T15:00:00Z");
const base = {
  email: "jane@buyer.com",
  country: "US",
  status: "active" as const,
  timeZone: "America/New_York",
  consent: null,
  suppressions: new Set<string>(),
  mailingAddress: "1 Main St, Jersey City, NJ 07302",
  context: "reply" as const,
};

describe("replyRefusal", () => {
  it("allows an allowed evaluation", () => {
    expect(replyRefusal(evaluateEmailContact(base, AT), "active", true)).toBeNull();
  });

  it.each([
    [{ status: "unsubscribed" as const }, "unsubscribed"],
    [{ status: "bounced" as const }, "bounced"],
    [{ suppressions: new Set(["jane@buyer.com"]) }, "suppressed"],
    [{ country: "CA" }, "no_consent"],
    [{ country: "DE" }, "no_consent"],
    [{ mailingAddress: undefined }, "mailing_address_missing"],
  ])("named refusal for %j → %s", (patch, code) => {
    const evaluation = evaluateEmailContact({ ...base, ...patch }, AT);
    const status = "status" in patch ? patch.status : "active";
    expect(replyRefusal(evaluation, status, "mailingAddress" in patch ? false : true)?.code).toBe(
      code,
    );
  });

  it("any other blocked evaluation is refused with the first failing check's rule as the code", () => {
    const allowed = evaluateEmailContact(base, AT);
    const blocked: EmailEvaluation = {
      ...allowed,
      decision: "blocked",
      checks: allowed.checks.map((c) =>
        c.rule === "send_window"
          ? { ...c, outcome: "fail", detail: "The contact's time zone isn't valid." }
          : c,
      ),
    };
    expect(replyRefusal(blocked, "active", true)).toEqual({
      code: "send_window",
      message: "The contact's time zone isn't valid.",
    });
    // Even a blocked decision with no failing check (defence in depth).
    expect(replyRefusal({ ...allowed, decision: "blocked" }, "active", true)).toEqual({
      code: "compliance_blocked",
      message: expect.any(String),
    });
  });

  it("an archived contact that fails contact_status isn't mislabelled as bounced", () => {
    const evaluation = evaluateEmailContact(
      { ...base, status: "archived", context: "sequence" },
      AT,
    );
    expect(replyRefusal(evaluation, "archived", true)?.code).toBe("contact_status");
  });
});
