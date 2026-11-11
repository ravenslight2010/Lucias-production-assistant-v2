# V2 Reserved VM pilot evidence

**Status: incomplete.** Local process and database checks passed. The live
Reserved VM publish and full deployment restart were not tested from this task
fork, so this evidence does not clear the feature-work gate.

## Boundary and data

- The project owner confirmed this workspace is intended to be V2.
- The API and worker use this project's `DATABASE_URL`; no V1-specific
  database variable or connection was configured.
- The Replit development database's six application tables were empty before
  the pilot test.
- The worker created one synthetic facility marker. The API health check read
  it successfully. The marker was deleted, and all six application tables
  were confirmed empty afterward.
- No V1 rows, credentials, or production payloads were read or written.

## Process and health checks

- The API and worker ran as separate child processes under one supervisor.
- API database pool maximum: 4 connections.
- Worker database pool maximum: 2 connections.
- The worker was terminated once. The supervisor restarted it after one second.
  API health returned HTTP 200 during and after the worker restart; both
  processes confirmed the synthetic marker was visible in the same database.
- The complete local API/worker service was restarted. Both processes started
  again, the worker database check passed, and API health returned HTTP 200.
- `pnpm run typecheck` and `pnpm --filter @workspace/api-server run build`
  passed.
- No user-facing error or log included database credentials or synthetic row
  contents.

## Sanitized connection budget

Source: project-local Replit development PostgreSQL settings and a
`pg_stat_activity` sample during the supervised local run. Sample time:
2026-11-11 00:33:28 UTC.

| Measurement | Value |
| --- | ---: |
| Database `max_connections` | 112 |
| Reserved PostgreSQL connections | 4 |
| Application-usable ceiling | 108 |
| 80% planning ceiling | 86 |
| API pool maximum | 4 |
| Worker pool maximum | 2 |
| Steady-state configured pool total | 6 |
| Two-stack replacement overlap estimate | 12 |
| Additional monitoring/admin planning reserve | 4 |
| Planned overlap plus reserve | 16 |
| Observed open connections in the sample | 3 |

The planned overlap plus reserve is 14.8% of the 108 application-usable
connections, below the 80% planning ceiling. The sample is a point-in-time
observation, not a measured deployment-restart peak. The replacement-overlap
and monitoring/admin figures are budget estimates, not observed production
counts.

## Remaining gates

- The project is configured for a VM deployment and its API production command
  starts the supervised API and worker.
- The project currently has no published deployment. Therefore the actual
  Reserved VM runtime type, harmless publish behavior, full deployment restart,
  production database availability, and real publish-overlap connection peak
  remain unverified.
- This workspace is a task fork. Live publishing was not performed here.

Do not treat the V2 pilot as passed until the remaining live-deployment checks
are completed in an authorized V2 deployment environment.
