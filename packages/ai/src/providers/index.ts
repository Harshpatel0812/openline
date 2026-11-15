import type { LlmProvider, ModelIds } from "../provider";
import { AnthropicProvider } from "./anthropic";
import { BedrockProvider } from "./bedrock";
import { FakeProvider } from "./fake";

export * from "./anthropic";
export * from "./bedrock";
export * from "./fake";

export type ProviderKind = "bedrock" | "anthropic" | "fake" | "off";

export interface ProviderConfig {
  provider: ProviderKind;
  models: ModelIds;
  region?: string;
  anthropicApiKey?: string;
  timeoutMs?: number;
}

/** Builds the configured provider, or null when Scout's model access is off. */
export function createProvider(config: ProviderConfig): LlmProvider | null {
  switch (config.provider) {
    case "off":
      return null;
    case "fake":
      return new FakeProvider();
    case "anthropic":
      return new AnthropicProvider({
        apiKey: config.anthropicApiKey ?? "",
        models: config.models,
        timeoutMs: config.timeoutMs,
      });
    case "bedrock":
      if (!config.region) throw new Error("Bedrock needs an AWS region");
      return new BedrockProvider({
        region: config.region,
        models: config.models,
        timeoutMs: config.timeoutMs,
      });
  }
}
