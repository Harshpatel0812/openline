/**
 * Which CRM endpoints a deployment may talk to (PRD "Sandbox rule"):
 *  - fake     development / test default: every call goes to the local fake servers (loopback).
 *  - sandbox  staging: real APIs, but the OAuth callback refuses any account not listed in
 *             CRM_SANDBOX_ACCOUNT_IDS (HubSpot test accounts, a Pipedrive sandbox company).
 *  - live     production only; refused anywhere else, like real outreach.
 * Base URLs are fixed hosts; overrides are refused when APP_ENV=production.
 */
import type { CrmProvider } from "@openline/shared";
import { CRM_SYNC_DEFAULTS } from "@openline/shared";
import { CrmError } from "./errors";

export type CrmMode = "fake" | "sandbox" | "live";
type AppEnv = "production" | "staging" | "development" | "test";

export interface HubSpotEndpoints {
  /** https://api.hubapi.com */
  apiBase: string;
  /** https://app.hubspot.com (consent screen + record links) */
  appBase: string;
}

export interface PipedriveEndpoints {
  /** https://oauth.pipedrive.com */
  oauthBase: string;
  /** Allowed api_domain values. */
  apiDomainPattern: RegExp;
}

export interface CrmProviderConfig {
  clientId: string;
  clientSecret: string;
  /** PKCE is sent only when the provider supports it (CRM_<P>_PKCE=true); the fakes do. */
  pkce: boolean;
}

export interface CrmConfig {
  mode: CrmMode;
  hubspot?: CrmProviderConfig & HubSpotEndpoints;
  pipedrive?: CrmProviderConfig & PipedriveEndpoints;
  /** sandbox mode: the only account ids a callback may connect. */
  sandboxAccountIds: Set<string>;
  intervals: { hubspot: number; pipedrive: number; idle: number };
  /** Every origin a CRM request may go to (SSRF guard in http.ts). */
  allowedOrigins: Set<string>;
}

export const LIVE_HOSTS = {
  hubspotApi: "https://api.hubapi.com",
  hubspotApp: "https://app.hubspot.com",
  pipedriveOauth: "https://oauth.pipedrive.com",
  pipedriveApiDomain: /^https:\/\/[a-z0-9-]+\.pipedrive\.com$/,
} as const;

export const DEFAULT_FAKE_CRM_URL = "http://127.0.0.1:4900";

