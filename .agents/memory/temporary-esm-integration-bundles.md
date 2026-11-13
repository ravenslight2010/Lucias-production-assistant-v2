---
name: Temporary ESM integration bundles
description: Module resolution constraints when the PostgreSQL test runner bundles API integration tests as temporary ESM.
---

Externalized packages in a temporary ESM test bundle are resolved relative to the bundle's output directory, not the runner's working directory. In this workspace, the API server and database test packages expose different dependencies through separate `node_modules` trees. Bundles that externalize `pg` should resolve from `lib/db/tests`; ESM bundles that include CommonJS dependencies with dynamic `require` also need the API build's `createRequire` banner.

**Why:** Integration tests that import the API router need Express and Clerk packages while still resolving the database driver's dependencies.

**How to apply:** When changing the integration bundle's imports or output path, confirm that every external package can resolve from the temporary bundle location; use a temporary `node_modules` link when the dependency trees are split, and preserve the `createRequire` banner when bundled CommonJS modules need native Node imports.
