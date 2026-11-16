import { describe, expect, it } from "vitest";
import {
  CITATIONS,
  CONSENT_WARNING_DAYS,
  currentConsent,
  evaluateEmailContact,
  failed,
  firstBlockingCheck,
  isWithinSendWindow,
  RULE_IDS,
  RULESET_VERSION,
  toComplianceProof,
  type Check,
  type ConsentRecord,
  type StoredConsent,
  type EmailContactInput,
  type RuleId,
} from "./index";

/** Wednesday 2026-11-18 10:00 in New York. */
const WED_10AM_NY = new Date("2026-11-18T15:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const base = (over: Partial<EmailContactInput> = {}): EmailContactInput => ({
  email: "jane@buyer.com",
  country: "US",
  status: "active",
  timeZone: "America/New_York",
  consent: null,
  suppressions: new Set<string>(),
  mailingAddress: "1 Main St, Jersey City, NJ 07302",
  ...over,
});

const check = (input: EmailContactInput, rule: RuleId, at = WED_10AM_NY): Check =>
  evaluateEmailContact(input, at).checks.find((c) => c.rule === rule)!;

describe("evaluateEmailContact: overall", () => {
  it("allows a US contact during business hours, reporting every rule in order", () => {
    const result = evaluateEmailContact(base(), WED_10AM_NY);
    expect(result.decision).toBe("allowed");
    expect(result.nextAllowedAt).toBeUndefined();
    expect(result.rulesetVersion).toBe(RULESET_VERSION);
    expect(result.channel).toBe("email");
    expect(result.jurisdiction).toBe("US");
    expect(result.evaluatedAt).toEqual(WED_10AM_NY);
    expect(result.checks.map((c) => c.rule)).toEqual([...RULE_IDS]);
    expect(result.checks.map((c) => c.outcome)).toEqual([
      "pass",
      "pass",
      "not_applicable",
      "not_applicable",
      "pass",
      "pass",
      "pass",
    ]);
    for (const c of result.checks) {
      expect(c.detail.length).toBeGreaterThan(0);
      expect(c.citation.length).toBeGreaterThan(0);
    }
  });

  it("a fail beats a wait: blocked, and no next allowed time", () => {
    const at = new Date("2026-11-18T08:00:00Z"); // 03:00 in New York
    const result = evaluateEmailContact(base({ status: "bounced" }), at);
    expect(result.decision).toBe("blocked");
    expect(result.nextAllowedAt).toBeUndefined();
    expect(firstBlockingCheck(result)?.rule).toBe("contact_status");
  });

  it("a wait alone is not_now with the next window start", () => {
    const at = new Date("2026-11-18T08:00:00Z");
    const result = evaluateEmailContact(base(), at);
    expect(result.decision).toBe("not_now");
    expect(result.nextAllowedAt?.toISOString()).toBe("2026-11-18T14:00:00.000Z");
    expect(firstBlockingCheck(result)?.rule).toBe("send_window");
    expect(failed(result, "send_window")).toBeUndefined();
  });

  it("firstBlockingCheck is undefined and failed() finds the failing rule", () => {
    expect(firstBlockingCheck(evaluateEmailContact(base(), WED_10AM_NY))).toBeUndefined();
    const blocked = evaluateEmailContact(base({ mailingAddress: null }), WED_10AM_NY);
    expect(failed(blocked, "sender_identity")?.outcome).toBe("fail");
    expect(failed(blocked, "suppression")).toBeUndefined();
  });

  it("does not change the caller's input", () => {
    const input = base({ suppressions: ["@other.com"] });
    const copy = JSON.stringify(input);
    evaluateEmailContact(input, WED_10AM_NY);
    expect(JSON.stringify(input)).toBe(copy);
  });
});

describe("rule: suppression", () => {
  it.each([
    ["exact email, case-insensitive", "Jane@Buyer.com", ["jane@buyer.com"], "fail", /address/],
    ["whole domain", "anyone@buyer.com", ["@buyer.com"], "fail", /domain/],
    ["malformed address", "no-at-sign", [], "fail", /valid email/],
    ["leading @", "@buyer.com", [], "fail", /valid email/],
    ["other entries only", "jane@buyer.com", ["bob@buyer.com", "@else.com"], "pass", /Not on/],
  ])("%s → %s", (_name, email, list, outcome, detail) => {
    const asArray = check(base({ email, suppressions: list }), "suppression");
    const asSet = check(base({ email, suppressions: new Set(list) }), "suppression");
    expect(asArray).toEqual(asSet);
    expect(asArray.outcome).toBe(outcome);
    expect(asArray.detail).toMatch(detail);
    expect(asArray.citation).toBe(CITATIONS.suppression);
  });

  it("blocks the send", () => {
    const r = evaluateEmailContact(base({ suppressions: ["@buyer.com"] }), WED_10AM_NY);
    expect(r.decision).toBe("blocked");
  });
});

