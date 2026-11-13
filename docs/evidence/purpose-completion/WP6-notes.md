# WP6 — Dashboard coherence

## Existing behavior and evidence

- The dashboard presents planned, active, and completed totals; a live timer
  and area-level case progress for active runs; the planned queue; and recently
  updated runs.
- The dashboard-summary route is facility-scoped. The pilot-verification
  integration test confirms that planned runs and active station progress
  appear in the summary.
- Active-run cards now include counts of stations that are not started, in
  progress, ready, or marked not required. The disposable pilot verification
  asserts those counts from saved station state.
- The summary includes runs with failed quality measurements or unresolved
  checks. The disposable pilot verifies that a failed measurement appears with
  the correct run status and count.
- The development-only dashboard preview at
  `/__visual-preview/dashboard` was checked at phone, tablet, and desktop
  widths. Browser logs showed no errors.
- The early-pull checklist also has a synthetic development preview at
  `/__visual-preview/preparation`; it was checked at 390×844, 768×1024, and
  1440×900. Browser logs showed no errors, and its status buttons only change
  local preview state.
- The importer, station calculator, and quality-check previews were also checked
  at 390×844. They render with synthetic data, make no API requests, and show no
  browser errors.
- Workspace typecheck, build, API/web tests, and disposable pilot verification
  passed after this change.

## Remaining

Import drafts are not persisted for the dashboard to query, so the review queue
is not yet surfaced. Verify the signed-in dashboard and early-pull checklist,
operator/manager actions, and actual phone-width behavior before calling
dashboard coherence complete. The published Reserved VM pilot remains
unverified; this disposable test does not establish production readiness.
