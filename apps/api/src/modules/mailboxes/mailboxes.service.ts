import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import {
  and,
  asc,
  count,
  enrollments,
  eq,
  inArray,
  mailboxes,
  messages,
  sql,
  withTenant,
  type DatabaseHandle,
  type Mailbox,
  type Tx,
} from "@openline/db";
import {
  exchangeGoogleCode,
  GMAIL_READONLY_SCOPE,
  googleAuthorizeUrl,
  openJson,
  pinSmtpConfig,
  sameRegistrableDomain,
  SendError,
  sealJson,
  SmtpAdapter,
  type MailboxSecret,
} from "@openline/email";
import { ReadError, verifyImapLogin, type ImapSettings } from "@openline/replies";
import type {
  ImapSettingsInput,
  MailboxDto,
  MailboxUpdateInputSchema,
  SmtpMailboxInput,
} from "@openline/shared";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth-context";
import { ApiException, forbidden, notFound } from "../../common/http";
import { requireVerified } from "../../common/verified";
import { CONFIG, type AppConfig } from "../../config";
import { DB } from "../../database/database.module";
import { AuditService } from "../audit/audit.service";
import { loadWorkspace } from "../workspace/workspace.service";
import { createOAuthState, verifyOAuthState } from "./oauth-state";

type MailboxUpdateInput = z.infer<typeof MailboxUpdateInputSchema>;

/**
 * A removed mailbox keeps its row (enrollments reference it and keep their history) but loses its
 * credentials: status "disconnected" and an empty secret. Removed rows are invisible to the API.
 */
export const REMOVED_SECRET = "";
const notRemoved = sql`${mailboxes.secretSealed} <> ''`;

const googleNotConfigured = () =>
  new ApiException(
    HttpStatus.NOT_IMPLEMENTED,
    "google_not_configured",
    "Gmail connections are not set up on this server yet",
  );

const replyDetectionUnavailable = () =>
  new ApiException(
    HttpStatus.CONFLICT,
    "reply_detection_unavailable",
    "Reply detection isn't available for this kind of mailbox",
  );

/** Checks an IMAP login. Replaceable in tests (see test/replies.spec.ts). */
export type ImapVerifier = (settings: ImapSettings) => Promise<void>;

/** Sync cursor + error fields reset whenever reply detection is (re)configured. */
const FRESH_SYNC = {
  syncUidValidity: null,
  syncLastUid: null,
  syncHistoryId: null,
  lastSyncError: null,
  syncLockedUntil: null,
} as const;

function toDto(m: Mailbox, sentToday: number): MailboxDto {
  // Deliberately field by field: secret_sealed and SMTP settings never leave the API.
  return {
    id: m.id,
    provider: m.provider,
    email: m.email,
    displayName: m.displayName,
    status: m.status,
    dailyCap: m.dailyCap,
    sentToday,
    lastError: m.lastError,
    ownerId: m.userId,
    createdAt: m.createdAt.toISOString(),
    replyDetection: m.replyDetection,
    lastSyncedAt: m.lastSyncedAt?.toISOString() ?? null,
    lastSyncError: m.lastSyncError,
  };
}

@Injectable()
export class MailboxesService {
  /**
   * Checks an IMAP login before it is saved. Like SMTP's check, it is skipped with the in-memory
   * test transport; tests that exercise it replace this.
   */
  imapVerifier: ImapVerifier;

  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {
    this.imapVerifier =
      config.OUTREACH_TRANSPORT === "capture" ? async () => undefined : (st) => verifyImapLogin(st);
  }

