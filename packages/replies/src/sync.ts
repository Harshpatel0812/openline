/**
 * The reply-sync runner (like the sending engine): claim due mailboxes with
 * claim_due_mailbox_syncs (the one cross-tenant query, ids only), then for each one, inside
 * withTenant() for its workspace: read new mail (network, outside transactions), process each
 * message, store the cursor. Any number of workers can run; the lease gives each mailbox to one.
 */
import { and, eq, mailboxes, sql, withIdentity, withTenant, type Mailbox } from "@openline/db";
import { openJson, type MailboxSecret } from "@openline/email";
import { keywordClassifier } from "./classify";
import { GmailReader } from "./gmail";
import { ImapReader } from "./imap";
import { processInbound } from "./process";
import {
  ReadError,
  type MailboxReader,
  type ReplySync,
  type ReplySyncOptions,
  type SyncCursor,
  type SyncSummary,
} from "./types";

export const DEFAULT_REPLY_SYNC_INTERVAL_MS = 120_000;
const FIRST_SYNC_DAYS = 7;
/** Same as claim_due_mailbox_syncs (0006). */
const LEASE = sql`now() + interval '5 minutes'`;
/** Renew the lease this often while processing, long before it can run out. */
const LEASE_RENEW_MS = 60_000;

/** Error text safe to log: database errors carry queries and parameters, so only codes. */
function describe(error: unknown): string {
  const e = error as {
    name?: string;
    message?: string;
    code?: string;
    query?: unknown;
    cause?: { code?: string };
  };
  if (e?.query !== undefined || e?.cause?.code || (e?.code && /^[0-9A-Z]{5}$/.test(e.code))) {
    return `${e?.name ?? "DatabaseError"} ${e?.cause?.code ?? e?.code ?? ""}`.trim();
  }
  if (e instanceof ReadError) return `ReadError(${e.kind})`;
  return e?.name ?? "Error";
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}

function emptySummary(): SyncSummary {
  return { claimed: 0, synced: 0, failed: 0, stored: 0, duplicates: 0, unmatched: 0, ignored: 0 };
}

/** The reader for a mailbox from its settings and sealed secret. */
export function defaultReaderFor(
  mailbox: Mailbox,
  secret: MailboxSecret,
  options: Pick<ReplySyncOptions, "google" | "allowPrivateHosts">,
): MailboxReader {
  if (mailbox.provider === "smtp" && secret.kind === "smtp") {
    if (!mailbox.imapHost || (mailbox.imapPort !== 993 && mailbox.imapPort !== 143)) {
      throw new ReadError("Add IMAP settings to turn on reply detection.", "auth");
    }
    return new ImapReader({
      host: mailbox.imapHost,
      port: mailbox.imapPort,
      username: secret.imap?.username ?? secret.username,
      password: secret.imap?.password ?? secret.password,
      allowPrivate: options.allowPrivateHosts === true,
    });
  }
  if (mailbox.provider === "gmail" && secret.kind === "oauth") {
    if (!options.google) {
      throw new ReadError("Gmail isn't set up on this server.", "transient");
    }
    return new GmailReader(options.google, secret.refreshToken);
  }
  throw new ReadError("Reply detection isn't available for this mailbox.", "auth");
}

