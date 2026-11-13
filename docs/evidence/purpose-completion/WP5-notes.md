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
- The dashboard summary returns counts for failed measurements and unresolved
  checks from the latest measurement per check.
- The disposable API pilot posts a failed synthetic measurement and confirms
  that the dashboard reports it for the correct run.

## Remaining

Run the signed-in measurement flow and visually verify the dashboard attention
state. Do not replace source ranges with a generic tolerance or silently assign
a role to an unfamiliar applicator.
