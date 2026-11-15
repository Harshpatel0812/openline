/** Sprint 4 contracts (OL-E4 §1–3): reply detection settings, reply labels and the reply inbox. */
import { z } from "zod";

// ------------------------------------------------------------------ labels

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
export const ReplyLabelSchema = z.enum(REPLY_LABELS);
export type ReplyLabel = z.infer<typeof ReplyLabelSchema>;

/** The inbox's default filter: replies a person should act on. */
export const NEEDS_ACTION_LABELS: readonly ReplyLabel[] = [
  "interested",
  "referral",
  "not_now",
  "other",
];

/** rule = deterministic (headers or keyword fallback, shown as "(rule)"); model = Scout; user = a person. */
export const LABEL_SOURCES = ["rule", "model", "user"] as const;
export type LabelSource = (typeof LABEL_SOURCES)[number];

/** How a reply was tied to our outreach. colleague = someone else at the contact's company. */
export const MATCH_KINDS = ["thread", "sender", "colleague"] as const;
export type MatchKind = (typeof MATCH_KINDS)[number];

/** What a classifier returns (Scout's model or the keyword fallback). Validated before use. */
export const ReplyClassificationSchema = z.object({
  label: ReplyLabelSchema,
  confidence: z.number().min(0).max(1),
  summary: z.string().trim().max(140).optional(),
  /** ISO date (YYYY-MM-DD) the sender is back, for out-of-office replies. */
  returnDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  referral: z
    .object({
      name: z.string().trim().max(200).optional(),
      email: z.string().trim().max(254).email().optional(),
    })
    .optional(),
});
export type ReplyClassification = z.infer<typeof ReplyClassificationSchema>;

// ------------------------------------------------------------------ reply detection settings

export const REPLY_DETECTION_STATES = ["off", "on", "error"] as const;
export type ReplyDetectionState = (typeof REPLY_DETECTION_STATES)[number];

/**
 * IMAP for an SMTP mailbox. Port 993 = TLS, 143 = STARTTLS (required). Leave username and password
 * out to reuse the SMTP login.
 */
export const ImapSettingsInputSchema = z
  .object({
    host: z
      .string()
      .trim()
      .min(3)
      .max(253)
      .regex(/^[a-zA-Z0-9.-]+$/, "Use a host name like imap.example.com"),
    port: z.coerce
      .number()
      .int()
      .refine((p) => p === 993 || p === 143, { message: "Use port 993 (TLS) or 143 (STARTTLS)" }),
    username: z.string().trim().min(1).max(254).optional(),
    password: z.string().min(1).max(500).optional(),
  })
  .refine((v) => (v.username === undefined) === (v.password === undefined), {
    message: "Give both a username and a password, or neither to reuse the SMTP login",
    path: ["password"],
  });
export type ImapSettingsInput = z.infer<typeof ImapSettingsInputSchema>;

// ------------------------------------------------------------------ inbox

const booleanParam = z
  .enum(["true", "false"])
  .transform((v) => v === "true")
  .optional();

export const InboxQuerySchema = z.object({
  label: ReplyLabelSchema.optional(),
  mailboxId: z.string().uuid().optional(),
  /**
   * Unhandled replies labelled interested / referral / not_now / other. Default: true unless a
   * label is given. false = every reply, handled or not.
   */
  needsAction: booleanParam,
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type InboxQuery = z.infer<typeof InboxQuerySchema>;

export const InboxUpdateInputSchema = z
  .object({
    label: ReplyLabelSchema.optional(),
    handled: z.boolean().optional(),
  })
  .refine((v) => v.label !== undefined || v.handled !== undefined, {
    message: "Change the label or the handled flag",
  });
export type InboxUpdateInput = z.infer<typeof InboxUpdateInputSchema>;

export const InboxReplyInputSchema = z.object({
  body: z.string().trim().min(1, "Write a reply").max(10_000),
});
export type InboxReplyInput = z.infer<typeof InboxReplyInputSchema>;

export interface InboxItemDto {
  id: string;
  receivedAt: string;
  from: { email: string; name: string | null };
  contact: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
  } | null;
  company: { id: string; name: string } | null;
  mailbox: { id: string; email: string };
  subject: string;
  label: ReplyLabel | null;
  labelSource: LabelSource | null;
  labelConfidence: number | null;
  /** Scout's summary, or null (show `snippet`). */
  summary: string | null;
  /** First non-empty line of the reply, ≤ 200 characters. Plain text. */
  snippet: string;
  matchedBy: MatchKind;
  sequence: { id: string; name: string } | null;
  /** The step this replied to, when known. */
  stepPosition: number | null;
  enrollmentId: string | null;
  needsAction: boolean;
  handledAt: string | null;
}

export interface InboxMessageDto extends InboxItemDto {
  /** The trimmed reply text. Untrusted input: render as plain text, never as HTML. */
  text: string;
  /** The outbound email this answers. */
  original: { id: string; subject: string; stepPosition: number | null; sentAt: string } | null;
  enrollment: {
    id: string;
    state: string;
    nextRunAt: string | null;
    lastDecision: string | null;
  } | null;
  referral: { name?: string; email?: string } | null;
  /** Replies sent from the inbox to this message, oldest first. */
  replies: { id: string; subject: string; sentAt: string; status: string }[];
  /** Link to the message in its mailbox, where we know one (Gmail). */
  openUrl: string | null;
}

export interface InboxPageDto {
  items: InboxItemDto[];
  nextCursor: string | null;
}

export interface InboxCountsDto {
  /** Unhandled replies labelled interested, referral, not_now or other. */
  needsAction: number;
  /** Unhandled replies per label. */
  byLabel: Record<ReplyLabel, number>;
}
