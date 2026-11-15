# PRD: Replies, reply inbox and Scout v1 (drafting with approval)

Epic: OL-E4 Sprint: S4 Owner: Harsh Status: Approved for build (Nov 14, 2026)

## Problem

Sprint 3 sends sequences, but a sequence that keeps emailing someone who already answered is the
fastest way to look like a spammer, annoy a buyer and lose the deal. Today a rep must press "Mark
replied" by hand. Reps also juggle replies across several mailboxes, and the first email of a
sequence — the one that decides whether anyone replies — is still written from a blank page.

## Goals and metrics

1. **No follow-up after a reply.** A reply stops that contact's sequence before the next step can
   send. Metric: 0 sends after a detected reply (engine re-checks before every send); median time
   from reply arriving to sequence stopped under 3 minutes (polling interval 2 minutes).
2. **One inbox.** Every reply from every connected mailbox in one list, labelled. Metric: 90 %+ of
   replies auto-labelled correctly on the evaluation set (`packages/ai/eval/replies.jsonl`).
3. **Scout drafts, the rep decides.** Metric: 50 %+ of Scout first-touch drafts approved with light
   edits in the design-partner beta (tracked via `ai_actions` status + edit distance).

## Scope

### 1. Reply detection (all mailbox types)

- **SMTP mailboxes** gain IMAP settings (host, port 993 TLS; same login by default, separate login
  allowed). Login is verified at connect like SMTP. Existing SMTP mailboxes show "Turn on reply
  detection" until IMAP is added. Same SSRF rules as SMTP (resolve, refuse private addresses
  outside dev/test, pin the address, ports 993 or 143+STARTTLS only).
- **Gmail mailboxes** need the `gmail.readonly` scope, which Google classes as restricted (needs
  app verification and a yearly CASA security assessment before public launch). We ask for it only
  when the user turns on reply detection ("incremental consent"); send-only users are unaffected.
  Until Openline is verified, Google shows an "unverified app" screen for test users — fine for
  the design-partner beta (≤100 users).
- **Sync** runs in the worker (in-process with PGlite, like the sequencer) every 2 minutes per
  mailbox: IMAP — messages in INBOX with UID above the last seen UID (first sync: last 7 days);
  Gmail — `history.list` from the stored `historyId` (first sync: `messages.list` newer_than:7d).
  Each sync is bounded (≤ 200 messages, ≤ 30 s) and records `last_synced_at` / `last_sync_error`.
- **Matching** an inbound message to an enrollment, in order:
  1. `In-Reply-To` / `References` contain an outbound `messages.message_id_header` of this
     workspace (exact match).
  2. Otherwise, sender email equals a contact with an `active`/`paused` enrollment that sent from
     this mailbox in the last 30 days.
  3. Otherwise, sender **domain** equals such a contact's company domain (colleague replied) —
     stops that contact's enrollment and is labelled "From a colleague".
     Unmatched messages are ignored and **not stored** (we only keep replies to our outreach).
  - Machine mail never matches by rule 2 or 3: `List-Id` / `List-Unsubscribe` / `Precedence:
bulk|list|junk`, `Auto-Submitted` other than `no` (rule 2 still accepts the contact's own
    `auto-replied` out-of-office), or a no-reply / notifications / mailer-daemon style sender.
    In the thread (rule 1), `Auto-Submitted: auto-generated` mail is stored as `other`, already
    handled, with no effects.
  - Bounce reports match **only** by rule 1 (the original Message-ID / References name a message
    we sent); a report naming only an address is not stored. A report whose failed address is not
    the contact's (a forward, an alias) is not stored either.
- **Stored** for matched messages (direction `inbound`): from (email, name), subject, received at,
  `Message-ID`, `In-Reply-To`, text body (plain text only; HTML converted to text; capped at
  20,000 characters; quoted history below "On … wrote:" trimmed), classification, linked
  enrollment/contact/mailbox. Attachments are not downloaded. Deleting a contact deletes their
  inbound messages (FK `ON DELETE CASCADE` for inbound rows' contact link is acceptable; outbound
  stays SET NULL for the cap and bounce history).
