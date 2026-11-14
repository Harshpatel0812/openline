## What and why

Closes OL-<id>. One-paragraph summary.

## How to test

1. ...

Preview link: <auto>

## Checklist

- [ ] Tests added/updated (bug fix = failing test first)
- [ ] `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test` pass locally
- [ ] Migration is expand-only or reversible; new tenant tables have an RLS policy
- [ ] No secrets, tokens or personal data in code or logs
- [ ] Feature flag: <name or n/a>
- [ ] Docs / PRD / help article updated

## Risk

Low / Medium / High — why. Touches auth, billing, sending, compliance or migrations? → needs a
second reviewer.
