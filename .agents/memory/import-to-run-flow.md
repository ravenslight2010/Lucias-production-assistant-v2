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

Brand prefixes also distinguish recipe identities during rename/merge; they are not merely display labels. Per-pizza weight or ratio can change between products while the recipe batch size usually stays the same.

**Why:** The user explained, “the per pizza wieght/ratio changes, but the batch size usually stays the same,” and clarified that this is also why the brand name is included.

**How to apply:** Keep shared batch-recipe identity and formula separate from each product's per-pizza usage. Do not collapse recipes across brands because their short names match, or infer identical batch sizes from “usually.” Explicitly merged aliases must not overwrite product-specific weights or ratios.

Keep the Kroger spec workbook's products in separate Kroger profiles, even though its internal headings say Corner Booth.

**Why:** The user explicitly chose separate Kroger profiles rather than sharing the matching Corner Booth brand/flavor profiles.

**How to apply:** Use Kroger as the destination brand for those customer specs, preserve the original source labels, and do not automatically rename existing profiles or run snapshots.

Recipe discrepancy acknowledgement means the source was reviewed for reference, not that its recipe was corrected or approved for automatic calculation.

**Why:** The uploaded dough, cheese, and sauce sources contain conflicting quantities, incomplete formulas, alternative batch or applicator definitions, and mixed-unit calculations. Choosing a value silently could change a production recipe.

**How to apply:** Preserve both source statements and review warnings in downstream run data. Do not treat an acknowledged warning as permission to invent missing quantities or automatically resolve recipe conflicts. A source heading such as “Tested and Good” is not production approval. Keep native quantities and parallel calculations distinct unless their units and conversions are explicitly confirmed.

Keep cheese applicator formulas and sub-mixes distinct. Similar recipe names are not evidence that formulas are interchangeable, and source shorthand is not an approved alias.

**Why:** Customer tabs reuse recipe names and may require more than one blend or a separately prepared sub-mix for one product.

**How to apply:** Require an explicit choice of the source formulas for a product; retain applicator labels, original names, and provenance rather than merging by display name or silently expanding sub-mixes.

Premix workbook planning totals are source references, not current-run requirements. Keep preparation/early-pull sections separate from the mix formula they sit beside.

**Why:** The source workbooks include saved mix counts, cases, already-made amounts, and pull totals from prior planning. Adjacent preparation tables can have different timing and quantities from the mix itself.

**How to apply:** Preserve the source values and timing in profile/run snapshots with their table identity. Do not reuse saved totals as new-run requirements or combine preparation quantities into a formula without a verified calculation rule.

Treat shipping guide labels as possible packaging variants, not reliable aliases for a whole customer brand.

**Why:** The guide distinguishes carton versus label packaging, sizes, product codes, and multipacks under related customer names. Automatically collapsing those rows into one brand setting could give a product the wrong packaging instructions.

**How to apply:** Keep original guide labels and source coordinates. Let the reviewer choose one row for each product; do not infer fuzzy aliases or apply every related variant to every flavor. Preserve uncertain grip-sheet placement and missing pallet heights rather than filling them in.

Name management must cover recipes, ingredients, brands, and flavors, not only whole product profiles. Different source labels can refer to the same recipe; the user gave “lucias sauce” versus “lucias style” as an example to merge into one recipe name.

**Why:** The user clarified that rename/merge applies to these individual names throughout the importing system, not just brand/flavor pairs.

**How to apply:** Trace source labels and their references across workbook types and downstream run setup. Do not report product-profile-only rename/merge as completion of this broader requirement. Preserve original source data and existing run snapshots.

Remember names explicitly renamed or merged by the user so future workbook and schedule imports match the surviving identity without repeating the same cleanup.

**Why:** The user said, “Remember what names got renamed or merged together, so that we don't have to do it every time.”

**How to apply:** Treat these as exact, facility-scoped name mappings created by explicit rename/merge actions, not inferred recipe aliases. Keep original workbook labels and existing run snapshots unchanged; carry remembered names through later merges.

Do not resolve recipe, ingredient, or flavor aliases by searching all historical brands that now share a canonical brand. Follow the exact original namespace and explicit brand redirects; carry alias decisions onto a renamed namespace deliberately.

**Why:** Merging brands can otherwise make an old flavor alias from one brand rename an unrelated flavor in the destination brand merely because their labels match. Brand prefixes exist to prevent that confusion.

**How to apply:** Preserve original brand context on imported sources, distinguish brand rename from brand merge, and check chains of flavor rename, brand merge, and later brand rename. Keep the destination's existing canonical names authoritative and retain the old source namespace for future imports.

For run calculations, keep each per-pizza source line visible, but total it once when multiple lines explicitly link to the exact same selected formula and batch column. Scale that selected formula to the combined demand and round the shared batch count once; never group by a similar recipe name or by a shared yield alone.

**Why:** Per-pizza quantities vary by product, while some products use the same batch formula more than once. Rounding every use separately can overstate batches; merging by a matching short name can combine different formulas.

**How to apply:** Preview calculations against the selected product and remembered-name revisions. Preserve the original source lines and values, verify units and formula totals, and capture the reviewed calculation with a new run rather than changing historical run snapshots. A source-reference acknowledgment is not approval to correct or accept a conflicting formula.

Manager recipe edits are profile-owned overrides, not edits to imported workbook sources. Apply them only to future run planning; existing run snapshots stay unchanged.

**Why:** The user chose editable manager libraries while relying on imported workbooks as traceable source records.

**How to apply:** Keep workbook source entries immutable, save manager changes with profile-revision checks, and use the reviewed override only when previewing or creating future runs.