  private scope<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, { workspaceId: auth.workspaceId, userId: auth.userId }, fn);
  }

  list(auth: AuthContext): Promise<MailboxDto[]> {
    return this.scope(auth, async (tx) => {
      const rows = await tx
        .select()
        .from(mailboxes)
        .where(and(eq(mailboxes.workspaceId, auth.workspaceId), notRemoved))
        .orderBy(asc(mailboxes.createdAt), asc(mailboxes.id));
      const sent = await this.sentToday(
        tx,
        auth.workspaceId,
        rows.map((r) => r.id),
      );
      return rows.map((r) => toDto(r, sent.get(r.id) ?? 0));
    });
  }

  /**
   * Outbound messages per mailbox since local midnight in the workspace's default time zone.
   * (The engine's cap itself is a rolling 24 hours.)
   */
  private async sentToday(
    tx: Tx,
    workspaceId: string,
    ids: string[],
  ): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const ws = await loadWorkspace(tx, workspaceId);
    const rows = await tx
      .select({ mailboxId: messages.mailboxId, n: count() })
      .from(messages)
      .where(
        and(
          eq(messages.workspaceId, workspaceId),
          inArray(messages.mailboxId, ids),
          eq(messages.direction, "outbound"),
          sql`${messages.sentAt} >= (date_trunc('day', now() AT TIME ZONE ${ws.defaultTimeZone}) AT TIME ZONE ${ws.defaultTimeZone})`,
        ),
      )
      .groupBy(messages.mailboxId);
    return new Map(rows.map((r) => [r.mailboxId!, Number(r.n)]));
  }

  async connectSmtp(auth: AuthContext, input: SmtpMailboxInput): Promise<MailboxDto> {
    requireVerified(auth);
    // Check the login BEFORE saving anything. Skipped only with the in-memory test transport.
    if (this.config.OUTREACH_TRANSPORT !== "capture") {
      try {
        // Resolve once, refuse private addresses (SSRF), and verify against that exact address.
        const smtp = await pinSmtpConfig(
          {
            host: input.host,
            port: input.port,
            secure: input.secure,
            username: input.username,
            password: input.password,
          },
          { allowPrivate: this.config.allowPrivateSmtpHosts },
        ).catch(() => {
          throw new ApiException(
            HttpStatus.BAD_REQUEST,
            "mailbox_unreachable",
            "We couldn't reach that SMTP server. Check the host and port.",
          );
        });
        await new SmtpAdapter(smtp).verify();
      } catch (error) {
        if (error instanceof SendError && error.kind === "auth") {
          throw new ApiException(
            HttpStatus.BAD_REQUEST,
            "mailbox_auth_failed",
            "The SMTP server rejected the username or password. Many providers need an app password.",
          );
        }
        throw new ApiException(
          HttpStatus.BAD_REQUEST,
          "mailbox_unreachable",
          "We couldn't reach that SMTP server. Check the host, port and security setting.",
        );
      }
    }

    const secret: MailboxSecret = {
      kind: "smtp",
      username: input.username,
      password: input.password,
    };
    const values = {
      userId: auth.userId,
      provider: "smtp" as const,
      displayName: input.displayName ?? null,
      status: "active" as const,
      dailyCap: input.dailyCap,
      smtpHost: input.host,
      smtpPort: input.port,
      smtpSecure: input.secure,
      secretSealed: sealJson(secret, this.config.secretsKey, auth.workspaceId),
      lastError: null,
      updatedAt: new Date(),
    };

    return this.scope(auth, async (tx) => {
      const existing = await this.findByEmail(tx, auth.workspaceId, input.email);
      let row: Mailbox;
      if (existing && existing.secretSealed !== REMOVED_SECRET) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          "conflict",
          "This mailbox is already connected in your workspace",
        );
      } else if (existing) {
        // Reconnecting a removed address revives its row (its old enrollments stay stopped).
        [row] = (await tx
          .update(mailboxes)
          .set(values)
          .where(and(eq(mailboxes.id, existing.id), eq(mailboxes.workspaceId, auth.workspaceId)))
          .returning()) as [Mailbox];
      } else {
        [row] = (await tx
          .insert(mailboxes)
          .values({ ...values, workspaceId: auth.workspaceId, email: input.email })
          .returning()) as [Mailbox];
      }
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "mailbox.connected",
        entity: "mailbox",
        entityId: row.id,
        metadata: { provider: "smtp" },
      });
      return toDto(row, 0);
    });
  }

  googleAuthorize(auth: AuthContext): { url: string } {
    if (!this.config.google) throw googleNotConfigured();
    requireVerified(auth);
    const state = createOAuthState(
      { workspaceId: auth.workspaceId, userId: auth.userId },
      this.config.UNSUBSCRIBE_SECRET,
    );
    return { url: googleAuthorizeUrl(this.config.google, state, auth.user.email) };
  }

  /** Returns where to redirect the browser (always the web app's mailbox settings page). */
  async googleCallback(
    auth: AuthContext | undefined,
    query: { code?: string; state?: string; error?: string },
  ): Promise<string> {
    const page = `${this.config.WEB_URL}/app/settings/mailboxes`;
    const fail = (code: string) => `${page}?error=${encodeURIComponent(code)}`;
    if (!this.config.google) return fail("google_not_configured");
    if (!auth) return fail("signed_out");
    if (query.error)
      return fail(query.error === "access_denied" ? "access_denied" : "google_failed");
    if (!query.state || !query.code) return fail("state_invalid");
    const check = verifyOAuthState(query.state, this.config.UNSUBSCRIBE_SECRET);
    if (!check.ok) return fail(check.error);
    if (check.state.u !== auth.userId || check.state.w !== auth.workspaceId) {
      return fail("state_mismatch");
    }
    if (!auth.emailVerified) return fail("email_not_verified");

    let account: { refreshToken: string; email: string; scopes: string[] };
    try {
      account = await exchangeGoogleCode(this.config.google, query.code);
    } catch {
      return fail("google_failed");
    }

    const secret: MailboxSecret = { kind: "oauth", refreshToken: account.refreshToken };
    const sealed = sealJson(secret, this.config.secretsKey, auth.workspaceId);
    const canRead = account.scopes.includes(GMAIL_READONLY_SCOPE);
    if (check.state.m) {
      return this.replyDetectionCallback(auth, check.state.m, account.email, sealed, canRead, page);
    }
    return this.scope(auth, async (tx) => {
      const existing = await this.findByEmail(tx, auth.workspaceId, account.email);
      if (
        existing &&
        existing.secretSealed !== REMOVED_SECRET &&
        (existing.userId !== auth.userId || existing.provider !== "gmail")
      ) {
        return fail("mailbox_taken");
      }
      // A reconnect keeps reply detection on only if Google still grants read access.
      const keepReading =
        canRead && existing?.provider === "gmail" && existing.secretSealed !== REMOVED_SECRET;
      const values = {
        userId: auth.userId,
        provider: "gmail" as const,
        status: "active" as const,
        smtpHost: null,
        smtpPort: null,
        smtpSecure: null,
        imapHost: null,
        imapPort: null,
        imapSecure: null,
        secretSealed: sealed,
        lastError: null,
        updatedAt: new Date(),
        ...(keepReading && existing.replyDetection !== "off"
          ? { replyDetection: "on" as const, lastSyncError: null, nextSyncAt: new Date() }
          : { replyDetection: "off" as const, nextSyncAt: null }),
      };
      let id: string;
      if (existing) {
        // Reconnect (fresh refresh token) or revive a removed row.
        await tx
          .update(mailboxes)
          .set(values)
          .where(and(eq(mailboxes.id, existing.id), eq(mailboxes.workspaceId, auth.workspaceId)));
        id = existing.id;
      } else {
        const [created] = await tx
          .insert(mailboxes)
          .values({ ...values, workspaceId: auth.workspaceId, email: account.email })
          .returning({ id: mailboxes.id });
        id = created!.id;
      }
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "mailbox.connected",
        entity: "mailbox",
        entityId: id,
        metadata: { provider: "gmail" },
      });
      return `${page}?connected=gmail`;
    });
  }

  async update(auth: AuthContext, id: string, input: MailboxUpdateInput): Promise<MailboxDto> {
    return this.scope(auth, async (tx) => {
      const mailbox = await this.loadEditable(tx, auth, id);
      const patch: Partial<typeof mailboxes.$inferInsert> = { updatedAt: new Date() };
      if (input.displayName !== undefined) patch.displayName = input.displayName || null;
      if (input.dailyCap !== undefined) patch.dailyCap = input.dailyCap;
      if (input.status !== undefined && input.status !== mailbox.status) {
        patch.status = input.status;
        if (input.status === "active") patch.lastError = null;
      }
      const [row] = await tx
        .update(mailboxes)
        .set(patch)
        .where(and(eq(mailboxes.id, id), eq(mailboxes.workspaceId, auth.workspaceId)))
        .returning();
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "mailbox.updated",
        entity: "mailbox",
        entityId: id,
        metadata: { fields: Object.keys(input), status: row!.status },
      });
      const sent = await this.sentToday(tx, auth.workspaceId, [id]);
      return toDto(row!, sent.get(id) ?? 0);
    });
  }

  /** Erases the credentials and stops the mailbox's active/paused enrollments. */
  async remove(auth: AuthContext, id: string): Promise<void> {
    await this.scope(auth, async (tx) => {
      await this.loadEditable(tx, auth, id);
      await tx
        .update(mailboxes)
        .set({
          status: "disconnected",
          secretSealed: REMOVED_SECRET,
          replyDetection: "off",
          nextSyncAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(mailboxes.id, id), eq(mailboxes.workspaceId, auth.workspaceId)));
      const stopped = await tx
        .update(enrollments)
        .set({
          state: "stopped",
          lastDecision: "mailbox_removed",
          nextRunAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(enrollments.workspaceId, auth.workspaceId),
            eq(enrollments.mailboxId, id),
            inArray(enrollments.state, ["active", "paused"]),
          ),
        )
        .returning({ id: enrollments.id });
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "mailbox.removed",
        entity: "mailbox",
        entityId: id,
        metadata: { enrollmentsStopped: stopped.length },
      });
    });
  }

  // ---------------------------------------------------------------- reply detection

  /** Adds or replaces IMAP settings on an SMTP mailbox (login verified first) → reply detection on. */
  async setImap(auth: AuthContext, id: string, input: ImapSettingsInput): Promise<MailboxDto> {
    requireVerified(auth);
    const mailbox = await this.scope(auth, (tx) => this.loadEditable(tx, auth, id));
    if (mailbox.provider !== "smtp") throw replyDetectionUnavailable();
    const current = openJson<MailboxSecret>(
      mailbox.secretSealed,
      this.config.secretsKey,
      auth.workspaceId,
    );
    if (current.kind !== "smtp") throw replyDetectionUnavailable();
    const separate =
      input.username !== undefined && input.password !== undefined
        ? { username: input.username, password: input.password }
        : undefined;
    // The SMTP login is only sent to an IMAP server when the caller owns the mailbox (it's their
    // own password) or the IMAP host is on the SMTP host's domain. Otherwise an admin could point a
    // rep's mailbox at a host they control and collect the rep's stored password.
    if (
      !separate &&
      mailbox.userId !== auth.userId &&
      !(mailbox.smtpHost && sameRegistrableDomain(input.host, mailbox.smtpHost))
    ) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        "imap_credentials_required",
        "Enter the IMAP username and password: the SMTP login is only reused for an IMAP server on the same domain as the SMTP server.",
      );
    }
    const login = separate ?? { username: current.username, password: current.password };

    try {
      // Same SSRF rules as SMTP: resolved once, private addresses refused, connected by address.
      await this.imapVerifier({
        host: input.host,
        port: input.port as 993 | 143,
        ...login,
        allowPrivate: this.config.allowPrivateSmtpHosts,
      });
    } catch (error) {
      if (error instanceof ReadError && error.kind === "auth") {
        throw new ApiException(
          HttpStatus.BAD_REQUEST,
          "imap_auth_failed",
          "The IMAP server rejected the username or password. Many providers need an app password.",
        );
      }
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        "imap_unreachable",
        "We couldn't reach that IMAP server. Check the host and port (993 for TLS, 143 for STARTTLS).",
      );
    }

    const secret: MailboxSecret = {
      kind: "smtp",
      username: current.username,
      password: current.password,
      ...(separate ? { imap: separate } : {}),
    };
    return this.scope(auth, async (tx) => {
      await this.loadEditable(tx, auth, id);
      const [row] = await tx
        .update(mailboxes)
        .set({
          imapHost: input.host.toLowerCase(),
          imapPort: input.port,
          imapSecure: input.port === 993,
          secretSealed: sealJson(secret, this.config.secretsKey, auth.workspaceId),
          replyDetection: "on",
          ...FRESH_SYNC,
          nextSyncAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(mailboxes.id, id), eq(mailboxes.workspaceId, auth.workspaceId)))
        .returning();
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "mailbox.reply_detection_on",
        entity: "mailbox",
        entityId: id,
        metadata: { via: "imap", separateLogin: Boolean(separate) },
      });
      const sent = await this.sentToday(tx, auth.workspaceId, [id]);
      return toDto(row!, sent.get(id) ?? 0);
    });
  }

  /** Turns reply detection off (SMTP: forgets the IMAP settings and login). */
  async removeImap(auth: AuthContext, id: string): Promise<MailboxDto> {
    return this.scope(auth, async (tx) => {
      const mailbox = await this.loadEditable(tx, auth, id);
      if (mailbox.provider === "graph") throw replyDetectionUnavailable();
      const patch: Partial<typeof mailboxes.$inferInsert> = {
        replyDetection: "off",
        ...FRESH_SYNC,
        nextSyncAt: null,
        updatedAt: new Date(),
      };
      if (mailbox.provider === "smtp") {
        const current = openJson<MailboxSecret>(
          mailbox.secretSealed,
          this.config.secretsKey,
          auth.workspaceId,
        );
        if (current.kind === "smtp") {
          const smtpOnly: MailboxSecret = {
            kind: "smtp",
            username: current.username,
            password: current.password,
          };
          patch.secretSealed = sealJson(smtpOnly, this.config.secretsKey, auth.workspaceId);
        }
        Object.assign(patch, { imapHost: null, imapPort: null, imapSecure: null });
      }
      const [row] = await tx
        .update(mailboxes)
        .set(patch)
        .where(and(eq(mailboxes.id, id), eq(mailboxes.workspaceId, auth.workspaceId)))
        .returning();
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "mailbox.reply_detection_off",
        entity: "mailbox",
        entityId: id,
        metadata: { provider: mailbox.provider },
      });
      const sent = await this.sentToday(tx, auth.workspaceId, [id]);
      return toDto(row!, sent.get(id) ?? 0);
    });
  }

  /**
   * Google consent URL adding gmail.readonly to what was granted (incremental consent). Only the
   * mailbox's owner can grant it: it is their Google account.
   */
  async googleReplyDetectionUrl(auth: AuthContext, id: string): Promise<string> {
    if (!this.config.google) throw googleNotConfigured();
    requireVerified(auth);
    const mailbox = await this.scope(auth, (tx) => this.loadEditable(tx, auth, id));
    if (mailbox.provider !== "gmail") throw replyDetectionUnavailable();
    if (mailbox.userId !== auth.userId) {
      throw forbidden("Only the mailbox's owner can give Openline access to read replies");
    }
    const state = createOAuthState(
      { workspaceId: auth.workspaceId, userId: auth.userId, mailboxId: mailbox.id },
      this.config.UNSUBSCRIBE_SECRET,
    );
    return googleAuthorizeUrl(this.config.google, state, mailbox.email, [GMAIL_READONLY_SCOPE]);
  }

  private async replyDetectionCallback(
    auth: AuthContext,
    mailboxId: string,
    accountEmail: string,
    sealed: string,
    canRead: boolean,
    page: string,
  ): Promise<string> {
    const fail = (code: string) => `${page}?error=${encodeURIComponent(code)}`;
    if (!canRead) return fail("reply_access_denied");
    return this.scope(auth, async (tx) => {
      const [mailbox] = await tx
        .select()
        .from(mailboxes)
        .where(
          and(
            eq(mailboxes.id, mailboxId),
            eq(mailboxes.workspaceId, auth.workspaceId),
            eq(mailboxes.provider, "gmail"),
            eq(mailboxes.userId, auth.userId),
            notRemoved,
          ),
        )
        .limit(1);
      if (!mailbox) return fail("mailbox_not_found");
      // The consent must come from the mailbox's own Google account.
      if (mailbox.email !== accountEmail) return fail("wrong_google_account");
      await tx
        .update(mailboxes)
        .set({
          secretSealed: sealed,
          replyDetection: "on",
          ...FRESH_SYNC,
          nextSyncAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(mailboxes.id, mailbox.id), eq(mailboxes.workspaceId, auth.workspaceId)));
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "mailbox.reply_detection_on",
        entity: "mailbox",
        entityId: mailbox.id,
        metadata: { via: "gmail" },
      });
      return `${page}?reply_detection=on`;
    });
  }

  // ---------------------------------------------------------------- helpers

  /** A visible (not removed) mailbox in this workspace, or 404. */
  async load(tx: Tx, workspaceId: string, id: string): Promise<Mailbox> {
    const [row] = await tx
      .select()
      .from(mailboxes)
      .where(and(eq(mailboxes.id, id), eq(mailboxes.workspaceId, workspaceId), notRemoved))
      .limit(1);
    if (!row) throw notFound("Mailbox");
    return row;
  }

  /** The mailbox's owner, workspace owners and admins may change it. */
  async loadEditable(tx: Tx, auth: AuthContext, id: string): Promise<Mailbox> {
    const mailbox = await this.load(tx, auth.workspaceId, id);
    if (mailbox.userId !== auth.userId && auth.role !== "owner" && auth.role !== "admin") {
      throw forbidden("Only the mailbox's owner or an admin can change it");
    }
    return mailbox;
  }

  private async findByEmail(tx: Tx, workspaceId: string, email: string) {
    const [row] = await tx
      .select()
      .from(mailboxes)
      .where(and(eq(mailboxes.workspaceId, workspaceId), eq(mailboxes.email, email)))
      .limit(1);
    return row;
  }
}
