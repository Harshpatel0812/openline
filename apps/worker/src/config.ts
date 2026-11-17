import type { ProviderConfig } from "@openline/ai";
import { resolveCrmConfig, type CrmConfig } from "@openline/crm";
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
  /** Sprint 4: how often each mailbox is checked for replies. */
  REPLY_SYNC_INTERVAL_MS: z.coerce.number().int().min(10_000).default(120_000),
  /** Model reply classifications per mailbox per UTC day; beyond it the keyword rules decide. */
  REPLY_CLASSIFY_DAILY_CAP: z.coerce.number().int().min(0).max(100_000).default(200),
  // Scout's model for reply classification (same variables and rules as the API, ADR 0005).
  AI_PROVIDER: z.enum(["bedrock", "anthropic", "fake", "off"]).default("off"),
  AI_MODEL_SMALL: z.string().trim().max(200).optional(),
  AI_MODEL_LARGE: z.string().trim().max(200).optional(),
  AI_AWS_REGION: z.string().trim().max(40).optional(),
  AWS_REGION: z.string().trim().max(40).optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
  // OL-E8 CRM sync (CRM_MODE, CRM_* client ids/secrets, intervals: see packages/crm config.ts).
  /** Sender of the one "reconnect your CRM" email to admins. */
  MAIL_FROM: z.string().default("Openline <no-reply@openline.local>"),
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
  replySyncIntervalMs: number;
  replyClassifyDailyCap: number;
  /** Scout's model access for reply classification ("off" = keyword fallback only). */
  ai: ProviderConfig;
  /** CRM sync mode and endpoints (fake / sandbox / live). */
  crm: CrmConfig;
  smtpUrl?: string;
  mailFrom: string;
}

/** Same provider rules as the API's resolveAiConfig. */
function resolveAi(e: z.infer<typeof EnvSchema>, appEnv: AppEnv): ProviderConfig {
  const devOrTest = appEnv === "development" || appEnv === "test";
  const provider = e.AI_PROVIDER;
  if (provider === "fake" && !devOrTest) {
    throw new Error("AI_PROVIDER=fake is only allowed in development and test");
  }
  if (provider === "anthropic" && appEnv === "production") {
    throw new Error("AI_PROVIDER=anthropic is for development; production uses bedrock");
  }
  if (provider === "anthropic" && !e.ANTHROPIC_API_KEY) {
    throw new Error("AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY");
  }
  const region = e.AI_AWS_REGION || e.AWS_REGION || undefined;
  if (provider === "bedrock" && !region) {
    throw new Error("AI_PROVIDER=bedrock requires AI_AWS_REGION or AWS_REGION");
  }
  if (
    (provider === "bedrock" || provider === "anthropic") &&
    (!e.AI_MODEL_SMALL || !e.AI_MODEL_LARGE)
  ) {
    throw new Error(`AI_PROVIDER=${provider} requires AI_MODEL_SMALL and AI_MODEL_LARGE`);
  }
  return {
    provider,
    models: { small: e.AI_MODEL_SMALL || "fake-small", large: e.AI_MODEL_LARGE || "fake-large" },
    region,
    anthropicApiKey: provider === "anthropic" ? e.ANTHROPIC_API_KEY : undefined,
    timeoutMs: e.AI_TIMEOUT_MS,
  };
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
    replySyncIntervalMs: e.REPLY_SYNC_INTERVAL_MS,
    replyClassifyDailyCap: e.REPLY_CLASSIFY_DAILY_CAP,
    ai: resolveAi(e, appEnv),
    crm: resolveCrmConfig(appEnv, env),
    smtpUrl: e.SMTP_URL,
    mailFrom: e.MAIL_FROM,
  };
}
