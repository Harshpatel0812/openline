import type { CrmProvider } from "@openline/shared";
import type { CrmConfig } from "./config";
import type { HttpContext } from "./http";
import { HubSpotOAuth } from "./hubspot";
import { PipedriveOAuth } from "./pipedrive";
import type { CrmOAuth } from "./types";

/** The OAuth client for a configured provider (undefined when it isn't set up on this server). */
export function createOAuth(
  config: CrmConfig,
  provider: CrmProvider,
  http: Omit<HttpContext, "allow" | "meter"> = {},
): CrmOAuth | undefined {
  if (provider === "hubspot")
    return config.hubspot ? new HubSpotOAuth(config.hubspot, config, http) : undefined;
  return config.pipedrive ? new PipedriveOAuth(config.pipedrive, config, http) : undefined;
}