function loopback(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === "http:" &&
      (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function origin(url: string): string {
  return new URL(url).origin;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function resolveCrmConfig(
  appEnv: AppEnv,
  env: Record<string, string | undefined>,
): CrmConfig {
  const requested = env.CRM_MODE as CrmMode | undefined;
  if (requested !== undefined && !["fake", "sandbox", "live"].includes(requested)) {
    throw new Error("CRM_MODE must be fake, sandbox or live");
  }
  const mode: CrmMode =
    requested ?? (appEnv === "production" ? "live" : appEnv === "staging" ? "sandbox" : "fake");

  if (mode === "live" && appEnv !== "production") {
    throw new Error("CRM_MODE=live is only allowed when APP_ENV=production");
  }
  if (appEnv === "production" && mode !== "live") {
    throw new Error("APP_ENV=production requires CRM_MODE=live");
  }
  if (mode === "fake" && appEnv === "staging") {
    // Staging is a production build reachable from outside: no loopback fakes there.
    throw new Error("CRM_MODE=fake is for development and test; staging uses sandbox");
  }

  const overrides = ["CRM_HUBSPOT_API_BASE", "CRM_HUBSPOT_APP_BASE", "CRM_PIPEDRIVE_OAUTH_BASE"];
  if (appEnv === "production" && overrides.some((k) => env[k])) {
    throw new Error("CRM base URLs can't be overridden in production");
  }

  const sandboxAccountIds = new Set(
    (env.CRM_SANDBOX_ACCOUNT_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  // Sandbox without an allowlist fails closed: no provider is offered at all.
  const sandboxClosed = mode === "sandbox" && sandboxAccountIds.size === 0;

  const fakeBase = (env.CRM_FAKE_BASE_URL || DEFAULT_FAKE_CRM_URL).replace(/\/$/, "");
  if (mode === "fake" && !loopback(fakeBase)) {
    throw new Error("CRM_FAKE_BASE_URL must be a loopback http:// URL");
  }

  let hubspotApi: string = LIVE_HOSTS.hubspotApi;
  let hubspotApp: string = LIVE_HOSTS.hubspotApp;
  let pipedriveOauth: string = LIVE_HOSTS.pipedriveOauth;
  let pipedriveDomain: RegExp = LIVE_HOSTS.pipedriveApiDomain;
  if (mode === "fake") {
    hubspotApi = `${fakeBase}/hubspot`;
    hubspotApp = `${fakeBase}/hubspot-app`;
    pipedriveOauth = `${fakeBase}/pipedrive-oauth`;
    pipedriveDomain = new RegExp(`^${escapeRegex(fakeBase)}/pipedrive$`);
  }
  hubspotApi = env.CRM_HUBSPOT_API_BASE || hubspotApi;
  hubspotApp = env.CRM_HUBSPOT_APP_BASE || hubspotApp;
  pipedriveOauth = env.CRM_PIPEDRIVE_OAUTH_BASE || pipedriveOauth;
  // Outside fake mode every endpoint must be https (an override can't downgrade it).
  for (const url of [hubspotApi, hubspotApp, pipedriveOauth]) {
    if (mode === "fake" ? !loopback(url) : !url.startsWith("https://")) {
      throw new Error(
        mode === "fake"
          ? "In CRM_MODE=fake every CRM URL must be a loopback http:// URL"
          : "CRM URLs must be https://",
      );
    }
  }

  const creds = (p: "HUBSPOT" | "PIPEDRIVE") => {
    const id = env[`CRM_${p}_CLIENT_ID`];
    const secret = env[`CRM_${p}_CLIENT_SECRET`];
    if (id && secret) return { clientId: id, clientSecret: secret };
    // The fakes accept fixed, non-secret development credentials.
    if (mode === "fake")
      return { clientId: `fake-${p.toLowerCase()}-client`, clientSecret: "fake-secret" };
    return undefined;
  };
  const pkce = (p: "HUBSPOT" | "PIPEDRIVE") =>
    env[`CRM_${p}_PKCE`] ? env[`CRM_${p}_PKCE`] === "true" : mode === "fake";

  const hub = sandboxClosed ? undefined : creds("HUBSPOT");
  const pd = sandboxClosed ? undefined : creds("PIPEDRIVE");
  const interval = (key: string, fallback: number) => {
    const v = env[key];
    if (v === undefined || v === "") return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1_000) throw new Error(`${key} must be ≥ 1000 ms`);
    return n;
  };

  const allowedOrigins = new Set([origin(hubspotApi), origin(hubspotApp), origin(pipedriveOauth)]);
  if (mode === "fake") allowedOrigins.add(origin(fakeBase));

  return {
    mode,
    hubspot: hub
      ? { ...hub, pkce: pkce("HUBSPOT"), apiBase: hubspotApi, appBase: hubspotApp }
      : undefined,
    pipedrive: pd
      ? {
          ...pd,
          pkce: pkce("PIPEDRIVE"),
          oauthBase: pipedriveOauth,
          apiDomainPattern: pipedriveDomain,
        }
      : undefined,
    sandboxAccountIds,
    intervals: {
      hubspot: interval("CRM_HUBSPOT_INTERVAL_MS", CRM_SYNC_DEFAULTS.hubspotIntervalMs),
      pipedrive: interval("CRM_PIPEDRIVE_INTERVAL_MS", CRM_SYNC_DEFAULTS.pipedriveIntervalMs),
      idle: interval("CRM_IDLE_INTERVAL_MS", CRM_SYNC_DEFAULTS.idleIntervalMs),
    },
    allowedOrigins,
  };
}

export function availableProviders(config: CrmConfig): CrmProvider[] {
  return (["hubspot", "pipedrive"] as const).filter((p) => config[p] !== undefined);
}

/** A Pipedrive api_domain from the token response, accepted only if it matches the allowlist. */
export function checkPipedriveDomain(config: CrmConfig, domain: unknown): string {
  if (
    typeof domain !== "string" ||
    !config.pipedrive ||
    !config.pipedrive.apiDomainPattern.test(domain.replace(/\/$/, ""))
  ) {
    throw new CrmError("forbidden_host", "Pipedrive returned an API domain we don't accept");
  }
  return domain.replace(/\/$/, "");
}

/** In sandbox mode only allowlisted accounts may connect. */
export function accountAllowed(config: CrmConfig, accountId: string): boolean {
  return config.mode !== "sandbox" || config.sandboxAccountIds.has(accountId);
}
