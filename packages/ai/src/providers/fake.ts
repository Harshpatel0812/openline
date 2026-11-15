import { rulePromiseCandidates } from "../promises";
import type { LlmProvider, LlmRequest, LlmResponse } from "../provider";

/** A scripted answer: text, an error to throw, or a function of the request. */
export type FakeStep = string | Error | ((request: LlmRequest) => string);

/**
 * Deterministic provider for tests and offline development. Scripted answers are used first, in
 * order; after that a built-in responder answers classification and drafting requests with
 * fixed, valid output. Every request is kept in `calls` so tests can inspect the prompt.
 */
export class FakeProvider implements LlmProvider {
  readonly name = "fake" as const;
  readonly calls: LlmRequest[] = [];
  private readonly script: FakeStep[] = [];

  constructor(script: FakeStep[] = []) {
    this.script.push(...script);
  }

  /** Queue more scripted answers. */
  push(...steps: FakeStep[]): this {
    this.script.push(...steps);
    return this;
  }

  /** Drops queued answers and recorded calls. */
  reset(): void {
    this.script.length = 0;
    this.calls.length = 0;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.calls.push(request);
    const step = this.script.shift();
    let text: string;
    if (step instanceof Error) throw step;
    else if (typeof step === "function") text = step(request);
    else if (typeof step === "string") text = step;
    else text = defaultAnswer(request);
    const promptChars =
      request.system.length + request.messages.reduce((n, m) => n + m.content.length, 0);
    return {
      text,
      model: `fake-${request.model}`,
      usage: { inputTokens: Math.ceil(promptChars / 4), outputTokens: Math.ceil(text.length / 4) },
    };
  }
}

function lastUserText(request: LlmRequest): string {
  return [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
}

function defaultAnswer(request: LlmRequest): string {
  const props = (request.jsonSchema?.properties ?? {}) as Record<string, unknown>;
  const prompt = lastUserText(request);
  if ("promises" in props) {
    // Promise extraction: the rule-based extractor over the fenced email text.
    const fenced = /<(UNTRUSTED-[0-9a-f]+) source="([^"]*)">\n([\s\S]*)\n<\/\1>/.exec(prompt);
    const promises = rulePromiseCandidates({
      text: fenced?.[3] ?? "",
      direction: fenced?.[2] === "email:outbound" ? "outbound" : "inbound",
    });
    return JSON.stringify({ promises });
  }
  if ("label" in props) {
    const t = prompt.toLowerCase();
    const label = /unsubscribe|remove me|stop emailing/.test(t)
      ? "unsubscribe"
      : /not interested/.test(t)
        ? "not_interested"
        : /out of (the )?office|on vacation/.test(t)
          ? "out_of_office"
          : "other";
    return JSON.stringify({ label, confidence: 0.5, summary: "Classified by the fake provider." });
  }
  // Drafting: cite the first allowed source, if any.
  const sources = /Allowed citation sources[^\n]*\n((?:- .+\n?)+)/.exec(prompt)?.[1] ?? "";
  const first = /^- (\S+)/m.exec(sources)?.[1];
  const claim = "This is a fake draft for testing.";
  // First touches use template variables; replies are sent as written, so they must not.
  const firstTouch = "subject" in props;
  return JSON.stringify({
    ...(firstTouch ? { subject: "Quick question, {{firstName|there}}" } : {}),
    body: firstTouch
      ? `Hi {{firstName|there}},\n\n${claim}\n\nBest,\n{{senderName}}`
      : `Hi,\n\n${claim}\n\nBest regards`,
    citations: first ? [{ claim, source: first }] : [],
  });
}
