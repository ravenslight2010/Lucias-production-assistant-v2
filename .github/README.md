# GitHub automation (V2)

| Workflow | Purpose |
|----------|---------|
| `ci.yml` | Typecheck, build, unit/API tests, prod dependency audit |
| `api-integration.yml` | DB run-control suite |
| `codegen-check.yml` | OpenAPI → Orval generated clients must match git |
| `dependency-review.yml` | PR dependency vulnerability/license review |
| `codeql.yml` | CodeQL JS/TS analysis (push/PR + weekly) |
| `lockfile.yml` | pnpm-only lockfile + frozen install |
| `auto-merge.yml` | Auto-enable squash auto-merge for same-repo non-draft PRs (majors from Dependabot still manual) |
| `dependabot.yml` | Weekly npm + GitHub Actions updates (grouped) |

## Auto-merge behavior

- Every **non-draft** PR from **this repository** (not forks) gets **squash auto-merge** enabled automatically.
- Merge only completes after **required checks** on `main` are green and the branch is up to date.
- **Dependabot major** version bumps are left for a human.
- Fork PRs are never auto-merged.

## Repo settings (optimized)

- **Auto-merge** enabled — green PRs can merge without a second click
- **Delete branch on merge** enabled
- **`main` protection** — requires Typecheck, Build, Unit and API tests, lockfile check; must be up to date
- **Dependabot security updates** + vulnerability alerts on
- **Secret scanning** + push protection on
- **Private vulnerability reporting** on
- Admins are **not** blocked by branch protection (can hotfix if needed)

Kept smaller than V1. Add browser/e2e or Docker lanes when those surfaces exist.
