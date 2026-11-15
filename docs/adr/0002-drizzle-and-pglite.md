# ADR 0002: Drizzle ORM + SQL migrations, PGlite for dev and tests

Date: 2026-11-13 Status: Accepted (replaces the Prisma choice in ADR 0001)

## Context

Prisma needs a query-engine binary downloaded at install/generate time. That download is blocked
in sandboxed environments (including our cloud build workspace), which stopped schema validation and
any database work. We also want row-level security (RLS) policies, roles and grants under version
control, which Prisma's schema language cannot express.

## Options considered

1. **Prisma** — great DX, but binary engine downloads and RLS lives outside the schema anyway.
2. **Drizzle ORM + hand-written SQL migrations** — pure TypeScript, no binaries, SQL-first, typed
   queries. Migrations are plain `.sql` files, so RLS, roles and grants live next to the tables.
3. Kysely — similar to Drizzle; smaller ecosystem for our needs.

## Decision

Option 2. `packages/db/migrations/NNNN_name.sql` is the source of truth; `packages/db/src/schema.ts`
mirrors it for typed queries. A tiny migrator applies pending files in order, each in a transaction.

Databases by environment, chosen by `DATABASE_URL`:

| URL                    | Used for                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `pglite://memory`      | API integration tests, Playwright e2e (real Postgres compiled to WASM, in-process) |
| `pglite://./.data/dev` | Local development without Docker                                                   |
| `postgres://...`       | CI (real Postgres service), staging, production                                    |

All tenant access goes through `withTenant()`, which runs the transaction as role `openline_app`
with `app.workspace_id` set, so RLS applies even if application code forgets a filter.

## Consequences

- No binary downloads; works offline and in any CI.
- Every schema change needs a migration file **and** a matching `schema.ts` edit in the same PR.
- CI runs the isolation tests against both PGlite and real Postgres 16 to catch differences.
