import type { GoogleOAuthConfig } from "@openline/email";
import {
  resolveAppEnv,
  resolveOutreach,
  type AppEnv,
  type OutreachTransport,
} from "@openline/sequencer";
import { z } from "zod";

/**
 * Fixed development secrets. They only make local dev and tests work without setup; production
 * refuses to start with them (see loadConfig). Not secret by design — never use them anywhere real.
 */
// Same values as apps/worker/src/config.ts, so the API and the worker read each other's sealed
// secrets and unsubscribe links in development.
export const DEV_SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");
export const DEV_UNSUBSCRIBE_SECRET = "dev-only-unsubscribe-secret-change-me";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** production | staging | development | test. Required when NODE_ENV=production. */
  APP_ENV: z.string().optional(),
  API_PORT: z.coerce.number().int().positive().default(4000),
  /** postgres://... in staging/prod; pglite://./.data/dev locally; pglite://memory in tests. */
  DATABASE_URL: z.string().default("pglite://./.data/dev"),
  /** Apply pending migrations at boot. Off in production (migrations run as a deploy step). */
  AUTO_MIGRATE: z.enum(["true", "false"]).optional(),
  /**
   * Express "trust proxy": which hops may set X-Forwarded-For. Default trusts only private
   * networks (the web proxy / load balancer inside the VPC), so a client can't spoof its IP.
   * The API must not be reachable directly from the internet.
   */
  TRUST_PROXY: z.string().default("loopback, linklocal, uniquelocal"),
  WEB_URL: z.string().url().default("http://localhost:3000"),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(14),
  INVITE_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  /** New accounts per IP per hour (raised in tests). */
  SIGNUPS_PER_IP_PER_HOUR: z.coerce.number().int().positive().default(10),

  // ---------------------------------------------------------------- Sprint 3: sending
  /** 32-byte base64 key that seals mailbox credentials. */
  SECRETS_KEY: z.string().optional(),
  /** HMAC secret for unsubscribe links (also used, derived, to sign OAuth state). */
  UNSUBSCRIBE_SECRET: z.string().optional(),
  MAIL_FROM: z.string().default("Openline <no-reply@openline.local>"),
  /** SMTP server for Openline's own emails, e.g. smtp://localhost:1025?requireTLS=false */
  SMTP_URL: z.string().url().optional(),
  MAIL_TRANSPORT: z.enum(["smtp", "log", "capture"]).optional(),
  OUTREACH_TRANSPORT: z.enum(["real", "sandbox", "capture"]).optional(),
  /** Catch-all inbox for sandboxed outreach in staging (development/test fall back to SMTP_URL). */
  OUTREACH_SANDBOX_SMTP_URL: z.string().url().optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  RUN_SCHEDULER: z.enum(["true", "false"]).optional(),
  /** Guardrail: OUTREACH_TRANSPORT=real outside production must be explicitly allowed. */
  ALLOW_REAL_SENDING: z.enum(["true", "false"]).optional(),
  /** Sprint 4: how often each mailbox is checked for replies (runs with RUN_SCHEDULER). */
  REPLY_SYNC_INTERVAL_MS: z.coerce.number().int().min(10_000).default(120_000),
  /** Model reply classifications per mailbox per UTC day; beyond it the keyword rules decide. */
  REPLY_CLASSIFY_DAILY_CAP: z.coerce.number().int().min(0).max(100_000).default(200),

  // ---------------------------------------------------------------- Sprint 4: Scout (ADR 0005)
  /** bedrock (production) | anthropic (local dev, test key) | fake (dev/test only) | off. */
  AI_PROVIDER: z.enum(["bedrock", "anthropic", "fake", "off"]).default("off"),
  AI_MODEL_SMALL: z.string().trim().max(200).optional(),
  AI_MODEL_LARGE: z.string().trim().max(200).optional(),
  /** Bedrock region (falls back to AWS_REGION). */
  AI_AWS_REGION: z.string().trim().max(40).optional(),
  AWS_REGION: z.string().trim().max(40).optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
  SCOUT_DRAFTS_PER_USER_PER_HOUR: z.coerce.number().int().positive().default(30),
});