describe("rule: contact_status", () => {
  it.each([
    ["active", "sequence", "pass", CITATIONS.contactStatus],
    ["unsubscribed", "sequence", "fail", CITATIONS.unsubscribed],
    ["unsubscribed", "reply", "fail", CITATIONS.unsubscribed],
    ["bounced", "sequence", "fail", CITATIONS.bounced],
    ["bounced", "reply", "fail", CITATIONS.bounced],
    ["archived", "sequence", "fail", CITATIONS.archived],
    ["archived", "reply", "pass", CITATIONS.archived],
    [null, "sequence", "not_applicable", CITATIONS.contactStatus],
  ] as const)("%s (%s) → %s", (status, context, outcome, citation) => {
    const c = check(base({ status, context }), "contact_status");
    expect(c.outcome).toBe(outcome);
    expect(c.citation).toBe(citation);
  });

  it("cites the CAN-SPAM opt-out section for unsubscribes", () => {
    expect(CITATIONS.unsubscribed).toContain("15 U.S.C. 7704(a)(4)");
    expect(CITATIONS.unsubscribed).toContain("GDPR Art. 21");
  });
});

describe("rule: consent_ca (CASL)", () => {
  const ca = (consent: ConsentRecord | null, over: Partial<EmailContactInput> = {}) =>
    base({ country: "CA", timeZone: "America/Toronto", consent, ...over });
  const obtained = new Date("2026-06-01T00:00:00Z");
  // implied_inquiry expires 6 months later: 2026-12-01T00:00:00Z.
  const inquiry: ConsentRecord = { basis: "implied_inquiry", obtainedAt: obtained };
  const inquiryExpires = new Date("2026-12-01T00:00:00Z");

  it.each([
    ["no record", null, "fail", /no express or implied consent/],
    ["basis none", { basis: "none", obtainedAt: obtained }, "fail", /no express or implied/],
    [
      "legitimate interest (not enough in Canada)",
      { basis: "legitimate_interest", obtainedAt: obtained },
      "fail",
      /no express or implied/,
    ],
    ["express", { basis: "express", obtainedAt: obtained }, "pass", /doesn't expire/],
    [
      "withdrawn express",
      { basis: "express", obtainedAt: obtained, withdrawnAt: new Date("2026-10-01T00:00:00Z") },
      "fail",
      /withdrew/,
    ],
    [
      "withdrawal dated in the future (not yet effective)",
      { basis: "express", obtainedAt: obtained, withdrawnAt: new Date("2027-01-01T00:00:00Z") },
      "pass",
      /express consent/,
    ],
    [
      "implied purchase, 2 years",
      { basis: "implied_purchase", obtainedAt: new Date("2025-01-10T00:00:00Z") },
      "pass",
      /until 2027-01-10/,
    ],
    [
      "implied purchase older than 2 years",
      { basis: "implied_purchase", obtainedAt: new Date("2024-11-17T00:00:00Z") },
      "fail",
      /expired on 2026-11-17/,
    ],
  ] as const)("%s → %s", (_name, consent, outcome, detail) => {
    const c = check(ca(consent as ConsentRecord | null), "consent_ca");
    expect(c.outcome).toBe(outcome);
    expect(c.detail).toMatch(detail);
    expect(c.citation).toBe(CITATIONS.consentCa);
    expect(c.warning).toBeUndefined();
  });

  it("is not applicable outside Canada, and Canada is detected from a .ca address", () => {
    expect(check(base(), "consent_ca").outcome).toBe("not_applicable");
    const dotCa = evaluateEmailContact(base({ country: null, email: "a@shop.ca" }), WED_10AM_NY);
    expect(dotCa.jurisdiction).toBe("CA");
    expect(dotCa.decision).toBe("blocked");
    expect(failed(dotCa, "consent_ca")).toBeDefined();
  });

  it.each([
    ["31 days before expiry", inquiryExpires.getTime() - 31 * DAY, "pass", false],
    ["30 days + 1 ms before expiry", inquiryExpires.getTime() - 30 * DAY - 1, "pass", false],
    ["exactly 30 days before expiry", inquiryExpires.getTime() - 30 * DAY, "pass", true],
    ["1 day before expiry", inquiryExpires.getTime() - DAY, "pass", true],
    ["1 ms before expiry", inquiryExpires.getTime() - 1, "pass", true],
    ["exactly at expiry", inquiryExpires.getTime(), "fail", false],
    ["after expiry", inquiryExpires.getTime() + DAY, "fail", false],
  ] as const)("implied inquiry %s → %s (warning %s)", (_name, atMs, outcome, warning) => {
    const c = check(ca(inquiry), "consent_ca", new Date(atMs));
    expect(c.outcome).toBe(outcome);
    expect(c.warning === true).toBe(warning);
    if (warning) expect(c.detail).toContain("expires on 2026-12-01");
    if (outcome === "fail") expect(c.detail).toContain("expired on 2026-12-01");
  });

  it("the warning window is 30 days", () => {
    expect(CONSENT_WARNING_DAYS).toBe(30);
  });

  it("a warning still allows the send", () => {
    const at = new Date(inquiryExpires.getTime() - 5 * DAY);
    const r = evaluateEmailContact(ca(inquiry), new Date(at.getTime() + 0));
    expect(failed(r, "consent_ca")).toBeUndefined();
    expect(r.decision).not.toBe("blocked");
  });

  it("cites CASL s. 6 and the implied consent periods", () => {
    expect(CITATIONS.consentCa).toContain("CASL s. 6");
    expect(CITATIONS.consentCa).toContain("s. 10(9)–(10)");
    expect(CITATIONS.consentCa).toContain("2 years");
    expect(CITATIONS.consentCa).toContain("6 months");
  });
});

describe("rule: basis_eu (GDPR)", () => {
  const eu = (consent: ConsentRecord | null, country = "DE") =>
    base({ country, timeZone: "Europe/Berlin", consent });
  const obtained = new Date("2026-01-01T00:00:00Z");
  // 10:00 in Berlin on a Wednesday.
  const at = new Date("2026-11-18T09:00:00Z");

  it.each([
    ["no record", null, "fail"],
    ["basis none", { basis: "none", obtainedAt: obtained }, "fail"],
    [
      "withdrawn",
      { basis: "express", obtainedAt: obtained, withdrawnAt: new Date("2026-02-01T00:00:00Z") },
      "fail",
    ],
    ["consent", { basis: "express", obtainedAt: obtained }, "pass"],
    ["legitimate interest", { basis: "legitimate_interest", obtainedAt: obtained }, "pass"],
    [
      "implied inquiry (a recorded basis)",
      { basis: "implied_inquiry", obtainedAt: obtained },
      "pass",
    ],
  ] as const)("%s → %s", (_name, consent, outcome) => {
    const c = check(eu(consent as ConsentRecord | null), "basis_eu", at);
    expect(c.outcome).toBe(outcome);
    expect(c.citation).toBe(CITATIONS.basisEu);
  });

  it("names the recorded basis", () => {
    const c = check(eu({ basis: "legitimate_interest", obtainedAt: obtained }), "basis_eu", at);
    expect(c.detail).toBe("Lawful basis recorded: legitimate interest.");
  });

  it("applies to the UK and to EEA domains, not elsewhere", () => {
    expect(check(eu(null, "GB"), "basis_eu", at).outcome).toBe("fail");
    expect(check(base({ country: null, email: "a@firma.de" }), "basis_eu", at).outcome).toBe(
      "fail",
    );
    expect(check(base({ country: "JP" }), "basis_eu", at).outcome).toBe("not_applicable");
    expect(check(base({ country: "JP" }), "consent_ca", at).outcome).toBe("not_applicable");
  });

  it("cites GDPR Art. 6(1) and Art. 21", () => {
    expect(CITATIONS.basisEu).toContain("Art. 6(1)");
    expect(CITATIONS.basisEu).toContain("Art. 21");
  });
});

describe("rule: sender_identity", () => {
  it.each([
    ["present", "1 Main St, Jersey City, NJ 07302", "pass"],
    ["missing (null)", null, "fail"],
    ["missing (undefined)", undefined, "fail"],
    ["empty", "", "fail"],
  ] as const)("postal address %s → %s", (_name, mailingAddress, outcome) => {
    const c = check(base({ mailingAddress }), "sender_identity");
    expect(c.outcome).toBe(outcome);
    expect(c.citation).toContain("15 U.S.C. 7704(a)(5)");
  });
});

describe("rule: unsubscribe_mechanism", () => {
  it("always passes and is recorded for proof", () => {
    for (const status of ["active", "unsubscribed", null] as const) {
      for (const context of ["sequence", "reply"] as const) {
        const c = check(base({ status, context }), "unsubscribe_mechanism");
        expect(c.outcome).toBe("pass");
        expect(c.citation).toBe(CITATIONS.unsubscribeMechanism);
      }
    }
  });
});

describe("rule: send_window", () => {
  it.each([
    // [label, instant, zone, outcome, nextAllowedAt]
    [
      "08:59 Wed New York",
      "2026-11-18T13:59:59Z",
      "America/New_York",
      "wait",
      "2026-11-18T14:00:00.000Z",
    ],
    ["09:00 Wed New York", "2026-11-18T14:00:00Z", "America/New_York", "pass", undefined],
    ["17:59 Wed New York", "2026-11-18T22:59:59Z", "America/New_York", "pass", undefined],
    [
      "18:00 Wed New York",
      "2026-11-18T23:00:00Z",
      "America/New_York",
      "wait",
      "2026-11-19T14:00:00.000Z",
    ],
    [
      "Friday evening → Monday",
      "2026-11-20T23:00:00Z",
      "America/New_York",
      "wait",
      "2026-11-23T14:00:00.000Z",
    ],
    [
      "07:00 Los Angeles",
      "2026-11-18T15:00:00Z",
      "America/Los_Angeles",
      "wait",
      "2026-11-18T17:00:00.000Z",
    ],
    [
      "06:00 Kolkata (UTC+5:30)",
      "2026-11-18T00:30:00Z",
      "Asia/Kolkata",
      "wait",
      "2026-11-18T03:30:00.000Z",
    ],
    [
      "06:00 St John's (UTC−3:30)",
      "2026-11-18T09:30:00Z",
      "America/St_Johns",
      "wait",
      "2026-11-18T12:30:00.000Z",
    ],
    // US DST ends Sun 2026-11-01: Saturday noon EDT → Monday 09:00 EST.
    [
      "autumn DST change",
      "2026-10-31T16:00:00Z",
      "America/New_York",
      "wait",
      "2026-11-02T14:00:00.000Z",
    ],
    // US DST starts Sun 2027-03-14: Saturday noon EST → Monday 09:00 EDT.
    [
      "spring DST change",
      "2027-03-13T17:00:00Z",
      "America/New_York",
      "wait",
      "2027-03-15T13:00:00.000Z",
    ],
    // EU DST ends Sun 2026-10-25: Sunday → Monday 09:00 CET.
    ["EU DST change", "2026-10-25T10:00:00Z", "Europe/Berlin", "wait", "2026-10-26T08:00:00.000Z"],
  ])("%s → %s", (_name, at, timeZone, outcome, next) => {
    const r = evaluateEmailContact(base({ timeZone }), new Date(at));
    const c = r.checks.find((x) => x.rule === "send_window")!;
    expect(c.outcome).toBe(outcome);
    expect(r.nextAllowedAt?.toISOString()).toBe(next);
    expect(r.decision).toBe(outcome === "pass" ? "allowed" : "not_now");
    if (next) expect(c.detail).toContain(next);
  });

  it("uses the sequence's own window", () => {
    const window = { days: [6], startHour: 10, endHour: 12 }; // Saturdays 10–12 only
    const r = evaluateEmailContact(base({ sendWindow: window }), WED_10AM_NY);
    expect(r.decision).toBe("not_now");
    expect(r.nextAllowedAt?.toISOString()).toBe("2026-11-21T15:00:00.000Z");
  });

  it("is not applicable to inbox replies, even at 3 a.m. on a Sunday", () => {
    const r = evaluateEmailContact(base({ context: "reply" }), new Date("2026-11-22T08:00:00Z"));
    expect(r.checks.find((c) => c.rule === "send_window")?.outcome).toBe("not_applicable");
    expect(r.decision).toBe("allowed");
  });

  it("an unknown time zone or an empty window fails instead of throwing", () => {
    const badZone = evaluateEmailContact(base({ timeZone: "Mars/Olympus" }), WED_10AM_NY);
    expect(failed(badZone, "send_window")?.detail).toMatch(/time zone/);
    expect(badZone.decision).toBe("blocked");
    const empty = evaluateEmailContact(
      base({ sendWindow: { days: [], startHour: 9, endHour: 17 } }),
      WED_10AM_NY,
    );
    expect(failed(empty, "send_window")).toBeDefined();
  });

  it("property: across zones and a year of instants, waits always land inside the window", () => {
    // Small deterministic PRNG (no extra dependency): same cases on every run.
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const zones = [
      "America/New_York",
      "America/Los_Angeles",
      "America/St_Johns",
      "Europe/London",
      "Europe/Berlin",
      "Asia/Kolkata",
      "Asia/Kathmandu",
      "Australia/Sydney",
      "Pacific/Auckland",
      "UTC",
    ];
    const start = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 400; i += 1) {
      const at = new Date(start + Math.floor(rand() * 365 * DAY));
      const timeZone = zones[i % zones.length]!;
      const r = evaluateEmailContact(base({ timeZone }), at);
      if (r.decision === "allowed") {
        expect(isWithinSendWindow(at, timeZone)).toBe(true);
      } else {
        expect(r.decision).toBe("not_now");
        const next = r.nextAllowedAt!;
        expect(next.getTime()).toBeGreaterThan(at.getTime());
        expect(next.getTime() - at.getTime()).toBeLessThanOrEqual(4 * DAY);
        expect(isWithinSendWindow(next, timeZone)).toBe(true);
        // The re-evaluation at that instant is allowed.
        expect(evaluateEmailContact(base({ timeZone }), next).decision).toBe("allowed");
      }
    }
  });
});

