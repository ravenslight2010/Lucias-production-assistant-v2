---
name: PNPM override location
description: Keep security and compatibility overrides in the root manifest.
---

The workspace's overrides are kept in the root `package.json` under `pnpm.overrides`; duplicate rules in `pnpm-workspace.yaml` should stay aligned when retained.

**Why:** PNPM 9.15.9 retained vulnerable transitive versions when the overrides existed only in `pnpm-workspace.yaml`. This project now uses PNPM 10.26.1, so keep using the root manifest as the source of truth unless a deliberate change is verified.

**How to apply:** After changing overrides, resolve with PNPM 10.26.1, inspect dependency paths with `pnpm why`, run `pnpm audit`, and confirm a frozen install succeeds.
