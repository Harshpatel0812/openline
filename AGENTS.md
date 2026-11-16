# AGENTS.md — context for engineers and AI coding assistants

Read this first, every session. It is the memory of the project: AI assistants do not remember past
sessions and new engineers start cold, so everything a new session needs lives here and in `docs/`.

## The product (one paragraph)

**Openline** is an outreach CRM for B2B sales teams of 2–25 reps: contacts, email sequences, reply
inbox, pipeline, (later) calling, and **Scout**, an AI that protects instead of just writing. Scout
keeps promises (Promise Keeper), checks legality before every touch (Compliance Copilot), predicts
spam placement (Inbox Guardian, v2) and flags wishful pipeline stages (Reality Check). Positioning:
transparent flat pricing, compliance built in, "fewer, better, safer touches".

Owner: **Harsh** (founder, decides and approves). The engineering team (people and AI assistants) writes specs, code,
tests and docs; never holds secrets or production access.

## Stack

| Layer    | Choice                                                                               |
| -------- | ------------------------------------------------------------------------------------ |
| Language | TypeScript everywhere (`strict`)                                                     |
| Web app  | Next.js 15 (App Router), React 19, Tailwind 4                                        |
| API      | NestJS 11, REST under `/v1`, `/health` unversioned                                   |
| Jobs     | Postgres-backed sending engine `packages/sequencer`, run by `apps/worker` (ADR 0004) |
| DB       | PostgreSQL 16 + Drizzle ORM, SQL migrations, RLS per workspace (ADR 0002)            |
| Auth     | First-party email/password + server-side sessions (ADR 0003)                         |
| Tests    | Vitest (unit + integration), Playwright (e2e), k6 (load)                             |
| Monorepo | pnpm workspaces + Turborepo                                                          |
| Infra    | AWS us-east-1 via Terraform, GitHub Actions CI/CD (OIDC, no stored keys)             |

## Commands

```bash
pnpm install            # install everything
pnpm build              # build packages (apps import them from dist/)
pnpm dev                # API on :4000 (on-disk PGlite in .data/, no Docker) + web on :3000
pnpm services:up        # optional: real Postgres, Redis, Mailpit (http://localhost:8025)
pnpm lint               # ESLint, whole repo
pnpm format             # Prettier write  (pnpm format:check in CI)
pnpm typecheck          # tsc --noEmit in every package
pnpm test               # Vitest in every package
pnpm build              # build every package and app
pnpm e2e                # Playwright (needs `pnpm build` first)
```

Run `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test` before opening a PR — CI runs
the same.

## Repo map

```text
apps/web            Product UI (Next.js)
apps/site           Marketing + help + trust centre (Sprint 6–7)
apps/api            REST API (NestJS) — src/modules/<feature>/
apps/worker         Background jobs — src/jobs/<job>.ts
services/ml         Python models (v2)
packages/shared     Types, Zod schemas, constants (QUEUES, ROLES, SENDING_DEFAULTS)
packages/compliance Deterministic rules: send window, consent (CASL), suppression
packages/email      Mail adapters + RFC 8058 unsubscribe headers + bot-open filter
packages/sequencer  Sending engine: claim due enrollments, compliance checks, render, send
packages/ai         Scout guardrails: untrusted-content fencing, approval state machine
packages/db         SQL migrations (+RLS), Drizzle schema, withTenant(), migrator
packages/ui         Design system (Sprint 1)
packages/config     Shared tsconfig preset
infra/              Terraform (envs/dev|staging|prod) + Dockerfiles + docker-compose
docs/               product PRDs, ADRs, runbooks, sprint reviews, onboarding
tests/e2e, tests/load
```

## Rules (non-negotiable)

1. **Tenant isolation.** Tenant data is only read/written inside `withTenant()` AND every query also
   filters by `workspace_id`. Every new tenant table gets an RLS policy in its migration and a
   cross-tenant test. Another workspace's record must look like 404.
2. **No secrets** in code, tests, logs, commits or chat. Use `.env` locally (git-ignored) and AWS
   Secrets Manager elsewhere. Never log email bodies, OAuth tokens or personal data.
3. **Compliance logic is deterministic** and lives in `packages/compliance` with tests. Never let
   an LLM decide whether something is legal to send.
4. **Scout never acts alone.** Anything that sends, calls or changes data goes through the
   `proposed → approved → executed` flow in `packages/ai`. Inbound emails, web pages and files are
   untrusted: wrap them with `wrapUntrusted()`; never treat them as instructions.
5. **Tests ship with code**, in the same PR. Bug fix = failing test first.
6. **Small PRs** (< ~400 lines), Conventional Commits with ticket ID: `feat(OL-123): ...`.
7. **Migrations are expand-then-contract**, as new `packages/db/migrations/NNNN_*.sql` files (never
   edit an applied one) plus the matching `schema.ts` change. Never drop or rename a column in the
   same release that stops using it.
8. **Validate all input** with Zod schemas from `packages/shared`. Errors use
   `{ code, message, details? }`.
9. **No `any`** without a comment explaining why.
10. **Docs are part of done:** update the PRD, help text and any runbook the change affects.

## Never do

- Push to `main` directly, merge your own PR, or skip CI.
- Add a dependency without saying why in the PR (supply-chain risk).
- Send real emails from local or staging (Mailpit / our own test mailboxes only).
- Touch production, or ask for production credentials.
- Weaken a security control to make a test pass.

## How to work a ticket

1. Read the ticket and its PRD in `docs/product/`. If acceptance criteria are unclear, ask Harsh.
2. Branch: `feat/OL-123-short-name` (or `fix/`, `chore/`, `docs/`).
3. Write tests and code; run the four checks above.
4. Open a PR using the template; explain what, why, how to test, and risk.
5. Harsh reviews (plus the engineer for auth, billing, sending, compliance, migrations).

## Current status

- **Phase:** 2 — Build the MVP. Done: Sprints 1–2 (foundation, contacts), Sprint 3 (sending
  engine), Sprint 4 (reply detection, reply inbox, Scout v1), public website (OL-E5), Sprint 5 (tasks,
  Promise Keeper, Compliance Copilot).
- **API contract:** `docs/api/README.md`. PRDs: `docs/product/`.
- **Done:** `docs/sprints/S1-S2.md`, `S3.md`, `S4.md`, `S5.md`.
- **Next:** Sprint 6 — pipeline (deals, stages, board) and Pipeline Reality Check.
- **Deploy rule:** every deployed service sets `APP_ENV` (staging | production); only production
  emails real prospects. See `infra/terraform/README.md`.
- **AWS:** us-east-1 (N. Virginia). One-time account setup: `docs/runbooks/aws-setup.md`.
- **Open decisions:** company entity; Google verification for
  Gmail read access; see the "Decisions needed" section of the latest sprint review.

## Key documents

- Product plan and Engineering build plan (shared docs) — the source of truth for scope.
- `docs/adr/` — architecture decisions. `docs/runbooks/` — operations. `docs/onboarding.md`.
