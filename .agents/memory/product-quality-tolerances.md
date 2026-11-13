---
name: Product quality tolerances
description: User-provided acceptable deviations for run-tied quality checks.
---

The user chose both individual ingredient weights and finished-pizza weight as QC measurements, with ounces as the unit. All product spec sheets are in scope. Ingredient weights generally use ±0.1 oz; sauce and pep-applicator rows use ±0.05 oz. Cheese-applicator and ordinary ingredient rows use ±0.1 oz. Finished-pizza weight uses the product spec-sheet range, not a guessed fixed tolerance.

**Why:** The user specified that the tighter ingredient tolerance depends on sauce and pep-applicator rows across product spec sheets, not ingredient-name guesses.

**How to apply:** Use captured source-row roles and preserve source provenance. Apply ±0.05 oz to sauce and pep-applicator rows; use ±0.1 oz for cheese applicators and other ingredients. If a target or finished-weight range is unclear, show it as unresolved rather than inventing a pass/fail result.
