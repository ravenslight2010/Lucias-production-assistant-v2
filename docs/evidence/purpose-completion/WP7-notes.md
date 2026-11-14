# WP7 — Hardening, tests, and CI

## Local baseline

- Frozen install passed with `corepack pnpm@9.15.9`.
- Workspace typecheck and build passed; build used the CI values
  `PORT=4173 BASE_PATH=/`.
- V2 web tests: 83 passed.
- API tests: 97 passed, including disposable-PostgreSQL integration tests and
  the source-independent run-math golden case.
- Development pilot verification: passed against a fresh disposable local
  PostgreSQL database. It checks opening inventory counts, planned-run
  non-deduction, count-based usage refresh, quality attention, and restart
  persistence.
- Workspace build passed after the dashboard change; only the existing
  large-client-chunk advisory remains.
- `git diff --check` passed for the documentation changes.

## Remaining

GitHub Actions had not run on that historical changeset, and no changes were
pushed or published at the time. The disposable pilot test does not verify
Replit VM overlap or external sign-in providers. The PNPM 9 toolchain notes in
this historical verification were superseded on 2026-11-13 by the coordinated
PNPM 10.26.1 migration across the manifest, lockfile, CI, and setup script. The
signed-in browser journey remains unverified in that turn.
