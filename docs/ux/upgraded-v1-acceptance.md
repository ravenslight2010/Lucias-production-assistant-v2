# Upgraded-V1 experience acceptance

This checklist tracks the requested experience against the current V2 code.
“Implemented” means the code path exists; it does not imply the published
separate-project pilot or signed-in floor workflow has been verified.

## Work packages

| Package | Status | Evidence / remaining verification |
|---|---|---|
| U1 — Day cockpit and app shell | Implemented in code | Today shows active and queued runs, station count coverage, preparation readiness, quality attention, completions for the current production day, recent import batches, and a compact stock snapshot. A worker sweep finalizes unfinished runs at midnight America/Chicago even if nobody has the app open; dashboard and run requests provide an idempotent fallback. Those runs close as incomplete, retain their saved history, and do not carry into the new day. Draft batches need review and tracked balances below zero are flagged; the app does not invent low-stock thresholds. The focused run remains visible on operational routes. |
| U2 — Live run workspace | Implemented in code; signed-in floor verification open | Run detail keeps the run timer and station counts tied to the server's shared line lifecycle, includes preparation pulls, current requirements, quality checks, inventory-use confirmation, and quick section navigation. API and lifecycle tests pass. Verify live retry after a network failure and two signed-in sessions refreshing the same run. |
| U3 — Run strip and multi-run awareness | Implemented | Active and planned runs are visible together. Selecting a run updates the persistent focus; the selection survives route changes and browser reloads. The current summary response limits planned and recent runs, so very large day queues still need a dedicated queue view. |
| U4 — Operational imports | Implemented in code; signed-in apply verification open | Imports have Upload → Parse → Review → Apply → Runs created progress. Past schedule rows are excluded; source cells and row warnings remain reviewable. Schedule results link to each run and show its captured requirement summary. Uploaded workbook parser fixtures pass; verify apply and replay in a signed-in disposable facility. |
| U5 — Inventory as a production surface | Implemented in code; shared-session verification open | Inventory has opening stock and audited adjustments; run detail shows proposed use, shortages, and explicit confirmation before a stock deduction. Today shows tracked item count and below-zero balances without guessing thresholds. Verify confirmed updates and history across signed-in sessions. |
| U6 — Quality in the flow | Implemented in code; signed-in workflow verification open | Quality measurements are tied to runs, configured tolerances come from captured product requirements, and the cockpit displays failed or unresolved checks. API and tolerance logic tests pass; verify a failed and unresolved check through a signed-in run. |
| U7 — Industrial visual system | Implemented for cockpit and importer; broader contrast review open | The cockpit has shared density and status tokens, prominent counts, and responsive layouts. Cockpit and importer previews were checked at phone, tablet, and desktop sizes. Existing manager, inventory, and station screens still need a full contrast/accessibility pass. |
| U8 — Feedback and trust | Implemented in code; live retry verification open | Run commands and station updates use revisions and idempotency; stale revisions show a conflict and refresh; offline controls are disabled; successful commands show saved state. Automated lifecycle and retry-safety tests pass. Exercise real network loss and retry behavior on two signed-in sessions. |
| U9 — Dense-screen performance | Bounded in code; floor-device verification open | Dashboard refreshes every five seconds, station progress uses the existing ten-second refresh, and station layouts are capped at 50 entries. Verify a full facility lineup and large requirement plan on a floor tablet; the current cap does not require virtualization. |

## Development-only visual check

Open `/__visual-preview/day-cockpit` to inspect the cockpit with synthetic
active, planned, completed, station-progress, preparation, quality, recent
imports, and inventory data. Open `/__visual-preview/imports` to inspect the
review-step importer with synthetic product-spec data. These routes do not call
the API or save changes. Both were visually checked at phone and desktop sizes;
the cockpit was also checked at tablet size.

## Verification recorded for this change

- Workspace TypeScript typecheck passed.
- V2 tests passed: 89 importer, planning, lifecycle, and UI-logic tests; 2 production PWA build checks passed.
- API server tests passed: 101 tests, including schedule import tests against disposable PostgreSQL.
- The development-only cockpit preview was visually checked at phone (402 × 874), tablet (768 × 1024), and desktop (1440 × 1000); the importer preview was checked at phone and desktop sizes.
- The signed-in browser flow, two-session floor checks, and separate-project production pilot remain unverified. Use synthetic/disposable V2 data until those checks are completed.
