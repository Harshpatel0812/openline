import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { AiError, createProvider, type LlmProvider } from "@openline/ai";
import { ApiException } from "../../common/http";
import { CONFIG, type AppConfig } from "../../config";

/** Holds the configured LLM provider (null when AI_PROVIDER=off). */
@Injectable()
export class ScoutModelService {
  readonly provider: LlmProvider | null;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.provider = createProvider(config.ai);
  }

  get configured(): boolean {
    return this.provider !== null;
  }

  /** The provider, or 503 ai_unavailable when none is configured. */
  require(): LlmProvider {
    if (!this.provider) throw aiUnavailable();
    return this.provider;
  }
}

export const aiUnavailable = () =>
  new ApiException(
    HttpStatus.SERVICE_UNAVAILABLE,
    "ai_unavailable",
    "Scout isn't available right now. Everything else keeps working.",
  );

export const budgetExceeded = (resetsAt: Date) =>
  new ApiException(
    HttpStatus.TOO_MANY_REQUESTS,
    "ai_budget_exceeded",
    `This workspace has used its Scout credits for the month. They reset on ${resetsAt.toISOString().slice(0, 10)}.`,
    { resetsAt: resetsAt.toISOString() },
  );

/** AiError → the API's stable error codes. Anything else is rethrown untouched. */
export function toApiError(err: unknown): unknown {
  if (!(err instanceof AiError)) return err;
  switch (err.code) {
    case "unavailable":
      return aiUnavailable();
    case "budget":
      return budgetExceeded(err.details.resetsAt ?? new Date());
    case "invalid_output":
      return new ApiException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        "ai_invalid_output",
        "Scout couldn't write a draft it can back up with sources. Try again or adjust the note.",
      );
  }
}
