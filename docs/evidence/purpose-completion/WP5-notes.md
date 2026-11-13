# WP5 — Run-tied quality checks

## Existing behavior and evidence

- Quality checks are generated from the captured run snapshot, accept ounce
  measurements, preserve check history, and display pass/fail against the
  saved spec.
- Sauce and pepperoni-applicator rows use the tighter tolerance; finished
  weight uses the imported spec range. Unknown applicator rows remain
  unresolved until reviewed.
- `run-quality-checks.test.mjs` covers snapshot-derived limits, source-role
  mapping, and unresolved or unclear source rows.
- The WP0 API and web test suites passed.

## Remaining

Run the signed-in measurement flow and verify that failed or unresolved checks
appear as an actionable dashboard state. Do not replace source ranges with a
generic tolerance or silently assign a role to an unfamiliar applicator.
