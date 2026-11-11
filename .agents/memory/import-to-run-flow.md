---
name: V1 import-to-run flow
description: Product requirement connecting importers, master data, and production runs.
---

V2 imports are the source of most run information, not merely archived spreadsheets. Trace V1's importer output into shared product profiles, recipe and process master data, schedules, and the run workflows that consume them.

**Why:** The user said imports provide most of the app's run information and asked that the import rebuild cover how imported data is applied throughout the app.

**How to apply:** Keep imported master data queryable by run flows, preserve source/provenance, and snapshot selected product data onto runs so later imports do not silently rewrite existing runs.
