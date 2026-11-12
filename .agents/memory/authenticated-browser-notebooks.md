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
