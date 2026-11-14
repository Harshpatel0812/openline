# Runbook: incident response

## Severity

| Level | Example                                                  | Response                                                    |
| ----- | -------------------------------------------------------- | ----------------------------------------------------------- |
| SEV1  | Data breach, platform down, emails sent wrongly at scale | Start within 15 min, all hands, customer notice within 24 h |
| SEV2  | Key feature broken for many customers                    | Start within 1 h, status page updated                       |
| SEV3  | Minor bug or one customer affected                       | Next business day                                           |

## The five steps

1. **Detect** — alert (Sentry, Grafana, GuardDuty) or report to support@ / security@.
   Open an incident channel and name an incident lead.
2. **Contain** — use kill switches: global send pause, per-workspace pause, per-mailbox pause,
   AI features off, new signups off, read-only mode. Revoke tokens if credentials may be exposed.
3. **Fix and recover** — roll back (redeploy previous image) or hotfix; restore data if needed
   (see `disaster-recovery.md`, to be written in Sprint 8).
4. **Communicate** — status page; email affected customers. For personal-data breaches, call the
   lawyer and notify regulators/customers within legal deadlines.
5. **Learn** — blameless post-mortem within 5 days in `docs/postmortems/`, action items as tickets.

## Kill switches

Implemented in Sprint 3 as feature flags + an admin endpoint. Document exact commands here when built.
