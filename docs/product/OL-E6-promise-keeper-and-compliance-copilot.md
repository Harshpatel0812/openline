# PRD: Promise Keeper and Compliance Copilot

Epic: OL-E6 Sprint: S5 Owner: Harsh Status: Approved for build (Nov 15, 2026)

## Problem

Two things quietly lose deals and create risk for small sales teams:

1. **Broken promises.** "I'll send the quote Friday" and "call me after budget in March" live in
   email threads and in people's heads. They get forgotten, and the prospect notices.
2. **"Am I allowed to contact this person?"** Reps can't answer this for a Canadian contact whose
   implied consent may have expired, someone who unsubscribed last year, or a 10 p.m. send. Today
   the sending engine silently skips or waits, and nobody can see why, or prove later that a
   contact was allowed.

## Goals and metrics

- Promise Keeper catches 90 %+ of commitments in the evaluation set
  (`packages/ai/eval/promises.jsonl`), with no more than 10 % false positives.
- Every email Openline sends has a stored compliance decision citing the rules it checked
  ("proof"), and any rep can ask "can I email this contact now?" and get an answer with reasons
  in under 300 ms.
- No promise is overdue without the owner being told (Today card and inbox badge).

## Scope

### 1. Tasks (foundation)

A `tasks` table: workspace, owner (user), contact (optional), company (optional), title (≤200),
notes (≤2,000), due_at (optional), kind (`follow_up`, `send_promised`, `call`, `other`), source
(`manual`, `promise`), source message id (optional), status (`open`, `done`, `dismissed`),
completed_at, created_by. RLS + cross-tenant tests. API: list (mine / all for manager+, filters
open/overdue/due today/upcoming), create, update, complete, dismiss. Reps see and edit their own
tasks; managers+ see all. The Today page lists overdue, due today and the next 7 days.

### 2. Promise Keeper (Scout feature)

