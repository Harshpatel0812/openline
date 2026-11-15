/**
 * Model access for Scout. Every feature talks to an `LlmProvider`; adapters exist for AWS Bedrock
 * (production, zero data retention), the direct Anthropic API (local development) and a
 * deterministic fake (tests, offline dev). See docs/adr/0005-scout-llm-provider.md.
 *
 * Privacy rule: prompts and model outputs are NEVER logged or put in error messages. Errors carry
 * a stable code and, at most, an HTTP status.
 */

export type ModelTier = "small" | "large";

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
  model: ModelTier;
  /**
   * JSON Schema the answer must follow. Adapters add it to the system prompt (the answer is
   * validated with zod by the caller either way, so no adapter relies on it being enforced).
   */
  jsonSchema?: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  text: string;
  usage: LlmUsage;
  /** The concrete model id that answered. */
  model: string;
}

export interface LlmProvider {
  readonly name: "bedrock" | "anthropic" | "fake";
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export type AiErrorCode = "unavailable" | "invalid_output" | "budget";

/** Typed Scout failure. `usage` is what was spent before failing (it still counts to budgets). */
export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
    readonly details: { status?: number; usage?: LlmUsage; model?: string; resetsAt?: Date } = {},
  ) {
    super(message);
    this.name = "AiError";
  }
}

export const ZERO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * A provider call failed after earlier attempts already spent tokens: returns an AiError whose
 * `details.usage` includes them (plus any the failed call reported), so callers can still record
 * the spend. Non-AiError failures become AiError("unavailable").
 */
export function failedWithUsage(error: unknown, spent: LlmUsage, model: string): AiError {
  const base =
    error instanceof AiError
      ? error
      : new AiError("unavailable", "Scout isn't available right now.", {});
  return new AiError(base.code, base.message, {
    ...base.details,
    usage: addUsage(spent, base.details.usage ?? ZERO_USAGE),
    model: base.details.model || model,
  });
}

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

export interface ModelIds {
  small: string;
  large: string;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

/** Retryable = provider 5xx, throttling or timeout/network. 4xx (bad request, auth) are not. */
export class RetryableError extends Error {
  constructor(readonly status?: number) {
    super("retryable provider failure");
  }
}

/**
 * Runs `attempt` with one retry on a retryable failure. Anything still failing becomes
 * AiError("unavailable") with no provider text in it.
 */
export async function withOneRetry<T>(attempt: () => Promise<T>, label: string): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (err instanceof RetryableError && i === 0) continue;
      if (err instanceof AiError) throw err;
      const status = err instanceof RetryableError ? err.status : undefined;
      throw new AiError("unavailable", `${label} is unavailable`, { status });
    }
  }
}

/** The instruction that asks for JSON; appended to the system prompt when jsonSchema is set. */
export function systemWithSchema(request: LlmRequest): string {
  if (!request.jsonSchema) return request.system;
  return (
    `${request.system}\n\nRespond with a single JSON object and nothing else (no prose, no code ` +
    `fence). It must match this JSON Schema:\n${JSON.stringify(request.jsonSchema)}`
  );
}
