/**
 * IMAP reader (imapflow). Same SSRF rules as SMTP: the host is resolved once, private addresses are
 * refused outside development/test, and we connect to that exact address while TLS verifies the
 * certificate against the host name. Port 993 = TLS; 143 = STARTTLS, required (never cleartext).
 * INBOX is opened read-only: syncing never changes flags or moves mail.
 */
import { resolveSafeAddress } from "@openline/email";
import { ImapFlow, type FetchMessageObject, type ImapFlowOptions } from "imapflow";
import {
  ReadError,
  type MailboxReader,
  type RawInbound,
  type ReadLimits,
  type ReadResult,
  type SyncCursor,
} from "./types";

/** Only the first part of each message is fetched: the reply text is at the top. */
export const MAX_SOURCE_BYTES = 256 * 1024;
const FETCH_CHUNK = 20;

export interface ImapSettings {
  host: string;
  port: 993 | 143;
  username: string;
  password: string;
  /** Development/test only. */
  allowPrivate?: boolean;
}

/** The part of ImapFlow we use (so tests can drive the reader with recorded fixtures). */
export interface ImapClientLike {
  connect(): Promise<void>;
  mailboxOpen(
    path: string,
    options?: { readOnly?: boolean },
  ): Promise<{ uidValidity: bigint | number; uidNext: number; exists: number }>;
  search(
    query: { since?: Date; uid?: string },
    options?: { uid?: boolean },
  ): Promise<number[] | false | undefined>;
  fetchAll(
    range: string,
    query: { uid: boolean; source: { maxLength: number } },
    options?: { uid?: boolean },
  ): Promise<Pick<FetchMessageObject, "uid" | "source">[]>;
  logout(): Promise<void>;
  close(): void;
}

export type ImapClientFactory = (options: ImapFlowOptions) => ImapClientLike;

export const defaultImapClientFactory: ImapClientFactory = (options) =>
  new ImapFlow(options) as unknown as ImapClientLike;

/** The connection options for a checked address. Exported for tests. */
export function imapOptions(settings: ImapSettings, address: string): ImapFlowOptions {
  const secure = settings.port === 993;
  return {
    host: address,
    // TLS (and SNI) use the host name, so the certificate is verified against it, not the IP.
    servername: settings.host,
    port: settings.port,
    secure,
    doSTARTTLS: secure ? undefined : true,
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    auth: { user: settings.username, pass: settings.password },
    // Never log: protocol logs contain message content and, at debug level, credentials.
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    maxLiteralSize: 4 * 1024 * 1024,
    maxResponseSize: 8 * 1024 * 1024,
  };
}

function connectError(error: unknown): ReadError {
  const e = error as { authenticationFailed?: boolean; code?: string; serverResponseCode?: string };
  if (e?.authenticationFailed || e?.serverResponseCode === "AUTHENTICATIONFAILED") {
    return new ReadError(
      "The IMAP server rejected the username or password. Many providers need an app password.",
      "auth",
    );
  }
  return new ReadError(
    "We couldn't connect to the IMAP server. Check the host and port.",
    "unreachable",
  );
}

async function open(settings: ImapSettings, factory: ImapClientFactory): Promise<ImapClientLike> {
  const address = await resolveSafeAddress(settings.host, { allowPrivate: settings.allowPrivate });
  if (!address) {
    throw new ReadError("The IMAP server's address isn't reachable from Openline", "unreachable");
  }
  const client = factory(imapOptions(settings, address));
  try {
    await client.connect();
  } catch (error) {
    client.close();
    throw connectError(error);
  }
  return client;
}

async function done(client: ImapClientLike): Promise<void> {
  try {
    await client.logout();
  } catch {
    client.close();
  }
}

/** Checks the login (and that INBOX opens) without reading anything. */
export async function verifyImapLogin(
  settings: ImapSettings,
  factory: ImapClientFactory = defaultImapClientFactory,
): Promise<void> {
  const client = await open(settings, factory);
  try {
    await client.mailboxOpen("INBOX", { readOnly: true });
  } catch {
    throw new ReadError("The IMAP server didn't let us open the inbox.", "unreachable");
  } finally {
    await done(client);
  }
}

export class ImapReader implements MailboxReader {
  constructor(
    private readonly settings: ImapSettings,
    private readonly factory: ImapClientFactory = defaultImapClientFactory,
  ) {}

  async read(cursor: SyncCursor, limits: ReadLimits): Promise<ReadResult> {
    const client = await open(this.settings, this.factory);
    try {
      let box;
      try {
        box = await client.mailboxOpen("INBOX", { readOnly: true });
      } catch {
        throw new ReadError("The IMAP server didn't let us open the inbox.", "transient");
      }
      const uidValidity = Number(box.uidValidity);
      // First sync, or the server renumbered the mailbox: start again from the last 7 days
      // (already stored replies are skipped by the (mailbox, Message-ID) unique index).
      const fresh =
        cursor.uidValidity !== uidValidity ||
        cursor.lastUid === null ||
        cursor.lastUid === undefined;
      const lastUid = fresh ? 0 : Number(cursor.lastUid);
      const found = fresh
        ? await client.search({ since: limits.since }, { uid: true })
        : await client.search({ uid: `${lastUid + 1}:*` }, { uid: true });
      // "N:*" always includes the newest message, even when its UID is below N.
      const uids = [...new Set(found || [])]
        .filter((u) => u > lastUid)
        .sort((a, b) => a - b)
        .slice(0, limits.maxMessages);

      if (!uids.length) {
        const top = fresh ? Math.max(0, box.uidNext - 1) : lastUid;
        return { messages: [], cursor: { uidValidity, lastUid: top } };
      }

      const messages: RawInbound[] = [];
      let seen = lastUid;
      for (let i = 0; i < uids.length; i += FETCH_CHUNK) {
        if (Date.now() > limits.deadline) break;
        const chunk = uids.slice(i, i + FETCH_CHUNK);
        let rows;
        try {
          rows = await client.fetchAll(
            chunk.join(","),
            { uid: true, source: { maxLength: MAX_SOURCE_BYTES } },
            { uid: true },
          );
        } catch {
          if (messages.length) break; // keep what we have; the rest comes next time
          throw new ReadError("Reading the inbox failed; we'll try again.", "transient");
        }
        for (const row of [...rows].sort((a, b) => a.uid - b.uid)) {
          if (row.uid <= lastUid) continue;
          seen = Math.max(seen, row.uid);
          if (!row.source) continue;
          messages.push({ raw: row.source, checkpoint: { uidValidity, lastUid: row.uid } });
        }
      }
      return { messages, cursor: { uidValidity, lastUid: seen } };
    } finally {
      await done(client);
    }
  }
}
