/**
 * Compliance Copilot: "Can I email this contact right now?" (OL-E6 §3).
 *
 * One deterministic engine used by the sending engine, inbox replies, the enroll dialog and the
 * contact page, so all of them give the same answer for the same facts. Every rule is checked and
 * reported (so the result doubles as proof), each with a plain-language detail and a citation.
 *
 * Decision: any `fail` → `blocked`; otherwise any `wait` → `not_now` (with `nextAllowedAt`);
 * otherwise `allowed`. Citations explain the rule; they are not legal advice.
 */
import {
  canSendCommercialEmail,
  consentExpiresAt,
  type ConsentRecord,
  type Jurisdiction,
} from "./consent";
import { jurisdictionFor } from "./jurisdiction";
import {
  DEFAULT_SEND_WINDOW,
  isWithinSendWindow,
  nextSendWindowStart,
  type SendWindow,
} from "./send-window";
import { isSuppressed } from "./suppression";

/** Bump when any rule's outcome or wording changes; stored with every proof. */
export const RULESET_VERSION = "2026-11-15.1";

/** Stable rule ids, in the order they are checked and reported. */
export const RULE_IDS = [
  "suppression",
  "contact_status",
  "consent_ca",
  "basis_eu",
  "sender_identity",
  "unsubscribe_mechanism",
  "send_window",
] as const;
export type RuleId = (typeof RULE_IDS)[number];

export type CheckOutcome = "pass" | "fail" | "wait" | "not_applicable";
export type ComplianceDecision = "allowed" | "not_now" | "blocked";

export interface Check {
  rule: RuleId;
  outcome: CheckOutcome;
  /** Plain language, safe to show to the rep. Never contains the email address. */
  detail: string;
  /** The law (and section) or Openline policy behind the rule. */
  citation: string;
  /** A pass that needs attention soon (CASL implied consent expiring within 30 days). */
  warning?: boolean;
}

export type ContactStatus = "active" | "bounced" | "unsubscribed" | "archived";

export interface EmailContactInput {
  /** The recipient address. */
  email: string;
  country?: string | null;
  /** `null` when the recipient isn't a saved contact (e.g. a reply to a different address). */
  status: ContactStatus | null;
  /** The contact's IANA time zone, or the workspace default when the contact has none. */
  timeZone: string;
  /** The consent record the caller treats as current (usually the latest one). */
  consent?: ConsentRecord | null;
  /** Suppression entries that could match: full emails and `@domain` values. */
  suppressions: ReadonlySet<string> | readonly string[];
  /** The workspace's postal address (shown in every email footer). */
  mailingAddress: string | null | undefined;
  /** Business hours for the send window; defaults to Mon–Fri 9:00–18:00 local. */
  sendWindow?: SendWindow;
  /**
   * `sequence` (default): every rule. `reply`: a 1:1 reply in a conversation the contact started —
   * the send window doesn't apply and archiving (a CRM state, not an opt-out) doesn't block.
   */
  context?: "sequence" | "reply";
}

export interface EmailEvaluation {
  rulesetVersion: string;
  channel: "email";
  decision: ComplianceDecision;
  /** Only when `decision` is `not_now`: the earliest time every rule passes. */
  nextAllowedAt?: Date;
  jurisdiction: Jurisdiction;
  evaluatedAt: Date;
  checks: Check[];
}

/** The JSON stored on `messages.compliance_proof`. No message body, no email address. */
export interface ComplianceProof {
  rulesetVersion: string;
  channel: "email";
  decision: ComplianceDecision;
  nextAllowedAt?: string;
  jurisdiction: Jurisdiction;
  evaluatedAt: string;
  checks: Check[];
}

/** Days before a CASL implied consent expires when the check starts warning. */
export const CONSENT_WARNING_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const CITATIONS = {
  suppression:
    "Opt-outs must be honoured: CAN-SPAM Act, 15 U.S.C. 7704(a)(4); CASL s. 11(3) (within 10 business days). Your suppression list also holds addresses and domains you chose never to email.",
  unsubscribed:
    "Opt-outs must be honoured: CAN-SPAM Act, 15 U.S.C. 7704(a)(4); CASL s. 11(3); GDPR Art. 21(3) (an objection to direct marketing ends it).",
  bounced:
    "Openline policy (not a legal rule): addresses that hard-bounced are not emailed again, to protect your sender reputation.",
  archived: "Openline policy (not a legal rule): archived contacts are not emailed from sequences.",
  contactStatus:
    "Opt-outs must be honoured: CAN-SPAM Act, 15 U.S.C. 7704(a)(4); CASL s. 11(3); GDPR Art. 21(3).",
  consentCa:
    "CASL s. 6: commercial email to Canada needs express or implied consent; s. 10(9)–(10): implied consent from an existing business relationship lasts 2 years after a purchase or 6 months after an inquiry.",
  basisEu:
    "GDPR Art. 6(1): processing personal data needs a lawful basis (such as consent or legitimate interest); Art. 21: people can object to direct marketing at any time. The UK GDPR has the same articles.",
  senderIdentity:
    "CAN-SPAM Act, 15 U.S.C. 7704(a)(5): a valid physical postal address and a clear opt-out notice in every commercial email; CASL s. 6(2): identify the sender and how to contact them.",
  unsubscribeMechanism:
    "CAN-SPAM Act, 15 U.S.C. 7704(a)(3) and (a)(5): a working opt-out in every commercial email; CASL s. 6(2)(c) and s. 11: an unsubscribe mechanism in every message.",
  sendWindow:
    "Openline policy (not a legal rule): contact people only during business hours in their own time zone.",
} as const;

