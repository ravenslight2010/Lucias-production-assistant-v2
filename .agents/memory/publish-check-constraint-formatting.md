---
name: Publish check-constraint formatting
description: A Replit Publish diff quirk affecting CASE-based PostgreSQL check constraints.
---

For Replit-managed PostgreSQL, a valid check constraint with a top-level `CASE`
expression can be emitted by the Publish diff as `CHECK (CHECK (CASE ...))`.
The development catalog and Drizzle schema can both be valid while the
generated production statement is not. Compare the actual Publish diff instead
of changing correct validation logic blindly.

**Why:** A publish-time syntax failure reproduced in the development-to-production
diff, while an equivalent boolean expression generated valid DDL.

**How to apply:** Preserve the same accepted values, but keep `CASE` nested in a
safe function argument when possible. Apply the change through the development
schema flow, inspect `pg_get_constraintdef`, and recompute the Publish diff.
Drizzle may ignore an expression-only check change under the same constraint
name, so replacing that development constraint may require explicit approval.
Recommend retrying only after the generated SQL has one `CHECK` wrapper and no
structural data-loss change. Never modify production or bypass Publish.
