# PRD: CRM sync (HubSpot and Pipedrive)

Epic: OL-E8 Sprint: S7 Owner: Harsh Status: Draft for approval (Nov 16, 2026)

## Problem

Most teams we sell to already pay for HubSpot or Pipedrive and will not type every contact and
deal twice. Today they import a CSV once (OL-E2) and the systems drift: a deal won in Openline is
still "Proposal" in the CRM report, and a person who unsubscribed in Openline is still mailable
from HubSpot. Drift costs trust in both tools and, for opt-outs, is a legal risk.

## Goals and metrics

- An admin connects HubSpot or Pipedrive, previews and imports a 10,000-contact account and has
  both systems in step in under 15 minutes.
- Freshness: p95 "changed on one side → visible on the other" < 20 minutes.
- Correctness: 0 duplicates created by sync; < 1 % of synced records with an open error after 24 h.
- Compliance: 0 cases of sync re-subscribing or un-suppressing a person (tested and alerted).
- Adoption: 40 % of active Team-plan workspaces connect a CRM within 30 days of launch.
- Instrumented: connections by provider/state, connect → first import time, run duration,
  freshness lag both ways, errors by code, 429s, Pipedrive tokens spent, opt-outs pushed/pulled.

## Scope

### 1. Connect

- **One CRM connection per workspace** (HubSpot _or_ Pipedrive; a second → 409
  `crm_already_connected`). Owner/admin connect, map, import, pause, resume and disconnect;
  managers see status and the sync log; reps see record badges.
