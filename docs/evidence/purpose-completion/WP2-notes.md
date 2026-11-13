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
  preparation references. The run snapshot also carries each early-pull row as
  an individually identified item, preserving source workbook/sheet/row and
  column when available.
- Pull status is stored separately from the immutable run snapshot. Each item
  supports not started, in progress, and completed, with revision checks and
  command receipts for safe retries.
- No station assignment is inferred when the workbook does not identify one.

## Existing test evidence

- `run-station-progress.test.mjs` covers timer-derived station states,
  lifecycle transitions, count validation, expected revisions, and response
  shape.
- `run-requirements-progress.test.mjs` verifies the lowest reported case count
  per matching area and that missing counts do not appear complete.
- `run-timer.test.mjs` checks running, paused, and completed elapsed-time
  behavior.
- `run-quality-checks.test.mjs` verifies stable IDs and source provenance for
  imported early-pull items.
- The disposable API pilot checks initial checklist state, a status update,
  idempotent retry, and a stale-revision conflict.

## Remaining

Cross-session signed-in UI verification still requires the authenticated
browser harness. Keep station assignment blank unless a source workbook
provides a reliable mapping.
