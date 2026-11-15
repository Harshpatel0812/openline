import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
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
import { parseMessagesResponse } from "./anthropic";

/** The part of BedrockRuntimeClient we use (lets tests pass a mock). */
export interface BedrockSender {
  send(
    command: InvokeModelCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<{ body?: Uint8Array }>;
}

export interface BedrockProviderOptions {
  region: string;
  models: ModelIds;
  timeoutMs?: number;
  /** Injected in tests; otherwise a client using the default AWS credential chain. */
  client?: BedrockSender;
}

const RETRYABLE_NAMES = new Set([
  "ThrottlingException",
  "ServiceUnavailableException",
  "InternalServerException",
  "ModelTimeoutException",
  "ModelNotReadyException",
  "TimeoutError",
  "AbortError",
]);

/**
 * Anthropic models on AWS Bedrock (Messages API body). The production choice: data stays in our
 * AWS account's region and Bedrock does not retain or train on prompts. Credentials come from
 * the standard AWS chain (task role in ECS); nothing secret is configured here.
 */
export class BedrockProvider implements LlmProvider {
  readonly name = "bedrock" as const;
  private readonly client: BedrockSender;

  constructor(private readonly opts: BedrockProviderOptions) {
    // The SDK's own retries are off: we retry once ourselves so timeouts stay bounded.
    this.client = opts.client ?? new BedrockRuntimeClient({ region: opts.region, maxAttempts: 1 });
  }

  complete(request: LlmRequest): Promise<LlmResponse> {
    const modelId = this.opts.models[request.model];
    const body = JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: request.maxTokens,
      system: systemWithSchema(request),
      messages: request.messages,
    });
    return withOneRetry(async () => {
      let raw: { body?: Uint8Array };
      try {
        raw = await this.client.send(
          new InvokeModelCommand({
            modelId,
            contentType: "application/json",
            accept: "application/json",
            body,
          }),
          { abortSignal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) },
        );
      } catch (err) {
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        const status = e?.$metadata?.httpStatusCode;
        if ((status !== undefined && status >= 500) || status === 429) {
          throw new RetryableError(status);
        }
        if (e?.name && RETRYABLE_NAMES.has(e.name)) throw new RetryableError(status);
        if (status === undefined) throw new RetryableError(); // network
        throw new AiError("unavailable", "The AI provider refused the request", { status });
      }
      let json: Parameters<typeof parseMessagesResponse>[0];
      try {
        json = JSON.parse(new TextDecoder().decode(raw.body ?? new Uint8Array())) as typeof json;
      } catch {
        throw new RetryableError();
      }
      return parseMessagesResponse(json, modelId);
    }, "The AI provider");
  }
}
