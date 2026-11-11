---
name: Drizzle push safeguards
description: Preserving database objects maintained outside the generated application schema during Drizzle pushes.
---

Drizzle schema pushes can treat custom indexes and check constraints that are not in the generated schema as drift and remove them. Keep confirmation enabled for ordinary pushes so these changes cannot be applied silently.

**Why:** A repeat push removed an externally maintained partial index and check constraint until the change was run in strict confirmation mode and declined.

**How to apply:** Do not disable confirmation for normal schema pushes. Tests that need an unprompted initial schema setup may opt out only for fixture initialization; test externally maintained objects by declining the repeat push and checking that they remain.

Non-interactive confirmation failures should be checked explicitly: the current CLI can print the terminal error but still return a successful process status. Require an explicit schema-completion message as well as a successful exit before treating unattended setup as complete.

The standalone push script must import the same complete schema barrel as `drizzle.config.ts`; importing only one table module makes tables from other schema files appear as destructive drift. With Node's native TypeScript stripping, relative TypeScript imports in that barrel need explicit `.ts` extensions. The post-merge runner must also recognize the push script's exact no-op success output, `No schema changes`.

**Why:** An incomplete schema import treated a valid station-layout table as a table to drop, and the setup runner did not recognize the successful no-op message.

**How to apply:** Keep the push script's schema source aligned with the database package barrel, verify it with a fresh-install schema test, and update the post-merge success matcher if the push script's success messages change. Preserve strict confirmation; do not globally set `DRIZZLE_PUSH_STRICT=false`.
