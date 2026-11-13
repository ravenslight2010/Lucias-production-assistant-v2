---
name: PNPM patched lockfile compatibility
description: Keep patched dependency lockfiles aligned with the PNPM major version that installs them.
---

PNPM 9 and PNPM 10 serialize patched dependency hashes differently. Use the same PNPM major to generate and consume a lockfile that contains patches; do not regenerate it with another major merely to clear a frozen-install mismatch.

**Why:** A mixed-version install rejected the patched lock metadata, while a non-frozen regeneration tried to resolve newly released packages and hit the workspace's release-age safeguard. In this Replit workspace, adding a root `packageManager` pin also triggered repeated PNPM self-installs and exhausted process slots.

**How to apply:** Keep the explicit `corepack pnpm@9` usage in setup commands and generate patched lockfiles with PNPM 9. Do not enforce the pin with a root `packageManager` field here; change package-manager versions only as an intentional lockfile migration, preserving release-age safeguards.
