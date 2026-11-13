# WP4 — Inventory from confirmed production

## Existing behavior and evidence

- Facility inventory supports on-hand adjustments and a run-level actual-use
  review/confirmation flow.
- `run-control.integration.ts` verifies that stale inventory revisions reject
  confirmation, accepted actual use writes a reconciliation, the same command
  can be retried safely, a second deduction is rejected, and corrections link
  to the original transaction.
- The UI also warns when entered usage exceeds known stock without treating
  unknown stock as zero.
- The WP0 API and web test suites passed.

## Remaining

Add explicit acceptance evidence for recording an opening physical count and
for ensuring a planned-only run does not change inventory. Verify the
confirmed-use path in the signed-in UI before treating inventory as pilot-ready.
