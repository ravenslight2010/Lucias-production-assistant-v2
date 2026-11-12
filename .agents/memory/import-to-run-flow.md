---
name: V1 import-to-run flow
description: Product requirement connecting importers, master data, and production runs.
---

V2 imports are the source of most run information, not merely archived spreadsheets. Trace V1's importer output into shared product profiles, recipe and process master data, schedules, and the run workflows that consume them.

Treat V1 as a behavioral reference: preserve useful workflows in V2 while improving review, validation, and shared data flow instead of cloning implementation details.

**Why:** The user said imports provide most of the app's run information and asked that the import rebuild cover how imported data is applied throughout the app. They also said V2 should retain many V1 features, but improve them.

**How to apply:** Compare V1 behavior before replacing importer flows; keep imported master data queryable by run flows, preserve source/provenance, and snapshot selected product data onto runs so later imports do not silently rewrite existing runs.

For importer work, follow this priority order: product spec sheets first; dough procedures second because they are hardest to parse correctly; cheese workbooks third, disambiguating duplicate recipe names; sauce guides fourth, allowing products without a sauce recipe; premix workbooks fifth, preserving extra timing information such as pulling ingredients days early; shipping guides sixth; schedules last.

**Why:** The user explicitly set this sequence and called out the data-quality risks for dough, duplicate cheese recipe names, incomplete sauce coverage, and premix pull timing.

**How to apply:** Do not advance to a lower-priority workbook type until the higher-priority one is working and verified, unless the user changes the order.
