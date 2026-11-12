---
name: V1 import-to-run flow
description: Product requirement connecting importers, master data, and production runs.
---

V2 imports are the source of most run information, not merely archived spreadsheets. Trace V1's importer output into shared product profiles, recipe and process master data, schedules, and the run workflows that consume them.

Treat V1 as a behavioral reference: preserve useful workflows in V2 while improving review, validation, and shared data flow instead of cloning implementation details.

**Why:** The user said imports provide most of the app's run information and asked that the import rebuild cover how imported data is applied throughout the app. They also said V2 should retain many V1 features, but improve them.

**How to apply:** Compare V1 behavior before replacing importer flows; keep imported master data queryable by run flows, preserve source/provenance, and snapshot selected product data onto runs so later imports do not silently rewrite existing runs.
