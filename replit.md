# Lucia’s Production Assistant V2

A secure production operations app for facility teams to create and control runs while keeping confirmed state aligned across devices.

## GitHub sync

When GitHub `main` is updated outside Replit, issue **Replit sync: pull latest GitHub main** (`label: replit-sync`) is opened/updated automatically. Pull before continuing:

```bash
git fetch origin && git pull --ff-only origin main
corepack pnpm@9.15.9 install --frozen-lockfile
```

Details: `docs/replit-github-sync.md`.
The patched lockfile was verified with PNPM 9.15.9; GitHub CI installs PNPM 9.
The current Replit shell's PNPM 10 rejects this patched lockfile, so use the
Corepack command above and do not regenerate the lockfile under PNPM 10.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/lucia-production-assistant-v2 run dev` — run the V2 web app
- `corepack pnpm@9.15.9 run typecheck` — full typecheck across all packages
- `PORT=4173 BASE_PATH=/ corepack pnpm@9.15.9 run build` — typecheck + build all packages
- `corepack pnpm@9.15.9 --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `corepack pnpm@9.15.9 --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — this V2 project's PostgreSQL connection string
- Authentication uses the Replit-managed Clerk setup; do not add V1 credentials.

## Stack

- pnpm 9.15.9 workspaces, Node.js 24, TypeScript 5.9
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

- Facility identity, membership, invitations, revision-safe run lifecycle, run history, editable facility station lineups, and active-run dashboard summaries are implemented. Active cards include shared line time, station case counts, and preparation status.
- Station status and elapsed timers follow the shared production-line timer. Revision-checked per-station counts and a station-level preparation status exist. Track each imported early-pull instruction as its own saved checklist item; do not invent station assignments when the source does not provide one. The checklist supports retry-safe, revision-checked status changes. Signed-in multi-session floor verification remains incomplete.
- Workbook import supports product specifications, dough, cheese, sauce, premix, shipping references, name cleanup, and schedule-created planned runs. Run requirements are captured from reviewed source data. The signed-in real-workbook-to-floor day-plan path still needs end-to-end verification.
- The run-requirements planner is pre-run calculation and source review. Run detail also shows count-based station progress; broader live production math still needs the golden-fixture and floor-flow checks listed in `docs/purpose-completion-status.md`.
- Inventory supports facility balances/adjustments and run-level actual-use confirmation. The full confirmed-production-to-on-hand deduction path still needs end-to-end verification.
- Run-tied ounce quality checks, customer-spec tolerances, and finished-weight ranges are implemented. Unfamiliar applicator rows remain unresolved until reviewed. The dashboard now summarizes failed and unresolved checks; the signed-in import-and-record path still needs end-to-end verification.
- The separate-project Reserved VM pilot is still unverified; continue using only synthetic data in the disposable V2 database.

### Purpose-first build order

1. Harden the day-plan import path from real workbooks into runs and station preparation. Follow the user's workbook priority: product specs, dough, cheese, sauce, mix/premix, shipping, then schedule; ignore schedule dates earlier than the import date.
2. Complete station execution: progress, counts, and preparation pulls against the facility lineup, while every station continues to follow the line timer.
3. Finish and verify live production math on V2 run/station state; do not port the V1 sync engine.
4. Verify inventory deductions from confirmed run or station use; use a new physical count for any inventory cutover.
5. Verify minimal run-tied quality checks and dashboard response to failed or unresolved checks.
6. Complete dashboard coherence and mobile floor usability; defer templates, broad multi-day lookahead, advanced shipping/allergen programs, and AI diagnostics until a full day can run on V2.
7. Keep workspace CI and the lockfile green; do not push to GitHub main until the required checks pass.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
