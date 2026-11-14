---
name: Dependabot catalog updates
description: Keep Dependabot's pnpm catalog changes compatible with lockfile updates.
---

Keep the Dependabot npm update configuration on the `increase` versioning strategy for dependencies managed through pnpm catalogs. This strategy advances catalog requirements when Dependabot proposes a newer release, rather than relying solely on a lockfile update while the existing range already permits that release.

**Why:** Dependabot's pnpm catalog lockfile-only update path has an upstream no-change failure mode when a newer version is already allowed by an unchanged catalog range.

**How to apply:** Preserve `increase` for this workspace's catalog updates, and verify that a real Dependabot PR changes the catalog and lockfile together. Revisit this constraint if Dependabot's catalog updater behavior changes.
