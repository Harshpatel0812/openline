/**
 * CRM sync (OL-E8, ADR 0006): constants, input schemas and DTOs shared by the API, the worker,
 * packages/crm and the web app.
 */
import { z } from "zod";

export const CRM_PROVIDERS = ["hubspot", "pipedrive"] as const;
export type CrmProvider = (typeof CRM_PROVIDERS)[number];

export const CRM_PROVIDER_LABELS: Record<CrmProvider, string> = {
  hubspot: "HubSpot",
  pipedrive: "Pipedrive",
};

export const CRM_OBJECTS = ["contact", "company", "deal"] as const;
export type CrmObject = (typeof CRM_OBJECTS)[number];

/** needs_setup → previewing → importing → active ⇄ paused; error = reconnect needed. */
export const CRM_CONNECTION_STATUSES = [
  "needs_setup",
  "previewing",
  "importing",
  "active",
  "paused",
  "error",
  "disconnected",
] as const;
export type CrmConnectionStatus = (typeof CRM_CONNECTION_STATUSES)[number];

export const CRM_LINK_STATES = [
  "linked",
  "creating",
  "unconfirmed",
  "unlinked",
  "tombstone",
] as const;
export type CrmLinkState = (typeof CRM_LINK_STATES)[number];

export const CRM_DIRECTIONS = ["both", "to_crm", "from_crm", "off"] as const;
export type CrmDirection = (typeof CRM_DIRECTIONS)[number];

export const CRM_SOURCES_OF_TRUTH = ["newest", "openline", "crm"] as const;
export type CrmSourceOfTruth = (typeof CRM_SOURCES_OF_TRUTH)[number];

/** Which new Openline contacts are pushed: engaged = on a deal, replied, or in a sequence. */
export const CRM_CONTACT_PUSH_RULES = ["engaged", "all", "never"] as const;
export type CrmContactPushRule = (typeof CRM_CONTACT_PUSH_RULES)[number];

export const CRM_RUN_KINDS = ["preview", "import", "incremental", "reconcile"] as const;
export type CrmRunKind = (typeof CRM_RUN_KINDS)[number];

export const CRM_RUN_STATUSES = ["running", "succeeded", "partial", "failed"] as const;
export type CrmRunStatus = (typeof CRM_RUN_STATUSES)[number];

/** Stable per-record error codes (crm_sync_errors.code). Messages are ours, never CRM text. */
export const CRM_ERROR_CODES = [
  "validation",
  "currency_mismatch",
  "missing_property",
  "merge_conflict",
  "unconfirmed",
  "not_found",
  "remote_rejected",
  "invalid_email",
] as const;
export type CrmErrorCode = (typeof CRM_ERROR_CODES)[number];

export const CRM_LIMITS = {
  /** Extra (custom) field mappings per object. */
  maxCustomMappings: 20,
  /** Preview lifetime. */
  previewTtlMs: 60 * 60 * 1000,
  /** Example ids kept per preview bucket (ids only, no values). */
  previewExamples: 20,
  /** Openline limits for pulled text. */
  nameMax: 120,
  titleMax: 200,
  customValueMax: 500,
  phoneMax: 32,
  errorMessageMax: 500,
  /** "Sync now" per connection per hour. */
  syncNowPerHour: 6,
  /** Extra HubSpot deal contacts pulled into deal_contacts. */
  dealContactsMax: 20,
} as const;

/** Polling cadence (ADR 0006). Configurable per deployment (CRM_*_INTERVAL_MS). */
export const CRM_SYNC_DEFAULTS = {
  hubspotIntervalMs: 10 * 60 * 1000,
  pipedriveIntervalMs: 15 * 60 * 1000,
  idleIntervalMs: 30 * 60 * 1000,
  /** Empty polls in a row before backing off to idleIntervalMs. */
  emptyPollsBeforeIdle: 4,
  /** A paused connection still refreshes its token this often (Pipedrive refresh tokens expire). */
  pausedRefreshMs: 7 * 24 * 60 * 60 * 1000,
  /** Our own per-connection share of Pipedrive's company-wide daily token budget. */
  pipedriveDailyTokenCap: 15_000,
  leaseMinutes: 10,
} as const;

// ------------------------------------------------------------------ entitlement

/** Plans that include CRM sync (open question 1: Team and up). */
export const CRM_SYNC_PLANS = ["team", "growth", "scale"] as const;

/**
 * Whether a workspace may use CRM sync. There is no billing/entitlement system yet, so this is a
 * workspace feature flag (`workspaces.crm_sync_enabled`, migration 0014): true/false force it;
 * NULL (default) follows the plan — Team, Growth and Scale yes, Solo no, and the free trial yes
 * (trials try the Team feature set).
 */
