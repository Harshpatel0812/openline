/** Sprint 4 contracts (OL-E4 §4): Scout settings, drafts and the approval flow. */
import { z } from "zod";

export const SCOUT_ACTION_KINDS = ["draft_email", "draft_reply"] as const;
export type ScoutActionKind = (typeof SCOUT_ACTION_KINDS)[number];

export const SCOUT_ACTION_STATUSES = [
  "proposed",
  "approved",
  "rejected",
  "executed",
  "failed",
] as const;
export type ScoutActionStatus = (typeof SCOUT_ACTION_STATUSES)[number];

/** Requests per user per hour for Scout drafts. */
export const SCOUT_DRAFTS_PER_USER_PER_HOUR = 30;
/** 1 AI credit = 1,000 tokens. */
export const SCOUT_TOKENS_PER_CREDIT = 1_000;

const optionalLongText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null));

// ------------------------------------------------------------------ settings

export const ScoutSettingsInputSchema = z
  .object({
    enabled: z.boolean().optional(),
    monthlyCredits: z.coerce.number().int().min(0).max(1_000_000).optional(),
    webResearch: z.boolean().optional(),
    /** What the company does, in a few sentences (drafts may only claim what is said here). */
    aboutUs: optionalLongText(2_000),
    valueProposition: optionalLongText(1_000),
  })
  .strict();
export type ScoutSettingsInput = z.infer<typeof ScoutSettingsInputSchema>;

export interface ScoutUsageDto {
  /** "2026-11" (calendar month, UTC). */
  month: string;
  creditsUsed: number;
  creditsRemaining: number;
  /** ISO time the budget resets (first day of next month, UTC). */
  resetsAt: string;
}

export interface ScoutSettingsDto {
  enabled: boolean;
  monthlyCredits: number;
  webResearch: boolean;
  aboutUs: string | null;
  valueProposition: string | null;
  /** A model provider is configured for this deployment (AI_PROVIDER is not off). */
  providerConfigured: boolean;
  /** enabled && providerConfigured. */
  available: boolean;
  usage: ScoutUsageDto;
}

// ------------------------------------------------------------------ drafts

export const FirstTouchDraftInputSchema = z.object({
  contactId: z.string().uuid(),
  sequenceId: z.string().uuid().optional(),
  stepPosition: z.coerce.number().int().min(1).max(50).optional(),
  /** The rep's one-line note: what this email is for. */
  purpose: z.string().trim().min(3).max(500),
});
export type FirstTouchDraftInput = z.infer<typeof FirstTouchDraftInputSchema>;

export const ReplyDraftInputSchema = z.object({
  messageId: z.string().uuid(),
  instructions: z.string().trim().max(500).optional(),
});
export type ReplyDraftInput = z.infer<typeof ReplyDraftInputSchema>;

export const ApproveAiActionInputSchema = z.object({
  /** The rep's edited body; omitted = approve the proposal as is. */
  finalText: z.string().trim().min(1).max(10_000).optional(),
  /** Edited subject (first-touch drafts only). */
  finalSubject: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((s) => !/[\r\n]/.test(s), "Subject must be one line")
    .optional(),
});
export type ApproveAiActionInput = z.infer<typeof ApproveAiActionInputSchema>;

export const RejectAiActionInputSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type RejectAiActionInput = z.infer<typeof RejectAiActionInputSchema>;

export interface CitationDto {
  claim: string;
  /** A source id from `sources` (contact field id, page URL or "message.inbound"). */
  source: string;
}

export interface ScoutSourceDto {
  id: string;
  kind: "contact_field" | "web_page" | "message";
  label: string;
}

export interface AiActionDto {
  id: string;
  kind: ScoutActionKind;
  status: ScoutActionStatus;
  createdBy: string;
  contactId: string | null;
  messageId: string | null;
  sequenceId: string | null;
  stepPosition: number | null;
  proposal: { subject?: string; body: string; citations: CitationDto[] };
  sources: ScoutSourceDto[];
  /** Whether company web pages were used: fetched now, from the 7-day cache, or not at all. */
  research: "fetched" | "cached" | "failed" | "off" | "none";
  finalSubject: string | null;
  finalText: string | null;
  editDistance: number | null;
  rejectReason: string | null;
  model: string;
  usage: { inputTokens: number; outputTokens: number; credits: number };
  createdAt: string;
  decidedAt: string | null;
}
