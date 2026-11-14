# ADR 0004: Postgres as the sending queue (instead of BullMQ/Redis)

Date: 2026-11-14 Status: Accepted (supersedes the BullMQ choice in the build plan)

## Context

Sequence emails are scheduled work with long, variable delays (days), per-contact business hours,
per-mailbox caps and spacing. The plan proposed BullMQ on Redis. But the schedule already lives in
Postgres (`enrollments.next_run_at`), every decision needs Postgres data anyway, and Redis adds a
second stateful system to run, secure and back up — and a second source of truth to keep in sync.

## Decision

`packages/sequencer` polls Postgres:

- `claim_due_enrollments(batch)` — a `SECURITY DEFINER` function, the only cross-tenant query —
  leases due rows for 5 minutes with `FOR UPDATE SKIP LOCKED`, returning ids only.
- Each enrollment is then decided, sent and recorded inside `withTenant()` for its workspace, so
  row-level security still applies to everything else.
- Deferrals rewrite `next_run_at` (business hours, caps, spacing, paused sequence); the reason goes
  to `last_decision` so the UI can explain it.
- Any number of workers can run. The lease spreads work; **send reservations** guarantee one send
  per step: before the network call the engine inserts the outbound `messages` row with status
  `sending`, and a unique index on `(enrollment_id, step_position)` refuses a second reservation.
  Failure hands the reservation back; a reservation whose worker died mid-send becomes
  `unconfirmed` and the enrollment goes to `error` for a person to check — never re-sent on a guess.
- The function is owned by `openline_scheduler` (migration 0005): `NOLOGIN`, no `BYPASSRLS`, only
  `SELECT`/`UPDATE` on `enrollments` plus a policy for that role. (Owned by the migration role it
  saw no rows in production, because `FORCE ROW LEVEL SECURITY` applies to non-superuser owners.)
- A person's change wins over an in-flight send: the engine only moves an enrollment's state while
  it is still `active`, but always advances its step so a resumed enrollment never repeats one.
- With PGlite (local dev) only one process can open the database, so the API runs the engine
  in-process (`RUN_SCHEDULER=true`); in production `apps/worker` runs it.

## Consequences

- One stateful system (Postgres) instead of two; simpler local setup (no Docker needed).
- Throughput is bounded by polling (every 15 s, batches of 50 per worker) — ample for the MVP
  (thousands of sends/hour per worker). Revisit if we need sub-second scheduling.
- Redis is still planned for shared rate limiting when the API runs on multiple instances.
