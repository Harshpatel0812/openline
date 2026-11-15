/**
 * Drizzle table definitions. These mirror migrations/*.sql, which are the source of truth
 * (they also hold row-level security policies and grants that Drizzle cannot express).
 * Change a table = write a new migration file AND update this file in the same PR.
 */
import {
  bigint,
  boolean,
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
});

// ---------------------------------------------------------------- Scout (0007)

export const AI_ACTION_KINDS = ["draft_email", "draft_reply"] as const;
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
