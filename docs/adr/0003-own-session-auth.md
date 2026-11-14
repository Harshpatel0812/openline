# ADR 0003: First-party email/password auth with server-side sessions

Date: 2026-11-13 Status: Accepted

## Context

The plan named Clerk or Auth.js. A hosted auth provider puts user identity outside our database and
region, adds a per-user cost, and cannot be reached from sandboxed build environments. Our needs for
the MVP are simple: email + password, workspaces with roles, invites. Google/Microsoft sign-in is
needed later because users connect those mailboxes anyway.

## Decision

Build first-party auth in `apps/api/src/modules/auth`:

- Passwords: scrypt (N=2^15, r=8, p=1, 16-byte salt, 64-byte key), parameters stored with each hash
  so they can be raised later. Minimum 12 characters, maximum 200 (caps hashing cost).
- Sessions: 256-bit random token in an httpOnly, SameSite=Lax cookie (`__Host-` prefixed and Secure
  in production); only the SHA-256 of the token is stored. 14-day sliding expiry.
- CSRF: mutating requests must carry `x-openline-csrf: 1` (cannot be sent cross-site without a CORS
  preflight, and CORS allows only our web origin).
- Login: same error and similar timing for unknown email vs wrong password (dummy hash), rate limits
  per account+IP and per IP.
- Invites: 256-bit token, hash stored, 7-day expiry, single use (atomic claim).
- Every security-relevant action is written to the append-only audit log.

## Consequences

- Identity data stays in our database and region; no per-user auth fees.
- We own the security of this code: it has dedicated tests and is in scope for every security review
  and the external pen test.
- Follow-ups: email verification and password reset (Sprint 3, needs a mail provider), Google and
  Microsoft OAuth sign-in (Sprint 2–3), 2FA (v1), Redis-backed rate limiting when the API runs on
  more than one instance, breached-password check (k-anonymity API) when outbound network is allowed.
