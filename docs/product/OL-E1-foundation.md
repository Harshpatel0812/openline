# PRD: Foundation — accounts, workspaces, roles and team invites

Epic: OL-E1 Sprint: S1 Owner: Harsh Status: Draft

## Problem

Every Openline customer is a team of 2–25 reps, and every later feature (contacts, sequences,
inbox, Scout) needs to know who the user is, which workspace they act in and what they may do.
Small teams trying an outreach tool today either share one login (no record of who sent what,
which matters the day a recipient complains or a regulator asks) or pay per seat for people who
only look. A team should be able to sign up, bring in teammates with the right role and trust that
no other customer can ever see their data. Without this, nothing else can ship.

## Goal and success metric

A founder can create a workspace and get teammates working in it within minutes, with each
person's actions attributable and every workspace's data walled off.

Metric: at least 50% of new workspaces have a second member who accepted an invite within 7 days
of sign-up (measured from `workspace.created` and `invite.accepted` audit events).

## User stories and acceptance criteria

- As a founder, I want to sign up with my name, email, password and a workspace name, so that my
  team has its own space in Openline.
  - [ ] Given I am logged out, when I submit sign-up with a name, a valid email, a 12+ character
        password and a workspace name, then one account, one workspace and one membership with
        role `owner` are created in one transaction, a session cookie is set and I land in the
        app shell showing the workspace name.
  - [ ] Given I enter a password of 11 characters (or more than 128), when I submit sign-up or
        invite accept, then nothing is created and I see "Use 12 to 128 characters." Spaces and
        any Unicode characters are allowed; there are no composition rules.
  - [ ] Given an account already exists for `Jane@Acme.com`, when someone signs up with
        `jane@acme.com`, then no second account is created (emails compare case-insensitively)
        and the form shows "We couldn't create an account with these details. If you already
        have one, log in." (see Open questions on enumeration at sign-up).
- As a user, I want to log in and out, so that only I can act as me.
  - [ ] Given a valid email and password, when I log in, then a new session is created (any
        pre-login session id is discarded), the cookie `__Host-ol_session` is set with
        `HttpOnly; Secure; SameSite=Lax; Path=/` and an absolute expiry 14 days from login, and
        I land in the workspace I used last.
  - [ ] Given an unknown email, or a known email with a wrong password, when I log in, then the
        response is the same 401 `{ code: "invalid_credentials", message: "Email or password is
incorrect." }` and the response time does not differ measurably (a dummy scrypt hash is
        computed for unknown emails).
  - [ ] Given 5 failed logins for the same email from the same IP within 15 minutes (or 20 for
        that email from any IP within 1 hour, or 50 from one IP within 1 hour), when another
        attempt arrives, then it is rejected with 429 `rate_limited` "Too many attempts. Try
        again in 15 minutes." without checking the password, whether or not the account exists.
  - [ ] Given I am logged in, when I click Log out, then the session row is revoked, the cookie
        is cleared and replaying the old cookie returns 401.
  - [ ] Given my session is older than 14 days, when I make any request, then I get 401
        `session_expired` and the web app sends me to `/login?next=<path>`; `next` is honoured
        only if it is a relative path on our own app (no open redirect).
- As an owner or admin, I want to invite teammates by email with a role, so that they can join
  without sharing a password.
  - [ ] Given I am an owner or admin, when I invite `sam@acme.com` as `rep`, then a pending invite
        is created that expires in 7 days and is single-use, and the invite link is shown for me
        to copy (no email is sent until Sprint 3). Re-inviting the same pending email revokes
        the old link and issues a new one.
  - [ ] Given I am a `rep` or `manager`, when I call the invite endpoint directly, then the API
        returns 403 `forbidden` and no invite is created; the Invite button is not shown to me.
        Given I am an admin, when I invite someone as `owner`, then I also get 403: only owners
        can invite or promote to `owner`.
  - [ ] Given `sam@acme.com` is already a member of this workspace, when anyone invites that
        email, then the API returns 409 `already_member` "Sam is already in this workspace." and
        no invite is created.
- As an invited person, I want to accept the invite with a new or existing account, so that I can
  start working.
  - [ ] Given a valid invite for an email with no account, when I open the link, then I see the
        workspace name and role, the email is fixed to the invited address, and after I enter my
        name and password an account and membership are created and I am logged in.
  - [ ] Given a valid invite for an email that already has an account (for example, a member of
        another workspace), when I open the link, then I am asked to log in (or, if already logged
        in as that email, to confirm), and on success a membership in this workspace is added and
        it becomes my current workspace. If I am logged in as a different email, I see "This
        invite is for s\*\*\*@acme.com. Log out to accept it." and nothing changes.
  - [ ] Given an invite older than 7 days, when I open the link, then I see "This invite has
        expired. Ask your admin for a new one." and nothing is created. Given a used, revoked or
        unknown token, I see "This invite link is not valid." (one message for all three).
