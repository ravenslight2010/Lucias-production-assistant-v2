---
name: PNPM 9 override location
description: Ensure dependency overrides are applied by the workspace's pinned PNPM version.
---

The `overrides` section in `pnpm-workspace.yaml` alone was not applied by this workspace's pinned PNPM 9.15.9. Put required overrides in the root `package.json` under `pnpm.overrides`; keep duplicate workspace rules aligned if they remain for other package-manager versions.

**Why:** A fresh dependency resolution retained vulnerable transitive versions until the overrides were present in the root manifest.

**How to apply:** After changing overrides, reinstall without a frozen lockfile, inspect dependency paths with `pnpm why`, run `pnpm audit`, and confirm `pnpm install --frozen-lockfile` succeeds.
