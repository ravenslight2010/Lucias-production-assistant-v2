---
name: V1 import-to-run flow
description: Product requirement connecting importers, master data, and production runs.
---

V2 imports are the source of most run information, not merely archived spreadsheets. Trace V1's importer output into shared product profiles, recipe and process master data, schedules, and the run workflows that consume them.

Treat V1 as a behavioral reference: preserve useful workflows in V2 while improving review, validation, and shared data flow instead of cloning implementation details.

**Why:** The user said imports provide most of the app's run information and asked that the import rebuild cover how imported data is applied throughout the app. They also said V2 should retain many V1 features, but improve them.

**How to apply:** Compare V1 behavior before replacing importer flows; keep imported master data queryable by run flows, preserve source/provenance, and snapshot selected product data onto runs so later imports do not silently rewrite existing runs.

For importer work, follow this priority order: product spec sheets first; dough procedures second because they are hardest to parse correctly; cheese workbooks third, disambiguating duplicate recipe names; sauce guides fourth, allowing products without a sauce recipe; premix workbooks fifth, preserving extra timing information such as pulling ingredients days early; shipping guides sixth; schedules last.

During import, prefix cheese recipe names and mix names with their brand names to disambiguate duplicates.

**Why:** The user explicitly set this sequence and called out the data-quality risks for dough, duplicate cheese recipe names, incomplete sauce coverage, and premix pull timing.

**How to apply:** Do not advance to a lower-priority workbook type until the higher-priority one is working and verified, unless the user changes the order. Apply the brand prefix when creating imported cheese and mix recipe names.

Keep the Kroger spec workbook's products in separate Kroger profiles, even though its internal headings say Corner Booth.

**Why:** The user explicitly chose separate Kroger profiles rather than sharing the matching Corner Booth brand/flavor profiles.

**How to apply:** Use Kroger as the destination brand for those customer specs, preserve the original source labels, and do not automatically rename existing profiles or run snapshots.

Recipe discrepancy acknowledgement means the source was reviewed for reference, not that its recipe was corrected or approved for automatic calculation.

**Why:** The uploaded dough, cheese, and sauce sources contain conflicting quantities, incomplete formulas, alternative batch or applicator definitions, and mixed-unit calculations. Choosing a value silently could change a production recipe.

**How to apply:** Preserve both source statements and review warnings in downstream run data. Do not treat an acknowledged warning as permission to invent missing quantities or automatically resolve recipe conflicts. A source heading such as “Tested and Good” is not production approval. Keep native quantities and parallel calculations distinct unless their units and conversions are explicitly confirmed.

Keep cheese applicator formulas and sub-mixes distinct. Similar recipe names are not evidence that formulas are interchangeable, and source shorthand is not an approved alias.

**Why:** Customer tabs reuse recipe names and may require more than one blend or a separately prepared sub-mix for one product.

**How to apply:** Require an explicit choice of the source formulas for a product; retain applicator labels, original names, and provenance rather than merging by display name or silently expanding sub-mixes.
