/**
 * Drizzle table definitions. These mirror migrations/*.sql, which are the source of truth
 * (they also hold row-level security policies and grants that Drizzle cannot express).
 * Change a table = write a new migration file AND update this file in the same PR.
 */
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
  /** sending = reserved before the network send; unconfirmed = the sender died mid-send. */
  status: text("status", { enum: ["sending", "sent", "unconfirmed"] })
    .notNull()
    .default("sent"),
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
