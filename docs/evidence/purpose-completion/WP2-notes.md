# WP2 — Station execution

## Existing behavior

- Station run status is derived from the production-line run lifecycle; all
  stations share the line timer rather than independent clocks.
- Run detail stores revision-checked `producedCount`, `completedCases`, and
  `preparationStatus` for each active facility station.
- Preparation states are `not_started`, `in_progress`, `ready`, and
  `not_required`.
- Imported preparation notes retain workbook, sheet, source row, and
  days-early information in the captured run requirements and render as
  preparation references.

## Existing test evidence

- `run-station-progress.test.mjs` covers timer-derived station states,
  lifecycle transitions, count validation, expected revisions, and response
  shape.
- `run-requirements-progress.test.mjs` verifies the lowest reported case count
  per matching area and that missing counts do not appear complete.
- `run-timer.test.mjs` checks running, paused, and completed elapsed-time
  behavior.
- The WP0 workspace test suites passed.

## Remaining

The current preparation selector confirms a station-level state, not each
imported pull instruction. No source-to-station mapping is assumed. Keep pull
notes review-only until the user confirms how operators should acknowledge
them; then add only mappings supported by source data. Cross-session UI
verification still requires the authenticated browser harness.
