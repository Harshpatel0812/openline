/**
 * Gmail API adapter (send only).
 *
 * Scope: https://www.googleapis.com/auth/gmail.send — a "sensitive" scope, which needs Google's
 * OAuth verification but NOT the CASA security assessment that restricted scopes (reading mail)
 * require. Reply detection (Sprint 4) will add gmail.metadata, a restricted scope.
 *
 * Uses fetch directly (no googleapis SDK) to keep the dependency surface small; `fetchImpl` is
 * injectable for tests.
 */
import MailComposer from "nodemailer/lib/mail-composer";
import { SendError, type MailAdapter, type OutgoingEmail, type SendResult } from "./adapter";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

type FetchLike = typeof fetch;

export function googleAuthorizeUrl(
  config: GoogleOAuthConfig,
  state: string,
  loginHint?: string,
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    // Always show consent so Google returns a refresh token.
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  if (loginHint) params.set("login_hint", loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** Exchanges the authorization code for a refresh token and the account's email. */
export async function exchangeGoogleCode(
  config: GoogleOAuthConfig,
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ refreshToken: string; email: string; scopes: string[] }> {
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new SendError("Google sign-in failed", "auth");
  const token = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    scope?: string;
  };
  if (!token.refresh_token) throw new SendError("Google did not return offline access", "auth");
  const scopes = (token.scope ?? "").split(" ");
  if (!scopes.includes("https://www.googleapis.com/auth/gmail.send")) {
    throw new SendError("Permission to send email was not granted", "auth");
  }
  const info = await fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!info.ok) throw new SendError("Could not read the Google account email", "auth");
  const { email, email_verified } = (await info.json()) as {
    email?: string;
    email_verified?: boolean;
  };
  if (!email || email_verified === false)
    throw new SendError("Google account email is not verified", "auth");
  return { refreshToken: token.refresh_token, email: email.toLowerCase(), scopes };
}

/** Builds the raw RFC 5322 message Gmail expects (base64url). */
export async function buildRawMime(email: OutgoingEmail): Promise<string> {
  const composer = new MailComposer({
    from: email.from.name ? { name: email.from.name, address: email.from.email } : email.from.email,
    to: email.to,
    subject: email.subject,
    text: email.text,
    html: email.html,
    headers: email.headers,
    messageId: email.messageId,
    replyTo: email.replyTo,
    inReplyTo: email.inReplyTo,
    references: email.inReplyTo,
  });
  const buffer: Buffer = await new Promise((resolve, reject) =>
    composer.compile().build((err, message) => (err ? reject(err) : resolve(message))),
  );
  return buffer.toString("base64url");
}

export class GmailAdapter implements MailAdapter {
  readonly provider = "gmail" as const;
  private accessToken?: { value: string; expiresAt: number };

  constructor(
    private readonly config: GoogleOAuthConfig,
    private readonly refreshToken: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) {
      return this.accessToken.value;
    }
    const res = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (res.status === 400 || res.status === 401) {
      throw new SendError("Google access was revoked — reconnect the mailbox", "auth");
    }
    if (!res.ok) throw new SendError("Google is temporarily unavailable", "transient");
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  async verify(): Promise<void> {
    await this.token();
  }

  async send(email: OutgoingEmail): Promise<SendResult> {
    const raw = await buildRawMime(email);
    const res = await this.fetchImpl(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await this.token()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          raw,
          ...(email.providerThreadId ? { threadId: email.providerThreadId } : {}),
        }),
      },
    );
    if (res.status === 401 || res.status === 403) {
      throw new SendError("Gmail refused the request — reconnect the mailbox", "auth");
    }
    if (res.status === 400) throw new SendError("Gmail rejected the message", "permanent");
    if (!res.ok) throw new SendError("Gmail is temporarily unavailable", "transient");
    const body = (await res.json()) as { id: string; threadId: string };
    return { providerMessageId: body.id, providerThreadId: body.threadId };
  }
}
