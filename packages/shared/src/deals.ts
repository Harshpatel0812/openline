/** Sprint 6 contracts (OL-E7 §1–3): pipeline stages, deals, board summary, timeline. */
import { z } from "zod";
import type { CrmRecordLinkDto } from "./crm";

// ------------------------------------------------------------------ stages

export const STAGE_KINDS = ["open", "won", "lost"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

/** Evidence types the Reality Check understands; `none` = a plain checklist item. */
export const DEAL_EVIDENCE_TYPES = [
  "decision_maker_engaged",
  "budget_discussed",
  "need_confirmed",
  "timeline_discussed",
  "next_step_dated",
  "proposal_sent",
  "verbal_yes",
  "none",
] as const;
export type DealEvidenceType = (typeof DEAL_EVIDENCE_TYPES)[number];

export const PIPELINE_LIMITS = {
  stageName: 40,
  maxStages: 20,
  maxCriteria: 5,
  criterionLabel: 120,
  maxStaleDays: 365,
  dealName: 120,
  nextStep: 200,
  lostReason: 500,
  maxContacts: 20,
  /** Largest amount in minor units (keeps column sums exact as JS numbers). */
  maxAmountMinor: 999_999_999_999,
  /** Snippet length on timeline emails. */
  snippet: 200,
} as const;

/** Stale limit for new stages when none is given. */
export const DEFAULT_STALE_AFTER_DAYS = 14;

export const StageCriterionSchema = z
  .object({
    label: z.string().trim().min(1, "Describe the criterion").max(PIPELINE_LIMITS.criterionLabel),
    evidence: z.enum(DEAL_EVIDENCE_TYPES).default("none"),
  })
  .strict();
export type StageCriterion = z.output<typeof StageCriterionSchema>;

export const StageInputSchema = z
  .object({
    /** Existing stage to keep (rename/reorder/edit); omit to add a new one. */
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1, "Name the stage").max(PIPELINE_LIMITS.stageName),
    probability: z.number().int().min(0).max(100),
    kind: z.enum(STAGE_KINDS).default("open"),
    /** null = never stale. */
    staleAfterDays: z
      .number()
      .int()
      .min(1)
      .max(PIPELINE_LIMITS.maxStaleDays)
      .nullable()
      .default(DEFAULT_STALE_AFTER_DAYS),
    entryCriteria: z.array(StageCriterionSchema).max(PIPELINE_LIMITS.maxCriteria).default([]),
  })
  .strict();
export type StageInput = z.output<typeof StageInputSchema>;

/**
 * Replaces the stage list: array order = board order. Stages left out are archived (only when
 * they hold no deals). Rules: unique names, exactly one won and one lost stage, at least one open
 * stage, open stages before won/lost.
 */
export const ReplaceStagesInputSchema = z
  .object({
    stages: z.array(StageInputSchema).min(3).max(PIPELINE_LIMITS.maxStages),
  })
  .strict()
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    const ids = new Set<string>();
    v.stages.forEach((s, i) => {
      const key = s.name.toLocaleLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["stages", i, "name"],
          message: "Stage names must be unique",
        });
      }
      seen.add(key);
      if (s.id) {
        if (ids.has(s.id)) {
          ctx.addIssue({ code: "custom", path: ["stages", i, "id"], message: "Listed twice" });
        }
        ids.add(s.id);
      }
    });
    for (const kind of ["won", "lost"] as const) {
      if (v.stages.filter((s) => s.kind === kind).length !== 1) {
        ctx.addIssue({
          code: "custom",
          path: ["stages"],
          message: `Keep exactly one ${kind} stage`,
        });
      }
    }
    const firstClosed = v.stages.findIndex((s) => s.kind !== "open");
    if (firstClosed === 0 || v.stages.slice(firstClosed).some((s) => s.kind === "open")) {
      ctx.addIssue({
        code: "custom",
        path: ["stages"],
        message: "Open stages come first, then the won and lost stages",
      });
    }
  });
export type ReplaceStagesInput = z.output<typeof ReplaceStagesInputSchema>;

export interface PipelineStageDto {
  id: string;
  name: string;
  position: number;
  probability: number;
  kind: StageKind;
  staleAfterDays: number | null;
  entryCriteria: StageCriterion[];
  /** Deals currently in this stage (a stage with deals can't be archived). */
  dealCount: number;
}

// ------------------------------------------------------------------ money

/** ISO 4217 code that this runtime knows (e.g. USD, EUR, JPY). */
export const CurrencySchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .refine(isKnownCurrency, { message: "Use an ISO 4217 currency code like USD" });

export function isKnownCurrency(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  if (supported) return supported("currency").includes(code);
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: code });
    return true;
  } catch {
    return false;
  }
}

