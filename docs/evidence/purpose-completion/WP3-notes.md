# WP3 — Live production math

## Existing behavior and evidence

- Run detail calculates remaining requirements from the immutable run plan and
  saved station counts, not from a workbook preview.
- Matching-area requirements use the lowest reported completed-case count;
  zero remaining cases produce zero demand, while missing counts remain
  unresolved.
- Shared-batch preparation combines only lines linked to the exact same
  selected formula and batch column.
- Tests include `run-requirements-progress.test.mjs` and
  `station-area-calculations.test.mjs`, including a no-guessed-values case.
- The WP0 workspace test suites passed.
- The disposable API pilot changes a saved station count from zero to one and
  verifies that estimated completed-production ingredient use changes from
  zero to one without changing the captured run plan.

## Remaining

The current tests prove core math invariants, not a full golden set from the
uploaded product, dough, cheese, and sauce workbook families. Add representative
approved fixtures and verify the signed-in run page refreshes after station
counts change in another browser context before marking production calculations
fully verified.
