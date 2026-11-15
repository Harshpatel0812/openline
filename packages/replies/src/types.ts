import type { Db, Mailbox } from "@openline/db";
import type { GoogleOAuthConfig, MailboxSecret } from "@openline/email";
import type { ReplyClassification } from "@openline/shared";

/** Where a mailbox's sync left off. IMAP: UIDVALIDITY + highest UID; Gmail: history id. */
export interface SyncCursor {
  uidValidity?: number | null;
  lastUid?: number | null;
  historyId?: string | null;
}

/** One message as read from a mailbox, before parsing. */
export interface RawInbound {
  /** RFC 822 source (possibly truncated to the first few hundred KB). */
  raw: Buffer;
  providerMessageId?: string;
  providerThreadId?: string;
  /** A cursor that is safe to store once this message (and every earlier one) is processed. */
  checkpoint?: SyncCursor;
}

export interface ReadLimits {
  maxMessages: number;
  /** Epoch ms after which the reader stops fetching more. */
  deadline: number;
  /** First sync only: read messages received after this. */
  since: Date;
}

export interface ReadResult {
  /** Oldest first. */
  messages: RawInbound[];
  /** The cursor to store when every message was processed. */
  cursor: SyncCursor;
}

/** Reads new inbound mail from one mailbox. Implementations: ImapReader, GmailReader. */
export interface MailboxReader {
  read(cursor: SyncCursor, limits: ReadLimits): Promise<ReadResult>;
}

/**
 * A read failure. auth = the user must act (password changed, access revoked) — reply detection
 * goes to 'error'; unreachable / transient = retried at the next interval.
 * Messages are written for the user and never contain credentials or message content.
 */
export class ReadError extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "unreachable" | "transient",
  ) {
    super(message);
    this.name = "ReadError";
  }
}

export interface ClassifierInput {
  /** The trimmed reply text. Untrusted: a model-backed classifier must fence it. */
  text: string;
  subject: string;
  from: string;
  /** The workspace the reply belongs to (budget and Scout on/off are per workspace). */
  workspaceId?: string;
  /** The mailbox it arrived in (the per-mailbox daily classification cap). */
  mailboxId?: string;
  /** The message's own date: relative return dates are read against it. */
  sentAt?: Date;
}

/** Result of a classifier; `source` defaults to "model" for injected classifiers. */
export type ClassifierResult = ReplyClassification & { source?: "model" | "rule" };

/**
 * Labels a reply. Injected so Scout's model can be plugged in; the keyword fallback
 * (`keywordClassifier`) is the default. Output is validated; on error or invalid output the
 * keyword fallback is used instead.
 */
export type ReplyClassifier = (input: ClassifierInput) => Promise<ClassifierResult>;

export interface ReplySyncOptions {
  db: Db;
  /** 32-byte key that seals mailbox credentials. */
  secretsKey: Buffer;
  google?: GoogleOAuthConfig;
  classifier?: ReplyClassifier;
  /** Promise Keeper: told about each stored human reply (runs in the background). */
  promiseKeeper?: { afterInboundStored(event: { workspaceId: string; messageId: string }): void };
  /** IMAP hosts on private/loopback addresses: development and test only. */
  allowPrivateHosts?: boolean;
  /** How often each mailbox is synced (REPLY_SYNC_INTERVAL_MS). Default 2 minutes. */
  intervalMs?: number;
  /** Per-sync bounds (spec: ≤ 200 messages, ≤ 30 s). */
  maxMessages?: number;
  maxDurationMs?: number;
  /** Override for tests: the reader for a mailbox. */
  readerFor?: (mailbox: Mailbox, secret: MailboxSecret) => MailboxReader | undefined;
  now?: () => Date;
  logger?: Pick<Console, "warn" | "error">;
}

export interface SyncSummary {
  claimed: number;
  synced: number;
  failed: number;
  stored: number;
  duplicates: number;
  unmatched: number;
  ignored: number;
}

export interface ReplySync {
  /** Claims due mailboxes and syncs each once. */
  runOnce(batch?: number): Promise<SyncSummary>;
  /** Syncs one mailbox now (used by runOnce; handy in tests). */
  syncMailbox(workspaceId: string, mailboxId: string): Promise<SyncSummary>;
  /** Polls for due mailboxes every `pollMs` until stop(). */
  start(pollMs?: number): void;
  stop(): Promise<void>;
}
