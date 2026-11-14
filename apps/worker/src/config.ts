import { parseSecretsKey } from "@openline/email";
import {
  resolveAppEnv,
  resolveOutreach,
  type AppEnv,
  type OutreachTransport,
} from "@openline/sequencer";
import { z } from "zod";

/** Development-only defaults; the worker refuses to start in production with these. */
export const DEV_SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");
export const DEV_UNSUBSCRIBE_SECRET = "dev-only-unsubscribe-secret-change-me";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** production | staging | development | test. Required when NODE_ENV=production. */
  APP_ENV: z.string().optional(),
  DATABASE_URL: z.string().min(1),
  SECRETS_KEY: z.string().default(DEV_SECRETS_KEY),
  UNSUBSCRIBE_SECRET: z.string().min(16).default(DEV_UNSUBSCRIBE_SECRET),
  WEB_URL: z.string().url().default("http://localhost:3000"),
  OUTREACH_TRANSPORT: z.enum(["real", "sandbox", "capture"]).optional(),
  /** Catch-all inbox for sandboxed outreach in staging (development/test fall back to SMTP_URL). */
  OUTREACH_SANDBOX_SMTP_URL: z.string().url().optional(),
  SMTP_URL: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(15_000),
});

export interface WorkerConfig {
  databaseUrl: string;
  secretsKey: Buffer;
  unsubscribeSecret: string;
  webUrl: string;
  appEnv: AppEnv;
  outreach: OutreachTransport;
  allowPrivateSmtpHosts: boolean;
  google?: { clientId: string; clientSecret: string; redirectUri: string };
  pollIntervalMs: number;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const e = EnvSchema.parse(env);
  const appEnv = resolveAppEnv(e.NODE_ENV, e.APP_ENV);
  // Staging is held to production's secret rules too: it holds real mailbox credentials.
  const deployed = appEnv === "production" || appEnv === "staging";

  if (e.DATABASE_URL.startsWith("pglite://")) {
    throw new Error(
      "The worker needs a postgres:// DATABASE_URL. With PGlite, the API runs the engine in-process (RUN_SCHEDULER).",
    );
  }
  if (
    deployed &&
    (e.SECRETS_KEY === DEV_SECRETS_KEY || e.UNSUBSCRIBE_SECRET === DEV_UNSUBSCRIBE_SECRET)
  ) {
    throw new Error("Set SECRETS_KEY and UNSUBSCRIBE_SECRET in production and staging");
  }

  const { outreach, allowPrivateSmtpHosts } = resolveOutreach({
    appEnv,
    requested: e.OUTREACH_TRANSPORT,
    smtpUrl: e.SMTP_URL,
    sandboxSmtpUrl: e.OUTREACH_SANDBOX_SMTP_URL,
    allowRealSending: env.ALLOW_REAL_SENDING === "true",
  });

  const google =
    e.GOOGLE_OAUTH_CLIENT_ID && e.GOOGLE_OAUTH_CLIENT_SECRET
      ? {
          clientId: e.GOOGLE_OAUTH_CLIENT_ID,
          clientSecret: e.GOOGLE_OAUTH_CLIENT_SECRET,
          redirectUri: `${e.WEB_URL.replace(/\/$/, "")}/api/v1/mailboxes/google/callback`,
        }
      : undefined;

  return {
    databaseUrl: e.DATABASE_URL,
    secretsKey: parseSecretsKey(e.SECRETS_KEY),
    unsubscribeSecret: e.UNSUBSCRIBE_SECRET,
    webUrl: e.WEB_URL,
    appEnv,
    outreach,
    allowPrivateSmtpHosts,
    google,
    pollIntervalMs: e.POLL_INTERVAL_MS,
  };
}
