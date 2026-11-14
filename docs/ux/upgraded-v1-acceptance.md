# Upgraded-V1 experience acceptance

This checklist tracks the requested experience against the current V2 code.
“Implemented” means the code path exists; it does not imply the published
separate-project pilot or signed-in floor workflow has been verified.

## Work packages

| Package | Status | Evidence / remaining verification |
|---|---|---|
| U1 — Day cockpit and app shell | Implemented | Today shows active and queued runs, station count coverage, preparation readiness, quality attention, and recent completions. The nav prioritizes Today, Live run, Stations, Imports, Inventory, then Run queue and manager tools. The focused run is remembered locally and exposed on operational routes. Import-review and stock-shortage badges are not yet part of the dashboard API contract. |
| U2 — Live run workspace | Implemented in code; floor verification open | Run detail keeps the run timer and station counts tied to the server's shared line lifecycle, includes preparation pulls, current requirements, quality checks, and inventory-use confirmation, and now offers quick section navigation. Verify the full station lineup, retry after a network failure, and two signed-in sessions refreshing the same run. |
| U3 — Run strip and multi-run awareness | Implemented | Active and planned runs are visible together. Selecting a run updates the persistent focus; the selection survives route changes and browser reloads. The current summary response limits planned and recent runs, so very large day queues still need a dedicated queue view. |
| U4 — Operational imports | Partial | Imports remain in the operational shell and schedule review filters out earlier dates while preserving source review. A successful schedule import now links to the run queue. Verify the whole real-workbook-to-run path with the uploaded fixtures; a shared upload/review/apply stepper and direct links to each created run remain. |
| U5 — Inventory as a production surface | Partial | Inventory has opening stock and audited adjustments; run detail shows proposed use, shortages, and explicit confirmation before a stock deduction. Verify confirmed production updates balances and history across sessions. A cockpit stock badge is not in the current dashboard summary. |
| U6 — Quality in the flow | Partial | Quality measurements are run-tied, and the cockpit displays failed or unresolved checks. Verify a failed and an unresolved check through the signed-in import-to-run-to-dashboard flow. |
| U7 — Industrial visual system | Partial | The cockpit has dedicated compact operational styling, prominent counts, explicit state colors, and responsive layouts. Extend shared tokens and complete contrast/accessibility review across existing manager, import, inventory, and station screens. |
| U8 — Feedback and trust | Implemented in code; live retry verification open | Run commands and station updates use revisions and idempotency; stale revisions show a conflict and refresh; offline controls are disabled; successful commands show saved state. Exercise real network loss and retry behavior on two sessions. |
| U9 — Dense-screen performance | Partial | Dashboard and run data refresh at the existing five-second interval and station lineup input is bounded by the API. Verify a facility's full lineup and large requirement plan on a floor tablet; virtualization is not currently implemented. |

## Development-only visual check

Open `/__visual-preview/day-cockpit` to inspect the cockpit with synthetic
active, planned, completed, station-progress, preparation, and quality data.
This route does not call the API or save changes. The cockpit and persistent
run strip were visually checked at phone (402 × 874), tablet (768 × 1024), and
desktop (1440 × 1000) sizes.

## Verification recorded for this change

- V2 TypeScript typecheck passed.
- V2 tests passed: 89 importer, planning, lifecycle, and UI-logic tests.
- Production PWA build checks passed: 2 tests.
- The dev-only cockpit preview was visually checked at phone, tablet, and desktop sizes.
- Signed-in multi-session browser checks and the separate-project production
  pilot remain unverified. Use synthetic/disposable V2 data only until those
  checks are explicitly completed.