- **Effects** (in one transaction, idempotent by `(mailbox_id, Message-ID)` unique):
  - human reply → enrollment `replied`, `nextRunAt` null, `lastDecision` `reply_received`; the
    contact's other active enrollments in the workspace are also stopped (`replied`).
  - out-of-office (auto-reply headers `Auto-Submitted: auto-replied`, `X-Autoreply`,
    `X-Autorespond`, `Precedence: auto_reply`, or classification `out_of_office`) → enrollment
    keeps `active` but `nextRunAt` moves to the return date found in the text (+1 business day)
    or +7 days if none; `lastDecision` `out_of_office`. Never counts as a reply. Dates are read
    against the message's own `Date`; a date without a year up to 60 days before it is already
    past (+7 days); any return date (also the model's) must lie within message date − 1 day …
    - 366 days, else +7 days. A step sent while the auto-reply arrived never pulls `nextRunAt`
      earlier.
  - bounce report (from `mailer-daemon@` / `postmaster@`, or `Content-Type: multipart/report;
report-type=delivery-status`) with a 5.x.x status for an address we emailed → contact
    `bounced`, enrollment `bounced`, then the >3 % auto-pause check. 4.x.x is ignored.
  - classified `unsubscribe` ("remove me", "stop emailing") → same as the unsubscribe link:
    suppress the email, contact `unsubscribed`, all enrollments `unsubscribed`. When the sender
    is not the contact (a colleague, also inside the thread): suppress the sender only; the
    contact's enrollments end as `replied`.
  - The engine already re-checks enrollment state before every send; it must also skip when an
    inbound reply for the enrollment exists that arrived after the last outbound step.

### 2. Reply classification

Labels: `interested`, `not_now`, `referral`, `not_interested`, `unsubscribe`, `out_of_office`,
`bounce`, `other`.

1. Deterministic first: bounce and auto-reply headers decide `bounce` / `out_of_office` with no AI.
2. Otherwise Scout's small model classifies the trimmed text, fenced as untrusted, returning JSON
   `{label, confidence 0–1, returnDate?, referral?: {name?, email?}, summary (≤ 140 chars)}`
   validated with zod. Invalid output → retry once → `other`.
3. If Scout is off for the workspace or no model is configured, a keyword fallback classifies
   (`unsubscribe`/`remove me`/`stop emailing` → unsubscribe; `not interested` → not_interested;
   `out of office`/`on vacation` → out_of_office; else `other`). Labels from the fallback show
   "(rule)" in the UI. Both classifiers only read the sender's own text: `>`-quoted lines, quoted
   copies of our compliance footer and our `/u/<token>` links are removed first, and quoted
   history is cut at "On … wrote:" and its de/es/fr/it/nl/pt forms, Outlook "From/Von … Sent/
   Gesendet" blocks and "-----Original Message-----" dividers.
   Model classification is capped (inbound mail is attacker-controlled): at most
   `REPLY_CLASSIFY_DAILY_CAP` (default 200) per mailbox per UTC day and at most 50 % of the
   month's credits; beyond that the keyword rules decide.
4. A rep can change the label; changing to/from `unsubscribe` applies/does not undo suppression
   (undoing suppression stays an admin action in Suppressions).

### 3. Reply inbox (web)

- `/app/inbox`: newest first, filters (label, mailbox, "needs action" = interested + referral +
  not_now + other, default), each row: contact, company, label chip (+ "(rule)"/confidence), the
  summary or first line, sequence + step it replied to, received time. Reps see replies to their
  own mailboxes; managers+ see all.
- Reply detail: the trimmed text (rendered as plain text, never HTML), the original step that was
  replied to, label editor, "Open in Gmail/mailbox" link where available, "Ask Scout to draft a
  reply" (proposal, see 4), "Mark handled".
- The Today page counts "Replies needing action" and links to the inbox; sidebar badge.
- Mailbox settings: reply-detection status per mailbox (On / Off / Error with message, last sync).

### 4. Scout v1 — drafting with approval

- **Model access** via `packages/ai` `LlmProvider` interface with adapters: `bedrock` (Anthropic
  models on AWS Bedrock, zero retention, the production choice), `anthropic` (direct API, for
  local development with a test key), `fake` (deterministic, for tests and offline dev). Config:
  `AI_PROVIDER=bedrock|anthropic|fake|off` (default `off`; `fake` allowed only in dev/test),
  `AI_MODEL_SMALL`, `AI_MODEL_LARGE`, plus provider credentials from the environment. No customer
  data in logs; prompts and outputs are never logged.
- **Workspace controls** (owner/admin, Workspace settings → Scout): on/off (default on when a
  provider is configured), monthly budget in AI credits (default 2,000; one credit ≈ 1,000 tokens),
  "Let Scout read company websites" (default on). Over budget → Scout features return 429
  `ai_budget_exceeded` with the reset date; deterministic features keep working.
- **Draft a first-touch email** (sequence step editor and contact page): input = contact (name,
  title, company), company domain, the step's purpose (rep's one-line note), the workspace's
  "about us" + value proposition (new workspace fields), optionally the company website. Output =
  subject + body with the sequence variables kept as `{{firstName}}` etc. where personalisation is
  generic, plus **citations**: every specific claim about the prospect lists its source (a
  contact field or a fetched page URL); claims without a source are not allowed (rule "cite or
  stay silent"), checked by the prompt and by validating that each cited source was in the input.
- **Draft a reply** to an inbound message: input = the trimmed thread (untrusted), contact, the
  original step. Output = reply body + citations.
- **Website research**: fetch at most 3 pages of the contact's company domain (`/`, `/about`,
  `/products` or `/services` if linked), https only, same SSRF guard and address pinning as SMTP,
  5 s timeout, 1 MB cap, text only, cached 7 days per domain per workspace. Page text is fenced
  with `wrapUntrusted` and the standing `UNTRUSTED_DATA_RULE`.
