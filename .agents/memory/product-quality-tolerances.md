---
name: Product quality tolerances
description: User-provided acceptable deviations for run-tied quality checks.
---

The user chose both individual ingredient weights and finished-pizza weight as QC measurements, with ounces as the unit. Ingredient weights generally use ±0.1 oz; sauce and anything in the “pep applicators” use ±0.05 oz. Finished-pizza weight must use the range on the product spec sheet, not a guessed fixed tolerance.

**Why:** The user supplied these limits while scoping run-tied quality checks.

**How to apply:** Use captured run targets for ingredient checks, the spec-sheet range for finished weight, and preserve source provenance. Map the tighter sauce/pep tolerance to the relevant applicator source. If a target or range cannot be established, show it as unresolved rather than inventing a pass/fail result.
