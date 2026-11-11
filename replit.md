# Lucia’s Production Assistant V2

A secure production operations app for facility teams to create and control runs while keeping confirmed state aligned across devices.

## GitHub sync

When GitHub `main` is updated outside Replit, issue **Replit sync: pull latest GitHub main** (`label: replit-sync`) is opened/updated automatically. Pull before continuing:

```bash
git fetch origin && git pull --ff-only origin main && pnpm install --frozen-lockfile
```

Details: `docs/replit-github-sync.md`.

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
- Clerk remains the V2 sign-in provider. The API issues a short-lived `v2_session` bound to the currently verified Clerk user and session; run requests still resolve facility membership and role from PostgreSQL on every request. Never accept or transfer V1 cookies, sessions, or credentials.
- A lifecycle change, its receipt, audit event, and outbox event are committed in one database transaction.
- V1 historical runs are not imported; opening inventory at cutover must come from a new physical count.
- The separate-project Reserved VM pilot is not yet complete: confirm the VM configuration, verify a compute restart and harmless published update, and measure the database connection peak during an instrumented overlap. The pilot is a gate before more feature work. Use only a disposable V2 database and synthetic data; never test against V1.

## Product

The current slice supports facility setup, draft run creation, run listing, and start/pause/resume/complete controls. Facility members can view the V1-map station lineup; owners and managers can edit it with revision checks. Dashboard, run list, and run detail refresh periodically while online; offline views are read-only. Station-level production operations, imports and synchronization, automatic tracking, and inventory workflows are not implemented yet.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