- OAuth 2 authorization code, same shape as the Gmail connection (`mailboxes` module): `authorize`
  returns the consent URL with a signed `state` (HMAC, 10 min, workspace + user + provider, own
  derivation label `openline.crm-oauth-state.v1` so it can't be swapped with a Google state); the
  public callback verifies it, exchanges the code and redirects to Settings → Integrations with
  `?connected=` or `?error=state_invalid|state_expired|state_mismatch|…`.
- **Minimal scopes** (no `admin`, mail, webhooks or field-write scopes: Openline never creates
  properties, pipelines or stages in the customer's CRM):

| Provider  | Required                                                                                                                                         | Optional                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| HubSpot   | `oauth`, `crm.objects.{contacts,companies,deals}.read` + `.write`, `crm.objects.owners.read`, `crm.schemas.{contacts,companies,deals}.read` [H8] | `communication_preferences.write` (push opt-outs) [H4]    |
| Pipedrive | `base`, `contacts:full` (persons, orgs, their notes), `deals:full` (deals, pipelines, stages, notes), `users:read` (owner match) [P6]            | none (Pipedrive scopes are fixed on the app, not per URL) |

- **Tokens sealed like mailbox secrets:** `sealJson()` (`packages/email/src/secrets.ts`, AES-256-GCM,
  workspace id as AAD) of `{kind: "oauth", refreshToken, accessToken, accessExpiresAt}` in
  `crm_connections.secret_sealed`; never returned, never logged. Store the refresh token returned
  by every refresh (rotation-safe). HubSpot access tokens last 30 min [H1]; Pipedrive's 60 min,
  and its refresh token expires after 60 days unused [P1], so a paused connection still refreshes
  weekly. HubSpot: use the dated OAuth endpoints (`/oauth/2026-03/token`, `/token/revoke`), not
  v1, which is deprecated on Feb 16, 2027 [H2]. Pipedrive: `oauth.pipedrive.com/oauth/authorize`, `/token`,
  `/revoke` [P1][P2]; calls go to the returned `api_domain`, accepted only if it matches
  `^https://[a-z0-9-]+\.pipedrive\.com$`.
- **Disconnect** revokes at the provider (Pipedrive: revoking the refresh token uninstalls the app
  [P2]), replaces the secret with the removed marker, stops the schedule and keeps the id links
  (ids only), so reconnecting the _same_ account resumes without duplicates; a _different_ account
  clears them, as does "Disconnect and forget links" (which keeps tombstones, so erased people are
  never re-imported). A failed revoke never blocks the local disconnect. Pipedrive's uninstall
  callback (`DELETE`, basic auth with our client credentials, compared in constant time) marks the
  connection disconnected and drops its lease; a run in progress stops at its next lease check.
- States: `needs_setup → previewing → importing → active ⇄ paused`, `error` (reconnect needed:
  `invalid_grant`, missing scope, account gone), `disconnected`.

### 2. Mapping

- **Identity:** `crm_links` maps each Openline contact / company / deal to one external id (unique
  both ways per connection). First-link match keys: contacts by **email** (lower-cased; HubSpot
  `email`, Pipedrive primary `emails[]`); companies by **normalized domain** (lower-case, no
  scheme, `www.`, path or port). Pipedrive orgs have no standard domain field: they match by the
  website field the admin maps, else by exact case-insensitive name, shown in the preview as
  "matched by name". Deals have no natural key: imported deals are created, Openline-only deals are
  pushed; on an import (e.g. after "forget links") an unlinked deal with the exact name in the
  pipeline (and the same amount / close date where both have one) is linked instead, both ways.
  Contacts without a valid email are skipped and counted. Domains are stored and compared in match
  form; a domain another company holds is not copied (`domain_taken`), and any unique clash inside
  one record is a record-level error, never a failed run.
- **Standard field map** (on by default, direction editable; email is the key and never
  overwritten):

| Openline                  | HubSpot                                    | Pipedrive                             |
| ------------------------- | ------------------------------------------ | ------------------------------------- |
| contact first/last, email | `firstname`, `lastname`, `email`           | `first_name`, `last_name`, `emails[]` |
| title, phone              | `jobtitle`, `phone`                        | mapped custom field, `phones[]`       |
| contact→company, owner    | association, `hubspot_owner_id`            | `org_id`, `owner_id`                  |
| company name, domain      | `name`, `domain`                           | `name`, mapped website field          |
| deal name, amount, cur.   | `dealname`, `amount`, `deal_currency_code` | `title`, `value`, `currency`          |
| deal stage                | `pipeline` + `dealstage`                   | `stage_id` + `status` (won/lost)      |
| close date, lost reason   | `closedate`, `closed_lost_reason`          | `expected_close_date`, `lost_reason`  |
| deal→company, contact(s)  | associations v4                            | `org_id`, `person_id`                 |

- **Custom-field mapping UI:** ≤ 20 extra mappings per object between an Openline custom field
  (`custom.<key>`: text, number, date, boolean) and a CRM property of a compatible type, listed
  from the properties / `*Fields` APIs. Enumerations map by label, CRM → Openline only in v1;
  read-only / calculated CRM properties can only map _from_ the CRM.
- Each mapping has a **direction** (`both` | `to_crm` | `from_crm` | `off`) and a **source of
  truth** (`newest` default | `openline` | `crm`), see §3.
- **Owners** match by user email (HubSpot owners, Pipedrive users). Unmatched CRM owner → the
  connection's default owner (the connecting admin, changeable); an Openline owner with no CRM
  user leaves the CRM owner unchanged.
- **Stages, one pipeline in v1:** the admin picks one CRM deal pipeline; deals elsewhere are
  ignored (counted). Every CRM stage maps to one Openline stage (many-to-one allowed) and every
  active Openline stage to one CRM stage, pre-filled by name and won/lost kind. Pipedrive won/lost
  is a deal `status`, not a stage: Openline Won → `status=won`, Lost → `status=lost` +
  `lost_reason`; a pulled lost deal with no reason gets "Not given (from Pipedrive)". Sync waits
  for a complete mapping; a stage added or archived on either side pauses _deal_ sync with "Stage
  mapping needs attention" (contacts and companies continue).
- **Currency:** Openline keeps integer minor units (OL-E7); conversion uses ISO 4217 minor digits
  (JPY 0, USD 2, KWD 3) on the decimal string, never floats (extra precision rounds half-up,
  logged). **No FX conversion.** If the CRM can't hold the deal's currency (single-currency
  HubSpot, currency not enabled in Pipedrive) the amount isn't pushed and the deal shows
  `currency_mismatch`; other fields still sync. Pulled deals without currency take the CRM default.

### 3. Direction and conflicts

- **Initial import (CRM → Openline), dry run first.** "Preview" runs the full matching without
  writing and shows per-object counts: create / link to existing / update / skipped (no email,
  other pipeline, suppressed-and-new, invalid) and "only in Openline". The admin confirms with the
  CSV import's lawful-basis checkbox (pulled contacts get `consent_basis = none`) and chooses
  whether to push Openline-only records now. A preview is valid 1 h and stores counts plus ≤ 20
  example ids per bucket, no field values.
- **Then two-way incremental.** For each link, `crm_links.shadow` holds a hash per synced field of
  the value both sides last agreed on. Per field: changed only in Openline → push; only in the CRM
  → pull; on both → **last writer wins per field**, comparing the CRM record's modified time
  (`lastmodifieddate` / `hs_lastmodifieddate` [H5], Pipedrive `update_time`) with the Openline
  row's `updated_at`; ties go to the CRM. A field's source of truth `openline` / `crm` replaces the
  timestamp rule. Each conflict is logged (field, winner, both times; no values).
- **Echo suppression:** a value we just wrote is in the shadow, so the next poll on either side
  sees no difference and writes nothing. Pulled writes are made by the sync actor and do not bump
  a deal's `last_activity_at`.
- **New records after import:** new CRM contacts / companies / in-pipeline deals are created in
  Openline. Pushed: deals always; companies when a synced contact or deal needs one; contacts
  **"engaged" by default** (on a deal, replied, or in a sequence), or "all" / "never", because new
  HubSpot contacts can raise the customer's marketing-contact bill.
- **Deletes are soft.** Deleted in the CRM → Openline record kept and unlinked, badge "Deleted in
  HubSpot" (HubSpot restores for 90 days [H3], Pipedrive purges after 30 [P3]; a restore re-links).
  Deleted in Openline, including erasure → the link becomes a **tombstone** (external id only) so
  the next pull does not re-create the person. **Openline never deletes in the CRM in v1**; the
  help article tells admins to erase there too when a request covers both.
- **Merges:** when a linked external record disappears or reports it was merged (HubSpot's merge
  returns the surviving id [H3]; a Pipedrive merge deletes the losing record [P3]), re-match by key
  (email / domain): one hit → repoint, logged "merged in CRM"; none → unlink. If two Openline
  records would point at one CRM record, the key match keeps the link and the other gets a
  `merge_conflict` error for an admin. Openline never merges its own records automatically.

### 4. What syncs out, and what never does

- Deals, contacts, companies and their links (contact→company, deal→company, deal→primary
  contact). Extra HubSpot deal contacts are pulled into `deal_contacts` (≤ 20); pushing extras is v2.
- **Activity note (opt-in, off by default):** per sent sequence email and per reply on a linked
  contact, a CRM note on the contact (and its deal): "Openline: email 'Subject' sent from Ana's
  mailbox, step 2 of 'Q1 outreach'" / "Reply received (interested)". Subject only, never the body;
  the S6 teammate-mailbox privacy rule applies. Append-only, never pulled back. Build ticket
  confirms the HubSpot Notes scope [H9]; if it needs one, it becomes optional.
- **Opt-outs travel, re-subscribes never do.** An Openline unsubscribe or "asked not to contact"
  pushes the CRM opt-out: HubSpot unsubscribe-from-all (only with the optional scope; otherwise a
  standing warning "Opt-outs are not being sent to HubSpot") [H4]; Pipedrive `marketing_status =
unsubscribed` where Campaigns is on (Pipedrive allows that change once, which is all we need)
  [P3]. A CRM opt-out (`hs_email_optout`, Pipedrive `unsubscribed`) adds a **locked** Openline
  suppression, new reason `crm_unsubscribed` (added to `LOCKED_REASONS`). Sync never re-subscribes,
  removes a suppression, lowers `consent_basis`, or returns a contact to `active`.
- **Never out:** the suppression list itself; suppressed contacts not already in the CRM; email
  bodies; Scout output beyond the label in the opt-in note; health scores; consent evidence.

### 5. Engine

- New `packages/crm`: providers `hubspot`, `pipedrive`, `fake`; mapping, conflict, sanitizing and
  currency logic as pure, unit-tested functions. Run by `apps/worker` beside the sequencer, and
  in the API when `RUN_SCHEDULER=true` (PGlite), as in ADR 0004. HubSpot object APIs pinned to one
  dated version in one module.
- **Polling per connection** (ADR 0006): `claim_due_crm_syncs(batch)`, `SECURITY DEFINER` owned by
  `openline_scheduler`, column grants on `crm_connections` only (`id, workspace_id, status,
next_sync_at, sync_locked_until`), `FOR UPDATE SKIP LOCKED`, 10-min lease renewed during long
  runs, ids only; all else inside `withTenant()`. Every 10 min (HubSpot) / 15 min (Pipedrive);
  after 4 empty polls back off to 30 min; a local change or "Sync now" (6/h) brings it forward.
- **Cursors** per object in `crm_connections.cursors`. HubSpot: search by last-modified ascending
  from cursor − 2 min (search indexing lags), 200 per page, re-anchoring the window before the
  10,000-result cap [H5]; initial import uses list endpoints (`after`, 100 per page) [H3].
  Pipedrive: API v2 lists with `updated_since`, `sort_by=update_time`, cursor, ≤ 500 per page, and
  deleted deals via `status=deleted` [P3][P4]. Local side: rows with `updated_at` past the local
  cursor, diffed against the shadow. A daily reconcile re-reads linked ids in batches to catch
  deletes and merges the change feeds miss.
- **Rate limits.** HubSpot: batch ≤ 100 records [H3], search 5 req/s [H5], 110 requests / 10 s per
  installed account for the rest, shared with the customer's other apps [H6]; we use at most half
  (token bucket per connection, reading `X-HubSpot-RateLimit-Remaining`). Pipedrive: per-2-second
  burst limit from `x-ratelimit-*`, plus a **daily token budget shared by the whole company**
  (30,000 × plan multiplier × seats; v2 list 10, update 10, search 40) [P4][P5]. We count our own
  spend and stop at a per-connection cap (default 15,000/day, admin-adjustable): "Paused until
  tomorrow: daily API budget". An idle Pipedrive connection costs ~1,500–3,000 tokens a day.
- **Retries.** 429 → wait for the window / `Retry-After`; 5xx or network → backoff with jitter (1,
  5, 30 min, then hourly); 401 → one refresh, then `error` + "Reconnect" banner and one email to
  admins. Per-record errors (validation, `currency_mismatch`, missing property) retry at 5 min,
  30 min, 2 h, then stay "needs attention" until retried, fixed or dismissed.
- **Idempotency.** Pulls are idempotent by external id + shadow. Before creating in the CRM the
  engine writes the link as `creating` (a reservation, like send reservations); if the worker dies,
  recovery looks the record up by key (contact upsert by email, company by domain, deal by exact
  name in the pipeline created after the reservation): one hit → link, otherwise `unconfirmed` for
  an admin. Never create twice on a guess.
- **Sync log:** `crm_sync_runs` (kind, counts per object and action, API calls / tokens, duration,
  status) and `crm_sync_errors` (object, Openline id, external id, direction, code, message ≤ 500
  written by us, never CRM text or values). **Pause / resume** stops both directions and keeps
  cursors; changes made while paused sync once on resume.
- Performance: import of 10k contacts + 2k companies + 1k deals < 10 min (HubSpot); a run with 100
  changes < 30 s; no transaction spans a network call; pages are streamed.

### 6. UI

- **Settings → Integrations** (`/app/settings/integrations`): HubSpot and Pipedrive cards
  (Connect, or "Connected to Acme (portal 1234) by Ana"), status, last and next sync, open errors
  (link to log), Sync now, Pause / Resume, Disconnect (dialog: what is kept; nothing is deleted in
  the CRM). Setup wizard: pipeline → stage mapping → field mapping (standard rows + "Add field
  mapping") → preview counts → confirm (lawful basis, push Openline-only?) → progress. Tabs later:
  Fields, Stages, Options (contact push rule, activity notes, Pipedrive daily cap).
- **Sync log** (`/app/settings/integrations/log`; manager+ view, admin+ act): runs; errors by
  object / code / open, each linking to the Openline and CRM record, with Retry and Dismiss.
- **Record badges** on contact, company and deal pages and rows: "Synced with HubSpot · 4 min ago"
  linking to the CRM record, or "Not synced: <reason>", "Deleted in HubSpot", "Sync paused".
- **Help article** `apps/web/src/content/help/crm-sync.ts`: connecting, what syncs which way,
  conflicts and source of truth, deletes and erasure, opt-outs, Pipedrive budget, disconnecting.

### Out of scope (v1)

Salesforce and others; several pipelines; webhooks (ADR 0006: next); deleting or merging in the
CRM; tasks, calls, meetings, products, quotes, files, lists, custom objects; creating CRM
properties; field-history UI; marketplace listings.

## Data, security and compliance

- **New tables** (`0014_crm_sync.sql`, expand only), each with `workspace_id`, ENABLE + FORCE RLS,
  split policies, cross-tenant tests and composite `(workspace_id, id)` FKs as in 0011:
  `crm_connections` (`UNIQUE (workspace_id)`; provider, status, account id/name, `api_domain`,
  scopes, `secret_sealed`, pipeline, default owner, options, cursors, schedule/lease, `last_error`);
  `crm_links` (exactly one of `contact_id | company_id | deal_id` by CHECK, each a composite FK
  `ON DELETE SET NULL (col)` so erasure leaves a tombstone; external id; state `linked | creating |
unconfirmed | unlinked | tombstone`; shadow; timestamps; unique per connection both ways);
  `crm_field_mappings`; `crm_stage_mappings` (composite FK to `pipeline_stages`); `crm_sync_runs`;
  `crm_sync_errors` (app may update only `resolved_*`, `attempts`, `next_retry_at`). The scheduler
  gets column grants and one `TO openline_scheduler` policy on `crm_connections` only.
- **Personal data:** names, emails, phones, titles, company and deal data (categories we already
  hold), now copied to and from the customer's CRM on their admin's instruction. Retention: runs 90
  days, resolved errors 30 days, tombstones for the life of the connection (kept by "forget links";
  cleared only when a different account is connected).
- **Tokens:** decrypted only in-process for the call; never in logs, errors, audit or run log;
  refresh happens under the lease so two workers never race a rotating refresh token.
- **SSRF: not applicable** — fixed hosts (`api.hubapi.com`, `app.hubspot.com`,
  `oauth.pipedrive.com`, `*.pipedrive.com` validated), no user URLs; base URLs are overridable only
  when `APP_ENV` ≠ `production`.
- **Untrusted CRM data:** every pulled string is HTML-stripped, control characters removed, NFC,
  trimmed and cut to Openline limits (names 120, title 200, custom values 500); emails validated
  with the shared Zod schema; numbers and dates parsed strictly; raw payloads never stored. CRM
  text reaching Scout (job titles in Reality Check) is fenced with `wrapUntrusted()`.
- **Tenant isolation:** the workspace comes from the signed state at callback and from the claim
  row in the worker; every query also filters `workspace_id`; another workspace's connection, run,
  error or link → 404. Two workspaces may connect the same CRM account; we never check across
  tenants (that would reveal another workspace's connection).
- **Audit:** `crm.connected`, `crm.disconnected`, `crm.reconnect_required`, `crm.paused`,
  `crm.resumed`, `crm.import_previewed`, `crm.import_started`, `crm.import_completed` (counts),
  `crm.field_mapping_changed`, `crm.stage_mapping_changed`, `crm.options_changed`,
  `crm.error_dismissed`, and `contact.suppressed` with source `crm` for pulled opt-outs.
- **Sandbox rule:** `CRM_MODE` = `fake` (development / test default; base URLs → local fake
  servers), `sandbox` (staging: real APIs, but the callback rejects any account id not in
  `CRM_SANDBOX_ACCOUNT_IDS` with `crm_account_not_allowed`: HubSpot test accounts and a Pipedrive
  sandbox company only), `live` (production only; config refuses it elsewhere, like outreach).
- **Legal:** CAN-SPAM, CASL and GDPR opt-outs must hold across systems, hence opt-outs both ways
  and no re-subscribe path. Pulled contacts start at `consent_basis = none` after the lawful-basis
  confirmation. Privacy policy must name CRM integrations (lawyer review).

## Testing

- **No real network in CI.** `packages/crm/test/fake-hubspot.ts` and `fake-pipedrive.ts`:
  in-memory HTTP servers for everything we call (OAuth authorize auto-approve, token, rotating
  refresh, revoke; objects list / search / batch / merge / delete / restore; associations;
  pipelines; properties / fields; owners / users; notes; opt-out endpoints), with knobs for 429,
  5xx, latency, indexing lag, clock skew and per-request token cost. Request shapes follow the
  official doc examples. Playwright starts them like `tests/e2e/support/mail-sink.mjs`.
- Unit: field conflict matrix (here / there / both × source of truth), echo suppression (two polls
  after a write → zero writes), currency table, domain normalization, sanitizer, cursor overlap and
  10,000 cap, limiter, retry schedule. Integration (PGlite): RLS + cross-tenant on every table,
  claim / lease, reservation recovery, erasure tombstone, opt-out ratchet. E2E: connect fake
  HubSpot → preview → import → edit both sides → disconnect revokes.
- Manual pre-release run against staging sandbox accounts (`pnpm test:crm-sandbox`, never in CI).

## API (all under /v1; admin+ unless noted)

| Method + path                                                                     | Purpose                             |
| --------------------------------------------------------------------------------- | ----------------------------------- |
| `GET /integrations/crm` (manager+)                                                | Status, last/next run, error counts |
| `GET /integrations/crm/:provider/authorize` · `…/callback` (public, signed state) | OAuth start / return                |
| `GET /integrations/crm/remote/pipelines` · `…/remote/fields?object=`              | CRM pipelines + stages, properties  |
| `GET/PUT /integrations/crm/stage-mappings` · `…/field-mappings`                   | Read / replace mappings (validated) |
| `PATCH /integrations/crm` `{pipelineId, defaultOwnerId, options}`                 | Setup and options                   |
| `POST /integrations/crm/import/preview` · `…/import`                              | Dry run (returns run id) · confirm  |
| `POST /integrations/crm/sync-now` · `/pause` · `/resume`                          | Control (sync-now 6/h)              |
| `DELETE /integrations/crm?forgetLinks=`                                           | Disconnect (revokes)                |
| `GET /integrations/crm/runs` · `…/runs/:id` · `…/errors` (manager+)               | Sync log                            |
| `POST /integrations/crm/errors/:id/retry` · `/dismiss`                            | Act on an error                     |

Contact, company and deal DTOs gain `crm?: { provider, state, url?, syncedAt?, reason? }`.

## Acceptance criteria

- [ ] Given an admin, when they connect HubSpot, then consent asks only the scopes above, the token
      is stored sealed, `crm.connected` is audited and the wizard opens; a manager or rep → 403.
- [ ] Given a tampered, expired or other-user `state`, when the callback runs, then nothing is
      stored and the browser lands on the matching `?error=`; given staging and an account not on
      the sandbox list, then `crm_account_not_allowed`.
- [ ] Given a complete stage mapping, when the admin runs Preview, then counts per bucket show and
      no record changes on either side (checked on the fake server).
- [ ] Given a CRM contact with an Openline contact's email, when import runs, then they are linked,
      not duplicated, and any Openline suppression for that email stays.
- [ ] Given a field changed only in the CRM, when the next poll runs, then Openline shows it and the
      poll after writes nothing to either side.
- [ ] Given a field changed on both sides, then the later timestamp wins unless the field's source
      of truth says otherwise, and the run log records the decision.
- [ ] Given a deal moved to Won in Openline, then the Pipedrive deal is `status=won`; given a
      Pipedrive deal lost with a reason, then Openline moves it to Lost with that reason.
- [ ] Given an EUR deal and a USD-only HubSpot account, then the amount is not pushed, the deal
      shows `currency_mismatch` and its other fields sync.
- [ ] Given an Openline unsubscribe, then HubSpot unsubscribe-all is called (scope granted) or the
      warning shows (not granted); given a CRM opt-out, then a locked `crm_unsubscribed`
      suppression is added; given a CRM re-subscribe, then Openline changes nothing.
- [ ] Given a contact erased in Openline, when the CRM record later changes, then it is not
      re-created and nothing is deleted in the CRM.
- [ ] Given a record deleted in the CRM, then the Openline record stays, unlinked, badged "Deleted
      in HubSpot"; restoring it in the CRM re-links it.
- [ ] Given two CRM contacts merged, then the survivor keeps the key-matching link and any other
      Openline record left pointing at it gets `merge_conflict`, not a merge.
- [ ] Given a worker that dies after creating a CRM deal, when the lease expires, then recovery
      links it or marks it `unconfirmed`; the CRM never gets a second copy.
- [ ] Given repeated 429s, then sync backs off within the per-connection budget and the status says
      when it resumes; given `invalid_grant`, then `error` + "Reconnect" and one admin email.
- [ ] Given a pulled name with `<script>` and 5,000 characters, then it is stored as plain text
      cut to 120 characters.
- [ ] Given workspace B, when it requests workspace A's connection, runs, errors or links, then 404.
- [ ] Given a paused connection with changes on both sides, then nothing syncs until resume, then
      each change syncs once.
- [ ] Given a disconnect, then the provider revoke is called, the secret is erased, links are kept
      (or cleared with `forgetLinks=true`) and nothing is deleted in either system.

## Risks

- Silent overwrites from last-writer-wins → shadows, per-field source of truth, conflict log.
- Shared API budgets starving the customer's other tools → half-budget limiter, Pipedrive cap.
- HubSpot OAuth v1 sunset (Feb 2027), dated API versions → one pinned client module + fakes.
- HubSpot caps unlisted apps (2025.2+ platform) at 25 installs until listed [H7].
- Weak Pipedrive company matching (by name) → shown separately in the preview.

## What Harsh must do to go live

1. Register a **HubSpot public app** (developer account), redirect
   `https://<api domain>/v1/integrations/crm/hubspot/callback`, scopes above; create a HubSpot
   developer test account for staging.
2. Register a **Pipedrive app** in Developer Hub (unlisted), same callback pattern, scopes above,
   uninstall callback URL; create a Pipedrive sandbox company for staging.
3. Put `CRM_HUBSPOT_CLIENT_ID/SECRET` and `CRM_PIPEDRIVE_CLIENT_ID/SECRET` (separate staging and
   production apps) into AWS Secrets Manager, and send the engineer the sandbox account ids for
   `CRM_SANDBOX_ACCOUNT_IDS`. Secrets never go into chat or tickets.

## Changes from the Sprint 7 reviews

- Suppressions match by address **or @domain** everywhere (preview, import, push, opt-out push).
- A CRM opt-out upgrades an unlocked suppression (manual, bounced, …) to `crm_unsubscribed` and
  always unsubscribes the contact; locked reasons are never rewritten.
- A plan without CRM sync: nothing is claimed or synced (schedule kept, resumes on upgrade); status,
  log, pause, dismiss and disconnect still work; connect, setup / mappings, import, resume and Sync
  now need the plan.
- Stage drift (a new Openline stage, or a CRM deal in an unmapped stage) sets
  `stage_mapping_complete = false`, records a `stage_unmapped` error, shows "Stage mapping needs
  attention" and pauses deal badges; saving a complete mapping resolves it.
- Mappings may not use the key or opt-out properties (`email`, `hs_email_optout`, Pipedrive
  `emails` / `marketing_status`, …) nor one CRM field twice (400).
- Pipedrive conflicts compare whole seconds (its clock); ties go to the CRM.
- A local write to a linked record, or a new suppression, brings the next sync within a minute.
- Previews count a repeated key as the import will, save their Pipedrive spend, and are `partial`
  (still importable, flagged in the UI) when cut short; API setup calls count against the budget.
- Every engine write to the connection is guarded: a disconnect or uninstall always wins.
- Audit adds `crm.sync_requested`, `crm.error_retried` and `crm.connect_failed` (reason only).

## Open questions (business decisions for Harsh)

1. **Plans:** CRM sync in every plan, or Team and up? (Recommendation: Team and up.)
2. **Marketplace listings** (HubSpot needed past 25 installs; Pipedrive optional): when to apply.
   Recommendation: once 10 workspaces use the unlisted apps.
3. **Pushed-contacts default "engaged"** (protects customers' HubSpot bills): confirm.
4. **Privacy policy** wording for CRM integrations: add to the lawyer review.

## Sources (official docs, checked Nov 16, 2026)

- [H1] https://developers.hubspot.com/docs/guides/api/app-management/oauth-tokens
- [H2] https://developers.hubspot.com/docs/api-reference/legacy/authentication/oauth-tokens/v1/migration-guide
- [H3] https://developers.hubspot.com/docs/guides/crm/using-object-apis
- [H4] https://developers.hubspot.com/docs/api-reference/communication-preferences-subscriptions-v4/guide
- [H5] https://developers.hubspot.com/docs/api-reference/2026-03/crm/search-the-crm
- [H6] https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines
- [H7] https://developers.hubspot.com/changelog/new-marketplace-distribution-app-install-limits
- [H8] https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/scopes
- [H9] https://developers.hubspot.com/docs/guides/api/crm/engagements/notes · webhooks:
  https://developers.hubspot.com/docs/platform/working-with-webhooks
- [P1] https://pipedrive.readme.io/docs/marketplace-oauth-authorization ·
  https://developers.pipedrive.com/docs/api/v1/Oauth
- [P2] https://pipedrive.readme.io/docs/app-uninstallation
- [P3] https://developers.pipedrive.com/docs/api/v1/Persons
- [P4] https://developers.pipedrive.com/docs/api/v1/Deals
- [P5] https://pipedrive.readme.io/docs/core-api-concepts-rate-limiting
- [P6] https://pipedrive.readme.io/docs/marketplace-scopes-and-permissions-explanations · webhooks
  v2: https://pipedrive.readme.io/docs/guide-for-webhooks-v2
