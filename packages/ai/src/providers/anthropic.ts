import {
  AiError,
  DEFAULT_TIMEOUT_MS,
  RetryableError,
  systemWithSchema,
  withOneRetry,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type ModelIds,
} from "../provider";

export interface AnthropicProviderOptions {
  apiKey: string;
  models: ModelIds;
  timeoutMs?: number;
  baseUrl?: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

interface MessagesResponse {
  model?: string;
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Direct HTTPS to the Anthropic Messages API — for local development with a test key only
 * (production uses Bedrock; see ADR 0005). Nothing from the request or response is logged.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly opts: AnthropicProviderOptions) {
    if (!opts.apiKey) throw new Error("AnthropicProvider needs an API key");
    this.fetchImpl = opts.fetch ?? fetch;
    this.baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  }

  complete(request: LlmRequest): Promise<LlmResponse> {
    const model = this.opts.models[request.model];
    const body = JSON.stringify({
      model,
      max_tokens: request.maxTokens,
      system: systemWithSchema(request),
      messages: request.messages,
    });
    return withOneRetry(async () => {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.opts.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body,
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch {
        // Timeout or network error.
        throw new RetryableError();
      }
      if (res.status >= 500 || res.status === 429 || res.status === 529) {
        throw new RetryableError(res.status);
      }
      if (!res.ok) {
        throw new AiError("unavailable", "The AI provider refused the request", {
          status: res.status,
        });
      }
      let json: MessagesResponse;
      try {
        json = (await res.json()) as MessagesResponse;
      } catch {
        throw new RetryableError(res.status);
      }
      return parseMessagesResponse(json, model);
    }, "The AI provider");
  }
}

/** Shared by the Anthropic and Bedrock adapters (Bedrock returns the same body shape). */
export function parseMessagesResponse(json: MessagesResponse, fallbackModel: string): LlmResponse {
  const text = (json.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
  return {
    text,
    model: json.model ?? fallbackModel,
    usage: {
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
    },
  };
}