- As an owner or admin, I want to change roles and remove members, so that access matches who
  does what.
  - [ ] Given I am an owner or admin, when I change a member's role, then the new role applies to
        that member's very next request (roles are read from the database per request, not from
        the session) and an audit entry records before and after roles. Admins cannot change or
        remove owners.
  - [ ] Given I am an owner or admin, when I remove a member, then their membership is deleted,
        all their sessions in this workspace are revoked (next request returns 401), invites they
        created that are still pending are revoked, and contacts they owned stay in the workspace
        without an owner. If it was their only workspace, their next login shows a "No
        workspace" page with a Create workspace button.
  - [ ] Given the workspace has exactly one owner, when anyone tries to remove that owner or change
        their role, then the API returns 409 `last_owner` "A workspace needs at least one owner.
        Make someone else an owner first." This holds when two owners demote each other at the
        same moment (the owner count is checked under a row lock in the same transaction).
- As an owner or admin, I want a log of security-relevant actions, so that I can answer "who did
  this?".
  - [ ] Given any of these actions happens — sign-up, workspace created, login succeeded, login
        failed (known account only), logout, rate limit hit, invite created, invite revoked,
        invite accepted, role changed, member removed — then one `audit_log` row is written in the
        same transaction with actor, action, entity, before/after (no passwords, hashes or
        tokens), IP and user agent; owners and admins can view it newest-first in Settings →
        Security log (50 per page); the application role cannot update or delete rows.
- As a customer, I want my workspace's data walled off from every other customer, so that a bug
  cannot leak it.
  - [ ] Given two workspaces A and B, when a user of A requests any B resource by id (member,
        invite, audit entry), then the API returns 404; and given a query run as the application
        DB role with `app.workspace_id` set to A, then it returns zero rows from B, and with
        `app.workspace_id` unset it errors instead of returning data. A cross-tenant test exists
        for every tenant table.
  - [ ] Given a logged-in user, when a POST, PUT, PATCH or DELETE arrives without a valid
        `X-CSRF-Token` header bound to the session, or with an `Origin` header not on our allow
        list, then the API returns 403 `csrf_invalid` and changes nothing; sign-up, login and
        invite accept (no session yet) require a matching `Origin` and a pre-session CSRF cookie.

## Out of scope

- Google / Microsoft SSO (Sprint 2+).
- Email verification and password-reset emails (Sprint 3, needs a mail provider). Until then a
  forgotten password is reset by Harsh through a runbook, not a UI.
- Two-factor authentication (v1).
- Billing, plans and seat limits (Sprint 6).
- Creating extra workspaces from the app except from the "No workspace" page; leaving a workspace
  yourself; transferring or deleting a workspace; deleting an account.
- Changing your own name, email or password from the app.
- Record-level visibility rules for reps (in MVP reps see all records).

## Design

No mockups yet; built with `packages/ui`. Screens: Sign up, Log in, Accept invite (new account /
existing account / wrong account / expired / invalid states), No workspace, App shell (workspace
name, user menu with Log out, workspace switcher when the user has more than one membership),
Settings → Team (members with role dropdown and Remove, pending invites with Copy link and Revoke,
Invite dialog), Settings → Security log.

## Data, security and compliance

- New tables/columns (and their RLS policy) — **as built** in `packages/db/migrations/0001_init.sql`:
  - `users` — global identity (no `workspace_id`): `email` (lower-case, unique), `name`,
    `password_hash`. No RLS; only the auth and invite services read it.
  - `sessions` — global: `token_hash` (SHA-256 of a 256-bit random token; the raw token exists only
    in the cookie), `user_id`, `workspace_id` (active workspace), `ip`, `user_agent`, `expires_at`
    (14-day sliding expiry), `last_seen_at`.
  - `workspaces` — RLS: visible when it is the current workspace or one the current user belongs to.
  - `workspace_members` — `(workspace_id, user_id, role)`; RLS: current workspace, or the current
    user's own memberships (needed at login to pick a workspace).
  - `invites` — `email`, `role`, `token_hash`, `expires_at` (7 days), `accepted_at`, `revoked_at`;
    RLS: current workspace, or the holder of the token (via `app.invite_token_hash`).
  - `audit_log` — append-only (the app role has no UPDATE/DELETE).
  - Every tenant query runs in `withTenant()`: `SET LOCAL ROLE openline_app` (no BYPASSRLS) plus
    `app.workspace_id` / `app.user_id` from the session — never from the URL or body. No SECURITY
    DEFINER functions were needed.
  - Error codes as built: `invalid_credentials`, `rate_limited`, `unauthorized`, `forbidden`,
    `csrf`, `email_taken`, `already_member`, `last_owner`, `login_required`, `invite_used`,
    `invite_expired`, `invite_revoked`, `no_workspace`, `validation_error`.
