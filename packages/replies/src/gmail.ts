/**
 * Gmail reader (gmail.readonly). First sync: messages.list newer_than:7d in INBOX, with the
 * mailbox's current historyId as the cursor. Then history.list from that id (messageAdded, INBOX).
 * Uses fetch directly, like the sending adapter; `fetchImpl` is injectable for tests.
 */
import { refreshGoogleAccessToken, SendError, type GoogleOAuthConfig } from "@openline/email";
import { MAX_SOURCE_BYTES } from "./imap";
import {
  ReadError,
  type MailboxReader,
  type RawInbound,
  type ReadLimits,
  type ReadResult,
  type SyncCursor,
} from "./types";

type FetchLike = typeof fetch;
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Messages bigger than this (Gmail's sizeEstimate) are never downloaded whole. */
export const MAX_GMAIL_MESSAGE_BYTES = 2 * 1024 * 1024;
export const TOO_LARGE_BODY = "[message too large to show — open it in Gmail]";
/** The headers reply detection reads; enough to match and label a message without its body. */
const METADATA_HEADERS = [
  "From",
  "To",
  "Subject",
  "Date",
  "Message-ID",
  "In-Reply-To",
  "References",
  "Auto-Submitted",
  "Precedence",
  "List-Id",
  "List-Unsubscribe",
  "X-Autoreply",
  "X-Autorespond",
];

interface MetadataResponse {
  id: string;
  threadId?: string;
  sizeEstimate?: number;
  payload?: { headers?: { name: string; value: string }[] };
}

/** A header-only RFC 822 message standing in for one too large to download. */
export function headersOnlyMessage(headers: { name: string; value: string }[]): Buffer {
  const allowed = new Set(METADATA_HEADERS.map((h) => h.toLowerCase()));
  const lines = headers
    .filter((h) => allowed.has(h.name.toLowerCase()))
    .map((h) => `${h.name}: ${h.value.replace(/[\r\n]+/g, " ")}`);
  lines.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8");
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n${TOO_LARGE_BODY}\r\n`, "utf8");
}

interface HistoryResponse {
  history?: {
    id: string;
    messagesAdded?: { message: { id: string; threadId?: string; labelIds?: string[] } }[];
  }[];
  historyId?: string;
  nextPageToken?: string;
}

interface Pending {
  id: string;
  threadId?: string;
}

/** Gmail's web link for a thread in this account. */
export function gmailOpenUrl(mailboxEmail: string, threadId: string | null): string | null {
  if (!threadId || !/^[0-9a-f]{1,32}$/i.test(threadId)) return null;
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(mailboxEmail)}#all/${threadId}`;
}

export class GmailReader implements MailboxReader {
  constructor(
    private readonly config: GoogleOAuthConfig,
    private readonly refreshToken: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async accessToken(): Promise<string> {
    try {
      return (await refreshGoogleAccessToken(this.config, this.refreshToken, this.fetchImpl))
        .accessToken;
    } catch (error) {
      if (error instanceof SendError && error.kind === "auth") {
        throw new ReadError("Google access was revoked — turn reply detection on again.", "auth");
      }
      throw new ReadError("Google is temporarily unavailable; we'll try again.", "transient");
    }
  }

  /** GET an API path. Returns null on 404. */
  private async get<T>(token: string, path: string): Promise<T | null> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${API}/${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      throw new ReadError("Google is temporarily unavailable; we'll try again.", "transient");
    }
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) {
      throw new ReadError(
        "Openline isn't allowed to read this mailbox — turn reply detection on again.",
        "auth",
      );
    }
    if (!res.ok) {
      throw new ReadError("Google is temporarily unavailable; we'll try again.", "transient");
    }
    return (await res.json()) as T;
  }

  async read(cursor: SyncCursor, limits: ReadLimits): Promise<ReadResult> {
    const token = await this.accessToken();
    let pending: Pending[] | null = null;
    let nextCursor: string | null = null;
    /** True when this read lists recent mail instead of following history (none or expired). */
    let firstSync = false;

    if (cursor.historyId) {
      pending = [];
      let pageToken: string | undefined;
      let latest = cursor.historyId;
      let truncated = false;
      do {
        const params = new URLSearchParams({
          startHistoryId: cursor.historyId,
          historyTypes: "messageAdded",
          labelId: "INBOX",
          maxResults: "500",
        });
        if (pageToken) params.set("pageToken", pageToken);
        const page = await this.get<HistoryResponse>(token, `history?${params.toString()}`);
        if (!page) {
          pending = null; // history id too old: start over like a first sync
          break;
        }
        for (const record of page.history ?? []) {
          const added = (record.messagesAdded ?? [])
            .map((a) => a.message)
            .filter((m) => {
              const labels = m.labelIds ?? ["INBOX"];
              return (
                labels.includes("INBOX") && !labels.includes("SENT") && !labels.includes("DRAFT")
              );
            });
          if (pending.length + added.length > limits.maxMessages && pending.length) {
            truncated = true;
            break;
          }
          pending.push(...added.map((m) => ({ id: m.id, threadId: m.threadId })));
          latest = record.id; // whole records only, so this is a safe resume point
        }
        if (truncated) break;
        // The response's historyId is "now": only safe once there's no further page to read.
        if (page.historyId && !page.nextPageToken) latest = page.historyId;
        pageToken = page.nextPageToken;
      } while (pageToken && Date.now() < limits.deadline);
      nextCursor = latest;
    }

    if (!pending) {
      firstSync = true;
      const profile = await this.get<{ historyId: string }>(token, "profile");
      if (!profile) throw new ReadError("Gmail didn't return the mailbox profile.", "transient");
      const since = Math.max(1, Math.round((Date.now() - limits.since.getTime()) / 86_400_000));
      const params = new URLSearchParams({
        q: `newer_than:${since}d -in:sent -in:drafts`,
        labelIds: "INBOX",
        maxResults: String(limits.maxMessages),
      });
      const list = await this.get<{ messages?: { id: string; threadId?: string }[] }>(
        token,
        `messages?${params.toString()}`,
      );
      pending = [...(list?.messages ?? [])].reverse(); // the API lists newest first
      nextCursor = profile.historyId;
    }

    const messages: RawInbound[] = [];
    const seen = new Set<string>();
    for (const item of pending) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      if (Date.now() > limits.deadline || messages.length >= limits.maxMessages) {
        // Not finished: keep the old cursor so the rest is read next time (duplicates are skipped).
        // An unfinished first sync (also one replacing an expired history id) stores no history
        // id at all: it starts over next time.
        return { messages, cursor: { historyId: firstSync ? null : (cursor.historyId ?? null) } };
      }
      const path = `messages/${encodeURIComponent(item.id)}`;
      const meta = await this.get<MetadataResponse>(
        token,
        `${path}?format=metadata&${METADATA_HEADERS.map((h) => `metadataHeaders=${encodeURIComponent(h)}`).join("&")}`,
      );
      if (!meta) continue; // deleted meanwhile
      if ((meta.sizeEstimate ?? 0) > MAX_GMAIL_MESSAGE_BYTES) {
        // Too big to download (attachments): match and label it by its headers alone.
        messages.push({
          raw: headersOnlyMessage(meta.payload?.headers ?? []),
          providerMessageId: meta.id,
          providerThreadId: meta.threadId ?? item.threadId,
        });
        continue;
      }
      const full = await this.get<{ id: string; threadId?: string; raw?: string }>(
        token,
        `${path}?format=raw`,
      );
      if (!full?.raw) continue; // deleted meanwhile
      const raw = Buffer.from(full.raw, "base64url");
      messages.push({
        raw: raw.length > MAX_SOURCE_BYTES ? raw.subarray(0, MAX_SOURCE_BYTES) : raw,
        providerMessageId: full.id,
        providerThreadId: full.threadId ?? item.threadId,
      });
    }
    return { messages, cursor: { historyId: nextCursor } };
  }
}
