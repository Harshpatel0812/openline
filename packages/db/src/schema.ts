/**
 * Drizzle table definitions. These mirror migrations/*.sql, which are the source of truth
 * (they also hold row-level security policies and grants that Drizzle cannot express).
 * Change a table = write a new migration file AND update this file in the same PR.
 */
import {
  bigint,
  boolean,
  char,
  date,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  emailVerifiedAt: ts("email_verified_at"),
  lastWorkspaceId: uuid("last_workspace_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
});

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  mailingAddress: text("mailing_address"),
  defaultTimeZone: text("default_time_zone").notNull().default("America/New_York"),
  plan: text("plan").notNull().default("trial"),
  dataRegion: text("data_region").notNull().default("us"),
  trialEndsAt: ts("trial_ends_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  // Scout (0007).
  scoutEnabled: boolean("scout_enabled").notNull().default(true),
  scoutMonthlyCredits: integer("scout_monthly_credits").notNull().default(2000),
  scoutWebResearch: boolean("scout_web_research").notNull().default(true),
  aboutUs: text("about_us"),
  valueProposition: text("value_proposition"),
  // Pipeline (0011): default currency for new deals (ISO 4217).
  currency: char("currency", { length: 3 }).notNull().default("USD"),
  // Plan picked on /pricing (0012). Intent only: billing isn't switched on yet.
  chosenPlan: text("chosen_plan", { enum: ["solo", "team", "growth", "scale"] }),
  chosenBilling: text("chosen_billing", { enum: ["monthly", "annual"] }),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role", { enum: ["owner", "admin", "manager", "rep"] }).notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export const invites = pgTable("invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  email: text("email").notNull(),
  role: text("role", { enum: ["admin", "manager", "rep"] }).notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  invitedBy: uuid("invited_by"),
  expiresAt: ts("expires_at").notNull(),
  acceptedAt: ts("accepted_at"),
  revokedAt: ts("revoked_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  domain: text("domain"),
  custom: jsonb("custom").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const CONSENT_BASES = [
  "express",
  "implied_purchase",
  "implied_inquiry",
  "legitimate_interest",
  "none",
] as const;

export const contacts = pgTable("contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  companyId: uuid("company_id"),
  ownerId: uuid("owner_id"),
  email: text("email").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  title: text("title"),
  phone: text("phone"),
  timeZone: text("time_zone"),
  country: text("country"),
  status: text("status", { enum: ["active", "bounced", "unsubscribed", "archived"] })
    .notNull()
    .default("active"),
  healthScore: integer("health_score").notNull().default(100),
  consentBasis: text("consent_basis", { enum: CONSENT_BASES }).notNull().default("none"),
  custom: jsonb("custom").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const consents = pgTable("consents", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  contactId: uuid("contact_id").notNull(),
  channel: text("channel").notNull().default("email"),
  basis: text("basis", { enum: CONSENT_BASES }).notNull(),
  source: text("source").notNull(),
  obtainedAt: ts("obtained_at").notNull(),
  expiresAt: ts("expires_at"),
  withdrawnAt: ts("withdrawn_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const suppressions = pgTable("suppressions", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  value: text("value").notNull(),
  reason: text("reason").notNull(),
  createdBy: uuid("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  actorId: uuid("actor_id"),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  at: ts("at").notNull().defaultNow(),
});

export const emailTokens = pgTable("email_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  kind: text("kind", { enum: ["verify_email", "reset_password"] }).notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const MAILBOX_PROVIDERS = ["smtp", "gmail", "graph"] as const;
export const MAILBOX_STATUSES = ["active", "paused", "error", "disconnected"] as const;
export const REPLY_DETECTION_STATES = ["off", "on", "error"] as const;
export const REPLY_LABELS = [
  "interested",
  "not_now",
  "referral",
  "not_interested",
  "unsubscribe",
  "out_of_office",
  "bounce",
  "other",
] as const;
export const LABEL_SOURCES = ["rule", "model", "user"] as const;
export const MATCH_KINDS = ["thread", "sender", "colleague"] as const;

export const mailboxes = pgTable("mailboxes", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  userId: uuid("user_id").notNull(),
  provider: text("provider", { enum: MAILBOX_PROVIDERS }).notNull(),
  email: text("email").notNull(),
  displayName: text("display_name"),
  status: text("status", { enum: MAILBOX_STATUSES }).notNull().default("active"),
  dailyCap: integer("daily_cap").notNull().default(50),
  smtpHost: text("smtp_host"),
  smtpPort: integer("smtp_port"),
  smtpSecure: boolean("smtp_secure"),
  secretSealed: text("secret_sealed").notNull(),
  lastError: text("last_error"),
  // Reply detection (0006). The IMAP login itself is inside secret_sealed.
  imapHost: text("imap_host"),
  imapPort: integer("imap_port"),
  imapSecure: boolean("imap_secure"),
  replyDetection: text("reply_detection", { enum: REPLY_DETECTION_STATES })
    .notNull()
    .default("off"),
  // bigint as number: IMAP UIDs and UIDVALIDITY are 32-bit unsigned.
  syncUidValidity: bigint("sync_uidvalidity", { mode: "number" }),
  syncLastUid: bigint("sync_last_uid", { mode: "number" }),
  syncHistoryId: text("sync_history_id"),
  lastSyncedAt: ts("last_synced_at"),
  lastSyncError: text("last_sync_error"),
  nextSyncAt: ts("next_sync_at"),
  syncLockedUntil: ts("sync_locked_until"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export interface SendWindowJson {
  days: number[];
  startHour: number;
  endHour: number;
}

export const SEQUENCE_STATUSES = ["draft", "active", "paused", "archived"] as const;

export const sequences = pgTable("sequences", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  status: text("status", { enum: SEQUENCE_STATUSES }).notNull().default("draft"),
  sendWindow: jsonb("send_window")
    .$type<SendWindowJson>()
    .notNull()
    .default({ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 }),
  createdBy: uuid("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const sequenceSteps = pgTable("sequence_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  sequenceId: uuid("sequence_id").notNull(),
  position: integer("position").notNull(),
  delayDays: integer("delay_days").notNull().default(0),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  threadWithPrevious: boolean("thread_with_previous").notNull().default(true),
});

export const ENROLLMENT_STATES = [
  "active",
  "paused",
  "completed",
  "replied",
  "bounced",
  "unsubscribed",
  "stopped",
  "error",
] as const;

export const enrollments = pgTable("enrollments", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  sequenceId: uuid("sequence_id").notNull(),
  contactId: uuid("contact_id").notNull(),
  mailboxId: uuid("mailbox_id").notNull(),
  state: text("state", { enum: ENROLLMENT_STATES }).notNull().default("active"),
  nextPosition: integer("next_position").notNull().default(1),
  nextRunAt: ts("next_run_at"),
  lockedUntil: ts("locked_until"),
  attempts: integer("attempts").notNull().default(0),
  lastDecision: text("last_decision"),
  lastError: text("last_error"),
  threadMessageId: text("thread_message_id"),
  threadSubject: text("thread_subject"),
  enrolledBy: uuid("enrolled_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  enrollmentId: uuid("enrollment_id"),
  contactId: uuid("contact_id"),
  mailboxId: uuid("mailbox_id"),
  stepPosition: integer("step_position"),
  direction: text("direction", { enum: ["outbound", "inbound"] })
    .notNull()
    .default("outbound"),
  messageIdHeader: text("message_id_header").notNull(),
  providerMessageId: text("provider_message_id"),
  subject: text("subject").notNull(),
  sentAt: ts("sent_at").notNull().defaultNow(),
  /**
   * sending = reserved before the network send; unconfirmed = the sender died mid-send;
   * received = an inbound reply.
   */
  status: text("status", { enum: ["sending", "sent", "unconfirmed", "received"] })
    .notNull()
    .default("sent"),
  // Inbound replies (0006). Bodies are stored for inbound only: plain text, trimmed, ≤ 20k chars.
  fromEmail: text("from_email"),
  fromName: text("from_name"),
  inReplyTo: text("in_reply_to"),
  referencesHeader: text("references_header"),
  bodyText: text("body_text"),
  receivedAt: ts("received_at"),
  providerThreadId: text("provider_thread_id"),
  matchKind: text("match_kind", { enum: MATCH_KINDS }),
  replyToId: uuid("reply_to_id"),
  label: text("label", { enum: REPLY_LABELS }),
  labelSource: text("label_source", { enum: LABEL_SOURCES }),
  labelConfidence: real("label_confidence"),
  summary: text("summary"),
  referral: jsonb("referral").$type<{ name?: string; email?: string }>(),
  handledAt: ts("handled_at"),
  /** Machine-generated inbound mail (0008): never replied to from the inbox. */
  autoSubmitted: boolean("auto_submitted").notNull().default(false),
  /** Compliance Copilot proof for outbound mail (0010); immutable once set; never the body. */
  complianceProof: jsonb("compliance_proof").$type<ComplianceProofJson>(),
});

/** Mirrors `ComplianceProof` in packages/compliance (kept structural: db doesn't depend on it). */
export interface ComplianceProofJson {
  rulesetVersion: string;
  channel: string;
  decision: string;
  nextAllowedAt?: string;
  jurisdiction: string;
  evaluatedAt: string;
  checks: { rule: string; outcome: string; detail: string; citation: string; warning?: boolean }[];
}

// ---------------------------------------------------------------- Scout (0007)

export const AI_ACTION_KINDS = [
  "draft_email",
  "draft_reply",
  // Promise Keeper (0009).
  "promise_task",
  "pause_enrollments",
  // Reality Check (0013): "Move to <evidence stage>".
  "deal_stage_move",
] as const;
export const AI_ACTION_STATUSES = [
  "proposed",
  "approved",
  "rejected",
  "executed",
  "failed",
] as const;

export interface AiProposalJson {
  subject?: string;
  body: string;
  citations: { claim: string; source: string }[];
  /** Promise Keeper proposals (kind promise_task, 0009; pause_enrollments is a legacy, unused value). */
  promise?: PromiseProposalJson;
  /** Reality Check proposals (kind deal_stage_move, 0013); `body` is the reason. */
  stageMove?: StageMoveProposalJson;
}

/** "Move to <evidence stage>" from a Reality Check run. */
export interface StageMoveProposalJson {
  checkId: string;
  fromStageId: string;
  toStageId: string;
}

/** What Promise Keeper found in one email; `body` of the proposal is the suggested task title. */
export interface PromiseProposalJson {
  /** our_promise = the rep committed; their_request = "try me in March"; their_promise = they will. */
  type: "our_promise" | "their_request" | "their_promise";
  who: "us" | "them";
  kind: string;
  /** ≤ 160 characters, from the email. */
  what: string;
  whenPhrase: string | null;
  taskKind: "follow_up" | "send_promised";
  /** ISO time, resolved in code from whenPhrase + the message date. */
  dueAt: string;
  dueDateMissing: boolean;
  confidence: number;
  source: "model" | "rule";
  direction: "inbound" | "outbound";
}
export interface AiSourceJson {
  id: string;
  kind: "contact_field" | "web_page" | "message";
  label: string;
}
export interface WebsitePageJson {
  url: string;
  title?: string;
  text: string;
}

export const aiActions = pgTable("ai_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  userId: uuid("user_id").notNull(),
  kind: text("kind", { enum: AI_ACTION_KINDS }).notNull(),
  status: text("status", { enum: AI_ACTION_STATUSES }).notNull().default("proposed"),
  contactId: uuid("contact_id"),
  messageId: uuid("message_id"),
  sequenceId: uuid("sequence_id"),
  stepPosition: integer("step_position"),
  /** Reality Check stage-move proposals (0013). */
  dealId: uuid("deal_id"),
  inputSummary: jsonb("input_summary").$type<Record<string, unknown>>().notNull().default({}),
  proposal: jsonb("proposal").$type<AiProposalJson>().notNull(),
  finalSubject: text("final_subject"),
  finalText: text("final_text"),
  sources: jsonb("sources").$type<AiSourceJson[]>().notNull().default([]),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  editDistance: integer("edit_distance"),
  rejectReason: text("reject_reason"),
  createdAt: ts("created_at").notNull().defaultNow(),
  decidedAt: ts("decided_at"),
});

export const aiUsage = pgTable("ai_usage", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  userId: uuid("user_id"),
  feature: text("feature").notNull(),
  aiActionId: uuid("ai_action_id"),
  /** Reply classification only (0008): the mailbox the reply arrived in. */
  mailboxId: uuid("mailbox_id"),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  credits: integer("credits").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const websiteCache = pgTable("website_cache", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  domain: text("domain").notNull(),
  pages: jsonb("pages").$type<WebsitePageJson[]>().notNull().default([]),
  ok: boolean("ok").notNull().default(true),
  fetchedAt: ts("fetched_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------- Tasks (0009)

export const TASK_KINDS = ["follow_up", "send_promised", "call", "other"] as const;
export const TASK_SOURCES = ["manual", "promise"] as const;
export const TASK_STATUSES = ["open", "done", "dismissed"] as const;

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  ownerId: uuid("owner_id").notNull(),
  contactId: uuid("contact_id"),
  companyId: uuid("company_id"),
  title: text("title").notNull(),
  notes: text("notes"),
  dueAt: ts("due_at"),
  dueDateMissing: boolean("due_date_missing").notNull().default(false),
  kind: text("kind", { enum: TASK_KINDS }).notNull().default("other"),
  source: text("source", { enum: TASK_SOURCES }).notNull().default("manual"),
  sourceMessageId: uuid("source_message_id"),
  aiActionId: uuid("ai_action_id"),
  status: text("status", { enum: TASK_STATUSES }).notNull().default("open"),
  completedAt: ts("completed_at"),
  suggestDoneAt: ts("suggest_done_at"),
  suggestDoneMessageId: uuid("suggest_done_message_id"),
  /** Pipeline (0011): the deal this task is for. */
  dealId: uuid("deal_id"),
  createdBy: uuid("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------- Pipeline (0011)

export const STAGE_KINDS = ["open", "won", "lost"] as const;
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

export interface StageCriterionJson {
  label: string;
  evidence: (typeof DEAL_EVIDENCE_TYPES)[number];
}

export const pipelineStages = pgTable("pipeline_stages", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  position: integer("position").notNull(),
  probability: integer("probability").notNull(),
  kind: text("kind", { enum: STAGE_KINDS }).notNull().default("open"),
  /** null = never stale. */
  staleAfterDays: integer("stale_after_days"),
  entryCriteria: jsonb("entry_criteria").$type<StageCriterionJson[]>().notNull().default([]),
  archivedAt: ts("archived_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const deals = pgTable("deals", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  companyId: uuid("company_id"),
  primaryContactId: uuid("primary_contact_id"),
  ownerId: uuid("owner_id").notNull(),
  stageId: uuid("stage_id").notNull(),
  /** Integer minor units (cents). Read as a JS number: the column is capped below 2^53. */
  amountMinor: bigint("amount_minor", { mode: "number" }),
  currency: char("currency", { length: 3 }).notNull(),
  /** YYYY-MM-DD. */
  expectedCloseDate: date("expected_close_date", { mode: "string" }),
  nextStep: text("next_step"),
  nextStepDate: date("next_step_date", { mode: "string" }),
  lostReason: text("lost_reason"),
  stageEnteredAt: ts("stage_entered_at").notNull().defaultNow(),
  /** The deal's own activity (created, edit, stage change, task done); email is merged at read. */
  lastActivityAt: ts("last_activity_at").notNull().defaultNow(),
  closedAt: ts("closed_at"),
  /** Last Reality Check run (0013); the worker checks at most once a day. */
  realityCheckedAt: ts("reality_checked_at"),
  /** Worker lease for the scheduled Reality Check (claim_due_reality_checks). */
  realityLockedUntil: ts("reality_locked_until"),
  createdBy: uuid("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const dealContacts = pgTable(
  "deal_contacts",
  {
    workspaceId: uuid("workspace_id").notNull(),
    dealId: uuid("deal_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    addedAt: ts("added_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.dealId, t.contactId] })],
);

/** Append-only (the app role has no UPDATE/DELETE). */
export const dealStageHistory = pgTable("deal_stage_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  dealId: uuid("deal_id").notNull(),
  /** null = the deal was created in toStageId. */
  fromStageId: uuid("from_stage_id"),
  toStageId: uuid("to_stage_id").notNull(),
  movedBy: uuid("moved_by"),
  movedAt: ts("moved_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------- Reality Check (0013)

export interface DealEvidenceItemJson {
  present: "yes" | "no" | "unclear";
  /** ≤ 300 characters, verbatim from the message (the only email text stored here). */
  quote?: string;
  messageId?: string;
}

export interface DealFlagJson {
  id: string;
  code: string;
  severity: "high" | "medium" | "low";
  message: string;
  criterionKey?: string;
  criterion?: { stageId: string; stageName: string; label: string; evidence: string };
  quote?: string;
  messageId?: string;
}

/** Append-only (the app role has no UPDATE/DELETE). */
export const dealChecks = pgTable("deal_checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  dealId: uuid("deal_id").notNull(),
  /** The deal's stage when checked. */
  stageId: uuid("stage_id").notNull(),
  ranAt: ts("ran_at").notNull().defaultNow(),
  trigger: text("trigger", { enum: ["manual", "scheduled"] })
    .notNull()
    .default("manual"),
  ranBy: uuid("ran_by"),
  model: text("model"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  evidence: jsonb("evidence").$type<Record<string, DealEvidenceItemJson>>().notNull().default({}),
  flags: jsonb("flags").$type<DealFlagJson[]>().notNull().default([]),
  evidenceStageId: uuid("evidence_stage_id"),
  deterministicOnly: boolean("deterministic_only").notNull().default(true),
  deterministicReason: text("deterministic_reason"),
});

/** Append-only. */
export const dealFlagDismissals = pgTable("deal_flag_dismissals", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  dealId: uuid("deal_id").notNull(),
  flagId: text("flag_id").notNull(),
  code: text("code").notNull(),
  criterionKey: text("criterion_key"),
  reason: text("reason").notNull(),
  dismissedBy: uuid("dismissed_by"),
  dismissedAt: ts("dismissed_at").notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type Invite = typeof invites.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type Suppression = typeof suppressions.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
export type EmailToken = typeof emailTokens.$inferSelect;
export type Mailbox = typeof mailboxes.$inferSelect;
export type Sequence = typeof sequences.$inferSelect;
export type SequenceStep = typeof sequenceSteps.$inferSelect;
export type Enrollment = typeof enrollments.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type AiActionRow = typeof aiActions.$inferSelect;
export type AiUsageRow = typeof aiUsage.$inferSelect;
export type WebsiteCacheRow = typeof websiteCache.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type PipelineStageRow = typeof pipelineStages.$inferSelect;
export type DealRow = typeof deals.$inferSelect;
export type DealStageHistoryRow = typeof dealStageHistory.$inferSelect;
export type DealCheckRow = typeof dealChecks.$inferSelect;
export type DealFlagDismissalRow = typeof dealFlagDismissals.$inferSelect;
