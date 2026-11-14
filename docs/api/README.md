# Openline API contract (v1)

Base path `/v1` (health is `/health`). JSON only. Types and validation schemas live in
`packages/shared` and are shared by the API and the web app.

## Conventions

- **Auth:** session cookie (`ol_session` in dev, `__Host-ol_session` in production), httpOnly,
  SameSite=Lax. Every route needs a session unless marked public.
- **CSRF:** every POST/PATCH/DELETE must send header `x-openline-csrf: 1`, or it gets 403 `csrf`.
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
| DELETE | `/v1/members/:userId`                    | owner, admin, or self | 409 `last_owner`                                                                                                                                                                             |
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
