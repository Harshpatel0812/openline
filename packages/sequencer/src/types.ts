import type { Db } from "@openline/db";
import type { GoogleOAuthConfig, MailAdapter, SmtpConfig } from "@openline/email";

/**
 * Where sequence emails really go:
 *  - real:    through each mailbox (production)
 *  - sandbox: everything through one SMTP server, e.g. Mailpit (local/staging — never real prospects)
 *  - capture: kept in memory (tests)
 */
export type OutreachTransport =
  { mode: "real" } | { mode: "sandbox"; smtp: SmtpConfig } | { mode: "capture" };

export interface SequencerOptions {
  db: Db;
  /** 32-byte key that seals mailbox credentials. */
  secretsKey: Buffer;
  unsubscribeSecret: string;
  /** Public web origin used in unsubscribe links, e.g. https://app.openline.app */
  webUrl: string;
  google?: GoogleOAuthConfig;
  outreach: OutreachTransport;
  /**
   * Allow SMTP mailboxes whose host resolves to a private/loopback address (development and test
   * only). Otherwise every real send re-resolves the host and connects to the checked address.
   */
  allowPrivateSmtpHosts?: boolean;
  /** Override for tests: build the adapter for a mailbox. */
  adapterFor?: (mailbox: { provider: string; email: string }) => MailAdapter | undefined;
  now?: () => Date;
  random?: () => number;
  logger?: Pick<Console, "warn" | "error">;
}

export interface RunSummary {
  claimed: number;
  sent: number;
  deferred: number;
  finished: number;
  failed: number;
}

export interface Sequencer {
  /** Claims and processes up to `batch` due enrollments. */
  runOnce(batch?: number): Promise<RunSummary>;
  /** Polls every `intervalMs` until stop(). */
  start(intervalMs?: number): void;
  stop(): Promise<void>;
}
