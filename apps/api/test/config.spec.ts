import { describe, expect, it } from "vitest";
import {
  DEV_CONTACT_INBOX,
  DEV_SECRETS_KEY,
  DEV_UNSUBSCRIBE_SECRET,
  loadConfig,
} from "../src/config";

const prod = {
  NODE_ENV: "production",
  APP_ENV: "production",
  DATABASE_URL: "postgres://app@db/openline",
  SECRETS_KEY: Buffer.alloc(32, 1).toString("base64"),
  UNSUBSCRIBE_SECRET: "a-real-production-secret-of-good-length",
  SMTP_URL: "smtp://mail.example.com:587",
  CONTACT_INBOX: "hello@openline.test",
};

describe("config (Sprint 3)", () => {
  it("dev defaults match the worker and Sprint 3 defaults", () => {
    const c = loadConfig({ NODE_ENV: "development" });
    expect(c.SECRETS_KEY).toBe(Buffer.alloc(32, 7).toString("base64"));
    expect(c.UNSUBSCRIBE_SECRET).toBe("dev-only-unsubscribe-secret-change-me");
    expect(c.secretsKey).toHaveLength(32);
    expect(c.MAIL_TRANSPORT).toBe("log");
    expect(c.outreach).toEqual({ mode: "capture" });
    expect(c.RUN_SCHEDULER).toBe(true);
    expect(c.google).toBeUndefined();
    expect(loadConfig({ NODE_ENV: "test" }).MAIL_TRANSPORT).toBe("capture");
    // Unit tests drive the engine themselves; e2e turns it on explicitly.
    expect(loadConfig({ NODE_ENV: "test" }).RUN_SCHEDULER).toBe(false);
    expect(loadConfig({ NODE_ENV: "test", RUN_SCHEDULER: "true" }).RUN_SCHEDULER).toBe(true);
    expect(c.allowPrivateSmtpHosts).toBe(true);
    expect(loadConfig({ DATABASE_URL: "postgres://x/y" }).RUN_SCHEDULER).toBe(false);
  });

  it("production refuses missing or development secrets", () => {
    expect(loadConfig(prod)).toMatchObject({ MAIL_TRANSPORT: "smtp", outreach: { mode: "real" } });
    expect(() => loadConfig({ ...prod, SECRETS_KEY: undefined })).toThrow(/SECRETS_KEY/);
    expect(() => loadConfig({ ...prod, SECRETS_KEY: DEV_SECRETS_KEY })).toThrow(/SECRETS_KEY/);
    expect(() => loadConfig({ ...prod, UNSUBSCRIBE_SECRET: undefined })).toThrow(/UNSUBSCRIBE/);
    expect(() => loadConfig({ ...prod, UNSUBSCRIBE_SECRET: DEV_UNSUBSCRIBE_SECRET })).toThrow(
      /UNSUBSCRIBE/,
    );
    expect(() => loadConfig({ ...prod, MAIL_TRANSPORT: "log" })).toThrow(/MAIL_TRANSPORT/);
    expect(() => loadConfig({ ...prod, SMTP_URL: undefined })).toThrow(/SMTP_URL/);
  });

  it("a production build must say whether it is staging or production", () => {
    expect(() => loadConfig({ ...prod, APP_ENV: undefined })).toThrow(/APP_ENV/);
    expect(() => loadConfig({ ...prod, APP_ENV: "prod" })).toThrow(/APP_ENV/);
    expect(loadConfig(prod).allowPrivateSmtpHosts).toBe(false);
  });

  it("staging (a production build) never emails real prospects by default", () => {
    const staging = { ...prod, APP_ENV: "staging" };
    // SMTP_URL is a real provider in staging: outreach must never be "sandboxed" through it.
    expect(loadConfig(staging).outreach.mode).toBe("capture");
    expect(() => loadConfig({ ...staging, OUTREACH_TRANSPORT: "sandbox" })).toThrow(
      /OUTREACH_SANDBOX_SMTP_URL/,
    );
    const withInbox = { ...staging, OUTREACH_SANDBOX_SMTP_URL: "smtp://mailpit:1025" };
    expect(loadConfig(withInbox).outreach).toMatchObject({
      mode: "sandbox",
      smtp: { host: "mailpit" },
    });
    expect(() => loadConfig({ ...staging, OUTREACH_TRANSPORT: "real" })).toThrow(
      /ALLOW_REAL_SENDING/,
    );
    expect(loadConfig(staging).allowPrivateSmtpHosts).toBe(false);
  });

  it("real sending outside production needs ALLOW_REAL_SENDING; sandbox needs SMTP_URL", () => {
    expect(() => loadConfig({ OUTREACH_TRANSPORT: "real" })).toThrow(/ALLOW_REAL_SENDING/);
    expect(loadConfig({ OUTREACH_TRANSPORT: "real", ALLOW_REAL_SENDING: "true" }).outreach).toEqual(
      { mode: "real" },
    );
    expect(() => loadConfig({ OUTREACH_TRANSPORT: "sandbox" })).toThrow(/SMTP_URL/);
    expect(
      loadConfig({
        OUTREACH_TRANSPORT: "sandbox",
        SMTP_URL: "smtp://localhost:1025?requireTLS=false",
      }).outreach,
    ).toEqual({
      mode: "sandbox",
      smtp: {
        host: "localhost",
        port: 1025,
        secure: false,
        username: undefined,
        password: undefined,
        requireTls: false,
      },
    });
  });

  it("Gmail is configured only with both client id and secret", () => {
    const c = loadConfig({ GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "s" });
    expect(c.google?.redirectUri).toBe("http://localhost:3000/api/v1/mailboxes/google/callback");
    expect(loadConfig({ GOOGLE_OAUTH_CLIENT_ID: "id" }).google).toBeUndefined();
  });

  it("CONTACT_INBOX defaults in dev/test and is required in staging and production", () => {
    expect(loadConfig({ NODE_ENV: "development" }).CONTACT_INBOX).toBe(DEV_CONTACT_INBOX);
    expect(loadConfig({ NODE_ENV: "test" }).CONTACT_INBOX).toBe("hello@openline.example");
    expect(loadConfig(prod).CONTACT_INBOX).toBe("hello@openline.test");
    expect(() => loadConfig({ ...prod, CONTACT_INBOX: undefined })).toThrow(/CONTACT_INBOX/);
    expect(() => loadConfig({ ...prod, APP_ENV: "staging", CONTACT_INBOX: undefined })).toThrow(
      /CONTACT_INBOX/,
    );
    expect(() => loadConfig({ CONTACT_INBOX: "not-an-email" })).toThrow();
  });
});
