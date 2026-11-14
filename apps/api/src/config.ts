import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
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
});

export type AppConfig = Omit<z.infer<typeof EnvSchema>, "AUTO_MIGRATE"> & {
  AUTO_MIGRATE: boolean;
  cookieSecure: boolean;
  cookieName: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  if (parsed.NODE_ENV === "production" && parsed.DATABASE_URL.startsWith("pglite://")) {
    throw new Error("Production requires a postgres:// DATABASE_URL");
  }
  const cookieSecure = parsed.NODE_ENV === "production";
  return {
    ...parsed,
    // Production applies migrations as a separate deploy step with the owner role; the API itself
    // connects as a role that owns nothing (see infra/terraform/README.md).
    AUTO_MIGRATE: parsed.AUTO_MIGRATE
      ? parsed.AUTO_MIGRATE === "true"
      : parsed.NODE_ENV !== "production",
    cookieSecure,
    // __Host- prefix: browser enforces Secure, Path=/, no Domain (blocks subdomain overrides).
    cookieName: cookieSecure ? "__Host-ol_session" : "ol_session",
  };
}

export const CONFIG = Symbol("CONFIG");
