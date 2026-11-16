# Openline API contract (v1)

Base path `/v1` (health is `/health`). JSON only. Types and validation schemas live in
`packages/shared` and are shared by the API and the web app.

## Conventions

- **Auth:** session cookie (`ol_session` in dev, `__Host-ol_session` in production), httpOnly,
  SameSite=Lax. Every route needs a session unless marked public.
- **CSRF:** every POST/PATCH/DELETE must send header `x-openline-csrf: 1`, or it gets 403 `csrf`.
  Exempt (public, no session): `POST /v1/public/unsubscribe/:token` and `POST /v1/public/contact`.
- **Errors:** always `{ code, message, details? }`. Validation errors: 400 `validation_error` with
  `details: [{ path, message }]`.
- **Web app access:** the web app calls `/api/v1/...` on its own origin; Next.js rewrites
  `/api/*` to the API (`API_URL`, default `http://localhost:4000`). No CORS needed in practice.
- **Body size:** 100 KB per request, except `/v1/contacts/import*` (6 MB). Larger → 413
  `payload_too_large`.
- **Tenancy:** every request runs in the caller's active workspace (from the session).
  Another workspace's records always look like 404.

## Auth (Sprint 1)

| Method | Path                        | Body / query      | Response                                                                   |
| ------ | --------------------------- | ----------------- | -------------------------------------------------------------------------- |
| POST   | `/v1/auth/signup` (public)  | `SignupInput`     | 201 `{ok}` + cookie · 409 `email_taken` · 429                              |
| POST   | `/v1/auth/login` (public)   | `LoginInput`      | 200 `{ok}` + cookie · 401 `invalid_credentials` · 403 `no_workspace` · 429 |
| POST   | `/v1/auth/logout` (public)  | —                 | 200 `{ok}`, clears cookie                                                  |
| GET    | `/v1/auth/me`               | —                 | `MeResponse`                                                               |
| POST   | `/v1/auth/switch-workspace` | `{ workspaceId }` | 200 `{ok}` · 403                                                           |

## Team (Sprint 1)

| Method | Path                                     | Who                   | Response                                                                                                                                                                                     |
| ------ | ---------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/members`                            | all                   | `MemberDto[]`                                                                                                                                                                                |
| PATCH  | `/v1/members/:userId` `{ role }`         | owner, admin          | 409 `last_owner` · 403 (admin vs owner)                                                                                                                                                      |
| DELETE | `/v1/members/:userId`                    | owner, admin, or self | 409 `last_owner`; their mailboxes are removed and the active/paused enrollments sending from them stop                                                                                       |
| GET    | `/v1/invites`                            | owner, admin          | `InviteDto[]` (pending only)                                                                                                                                                                 |
| POST   | `/v1/invites` `InviteInput`              | owner, admin          | 201 `{ invite, inviteUrl }` · 409 `already_member`                                                                                                                                           |
| DELETE | `/v1/invites/:id`                        | owner, admin          | 200 · 404                                                                                                                                                                                    |
| GET    | `/v1/invites/lookup?token=`              | public                | `InviteLookupDto` · 404                                                                                                                                                                      |
| POST   | `/v1/invites/accept` `AcceptInviteInput` | public                | 200 (+cookie if new account) · 409 `login_required` (sign in as the invited email) · 409 `logout_required` (signed in as someone else) · 410 `invite_used`/`invite_expired`/`invite_revoked` |

`inviteUrl` is `${WEB_URL}/invite/<token>`; the token is shown once. Invite emails arrive in Sprint 3.

## Contacts and companies (Sprint 2)

| Method | Path                          | Who                   | Body / query                                                      | Response                                                           |
| ------ | ----------------------------- | --------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| GET    | `/v1/contacts`                | all                   | `?q=&limit=50&cursor=`                                            | `ContactListDto` (newest first; `q` searches name, email, company) |
| POST   | `/v1/contacts`                | all                   | `ContactCreate`                                                   | 201 `ContactDto` · 409 `contact_exists`                            |
| GET    | `/v1/contacts/:id`            | all                   | —                                                                 | `ContactDto` · 404                                                 |
| PATCH  | `/v1/contacts/:id`            | all                   | `ContactUpdate`                                                   | `ContactDto` · 409 `contact_exists`                                |
| DELETE | `/v1/contacts/:id`            | owner, admin, manager | `?suppress=true` also adds the email to suppressions              | 200 `{ok}`                                                         |
| POST   | `/v1/contacts/import/preview` | all                   | `{ csv }`                                                         | `ImportPreviewDto` (nothing saved)                                 |
| POST   | `/v1/contacts/import`         | all                   | `{ csv, duplicates: "skip"\|"update", confirmLawfulBasis: true }` | `ImportResultDto`                                                  |
| GET    | `/v1/companies`               | all                   | `?q=`                                                             | `{ items: CompanyDto[] }`                                          |

## Suppressions (Sprint 2)

| Method | Path                                   | Who          | Response                                                                               |
| ------ | -------------------------------------- | ------------ | -------------------------------------------------------------------------------------- |
| GET    | `/v1/suppressions`                     | all          | `SuppressionDto[]`                                                                     |
| POST   | `/v1/suppressions` `SuppressionCreate` | owner, admin | 201 `SuppressionDto` · 409 `conflict` if already listed                                |
| DELETE | `/v1/suppressions/:id`                 | owner, admin | 200 · 409 `suppression_locked` when reason is `unsubscribed` or `asked_not_to_contact` |

## Rules worth knowing

- `consentBasis` other than `none` can only be set by owner, admin or manager (rep → 403), and every
  change is written to the audit log as `contact.consent_changed`.
- Sessions: 14-day sliding expiry, 90-day absolute maximum.
- Login rate limits: 10 per account+IP and 50 per IP per 15 minutes; 30 per account per hour.

---

# Sprint 3 additions

## Configuration (API and worker)

| Env var                              | Purpose                                                                                                     | Default (dev / test)                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SECRETS_KEY`                        | 32-byte base64 key that seals mailbox credentials                                                           | fixed dev key (refused in production)                   |
| `UNSUBSCRIBE_SECRET`                 | HMAC secret for unsubscribe links                                                                           | fixed dev secret (refused in production)                |
| `MAIL_FROM`                          | Sender of Openline's own emails                                                                             | `Openline <no-reply@openline.local>`                    |
| `SMTP_URL`                           | SMTP server for Openline's own emails, e.g. `smtp://localhost:1025?requireTLS=false` (Mailpit)              | unset                                                   |
| `MAIL_TRANSPORT`                     | Openline's own emails: `smtp` \| `log` (print to console) \| `capture` (in memory, tests)                   | `log` in dev, `capture` in test, `smtp` in prod         |
| `OUTREACH_TRANSPORT`                 | Sequence emails: `real` (each mailbox) \| `sandbox` (everything to `SMTP_URL`) \| `capture`                 | `capture` unless set; `real` in prod                    |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | Gmail connection; when unset, Gmail endpoints return 501 `google_not_configured`                            | unset                                                   |
| `CONTACT_INBOX`                      | Inbox for website contact-form enquiries; required when `APP_ENV` is `staging` or `production`              | `hello@openline.example`                                |
| `RUN_SCHEDULER`                      | Run the sending engine inside the API process (needed with on-disk PGlite, which only one process can open) | `true` when `DATABASE_URL` is `pglite://`, else `false` |