- **Approval flow** (`ai_actions` table, the existing state machine): every draft is an
  `ai_actions` row `proposed` (kind `draft_email` or `draft_reply`) with prompt inputs summary,
  proposal, sources, model, token usage. The rep can Edit, Approve (→ `approved`, the text is put
  into the step / reply composer — nothing is sent by Scout in v1), or Reject with an optional
  reason. Every transition is in the audit log. Drafts are never auto-applied.
- **Reply sending from the inbox** is in scope as a normal user action (not Scout): the rep sends
  a reply from the same mailbox, threaded (`In-Reply-To`, `References`, `Re:` subject), recorded
  as an outbound message linked to the thread; all compliance checks apply except the sequence
  window (it's a 1:1 reply the prospect started).

### Out of scope (later)

Gmail Pub/Sub push and IMAP IDLE (polling is enough for the beta); Microsoft 365; attachments;
Promise Keeper and Compliance Copilot (Sprint 5 on top of this inbox); embeddings / pgvector.

## Non-functional

- Tenant isolation: every new table has `workspace_id`, FORCE RLS, read/write policies, and a
  cross-tenant test. The sync job reaches mailboxes through a SECURITY DEFINER claim function owned
  by `openline_scheduler`, like `claim_due_enrollments`.
- Secrets: IMAP passwords and Gmail refresh tokens stay inside the sealed mailbox secret.
- Untrusted input: inbound email text and web pages only ever reach the model fenced; Scout output
  is validated by zod and rendered as plain text; it can never trigger an action by itself.
- Performance: inbox list p95 < 300 ms at 50k messages; classification ≤ 3 s p95 (async — the
  reply shows immediately with "Classifying…").

## API contract (all under /v1, cookie auth + CSRF header like the rest)

| Method + path                                              | Who                                 | Purpose                                                          |
| ---------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| `PUT /mailboxes/:id/imap`                                  | owner of mailbox, admin+            | Add/replace IMAP settings (verified first) → MailboxDto          |
| `DELETE /mailboxes/:id/imap`                               | same                                | Turn off reply detection for an SMTP mailbox                     |
| `GET /mailboxes/:id/google/reply-detection`                | same                                | 302 to Google consent with `gmail.readonly` added                |
| `GET /inbox?label=&mailboxId=&needsAction=&cursor=&limit=` | rep (own mailboxes), manager+ (all) | Page of InboxItemDto                                             |
| `GET /inbox/counts`                                        | same                                | `{needsAction, byLabel}`                                         |
| `GET /inbox/:messageId`                                    | same                                | InboxMessageDto (text, original step, enrollment, actions)       |
| `PATCH /inbox/:messageId`                                  | same                                | `{label?, handled?}`                                             |
| `POST /inbox/:messageId/reply`                             | same                                | `{body}` → sends a threaded reply from the mailbox               |
| `GET /workspace/scout` / `PATCH /workspace/scout`          | admin+ (PATCH), all (GET)           | Scout settings + usage this month                                |
| `POST /scout/drafts/first-touch`                           | rep+                                | `{contactId, sequenceId?, stepPosition?, purpose}` → AiActionDto |
| `POST /scout/drafts/reply`                                 | rep+                                | `{messageId, instructions?}` → AiActionDto                       |
| `GET /scout/actions/:id`                                   | creator, manager+                   | AiActionDto                                                      |
| `POST /scout/actions/:id/approve`                          | creator                             | `{finalText?}` (edited) → AiActionDto `approved`                 |
| `POST /scout/actions/:id/reject`                           | creator                             | `{reason?}` → AiActionDto `rejected`                             |

Errors: 409 `reply_detection_unavailable` (mailbox provider can't), 400 `imap_unreachable` /
`imap_auth_failed`, 429 `ai_budget_exceeded`, 503 `ai_unavailable` (no provider / provider down),
422 `ai_invalid_output` (after retry).

## Open questions for Harsh

1. Start Google app verification + CASA for `gmail.readonly` now (weeks of lead time; assessment
   fee is paid to an authorised lab)? Recommended: yes, during the beta.
2. AWS account for Bedrock (needed before any real Scout use). Until then Scout runs on the `fake`
   provider locally, or the direct Anthropic API with a test key you add.
