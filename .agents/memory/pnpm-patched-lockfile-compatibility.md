---
name: PNPM patched lockfile compatibility
description: Keep patched dependency lockfiles aligned with the PNPM major version that installs them.
---

PNPM 9 and PNPM 10 serialize patched dependency hashes differently. Use the same PNPM major to generate and consume a lockfile that contains patches; do not regenerate it with another major merely to clear a frozen-install mismatch.

**Why:** A mixed-version install rejected the patched lock metadata, while a non-frozen regeneration tried to resolve newly released packages and hit the workspace's release-age safeguard.

**How to apply:** Follow the repository's pinned package-manager version for lockfile installs and schema commands. Change package-manager versions only as an intentional lockfile migration, and preserve release-age safeguards.
