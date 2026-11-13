---
name: v2-browser-regression
description: "Runs or extends Lucia V2 signed-in browser regressions. Use when verifying workbook imports, schedule imports, product-name changes, run creation, or role-specific production screens."
---

# Lucia V2 browser regression

Use the existing regression harness before adding a new browser test. Read
`artifacts/lucia-production-assistant-v2/test/browser/README.md` for the current
scenarios and setup details.

## Choose the existing check

- Run the web package tests for parser and UI-logic regressions:
  `pnpm --filter @workspace/lucia-production-assistant-v2 test`.
- Run the API package tests for routes and database integration:
  `pnpm --filter @workspace/api-server test`.
- Run `pnpm --filter @workspace/api-server run test:pilot` only for the
  disposable local PostgreSQL recovery check. It does not verify Replit VM
  overlap or external sign-in providers.
- Use `profile_snapshots.py` for authenticated profile import, applicator
  review, rename/merge, revision-conflict, and reload coverage.
- Use `schedule-import.mjs` for the authenticated schedule-import journey,
  including past-date exclusion, today/future rows, profile mapping,
  duplicate re-upload, and persistence.

The browser scenarios accept an existing authenticated page or storage state;
do not add a second Playwright installation or create an authentication bypass.
Use the Clerk e2e helper only when it is supported by this Replit-managed Clerk
setup. Keep test sessions and storage state outside Git.

## Keep test data isolated

- Use a disposable development facility and synthetic names/workbooks. Never
  write to production, V1, or a real facility.
- Generate unique data for each run. Existing browser scenarios may retain
  synthetic records for inspection; do not delete unrelated records to reset a
  test.
- Do not put customer workbooks, personal data, credentials, or session state
  into fixtures, logs, screenshots, or commits.
- Do not mock the API in an end-to-end test whose purpose is to verify
  persistence or shared state.

## Make browser checks reliable

- Prefer accessible role and label locators; use a stable test id when a
  control has no reliable accessible name. Avoid selectors tied to layout or
  CSS classes.
- Use auto-waiting actions and web-first assertions. Do not add fixed sleeps or
  force clicks to hide a synchronization problem.
- After a consequential save, reload the relevant route and verify the saved
  state. For rename/merge, check the active profile cards and run selectors;
  for a stale edit, verify the conflict response and that the winning revision
  remains after reload.
- Keep expected values independent of the implementation and assert the
  workbook payload or selected profile snapshot, not only a success message.

## Separate visual previews from signed-in proof

Development-only `__visual-preview` routes use synthetic data and disable API
writes. Use them for layout and responsive screenshots, but never count them as
proof of authenticated behavior. Report signed-in UI as unverified unless an
authenticated browser scenario actually exercised it.

## Source

This project-specific guide adapts selected stable-locator, auto-waiting, and
test-isolation practices from
[`petrkindlmann/qa-skills` `playwright-automation`](https://github.com/petrkindlmann/qa-skills/tree/main/skills/playwright-automation),
licensed under MIT. The upstream license notice is included beside this file.