- **What it reads:** inbound replies (when stored by reply detection) and outbound 1:1 replies
  sent from the inbox. Not sequence steps (templates aren't promises).
- **What it extracts:** commitments with who / what / by when:
  - _Our promise_ ("I'll send the pricing by Friday") → proposed task for the sender, kind
    `send_promised`, due at the parsed date (end of that business day in the rep's workspace time
    zone; "next week" → next Monday 10:00; no date → +2 business days, flagged "no date given").
  - _Their request to follow up later_ ("try me after budget in March", "circle back in Q2") →
    proposed task `follow_up` at that date. Promise Keeper never proposes pausing enrollments
    (product decision, Nov 15, 2026): the human reply already stops the sequence, and the task
    is the reminder.
  - _Their promise_ ("I'll check with my boss and get back to you next week") → proposed
    `follow_up` task the day after their date, so the rep nudges if nothing arrives.
- **How:** the small model with structured JSON output (zod-validated), the message text fenced
  with `wrapUntrusted`; dates resolved deterministically in code from the model's phrase plus the
  message's own date (never trust a model-computed absolute date). Max 3 promises per message.
  With Scout off or over budget, a conservative rule-based extractor handles the common English
  patterns ("I'll send … by <day>", "get back to you <when>", "reach out in <month/quarter>").
- **Approval (Scout rule 1):** each promise becomes an `ai_actions` row (kind `promise_task`) in
  `proposed`. The mailbox owner or a manager+ accepts (creates the task) or dismisses, from the inbox message, the contact
  page or Today. Nothing is created without a click. Audit every decision.
- **Keeping promises:** a task due within 24 h shows as "Due soon"; past due shows "Overdue" on
  Today, in the sidebar badge and on the contact. When the rep sends a reply in the same thread
  after the promise, the task is suggested as done ("Looks like you sent it — mark done?").
- **Evaluation set:** `packages/ai/eval/promises.jsonl` with ≥40 labelled examples (positive and
  negative, several languages' date phrases in English text), runnable like the reply eval.

### 3. Compliance Copilot (deterministic — never an LLM)

- **One engine:** `packages/compliance` gains `evaluateEmailContact(input, at)` returning
  `{ decision: "allowed" | "not_now" | "blocked", nextAllowedAt?, checks: Check[] }` where each
  `Check` is `{ rule: RuleId, outcome: "pass" | "fail" | "wait" | "not_applicable", detail,
citation }`. Rules (ids stable, versioned with `RULESET_VERSION`):
  - `suppression` — email or domain on the workspace suppression list → blocked.
  - `contact_status` — unsubscribed / bounced / archived → blocked.
  - `consent_ca` (CASL) — Canadian recipient needs express consent, or implied consent not
    expired (existing business relationship: 2 years from purchase, 6 months from inquiry) →
    blocked when missing or expired; when it expires within 30 days, pass with a warning.
  - `basis_eu` (GDPR) — EU/UK recipient needs a recorded lawful basis (consent or legitimate
    interest with a note) → blocked without one.
  - `sender_identity` (CAN-SPAM / CASL) — workspace postal address present → blocked without.
  - `unsubscribe_mechanism` — always pass (Openline adds it), recorded for proof.
  - `send_window` — inside the contact's local business hours → otherwise `not_now` with
    `nextAllowedAt`.
    Citations are plain-language with the law and section, e.g. "CAN-SPAM Act, 15 U.S.C.
    7704(a)(5): a valid physical postal address in every commercial email"; "CASL s. 6 and s. 10(9)–(10):
    implied consent from an existing business relationship lasts 2 years after a purchase or 6
    months after an inquiry"; "GDPR Art. 6(1): processing needs a lawful basis". The help article
    says this is not legal advice.
- **The sending engine uses the same engine** (replacing its inline checks with identical
  outcomes and the same `lastDecision` codes), and stores the result as **proof** on the
  outbound message row (`compliance_proof` jsonb: ruleset version, decision, checks, evaluated
  at). Inbox replies store proof too (with `send_window` not applicable).
- **Ask anytime:** `GET /v1/contacts/:id/compliance?channel=email` → the evaluation for now
  (`&purpose=reply` → what an inbox reply enforces: no send window, archived contacts may be
  answered; the reply composer's badge uses it). UI:
  a "Can I email them?" panel on the contact page (green / amber / red with each check and its
  citation, next allowed time); a compact badge in the enroll dialog (blocked contacts listed with
  the reason before enrolling) and in the inbox reply composer.
- **Proof export:** on a contact, "Download compliance record" → JSON of consent records,
  suppression state and the proof of every email sent to them (for a regulator or a complaint).

### Out of scope

Calls (TCPA, recording consent, DNC lists) — Compliance Copilot's call rules ship with calling.
Promise detection in call transcripts. State-by-state US privacy rules beyond the above.

## Non-functional

- Compliance engine: pure functions, 100 % branch coverage on rule outcomes, property tests for
  time-zone and expiry edges; p95 < 50 ms per evaluation.
- New tables with RLS and cross-tenant tests; proof JSON contains no message body.
- Promise extraction runs in the reply-sync/outbound path asynchronously and never blocks a send.

## API (all under /v1)

| Method + path                                  | Who                       | Purpose                             |
| ---------------------------------------------- | ------------------------- | ----------------------------------- |
| `GET /tasks?scope=mine\|all&status=&due=`      | rep (mine), manager+      | List tasks                          |
| `POST /tasks` / `PATCH /tasks/:id`             | rep+ (own)                | Create / edit                       |
| `POST /tasks/:id/complete` / `/dismiss`        | owner, manager+           | Close                               |
| `GET /tasks/counts`                            | rep+                      | `{overdue, dueToday, upcoming}`     |
| `GET /promises?status=proposed&contactId=`     | rep (own), manager+       | Proposed promise actions            |
| `POST /promises/:actionId/accept` / `/dismiss` | mailbox owner or manager+ | Accept (optionally edit title/date) |
| `GET /contacts/:id/compliance?channel=email`   | rep+                      | Evaluation now                      |
| `GET /contacts/:id/compliance/record`          | manager+                  | Proof export (JSON download)        |
