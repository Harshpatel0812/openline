/**
 * Compliance Copilot DTOs (OL-E6 §3). The rules themselves live in `packages/compliance`
 * (deterministic, never an LLM); these are the JSON shapes the API returns.
 */
import { z } from "zod";
import type { ConsentDto, ENROLL_SKIP_REASONS } from "./sending";

export const COMPLIANCE_RULE_IDS = [
  "suppression",
  "contact_status",
  "consent_ca",
  "basis_eu",
  "sender_identity",
  "unsubscribe_mechanism",
  "send_window",
] as const;
export type ComplianceRuleId = (typeof COMPLIANCE_RULE_IDS)[number];
export type ComplianceCheckOutcome = "pass" | "fail" | "wait" | "not_applicable";
export type ComplianceDecision = "allowed" | "not_now" | "blocked";
export type ComplianceJurisdiction = "CA" | "US" | "EU" | "OTHER";

export interface ComplianceCheckDto {
  rule: ComplianceRuleId;
  outcome: ComplianceCheckOutcome;
  detail: string;
  citation: string;
  /** A pass that needs attention soon (e.g. CASL implied consent expiring within 30 days). */
  warning?: boolean;
}

/** Stored on every outbound message (`messages.compliance_proof`). Never holds the body. */
export interface ComplianceProofDto {
  rulesetVersion: string;
  channel: "email";
  decision: ComplianceDecision;
  nextAllowedAt?: string;
  jurisdiction: ComplianceJurisdiction;
  evaluatedAt: string;
  checks: ComplianceCheckDto[];
}

/** `send` = a commercial email (sequence step); `reply` = an inbox reply in their conversation. */
export const COMPLIANCE_PURPOSES = ["send", "reply"] as const;
export type CompliancePurpose = (typeof COMPLIANCE_PURPOSES)[number];

/** `GET /v1/contacts/:id/compliance?channel=email[&purpose=send|reply][&sequenceId=]` */
export const ComplianceQuerySchema = z
  .object({
    channel: z.enum(["email"]).default("email"),
    /**
     * `reply` evaluates exactly what an inbox reply enforces: the send window is not applicable
     * and an archived contact who wrote to you may be answered.
     */
    purpose: z.enum(COMPLIANCE_PURPOSES).default("send"),
    /** Use this sequence's send window instead of the default business hours. */
    sequenceId: z.string().uuid().optional(),
  })
  .refine((q) => !(q.purpose === "reply" && q.sequenceId), {
    message: "A reply has no send window; don't pass a sequenceId with purpose=reply",
    path: ["sequenceId"],
  });
export type ComplianceQuery = z.infer<typeof ComplianceQuerySchema>;

export interface ContactComplianceDto extends ComplianceProofDto {
  contactId: string;
  /** Which settings the evaluation used, so the UI can explain (and link to) them. */
  settings: {
    timeZone: string;
    timeZoneSource: "contact" | "workspace";
    sendWindow: { days: number[]; startHour: number; endHour: number };
    sendWindowSource: "default" | "sequence";
    /** What was evaluated: a commercial send or an inbox reply. */
    purpose: CompliancePurpose;
    sequenceId: string | null;
    /** The workspace postal address is on file (sender identity). */
    mailingAddressOnFile: boolean;
  };
}

/** `POST /v1/sequences/:id/enroll/preview` */
export const EnrollPreviewInputSchema = z.object({
  contactIds: z.array(z.string().uuid()).min(1).max(1000),
});
export type EnrollPreviewInput = z.infer<typeof EnrollPreviewInputSchema>;

/** The compliance summary attached to an enroll skip or preview row. */
export interface ContactComplianceSummaryDto {
  decision: ComplianceDecision;
  nextAllowedAt?: string;
  /** The first failing check (or the first `wait` when nothing fails); absent when allowed. */
  check?: ComplianceCheckDto;
}

export interface EnrollPreviewItemDto {
  contactId: string;
  /** Enrolling would add this contact (sending may still wait for business hours). */
  enrollable: boolean;
  /** Why enrolling would skip them (same reasons as `POST /enroll`). */
  skipReason?: (typeof ENROLL_SKIP_REASONS)[number];
  /** Absent for contacts that don't exist in this workspace. */
  compliance?: ContactComplianceSummaryDto;
}

export interface EnrollPreviewDto {
  items: EnrollPreviewItemDto[];
  counts: { enrollable: number; skipped: number; blocked: number };
}

/** `GET /v1/contacts/:id/compliance/record` (JSON download, manager+). */
export interface ComplianceRecordDto {
  kind: "openline.compliance_record";
  exportedAt: string;
  rulesetVersion: string;
  notice: string;
  contact: {
    id: string;
    email: string;
    status: "active" | "bounced" | "unsubscribed" | "archived";
    country: string | null;
    timeZone: string | null;
    consentBasis: ConsentDto["basis"];
    createdAt: string;
  };
  consentRecords: ConsentDto[];
  suppression: {
    suppressed: boolean;
    entries: { scope: "email" | "domain"; reason: string; addedAt: string }[];
  };
  /** Audit trail entries about this contact (unsubscribes, consent changes, imports). */
  history: { action: string; at: string; byUser: boolean; metadata: Record<string, unknown> }[];
  messages: {
    id: string;
    kind: "sequence" | "reply";
    status: string;
    sentAt: string;
    subject: string;
    /** `null` for emails sent before proofs were stored (ruleset introduced Nov 2026). */
    proof: ComplianceProofDto | null;
  }[];
  currentEvaluation: ContactComplianceDto;
}
