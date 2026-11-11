---
name: Enum additions in Publish
description: Avoid using a newly added PostgreSQL enum value before the Publish transaction commits.
---

PostgreSQL may add an enum value in a transaction, but that value cannot be
used by later statements in that same transaction. A Publish diff that adds a
label and then sets a column default to that label can fail with
`unsafe use of new value`.

**Why:** The V2 development schema used a new `planned` value as a default while
the production enum did not yet contain it; Publish emitted both operations in
one diff.

**How to apply:** Compare development and production enum labels and defaults.
If application code explicitly writes the new value, keep the database default
at a value already present in production so the first Publish only adds the
enum label. If a new database default is required, apply it in a later Publish
after the enum addition has committed. Verify the full diff has no other use of
the new label before commit. Never add production or deploy-time DDL.
