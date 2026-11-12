---
name: Drizzle composite-key introspection
description: A Drizzle Kit pushSchema adapter issue with composite-primary-key introspection and bound query parameters.
---

Drizzle Kit 0.31.11's PostgreSQL `pushSchema` adapter discards the parameter array for its composite-primary-key lookup. The resulting query contains `$1` and `$2` but reaches PostgreSQL with no bound values, so a repeated push fails after the first push creates a composite primary key.

**Why:** This is an upstream adapter issue, not a schema mismatch or a reason to weaken confirmation or data-preservation safeguards.

**How to apply:** Keep disposable-database tests for strict decline, accepted upgrades, custom safeguard preservation, and saved-data snapshots. Avoid repeating a push after composite keys exist until the installed Drizzle Kit version correctly forwards query parameters; restore that idempotence coverage when fixed.

For destructive-push regression tests, use a separate minimal disposable database with a small fixture table rather than the populated run-control database. The smaller schema can produce real drop plans without triggering the composite-key introspection bug.

**Why:** An empty generated schema against the full run-control fixture failed during composite-key introspection before reaching the destructive-change safeguard.

**How to apply:** Keep each disposable destructive-schema test isolated from the larger migration fixture, explicitly point it at the local test database, and assert the planned change is rejected before checking that rows and custom objects remain.
