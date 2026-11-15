/**
 * Plain-language labels for Compliance Copilot (OL-E6 §3). The rules run in the API
 * (`packages/compliance`); the web app only explains their answers.
 */
import type {
  ComplianceCheckDto,
  ComplianceCheckOutcome,
  ComplianceDecision,
  ComplianceRuleId,
} from "@openline/shared";
import { formatInZone } from "./tasks";

export const RULE_LABELS: Record<ComplianceRuleId, string> = {
  suppression: "Suppression list",
  contact_status: "Contact status",
  consent_ca: "Canadian consent (CASL)",
  basis_eu: "EU/UK lawful basis (GDPR)",
  sender_identity: "Sender identity and postal address",
  unsubscribe_mechanism: "Unsubscribe link",
  send_window: "Business hours (an Openline policy)",
};

export const OUTCOME_LABELS: Record<ComplianceCheckOutcome, string> = {
  pass: "Passed",
  fail: "Blocks sending",
  wait: "Wait",
  not_applicable: "Doesn't apply",
};

export const DECISION_LABELS: Record<ComplianceDecision, string> = {
  allowed: "Allowed",
  not_now: "Not right now",
  blocked: "Blocked",
};

export const DECISION_TONES: Record<ComplianceDecision, "success" | "warning" | "danger"> = {
  allowed: "success",
  not_now: "warning",
  blocked: "danger",
};

export const JURISDICTION_LABELS: Record<string, string> = {
  CA: "Canada",
  US: "United States",
  EU: "EU / UK",
  OTHER: "Other country",
};

export const NOT_LEGAL_ADVICE = "This is not legal advice.";

/**
 * The engine's details name times as ISO strings ("next allowed at 2026-11-16T14:00:00.000Z");
 * show them as readable times in the given zone.
 */
export function readableDetail(detail: string, timeZone?: string): string {
  return detail.replace(
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/g,
    (iso) => formatInZone(iso, timeZone),
  );
}

/** "Suppression list: This address is on your suppression list." */
export function checkSummary(check: ComplianceCheckDto, timeZone?: string): string {
  return `${RULE_LABELS[check.rule]}: ${readableDetail(check.detail, timeZone)}`;
}

/**
 * Which rule an enrollment's `lastDecision` comes from, so sequence tables use the same labels as
 * the contact page. Codes that aren't about compliance return undefined.
 */
const DECISION_RULES: Record<string, ComplianceRuleId | "consent"> = {
  suppressed: "suppression",
  unsubscribed: "contact_status",
  bounced: "contact_status",
  contact_archived: "contact_status",
  no_consent: "consent",
  mailing_address_missing: "sender_identity",
  outside_send_window: "send_window",
};

export function complianceRuleForDecision(code: string | null): string | undefined {
  if (!code) return undefined;
  const rule = DECISION_RULES[code];
  if (!rule) return undefined;
  return rule === "consent" ? "Consent (CASL) or lawful basis (GDPR)" : RULE_LABELS[rule];
}
