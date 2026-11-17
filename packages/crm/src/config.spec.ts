/** APP_ENV rule: non-production only talks to the fakes or allowlisted sandbox accounts. */
import { describe, expect, it } from "vitest";
import {
  accountAllowed,
  availableProviders,
  checkPipedriveDomain,
  resolveCrmConfig,
} from "./config";

const creds = {
  CRM_HUBSPOT_CLIENT_ID: "id",
  CRM_HUBSPOT_CLIENT_SECRET: "secret",
  CRM_PIPEDRIVE_CLIENT_ID: "id",
  CRM_PIPEDRIVE_CLIENT_SECRET: "secret",
};

describe("CRM config", () => {
  it("development and test default to the local fakes on loopback", () => {
    for (const env of ["development", "test"] as const) {
      const c = resolveCrmConfig(env, {});
      expect(c.mode).toBe("fake");
      expect(c.hubspot?.apiBase).toBe("http://127.0.0.1:4900/hubspot");
      expect(c.pipedrive?.oauthBase).toBe("http://127.0.0.1:4900/pipedrive-oauth");
      expect(availableProviders(c)).toEqual(["hubspot", "pipedrive"]);
      expect([...c.allowedOrigins]).toEqual(["http://127.0.0.1:4900"]);
    }
  });

  it("fake mode refuses non-loopback fake URLs and overrides", () => {
    expect(() => resolveCrmConfig("test", { CRM_FAKE_BASE_URL: "https://evil.example" })).toThrow(
      /loopback/,
    );
    expect(() =>
      resolveCrmConfig("test", { CRM_HUBSPOT_API_BASE: "https://api.hubapi.com" }),
    ).toThrow(/loopback/);
  });

  it("development may not reach real CRMs unless in sandbox mode with an allowlist", () => {
    expect(() => resolveCrmConfig("development", { CRM_MODE: "live", ...creds })).toThrow(
      /production/,
    );
    // Sandbox without an allowlist fails closed: no provider can be connected.
    expect(
      availableProviders(resolveCrmConfig("development", { CRM_MODE: "sandbox", ...creds })),
    ).toEqual([]);
    const c = resolveCrmConfig("development", {
      CRM_MODE: "sandbox",
      CRM_SANDBOX_ACCOUNT_IDS: "123, 7001",
      ...creds,
    });
    expect(c.hubspot?.apiBase).toBe("https://api.hubapi.com");
    expect(accountAllowed(c, "123")).toBe(true);
    expect(accountAllowed(c, "999")).toBe(false);
  });

  it("staging defaults to sandbox (real hosts, allowlisted accounts only) and refuses fake/live", () => {
    expect(availableProviders(resolveCrmConfig("staging", creds))).toEqual([]);
    const c = resolveCrmConfig("staging", { CRM_SANDBOX_ACCOUNT_IDS: "123", ...creds });
    expect(c.mode).toBe("sandbox");
    expect(() => resolveCrmConfig("staging", { CRM_MODE: "fake" })).toThrow();
    expect(() => resolveCrmConfig("staging", { CRM_MODE: "live", ...creds })).toThrow();
    expect(() =>
      resolveCrmConfig("staging", {
        CRM_SANDBOX_ACCOUNT_IDS: "1",
        CRM_HUBSPOT_API_BASE: "http://127.0.0.1:1",
        ...creds,
      }),
    ).toThrow(/https/);
  });

  it("production is live only, with fixed hosts and no overrides", () => {
    const c = resolveCrmConfig("production", creds);
    expect(c.mode).toBe("live");
    expect(accountAllowed(c, "anything")).toBe(true);
    expect(() => resolveCrmConfig("production", { CRM_MODE: "fake" })).toThrow();
    expect(() =>
      resolveCrmConfig("production", { CRM_MODE: "sandbox", CRM_SANDBOX_ACCOUNT_IDS: "1" }),
    ).toThrow();
    expect(() =>
      resolveCrmConfig("production", { ...creds, CRM_HUBSPOT_API_BASE: "https://x.example" }),
    ).toThrow(/overridden/);
    // Without credentials a provider is simply unavailable (no fake defaults outside fake mode).
    expect(availableProviders(resolveCrmConfig("production", {}))).toEqual([]);
  });

  it("accepts only *.pipedrive.com API domains outside fake mode", () => {
    const c = resolveCrmConfig("production", creds);
    expect(checkPipedriveDomain(c, "https://acme.pipedrive.com")).toBe(
      "https://acme.pipedrive.com",
    );
    for (const bad of [
      "https://acme.pipedrive.com.evil.io",
      "http://acme.pipedrive.com",
      "https://evil.io",
      "https://a.b.pipedrive.com",
      5,
    ]) {
      expect(() => checkPipedriveDomain(c, bad)).toThrow();
    }
  });

  it("intervals are configurable", () => {
    const c = resolveCrmConfig("test", { CRM_HUBSPOT_INTERVAL_MS: "5000" });
    expect(c.intervals).toEqual({ hubspot: 5000, pipedrive: 900_000, idle: 1_800_000 });
    expect(() => resolveCrmConfig("test", { CRM_HUBSPOT_INTERVAL_MS: "5" })).toThrow();
  });
});
