/**
 * Drizzle table definitions. These mirror migrations/*.sql, which are the source of truth
 * (they also hold row-level security policies and grants that Drizzle cannot express).
 * Change a table = write a new migration file AND update this file in the same PR.
 */
import { integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
