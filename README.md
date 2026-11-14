# Openline

The outreach CRM that keeps you out of spam, out of trouble, and true to your word.

> Private repository. Proprietary and confidential.

## Quick start (5 minutes)

Prerequisites: Node 22 (`nvm use`), pnpm 10 (`corepack enable`), Docker.

```bash
pnpm install
cp .env.example .env
pnpm services:up      # Postgres, Redis, Mailpit
pnpm build
pnpm dev              # web on :3000, api on :4000
```

Check it works:

- http://localhost:3000 — product app
- http://localhost:4000/health — API health
- http://localhost:4000/v1/compliance/send-window?timeZone=America/New_York
- http://localhost:8025 — Mailpit (every local email lands here)

## Everyday commands

| Command                             | What it does                                     |
| ----------------------------------- | ------------------------------------------------ |
| `pnpm lint`                         | ESLint across the repo                           |
| `pnpm format` / `pnpm format:check` | Prettier                                         |
| `pnpm typecheck`                    | TypeScript in every package                      |
| `pnpm test`                         | Unit + integration tests (Vitest)                |
| `pnpm build`                        | Build all packages and apps                      |
| `pnpm e2e`                          | Playwright end-to-end tests (after `pnpm build`) |

## Structure

See [CLAUDE.md](CLAUDE.md#repo-map) for the full map, and [docs/onboarding.md](docs/onboarding.md)
for a new developer's first day.

## CI/CD

| Workflow             | When                           | What                                                                                                         |
| -------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `ci.yml`             | Every PR and push to `main`    | Lint, format, typecheck, tests (with Postgres + Redis), build, Prisma validate, SAST, secret scan, e2e smoke |
| `deploy-staging.yml` | Merge to `main` (once enabled) | Build images → ECR → Terraform → deploy → smoke test                                                         |
| `deploy-prod.yml`    | Manual, with approval          | Promote the exact staging image to production                                                                |

Deploys stay off until the repository variable `DEPLOY_ENABLED` is set to `true` and the AWS
roles exist (see `infra/terraform/README.md`).

## Repository settings to turn on (one-time, in GitHub)

- Branch protection on `main`: require PR, 1 approval, CI green, linear history, no force-push.
- Environment `production` with Harsh as required reviewer.
- Secret scanning + push protection, Dependabot alerts.
- 2FA required for every member of the GitHub organisation/account.

## Security

See [SECURITY.md](SECURITY.md). Report vulnerabilities to security@ — never in a public issue.
