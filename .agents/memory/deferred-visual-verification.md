---
name: Deferred visual verification
description: Keep visual checks blocked by unavailable browser access pending for a later combined pass.
---

When visual checks cannot run because browser or testing access is unavailable, keep them pending rather than treating them as complete. When that access returns, run all pending visual checks together.

**Why:** the user asked to remember unavailable visual checks so they can all be completed once access returns.

**How to apply:** Record blocked screens and flows in the current activity board. When visual testing is available again, review the pending items and verify them in one pass.
