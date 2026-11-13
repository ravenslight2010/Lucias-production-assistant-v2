# WP7 — Hardening, tests, and CI

## Local baseline

- Frozen install passed with `corepack pnpm@9.15.9`.
- Workspace typecheck and build passed; build used the CI values
  `PORT=4173 BASE_PATH=/`.
- V2 web tests: 77 passed.
- API tests: 96 passed, including disposable-PostgreSQL integration tests.
- Development pilot verification: passed against a fresh disposable local
  PostgreSQL database. It checks opening inventory counts, planned-run
  non-deduction, count-based usage refresh, quality attention, and restart
  persistence.
- Workspace build passed after the dashboard change; only the existing
  large-client-chunk advisory remains.
- `git diff --check` passed for the documentation changes.

## Remaining

GitHub Actions has not run on these changes, and no changes were pushed or
published. The disposable pilot test does not verify Replit VM overlap or
external sign-in providers. Keep CI's PNPM 9 toolchain aligned with the patched
lockfile; the workspace's bare PNPM 10.26.1 fails the frozen install. The
signed-in browser journey remains unverified in this turn.
