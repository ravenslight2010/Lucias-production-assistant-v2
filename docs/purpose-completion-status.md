# V2 purpose-completion status

Last checked: 2026-11-13  
Scope: purpose-first V2 production planning and execution. Synthetic or approved
fixtures only; no V1 credentials, sessions, database, or production data.

Workbook priority is user-confirmed: product specs → dough → cheese → sauce →
mix/premix → shipping → schedule. Schedule rows dated before the import date can
be ignored.

| Work package | Status | Current evidence and remaining acceptance |
|---|---|---|
| WP0 — Repo hygiene and status docs | **Complete** | Product status is corrected below. PNPM 9.15.9 frozen install, typecheck, build, and web/API tests pass locally. See [WP0 notes](evidence/purpose-completion/WP0-notes.md). |
| WP1 — Day-plan import | **Partial** | Product and process importers, name cleanup/merge, schedule-to-planned-run flow, and reviewed requirement snapshots exist. Synthetic signed-in browser regressions cover product snapshots and schedule imports, but they have not been run in this turn; see [WP1 notes](evidence/purpose-completion/WP1-notes.md). |
| WP2 — Station execution | **Partial** | Shared line timer, station status, revision-checked counts, and station-level preparation-pull status exist. Source pull instructions are visible but not individually confirmable; source-to-station mapping, retries, and two-session floor verification remain. |
| WP3 — Live production math | **Partial** | Run detail uses captured requirements and station progress for remaining demand. Lowest reported case count per area, exact shared-batch totals, and no-guessed-value behavior have tests; imported family golden fixtures and live-refresh acceptance remain. |
| WP4 — Inventory from production | **Partial** | Facility inventory, adjustments, and run-level actual-use confirmation exist. Integration coverage verifies stale-stock protection, confirmed deductions, retry safety, double-deduction prevention, and correction links. Opening-count and planned-only behavior still need explicit acceptance coverage. |
| WP5 — Run-tied quality checks | **Partial** | Run-level ounce measurements, customer tolerances, finished-weight ranges, and unresolved-applicator blocking exist and are unit-tested. Signed-in recording and dashboard response to failed/unresolved checks still need end-to-end verification. |
| WP6 — Dashboard coherence | **Partial** | Dashboard shows run totals, active timers, station-area counts, station preparation status, planned runs, and recent activity. The dashboard card preview was checked at phone, tablet, and desktop widths; quality failures and review-required imports are not yet surfaced there. |
| WP7 — Hardening and CI | **Partial** | Local typecheck, build, and web/API test suites pass. GitHub Actions on the resulting changes has not been run; preserve the PNPM 9 lockfile format and require CI before pushing or publishing. |

## WP0 — Repo hygiene and truth in docs

- [x] Updated `replit.md` to distinguish implemented, partial, and unverified behavior.
- [x] Added this checklist and a WP0 verification note.
- [x] Confirmed GitHub `main` was already up to date at the task baseline.
- [x] Verified the frozen install with the lockfile-compatible PNPM 9.15.9.
- [x] Ran workspace typecheck, workspace build, and web/API tests.

## WP1 — Day-plan import (P0)

- [x] Product-spec, dough, cheese, sauce, premix, shipping, name-library, and schedule import paths are present.
- [x] Schedule imports create planned runs with reviewed requirement snapshots; test coverage includes retry and source-selection safeguards.
- [x] Unfamiliar applicator rows can be reviewed before their quality tolerance is used.
- [x] Synthetic authenticated browser regressions cover product-profile import → planned-run snapshot and schedule import → planned-run/history/replay.
- [ ] Run those regressions in the authenticated browser harness with a fresh synthetic V2 account.
- [ ] Confirm batch warnings, review state, run/profile links, and user-visible errors across the full apply flow in that run.

## WP2 — Station execution (P0/P1)

- [x] Station state and elapsed time follow the shared production-line timer.
- [x] Run detail exposes revision-checked produced/completed counts, count-based remaining demand, and station-level preparation-pull status.
- [ ] Connect source-backed pull instructions to individually confirmable checklist items only where the source data supports a reliable station mapping; otherwise retain the review-only reference.
- [ ] Complete any stage actions supported by the V2 data model and verify update retries across two browser contexts.
- [ ] Verify duplicate retries and cross-session refresh against a disposable database.

## WP3 — Live production math (P1)

- [x] Run detail separates saved run requirements from progress derived from station counts.
- [ ] Add/confirm golden cases for dough, sauce, cheese, tray, and batch calculations represented by the supported fixtures.
- [ ] Prove that confirmed count changes update live results and that missing state never yields guessed values.

## WP4 — Inventory from confirmed production (P1)

- [x] Facility inventory and run-level actual-use review/confirmation screens and APIs exist.
- [ ] Verify physical opening count and audited corrections.
- [ ] Verify confirmed run/station use changes on-hand balances, while imported or planned-only runs do not.
- [ ] Retain links from inventory transactions to the confirming run/station event.

## WP5 — Minimal run-tied quality checks (P2)

- [x] Quality checks use the run snapshot, customer-specific limits, and unresolved states for unreviewed applicators.
- [ ] Exercise in-range, out-of-range, unresolved, permission, and completed-run behavior through the signed-in UI.
- [ ] Confirm dashboard attention state for failed or unresolved checks.

## WP6 — Dashboard coherence and UX

- [x] Home/dashboard summary pages exist.
- [x] Active-run cards summarize station preparation counts from shared progress state.
- [x] Development-only dashboard card preview checked at phone, tablet, and desktop widths.
- [ ] Verify operator versus manager next actions and truthful active/blocked/done state.
- [ ] Surface quality failures and any persisted import-review queue.
- [ ] Verify the signed-in dashboard and any quality/import attention indicators at phone width.

## WP7 — Hardening, tests, and CI

- [x] Workspace typecheck, build, and web/API test suites pass locally with the supported toolchain.
- [x] Frozen install succeeds with PNPM 9.15.9, which matches the patched lockfile format.
- [ ] Run GitHub CI after the next change set and require Typecheck, Build, Unit/API tests, and lockfile checks to pass.
- [ ] Run the signed-in core journey without bypassing Clerk or facility authorization.

## Pilot boundary

The separate-project Reserved VM pilot remains unverified. Continue with synthetic
or approved fixtures and the disposable V2 database until the operator handoff
and pilot sign-off criteria are met.
