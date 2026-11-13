---
name: Product quality tolerances
description: User-provided acceptable deviations for run-tied quality checks.
---

The user chose both individual ingredient weights and finished-pizza weight as QC measurements, with ounces as the unit. All product spec sheets are in scope. Ingredient weights generally use ±0.1 oz; sauce and pep-applicator items use ±0.05 oz. Finished-pizza weight uses the product spec-sheet range, not a guessed fixed tolerance. The current importer exposes source-row labels rather than a separate applicator assignment, so explicit sauce and pep/pepperoni labels are the present proxy for the tighter limit.

**Why:** The user supplied these limits while scoping run-tied quality checks, and the current product snapshot does not separately identify applicator stations.

**How to apply:** Use captured run targets and preserve source provenance. Use ±0.05 oz only for source rows explicitly identified as sauce or pep/pepperoni; other ingredients use ±0.1 oz. Replace this label-based proxy if imports later capture explicit pep-applicator membership. If a target or finished-weight range is unclear, show it as unresolved rather than inventing a pass/fail result.