- Permissions (enforced in the API on every request, the UI only hides buttons):
  owner — everything, including making or removing owners; admin — invite, change role, remove
  members except owners, view security log; manager — sees all records, no team management; rep —
  sees all records in MVP, no team management.
- Personal data touched, retention:
  - Our users' name, email, password hash, IP addresses and user agents (sessions, audit log).
  - Passwords: scrypt with a 16-byte random salt, N=2^15, r=8, p=1 (as built; parameters stored with the hash so they
    can be raised later), stored as `scrypt$N$r$p$salt$hash` so parameters can be raised and
    hashes upgraded at next login. Passwords never appear in logs, errors, audit rows or analytics.
  - Sessions: deleted 30 days after expiry or revocation. Rate-limit counters are in memory for the MVP (move to Redis
    when the API runs on more than one instance). Failed logins for unknown emails are not stored in `audit_log` (no
    workspace); the security log records a SHA-256 of the email and the IP, kept 30 days.
  - Audit log: kept for the life of the workspace, proposed 2 years maximum (see Open questions).
  - Pending invites: deleted 30 days after expiry; accepted/revoked invites kept 1 year for audit.
  - A removed member's account stays (it may belong to other workspaces); account deletion is out
    of scope and handled by request through a runbook.
- Threats considered (abuse, tenant leak, injection):
  - Tenant leak: RLS as a second wall (FORCE RLS, app role without BYPASSRLS, fail-closed when the
    setting is missing), 404 (not 403) for other workspaces' ids, cross-tenant tests per table,
    workspace id taken from the session only.
  - Credential stuffing / brute force: layered rate limits above, generic errors, equal timing.
  - Account enumeration: identical login errors; invite accept masks the invited email when a
    different user is logged in; sign-up remains a known gap until email verification (Sprint 3).
  - Session theft / fixation: httpOnly + Secure + `__Host-` cookie, new session id at login, token
    stored only as a hash, server-side revocation on logout and member removal.
  - CSRF: SameSite=Lax plus per-session token header and Origin check on all mutating requests.
  - Privilege escalation: role checks server-side; admins cannot touch owners; last-owner rule
    under a row lock; invite tokens are 256-bit random, single-use, 7-day expiry; a removed
    admin's pending invites are revoked.
  - Open redirect: `next` limited to relative in-app paths.
  - Injection / XSS: all input through Zod; parameterised queries only; workspace and user names
    rendered as text, max 100 characters.
  - DoS on hashing: password max 128 characters; scrypt memory bounded; sign-up limited to 5 per
    IP per hour.
- Legal rules involved (CAN-SPAM, TCPA, CASL, state privacy):
  - No outreach happens in this epic, so CAN-SPAM, TCPA and CASL do not apply to these features
    directly. The audit log is the base for later proof (who imported, who sent, who changed
    consent).
  - Our own users' data is personal data under US state privacy laws (e.g. CCPA/CPRA) and
    PIPEDA for Canadian users: the privacy policy must cover account data, IPs and the security
    log before the first external user signs up.

## Open questions

1. `CLAUDE.md` says Sprint 1 auth uses Clerk; this PRD builds our own email + password auth with
   scrypt as you described. Confirm we build in-house (and then `CLAUDE.md` needs updating), or
   switch this PRD to Clerk.
2. Sign-up cannot avoid revealing that an email has an account until email verification exists
   (Sprint 3). Accept that gap for Sprint 1, given the 5-per-hour sign-up limit?
3. Session expiry: absolute 14 days from login (as written), or 14 days of inactivity (sliding)?
4. Audit log retention: 2 years, or for the life of the workspace?
5. Should we also reject the 10,000 most common or known-breached passwords? It is cheap and NIST
   recommends it.
6. Should an admin be able to invite other admins, or only owners?
