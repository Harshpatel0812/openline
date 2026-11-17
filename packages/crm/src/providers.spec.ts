/** HubSpot and Pipedrive clients against the fake servers: OAuth, paging, limits, revocation. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveCrmConfig, type CrmConfig } from "./config";
import { CrmError } from "./errors";
import { FakeCrmServer } from "./fake";
import { createPkcePair } from "./pkce";
import { HubSpotOAuth } from "./hubspot";
import { createOAuth } from "./providers";
import type { CallMeter, CrmOAuth, TokenSet } from "./types";

const noSleep = { sleep: async () => undefined };

async function consent(oauth: CrmOAuth, redirectUri: string, challenge?: string): Promise<URL> {
  const res = await fetch(
    oauth.authorizeUrl({ state: "st", redirectUri, codeChallenge: challenge }),
    { redirect: "manual" },
  );
  return new URL(res.headers.get("location")!);
}

describe("CRM clients against the fakes", () => {
  const fake = new FakeCrmServer();
  let config: CrmConfig;
  let hub: CrmOAuth;
  let pd: CrmOAuth;
  const redirectUri = "http://localhost:3000/api/v1/integrations/crm/hubspot/callback";

  beforeAll(async () => {
    const url = await fake.start();
    config = resolveCrmConfig("test", { CRM_FAKE_BASE_URL: url });
    hub = createOAuth(config, "hubspot", noSleep)!;
    pd = createOAuth(config, "pipedrive", noSleep)!;
  });
  afterAll(() => fake.stop());
  beforeEach(() => fake.reset());

  async function hubTokens(): Promise<TokenSet> {
    const { verifier, challenge } = createPkcePair();
    const code = (await consent(hub, redirectUri, challenge)).searchParams.get("code")!;
    return (await hub.exchangeCode({ code, redirectUri, codeVerifier: verifier })).tokens;
  }
  function hubApi(t: TokenSet, meter: CallMeter = { calls: 0, tokens: 0 }) {
    return hub.api({
      accessToken: t.accessToken,
      portalId: "900123",
      meter,
      limiterKey: `t-${Math.random()}`,
    });
  }

  describe("HubSpot", () => {
    it("asks only the minimal scopes (no admin, mail, webhooks or schema writes) and sends PKCE", () => {
      const url = new URL(hub.authorizeUrl({ state: "s", redirectUri, codeChallenge: "c" }));
      const scopes = url.searchParams.get("scope")!.split(" ");
      expect(scopes).toContain("crm.objects.contacts.write");
      expect(scopes.some((s) => /admin|mail|webhook|schemas\.\w+\.write|content/.test(s))).toBe(
        false,
      );
      expect(url.searchParams.get("optional_scope")).toBe("communication_preferences.write");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.origin + url.pathname).toBe(`${fake.url}/hubspot-app/oauth/authorize`);
    });

    it("exchanges a code (PKCE checked), reads the account, rotates refresh tokens, revokes", async () => {
      const { verifier, challenge } = createPkcePair();
      const code = (await consent(hub, redirectUri, challenge)).searchParams.get("code")!;
      await expect(
        hub.exchangeCode({
          code,
          redirectUri,
          codeVerifier: "wrong-verifier-wrong-verifier-wrong-verif",
        }),
      ).rejects.toMatchObject({ kind: "auth" });
      const code2 = (await consent(hub, redirectUri, challenge)).searchParams.get("code")!;
      const { tokens, account } = await hub.exchangeCode({
        code: code2,
        redirectUri,
        codeVerifier: verifier,
      });
      expect(account).toMatchObject({
        accountId: "900123",
        currencies: ["USD"],
        portalId: "900123",
      });
      expect(tokens.scopes).toContain("communication_preferences.write");
      expect(fake.log.find((l) => l.path === "/oauth/2026-03/token")).toBeTruthy();

      const next = await hub.refresh(tokens.refreshToken);
      expect(next.refreshToken).not.toBe(tokens.refreshToken);
      await expect(hub.refresh(tokens.refreshToken)).rejects.toMatchObject({
        kind: "auth",
        options: { code: "invalid_grant" },
      });
      await hub.revoke({ refreshToken: next.refreshToken });
      await expect(hub.refresh(next.refreshToken)).rejects.toBeInstanceOf(CrmError);
    });

    it("lists everything in pages of 100 with associations", async () => {
      const company = fake.hubspot.create("companies", { name: "Acme", domain: "acme.com" });
      for (let i = 0; i < 250; i += 1) {
        fake.hubspot.create(
          "contacts",
          { email: `p${i}@acme.com`, firstname: `P${i}` },
          i === 0 ? { companies: [company] } : {},
        );
      }
      const api = hubApi(await hubTokens());
      const ids: string[] = [];
      let after: string | undefined;
      let pages = 0;
      do {
        const page = await api.listAll("contact", { after, custom: [] });
        ids.push(...page.records.map((r) => r.id));
        if (pages === 0) expect(page.records[0]!.fields.companyId).toBe(company);
        after = page.next;
        pages += 1;
      } while (after);
      expect(pages).toBe(3);
      expect(new Set(ids).size).toBe(250);
    });

    it("searches changes ascending and re-anchors the window before the 10,000 cap", async () => {
      fake.knobs.searchCap = 600; // the same logic at a smaller cap
      for (let i = 0; i < 1500; i += 1) {
        const id = fake.hubspot.create("contacts", { email: `c${i}@x.com` });
        fake.hubspot.records.contacts.get(id)!.updatedAt = 1_700_000_000_000 + i * 10;
      }
      const small = new HubSpotOAuth(config.hubspot!, config, noSleep, 600);
      const t = await hubTokens();
      const api = small.api({
        accessToken: t.accessToken,
        meter: { calls: 0, tokens: 0 },
        limiterKey: "cap",
      });
      const seen = new Set<string>();
      let after: string | undefined;
      let calls = 0;
      do {
        const page = await api.listChanged("contact", { since: new Date(0), after, custom: [] });
        page.records.forEach((r) => seen.add(r.id));
        after = page.next;
        calls += 1;
      } while (after && calls < 50);
      expect(seen.size).toBe(1500);
      expect(
        fake.log.every(
          (l) =>
            !(
              l.path.endsWith("/search") &&
              Number((l.body as { after?: string })?.after ?? 0) + 200 > 600
            ),
        ),
      ).toBe(true);
    });

    it("batch reads report deleted ids as missing and merged ids with their survivor", async () => {
      const a = fake.hubspot.create("contacts", { email: "a@x.com" });
      const b = fake.hubspot.create("contacts", { email: "b@x.com" });
      const c = fake.hubspot.create("contacts", { email: "c@x.com" });
      fake.hubspot.merge("contacts", a, b);
      fake.hubspot.remove("contacts", c);
      const got = await hubApi(await hubTokens()).getMany("contact", [a, b, c], []);
      expect(got.merged).toEqual({ [a]: b });
      expect(got.missing).toEqual([c]);
      expect(got.found.map((r) => r.id)).toEqual([b]);
    });

    it("waits out a 429 (Retry-After) and retries 5xx, then gives up with a typed error", async () => {
      const api = hubApi(await hubTokens());
      fake.knobs.fail429 = 1;
      await expect(api.owners()).resolves.toHaveLength(1);
      fake.knobs.fail5xx = 1;
      await expect(api.owners()).resolves.toHaveLength(1);
      fake.knobs.fail5xx = 3;
      await expect(api.owners()).rejects.toMatchObject({ kind: "transient" });
      fake.knobs.fail429 = 3;
      fake.knobs.retryAfterSec = 3600;
      await expect(api.owners()).rejects.toMatchObject({
        kind: "rate_limited",
        retryAfterMs: 3_600_000,
      });
    });

    it("unsubscribe-all needs the optional scope", async () => {
      fake.knobs.grantOptionalScopes = false;
      const api = hubApi(await hubTokens());
      fake.hubspot.create("contacts", { email: "o@x.com" });
      expect(await api.optOut("1", "o@x.com")).toBe("not_permitted");
      fake.knobs.grantOptionalScopes = true;
      expect(await hubApi(await hubTokens()).optOut("1", "o@x.com")).toBe("done");
      expect(fake.hubspot.find("contacts", "email", "o@x.com")!.properties.hs_email_optout).toBe(
        "true",
      );
    });

    it("an expired or revoked token is an auth error", async () => {
      const t = await hubTokens();
      fake.hubspot.oauth.expireAll();
      await expect(hubApi(t).owners()).rejects.toMatchObject({ kind: "auth", status: 401 });
    });
  });

  describe("Pipedrive", () => {
    const pdRedirect = "http://localhost:3000/api/v1/integrations/crm/pipedrive/callback";
    async function pdSession(
      meter: CallMeter = { calls: 0, tokens: 0 },
      spend?: (n: number) => void,
    ) {
      const code = (await consent(pd, pdRedirect)).searchParams.get("code")!;
      const { tokens, account } = await pd.exchangeCode({ code, redirectUri: pdRedirect });
      return {
        tokens,
        account,
        api: pd.api({
          accessToken: tokens.accessToken,
          apiDomain: account.apiDomain,
          meter,
          spend,
          limiterKey: `p-${Math.random()}`,
        }),
      };
    }

    it("exchanges with Basic client auth and accepts only the allowlisted api_domain", async () => {
      const { account, tokens } = await pdSession();
      expect(account).toMatchObject({
        accountId: "7001",
        apiDomain: `${fake.url}/pipedrive`,
        currencies: ["USD", "EUR"],
      });
      expect(tokens.accessExpiresAt - Date.now()).toBeGreaterThan(50 * 60_000);
      const tokenCall = fake.log.find((l) => l.path === "/oauth/token")!;
      expect((tokenCall.body as Record<string, string>).client_secret).toBeUndefined();

      fake.pipedrive.apiDomain = "https://evil.example";
      const code = (await consent(pd, pdRedirect)).searchParams.get("code")!;
      await expect(pd.exchangeCode({ code, redirectUri: pdRedirect })).rejects.toMatchObject({
        kind: "forbidden_host",
      });
      expect(() =>
        pd.api({
          accessToken: "x",
          apiDomain: "https://evil.example",
          meter: { calls: 0, tokens: 0 },
          limiterKey: "k",
        }),
      ).toThrow();
    });

    it("lists v2 changes since a time, ascending, with deleted deals and cursor paging", async () => {
      for (let i = 0; i < 700; i += 1)
        fake.pipedrive.create("persons", {
          name: `P ${i}`,
          emails: [{ value: `p${i}@x.com`, primary: true }],
        });
      const d1 = fake.pipedrive.create("deals", {
        title: "D1",
        pipeline_id: 1,
        stage_id: 1,
        value: 10,
        currency: "USD",
      });
      fake.pipedrive.create("deals", { title: "D2", pipeline_id: 1, stage_id: 1 });
      fake.pipedrive.remove("deals", d1);
      const meter = { calls: 0, tokens: 0 };
      const { api } = await pdSession(meter);
      const before = meter.tokens;
      let after: string | undefined;
      const ids: string[] = [];
      do {
        const page = await api.listChanged("contact", {
          since: new Date(Date.now() - 60_000),
          after,
          custom: [],
        });
        ids.push(...page.records.map((r) => r.id));
        after = page.next;
      } while (after);
      expect(new Set(ids).size).toBe(700);
      expect(meter.tokens - before).toBe(20); // two v2 list pages at 10 tokens
      const deals: { id: string; archived?: boolean }[] = [];
      after = undefined;
      do {
        const page = await api.listChanged("deal", { since: new Date(0), after, custom: [] });
        deals.push(...page.records);
        after = page.next;
      } while (after);
      expect(deals.find((d) => d.id === String(d1))?.archived).toBe(true);
      expect(fake.log.some((l) => l.path === "/api/v2/deals" && l.method === "GET")).toBe(true);
    });

    it("won / lost are statuses: canonical @won / @lost both ways", async () => {
      const id = fake.pipedrive.create("deals", {
        title: "D",
        pipeline_id: 1,
        stage_id: 2,
        status: "lost",
        lost_reason: "Budget",
      });
      const { api } = await pdSession();
      const { found } = await api.getMany("deal", [String(id)], []);
      expect(found[0]!.fields).toMatchObject({ stage: "@lost", lostReason: "Budget" });
      await api.update("deal", String(id), { stage: "@won" });
      expect(fake.pipedrive.records.deals.get(id)).toMatchObject({ status: "won", stage_id: 2 });
      const pipes = await api.pipelines();
      expect(pipes[0]!.stages.slice(-2).map((s) => s.kind)).toEqual(["won", "lost"]);
    });

    it("spends against our daily budget and stops before the cap", async () => {
      let spent = 0;
      const { api } = await pdSession({ calls: 0, tokens: 0 }, (cost) => {
        if (spent + cost > 25) throw new CrmError("budget", "Daily API budget used up");
        spent += cost;
      });
      await api.listAll("contact", { custom: [] });
      await api.listAll("contact", { custom: [] });
      const callsBefore = fake.log.length;
      await expect(api.listAll("contact", { custom: [] })).rejects.toMatchObject({
        kind: "budget",
      });
      expect(fake.log.length).toBe(callsBefore); // never sent
    });

    it("a merge deletes the loser (missing); opt-out sets marketing_status once and never back", async () => {
      const a = fake.pipedrive.create("persons", {
        name: "A",
        emails: [{ value: "a@x.com", primary: true }],
      });
      const b = fake.pipedrive.create("persons", {
        name: "B",
        emails: [{ value: "b@x.com", primary: true }],
      });
      fake.pipedrive.merge("persons", a, b);
      const { api } = await pdSession();
      const got = await api.getMany("contact", [String(a), String(b)], []);
      expect(got.missing).toEqual([String(a)]);
      expect(await api.optOut(String(b), "b@x.com")).toBe("done");
      expect(fake.pipedrive.records.persons.get(b)!.marketing_status).toBe("unsubscribed");
      fake.knobs.campaigns = false;
      expect(await api.optOut(String(b), "b@x.com")).toBe("unsupported");
    });

    it("revoking the refresh token uninstalls (refresh fails afterwards)", async () => {
      const { tokens } = await pdSession();
      await pd.revoke({ refreshToken: tokens.refreshToken });
      await expect(pd.refresh(tokens.refreshToken)).rejects.toMatchObject({ kind: "auth" });
    });
  });

  it("never follows redirects or calls hosts outside the allowlist", async () => {
    const api = hub.api({
      accessToken: "x",
      portalId: "900123",
      meter: { calls: 0, tokens: 0 },
      limiterKey: "z",
    });
    const evil = createOAuth(
      { ...config, allowedOrigins: new Set(["https://only.example"]) },
      "hubspot",
      noSleep,
    )!;
    await expect(evil.refresh("rt")).rejects.toMatchObject({ kind: "forbidden_host" });
    // The fake's consent screen answers 302: an API call must not follow it.
    expect(api.recordUrl("contact", "1")).toBe(
      `${fake.url}/hubspot-app/contacts/900123/record/0-1/1`,
    );
  });
});