describe("toComplianceProof", () => {
  it("is plain JSON with ISO dates and survives a round trip", () => {
    const at = new Date("2026-11-18T08:00:00Z");
    const proof = toComplianceProof(evaluateEmailContact(base(), at));
    expect(proof.evaluatedAt).toBe("2026-11-18T08:00:00.000Z");
    expect(proof.nextAllowedAt).toBe("2026-11-18T14:00:00.000Z");
    expect(proof.decision).toBe("not_now");
    expect(proof.rulesetVersion).toBe(RULESET_VERSION);
    expect(JSON.parse(JSON.stringify(proof))).toEqual(proof);
  });

  it("omits nextAllowedAt unless not_now, and never contains the email address", () => {
    const inputs = [
      base(),
      base({ status: "unsubscribed" }),
      base({ suppressions: ["jane@buyer.com"] }),
      base({ suppressions: ["@buyer.com"] }),
      base({ country: "CA" }),
      base({ country: "DE" }),
      base({ mailingAddress: null }),
    ];
    for (const input of inputs) {
      const proof = toComplianceProof(evaluateEmailContact(input, WED_10AM_NY));
      expect(proof.nextAllowedAt).toBeUndefined();
      const json = JSON.stringify(proof).toLowerCase();
      expect(json).not.toContain("jane@buyer.com");
      expect(json).not.toContain("buyer.com");
    }
  });

  it("copies checks (changing the proof never changes the evaluation)", () => {
    const evaluation = evaluateEmailContact(base(), WED_10AM_NY);
    const proof = toComplianceProof(evaluation);
    proof.checks[0]!.detail = "changed";
    expect(evaluation.checks[0]!.detail).not.toBe("changed");
  });
});

