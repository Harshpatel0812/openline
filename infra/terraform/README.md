# Infrastructure (Terraform)

All cloud changes go through Terraform — no clicking in the AWS console.

```text
infra/terraform/
├─ bootstrap/          One-time: state bucket, GitHub OIDC, deploy roles, Bedrock policy, budget
├─ modules/            Reusable building blocks (network, ecs-service, rds, redis, s3, secrets)
└─ envs/
   ├─ dev/             Developer sandbox
   ├─ staging/         Deployed on merge to main
   └─ prod/            Deployed only after manual approval
```

## Status

- Region: **us-east-1 (N. Virginia)**, the default in every environment.
- `bootstrap/` is ready: Harsh runs it once, following `docs/runbooks/aws-setup.md`.
- Staging and production start in **one AWS account**, separated by deploy roles, GitHub
  environments (production needs Harsh's approval) and name prefixes. Moving production to its own
  account (AWS Organizations) is planned before SOC 2 Type II.
- Environment modules (network, database, containers) come in the infrastructure sprint; until then
  `DEPLOY_ENABLED` stays off.
- CI runs `terraform fmt -check` and `terraform validate` on every pull request.

## Rules

- Remote state in S3 with locking; one state per environment.
- CI authenticates with GitHub OIDC — no long-lived AWS keys anywhere.
- Every resource is tagged `project=openline`, `env=<env>`.
- Databases and Redis live in private subnets only; nothing data-bearing is public.

## Database roles (required before the first production deploy)

The security review requires the API to connect as a role that owns nothing:

| Role                 | Login                 | Purpose                                                               |
| -------------------- | --------------------- | --------------------------------------------------------------------- |
| `openline_owner`     | yes (deploy job only) | Owns tables; runs `pnpm --filter @openline/db db:migrate`             |
| `openline_app`       | no                    | Created by migration 0001; `NOBYPASSRLS`; the privileges the app gets |
| `openline_api`       | yes (API + worker)    | `NOINHERIT`, member of `openline_app` only, owns nothing              |
| `openline_scheduler` | no                    | Created by migration 0005; owns only `claim_due_enrollments()`        |

```sql
CREATE ROLE openline_api LOGIN NOINHERIT NOBYPASSRLS PASSWORD '<from Secrets Manager>';
GRANT openline_app TO openline_api;
```

In production `AUTO_MIGRATE` defaults to `false`; migrations run as a one-off task with the owner role.
The API must only be reachable from the web proxy and load balancer inside the VPC (it trusts
`X-Forwarded-For` only from private networks). Set `TRUST_LB_FORWARDED_FOR=true` on the web service.

## Environment variables that decide who gets emailed

The image is built once with `NODE_ENV=production` and promoted from staging to production, so
NODE_ENV can't tell them apart. **Every deployed service must set `APP_ENV`** — the API and worker
refuse to start without it.

| Variable                    | staging                                      | production         |
| --------------------------- | -------------------------------------------- | ------------------ |
| `APP_ENV`                   | `staging`                                    | `production`       |
| `OUTREACH_TRANSPORT`        | unset (→ sandbox if inbox set, else capture) | unset (→ `real`)   |
| `OUTREACH_SANDBOX_SMTP_URL` | the staging Mailpit / catch-all inbox        | unset              |
| `ALLOW_REAL_SENDING`        | **never set**                                | unset (not needed) |
| `SMTP_URL`                  | Openline's own mail (verification etc.)      | same               |

`SMTP_URL` is never used for prospect email outside development/test, because in staging and
production it is a real provider that would deliver to the prospect. Mailbox SMTP hosts on private
or loopback addresses are refused outside development/test, and every send re-checks the address.
