# Openline

The outreach CRM that keeps you out of spam, out of trouble, and true to your word.

Openline is for B2B sales teams of 2–25 reps: contacts, email sequences that follow the law by
default, a reply inbox, and **Scout**, an assistant that drafts and checks instead of just sending
more. Every price, limit and rule is published; compliance (CAN-SPAM, CASL, GDPR) is built in
rather than bolted on.

## What works today

| Area                        | Status      | Highlights                                                                                                                                      |
| --------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts and teams          | ✅ Sprint 1 | Sign-up, email verification, password reset, workspaces, roles (owner, admin, manager, rep), invites, audit log                                 |
| Contacts                    | ✅ Sprint 2 | Contacts and companies, CSV import with a preview of duplicates and errors, suppression list, consent records                                   |
| Sending                     | ✅ Sprint 3 | SMTP and Gmail mailboxes, multi-step sequences, business hours in the contact's time zone, daily caps, bounce auto-pause, one-click unsubscribe |
| Replies and Scout v1        | 🚧 Sprint 4 | Reply detection that stops sequences, labelled reply inbox, Scout drafts with sources and human approval                                        |
| Pipeline, calling, CRM sync | Planned     | See the product plan                                                                                                                            |

Every data table is isolated per workspace with Postgres row-level security, and real email is only
ever sent from production (`APP_ENV=production`).

## See it live (GitHub Codespaces)

No install needed: GitHub runs Openline for you in the cloud.

1. On the repository page click **Code → Codespaces → Create codespace on main**.
2. Wait 3–5 minutes the first time while it installs and builds. A terminal then shows
   `Starting Openline at https://…-3000.app.github.dev` and the app opens in a new browser tab
   (if it doesn't, open the **Ports** tab and click the globe next to port 3000).
3. Sign up. The verification link is printed in that terminal (`[mail:verify_email]`).

The link works only for you while you're signed in to GitHub (to share it, set port 3000 to
Public in the Ports tab). A codespace stops after 30 minutes without use; open it again from
**Code → Codespaces** and your data is still there. GitHub's free plan includes a monthly
allowance of codespace hours; stop or delete codespaces you aren't using.

## Run it on your computer

You need **Node.js 22** (from [nodejs.org](https://nodejs.org)) and **pnpm 10** (`corepack enable`,
or `npm install -g pnpm`). Docker is not needed. Works on Windows, macOS and Linux.

Clone into a normal folder (on Windows, for example your user folder — not `C:\Windows\System32`):

```bash
git clone https://github.com/Harshpatel0812/openline.git
cd openline
pnpm install
pnpm build
pnpm dev
```

`pnpm dev` **keeps running**: leave that terminal window open (closing it or pressing Ctrl+C stops
Openline). When it shows `Ready` and `Found 0 errors` (30–60 seconds the first time):

1. Open **http://localhost:3000/signup** and create your workspace.
2. Verify your email. Locally, emails are printed in the terminal instead of sent: find the line
   starting `[mail:verify_email]` and open its link.

The local database lives in `apps/api/.data/` and is created automatically; delete that folder to
start fresh.

**"localhost refused to connect"** means `pnpm dev` isn't running or hasn't finished starting. Start
it and wait for `Ready`.

Optional: `pnpm services:up` starts real Postgres, Redis and Mailpit with Docker (every local email
then lands in Mailpit at http://localhost:8025). Point `DATABASE_URL` in `.env` at Postgres to use
it; `.env.example` lists every setting.

## Everyday commands

| Command                             | What it does                                     |
| ----------------------------------- | ------------------------------------------------ |
| `pnpm dev`                          | Web app on :3000 and API on :4000, live reload   |
| `pnpm lint`                         | ESLint across the repo                           |
| `pnpm format` / `pnpm format:check` | Prettier                                         |
| `pnpm typecheck`                    | TypeScript in every package                      |
| `pnpm test`                         | Unit and integration tests (Vitest)              |
| `pnpm build`                        | Build all packages and apps                      |
| `pnpm e2e`                          | Playwright browser journeys (after `pnpm build`) |

Before opening a pull request, run `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`;
CI runs the same checks.

## How the code is organised

```text
apps/web            Product UI (Next.js 15, React 19, Tailwind 4)
apps/api            REST API (NestJS) under /v1
apps/worker         Background jobs: the sending engine and reply sync
packages/shared     Types, Zod schemas and constants shared by every app
packages/db         SQL migrations with row-level security, Drizzle schema
packages/compliance Deterministic rules: send windows, consent, suppression
packages/email      SMTP and Gmail adapters, unsubscribe headers, secret sealing
packages/sequencer  The sending engine
packages/ai         Scout: model providers, untrusted-content fencing, approvals
infra/              Terraform, Dockerfiles, docker-compose
docs/               PRDs, architecture decisions, API contract, runbooks, sprint reviews
tests/e2e           Playwright journeys
```

Start with [AGENTS.md](AGENTS.md) — the project's rules, stack and current status — then
[docs/onboarding.md](docs/onboarding.md). Also useful:

- [docs/api/README.md](docs/api/README.md): the API contract
- [docs/adr/](docs/adr/): architecture decisions and why
- [docs/product/](docs/product/): feature specs (PRDs)
- [docs/sprints/](docs/sprints/): what each sprint shipped
- [docs/agents.md](docs/agents.md) and [docs/roles/](docs/roles/): how work is split between roles

## CI/CD

| Workflow             | When                           | What                                                                                                                                                                          |
| -------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`             | Every pull request and `main`  | Lint, format, typecheck, tests (Postgres and Redis), build, tenant isolation on real Postgres, dependency audit, Semgrep, secret scan, browser journeys, local dev on Windows |
| `deploy-staging.yml` | Merge to `main` (once enabled) | Build images → ECR → Terraform → deploy → smoke test                                                                                                                          |
| `deploy-prod.yml`    | Manual, with approval          | Promote the exact staging image to production                                                                                                                                 |

Deploys stay off until the repository variable `DEPLOY_ENABLED` is `true` and the AWS roles exist
(see `infra/terraform/README.md`).

### Repository settings to turn on (one-time, in GitHub)

- Branch protection on `main`: require a pull request, 1 approval, CI green, linear history, no
  force-push.
- Environment `production` with Harsh as required reviewer.
- Secret scanning with push protection, and Dependabot alerts.
- 2FA for every member.

## Security

See [SECURITY.md](SECURITY.md). Report vulnerabilities privately as described there, never in a
public issue.

## License

[Apache License 2.0](LICENSE).
