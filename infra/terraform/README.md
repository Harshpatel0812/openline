# Infrastructure (Terraform)

All cloud changes go through Terraform — no clicking in the AWS console.

```text
infra/terraform/
├─ modules/            Reusable building blocks (network, ecs-service, rds, redis, s3, secrets)
└─ envs/
   ├─ dev/             Separate AWS account
   ├─ staging/         Separate AWS account, deployed on merge to main
   └─ prod/            Separate AWS account, deployed only after manual approval
```

## Status

Week 0 skeleton. Region is a required variable and is **not decided yet** — set it in each
environment's `terraform.tfvars` (copy from `terraform.tfvars.example`). Modules are filled in during
Week 0 / Sprint 1 (epic OL-E1).

## Rules

- Remote state in S3 with locking; one state per environment.
- CI authenticates with GitHub OIDC — no long-lived AWS keys anywhere.
- Every resource is tagged `project=openline`, `env=<env>`.
- Databases and Redis live in private subnets only; nothing data-bearing is public.
