# Lucia’s Production Assistant V2

A secure production operations app for facility teams to create and control runs while keeping confirmed state aligned across devices.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/lucia-production-assistant-v2 run dev` — run the V2 web app
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — this V2 project's PostgreSQL connection string
- Authentication uses the Replit-managed Clerk setup; do not add V1 credentials.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/lucia-production-assistant-v2/` — V2 web app and run-control screens
- `lib/api-spec/openapi.yaml` — source of truth for API routes and data contracts
- `artifacts/api-server/src/routes/production.ts` — facility-scoped run endpoints
- `artifacts/api-server/src/lib/run-command-service.ts` — revision-checked lifecycle transactions
- `lib/db/src/schema/production.ts` — facility, membership, run, audit, receipt, and outbox tables

## Architecture decisions

- V2 is a separate Replit project with its own database and deployment; never connect it to V1 credentials or production data.
- The server is authoritative for facility and actor identity; lifecycle commands check revisions and stable idempotency keys.
- A lifecycle change, its receipt, audit event, and outbox event are committed in one database transaction.
- V1 historical runs are not imported; opening inventory at cutover must come from a new physical count.
- Do not implement additional V2 features until the separate-project Reserved VM pilot passes. Use a disposable V2 database and synthetic data to verify the supervised API/worker, shared database access, restart/publish behavior, and connection budget; never test against V1.

## Product

The current slice supports facility setup, draft run creation, run listing, and start/pause/resume/complete controls. Dashboard, run list, and run detail refresh periodically while online; offline views are read-only. Production stations, imports, automatic tracking, and inventory workflows are not implemented yet.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
