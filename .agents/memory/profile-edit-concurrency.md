---
name: Profile edit concurrency
description: Why open profile drafts and merge confirmations must keep the revision originally reviewed.
---

An open profile edit or merge confirmation must retain its originally reviewed
revision even when the active profile list refreshes in the background. Reopening
the edit should initialize both values and revision from the latest profile.

**Why:** A refresh can otherwise attach a newer revision to stale form values,
silently turning an expected revision conflict into an overwrite of another
operator's work.

**How to apply:** Treat refreshed list data and the operator's open draft as
separate states. Never advance the draft's expected revision until the operator
explicitly starts a new edit or reviews a new confirmation.