export function crmSyncEntitled(ws: { plan: string; crmSyncEnabled: boolean | null }): boolean {
  if (ws.crmSyncEnabled !== null) return ws.crmSyncEnabled;
  if (ws.plan === "trial") return true;
  return (CRM_SYNC_PLANS as readonly string[]).includes(ws.plan);
}

// ------------------------------------------------------------------ field names

/** Standard Openline fields per object that a mapping can sync (email is the key, never mapped). */
export const CRM_STANDARD_FIELDS = {
  contact: ["firstName", "lastName", "title", "phone", "companyId", "ownerId"],
  company: ["name", "domain"],
  deal: [
    "name",
    "amount",
    "stage",
    "expectedCloseDate",
    "lostReason",
    "companyId",
    "primaryContactId",
    "ownerId",
  ],
} as const satisfies Record<CrmObject, readonly string[]>;

const CUSTOM_KEY = /^custom\.[a-z][a-z0-9_]{0,39}$/;
const REMOTE_FIELD = /^[A-Za-z0-9_.:-]{1,100}$/;

export const CrmProviderSchema = z.enum(CRM_PROVIDERS);
export const CrmObjectSchema = z.enum(CRM_OBJECTS);

export const CrmFieldMappingInputSchema = z
  .object({
    object: CrmObjectSchema,
    /** A standard field (see CRM_STANDARD_FIELDS) or `custom.<key>`. */
    localField: z.string().trim().max(48),
    /** CRM property / field key; null = standard default (or unmapped). */
    remoteField: z.string().trim().regex(REMOTE_FIELD, "Invalid CRM field").nullable(),
    direction: z.enum(CRM_DIRECTIONS),
    sourceOfTruth: z.enum(CRM_SOURCES_OF_TRUTH).default("newest"),
  })
  .refine(
    (m) =>
      (CRM_STANDARD_FIELDS[m.object] as readonly string[]).includes(m.localField) ||
      CUSTOM_KEY.test(m.localField),
    { message: "Unknown Openline field", path: ["localField"] },
  )
  // Deals have no Openline custom fields (OL-E7).
  .refine((m) => !(m.object === "deal" && m.localField.startsWith("custom.")), {
    message: "Deals have no custom fields",
    path: ["localField"],
  })
  .refine((m) => !m.localField.startsWith("custom.") || m.remoteField !== null, {
    message: "Pick the CRM field",
    path: ["remoteField"],
  });
export type CrmFieldMappingInput = z.infer<typeof CrmFieldMappingInputSchema>;

export const CrmFieldMappingsInputSchema = z
  .object({ mappings: z.array(CrmFieldMappingInputSchema).max(100) })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    const custom: Record<string, number> = {};
    v.mappings.forEach((m, i) => {
      const key = `${m.object}:${m.localField}`;
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", message: "Mapped twice", path: ["mappings", i] });
      }
      seen.add(key);
      if (m.localField.startsWith("custom.")) custom[m.object] = (custom[m.object] ?? 0) + 1;
    });
    for (const [object, n] of Object.entries(custom)) {
      if (n > CRM_LIMITS.maxCustomMappings) {
        ctx.addIssue({
          code: "custom",
          message: `At most ${CRM_LIMITS.maxCustomMappings} extra fields per ${object}`,
          path: ["mappings"],
        });
      }
    }
  });

const RemoteId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_:@.-]{1,64}$/, "Invalid CRM id");

export const CrmStageMappingsInputSchema = z.object({
  /** Every CRM stage of the chosen pipeline → one Openline stage (many-to-one allowed). */
  fromCrm: z.array(z.object({ remoteStageId: RemoteId, stageId: z.string().uuid() })).max(100),
  /** Every active Openline stage → one CRM stage. */
  toCrm: z.array(z.object({ stageId: z.string().uuid(), remoteStageId: RemoteId })).max(100),
});
export type CrmStageMappingsInput = z.infer<typeof CrmStageMappingsInputSchema>;

export const CrmOptionsSchema = z.object({
  contactPush: z.enum(CRM_CONTACT_PUSH_RULES),
  activityNotes: z.boolean(),
  pipedriveDailyCap: z.number().int().min(1_000).max(1_000_000),
});
export type CrmOptions = z.infer<typeof CrmOptionsSchema>;

export const CRM_DEFAULT_OPTIONS: CrmOptions = {
  contactPush: "engaged",
  activityNotes: false,
  pipedriveDailyCap: CRM_SYNC_DEFAULTS.pipedriveDailyTokenCap,
};

export const CrmConnectionPatchSchema = z
  .object({
    pipelineId: RemoteId.optional(),
    defaultOwnerId: z.string().uuid().optional(),
    options: CrmOptionsSchema.partial().strict().optional(),
  })
  .strict();
