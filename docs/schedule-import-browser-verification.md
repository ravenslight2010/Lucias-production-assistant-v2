# Production-schedule browser verification

Verified on 2026-11-12 against the development preview using a fresh synthetic
Clerk account, a separate synthetic facility, and real XLSX uploads. No production
data was touched; no existing facility was modified. Synthetic runs remained
planned.

## Reusable coverage

- `artifacts/lucia-production-assistant-v2/test/browser/schedule-import.mjs`
  exports the authenticated Playwright scenario.
- `test/browser/schedule-fixture.mjs` in that package generates actual workbook
  bytes from the browser's local date.
- `test/schedule-fixture.test.mjs` checks the generated workbook against the real
  parser, including exact row coordinates and a year boundary. It also checks
  the browser assertion's handling of date-only and UTC ISO date serialization.
- See `test/browser/README.md` for invocation and account isolation requirements.

## Observed browser results

| Check | Result |
| --- | --- |
| Authenticated facility and active profile setup | Passed through UI |
| Schedule detected separately from product import | Passed |
| Yesterday's past-only product excluded | 1 ignored row; no profile mapping required |
| Today retained, future retained | 3 eligible rows |
| Preview date, brand, flavor, cases, notes, worksheet and row | Matched fixture |
| Review before import | No runs created |
| Exact Cheese profile match | Automatically selected |
| Unmatched Pepperoni alias | Import disabled until explicitly mapped |
| Import | 3 planned runs; 1 past row ignored |
| Saved run setup | Selected active profile IDs and immutable snapshots matched |
| Saved schedule details | Dates, cases, notes, original brand/flavor, file, sheet and row matched |
| Run list, each run detail, import history | Displayed imported data |
| Identical file re-upload and identical mappings | Replay returned the same import ID |
| Replay persistence | Exactly the same 3 run objects and IDs; 1 schedule import batch |
| Reload | Import history, list and all 3 details persisted |

The initial pass executed equivalent UI/API assertions manually because the
browser notebook cannot dynamically import Node ESM. That pass identified UTC
ISO serialization of `scheduledFor`. The saved assertion now compares the
calendar date while rejecting unexpected serialization.

The **actual exported scenario was then bundled and executed** in the
authenticated Playwright notebook. It created the isolated facility and profiles,
reviewed/mapped the schedule, and completed the first import. That execution
identified a case-sensitive test mismatch caused by the badge's displayed
“Planned” text. After normalizing the status text, the same exported function
completed from its guarded post-import checkpoint in the preserved synthetic
facility: all details, identical-file replay, unchanged run objects, one history
batch, reload, and persisted UI checks passed. No manual substitutions were used
during either part of this executable scenario run.

The notebook-compatible bundle also explicitly converts XLSX byte arrays into
the harness's `Buffer` type at the upload boundary. Both successful profile
imports and schedule imports read their response JSON once. The generated bundle
is not committed; rebuild it using the documented command.

Browser screenshot evidence was returned with the test report: disabled
unmapped review, replay notice/history, first import from the executable scenario,
and its final persisted three-run list. No credentials or session state are
included in this repository.