const BASIS_LABEL: Record<ConsentRecord["basis"], string> = {
  express: "express consent",
  implied_purchase: "implied consent (purchase)",
  implied_inquiry: "implied consent (inquiry)",
  legitimate_interest: "legitimate interest",
  none: "no consent",
};

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

function suppressionCheck(input: EmailContactInput): Check {
  const list = input.suppressions instanceof Set ? input.suppressions : new Set(input.suppressions);
  const normalised = input.email.trim().toLowerCase();
  if (normalised.lastIndexOf("@") < 1) {
    return {
      rule: "suppression",
      outcome: "fail",
      detail: "This isn't a valid email address, so it is never emailed.",
      citation: CITATIONS.suppression,
    };
  }
  if (isSuppressed(input.email, list)) {
    return {
      rule: "suppression",
      outcome: "fail",
      detail: list.has(normalised)
        ? "This address is on your suppression list."
        : "This address's whole domain is on your suppression list.",
      citation: CITATIONS.suppression,
    };
  }
  return {
    rule: "suppression",
    outcome: "pass",
    detail: "Not on your suppression list.",
    citation: CITATIONS.suppression,
  };
}

function contactStatusCheck(input: EmailContactInput): Check {
  const rule = "contact_status" as const;
  switch (input.status) {
    case null:
      return {
        rule,
        outcome: "not_applicable",
        detail: "The recipient isn't a saved contact.",
        citation: CITATIONS.contactStatus,
      };
    case "unsubscribed":
      return {
        rule,
        outcome: "fail",
        detail: "This contact unsubscribed.",
        citation: CITATIONS.unsubscribed,
      };
    case "bounced":
      return {
        rule,
        outcome: "fail",
        detail: "Emails to this address bounced.",
        citation: CITATIONS.bounced,
      };
    case "archived":
      return input.context === "reply"
        ? {
            rule,
            outcome: "pass",
            detail: "Archived, but they wrote to you: replying in their conversation is fine.",
            citation: CITATIONS.archived,
          }
        : {
            rule,
            outcome: "fail",
            detail: "This contact is archived.",
            citation: CITATIONS.archived,
          };
    default:
      return {
        rule,
        outcome: "pass",
        detail: "Active: not unsubscribed, bounced or archived.",
        citation: CITATIONS.contactStatus,
      };
  }
}

function consentCaCheck(input: EmailContactInput, jurisdiction: Jurisdiction, at: Date): Check {
  const rule = "consent_ca" as const;
  const citation = CITATIONS.consentCa;
  if (jurisdiction !== "CA") {
    return { rule, outcome: "not_applicable", detail: "Not a Canadian recipient.", citation };
  }
  const consent = input.consent ?? undefined;
  const permission = canSendCommercialEmail("CA", consent, at);
  if (!permission.allowed) return { rule, outcome: "fail", detail: permission.reason, citation };
  // Allowed means a non-withdrawn express or unexpired implied record exists.
  const record = consent!;
  const expiresAt = consentExpiresAt(record);
  if (expiresAt && expiresAt.getTime() - at.getTime() <= CONSENT_WARNING_DAYS * DAY_MS) {
    return {
      rule,
      outcome: "pass",
      warning: true,
      detail: `Valid ${BASIS_LABEL[record.basis]}, but it expires on ${isoDate(expiresAt)}. Ask for express consent before then.`,
      citation,
    };
  }
  return {
    rule,
    outcome: "pass",
    detail: expiresAt
      ? `Valid ${BASIS_LABEL[record.basis]} until ${isoDate(expiresAt)}.`
      : `Valid ${BASIS_LABEL[record.basis]} (doesn't expire until withdrawn).`,
    citation,
  };
}