describe("currentConsent (one consent fact for sending, enrolling and the contact page)", () => {
  const rec = (
    id: string,
    createdAt: string,
    extra: Partial<StoredConsent> = {},
  ): StoredConsent => ({
    id,
    basis: "express",
    obtainedAt: new Date(createdAt),
    createdAt: new Date(createdAt),
    withdrawnAt: null,
    ...extra,
  });

  it("is the newest record, withdrawn or not", () => {
    const older = rec("a", "2026-10-01T00:00:00Z");
    const withdrawn = rec("b", "2026-11-01T00:00:00Z", {
      withdrawnAt: new Date("2026-11-02T00:00:00Z"),
    });
    expect(currentConsent([older, withdrawn])).toEqual({
      basis: "express",
      obtainedAt: withdrawn.obtainedAt,
      withdrawnAt: withdrawn.withdrawnAt,
    });
    expect(currentConsent([withdrawn, older])?.withdrawnAt).toEqual(withdrawn.withdrawnAt);
  });

  it("breaks ties on id and returns null without records", () => {
    const t = "2026-11-01T00:00:00Z";
    expect(currentConsent([rec("a", t, { basis: "none" }), rec("b", t)])?.basis).toBe("express");
    expect(currentConsent([])).toBeNull();
    expect(currentConsent([rec("a", t)])).not.toHaveProperty("withdrawnAt");
  });
});
