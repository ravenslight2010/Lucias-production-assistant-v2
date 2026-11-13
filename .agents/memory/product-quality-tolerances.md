---
name: Product quality tolerances
description: User-provided acceptable deviations for run-tied quality checks.
---

The user chose both individual ingredient weights and finished-pizza weight as QC measurements, with ounces as the unit. Ingredient weights generally use ±0.1 oz; sauce and items listed on a sheet associated with a pep applicator use ±0.05 oz. Finished-pizza weight must use the range on the product spec sheet, not a guessed fixed tolerance. The exact pep-applicator sheet names are not yet established.

**Why:** The user supplied these limits while scoping run-tied quality checks.

**How to apply:** Use captured run targets for ingredient checks, the spec-sheet range for finished weight, and preserve source provenance. Apply the tighter pep tolerance from the exact source-sheet mapping, not from ingredient-name guesses. If a target, range, or sheet mapping cannot be established, show it as unresolved rather than inventing a pass/fail result.
