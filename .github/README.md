# GitHub automation (V2)

| Workflow | Purpose |
|----------|---------|
| `ci.yml` | Typecheck, build, unit/API tests, prod dependency audit |
| `api-integration.yml` | DB run-control integration; fails visibly if PostgreSQL test prerequisites are missing |
| `codegen-check.yml` | OpenAPI → Orval generated clients must match git |
| `dependency-review.yml` | PR dependency vulnerability/license review |
| `lockfile.yml` | pnpm-only lockfile + frozen install |
| `auto-merge.yml` | Auto-enable squash auto-merge for same-repo non-draft PRs |
| `dependabot.yml` | Weekly npm + GitHub Actions updates (grouped) |

Code scanning uses **GitHub default CodeQL setup** (no duplicate workflow).

## Auto-merge behavior

- Every **non-draft** PR from **this repository** (not forks) gets **squash auto-merge** enabled automatically.
- Merge only completes after **required checks** on `main` are green and the branch is up to date.
- **Dependabot major** version bumps are left for a human.
- Fork PRs are never auto-merged.

## Repo settings (optimized)

- **Auto-merge** enabled
- **Delete branch on merge** enabled
- **`main` protection** — Typecheck, Build, Unit and API tests, lockfile, and Dependency review; must be up to date
- The DB run-control integration workflow is separate from required merge checks; a missing test prerequisite is reported as a failure, not a pass.
- Dependabot security updates + vulnerability alerts
- Secret scanning + push protection
