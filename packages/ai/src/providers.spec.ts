import type { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  AiError,
  AnthropicProvider,
  BedrockProvider,
  createProvider,
  FakeProvider,
  type BedrockSender,
  type LlmRequest,
} from "./index";

const MODELS = { small: "small-model-id", large: "large-model-id" };
const REQUEST: LlmRequest = {
  system: "You are a test.",
  messages: [{ role: "user", content: "secret prospect text" }],
  maxTokens: 100,
  model: "small",
  jsonSchema: { type: "object", properties: { label: { type: "string" } } },
};

const okBody = {
  model: "small-model-id",
  content: [{ type: "text", text: '{"label":"other"}' }],
  usage: { input_tokens: 12, output_tokens: 5 },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AnthropicProvider", () => {
  it("calls the Messages API with the right model, headers and schema instruction", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody));
    const p = new AnthropicProvider({ apiKey: "test-key", models: MODELS, fetch: fetchMock });
    const res = await p.complete(REQUEST);
    expect(res).toEqual({
      text: '{"label":"other"}',
      model: "small-model-id",
      usage: { inputTokens: 12, outputTokens: 5 },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("small-model-id");
    expect(body.max_tokens).toBe(100);
    expect(body.system).toContain("You are a test.");
    expect(body.system).toContain("JSON Schema");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses the large model id for large requests", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody));
    const p = new AnthropicProvider({ apiKey: "k", models: MODELS, fetch: fetchMock });
    await p.complete({ ...REQUEST, model: "large" });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string).model).toBe("large-model-id");
  });

  it("retries once on a 5xx and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(529, { error: "overloaded" }))
      .mockResolvedValueOnce(jsonResponse(200, okBody));
    const p = new AnthropicProvider({ apiKey: "k", models: MODELS, fetch: fetchMock });
    expect((await p.complete(REQUEST)).text).toBe('{"label":"other"}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries once on a timeout, then fails as unavailable without leaking text", async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const p = new AnthropicProvider({ apiKey: "k", models: MODELS, fetch: fetchMock });
    const err = await p.complete(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).code).toBe("unavailable");
    expect((err as AiError).message).not.toContain("secret prospect text");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 4xx (bad key, bad request)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, { error: "invalid x-api-key" }));
    const p = new AnthropicProvider({ apiKey: "k", models: MODELS, fetch: fetchMock });
    const err = (await p.complete(REQUEST).catch((e: unknown) => e)) as AiError;
    expect(err.code).toBe("unavailable");
    expect(err.details.status).toBe(401);
    expect(err.message).not.toContain("invalid x-api-key");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("times out a hanging request", async () => {
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const p = new AnthropicProvider({
      apiKey: "k",
      models: MODELS,
      fetch: fetchMock,
      timeoutMs: 20,
    });
    await expect(p.complete(REQUEST)).rejects.toMatchObject({ code: "unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("BedrockProvider", () => {
  const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

  it("invokes the Anthropic messages body on Bedrock with the configured model id", async () => {
    const send = vi.fn(async () => ({ body: encode(okBody) }));
    const p = new BedrockProvider({ region: "us-east-1", models: MODELS, client: { send } });
    const res = await p.complete({ ...REQUEST, model: "large" });
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    const [command, options] = send.mock.calls[0] as unknown as [
      InvokeModelCommand,
      { abortSignal: AbortSignal },
    ];
    expect(command.input.modelId).toBe("large-model-id");
    const body = JSON.parse(command.input.body as string);
    expect(body.anthropic_version).toBe("bedrock-2023-05-31");
    expect(body.messages).toEqual(REQUEST.messages);
    expect(body.system).toContain("JSON Schema");
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("retries once on throttling / 5xx", async () => {
    const throttled = Object.assign(new Error("Rate exceeded"), {
      name: "ThrottlingException",
      $metadata: { httpStatusCode: 429 },
    });
    const send = vi
      .fn<BedrockSender["send"]>()
      .mockRejectedValueOnce(throttled)
      .mockResolvedValueOnce({ body: encode(okBody) });
    const p = new BedrockProvider({ region: "us-east-1", models: MODELS, client: { send } });
    expect((await p.complete(REQUEST)).text).toBe('{"label":"other"}');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("fails as unavailable after two 5xx", async () => {
    const down = Object.assign(new Error("down"), {
      name: "ServiceUnavailableException",
      $metadata: { httpStatusCode: 503 },
    });
    const send = vi.fn<BedrockSender["send"]>().mockRejectedValue(down);
    const p = new BedrockProvider({ region: "us-east-1", models: MODELS, client: { send } });
    await expect(p.complete(REQUEST)).rejects.toMatchObject({ code: "unavailable" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not retry a validation error (4xx)", async () => {
    const bad = Object.assign(new Error("Malformed input request"), {
      name: "ValidationException",
      $metadata: { httpStatusCode: 400 },
    });
    const send = vi.fn<BedrockSender["send"]>().mockRejectedValue(bad);
    const p = new BedrockProvider({ region: "us-east-1", models: MODELS, client: { send } });
    await expect(p.complete(REQUEST)).rejects.toMatchObject({ code: "unavailable" });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("FakeProvider and createProvider", () => {
  it("answers scripted steps in order and records calls", async () => {
    const fake = new FakeProvider(["one", new Error("boom")]);
    expect((await fake.complete(REQUEST)).text).toBe("one");
    await expect(fake.complete(REQUEST)).rejects.toThrow("boom");
    expect(fake.calls).toHaveLength(2);
    // Then the built-in responder: valid classification JSON.
    expect(JSON.parse((await fake.complete(REQUEST)).text).label).toBe("other");
  });

  it("creates the configured provider", () => {
    expect(createProvider({ provider: "off", models: MODELS })).toBeNull();
    expect(createProvider({ provider: "fake", models: MODELS })?.name).toBe("fake");
    expect(
      createProvider({ provider: "anthropic", models: MODELS, anthropicApiKey: "k" })?.name,
    ).toBe("anthropic");
    expect(createProvider({ provider: "bedrock", models: MODELS, region: "us-east-1" })?.name).toBe(
      "bedrock",
    );
  });
});
