/** Sprint 3 contracts: mailboxes, sequences, enrollments, workspace sending settings, account email flows. */
import { z } from "zod";
import { PasswordSchema } from "./api";

// ------------------------------------------------------------------ account email flows

export const VerifyEmailInputSchema = z.object({ token: z.string().min(20).max(200) });

export const ForgotPasswordInputSchema = z.object({
  email: z
    .string()
    .trim()
    .max(254)
    .email()
    .transform((v) => v.toLowerCase()),
});

export const ResetPasswordInputSchema = z.object({
  token: z.string().min(20).max(200),
  password: PasswordSchema,
});

// ------------------------------------------------------------------ workspace settings

export const WorkspaceSettingsInputSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  /** Physical postal address, printed in every outreach email (CAN-SPAM). */
  mailingAddress: z.string().trim().min(10, "Enter a full postal address").max(300).optional(),
  defaultTimeZone: z.string().trim().max(64).optional(),
});

export interface WorkspaceSettingsDto {
  id: string;
  name: string;
  mailingAddress: string | null;
  defaultTimeZone: string;
}

// ------------------------------------------------------------------ mailboxes

export const MAILBOX_STATUSES = ["active", "paused", "error", "disconnected"] as const;

export const SmtpMailboxInputSchema = z.object({
  email: z
    .string()
    .trim()
    .max(254)
    .email()
    .transform((v) => v.toLowerCase()),
  displayName: z.string().trim().max(100).optional(),
  host: z
    .string()
    .trim()
    .min(3)
    .max(253)
    .regex(/^[a-zA-Z0-9.-]+$/, "Use a host name like smtp.example.com"),
  port: z.coerce
    .number()
    .int()
    .refine((p) => [25, 465, 587, 1025, 2525].includes(p), {
      message: "Use port 25, 465, 587, 1025 or 2525",
    }),
  secure: z.boolean(),
  username: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(500),
  dailyCap: z.coerce.number().int().min(1).max(200).default(50),
});
export type SmtpMailboxInput = z.infer<typeof SmtpMailboxInputSchema>;

export const MailboxUpdateInputSchema = z.object({
  displayName: z.string().trim().max(100).optional(),
  dailyCap: z.coerce.number().int().min(1).max(200).optional(),
  status: z.enum(["active", "paused"]).optional(),
});

export interface MailboxDto {
  id: string;
  provider: "smtp" | "gmail" | "graph";
  email: string;
  displayName: string | null;
  status: (typeof MAILBOX_STATUSES)[number];
  dailyCap: number;
  sentToday: number;
  lastError: string | null;
  ownerId: string;
  createdAt: string;
}

// ------------------------------------------------------------------ sequences

export const SendWindowSchema = z
  .object({
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    startHour: z.number().int().min(0).max(23),
    endHour: z.number().int().min(1).max(24),
  })
  .refine((w) => w.startHour < w.endHour, {
    message: "End must be after start",
    path: ["endHour"],
  });

export const SequenceStepInputSchema = z.object({
  /** Days to wait after the previous step; 0 for the first step. */
  delayDays: z.number().int().min(0).max(60),
  subject: z.string().trim().min(1, "Add a subject").max(200),
  body: z.string().trim().min(1, "Write the email").max(10_000),
  threadWithPrevious: z.boolean().default(true),
});

export const SequenceInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sendWindow: SendWindowSchema.optional(),
  /** Replaces all steps (ordered). Allowed only while the sequence has no active enrollments. */
  steps: z.array(SequenceStepInputSchema).min(1, "Add at least one step").max(10).optional(),
});
export type SequenceInput = z.infer<typeof SequenceInputSchema>;

export const SequenceStatusInputSchema = z.object({
  status: z.enum(["active", "paused", "archived"]),
});

export interface SequenceStepDto {
  id: string;
  position: number;
  delayDays: number;
  subject: string;
  body: string;
  threadWithPrevious: boolean;
}

export interface SequenceStatsDto {
  active: number;
  completed: number;
  replied: number;
  unsubscribed: number;
  bounced: number;
  stopped: number;
  error: number;
  sent: number;
}

export interface SequenceDto {
  id: string;
  name: string;
  status: "draft" | "active" | "paused" | "archived";
  sendWindow: z.infer<typeof SendWindowSchema>;
  steps: SequenceStepDto[];
  stats: SequenceStatsDto;
  createdAt: string;
  updatedAt: string;
}

// ------------------------------------------------------------------ enrollments

export const EnrollInputSchema = z.object({
  contactIds: z.array(z.string().uuid()).min(1).max(1000),
  mailboxId: z.string().uuid(),
});

/** Why a contact could not be enrolled (shown per contact before/after enrolling). */
export const ENROLL_SKIP_REASONS = [
  "already_enrolled",
  "suppressed",
  "unsubscribed",
  "bounced",
  "no_consent",
  "not_found",
] as const;

export interface EnrollResultDto {
  enrolled: number;
  skipped: { contactId: string; reason: (typeof ENROLL_SKIP_REASONS)[number] }[];
}

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

export const EnrollmentActionInputSchema = z.object({
  action: z.enum(["pause", "resume", "stop", "mark_replied"]),
});

export interface EnrollmentDto {
  id: string;
  sequenceId: string;
  contact: { id: string; email: string; firstName: string | null; lastName: string | null };
  mailbox: { id: string; email: string };
  state: (typeof ENROLLMENT_STATES)[number];
  nextPosition: number;
  nextRunAt: string | null;
  lastDecision: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface MessageDto {
  id: string;
  sequenceId: string | null;
  stepPosition: number | null;
  subject: string;
  mailboxEmail: string | null;
  sentAt: string;
}

// ------------------------------------------------------------------ consent records

export const ConsentInputSchema = z
  .object({
    basis: z.enum([
      "express",
      "implied_purchase",
      "implied_inquiry",
      "legitimate_interest",
      "none",
    ]),
    /** Where the consent came from, e.g. "Signed up at trade show, 2026-10-02". */
    source: z.string().trim().min(3, "Say where consent came from").max(300).optional(),
    obtainedAt: z.coerce.date().optional(),
  })
  .refine((v) => v.basis === "none" || (v.source && v.obtainedAt), {
    message: "Consent needs a source and the date it was obtained",
    path: ["source"],
  })
  .refine((v) => !v.obtainedAt || v.obtainedAt.getTime() <= Date.now() + 60_000, {
    message: "The date can't be in the future",
    path: ["obtainedAt"],
  });
export type ConsentInput = z.infer<typeof ConsentInputSchema>;

export interface ConsentDto {
  basis: z.infer<typeof ConsentInputSchema>["basis"];
  source: string | null;
  obtainedAt: string | null;
  expiresAt: string | null;
  recordedAt: string;
  /** Set when the contact withdrew this consent (e.g. by unsubscribing). */
  withdrawnAt: string | null;
}
