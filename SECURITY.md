# Security policy

Openline holds access to customers' mailboxes. Security is a launch requirement, not a feature.

## Reporting a vulnerability

Email **security@openline** (address to be set up in Week 0) with steps to reproduce. Do not open a
public issue. We acknowledge within 1 business day and keep you updated until it is fixed.

## Baseline controls in this repo

- Tenant isolation: workspace scoping in code + Postgres row-level security (`packages/db/prisma/rls.sql`).
- Secrets never committed (`.gitignore`, secret scanning in CI, GitHub push protection).
- Dependencies: lockfile, Dependabot, restricted install scripts (`onlyBuiltDependencies`).
- SAST (Semgrep) and dependency review on every pull request.
- Security headers on the web app; `x-powered-by` disabled on the API.
- AI guardrails: untrusted-content fencing and a human-approval state machine (`packages/ai`).
- Compliance checks are deterministic code with tests (`packages/compliance`).

The full security plan (threat model, controls by layer, incident response, disaster recovery)
lives in the Engineering Build Plan.
