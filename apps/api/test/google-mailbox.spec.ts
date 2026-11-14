/** Gmail connection: signed OAuth state and the callback redirect. Google itself is faked. */
import type { NestExpressApplication } from "@nestjs/platform-express";
import { eq, mailboxes, withTenant, type DatabaseHandle } from "@openline/db";
import { openJson, type MailboxSecret } from "@openline/email";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CONFIG, type AppConfig } from "../src/config";
import { DB } from "../src/database/database.module";
import { createOAuthState } from "../src/modules/mailboxes/oauth-state";
import { browser, createTestApp, signedUp, verifiedSignup, type Browser } from "./helpers";

const GOOGLE_ENV = {
  GOOGLE_OAUTH_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
  GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
};
const PAGE = "http://localhost:3000/app/settings/mailboxes";

describe("Gmail mailbox connection", () => {
  let app: NestExpressApplication;
  let config: AppConfig;

  beforeAll(async () => {
    app = await createTestApp({ ...GOOGLE_ENV, OUTREACH_TRANSPORT: "capture" });
    config = app.get<AppConfig>(CONFIG);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await app.close();
    for (const key of Object.keys(GOOGLE_ENV)) delete process.env[key];
  });

  const me = async (b: Browser) => (await b.get("/v1/auth/me").expect(200)).body;

  async function callback(b: Browser, state: string, code = "auth-code") {
    const res = await b
      .get(`/v1/mailboxes/google/callback?code=${code}&state=${encodeURIComponent(state)}`)
      .expect(302);
    return res.headers.location as string;
  }

  function fakeGoogle(email: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("https://oauth2.googleapis.com/token")) {
          return new Response(
            JSON.stringify({
              access_token: "access",
              refresh_token: "refresh-token-xyz",
              scope: "https://www.googleapis.com/auth/gmail.send openid",
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ email, email_verified: true }), { status: 200 });
      }),
    );
  }

  it("authorize returns a Google URL with a signed state (verified users only)", async () => {
    const { b: unverified } = await signedUp(app);
    expect((await unverified.get("/v1/mailboxes/google/authorize").expect(403)).body.code).toBe(
      "email_not_verified",
    );

    const { b } = await verifiedSignup(app);
    const res = await b.get("/v1/mailboxes/google/authorize").expect(200);
    const url = new URL(res.body.url as string);
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/v1/mailboxes/google/callback",
    );
    expect(url.searchParams.get("state")).toMatch(/\./);
  });

  it("a valid callback seals the refresh token and redirects with connected=gmail", async () => {
    const { b } = await verifiedSignup(app);
    const state = new URL(
      (await b.get("/v1/mailboxes/google/authorize").expect(200)).body.url as string,
    ).searchParams.get("state")!;
    fakeGoogle("seller@gmail.com");

    expect(await callback(b, state)).toBe(`${PAGE}?connected=gmail`);
    const list = await b.get("/v1/mailboxes").expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ provider: "gmail", email: "seller@gmail.com" });
    expect(JSON.stringify(list.body)).not.toContain("refresh-token-xyz");

    const { workspace } = await me(b);
    const handle = app.get<DatabaseHandle>(DB);
    const [row] = await withTenant(handle.db, { workspaceId: workspace.id as string }, (tx) =>
      tx
        .select()
        .from(mailboxes)
        .where(eq(mailboxes.id, list.body[0].id as string)),
    );
    expect(openJson<MailboxSecret>(row!.secretSealed, config.secretsKey, workspace.id)).toEqual({
      kind: "oauth",
      refreshToken: "refresh-token-xyz",
    });
  });

  it("tampered, expired or someone else's state redirects with an error", async () => {
    const { b } = await verifiedSignup(app);
    const { user, workspace } = await me(b);
    const claims = { workspaceId: workspace.id as string, userId: user.id as string };
    const valid = createOAuthState(claims, config.UNSUBSCRIBE_SECRET);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const [payload, sig] = valid.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ w: claims.workspaceId, u: claims.userId, exp: Date.now() + 9e9 }),
    ).toString("base64url");
    expect(await callback(b, `${forgedPayload}.${sig}`)).toBe(`${PAGE}?error=state_invalid`);
    expect(await callback(b, `${payload}.AAAA`)).toBe(`${PAGE}?error=state_invalid`);

    const expired = createOAuthState(claims, config.UNSUBSCRIBE_SECRET, Date.now() - 11 * 60_000);
    expect(await callback(b, expired)).toBe(`${PAGE}?error=state_expired`);

    const { b: other } = await verifiedSignup(app);
    expect(await callback(other, valid)).toBe(`${PAGE}?error=state_mismatch`);

    expect(await callback(browser(app), valid)).toBe(`${PAGE}?error=signed_out`);
    const denied = await b.get("/v1/mailboxes/google/callback?error=access_denied").expect(302);
    expect(denied.headers.location).toBe(`${PAGE}?error=access_denied`);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await b.get("/v1/mailboxes").expect(200)).body).toHaveLength(0);
  });
});
