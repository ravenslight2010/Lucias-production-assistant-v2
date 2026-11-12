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
- The separate-project Reserved VM pilot remains unverified. Feature work may continue with a disposable V2 database and synthetic data, but do not claim operational readiness or perform production cutover until the VM configuration, compute restart, harmless published update, and instrumented connection-overlap check are verified. Never test against V1.

## Product

Lucia's Production Assistant is for pizza-line production planning, scheduling, and inventory for floor staff. V2 is a purpose-first rebuild, not a feature-for-feature V1 clone. Keep the V2 facility, revision, idempotency, and transaction model; never restore V1 credentials, databases, or synchronization stacks.

### Current capabilities and gaps

- Facility identity, membership, invitations, revision-safe run lifecycle, run history, dashboard summaries, and editable facility station lineups are implemented.
- Station status and elapsed timers follow the production-line timer. Per-station counts, pulls, and stage confirmation are still incomplete.
- Workbook import supports product profiles, name cleanup, and schedule-created planned runs. Schedule runs now carry reviewed, separately calculated requirement snapshots, but the real-workbook-to-floor day-plan path remains partial and must be verified before calling V2 purpose-complete.
- The run-requirements planner is pre-run calculation and source review. It is not the live station production calculator.
- Inventory deduction from confirmed production and minimal run-tied quality checks are not implemented.
- The separate-project Reserved VM pilot is still unverified; continue using only synthetic data in the disposable V2 database.

### Purpose-first build order

1. Harden the day-plan import path from real workbooks into runs and station preparation. Keep the user's workbook-family priority in the V1 import-to-run memory.
2. Complete station execution: progress, counts, and preparation pulls against the facility lineup, while every station continues to follow the line timer.
3. Build trusted live production math on the V2 run and station state; do not port the V1 sync engine.
4. Deduct inventory from confirmed run or station events; use a new physical count for any inventory cutover.
5. Add only minimal quality checks tied to a run.
6. Defer templates, broad multi-day lookahead, advanced shipping/allergen programs, and AI diagnostics until a full day can run on V2.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
