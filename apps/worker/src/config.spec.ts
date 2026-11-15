import { describe, expect, it } from "vitest";
import { DEV_SECRETS_KEY, loadWorkerConfig } from "./config";

const base = { DATABASE_URL: "postgres://db:5432/openline" };

describe("worker config guardrails", () => {
  it("refuses PGlite (the API runs the engine in-process instead)", () => {
    expect(() => loadWorkerConfig({ DATABASE_URL: "pglite://memory" })).toThrow(/postgres/);
  });

  it("defaults to capture outside production — never real sends by accident", () => {
    expect(loadWorkerConfig(base).outreach.mode).toBe("capture");
    expect(() => loadWorkerConfig({ ...base, OUTREACH_TRANSPORT: "real" })).toThrow(
      /ALLOW_REAL_SENDING/,
    );
  });

  it("refuses development secrets in production", () => {
    expect(() =>
      loadWorkerConfig({
        ...base,
        NODE_ENV: "production",
        APP_ENV: "production",
        SECRETS_KEY: DEV_SECRETS_KEY,
      }),
    ).toThrow(/SECRETS_KEY/);
  });

  const prodSecrets = {
    SECRETS_KEY: Buffer.alloc(32, 1).toString("base64"),
    UNSUBSCRIBE_SECRET: "a-real-unsubscribe-secret-value",
  };

  it("refuses a production build that doesn't say whether it is staging or production", () => {
    expect(() => loadWorkerConfig({ ...base, ...prodSecrets, NODE_ENV: "production" })).toThrow(
      /APP_ENV/,
    );
  });

  it("staging (a production build) never defaults to real sending", () => {
    const staging = { ...base, ...prodSecrets, NODE_ENV: "production", APP_ENV: "staging" };
    expect(loadWorkerConfig(staging).outreach.mode).toBe("capture");
    // SMTP_URL alone (a real provider in staging) is never used as the outreach sandbox.
    expect(loadWorkerConfig({ ...staging, SMTP_URL: "smtp://ses:587" }).outreach.mode).toBe(
      "capture",
    );
    expect(
      loadWorkerConfig({ ...staging, OUTREACH_SANDBOX_SMTP_URL: "smtp://mailpit:1025" }).outreach
        .mode,
    ).toBe("sandbox");
    expect(() => loadWorkerConfig({ ...staging, OUTREACH_TRANSPORT: "real" })).toThrow(
      /ALLOW_REAL_SENDING/,
    );
    expect(loadWorkerConfig(staging).allowPrivateSmtpHosts).toBe(false);
  });

  it("production sends for real and refuses private SMTP hosts", () => {
    const cfg = loadWorkerConfig({
      ...base,
      ...prodSecrets,
      NODE_ENV: "production",
      APP_ENV: "production",
    });
    expect(cfg.outreach.mode).toBe("real");
    expect(cfg.allowPrivateSmtpHosts).toBe(false);
  });

  it("sends everything to the sandbox SMTP server when asked", () => {
    const cfg = loadWorkerConfig({
      ...base,
      OUTREACH_TRANSPORT: "sandbox",
      SMTP_URL: "smtp://localhost:1025?requireTLS=false",
    });
    expect(cfg.outreach).toMatchObject({
      mode: "sandbox",
      smtp: { host: "localhost", port: 1025, requireTls: false },
    });
  });
});

describe("worker config: reply sync", () => {
  it("defaults to a 2-minute reply sync and the keyword classifier", () => {
    const c = loadWorkerConfig(base);
    expect(c.replySyncIntervalMs).toBe(120_000);
    expect(c.ai.provider).toBe("off");
  });

  it("applies the API's Scout provider rules", () => {
    expect(() =>
      loadWorkerConfig({
        ...base,
        NODE_ENV: "production",
        APP_ENV: "production",
        SECRETS_KEY: Buffer.alloc(32, 1).toString("base64"),
        UNSUBSCRIBE_SECRET: "a-real-unsubscribe-secret-value",
        AI_PROVIDER: "fake",
      }),
    ).toThrow(/fake/);
    expect(() => loadWorkerConfig({ ...base, AI_PROVIDER: "bedrock" })).toThrow(/region/i);
  });
});
