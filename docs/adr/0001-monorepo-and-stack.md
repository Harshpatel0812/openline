# ADR 0001: TypeScript monorepo and core stack

Date: 2026-11-13 Status: Accepted

## Context

A team of 1 founder + AI-assisted development + 1 part-time engineer must build and run a multi-part SaaS (web app,
API, background jobs, marketing site) and hand work between people and AI sessions without losing
context.

## Options considered

1. **One TypeScript monorepo (pnpm + Turborepo)** — one language, shared types, one CI, one place
   for context. Cons: build tooling to maintain.
2. Separate repos per service — clean boundaries, but duplicated config and types, and context
   split across repos. Too heavy for this team size.
3. Python backend + TypeScript frontend — strong for AI, but two languages and two toolchains.

## Decision

Option 1. Next.js (web), NestJS (API), a Postgres-backed job engine (ADR 0004; originally BullMQ), PostgreSQL + Drizzle (see ADR 0002; data, with row-level
security), Vitest/Playwright (tests), Terraform (infra), GitHub Actions (CI/CD). Python is allowed
only in `services/ml` for v2 models.

Internal packages compile to `dist/` (CommonJS) and apps depend on them through `workspace:*`;
Turborepo builds dependencies first (`^build`).

## Consequences

- Shared Zod schemas give the same validation in web, API and worker.
- Any developer or AI session can understand the whole system from one clone + `AGENTS.md`.
- We must keep CI fast (Turbo caching) as the repo grows; target under 10 minutes.
- Database changes follow expand-then-contract so deploys never break running code.
