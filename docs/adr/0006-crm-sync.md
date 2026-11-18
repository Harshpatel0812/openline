# ADR 0006: CRM sync — polling, per-field conflict rule, id mapping

Date: 2026-11-16 Status: Proposed (with PRD OL-E8)

## Context

Sprint 7 adds two-way sync of contacts, companies and deals with HubSpot and Pipedrive
(`docs/product/OL-E8-crm-sync.md`). We must choose how changes are detected, how conflicting
edits are resolved, and how records on the two sides are tied together. Constraints: one
stateful system (Postgres, ADR 0004); workers lease work through `SECURITY DEFINER` claim
functions owned by `openline_scheduler`; no public ingress exists yet other than the API; CI has
no network; both CRMs share their API budgets with the customer's other tools (HubSpot 110
requests / 10 s per account, Pipedrive a daily token budget per company).

## Options considered

**Change detection**

1. Webhooks (HubSpot app webhooks, Pipedrive webhooks v2) — near real time, cheap on API budget /
   need a public, signed ingress endpoint per provider, HubSpot subscriptions are per app (not per
   account), Pipedrive bans a failing endpoint and drops events during the ban, and neither covers
   the Openline → CRM direction. A safety-net poll is still needed.
2. Polling per connection with cursors (HubSpot search by last-modified; Pipedrive v2 lists with
   `updated_since`) — minutes of lag, costs budget when idle / same worker pattern as sending and
   reply sync, testable against a fake server, works the same in both directions.

**Conflict rule**

1. Record-level last writer wins — simple / one edit to an unrelated field overwrites the other
   side's change.
2. Fixed master per object (CRM always wins) — predictable / Openline edits (stages, owners)
   lost; defeats two-way sync.
3. Per-field last writer wins with a per-field source-of-truth override, using a stored shadow of
   the last agreed value — only real conflicts are decided; admins can pin a field / needs a
   shadow per link.

**Id mapping**

1. Store the external id on the Openline row (`contacts.hubspot_id`) — simple / one column per
   provider and object, no room for state, tombstones or reservations.
2. Write an Openline id into a CRM custom property — survives on their side / needs
   property-write scopes and creates fields in the customer's CRM.
3. A separate `crm_links` table — one row per linked record with state and shadow / one more join.

## Decision

- **Polling in v1**, via `claim_due_crm_syncs(batch)` (owned by `openline_scheduler`, column grants
  on `crm_connections` only, 10-minute lease, ids only), every 10 min (HubSpot) / 15 min
  (Pipedrive), backing off to 30 min when idle; per-object cursors with a 2-minute overlap; a daily
  reconcile of linked ids for deletes and merges. Webhooks are the next step, added as a trigger
  that brings `next_sync_at` forward, never as the only source of truth.
- **Per-field last writer wins** with `source_of_truth` (`newest` | `openline` | `crm`) per
  mapping. A field changed on one side only (compared with the shadow hash) simply flows; both
  changed → compare the CRM record's modified time with Openline's `updated_at`, ties to the CRM.
  The shadow also gives **echo suppression**: our own writes match the shadow and produce no
  further writes. Consent is outside the rule: opt-outs flow both ways, re-subscribes never.
- **`crm_links` table**, keyed `(connection, object, external_id)` and `(connection, local id)`,
  with one nullable composite FK per object type (`contact_id | company_id | deal_id`, CHECK
  exactly one) and states `linked | creating | unconfirmed | unlinked | tombstone`. First match by
  email (contacts) or normalized domain (companies). `creating` is a reservation written before a
  CRM create, as with send reservations (ADR 0004), so a crashed worker never creates twice.
  Erasure sets the FK to NULL and leaves a tombstone so the record is not re-imported.

## Consequences

- No new infrastructure or public endpoint; sync uses the same claim / lease / `withTenant()`
  pattern as the rest of the worker, and fake HubSpot / Pipedrive servers make it testable in CI.
- Freshness is minutes, not seconds (target p95 < 20 min); "Sync now" covers impatient moments.
- Idle polling spends API budget, which matters most for small Pipedrive accounts: we meter our own
  token spend and cap it per connection. Watch the 429 rate and token spend per connection.
- Timestamps from two clocks decide true conflicts; skew of a few seconds can pick the "wrong"
  winner on simultaneous edits. Accepted, logged per conflict, and admins can pin a field.
- Shadows store hashes, not values, so the log can say which field changed but not from what.
- Revisit when webhooks land, when a second pipeline is supported, or when a third CRM is added
  (the provider interface in `packages/crm` should not leak HubSpot or Pipedrive concepts).
