# PRD: Pipeline and Pipeline Reality Check

Epic: OL-E7 Sprint: S6 Owner: Harsh Status: Approved for build (Nov 15, 2026)

## Problem

Replies turn into conversations, and conversations into deals, but Openline has nowhere to track
them. Teams fall back to a spreadsheet or a second CRM, and the pipeline they report is too
optimistic: deals sit in "Proposal" when nobody has seen a proposal, and stale deals look alive.

## Goals and metrics

- A rep can turn a reply into a deal in two clicks, and the whole team's pipeline is on one board.
- Pipeline Reality Check flags agree with a sales manager's judgment 80 %+ of the time on the
  evaluation set (`packages/ai/eval/reality.jsonl`).
- Stale deals (no activity past the stage's limit) are visible on the board and on Today.

## Scope

### 1. Stages

- One pipeline per workspace (multiple pipelines are v2). Default stages created with the
  workspace (existing workspaces get them in the migration): Discovery (10 %), Qualified (25 %),
  Proposal (50 %), Negotiation (75 %), Won (100 %, closed won), Lost (0 %, closed lost).
- Each stage: name (≤40), order, probability 0–100, kind `open | won | lost`, `stale_after_days`
  (default 14, null = never), and **entry criteria**: up to 5 plain-language checklist items, each
  optionally tied to an evidence type the Reality Check understands: `decision_maker_engaged`,
  `budget_discussed`, `need_confirmed`, `timeline_discussed`, `next_step_dated`,
  `proposal_sent`, `verbal_yes`, `none`.
- Admin+ edit stages (rename, reorder, probabilities, criteria, add, archive). A stage with deals
  can only be archived after moving its deals. Exactly one `won` and one `lost` stage.

### 2. Deals

- Fields: name (≤120), company (optional), primary contact (optional) + other contacts
  (many-to-many, ≤20), owner (member), stage, amount (decimal ≥ 0, optional), currency (ISO 4217,
  default from workspace — new workspace setting `currency`, default USD), expected close date,
  next step (≤200) + next step date, lost reason (required when moved to lost), created/updated,
  `stage_entered_at`, `last_activity_at` (latest of: email sent/received with any deal contact,
  task completed on the deal, stage change, edit), closed_at.
- Create from: the Deals page, a contact, a company, or an inbox reply ("Create deal" prefilled
  with contact, company and a name like "Acme Tools — new deal").
- Moving stage: drag on the board or a select; each move is recorded in `deal_stage_history`
  (from, to, by, at) and in the audit log. Moving to won/lost sets `closed_at`; reopening clears it.
- Stale: `now - last_activity_at > stage.stale_after_days` → "Stale" badge; Today shows "Deals
  needing attention" (stale or next-step date passed) for the owner.
- Tasks can be linked to a deal (`tasks.deal_id`, optional).
- Permissions: reps see all deals in the workspace (read) but edit only deals they own; managers+
  edit all. Cross-workspace → 404.

### 3. Board and list (web)

- `/app/deals`: Kanban board by stage (open stages; Won/Lost as collapsible columns) with column
  totals (count, sum of amount, weighted sum = amount × probability), cards showing name, company,
  amount, owner initials, close date, stale/next-step badges, Reality Check flag icon. Drag and drop
  (keyboard accessible: move via a menu too). Filters: owner (mine / everyone / person), close
  date range, stale only, flagged only. List view with sortable columns and the same filters.
- Deal page `/app/deals/:id`: header (name, stage select, amount, close date, owner), contacts,
  activity timeline (emails with the deal's contacts, stage changes, tasks, notes), next step,
  tasks, Reality Check panel, stage history.
- Forecast strip on the board: open pipeline total, weighted total, expected to close this month
  and this quarter (by close date).
- Contact and company pages list their deals.

### 4. Pipeline Reality Check (Scout feature)

- **Evidence:** for each open deal, Openline gathers the emails (subject + trimmed text, both
  directions, last 90 days, max 30 messages / 30k characters) with the deal's contacts, the
  deal's next step fields, and completed tasks. Text is untrusted and fenced.
- **Model step (small model, JSON, zod-validated):** for each evidence type, return
  `{present: yes | no | unclear, quote?, messageId?}` — the quote must be a verbatim substring of
  that message's text (checked in code; otherwise treated as `unclear`). Who counts as a decision
  maker comes from contact job titles (fenced) plus what the emails say.
- **Deterministic step (code, not the model):** compare the evidence with the entry criteria of
  the deal's current stage _and all earlier stages_. If a criterion tied to an evidence type is
  `no`, flag it. Compute the **evidence stage**: the furthest stage whose tied criteria are all
  `yes` (or untied). Flag "Stage says Proposal, evidence says Discovery" when the evidence stage
  is earlier than the current stage. Also flag: next step date passed; no next step on a deal past
  Discovery; close date in the past while open; stale.
- **Output:** a `deal_checks` row per run: evidence per type with quotes and message links,
  flags, evidence stage, model, tokens, ran_at. The deal page shows it ("Reality Check —
  last checked 2 h ago"), each flag with its quote linked to the email; the board shows a flag
  icon. Suggestion only: "Move to <evidence stage>" is an `ai_actions` proposal the owner (or a
  manager) approves; nothing moves on its own. The rep can mark a flag "Not right — we discussed
  this on a call" (stored, suppresses that flag until new evidence; feeds the eval).
- **When it runs:** on demand ("Check now", rate-limited 10/deal/day), and automatically in the
  worker at most once a day per open deal with new activity since the last check, within the
  workspace's Scout budget (Reality Check may use up to 25 % of monthly credits). With Scout off
  or no budget: only the deterministic flags (dates, stale, no next step) run.
- **Evaluation set:** `packages/ai/eval/reality.jsonl` (≥30 deals: emails, stage, expected flags),
  runnable like the others.

### Out of scope

Multiple pipelines, products/line items/quotes, HubSpot/Pipedrive sync (next sprint), forecast
categories and targets, win/loss analytics (Win Pattern Miner, v2).

## Non-functional

- New tables with FORCE RLS, split policies, cross-tenant tests; stage history append-only.
- Board loads 500 open deals p95 < 500 ms; drag-and-drop updates optimistically and rolls back on
  error.
- Money as integer minor units (cents) in the database; never floats.
- No email text stored in `deal_checks` beyond the short quotes (≤300 characters each).

## API (all under /v1)

| Method + path                                                                 | Who                             | Purpose                                  |
| ----------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------- |
| `GET /pipeline/stages` · `PUT /pipeline/stages`                               | all · admin+                    | Read / replace stage list (validated)    |
| `GET /deals?stageId=&ownerId=&stale=&flagged=&closeFrom=&closeTo=&q=&cursor=` | rep+                            | List / board data                        |
| `GET /deals/summary?ownerId=`                                                 | rep+                            | Column totals and forecast strip         |
| `POST /deals` · `GET/PATCH /deals/:id`                                        | rep+ (edit own), manager+ (all) | Create, read, edit                       |
| `POST /deals/:id/move`                                                        | same                            | `{stageId, lostReason?}`                 |
| `GET /deals/:id/timeline`                                                     | rep+                            | Activity timeline                        |
| `POST /deals/:id/reality-check`                                               | owner, manager+                 | Run now (rate-limited)                   |
| `GET /deals/:id/reality-check`                                                | rep+                            | Latest check                             |
| `POST /deals/:id/reality-check/flags/:flagId/dismiss`                         | owner, manager+                 | "Not right" with reason                  |
| `POST /deals/:id/reality-check/suggestion/accept` · `/dismiss`                | owner, manager+                 | Accept / dismiss the stage-move proposal |
