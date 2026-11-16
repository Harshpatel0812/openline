/** Sprint 5 contracts (OL-E6 §1–2): tasks and Promise Keeper proposals. */
import { z } from "zod";

// ------------------------------------------------------------------ tasks

export const TASK_KINDS = ["follow_up", "send_promised", "call", "other"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const TASK_SOURCES = ["manual", "promise"] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];
export const TASK_STATUSES = ["open", "done", "dismissed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Due filters. today/overdue/upcoming use the workspace time zone; upcoming = the next 7 days. */
export const TASK_DUE_FILTERS = ["overdue", "today", "upcoming", "none", "any"] as const;
export type TaskDueFilter = (typeof TASK_DUE_FILTERS)[number];

/** A task due within this many hours shows as "Due soon". */
export const TASK_DUE_SOON_HOURS = 24;
/** "Upcoming" on Today: the next 7 days after today. */
export const TASK_UPCOMING_DAYS = 7;

const isoDateTime = z.string().datetime({ offset: true });

export const TaskQuerySchema = z.object({
  /** mine = my tasks (default); all = everyone's (manager and above). */
  scope: z.enum(["mine", "all"]).default("mine"),
  status: z.enum(TASK_STATUSES).default("open"),
  due: z.enum(TASK_DUE_FILTERS).default("any"),
  contactId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type TaskQuery = z.infer<typeof TaskQuerySchema>;

const title = z.string().trim().min(1, "Give the task a title").max(200);
const notes = z.string().trim().max(2_000);

export const CreateTaskInputSchema = z
  .object({
    title,
    notes: notes.optional(),
    dueAt: isoDateTime.nullable().optional(),
    kind: z.enum(TASK_KINDS).default("other"),
    contactId: z.string().uuid().optional(),
    companyId: z.string().uuid().optional(),
    /** Managers and above may assign to a teammate; reps only to themselves. */
    ownerId: z.string().uuid().optional(),
  })
  .strict();
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export const UpdateTaskInputSchema = z
  .object({
    title: title.optional(),
    notes: notes.nullable().optional(),
    dueAt: isoDateTime.nullable().optional(),
    kind: z.enum(TASK_KINDS).optional(),
    contactId: z.string().uuid().nullable().optional(),
    ownerId: z.string().uuid().optional(),
    /** false = hide the "Looks like you sent it — mark done?" suggestion. */
    suggestDone: z.literal(false).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Change at least one field" });
export type UpdateTaskInput = z.infer<typeof UpdateTaskInputSchema>;

export interface TaskDto {
  id: string;
  owner: { id: string; name: string };
  contact: { id: string; email: string; firstName: string | null; lastName: string | null } | null;
  companyId: string | null;
  title: string;
  notes: string | null;
  dueAt: string | null;
  /** The promise named no date: dueAt is the +2 business days default. */
  dueDateMissing: boolean;
  kind: TaskKind;
  source: TaskSource;
  sourceMessageId: string | null;
  /** The accepted Promise Keeper proposal this task came from. */
  promiseId: string | null;
  status: TaskStatus;
  completedAt: string | null;
  /** Open and past due. */
  overdue: boolean;
  /** Open and due within the next 24 hours. */
  dueSoon: boolean;
  /** The rep replied in the promise's thread afterwards: suggest marking it done. */
  suggestDoneAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** My open tasks: past due, due today (not yet past), and due in the next 7 days after today. */
export interface TaskCountsDto {
  overdue: number;
  dueToday: number;
  upcoming: number;
}

// ------------------------------------------------------------------ promises

/** Promise Keeper proposes follow-up tasks only (product decision, Sprint 5). */
export const PROMISE_ACTION_KINDS = ["promise_task"] as const;
/** Kinds that may still exist in old rows but are never created, listed or accepted. */
export const LEGACY_PROMISE_ACTION_KINDS = ["pause_enrollments"] as const;
export type PromiseActionKind = (typeof PROMISE_ACTION_KINDS)[number];
export const PROMISE_STATUSES = ["proposed", "accepted", "dismissed"] as const;
export type PromiseStatus = (typeof PROMISE_STATUSES)[number];
/** our_promise = the rep committed; their_request = "try me in March"; their_promise = they will. */
export const PROMISE_TYPES = ["our_promise", "their_request", "their_promise"] as const;
export type PromiseType = (typeof PROMISE_TYPES)[number];

export const PromiseQuerySchema = z.object({
  status: z.enum(PROMISE_STATUSES).default("proposed"),
  contactId: z.string().uuid().optional(),
  messageId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type PromiseQuery = z.infer<typeof PromiseQuerySchema>;

export const AcceptPromiseInputSchema = z
  .object({
    /** Task title (promise_task only); defaults to the proposal's. */
    title: title.optional(),
    /** Due time; defaults to the proposal's. */
    dueAt: isoDateTime.optional(),
  })
  .strict();
export type AcceptPromiseInput = z.infer<typeof AcceptPromiseInputSchema>;

export const DismissPromiseInputSchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict();
export type DismissPromiseInput = z.infer<typeof DismissPromiseInputSchema>;

export interface PromiseProposalDto {
  id: string;
  kind: PromiseActionKind;
  status: PromiseStatus;
  /** Whose mailbox received or sent the email: they (or a manager) decide. */
  userId: string;
  contactId: string | null;
  messageId: string | null;
  type: PromiseType;
  who: "us" | "them";
  direction: "inbound" | "outbound";
  /** What was promised, from the email (≤ 160). */
  what: string;
  whenPhrase: string | null;
  /** Suggested task title. */
  title: string;
  taskKind: "follow_up" | "send_promised";
  /** Suggested due time. */
  dueAt: string;
  dueDateMissing: boolean;
  confidence: number;
  /** model = Scout's model; rule = the rule-based fallback. */
  source: "model" | "rule";
  createdAt: string;
  decidedAt: string | null;
  /** Accepted promise_task: the task it created. */
  taskId: string | null;
}

export interface AcceptPromiseResultDto {
  promise: PromiseProposalDto;
  task: TaskDto | null;
}