/** Digits after the decimal point for a currency (USD 2, JPY 0, KWD 3). */
export function currencyMinorDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** "1234.5" → 123450 (USD). Null for invalid input or too many decimals. No floats involved. */
export function toMinorUnits(decimal: string, currency: string): number | null {
  const digits = currencyMinorDigits(currency);
  const m = /^(\d{1,15})(?:\.(\d*))?$/.exec(decimal.trim().replace(/,/g, ""));
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > digits) return null;
  const minor = Number(m[1]! + frac.padEnd(digits, "0"));
  return Number.isSafeInteger(minor) && minor <= PIPELINE_LIMITS.maxAmountMinor ? minor : null;
}

const amountMinor = z.number().int().min(0).max(PIPELINE_LIMITS.maxAmountMinor);

// ------------------------------------------------------------------ deals

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && isRealDate(d), "Invalid date");

function isRealDate(d: string): boolean {
  return new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
}

const queryBool = z
  .enum(["1", "0", "true", "false"])
  .transform((v) => v === "1" || v === "true")
  .optional();

export const DEAL_STATUSES = ["open", "won", "lost", "all"] as const;
export type DealStatusFilter = (typeof DEAL_STATUSES)[number];

export const DealQuerySchema = z
  .object({
    stageId: z.string().uuid().optional(),
    /** A member id, or `me`. */
    ownerId: z.union([z.literal("me"), z.string().uuid()]).optional(),
    contactId: z.string().uuid().optional(),
    companyId: z.string().uuid().optional(),
    /** open = deals in open stages; won / lost; all (default). */
    status: z.enum(DEAL_STATUSES).default("all"),
    stale: queryBool,
    flagged: queryBool,
    closeFrom: isoDate.optional(),
    closeTo: isoDate.optional(),
    q: z.string().trim().max(200).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .refine((v) => !v.closeFrom || !v.closeTo || v.closeFrom <= v.closeTo, {
    message: "closeFrom must be on or before closeTo",
    path: ["closeFrom"],
  });
export type DealQuery = z.output<typeof DealQuerySchema>;

export const DealSummaryQuerySchema = z.object({
  ownerId: z.union([z.literal("me"), z.string().uuid()]).optional(),
});
export type DealSummaryQuery = z.output<typeof DealSummaryQuerySchema>;

export const DealAttentionQuerySchema = z.object({
  /** 1 (default) = my deals; 0 = everyone's (manager and above). */
  mine: z
    .enum(["1", "0", "true", "false"])
    .default("1")
    .transform((v) => v === "1" || v === "true"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type DealAttentionQuery = z.output<typeof DealAttentionQuerySchema>;

const dealName = z.string().trim().min(1, "Name the deal").max(PIPELINE_LIMITS.dealName);
const nextStep = z.string().trim().max(PIPELINE_LIMITS.nextStep);
const contactIds = z
  .array(z.string().uuid())
  .max(PIPELINE_LIMITS.maxContacts, `At most ${PIPELINE_LIMITS.maxContacts} contacts per deal`);

export const CreateDealInputSchema = z
  .object({
    name: dealName,
    companyId: z.string().uuid().nullable().optional(),
    primaryContactId: z.string().uuid().nullable().optional(),
    /** Other contacts (the primary contact is added automatically). ≤ 20 in total. */
    contactIds: contactIds.optional(),
    /** Managers and above may create for a teammate; reps only for themselves. */
    ownerId: z.string().uuid().optional(),
    /** An open stage; defaults to the first open stage. */
    stageId: z.string().uuid().optional(),
    amountMinor: amountMinor.nullable().optional(),
    /** Defaults to the workspace currency. */
    currency: CurrencySchema.optional(),
    expectedCloseDate: isoDate.nullable().optional(),
    nextStep: nextStep.nullable().optional(),
    nextStepDate: isoDate.nullable().optional(),
  })
  .strict();
export type CreateDealInput = z.output<typeof CreateDealInputSchema>;

export const UpdateDealInputSchema = z
  .object({
    name: dealName.optional(),
    companyId: z.string().uuid().nullable().optional(),
    primaryContactId: z.string().uuid().nullable().optional(),
    /** Replaces the deal's contacts (the primary contact is kept/added). */
    contactIds: contactIds.optional(),
    /** Manager and above only. */
    ownerId: z.string().uuid().optional(),
    amountMinor: amountMinor.nullable().optional(),
    currency: CurrencySchema.optional(),
    expectedCloseDate: isoDate.nullable().optional(),
    nextStep: nextStep.nullable().optional(),
    nextStepDate: isoDate.nullable().optional(),
    /** Editable while the deal is lost. */
    lostReason: z.string().trim().min(1).max(PIPELINE_LIMITS.lostReason).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Change at least one field" });
export type UpdateDealInput = z.output<typeof UpdateDealInputSchema>;

export const MoveDealInputSchema = z
  .object({
    stageId: z.string().uuid(),
    /** Required when moving to the lost stage. */
    lostReason: z.string().trim().min(1).max(PIPELINE_LIMITS.lostReason).optional(),
  })
  .strict();
export type MoveDealInput = z.output<typeof MoveDealInputSchema>;

export interface DealContactRefDto {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
}

export interface DealDto {
  id: string;
  name: string;
  company: { id: string; name: string } | null;
  primaryContact: DealContactRefDto | null;
  owner: { id: string; name: string };
  stage: { id: string; name: string; kind: StageKind; probability: number };
  /** Integer minor units (cents); null = no amount. */
  amountMinor: number | null;
  currency: string;
  /** YYYY-MM-DD. */
  expectedCloseDate: string | null;
  nextStep: string | null;
  nextStepDate: string | null;
  lostReason: string | null;
  stageEnteredAt: string;
  /** Latest of: email with a deal contact, task completed on the deal, stage change, edit. */
  lastActivityAt: string;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** CRM sync badge (OL-E8); absent when the workspace has no CRM connection. */
  crm?: CrmRecordLinkDto;
  /** Open, and now − lastActivityAt > the stage's staleAfterDays. */
  isStale: boolean;
  /** Open, and nextStepDate is before today (workspace time zone). */
  nextStepOverdue: boolean;
  /** Open, and expectedCloseDate is before today (workspace time zone). */
  closeDateOverdue: boolean;
  /** Open, past the first open stage, and no next step. */
  missingNextStep: boolean;
  /**
   * Reality Check flags on the deal: the four deterministic ones above that are true, plus the
   * latest check's undismissed model flags (criterion_missing, stage_ahead_of_evidence).
   */
  flagCount: number;
  /** The caller may edit or move this deal (owner, or manager and above). */
  canEdit: boolean;
}

export interface DealDetailDto extends DealDto {
  contacts: DealContactRefDto[];
  stageHistory: DealStageChangeDto[];
}

export interface DealStageChangeDto {
  id: string;
  from: { id: string; name: string } | null;
  to: { id: string; name: string };
  by: { id: string; name: string } | null;
  at: string;
}

export interface DealPageDto {
  items: DealDto[];
  nextCursor: string | null;
}

/** Totals in one currency. Weighted = round(Σ amount × probability / 100), rounded once. */
export interface CurrencyTotalDto {
  currency: string;
  count: number;
  amountMinor: number;
  weightedMinor: number;
}

export interface DealTotalsDto {
  /** All deals, with or without an amount, in any currency. */
  count: number;
  /** In the workspace currency only (see byCurrency for the rest). */
  amountMinor: number;
  weightedMinor: number;
  /** One row per currency used by deals with an amount, workspace currency first. */
  byCurrency: CurrencyTotalDto[];
}

export interface DealSummaryDto {
  /** The workspace currency: amountMinor/weightedMinor are in it. */
  currency: string;
  /** Some deals use another currency: their amounts are only in byCurrency (no conversion). */
  multiCurrency: boolean;
  columns: (DealTotalsDto & { stageId: string })[];
  forecast: {
    /** Open stages. */
    open: DealTotalsDto;
    /** Open deals with an expected close date in this calendar month / quarter (workspace tz). */
    thisMonth: DealTotalsDto;
    thisQuarter: DealTotalsDto;
  };
}

export type DealTimelineItemDto =
  | {
      kind: "email";
      id: string;
      at: string;
      direction: "inbound" | "outbound";
      /** null when the email is in a teammate's mailbox the caller can't read. */
      subject: string | null;
      /**
       * true = in a teammate's mailbox (a rep reading someone else's mail): only direction and
       * date are shown, as "Email (in a teammate's mailbox)". Managers and above read all.
       */
      teammateMailbox: boolean;
      /** Inbound only, ≤ 200 characters, plain text; null when not visible to the caller. */
      snippet: string | null;
      messageId: string;
      contactId: string | null;
    }
  | {
      kind: "stage_change";
      id: string;
      at: string;
      from: { id: string; name: string } | null;
      to: { id: string; name: string };
      by: { id: string; name: string } | null;
    }
  | {
      kind: "task";
      id: string;
      at: string;
      taskId: string;
      /** null when the caller can't see the task (not theirs, not a manager). */
      title: string | null;
      status: "open" | "done" | "dismissed";
    }
  | {
      kind: "edit";
      id: string;
      at: string;
      by: { id: string; name: string } | null;
      fields: string[];
    };

export interface DealTimelineDto {
  items: DealTimelineItemDto[];
}

/** Today: "Deals needing attention" (stale or next-step date passed). */
export interface DealAttentionDto {
  items: DealDto[];
}

/** Inbox "Create deal": prefill for the form, and the contact's open deals. */
export interface DealPrefillDto {
  name: string;
  contactId: string | null;
  companyId: string | null;
  openDeals: { id: string; name: string; stageName: string }[];
}
