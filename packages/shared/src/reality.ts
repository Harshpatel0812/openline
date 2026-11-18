/** Sprint 6 contracts (OL-E7 §4): Pipeline Reality Check. */
import { z } from "zod";

/** Evidence types the Reality Check extracts (same list as packages/ai, without `none`). */
export const REALITY_EVIDENCE_TYPES = [
  "decision_maker_engaged",
  "budget_discussed",
  "need_confirmed",
  "timeline_discussed",
  "next_step_dated",
  "proposal_sent",
  "verbal_yes",
] as const;
export type RealityEvidenceType = (typeof REALITY_EVIDENCE_TYPES)[number];

export const REALITY_EVIDENCE_LABELS: Record<RealityEvidenceType, string> = {
  decision_maker_engaged: "Decision maker engaged",
  budget_discussed: "Budget discussed",
  need_confirmed: "Need confirmed",
  timeline_discussed: "Timeline discussed",
  next_step_dated: "Next step with a date",
  proposal_sent: "Proposal sent",
  verbal_yes: "Verbal yes",
};

export const REALITY_PRESENCE = ["yes", "no", "unclear"] as const;
export type RealityPresence = (typeof REALITY_PRESENCE)[number];

export const REALITY_FLAG_CODES = [
  "criterion_missing",
  "stage_ahead_of_evidence",
  "next_step_overdue",
  "no_next_step",
  "close_date_passed",
  "stale",
] as const;
export type RealityFlagCode = (typeof REALITY_FLAG_CODES)[number];
/** Flags that need the model's evidence (the rest are date/activity rules). */
export const REALITY_MODEL_FLAG_CODES = ["criterion_missing", "stage_ahead_of_evidence"] as const;
export type RealityFlagSeverity = "high" | "medium" | "low";

export const REALITY_LIMITS = {
  /** "Check now" runs per deal per day (UTC). */
  runsPerDealPerDay: 10,
  /** Share of the workspace's monthly Scout credits the Reality Check may use. */
  budgetShare: 0.25,
  /** Emails looked at: last N days, at most M messages / C characters. */
  lookbackDays: 90,
  maxMessages: 30,
  maxChars: 30_000,
  quoteMax: 300,
  dismissReason: 300,
} as const;

export const REALITY_SUGGESTION_STATUSES = [
  "proposed",
  "approved",
  "rejected",
  "executed",
  "failed",
] as const;
export type RealitySuggestionStatus = (typeof REALITY_SUGGESTION_STATUSES)[number];

// ------------------------------------------------------------------ inputs

export const RealityFlagDismissInputSchema = z.object({
  /** "Not right — we discussed this on a call". */
  reason: z.string().trim().min(1, "Say why").max(REALITY_LIMITS.dismissReason),
});
export type RealityFlagDismissInput = z.output<typeof RealityFlagDismissInputSchema>;

export const RealitySuggestionDismissInputSchema = z.object({
  reason: z.string().trim().max(REALITY_LIMITS.dismissReason).optional(),
});
export type RealitySuggestionDismissInput = z.output<typeof RealitySuggestionDismissInputSchema>;

/** :flagId path parameter (16 hex characters, stable per code + criterion). */
export const RealityFlagIdSchema = z.string().regex(/^[0-9a-f]{16}$/, "Unknown flag");

// ------------------------------------------------------------------ DTOs

export interface RealityEvidenceItemDto {
  present: RealityPresence;
  /** Verbatim words from the email (≤ 300 characters). Hidden when the viewer can't see it. */
  quote?: string;
  /** The message the quote comes from (link to it in the timeline). */
  messageId?: string;
  /** True when a quote exists but is from another rep's mailbox the viewer can't read. */
  quoteHidden?: boolean;
}

export interface RealityFlagDto {
  /** Stable for the same code + criterion across runs. */
  id: string;
  code: RealityFlagCode;
  severity: RealityFlagSeverity;
  message: string;
  criterionKey?: RealityEvidenceType;
  criterion?: {
    stageId: string;
    stageName: string;
    label: string;
    evidence: RealityEvidenceType;
  };
  quote?: string;
  messageId?: string;
  quoteHidden?: boolean;
  /** Set when someone marked the flag "Not right" (until new activity brings it back). */
  dismissed?: { reason: string; at: string; by: { id: string; name: string } };
}

export interface RealitySuggestionDto {
  /** The ai_actions proposal (kind deal_stage_move). */
  actionId: string;
  toStageId: string;
  toStageName: string;
  reason: string;
  status: RealitySuggestionStatus;
}

export interface RealityCheckDto {
  dealId: string;
  ranAt: string;
  /** The deal's stage when it was checked (model flags count only while it is still there). */
  stageId: string;
  /** manual = "Check now"; scheduled = the daily run. */
  trigger: "manual" | "scheduled";
  /** Model used for the evidence step; absent when only the deterministic rules ran. */
  model?: string;
  /** Per evidence type. Empty object when deterministicOnly. */
  evidence: Partial<Record<RealityEvidenceType, RealityEvidenceItemDto>>;
  /** Visible and dismissed flags (dismissed ones carry `dismissed`). */
  flags: RealityFlagDto[];
  /** The furthest open stage the evidence supports. */
  evidenceStageId?: string;
  /** Latest stage-move proposal for this check (any status). */
  suggestion?: RealitySuggestionDto;
  /** True when Scout was off, no provider was configured, or the budget was used up. */
  deterministicOnly: boolean;
  /** Why the model step didn't run (only when deterministicOnly). */
  deterministicReason?: "scout_off" | "no_provider" | "budget" | "no_emails" | "model_error";
  /** "Check now" runs left today for this deal. */
  runsLeftToday: number;
}

export interface RealityCheckResponseDto {
  /** null when the deal was never checked. */
  check: RealityCheckDto | null;
}

/*
 * Endpoints (all under /v1, see docs/api/README.md "Reality Check"):
 *   POST /deals/:id/reality-check                         → RealityCheckDto (429 rate_limited)
 *   GET  /deals/:id/reality-check                         → RealityCheckResponseDto
 *   POST /deals/:id/reality-check/flags/:flagId/dismiss   RealityFlagDismissInput → RealityCheckDto
 *   POST /deals/:id/reality-check/suggestion/accept       → { deal: DealDetailDto, check: RealityCheckDto }
 *   POST /deals/:id/reality-check/suggestion/dismiss      RealitySuggestionDismissInput → RealityCheckDto
 */
