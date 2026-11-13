# WP1 — Day-plan import

## Existing coverage

- `test/browser/profile_snapshots.py` generates real XLSX bytes and exercises the
  signed-in product-spec import, saved profile, planned-run snapshot, applicator
  role review, name changes/merges, direct run reloads, and stale-revision
  conflict handling.
- `test/browser/schedule-import.mjs` exercises a fresh synthetic facility and
  checks that past rows are ignored, today/future rows remain, aliases require
  review, planned runs keep the selected product snapshots, import history is
  visible, identical-file retry is idempotent, and results survive reload.
- `test/browser/README.md` documents the signed-in harness and safe use of a
  disposable development facility. It prohibits production data, auth bypasses,
  and committing browser credentials.
- The API schedule-import and profile-name integration tests and the web
  workbook-parser tests passed in the latest local run. The authenticated UI
  scripts below remain separate verification.

## Remaining verification

The browser scripts require a real Clerk-authenticated Playwright `Page`. The
static screenshot browser cannot sign in, and no authenticated browser page is
available to this agent. Do not bypass Clerk or reuse a production/V1 account.
Run both scripts with a fresh synthetic V2 identity in the documented
authenticated browser harness before marking WP1 complete.

The import priority remains product specs → dough → cheese → sauce → mix/premix
→ shipping → schedule. Rows dated before the schedule import date are ignored.
