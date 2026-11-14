---
name: PNPM patched lockfile compatibility
description: Keep patched dependency lockfiles aligned with the PNPM major version that installs them.
---

This project is standardized on PNPM 10.26.1. PNPM 9 and PNPM 10 serialize patched dependency hashes differently, so generate and consume the patched lockfile with the pinned PNPM 10 version.

**Why:** A mixed-version install rejected the patched lock metadata, while a non-frozen regeneration tried to resolve newly released packages and hit the workspace's release-age safeguard. A mismatched root `packageManager` pin triggered repeated self-installs; the persistent pin must match Replit's installed PNPM version.

**How to apply:** Keep `package.json`, GitHub Actions, post-merge setup, and lockfile operations aligned on PNPM 10.26.1. If changing versions, migrate the lockfile and verification commands together, preserving release-age safeguards.
