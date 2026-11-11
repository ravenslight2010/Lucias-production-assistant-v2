# GitHub automation (V2)

| Workflow | Purpose |
|----------|---------|
| `ci.yml` | Typecheck, build, unit/API tests, prod dependency audit |
| `api-integration.yml` | DB run-control suite (expand as integration coverage grows) |
| `dependabot.yml` | Weekly npm + GitHub Actions updates |

Kept intentionally smaller than V1. Add browser/e2e, Docker, or release lanes only when those surfaces exist in V2.
