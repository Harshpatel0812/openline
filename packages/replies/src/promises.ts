/**
 * Promise Keeper (OL-E6 §2): after reply detection stores a human reply, and after a rep sends a
 * reply from the inbox, find the commitments in it and store each as a *proposed* ai_actions row
 * (kind promise_task). Promise Keeper proposes follow-up tasks only — never pauses: a human reply
 * already stops the contact's sequences. Nothing is created until the rep accepts (Scout rule 1;
 * the API does that). Bulk/list mail is skipped by reply sync (see process.ts).
 *
 * Runs in the background: the hooks queue the work and return at once, and a failure is logged
 * (ids and error names only) — it never blocks or fails a sync or a send.
 *
 * Model use is gated like reply classification: Scout on, credits left this month, at most
 * PROMISE_BUDGET_SHARE of them, and at most `dailyCapPerMailbox` extractions per mailbox per UTC
 * day (inbound mail is attacker-controlled). Otherwise, or when the model fails, the rule-based
 * extractor decides. Spend is recorded in ai_usage as feature "extract_promises".
 */
import {
  AiError,
  creditsFor,
  extractPromises,
  monthStart,
  rulePromises,
  type LlmProvider,
  type LlmUsage,
  type PlannedPromise,
  type PromiseExtraction,
  type PromiseDirection,
} from "@openline/ai";
import {
  aiActions,
  aiUsage,
  and,
  auditLog,
  eq,
  inArray,
  isNull,
  mailboxes,
  messages,
  or,
  sql,
  tasks,
  withTenant,
  workspaces,
  type Db,
  type PromiseProposalJson,
  type Tx,
} from "@openline/db";

export const PROMISE_FEATURE = "extract_promises";
/** Share of the monthly credits promise extraction may use. */
export const PROMISE_BUDGET_SHARE = 0.25;
export const DEFAULT_PROMISE_DAILY_CAP = 200;
/** Background jobs waiting at most; beyond this new ones are dropped (and logged). */
const MAX_QUEUE = 1_000;
/** Kinds that mark a message as already read (pause_enrollments: legacy rows, never created). */
const PROMISE_KINDS = ["promise_task", "pause_enrollments"] as const;
/** Replies that are never read for promises. */
const SKIP_LABELS = new Set(["bounce", "out_of_office", "unsubscribe"]);

export interface InboundStoredEvent {
  workspaceId: string;
  /** The stored inbound message (messages.id). */
  messageId: string;
}

export interface OutboundSentEvent {
  workspaceId: string;
  /** The sent outbound inbox reply (messages.id). */
  messageId: string;
  /** What the rep wrote. Outbound bodies are not stored, so the text is passed in memory. */
  text: string;
}

export interface PromiseKeeperOptions {
  db: Db;
  /** Scout's model; null/undefined = rules only. */
  provider?: LlmProvider | null;
  now?: () => Date;
  logger?: Pick<Console, "warn" | "error">;
  /** Model extractions per mailbox per UTC day. */
  dailyCapPerMailbox?: number;
}

export interface PromiseKeeper {
  /** Queues extraction for a stored human reply. Never throws, never waits. */
  afterInboundStored(event: InboundStoredEvent): void;
  /** Queues the done-suggestion and extraction for a sent inbox reply. Never throws. */
  afterOutboundSent(event: OutboundSentEvent): void;
  /** Resolves when every queued job has finished (tests, shutdown). */
  idle(): Promise<void>;
  /** The jobs themselves (awaitable): return the number of proposals created. */
  processInbound(event: InboundStoredEvent): Promise<number>;
  processOutbound(event: OutboundSentEvent): Promise<number>;
}

/** Error text safe to log: a name and a database code at most. */
function describe(error: unknown): string {
  const e = error as { name?: string; code?: string; cause?: { code?: string } };
  return `${e?.name ?? "Error"}${e?.cause?.code || e?.code ? ` ${e?.cause?.code ?? e?.code}` : ""}`;
}