type Env = z.infer<typeof EnvSchema>;

export type AppConfig = Omit<
  Env,
  | "AUTO_MIGRATE"
  | "RUN_SCHEDULER"
  | "SECRETS_KEY"
  | "UNSUBSCRIBE_SECRET"
  | "MAIL_TRANSPORT"
  | "OUTREACH_TRANSPORT"
> & {
  AUTO_MIGRATE: boolean;
  RUN_SCHEDULER: boolean;
  SECRETS_KEY: string;
  UNSUBSCRIBE_SECRET: string;
  MAIL_TRANSPORT: "smtp" | "log" | "capture";
  OUTREACH_TRANSPORT: "real" | "sandbox" | "capture";
  cookieSecure: boolean;
  cookieName: string;
  /** Parsed SECRETS_KEY (32 bytes). */
  secretsKey: Buffer;
  /** Gmail OAuth settings, or undefined when not configured (Gmail endpoints return 501). */
  google?: GoogleOAuthConfig;
  /** Deployment (NODE_ENV can't tell staging from production). */
  appEnv: AppEnv;
  /** The sequencer's outreach option (same rule as apps/worker, see resolveOutreach). */
  outreach: OutreachTransport;
  /** SMTP mailboxes on private/loopback hosts: development and test only. */
  allowPrivateSmtpHosts: boolean;
  /** Scout model access (see resolveAiConfig). */
  ai: ScoutAiConfig;
};

export interface ScoutAiConfig {
  provider: "bedrock" | "anthropic" | "fake" | "off";
  models: { small: string; large: string };
  region?: string;
  anthropicApiKey?: string;
  timeoutMs: number;
  draftsPerUserPerHour: number;
  /** Website research may reach private/loopback hosts: development and test only. */
  allowPrivateResearchHosts: boolean;
}

/**
 * Scout's provider rules: `fake` only in development/test; `anthropic` (direct API, no
 * zero-retention agreement) never in production; real providers need explicit model ids.
 */
