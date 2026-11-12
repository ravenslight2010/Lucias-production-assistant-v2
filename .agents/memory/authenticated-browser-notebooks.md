---
name: Authenticated browser notebooks
description: Running reusable authenticated Playwright scenarios in the browser testing notebook.
---

The browser testing notebook exposes a real Playwright Page but may not support
ESM imports, CommonJS require, or an externally accessible browser connection.
Use a self-contained IIFE bundle of the same scenario when dynamic import fails,
rather than replacing executable regression coverage with manual steps.

**Why:** A manual equivalent pass did not exercise errors in the saved scenario.
The notebook rejected dynamic imports, and its browser wrapper exposed no
connection endpoint for a separate Node process. A bundled scenario executed
successfully with its injected Page.

**How to apply:** Keep reusable browser scenarios runtime-neutral, bundle their
dependencies with the existing build tools, and evaluate the bundle in the
authenticated notebook. Convert generated workbook byte arrays using the
notebook's Buffer at the Playwright upload boundary; browser-targeted spreadsheet
bundles may return a typed array instead. Never persist authentication material
to make this bridge work.

Keep the browser's in-memory CSRF token aligned with its V2 session cookie after
API-based test setup. A helper that issues a new V2 session rotates the cookie
and its paired token; reload the app after that setup before exercising UI
writes, and avoid issuing another session through the helper mid-journey.

**Why:** A signed-in browser test's saves returned the generic origin-verification
403 after API setup. Reloading restored the UI writes without relaxing any
authentication or origin checks.

**How to apply:** Let the app bootstrap finish after seeding, use ordinary
authenticated GETs for read-back, and do not print cookies or CSRF values while
diagnosing a mismatch. Do not weaken security middleware to accommodate test
setup.
