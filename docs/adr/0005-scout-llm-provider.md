# ADR 0005: Scout's model access — Bedrock in production, direct API for dev, fake for tests

Date: 2026-11-14 Status: Accepted

## Context

Scout v1 (OL-E4 §2, §4) classifies replies with a small model and drafts emails with a large
one. Its prompts carry prospects' personal data, inbound email text and company web pages. We
need: no retention or training on that data by the model vendor; data kept in the AWS region we
host in; a cheap way to develop locally; and fully deterministic tests and CI with no network.

## Decision

All model calls go through one interface in `packages/ai`:

```ts
interface LlmProvider {
  complete({ system, messages, maxTokens, model: "small" | "large", jsonSchema? }):
    Promise<{ text, usage: { inputTokens, outputTokens }, model }>;
}
```

Adapters, chosen with `AI_PROVIDER` (default `off`):

| Provider    | Where                      | Notes                                                                                                                                                                                                      |
| ----------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bedrock`   | staging, **production**    | Anthropic models on AWS Bedrock (`InvokeModel`, Messages body). Bedrock does not store or train on prompts/outputs, and traffic stays in our account's region. Credentials from the AWS chain (task role). |
| `anthropic` | local development          | Direct HTTPS to the Messages API with a developer's test key. **Refused when `APP_ENV=production`** (no zero-retention agreement in place).                                                                |
| `fake`      | tests, offline development | Deterministic scripted answers + a built-in responder. **Refused outside development/test.**                                                                                                               |
| `off`       | default                    | Scout endpoints return 503 `ai_unavailable`; deterministic features (keyword reply rules, compliance) keep working.                                                                                        |

Model ids are configuration (`AI_MODEL_SMALL`, `AI_MODEL_LARGE`), required for the real
providers, so a model upgrade is a config change and the eval set (`pnpm --filter @openline/ai
eval`) is re-run first. Bedrock's region is `AI_AWS_REGION` (falls back to `AWS_REGION`).

Common behaviour in every adapter: a timeout (`AI_TIMEOUT_MS`, default 30 s), exactly one retry on
5xx/429/timeout (SDK retries off), and typed `AiError`s (`unavailable`, `invalid_output`,
`budget`) whose messages never contain prompt or output text. Prompts and outputs are never
logged. Structured output is requested by adding the JSON Schema to the system prompt and is
always validated with zod by the caller, so no feature depends on a provider-specific
"structured output" mode.

## Consequences

- Production needs an AWS account with Bedrock model access in the chosen region (open decision:
  region/hosting) before any real Scout use; until then Scout runs on `fake` or a dev key.
- Tests and CI never touch the network; prompt-injection tests assert on the exact prompt the
  fake provider received (fencing + `UNTRUSTED_DATA_RULE`).
- Switching vendors or adding a self-hosted model is one new adapter.
- Budgets are counted from token usage reported by the provider (1 credit = 1,000 tokens), in an
  append-only `ai_usage` ledger.