export function createReplySync(options: ReplySyncOptions): ReplySync {
  const db = options.db;
  const now = options.now ?? (() => new Date());
  const log = options.logger ?? console;
  const classifier = options.classifier ?? keywordClassifier;
  const intervalMs = options.intervalMs ?? DEFAULT_REPLY_SYNC_INTERVAL_MS;
  const maxMessages = options.maxMessages ?? 200;
  const maxDurationMs = options.maxDurationMs ?? 30_000;

  let timer: NodeJS.Timeout | undefined;
  let running: Promise<SyncSummary> | undefined;
  let stopped = false;

  /** Writes the outcome of a sync. Never re-enables a mailbox someone turned off meanwhile. */
  async function finish(
    workspaceId: string,
    mailboxId: string,
    patch: {
      cursor?: SyncCursor;
      synced?: boolean;
      error?: string | null;
      needsUser?: boolean;
      /** Stopped at the deadline with more to read: due again right away. */
      more?: boolean;
    },
  ) {
    const t = now();
    await withTenant(db, { workspaceId }, (tx) =>
      tx
        .update(mailboxes)
        .set({
          ...(patch.cursor
            ? {
                syncUidValidity: patch.cursor.uidValidity ?? null,
                syncLastUid: patch.cursor.lastUid ?? null,
                syncHistoryId: patch.cursor.historyId ?? null,
              }
            : {}),
          ...(patch.synced ? { lastSyncedAt: t } : {}),
          ...(patch.error !== undefined ? { lastSyncError: patch.error } : {}),
          ...(patch.needsUser ? { replyDetection: "error" as const, nextSyncAt: null } : {}),
          ...(!patch.needsUser
            ? { nextSyncAt: patch.more ? t : new Date(t.getTime() + intervalMs) }
            : {}),
          syncLockedUntil: null,
        })
        .where(
          and(
            eq(mailboxes.id, mailboxId),
            eq(mailboxes.workspaceId, workspaceId),
            eq(mailboxes.replyDetection, "on"),
          ),
        ),
    );
  }

  async function releaseOnly(workspaceId: string, mailboxId: string) {
    await withTenant(db, { workspaceId }, (tx) =>
      tx
        .update(mailboxes)
        .set({ syncLockedUntil: null })
        .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.workspaceId, workspaceId))),
    );
  }

  /**
   * Renews this worker's lease on the mailbox. False when it was lost (ran out and another worker
   * may hold it): the caller must stop without writing anything.
   */
  async function renewLease(workspaceId: string, mailboxId: string): Promise<boolean> {
    const rows = await withTenant(db, { workspaceId }, (tx) =>
      tx
        .update(mailboxes)
        .set({ syncLockedUntil: LEASE })
        .where(
          and(
            eq(mailboxes.id, mailboxId),
            eq(mailboxes.workspaceId, workspaceId),
            sql`(${mailboxes.syncLockedUntil} IS NULL OR ${mailboxes.syncLockedUntil} > now())`,
          ),
        )
        .returning({ id: mailboxes.id }),
    );
    return rows.length > 0;
  }

  async function syncMailbox(workspaceId: string, mailboxId: string): Promise<SyncSummary> {
    const summary = emptySummary();
    // One deadline for the whole sync (read + process); reading may use the first half of it.
    const startedAt = Date.now();
    const deadline = startedAt + maxDurationMs;
    const [mailbox] = await withTenant(db, { workspaceId }, (tx) =>
      tx
        .select()
        .from(mailboxes)
        .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.workspaceId, workspaceId))),
    );
    if (
      !mailbox ||
      mailbox.replyDetection !== "on" ||
      mailbox.status === "disconnected" ||
      !mailbox.secretSealed
    ) {
      if (mailbox) await releaseOnly(workspaceId, mailboxId);
      return summary;
    }

    const cursor: SyncCursor = {
      uidValidity: mailbox.syncUidValidity,
      lastUid: mailbox.syncLastUid,
      historyId: mailbox.syncHistoryId,
    };
    const t = now();
    let read;
    try {
      const secret = openJson<MailboxSecret>(mailbox.secretSealed, options.secretsKey, workspaceId);
      const reader =
        options.readerFor?.(mailbox, secret) ?? defaultReaderFor(mailbox, secret, options);
      read = await reader.read(cursor, {
        maxMessages,
        deadline: startedAt + Math.floor(maxDurationMs / 2),
        since: new Date(t.getTime() - FIRST_SYNC_DAYS * 86_400_000),
      });
    } catch (error) {
      summary.failed += 1;
      if (error instanceof ReadError) {
        await finish(workspaceId, mailboxId, {
          error: error.message,
          needsUser: error.kind === "auth",
        });
      } else {
        log.error(`reply-sync: mailbox ${mailboxId} read failed: ${describe(error)}`);
        await finish(workspaceId, mailboxId, {
          error: "We couldn't check this mailbox for replies; we'll try again.",
        });
      }
      return summary;
    }

    let saved: SyncCursor = cursor;
    let aborted = false;
    let partial = false;
    let processed = 0;
    let renewedAt = 0;
    for (const message of read.messages) {
      if (stopped) {
        aborted = true;
        break;
      }
      if (processed > 0 && Date.now() > deadline) {
        // Out of time: keep the cursor at the last message we finished; the rest comes next.
        partial = true;
        break;
      }
      if (Date.now() - renewedAt >= LEASE_RENEW_MS) {
        if (!(await renewLease(workspaceId, mailboxId))) {
          // Another worker may own the mailbox now: write nothing, it continues from the cursor.
          summary.failed += 1;
          log.warn(`reply-sync: mailbox ${mailboxId} lease lost; stopping`);
          return summary;
        }
        renewedAt = Date.now();
      }
      processed += 1;
      try {
        const outcome = await processInbound(
          { db, workspaceId, mailbox, classifier, now: now() },
          message,
        );
        if (outcome === "stored") summary.stored += 1;
        else if (outcome === "duplicate") summary.duplicates += 1;
        else if (outcome === "unmatched") summary.unmatched += 1;
        else summary.ignored += 1;
        if (message.checkpoint) saved = message.checkpoint;
      } catch (error) {
        // Stop here and keep the cursor at the last message we finished: nothing is skipped.
        aborted = true;
        log.error(`reply-sync: mailbox ${mailboxId} processing failed: ${describe(error)}`);
        break;
      }
    }

    if (partial) {
      summary.synced += 1;
      await finish(workspaceId, mailboxId, {
        cursor: saved,
        synced: true,
        error: null,
        more: true,
      });
    } else if (aborted) {
      summary.failed += 1;
      await finish(workspaceId, mailboxId, {
        cursor: saved,
        error: stopped ? undefined : "Some replies couldn't be processed yet; we'll try again.",
      });
    } else {
      summary.synced += 1;
      await finish(workspaceId, mailboxId, { cursor: read.cursor, synced: true, error: null });
    }
    return summary;
  }

  async function runOnce(batch = 20): Promise<SyncSummary> {
    const total = emptySummary();
    const claimed = rowsOf<{ workspace_id: string; mailbox_id: string }>(
      await withIdentity(db, (tx) =>
        tx.execute(sql`SELECT * FROM claim_due_mailbox_syncs(${batch})`),
      ),
    );
    total.claimed = claimed.length;
    for (const row of claimed) {
      if (stopped) break;
      try {
        const s = await syncMailbox(row.workspace_id, row.mailbox_id);
        for (const key of [
          "synced",
          "failed",
          "stored",
          "duplicates",
          "unmatched",
          "ignored",
        ] as const) {
          total[key] += s[key];
        }
      } catch (error) {
        // One bad mailbox never stops the batch; its lease runs out and it is retried.
        total.failed += 1;
        log.error(`reply-sync: mailbox ${row.mailbox_id} failed: ${describe(error)}`);
      }
    }
    return total;
  }

  return {
    runOnce: (batch?: number) => {
      const run = runOnce(batch);
      running = run;
      return run;
    },
    syncMailbox,
    start(pollMs = 15_000) {
      stopped = false;
      const tick = async () => {
        if (stopped) return;
        try {
          running = runOnce();
          await running;
        } catch (error) {
          log.error(`reply-sync: run failed: ${describe(error)}`);
        } finally {
          running = undefined;
          if (!stopped) timer = setTimeout(() => void tick(), pollMs);
        }
      };
      timer = setTimeout(() => void tick(), 2_000);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (running) await running.catch(() => undefined);
    },
  };
}
