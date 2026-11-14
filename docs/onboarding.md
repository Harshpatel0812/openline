# First day on Openline

1. Get access: GitHub (with 2FA), the ticket tracker, Slack, Figma. Sign the contractor agreement
   (IP assignment + confidentiality) first — no access before that.
2. Read `CLAUDE.md` (15 min), then the Product plan and Engineering build plan.
3. Run the quick start in `README.md`. All four checks must pass locally:
   `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`.
4. Read `docs/adr/` to understand why things are the way they are.
5. Pick a ticket labelled `good-first-ticket`, follow "How to work a ticket" in `CLAUDE.md`.

## Where things go

| You are adding...                            | Put it in                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| An API endpoint                              | `apps/api/src/modules/<feature>/` (controller, service, repository, dto, tests) |
| A background job                             | `apps/worker/src/jobs/<job>.ts` + test                                          |
| A shared type or validation                  | `packages/shared`                                                               |
| A legal/compliance rule                      | `packages/compliance` + test + note in the PRD                                  |
| A Scout prompt or guardrail                  | `packages/ai` + eval cases                                                      |
| A database change                            | New `packages/db/migrations/NNNN_*.sql` (+ RLS policy) and matching `schema.ts` |
| A decision that affects more than one module | `docs/adr/NNNN-title.md`                                                        |
| An operational procedure                     | `docs/runbooks/`                                                                |