function basisEuCheck(input: EmailContactInput, jurisdiction: Jurisdiction, at: Date): Check {
  const rule = "basis_eu" as const;
  const citation = CITATIONS.basisEu;
  if (jurisdiction !== "EU") {
    return { rule, outcome: "not_applicable", detail: "Not an EU/UK recipient.", citation };
  }
  const consent = input.consent ?? undefined;
  const permission = canSendCommercialEmail("EU", consent, at);
  if (!permission.allowed) return { rule, outcome: "fail", detail: permission.reason, citation };
  return {
    rule,
    outcome: "pass",
    detail: `Lawful basis recorded: ${BASIS_LABEL[consent!.basis]}.`,
    citation,
  };
}

function senderIdentityCheck(input: EmailContactInput): Check {
  return input.mailingAddress
    ? {
        rule: "sender_identity",
        outcome: "pass",
        detail: "Your workspace postal address and name are added to every email.",
        citation: CITATIONS.senderIdentity,
      }
    : {
        rule: "sender_identity",
        outcome: "fail",
        detail: "Add your postal address in Workspace settings: it's required in every email.",
        citation: CITATIONS.senderIdentity,
      };
}

function unsubscribeCheck(): Check {
  return {
    rule: "unsubscribe_mechanism",
    outcome: "pass",
    detail: "Openline adds an unsubscribe link and one-click unsubscribe headers to every email.",
    citation: CITATIONS.unsubscribeMechanism,
  };
}

function sendWindowCheck(input: EmailContactInput, at: Date): { check: Check; next?: Date } {
  const rule = "send_window" as const;
  const citation = CITATIONS.sendWindow;
  if (input.context === "reply") {
    return {
      check: {
        rule,
        outcome: "not_applicable",
        detail: "A reply in a conversation the contact started: business hours don't apply.",
        citation,
      },
    };
  }
  const window = input.sendWindow ?? DEFAULT_SEND_WINDOW;
  try {
    if (isWithinSendWindow(at, input.timeZone, window)) {
      return {
        check: {
          rule,
          outcome: "pass",
          detail: `Inside business hours in ${input.timeZone}.`,
          citation,
        },
      };
    }
    const next = nextSendWindowStart(at, input.timeZone, window);
    return {
      check: {
        rule,
        outcome: "wait",
        detail: `Outside business hours in ${input.timeZone}; next allowed at ${next.toISOString()}.`,
        citation,
      },
      next,
    };
  } catch {
    return {
      check: {
        rule,
        outcome: "fail",
        detail: "The contact's time zone (or the send window) isn't valid. Fix it on the contact.",
        citation,
      },
    };
  }
}

/** Evaluates every email rule for one recipient at instant `at`. Pure and deterministic. */
export function evaluateEmailContact(input: EmailContactInput, at: Date): EmailEvaluation {
  const jurisdiction = jurisdictionFor(input.country, input.email);
  const window = sendWindowCheck(input, at);
  const checks: Check[] = [
    suppressionCheck(input),
    contactStatusCheck(input),
    consentCaCheck(input, jurisdiction, at),
    basisEuCheck(input, jurisdiction, at),
    senderIdentityCheck(input),
    unsubscribeCheck(),
    window.check,
  ];
  const decision: ComplianceDecision = checks.some((c) => c.outcome === "fail")
    ? "blocked"
    : checks.some((c) => c.outcome === "wait")
      ? "not_now"
      : "allowed";
  return {
    rulesetVersion: RULESET_VERSION,
    channel: "email",
    decision,
    ...(decision === "not_now" ? { nextAllowedAt: window.next } : {}),
    jurisdiction,
    evaluatedAt: at,
    checks,
  };
}

/** The first check that stops sending: a `fail`, else a `wait`; `undefined` when allowed. */
export function firstBlockingCheck(evaluation: EmailEvaluation): Check | undefined {
  return (
    evaluation.checks.find((c) => c.outcome === "fail") ??
    evaluation.checks.find((c) => c.outcome === "wait")
  );
}

/** The failing check for `rule`, if any. */
export function failed(evaluation: EmailEvaluation, rule: RuleId): Check | undefined {
  return evaluation.checks.find((c) => c.rule === rule && c.outcome === "fail");
}

/** Serialises an evaluation for storage as proof (ISO dates, plain JSON). */
export function toComplianceProof(evaluation: EmailEvaluation): ComplianceProof {
  return {
    rulesetVersion: evaluation.rulesetVersion,
    channel: evaluation.channel,
    decision: evaluation.decision,
    ...(evaluation.nextAllowedAt ? { nextAllowedAt: evaluation.nextAllowedAt.toISOString() } : {}),
    jurisdiction: evaluation.jurisdiction,
    evaluatedAt: evaluation.evaluatedAt.toISOString(),
    checks: evaluation.checks.map((c) => ({ ...c })),
  };
}
