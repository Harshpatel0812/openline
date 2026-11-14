import type { OutreachTransport } from "./types";

/**
 * Where the code is running. NODE_ENV can't tell staging from production (one image, built with
 * NODE_ENV=production, is promoted from staging to prod), so deployments declare APP_ENV.
 */
export type AppEnv = "production" | "staging" | "development" | "test";
export type OutreachMode = OutreachTransport["mode"];

const APP_ENVS: readonly AppEnv[] = ["production", "staging", "development", "test"];

export function resolveAppEnv(nodeEnv: string | undefined, appEnv: string | undefined): AppEnv {
  if (appEnv !== undefined && appEnv !== "") {
    if (!(APP_ENVS as readonly string[]).includes(appEnv)) {
      throw new Error(`APP_ENV must be one of ${APP_ENVS.join(", ")}`);
    }
    return appEnv as AppEnv;
  }
  if (nodeEnv === "production") {
    // A production build without APP_ENV might be staging: refuse rather than guess.
    throw new Error("Set APP_ENV (production or staging) when NODE_ENV=production");
  }
  return nodeEnv === "test" ? "test" : "development";
}

export interface OutreachEnv {
  appEnv: AppEnv;
  /** OUTREACH_TRANSPORT, if set. */
  requested?: OutreachMode;
  /**
   * OUTREACH_SANDBOX_SMTP_URL: the catch-all inbox (e.g. Mailpit) for sandboxed outreach.
   * Must never be a relay that delivers to the real recipient.
   */
  sandboxSmtpUrl?: string;
  /** SMTP_URL (Openline's own mail). Reused as the sandbox only in development and test. */
  smtpUrl?: string;
  /** ALLOW_REAL_SENDING === "true". */
  allowRealSending: boolean;
}

export interface OutreachSettings {
  outreach: OutreachTransport;
  /** SMTP mailboxes on private/loopback addresses are only allowed in development and test. */
  allowPrivateSmtpHosts: boolean;
}

/**
 * The single rule for "may this process email real prospects?", shared by the API and the worker:
 * only APP_ENV=production sends for real by default; anywhere else it takes OUTREACH_TRANSPORT=real
 * plus ALLOW_REAL_SENDING=true. Staging uses OUTREACH_SANDBOX_SMTP_URL when set, else capture.
 */
export function resolveOutreach(env: OutreachEnv): OutreachSettings {
  const { appEnv } = env;
  const local = appEnv === "development" || appEnv === "test";
  // In staging/production SMTP_URL is a real provider that would deliver to the prospect, so
  // the sandbox inbox has to be named explicitly there.
  const sandboxUrl = env.sandboxSmtpUrl ?? (local ? env.smtpUrl : undefined);
  const mode: OutreachMode =
    env.requested ??
    (appEnv === "production" ? "real" : appEnv === "staging" && sandboxUrl ? "sandbox" : "capture");

  if (mode === "real" && appEnv !== "production" && !env.allowRealSending) {
    throw new Error(
      `OUTREACH_TRANSPORT=real in ${appEnv} needs ALLOW_REAL_SENDING=true (only production sends to real prospects by default)`,
    );
  }

  let outreach: OutreachTransport;
  if (mode === "sandbox") {
    if (!sandboxUrl) {
      throw new Error(
        local
          ? "OUTREACH_TRANSPORT=sandbox needs SMTP_URL (e.g. Mailpit)"
          : "OUTREACH_TRANSPORT=sandbox needs OUTREACH_SANDBOX_SMTP_URL (a catch-all inbox like Mailpit)",
      );
    }
    const u = new URL(sandboxUrl);
    outreach = {
      mode: "sandbox",
      smtp: {
        host: u.hostname,
        port: Number(u.port || 587),
        secure: u.protocol === "smtps:",
        username: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : undefined,
        requireTls: u.searchParams.get("requireTLS") !== "false",
      },
    };
  } else {
    outreach = { mode };
  }
  return { outreach, allowPrivateSmtpHosts: local };
}
