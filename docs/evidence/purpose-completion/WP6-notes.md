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
- The development-only dashboard preview at
  `/__visual-preview/dashboard` was checked at phone, tablet, and desktop
  widths. Browser logs showed no errors.
- Workspace typecheck, build, API/web tests, and disposable pilot verification
  passed after this change.

## Remaining

The dashboard currently has no summary for run quality failures/unresolved
checks or review-required imports. Import drafts are not persisted for the
dashboard to query. Design the remaining attention state from existing V2 data
and verify the signed-in dashboard, operator/manager actions, and actual
phone-width behavior before calling dashboard coherence complete.