interface Source {
  workspaceId: string;
  messageId: string;
  mailboxId: string | null;
  userId: string;
  contactId: string;
  timeZone: string;
  scoutEnabled: boolean;
  monthlyCredits: number;
  messageDate: Date;
}

export function createPromiseKeeper(options: PromiseKeeperOptions): PromiseKeeper {
  const { db } = options;
  const provider = options.provider ?? null;
  const now = options.now ?? (() => new Date());
  const log = options.logger ?? console;
  const dailyCap = options.dailyCapPerMailbox ?? DEFAULT_PROMISE_DAILY_CAP;

  let tail: Promise<void> = Promise.resolve();
  let queued = 0;

  function enqueue(label: string, job: () => Promise<unknown>): void {
    if (queued >= MAX_QUEUE) {
      log.warn(`promise-keeper: queue full; skipped ${label}`);
      return;
    }
    queued += 1;
    tail = tail
      .then(job)
      .then(
        () => undefined,
        (error: unknown) => log.error(`promise-keeper: ${label} failed: ${describe(error)}`),
      )
      .finally(() => {
        queued -= 1;
      });
  }

  /** May this source use the model now? Scout on, budget left, the mailbox's daily cap. */
  async function modelAllowed(tx: Tx, s: Source): Promise<boolean> {
    if (!provider || !s.scoutEnabled) return false;
    const t = now();
    const [row] = await tx
      .select({
        used: sql<number>`coalesce(sum(${aiUsage.credits}), 0)::int`,
        feature: sql<number>`coalesce(sum(${aiUsage.credits}) filter (where ${aiUsage.feature} = ${PROMISE_FEATURE}), 0)::int`,
      })
      .from(aiUsage)
      .where(
        and(
          eq(aiUsage.workspaceId, s.workspaceId),
          sql`${aiUsage.createdAt} >= ${monthStart(t).toISOString()}`,
        ),
      );
    if (Number(row?.used ?? 0) >= s.monthlyCredits) return false;
    if (Number(row?.feature ?? 0) >= s.monthlyCredits * PROMISE_BUDGET_SHARE) return false;
    if (s.mailboxId) {
      const dayStart = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
      const [today] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(aiUsage)
        .where(
          and(
            eq(aiUsage.workspaceId, s.workspaceId),
            eq(aiUsage.mailboxId, s.mailboxId),
            eq(aiUsage.feature, PROMISE_FEATURE),
            sql`${aiUsage.createdAt} >= ${dayStart.toISOString()}`,
          ),
        );
      if (Number(today?.n ?? 0) >= dailyCap) return false;
    }
    return true;
  }

  async function recordUsage(s: Source, usage: LlmUsage, model: string): Promise<void> {
    if (usage.inputTokens + usage.outputTokens <= 0) return;
    await withTenant(db, { workspaceId: s.workspaceId }, (tx) =>
      tx.insert(aiUsage).values({
        workspaceId: s.workspaceId,
        userId: null,
        mailboxId: s.mailboxId,
        feature: PROMISE_FEATURE,
        model: model || "unknown",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        credits: creditsFor(usage),
        createdAt: now(),
      }),
    );
  }

  async function alreadyProposed(tx: Tx, s: Source): Promise<boolean> {
    const [row] = await tx
      .select({ id: aiActions.id })
      .from(aiActions)
      .where(
        and(
          eq(aiActions.workspaceId, s.workspaceId),
          eq(aiActions.messageId, s.messageId),
          inArray(aiActions.kind, [...PROMISE_KINDS]),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  /** Model (when allowed) or rules; a model failure or invalid answer falls back to the rules. */
  async function extract(s: Source, text: string, direction: PromiseDirection) {
    const input = { text, direction, messageDate: s.messageDate, timeZone: s.timeZone };
    const useModel = await withTenant(db, { workspaceId: s.workspaceId }, (tx) =>
      modelAllowed(tx, s),
    );
    if (!useModel || !provider) return rulePromises(input);
    let result: PromiseExtraction;
    try {
      result = await extractPromises(provider, input);
    } catch (error) {
      if (error instanceof AiError && error.details.usage) {
        await recordUsage(s, error.details.usage, error.details.model ?? "");
      }
      return rulePromises(input);
    }
    await recordUsage(s, result.usage, result.model);
    return result.valid ? result : rulePromises(input);
  }

  async function store(
    s: Source,
    extraction: PromiseExtraction,
    direction: PromiseDirection,
    textChars: number,
  ): Promise<number> {
    if (!extraction.promises.length) return 0;
    return withTenant(db, { workspaceId: s.workspaceId }, async (tx) => {
      if (await alreadyProposed(tx, s)) return 0;
      const rows: (typeof aiActions.$inferInsert)[] = [];
      extraction.promises.forEach((p: PlannedPromise, index) => {
        const promise: PromiseProposalJson = {
          type: p.type,
          who: p.who,
          kind: p.kind,
          what: p.what,
          whenPhrase: p.whenPhrase ?? null,
          taskKind: p.taskKind,
          dueAt: p.dueAt.toISOString(),
          dueDateMissing: p.dueDateMissing,
          confidence: p.confidence,
          source: extraction.source,
          direction,
        };
        const base = {
          workspaceId: s.workspaceId,
          userId: s.userId,
          contactId: s.contactId,
          messageId: s.messageId,
          // Ids, flags and lengths only: no email text.
          inputSummary: { direction, textChars, index, source: extraction.source },
          sources: [{ id: s.messageId, kind: "message" as const, label: "Email" }],
          model: extraction.model || extraction.source,
        };
        rows.push({
          ...base,
          kind: "promise_task",
          proposal: { body: p.title, citations: [], promise },
        });
      });
      await tx.insert(aiActions).values(rows);
      await tx.insert(auditLog).values({
        workspaceId: s.workspaceId,
        actorId: null,
        action: "promise.proposed",
        entity: "message",
        entityId: s.messageId,
        metadata: {
          direction,
          source: extraction.source,
          tasks: rows.length,
        },
      });
      return rows.length;
    });
  }

  async function loadSource(workspaceId: string, messageId: string, direction: PromiseDirection) {
    return withTenant(db, { workspaceId }, async (tx) => {
      const [row] = await tx
        .select({
          m: messages,
          userId: mailboxes.userId,
          timeZone: workspaces.defaultTimeZone,
          scoutEnabled: workspaces.scoutEnabled,
          monthlyCredits: workspaces.scoutMonthlyCredits,
        })
        .from(messages)
        .innerJoin(
          mailboxes,
          and(eq(mailboxes.id, messages.mailboxId), eq(mailboxes.workspaceId, workspaceId)),
        )
        .innerJoin(workspaces, eq(workspaces.id, messages.workspaceId))
        .where(
          and(
            eq(messages.id, messageId),
            eq(messages.workspaceId, workspaceId),
            eq(messages.direction, direction),
          ),
        )
        .limit(1);
      if (!row || !row.m.contactId) return null;
      const source: Source = {
        workspaceId,
        messageId,
        mailboxId: row.m.mailboxId,
        userId: row.userId,
        contactId: row.m.contactId,
        timeZone: row.timeZone,
        scoutEnabled: row.scoutEnabled,
        monthlyCredits: row.monthlyCredits,
        messageDate: row.m.receivedAt ?? row.m.sentAt,
      };
      return { source, message: row.m };
    });
  }

  async function processInbound(event: InboundStoredEvent): Promise<number> {
    const loaded = await loadSource(event.workspaceId, event.messageId, "inbound");
    if (!loaded) return 0;
    const { source, message: m } = loaded;
    // Human replies only: no bounce reports, auto-replies or machine mail.
    if (m.autoSubmitted || (m.label && SKIP_LABELS.has(m.label)) || !m.bodyText?.trim()) return 0;
    const done = await withTenant(db, { workspaceId: source.workspaceId }, (tx) =>
      alreadyProposed(tx, source),
    );
    if (done) return 0;
    const extraction = await extract(source, m.bodyText, "inbound");
    return store(source, extraction, "inbound", m.bodyText.length);
  }

  /**
   * Marks open send_promised tasks of the same conversation as "looks done": their source email is
   * the message this reply answers, an earlier reply to that message, referenced by this reply, or
   * in the same provider thread — and is older than the reply.
   */
  async function suggestDone(event: OutboundSentEvent): Promise<number> {
    return withTenant(db, { workspaceId: event.workspaceId }, async (tx) => {
      const ws = event.workspaceId;
      const [reply] = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.id, event.messageId),
            eq(messages.workspaceId, ws),
            eq(messages.direction, "outbound"),
          ),
        )
        .limit(1);
      if (!reply?.contactId) return 0;
      const refs = (reply.referencesHeader ?? "").split(/\s+/).filter(Boolean).slice(-50);
      // No way to tell the conversation: suggest nothing rather than guess.
      if (!reply.replyToId && !refs.length && !reply.providerThreadId) return 0;
      const thread = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.workspaceId, ws),
            eq(messages.contactId, reply.contactId),
            sql`${messages.sentAt} < ${reply.sentAt.toISOString()}`,
            or(
              reply.replyToId ? eq(messages.id, reply.replyToId) : undefined,
              // An earlier reply of ours to the same message.
              reply.replyToId ? eq(messages.replyToId, reply.replyToId) : undefined,
              refs.length ? inArray(messages.messageIdHeader, refs) : undefined,
              reply.providerThreadId
                ? eq(messages.providerThreadId, reply.providerThreadId)
                : undefined,
            ),
          ),
        );
      if (!thread.length) return 0;
      const t = now();
      const rows = await tx
        .update(tasks)
        .set({ suggestDoneAt: t, suggestDoneMessageId: reply.id, updatedAt: t })
        .where(
          and(
            eq(tasks.workspaceId, ws),
            eq(tasks.contactId, reply.contactId),
            eq(tasks.kind, "send_promised"),
            eq(tasks.status, "open"),
            isNull(tasks.suggestDoneAt),
            inArray(
              tasks.sourceMessageId,
              thread.map((r) => r.id),
            ),
            sql`${tasks.createdAt} <= ${reply.sentAt.toISOString()}`,
          ),
        )
        .returning({ id: tasks.id });
      return rows.length;
    });
  }

  async function processOutbound(event: OutboundSentEvent): Promise<number> {
    await suggestDone(event);
    const loaded = await loadSource(event.workspaceId, event.messageId, "outbound");
    if (!loaded || !event.text.trim()) return 0;
    const { source } = loaded;
    const done = await withTenant(db, { workspaceId: source.workspaceId }, (tx) =>
      alreadyProposed(tx, source),
    );
    if (done) return 0;
    const extraction = await extract(source, event.text, "outbound");
    return store(source, extraction, "outbound", event.text.length);
  }

  return {
    afterInboundStored(event) {
      try {
        enqueue(`inbound ${event.messageId}`, () => processInbound(event));
      } catch (error) {
        log.error(`promise-keeper: could not queue: ${describe(error)}`);
      }
    },
    afterOutboundSent(event) {
      try {
        enqueue(`outbound ${event.messageId}`, () => processOutbound(event));
      } catch (error) {
        log.error(`promise-keeper: could not queue: ${describe(error)}`);
      }
    },
    async idle() {
      let current: Promise<void>;
      do {
        current = tail;
        await current;
      } while (current !== tail);
    },
    processInbound,
    processOutbound,
  };
}