## Account emails

| Method | Path                                            | Who       | Response                                                  |
| ------ | ----------------------------------------------- | --------- | --------------------------------------------------------- |
| POST   | `/v1/auth/verify-email` `{ token }`             | public    | 200 · 410 `token_invalid`                                 |
| POST   | `/v1/auth/resend-verification`                  | signed in | 200 (5/hour/user)                                         |
| POST   | `/v1/auth/forgot-password` `{ email }`          | public    | always 200 (no enumeration); rate-limited                 |
| POST   | `/v1/auth/reset-password` `{ token, password }` | public    | 200, ends ALL sessions of that user · 410 `token_invalid` |

- Sign-up sends a verification email (token valid 24 h). Reset tokens are valid 1 h, single use.
- `MeResponse.user.emailVerified`. Unverified users get 403 `email_not_verified` when connecting a
  mailbox, activating a sequence, or enrolling contacts.
- `POST /v1/invites` now also emails the invite link (the response still includes `inviteUrl`).

## Workspace settings

| Method | Path                                          | Who          | Response                                                                   |
| ------ | --------------------------------------------- | ------------ | -------------------------------------------------------------------------- |
| GET    | `/v1/workspace`                               | all          | `WorkspaceSettingsDto`                                                     |
| PATCH  | `/v1/workspace` `WorkspaceSettingsInput`      | owner, admin | `WorkspaceSettingsDto` (time zone validated)                               |
| PUT    | `/v1/workspace/plan-choice` `PlanChoiceInput` | owner, admin | `PlanChoiceDto`; audits `workspace.plan_choice_changed` (from/to plan ids) |

### Plan choice (no billing yet)

Every workspace is a 14-day trial (`plan: "trial"`, `trialEndsAt`). The plan a visitor picks on
/pricing (`?plan=solo|team|growth|scale&billing=monthly|annual`) is kept through sign-up and
sign-in: `SignupInput` takes optional `plan` and `billing` (billing defaults to `monthly`; billing
without a plan is a 400) and stores them as `workspaces.chosen_plan` / `chosen_billing`;
`MeResponse.workspace` returns `chosenPlan` / `chosenBilling` (null when none). The ids come from
`PLAN_IDS` / `BILLING_PERIODS` in `@openline/shared`. This is intent only: nothing is charged and
`plan` / `trialEndsAt` are never changed by it. The web app shows and changes it on
`/app/settings/billing`.

## Mailboxes