export type CrmConnectionPatch = z.infer<typeof CrmConnectionPatchSchema>;

export const CrmImportInputSchema = z.object({
  previewId: z.string().uuid(),
  confirmLawfulBasis: z.literal(true, {
    message: "Confirm you have a lawful basis to contact these people",
  }),
  pushLocalOnly: z.boolean().default(false),
});
export type CrmImportInput = z.infer<typeof CrmImportInputSchema>;

export const CrmPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

export const CrmErrorsQuerySchema = CrmPageQuerySchema.extend({
  object: CrmObjectSchema.optional(),
  code: z.enum(CRM_ERROR_CODES).optional(),
  open: z.enum(["true", "false"]).default("true"),
});

export const CrmRemoteFieldsQuerySchema = z.object({ object: CrmObjectSchema });

// ------------------------------------------------------------------ DTOs

export interface CrmStatusDto {
  /** Whether this workspace's plan (or feature flag) includes CRM sync. */
  entitled: boolean;
  /** Providers configured on this server. */
  available: CrmProvider[];
  connection: CrmConnectionDto | null;
}

export interface CrmConnectionDto {
  id: string;
  provider: CrmProvider;
  status: CrmConnectionStatus;
  accountId: string | null;
  accountName: string | null;
  connectedBy: { id: string; name: string } | null;
  connectedAt: string;
  pipelineId: string | null;
  defaultOwnerId: string | null;
  options: CrmOptions;
  /** Optional scope state, e.g. HubSpot opt-out push needs communication_preferences.write. */
  canPushOptOuts: boolean;
  warnings: string[];
  /** Deal sync waits for a complete stage mapping ("Stage mapping needs attention"). */
  stageMappingComplete: boolean;
  lastSyncAt: string | null;
  nextSyncAt: string | null;
  lastError: string | null;
  /** Set while paused for the day's Pipedrive budget or a 429 window. */
  resumesAt: string | null;
  openErrors: number;
  budget: { day: string | null; spent: number; cap: number } | null;
}

export interface CrmRemoteStageDto {
  id: string;
  name: string;
  kind: "open" | "won" | "lost";
}
export interface CrmPipelineDto {
  id: string;
  name: string;
  stages: CrmRemoteStageDto[];
}

export interface CrmRemoteFieldDto {
  key: string;
  label: string;
  type: "text" | "number" | "date" | "boolean" | "enumeration";
  readOnly: boolean;
}

export interface CrmFieldMappingDto {
  id: string;
  object: CrmObject;
  localField: string;
  remoteField: string | null;
  direction: CrmDirection;
  sourceOfTruth: CrmSourceOfTruth;
  standard: boolean;
}

export interface CrmStageMappingsDto {
  fromCrm: { remoteStageId: string; stageId: string }[];
  toCrm: { stageId: string; remoteStageId: string }[];
  complete: boolean;
}

export type CrmPreviewBucket =
  | "create"
  | "link"
  | "update"
  | "skipped_no_email"
  | "skipped_other_pipeline"
  | "skipped_suppressed_new"
  | "skipped_invalid"
  | "matched_by_name"
  | "only_in_openline";

export interface CrmRunDto {
  id: string;
  kind: CrmRunKind;
  status: CrmRunStatus;
  /** object → action/bucket → count. */
  counts: Partial<Record<CrmObject, Record<string, number>>>;
  apiCalls: number;
  tokens: number;
  conflicts: number;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  errorCode: string | null;
  /** Previews only: valid until. */
  expiresAt: string | null;
}

export interface CrmRunDetailDto extends CrmRunDto {
  /** Previews: ≤ 20 example ids per bucket (external or Openline ids, never values). */
  examples: Partial<Record<CrmObject, Record<string, string[]>>>;
  /** Conflict decisions: field, winner, both times. No values. */
  conflictLog: {
    object: CrmObject;
    field: string;
    winner: "openline" | "crm";
    localAt: string;
    remoteAt: string;
    rule: CrmSourceOfTruth;
  }[];
}

export interface CrmSyncErrorDto {
  id: string;
  runId: string | null;
  object: CrmObject;
  localId: string | null;
  externalId: string | null;
  externalUrl: string | null;
  direction: "to_crm" | "from_crm";
  code: string;
  message: string;
  attempts: number;
  nextRetryAt: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolution: "fixed" | "dismissed" | null;
}

export interface CrmPage<T> {
  items: T[];
  nextCursor: string | null;
}

/** Per-record badge on contact, company and deal DTOs. */
export interface CrmRecordLinkDto {
  provider: CrmProvider;
  state: CrmLinkState | "paused";
  url?: string;
  syncedAt?: string;
  reason?: string;
}
