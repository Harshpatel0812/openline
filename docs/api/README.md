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

| Method | Path                                     | Who          | Response                                     |
| ------ | ---------------------------------------- | ------------ | -------------------------------------------- |
| GET    | `/v1/workspace`                          | all          | `WorkspaceSettingsDto`                       |
| PATCH  | `/v1/workspace` `WorkspaceSettingsInput` | owner, admin | `WorkspaceSettingsDto` (time zone validated) |

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

| Method | Path                                             | Who                                        | Response                                                                                                                                                                                    |
| ------ | ------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/sequences`                                  | all                                        | `SequenceDto[]` (archived hidden unless `?includeArchived=true`)                                                                                                                            |
| POST   | `/v1/sequences` `SequenceInput` (steps required) | all                                        | 201 `SequenceDto` (status `draft`)                                                                                                                                                          |
| GET    | `/v1/sequences/:id`                              | all                                        | `SequenceDto`                                                                                                                                                                               |
| PATCH  | `/v1/sequences/:id` `SequenceInput`              | all                                        | `SequenceDto` · 409 `sequence_in_use` if replacing steps while it has active/paused enrollments · 403 if a rep replaces the steps of a non-draft sequence · 400 for unknown `{{variables}}` |
| POST   | `/v1/sequences/:id/status` `{ status }`          | owner, admin, manager                      | `SequenceDto` · 409 `mailing_address_required` · 409 `sequence_empty` (activating with no steps) · 409 `invalid_transition` · 403 `email_not_verified`                                      |
| POST   | `/v1/sequences/:id/preview` `{ contactId? }`     | all                                        | `{ steps: { position, subject, text, html }[] }`                                                                                                                                            |
| POST   | `/v1/sequences/:id/enroll` `EnrollInput`         | all (verified)                             | `EnrollResultDto` · 409 `sequence_not_active` · 403 if a rep uses someone else's mailbox · 409 `mailbox_not_active`                                                                         |
| GET    | `/v1/sequences/:id/enrollments`                  | all                                        | `{ items: EnrollmentDto[], nextCursor }` (`?state=&cursor=&limit=`)                                                                                                                         |
| POST   | `/v1/enrollments/:id/action` `{ action }`        | all (reps: own mailbox's enrollments only) | `EnrollmentDto` (pause, resume, stop, mark_replied) · 409 `invalid_transition` · 403 if a rep acts on an enrollment sending from someone else's mailbox                                     |
| GET    | `/v1/contacts/:id/enrollments`                   | all                                        | `EnrollmentDto[]`                                                                                                                                                                           |
| GET    | `/v1/contacts/:id/messages`                      | all                                        | `MessageDto[]`                                                                                                                                                                              |

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
