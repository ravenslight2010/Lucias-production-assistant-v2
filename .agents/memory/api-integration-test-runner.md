---
name: PostgreSQL integration test runners
description: Environment-specific details for API tests that launch isolated PostgreSQL and nested Node test processes.
---

When an integration test is started from inside Node's test runner and it launches a second `node --test` process, remove the inherited `NODE_TEST_CONTEXT` from the child environment. Otherwise the nested runner can skip test discovery. If the bundle externalizes PostgreSQL's `pg` package, place the temporary bundle under `lib/db/tests` (or another directory whose parent can resolve that package); bundling to the system temp directory cannot resolve workspace-local dependencies.

**Why:** The API test runner needed an isolated PostgreSQL instance and a bundled test process, and Node's inherited test state and ESM package resolution caused misleading skipped tests and module-not-found errors.

**How to apply:** Reuse this setup when adding integration tests that spawn a fresh Node test process against a disposable database.
