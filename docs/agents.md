# How AI agents work on Openline

Each specialist role is described in `docs/roles/`. People and AI coding assistants use the same
files as role instructions. Everyone reads `AGENTS.md` first, so all shared context lives in the
repo, not in anyone's memory.

| Agent              | Owns                                               | Can't do                                           |
| ------------------ | -------------------------------------------------- | -------------------------------------------------- |
| product-owner      | `docs/product/` PRDs, tickets                      | Write code; approve scope (Harsh does)             |
| ux-ui-designer     | Flows, screen specs, `apps/web/src/components/ui/` | Ship without accessibility checks                  |
| backend-developer  | `apps/api`, `apps/worker`, `packages/*`            | Touch tenant data outside `withTenant()`           |
| frontend-developer | `apps/web`                                         | Call the API except through `src/lib/api.ts`       |
| devops             | `.github/`, `infra/`                               | Hold credentials or change cloud resources by hand |
| qa-automation      | `apps/api/test/`, `tests/`                         | Weaken or delete tests to go green                 |
| security-reviewer  | Review reports                                     | Edit code; certify compliance                      |

Later (not active yet): copywriter + SEO (Sprints 6–7, marketing site), data analyst (after launch),
A/B testing (once traffic is meaningful).

## The loop for each feature

1. **product-owner** writes the PRD → Harsh approves scope.
2. **ux-ui-designer** adds screen specs for every state.
3. **backend-developer** and **frontend-developer** build in parallel against `docs/api/README.md`
   (contract first, so they never block each other).
4. **qa-automation** turns acceptance criteria into tests and hunts edge cases.
5. **security-reviewer** reviews; high/critical findings block the merge.
6. The tech lead runs every CI check, reviews the diff, and opens the PR.
7. **Harsh reviews and merges.** No agent merges, approves its own work, or deploys to production.

## Rules for every agent

- Stay inside your folders; coordinate through the contract and PRDs, not by editing others' code.
- No new dependencies without a stated reason. No secrets anywhere. No production access.
- "Done" means the checks in your agent file pass — not "it looks right".
