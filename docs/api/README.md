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