export function resolveAiConfig(parsed: Env, appEnv: AppEnv): ScoutAiConfig {
  const devOrTest = appEnv === "development" || appEnv === "test";
  const provider = parsed.AI_PROVIDER;
  if (provider === "fake" && !devOrTest) {
    throw new Error("AI_PROVIDER=fake is only allowed in development and test");
  }
  if (provider === "anthropic" && appEnv === "production") {
    throw new Error("AI_PROVIDER=anthropic is for development; production uses bedrock");
  }
  if (provider === "anthropic" && !parsed.ANTHROPIC_API_KEY) {
    throw new Error("AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY");
  }
  const region = parsed.AI_AWS_REGION || parsed.AWS_REGION || undefined;
  if (provider === "bedrock" && !region) {
    throw new Error("AI_PROVIDER=bedrock requires AI_AWS_REGION or AWS_REGION");
  }
  const real = provider === "bedrock" || provider === "anthropic";
  if (real && (!parsed.AI_MODEL_SMALL || !parsed.AI_MODEL_LARGE)) {
    throw new Error(`AI_PROVIDER=${provider} requires AI_MODEL_SMALL and AI_MODEL_LARGE`);
  }
  return {
    provider,
    models: {
      small: parsed.AI_MODEL_SMALL || "fake-small",
      large: parsed.AI_MODEL_LARGE || "fake-large",
    },
    region,
    anthropicApiKey: provider === "anthropic" ? parsed.ANTHROPIC_API_KEY : undefined,
    timeoutMs: parsed.AI_TIMEOUT_MS,
    draftsPerUserPerHour: parsed.SCOUT_DRAFTS_PER_USER_PER_HOUR,
    allowPrivateResearchHosts: devOrTest,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  const production = parsed.NODE_ENV === "production";
  if (production && parsed.DATABASE_URL.startsWith("pglite://")) {
    throw new Error("Production requires a postgres:// DATABASE_URL");
  }

  const SECRETS_KEY = parsed.SECRETS_KEY || DEV_SECRETS_KEY;
  const UNSUBSCRIBE_SECRET = parsed.UNSUBSCRIBE_SECRET || DEV_UNSUBSCRIBE_SECRET;
  if (production && SECRETS_KEY === DEV_SECRETS_KEY) {
    throw new Error("Production requires SECRETS_KEY (the development key is refused)");
  }
  if (production && UNSUBSCRIBE_SECRET === DEV_UNSUBSCRIBE_SECRET) {
    throw new Error("Production requires UNSUBSCRIBE_SECRET (the development secret is refused)");
  }
  if (UNSUBSCRIBE_SECRET.length < 16) {
    throw new Error("UNSUBSCRIBE_SECRET must be at least 16 characters");
  }
  const secretsKey = Buffer.from(SECRETS_KEY, "base64");
  if (secretsKey.length !== 32) throw new Error("SECRETS_KEY must be 32 bytes, base64-encoded");

  const MAIL_TRANSPORT =
    parsed.MAIL_TRANSPORT ?? (production ? "smtp" : parsed.NODE_ENV === "test" ? "capture" : "log");
  if (production && MAIL_TRANSPORT !== "smtp") {
    throw new Error("Production requires MAIL_TRANSPORT=smtp");
  }
  if (MAIL_TRANSPORT === "smtp" && !parsed.SMTP_URL) {
    throw new Error("MAIL_TRANSPORT=smtp requires SMTP_URL");
  }
  const appEnv = resolveAppEnv(parsed.NODE_ENV, parsed.APP_ENV);
  // Only APP_ENV=production emails real prospects by default (staging is a production build).
  const { outreach, allowPrivateSmtpHosts } = resolveOutreach({
    appEnv,
    requested: parsed.OUTREACH_TRANSPORT,
    smtpUrl: parsed.SMTP_URL,
    sandboxSmtpUrl: parsed.OUTREACH_SANDBOX_SMTP_URL,
    allowRealSending: parsed.ALLOW_REAL_SENDING === "true",
  });
  const OUTREACH_TRANSPORT = outreach.mode;

  const google =
    parsed.GOOGLE_OAUTH_CLIENT_ID && parsed.GOOGLE_OAUTH_CLIENT_SECRET
      ? {
          clientId: parsed.GOOGLE_OAUTH_CLIENT_ID,
          clientSecret: parsed.GOOGLE_OAUTH_CLIENT_SECRET,
          redirectUri: `${parsed.WEB_URL.replace(/\/$/, "")}/api/v1/mailboxes/google/callback`,
        }
      : undefined;

  const ai = resolveAiConfig(parsed, appEnv);

  const cookieSecure = production;
  return {
    ...parsed,
    ai,
    // Production applies migrations as a separate deploy step with the owner role; the API itself
    // connects as a role that owns nothing (see infra/terraform/README.md).
    AUTO_MIGRATE: parsed.AUTO_MIGRATE ? parsed.AUTO_MIGRATE === "true" : !production,
    // On-disk PGlite can only be opened by one process, so the API runs the engine itself.
    // Unit tests drive the engine directly, so it stays off there unless asked for (e2e asks).
    RUN_SCHEDULER: parsed.RUN_SCHEDULER
      ? parsed.RUN_SCHEDULER === "true"
      : parsed.DATABASE_URL.startsWith("pglite://") && parsed.NODE_ENV !== "test",
    SECRETS_KEY,
    UNSUBSCRIBE_SECRET,
    MAIL_TRANSPORT,
    OUTREACH_TRANSPORT,
    secretsKey,
    google,
    appEnv,
    outreach,
    allowPrivateSmtpHosts,
    cookieSecure,
    // __Host- prefix: browser enforces Secure, Path=/, no Domain (blocks subdomain overrides).
    cookieName: cookieSecure ? "__Host-ol_session" : "ol_session",
  };
}

export const CONFIG = Symbol("CONFIG");
