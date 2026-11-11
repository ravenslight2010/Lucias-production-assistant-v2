# GitHub automation (V2)

| Workflow | Purpose |
|----------|---------|
| `ci.yml` | Typecheck, build, unit/API tests, prod dependency audit |
| `api-integration.yml` | DB run-control suite |
| `codegen-check.yml` | OpenAPI → Orval generated clients must match git |
| `dependency-review.yml` | PR dependency vulnerability/license review |
| `codeql.yml` | CodeQL JS/TS analysis (push/PR + weekly) |
| `lockfile.yml` | pnpm-only lockfile + frozen install |
| `dependabot.yml` | Weekly npm + GitHub Actions updates |

Kept smaller than V1. Add browser/e2e, Docker, or release lanes only when those surfaces exist in V2.