| Method | Path                                         | Who                          | Response                                                                                                        |
| ------ | -------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/mailboxes`                              | all                          | `MailboxDto[]` (never includes credentials)                                                                     |
| POST   | `/v1/mailboxes/smtp` `SmtpMailboxInput`      | all (verified)               | 201 `MailboxDto` after an SMTP login check · 400 `mailbox_auth_failed` / `mailbox_unreachable` · 409 `conflict` |
| GET    | `/v1/mailboxes/google/authorize`             | all (verified)               | `{ url }` · 501 `google_not_configured`                                                                         |
| GET    | `/v1/mailboxes/google/callback?code=&state=` | signed in (browser redirect) | 302 → `/app/settings/mailboxes?connected=gmail` or `?error=<code>`                                              |
| PATCH  | `/v1/mailboxes/:id` `MailboxUpdateInput`     | mailbox owner, owner, admin  | `MailboxDto`                                                                                                    |
| DELETE | `/v1/mailboxes/:id`                          | mailbox owner, owner, admin  | 200; its active and paused enrollments become `stopped` (`lastDecision: mailbox_removed`)                       |

The Google redirect URI is `${WEB_URL}/api/v1/mailboxes/google/callback`; `state` is HMAC-signed
(workspace, user, expiry 10 min).

## Sequences and enrollments

| Method | Path                                                | Who                                        | Response                                                                                                                                                                                    |
| ------ | --------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/sequences`                                     | all                                        | `SequenceDto[]` (archived hidden unless `?includeArchived=true`)                                                                                                                            |
| POST   | `/v1/sequences` `SequenceInput` (steps required)    | all                                        | 201 `SequenceDto` (status `draft`)                                                                                                                                                          |
| GET    | `/v1/sequences/:id`                                 | all                                        | `SequenceDto`                                                                                                                                                                               |
| PATCH  | `/v1/sequences/:id` `SequenceInput`                 | all                                        | `SequenceDto` · 409 `sequence_in_use` if replacing steps while it has active/paused enrollments · 403 if a rep replaces the steps of a non-draft sequence · 400 for unknown `{{variables}}` |
| POST   | `/v1/sequences/:id/status` `{ status }`             | owner, admin, manager                      | `SequenceDto` · 409 `mailing_address_required` · 409 `sequence_empty` (activating with no steps) · 409 `invalid_transition` · 403 `email_not_verified`                                      |
| POST   | `/v1/sequences/:id/preview` `{ contactId? }`        | all                                        | `{ steps: { position, subject, text, html }[] }`                                                                                                                                            |
| POST   | `/v1/sequences/:id/enroll` `EnrollInput`            | all (verified)                             | `EnrollResultDto` · 409 `sequence_not_active` · 403 if a rep uses someone else's mailbox · 409 `mailbox_not_active`                                                                         |
| POST   | `/v1/sequences/:id/enroll/preview` `{ contactIds }` | all                                        | `EnrollPreviewDto` (OL-E6): per contact `enrollable`, `skipReason?`, `compliance?`; nothing is enrolled                                                                                     |
| GET    | `/v1/sequences/:id/enrollments`                     | all                                        | `{ items: EnrollmentDto[], nextCursor }` (`?state=&cursor=&limit=`)                                                                                                                         |
| POST   | `/v1/enrollments/:id/action` `{ action }`           | all (reps: own mailbox's enrollments only) | `EnrollmentDto` (pause, resume, stop, mark_replied) · 409 `invalid_transition` · 403 if a rep acts on an enrollment sending from someone else's mailbox                                     |
| GET    | `/v1/contacts/:id/enrollments`                      | all                                        | `EnrollmentDto[]`                                                                                                                                                                           |
| GET    | `/v1/contacts/:id/messages`                         | all                                        | `MessageDto[]`                                                                                                                                                                              |

Sequence status transitions: `draft`/`paused` → `active` (needs ≥1 step, else 409 `sequence_empty`;
`archived` → `active` is 409 `invalid_transition`); `active` → `paused` (from any other state 409
`invalid_transition`); any → `archived` (its active and paused enrollments become `stopped` with
`lastDecision: sequence_archived`). Setting the current status again is a no-op.

Enrollment actions and the states they are allowed from (anything else is 409 `invalid_transition`):

| Action         | From                                     | To        | `lastDecision`    |
| -------------- | ---------------------------------------- | --------- | ----------------- |
| `pause`        | `active`                                 | `paused`  | `paused_by_user`  |
| `resume`       | `paused`                                 | `active`  | `resumed`         |
| `stop`         | `active`, `paused`, `error`              | `stopped` | `stopped_by_user` |
| `mark_replied` | `active`, `paused`, `completed`, `error` | `replied` | `marked_replied`  |

Stop reasons are reported in `lastDecision`; `lastError` is only for sending failures.

A contact can only ever be enrolled once per sequence (any state, including stopped or completed);
enrolling them again is skipped as `already_enrolled`. Re-enrolling is a future feature.

Enroll skips (never errors) contacts that are suppressed, unsubscribed, bounced, already enrolled,
or have no valid consent where the law requires it (Canada: CASL; EU/UK: GDPR basis). Jurisdiction
comes from the contact's country, else the email's country domain, else US.

## Consent records

| Method | Path                                      | Who                   | Response                                                                                                                   |
| ------ | ----------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/contacts/:id/consent`                | all                   | `ConsentDto` or `null` (latest record; `withdrawnAt` set once withdrawn)                                                   |
| PUT    | `/v1/contacts/:id/consent` `ConsentInput` | owner, admin, manager | `ConsentDto` — appends a `consents` row (history kept), updates `contacts.consent_basis`, audits `contact.consent_changed` |

Setting `consentBasis` other than `none` through POST/PATCH `/v1/contacts` now returns 400
`use_consent_endpoint` — consent needs a source and date.

## Unsubscribe (public, no session)

| Method | Path                            | Response                                                                                                                   |
| ------ | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/public/unsubscribe/:token` | `{ email (masked, j***@acme.com), workspaceName, alreadyUnsubscribed }` · 404                                              |
| POST   | `/v1/public/unsubscribe/:token` | 200. Accepts RFC 8058 one-click (`List-Unsubscribe=One-Click`, form-encoded) or JSON. No CSRF header required. Idempotent. |

Effects: contact `status = unsubscribed`, suppression added (reason `unsubscribed`, locked), all of the
contact's active/paused enrollments become `unsubscribed`, audit `contact.unsubscribed` (no actor).
Links in emails: footer → `${WEB_URL}/u/<token>` (web page with a confirm button);
`List-Unsubscribe` header → `<${WEB_URL}/api/v1/public/unsubscribe/<token>>`.

## Public website (OL-E5)

| Method | Path                 | Body               | Response                                                                                             |
| ------ | -------------------- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| POST   | `/v1/public/contact` | `ContactFormInput` | 202 `{ ok: true }` · 400 `validation_error` · 429 `rate_limited` · 503 `contact_unavailable` (retry) |

- No session, no CSRF header. Schema `ContactFormInputSchema` (`packages/shared/src/contact.ts`):
  `name` 1–100, `email` valid ≤ 254, `company?` ≤ 120, `teamSize?` one of `1`, `2-5`, `6-15`,
  `16-25`, `26+`, `message` 10–5000, `website?` (honeypot). Empty optional fields mean "not given".
- Honeypot: a non-empty `website` returns 202 `{ ok: true }` and nothing is sent (checked before
  validation, so bots never see field errors).
- Effect: one plain-text email to `CONTACT_INBOX`, subject `Website enquiry from <name>` (control
  characters and links removed, ≤ 78 characters), `Reply-To` = the visitor's address. Nothing is
  stored. Logs carry event names only (`contact.enquiry_sent`, `contact.honeypot_dropped`,
  `contact.enquiry_failed`), never the name, email or message.
- Rate limits: 5 per client IP per hour (honeypot hits included; the IP honours `TRUST_PROXY`) and
  3 per email address per day. In-memory, per API instance, like the other limiters.

## Sending engine (`packages/sequencer`, built by the lead)

```ts
import { createSequencer } from "@openline/sequencer";
const sequencer = createSequencer({ db, secretsKey, unsubscribeSecret, webUrl, google, outreach });
await sequencer.runOnce(50); // claim and process up to 50 due enrollments
sequencer.start(15_000); // poll every 15 s; sequencer.stop() on shutdown
```

`apps/worker` runs it in production; the API runs it in-process when `RUN_SCHEDULER=true`.

## Scout (Sprint 4)

Scout drafts, the rep decides: every draft is an `ai_actions` row in `proposed`; nothing is sent
or applied by Scout. Types: `ScoutSettingsDto`, `AiActionDto` and the input schemas in
`packages/shared/src/scout.ts`. Model access: ADR 0005.

| Method | Path                            | Who                                  | Body                                                                                     | Response                                                                                                   |
| ------ | ------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/workspace/scout`           | all                                  | —                                                                                        | `ScoutSettingsDto` (settings, `providerConfigured`, `available`, this month's `usage`)                     |
| PATCH  | `/v1/workspace/scout`           | owner, admin                         | `{ enabled?, monthlyCredits?, webResearch?, aboutUs?, valueProposition? }` (`""` clears) | `ScoutSettingsDto`; audits `workspace.scout_updated` (switches/budget values, text field names only)       |
| POST   | `/v1/scout/drafts/first-touch`  | all                                  | `{ contactId, purpose, sequenceId?, stepPosition? }`                                     | 201 `AiActionDto` (`draft_email`, subject + body + citations) · 404 contact/sequence                       |
| POST   | `/v1/scout/drafts/reply`        | all (reps: replies to own mailboxes) | `{ messageId, instructions? }` (an inbound message)                                      | 201 `AiActionDto` (`draft_reply`, body + citations, no template variables) · 404                           |
| GET    | `/v1/scout/actions/:id`         | creator, manager+                    | —                                                                                        | `AiActionDto` · 404 (other reps' drafts look missing)                                                      |
| POST   | `/v1/scout/actions/:id/approve` | creator                              | `{ finalText?, finalSubject? }` (edited; omit = as proposed)                             | 200 `AiActionDto` `approved` with `finalText`, `editDistance` · 403 not creator · 409 `invalid_transition` |
| POST   | `/v1/scout/actions/:id/reject`  | creator                              | `{ reason? }` (≤ 500 chars)                                                              | 200 `AiActionDto` `rejected` · 403 · 409 `invalid_transition`                                              |

Errors on draft endpoints, checked in this order: 503 `ai_unavailable` (`AI_PROVIDER=off` or the
provider is down after one retry) · 429 `rate_limited` (30 drafts per user per hour,
`SCOUT_DRAFTS_PER_USER_PER_HOUR`) · 403 `scout_disabled` (turned off for the workspace) · 429
`ai_budget_exceeded` with `details.resetsAt` (monthly credits used up; 1 credit = 1,000 tokens,
months are UTC calendar months) · 422 `ai_invalid_output` (the model's answer was invalid twice).
Tokens spent on a failed draft still count.

**Citations ("cite or stay silent").** `proposal.citations` is `[{ claim, source }]`; `source` is
an id from `sources`: a contact field (`contact.firstName`, `contact.title`, `contact.company`,
`contact.country`, `company.domain`), a fetched page URL, or `message.inbound` (their email). A
citation to anything not in the input is dropped; if the text still makes that claim the answer is
invalid. First-touch drafts may use `{{firstName}}`-style variables (same list as sequence steps);
unknown variables make the answer invalid.

**Website research** (`research` in the DTO: `fetched` | `cached` | `failed` | `off` | `none`): up
to 3 pages of the contact's company domain (`/`, plus `/about`/`/about-us` and
`/products`/`/services` when the home page links to them), https on port 443 only, private
addresses refused outside development/test, connection pinned to the checked address (TLS still
verifies the host name), redirects only within the same domain and its subdomains (max 3, each
re-checked), 5 s and 1 MB per page, cached 7 days per workspace + domain (failures too). Turned off
with `webResearch: false`. Page text, contact fields and inbound emails reach the model only
inside `wrapUntrusted()` fences under `UNTRUSTED_DATA_RULE`.

Audit: `scout.action_proposed`, `scout.action_approved` (`edited`, `editDistance`),
`scout.action_rejected` (`hasReason`) — ids, counts and flags only, never email text.

`packages/ai` also exports `classifyReply(provider, { text, subject, from })` (small model,
fenced, zod-validated, retry once → `other`) for the reply pipeline, and `createProvider()`.
When a provider call throws after an earlier attempt, the `AiError` carries the tokens already
spent in `details.usage` (they count to the budget). A draft citing any source that wasn't
provided is invalid (retry once, then 422 `ai_invalid_output`).

## Replies and inbox (Sprint 4)

Configuration (API and worker): `REPLY_SYNC_INTERVAL_MS` (default `120000`, min `10000`) — how
often each mailbox is checked. Reply sync runs in the API with `RUN_SCHEDULER=true` (PGlite) and in
`apps/worker` otherwise. With `AI_PROVIDER` set, replies are classified by Scout's small model when
the workspace has Scout on and credits left (usage recorded in `ai_usage` as `classify_reply`);
otherwise, and after two invalid model answers, by keyword rules (`labelSource: "rule"`).
`REPLY_CLASSIFY_DAILY_CAP` (default `200`) caps model classifications per mailbox per UTC day;
classification may also use at most 50 % of the month's Scout credits. Beyond either cap the
keyword rules decide. Each sync has one deadline for reading and processing (30 s); it stops at the
last processed message, keeps the cursor there and is due again at once. Gmail messages over 2 MB
(`sizeEstimate`) are never downloaded: they are matched by their headers and stored with the body
"[message too large to show — open it in Gmail]".

`MailboxDto` gains `replyDetection` (`off` | `on` | `error`), `lastSyncedAt`, `lastSyncError`.
`MessageDto` (contact timeline) gains `direction` (`outbound` | `inbound`).

| Method + path                               | Who                                 | Notes                                                                                                                                                                                     |
| ------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /mailboxes/:id/imap`                   | mailbox owner, owner/admin          | SMTP mailboxes. `{ host, port: 993 \| 143, username?, password? }` (both or neither; neither = SMTP login). Login verified first (SSRF rules as SMTP; 143 requires STARTTLS) → MailboxDto |
| `DELETE /mailboxes/:id/imap`                | same                                | Reply detection off (SMTP: IMAP settings and login forgotten; Gmail: just off) → MailboxDto                                                                                               |
| `GET /mailboxes/:id/google/reply-detection` | the mailbox's owner only            | Browser navigation: 302 to Google adding `gmail.readonly` (`include_granted_scopes`). Callback (`/mailboxes/google/callback`) → `?reply_detection=on` or `?error=…`                       |
| `GET /inbox`                                | rep (own mailboxes), manager+ (all) | `?label=&mailboxId=&needsAction=true\|false&cursor=&limit=` (1–100, default 50). Default = needs action (unhandled interested/referral/not_now/other) → `{ items, nextCursor }`           |
| `GET /inbox/counts`                         | same                                | `{ needsAction, byLabel }` (unhandled replies)                                                                                                                                            |
| `GET /inbox/:id`                            | same                                | InboxMessageDto: `text` (plain text — never render as HTML), `original`, `enrollment`, `referral`, `replies`, `openUrl`                                                                   |
| `PATCH /inbox/:id`                          | same                                | `{ label?, handled? }`. Label → `labelSource: "user"`. To `unsubscribe` applies the suppression; changing it back never removes one                                                       |
| `POST /inbox/:id/reply`                     | same                                | `{ body }` (1–10,000 chars) → 201 InboxMessageDto. Threaded (`In-Reply-To`, `References`, `Re:`), same mailbox, compliance footer; marks the reply handled                                |

Errors: 409 `reply_detection_unavailable` (provider can't), 400 `imap_auth_failed` /
`imap_unreachable`, 400 `imap_credentials_required` (the SMTP login is reused only by the
mailbox's own user, or for an IMAP host on the SMTP host's registrable domain — anyone else must
send `username` + `password`), 409 `unsubscribed` / `bounced` / `suppressed` / `no_consent` /
`mailing_address_missing` / `mailbox_unavailable` / `contact_missing` (reply), 409
`reply_not_allowed` (reply to a bounce report, an auto-submitted message or a mailer-daemon /
no-reply sender), 502 `send_failed`.
Another workspace's message, an outbound message, or (for reps) another person's mailbox → 404.

Reply effects (`packages/replies`, idempotent by `(mailbox_id, Message-ID)`): human reply → every
active/paused enrollment of the contact `replied` (`reply_received`); out-of-office → stays active,
`nextRunAt` = business day after the return date (else +7 days, never earlier); 5.x.x bounce
naming a message we sent, for the contact's own address → contact + enrollments `bounced`, then
the >3 % auto-pause check (4.x.x ignored; address-only reports are not stored); unsubscribe → same
as the link. Unmatched mail is not stored and never reaches a model. The engine also refuses to send
a step when a human reply arrived after the last step. Audit: `mailbox.reply_detection_on|off`,
`reply.received`, `reply.relabelled`, `reply.handled`, `reply.sent` (ids, labels, counts only).

# Sprint 5 additions

## Tasks (OL-E6 §1)

Types: `TaskDto`, `TaskCountsDto` and the input schemas in `packages/shared/src/tasks.ts`
(migration 0009). Reps see and edit their own tasks (others' look like 404); managers and above
see everyone's and may assign/reassign to a workspace member. Tasks are closed, never deleted;
deleting the contact deletes its tasks. "Today", "overdue" and "upcoming" (the 7 days after today)
use the workspace time zone.

| Method + path                 | Who                         | Body / query                                                                                              | Response                                                                     |
| ----------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /v1/tasks`               | all (`scope=all`: manager+) | `?scope=mine\|all&status=open\|done\|dismissed&due=overdue\|today\|upcoming\|none\|any&contactId=&limit=` | `TaskDto[]` by due date (undated last) · 403 `forbidden` (rep + `scope=all`) |
| `GET /v1/tasks/counts`        | all                         | —                                                                                                         | `{ overdue, dueToday, upcoming }` (my open tasks)                            |
| `GET /v1/tasks/:id`           | owner, manager+             | —                                                                                                         | `TaskDto` · 404                                                              |
| `POST /v1/tasks`              | all                         | `{ title (≤200), notes? (≤2000), dueAt?, kind?, contactId?, companyId?, ownerId? }`                       | 201 `TaskDto` · 403 assigning as a rep · 404 contact/company/member          |
| `PATCH /v1/tasks/:id`         | owner, manager+             | `{ title?, notes?, dueAt?, kind?, contactId?, ownerId? (manager+), suggestDone?: false }`                 | `TaskDto` · 409 `task_closed`                                                |
| `POST /v1/tasks/:id/complete` | owner, manager+             | —                                                                                                         | 200 `TaskDto` `done` (repeat = no-op) · 409 `task_closed` if dismissed       |
| `POST /v1/tasks/:id/dismiss`  | owner, manager+             | —                                                                                                         | 200 `TaskDto` `dismissed` (repeat = no-op) · 409 `task_closed` if done       |

`TaskDto` flags: `overdue` (open, past due), `dueSoon` (open, due within 24 h), `dueDateMissing`
(the promise named no date), `suggestDoneAt` (the rep replied in the promise's thread afterwards:
"Looks like you sent it — mark done?"; `PATCH { suggestDone: false }` hides it). Audit:
`task.created|updated|completed|dismissed` (kind, source, field names; never titles or notes).

## Promise Keeper (OL-E6 §2)

After reply detection stores a human reply (not a bounce, auto-reply, machine mail or unsubscribe)
and after a rep sends an inbox reply, Promise Keeper runs in the background (never blocks or fails
the sync or the send) and stores each commitment as a proposed `ai_actions` row of kind `promise_task` (a follow-up task).
Promise Keeper never proposes pausing enrollments; the `pause_enrollments` kind is a legacy value
that is never created, listed or accepted.
Scout's small model when the workspace has Scout on and credits left (≤ 25 % of the month's
credits, ≤ `REPLY_CLASSIFY_DAILY_CAP` per mailbox per day; spend in `ai_usage` as
`extract_promises`), else a rule-based extractor. Dates are resolved in code (`resolveWhen` in
`packages/ai`), never by the model: our promise → end of that business day (17:00; a weekend day
rolls back to Friday), a week/month/quarter → its first business day 10:00 ("next week" → Monday
10:00); their request → first business day of the period 10:00; their promise → the business day
after their period, 10:00; no date → +2 business days, `dueDateMissing`. Weeks are Monday–Sunday,
numeric dates month/day, quarters calendar quarters; holidays are not modelled.

| Method + path                   | Who                                  | Body / query                                                         | Response                                                                                                                                    |
| ------------------------------- | ------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/promises`              | mailbox owner (reps), manager+ (all) | `?status=proposed\|accepted\|dismissed&contactId=&messageId=&limit=` | `PromiseProposalDto[]` newest first                                                                                                         |
| `POST /v1/promises/:id/accept`  | mailbox owner, manager+              | `{ title?, dueAt? }` (edits)                                         | 200 `{ promise, task }` · repeat = same result · 404 · 409 `invalid_transition` (dismissed) · 409 `unsupported_proposal` (legacy pause row) |
| `POST /v1/promises/:id/dismiss` | mailbox owner, manager+              | `{ reason? }` (≤ 500)                                                | 200 `PromiseProposalDto` `dismissed` · repeat = no-op · 409 `invalid_transition` (accepted)                                                 |

Accept `promise_task` creates the task for the mailbox owner (`source: promise`, the source message,
`promiseId`). Accepting a legacy `pause_enrollments` row returns 409 `unsupported_proposal` and
changes nothing (it can still be dismissed). Proposals are not
reachable through `/v1/scout/actions` (404). Audit: `promise.proposed` (counts),
`promise.accepted`, `promise.dismissed` (kind, type, edited flags; no email text, no reason).
Evaluation: `pnpm --filter @openline/ai eval:promises` over `packages/ai/eval/promises.jsonl`.

## Compliance Copilot (OL-E6)

One deterministic engine, `evaluateEmailContact(input, at)` in `packages/compliance`
(`RULESET_VERSION`), answers "can I email this contact?" for the sending engine, inbox replies, the
enroll dialog and the contact page. Never an LLM. Each answer is `{ decision, nextAllowedAt?,
jurisdiction, evaluatedAt, rulesetVersion, checks }`; `decision` is `blocked` if any check fails,
else `not_now` if any check waits (`nextAllowedAt` = next business-hours start), else `allowed`.
Each check: `{ rule, outcome: pass|fail|wait|not_applicable, detail, citation, warning? }`.

| Rule (`rule`)           | Fails / waits when                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `suppression`           | the address or its `@domain` is on the suppression list, or the address is malformed                 |
| `contact_status`        | unsubscribed, bounced, archived (archived passes for inbox replies); n/a when not a saved contact    |
| `consent_ca`            | Canada (CASL): no express/implied consent, withdrawn, or implied consent expired (warns within 30 d) |
| `basis_eu`              | EU/UK (GDPR): no lawful basis recorded, or withdrawn                                                 |
| `sender_identity`       | the workspace has no postal address                                                                  |
| `unsubscribe_mechanism` | never (Openline adds it to every email); recorded for proof                                          |
| `send_window`           | outside the contact's business hours (`wait`); unknown time zone (`fail`); n/a for inbox replies     |

| Method + path                                   | Who                   | Response                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/contacts/:id/compliance?channel=email` | all                   | `ContactComplianceDto`: the evaluation now + `settings` used (time zone and its source, send window, `mailingAddressOnFile`) · `&sequenceId=` uses that sequence's window · `&purpose=reply` (default `send`) evaluates an inbox reply: `send_window` not applicable, archived contacts allowed (400 with `sequenceId`)   |
| `GET /v1/contacts/:id/compliance/record`        | owner, admin, manager | `ComplianceRecordDto` as a download (`Content-Disposition: attachment`, `Cache-Control: no-store`): contact, consent history, suppression state, audit history for the contact, every outbound email (`id, kind, status, sentAt, subject, proof`), current evaluation. Audits `contact.compliance_exported` (counts only) |
| `POST /v1/sequences/:id/enroll/preview`         | all                   | see Sequences; `counts: { enrollable, skipped, blocked }`                                                                                                                                                                                                                                                                 |

Errors: 400 `validation_error` (channel other than `email`, bad ids), 404 `not_found` (contact or
sequence in another workspace), 403 `forbidden` (record export by a rep).

**Proof.** Every outbound email stores the evaluation that allowed it in `messages.compliance_proof`
(migration 0010; immutable once written; no body, no address): sequence steps (all rules) and inbox
replies (`send_window` not applicable). Emails sent before 0010 have `proof: null` in the export.

**Same outcomes as before.** The engine maps the checks to the same `lastDecision` codes, in the
same order: `unsubscribed` / `bounced` / `contact_archived` → `suppressed` → `no_consent` (the
check's detail in `lastError`) → `mailing_address_missing` (defers 1 h) → mailbox checks →
`outside_send_window`. Enroll keeps its skip reasons and order; compliance skips (`unsubscribed`,
`bounced`, `suppressed`, `no_consent`) now carry `compliance: { decision, nextAllowedAt?, check }`.

# Sprint 6 additions

## Pipeline and deals (OL-E7 §1–3)

Types and schemas: `packages/shared/src/deals.ts` (migration 0011). One pipeline per workspace.
Every role reads every deal; reps change only deals they own (someone else's deal: 403
`forbidden`), managers and above change all; another workspace's deal, stage, contact or company is 404. Money is integer minor units: `amountMinor` (≤ 999 999 999 999) + ISO 4217 `currency`
(defaults to the new workspace setting `currency`, `PATCH /v1/workspace { currency }`, default
`USD`). Dates (`expectedCloseDate`, `nextStepDate`) are `YYYY-MM-DD`.

| Method + path                 | Who                              | Body / query                                                                                                                                                                                              | Response                                                                                                                                                                      |
| ----------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/pipeline/stages`     | all                              | —                                                                                                                                                                                                         | `PipelineStageDto[]` in board order (`dealCount` each)                                                                                                                        |
| `PUT /v1/pipeline/stages`     | owner, admin                     | `{ stages: [{ id?, name (≤40), probability 0–100, kind open\|won\|lost, staleAfterDays (1–365 \| null, default 14), entryCriteria ≤5 [{ label, evidence }] }] }`                                          | Array order = board order; stages left out are archived · 400 duplicate names, not exactly one won + one lost, open stages not first · 404 unknown id · 409 `stage_has_deals` |
| `GET /v1/deals`               | all                              | `?stageId=&ownerId=<id>\|me&contactId=&companyId=&status=open\|won\|lost\|all&stale=1\|0&flagged=1\|0&closeFrom=&closeTo=&q=&cursor=&limit=` (≤500, def 200)                                              | `{ items: DealDto[], nextCursor }` newest first                                                                                                                               |
| `GET /v1/deals/summary`       | all                              | `?ownerId=<id>\|me`                                                                                                                                                                                       | `DealSummaryDto`: per-stage `columns` and `forecast { open, thisMonth, thisQuarter }`                                                                                         |
| `GET /v1/deals/attention`     | all (`mine=0`: manager+)         | `?mine=1\|0&limit=` (≤100)                                                                                                                                                                                | `{ items: DealDto[] }` open deals that are stale or past their next-step date, oldest activity first (Today)                                                                  |
| `POST /v1/deals`              | all (`ownerId` ≠ self: manager+) | `{ name (≤120), companyId?, primaryContactId?, contactIds? (≤20 incl. primary), ownerId?, stageId? (open; default first), amountMinor?, currency?, expectedCloseDate?, nextStep? (≤200), nextStepDate? }` | 201 `DealDetailDto` · 400 `stage_closed` · 404 contact/company/stage/member                                                                                                   |
| `GET /v1/deals/:id`           | all                              | —                                                                                                                                                                                                         | `DealDetailDto` (+ `contacts`, `stageHistory`)                                                                                                                                |
| `PATCH /v1/deals/:id`         | owner of the deal, manager+      | any create field except `stageId`; `ownerId` manager+; `contactIds` replaces the set; `lostReason` only while lost                                                                                        | `DealDetailDto` · 409 `deal_not_lost`                                                                                                                                         |
| `POST /v1/deals/:id/move`     | owner of the deal, manager+      | `{ stageId, lostReason? }`                                                                                                                                                                                | 200 `DealDetailDto` · 400 `lost_reason_required` · same stage = no-op                                                                                                         |
| `GET /v1/deals/:id/timeline`  | all                              | —                                                                                                                                                                                                         | `{ items: DealTimelineItemDto[] }` newest first (≤200): `email`, `stage_change`, `task`, `edit`                                                                               |
| `GET /v1/contacts/:id/deals`  | all                              | —                                                                                                                                                                                                         | `DealDto[]` (the contact is on the deal) · 404                                                                                                                                |
| `GET /v1/companies/:id/deals` | all                              | —                                                                                                                                                                                                         | `DealDto[]` · 404                                                                                                                                                             |

**Rules.** Moving to the won or lost stage sets `closedAt` (lost needs `lostReason`); moving back
to an open stage clears `closedAt` and `lostReason`. Each move adds a `deal_stage_history` row
(append-only; creation is the first row, `from: null`) and an audit record. Stages with deals can't
be archived or change kind. New workspaces get Discovery 10 %, Qualified 25 %, Proposal 50 %,
Negotiation 75 %, Won 100 %, Lost 0 %.

**Activity and flags on `DealDto`.** `lastActivityAt` = latest of: deal created/edited, stage
change, a task on the deal completed, and any email (sent or received; not an unsent reservation)
with any of the deal's contacts — the email part is read from `messages` at query time.
`isStale`: open and `now − lastActivityAt` strictly greater than the stage's `staleAfterDays` × 24 h.
`nextStepOverdue` / `closeDateOverdue`: open and the date is before today in the workspace time
zone (not on the day itself). `missingNextStep`: open, past the first open stage, no next step.
`flagged=1` = any of these four, or an undismissed model flag (`criterion_missing`,
`stage_ahead_of_evidence`) of the deal's latest Reality Check while the deal is still in the stage
it was checked in. `flagCount` counts the same (four booleans + those model flags).
`canEdit` tells the UI whether the caller may edit/move.

**Summary math.** Per stage and per forecast bucket: `count` (all deals), and per currency
`amountMinor` and `weightedMinor` = round half up of Σ(amount × probability) / 100, rounded once
per bucket (not per deal). Top-level `amountMinor` / `weightedMinor` are in the workspace currency
only; other currencies are listed in `byCurrency` (no conversion) and `multiCurrency: true`.
`thisMonth` / `thisQuarter`: open deals whose `expectedCloseDate` falls in the current calendar
month / quarter of the workspace time zone.

**Timeline visibility.** Everyone sees email subject, direction and date. Inbound `snippet` (≤200,
plain text) only for the caller's own mailboxes (managers: all), as in the inbox; outbound bodies
aren't stored (`snippet: null`). Task titles only for the task's owner and managers.

**Related changes.** Tasks: `dealId` on create/update/`TaskDto`, `GET /v1/tasks?dealId=`.
Inbox: `InboxMessageDto.dealPrefill { name: "<Company> — new deal", contactId, companyId,
openDeals }` for "Create deal". Audit: `deal.created|updated|moved` (ids, kinds, field names; never
names, next steps or reasons), `pipeline.stages_updated` (counts).

## Pipeline Reality Check (OL-E7 §4)

Types and schemas: `packages/shared/src/reality.ts` (migration 0013). Runner:
`packages/replies/src/reality.ts` (`createRealityChecker`, shared by the API and the worker);
evidence + rules: `packages/ai/src/reality.ts`.

| Method + path                                            | Who                         | Body                 | Response                                                                               |
| -------------------------------------------------------- | --------------------------- | -------------------- | -------------------------------------------------------------------------------------- |
| `POST /v1/deals/:id/reality-check`                       | owner of the deal, manager+ | —                    | 200 `RealityCheckDto` · 429 `rate_limited` (10 manual runs per deal per UTC day)       |
| `GET /v1/deals/:id/reality-check`                        | all                         | —                    | `{ check: RealityCheckDto \| null }` (latest run)                                      |
| `POST /v1/deals/:id/reality-check/flags/:flagId/dismiss` | owner of the deal, manager+ | `{ reason (1–300) }` | 200 `RealityCheckDto` · 400 bad id/reason · 404 flag not in the latest check           |
| `POST /v1/deals/:id/reality-check/suggestion/accept`     | owner of the deal, manager+ | —                    | 200 `{ deal: DealDetailDto, check }` · 404 no open suggestion · 409 `suggestion_stale` |
| `POST /v1/deals/:id/reality-check/suggestion/dismiss`    | owner of the deal, manager+ | `{ reason? (≤300) }` | 200 `RealityCheckDto` · 404 no open suggestion                                         |

Another workspace's deal is 404 everywhere; someone else's deal for a rep is 403 (`forbidden`).

**A run.** Evidence = emails (both directions; bodies exist for inbound only, quoted history
trimmed) with the deal's contacts from the last 90 days (newest 30, ≤ 30k characters), the
contacts' names and job titles and the deal's next step, all fenced as untrusted. The small model
answers per evidence type; code keeps a quote only if it is verbatim (whitespace-normalised, 8–300
characters) in the message it names, otherwise the type is `unclear`. `assessDeal` (code) then
computes the evidence stage and flags: `criterion_missing`, `stage_ahead_of_evidence` (model) and
`next_step_overdue`, `no_next_step`, `close_date_passed`, `stale` (deterministic). Won/lost deals
get no flags and no model call.

**Deterministic only** (`deterministicOnly: true`, `deterministicReason`): `scout_off`,
`no_provider` (AI_PROVIDER=off), `budget` (month's credits used up, or the Reality Check's own
spend this month ≥ 25 % of them), `no_emails`, `model_error` (failed or invalid twice; never an
error response). Spend is recorded in `ai_usage` as feature `reality_check`.

**Stored.** One `deal_checks` row per run (append-only): evidence (`present`, quote ≤ 300,
messageId — no other email text), all flags, evidence stage, the deal's stage at the time, model,
tokens, trigger (`manual` | `scheduled`). Flag ids are stable per code + criterion.

**Quotes are private like the timeline.** A quote is returned only if its message is still on the
deal and the caller is a manager+ or owns the mailbox it came through; otherwise the item carries
`quoteHidden: true` (and `messageId`) without the words.

**Dismissals.** "Not right — …" stores a `deal_flag_dismissals` row (append-only, feeds the
evaluation set); the flag comes back with `dismissed { reason, at, by }` and drops out of
`flagged` / `flagCount` until there is activity on the deal after the dismissal. Dismissing
`stage_ahead_of_evidence` also withdraws the suggestion. Audit: `deal.reality_flag_dismissed` (flag
id + code, no reason text).

**Suggestion.** "Move to <evidence stage>" is an `ai_actions` row of kind `deal_stage_move`
(owner = the deal's owner), at most one open per deal: refreshed when a new run suggests the same
move, replaced (old one `rejected`, superseded) when it suggests another, closed when it suggests
none. Accept = proposed → executed in one transaction through the normal move (history row,
`deal.moved` audit with `viaRealityCheck: true`, plus `ai.stage_move_accepted`); if the deal moved
since the check it is 409 `suggestion_stale`. A dismissed move (`ai.stage_move_dismissed`) isn't
proposed again until there is new activity. Nothing ever moves on its own.

**Schedule.** The worker (and the API with `RUN_SCHEDULER=true`) polls every 5 minutes;
`claim_due_reality_checks(batch)` (openline_scheduler, ids and timestamps only, 10-minute lease)
returns open deals not checked in the last 24 h (manual runs count) that have activity since their
last check. Same budget gate as above; one failing deal never stops the batch or other jobs.
