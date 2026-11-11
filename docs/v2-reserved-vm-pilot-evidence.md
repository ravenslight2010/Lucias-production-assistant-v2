# V2 Reserved VM pilot evidence

**Status: incomplete.** Local process and database checks passed. A live VM
deployment startup and API health response have now been observed, and the
production synthetic-marker query returned zero rows. V2 API and worker pool
instrumentation now records sanitized connection lifecycle counts. It has not
yet been deployed for a measured restart overlap, so the production connection
peak remains unverified.

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

## Live deployment spot-check

Observed 2026-11-11 02:24 UTC from the V2 published deployment. No V1 endpoint,
database, or credentials were accessed.

- Deployment metadata reported an active deployment, type `vm`, and a
  successful current build. The configured target in this project is `vm`;
  the exact machine configuration was not independently inspected in the
  Publishing UI.
- The latest observed build was created at 2026-11-11 02:20:38 UTC and
  succeeded at 02:23:30 UTC. Build logs recorded creation of a new VM.
- Runtime logs recorded the API listening on port 8080 at 02:23:06 UTC and the
  worker database check succeeding at 02:23:07 UTC.
- `GET /api/healthz` returned HTTP 200 with `{"status":"ok"}` at 02:24:19 UTC.
  The health route executes a database `SELECT 1` before returning success.
- Deployment health checks briefly failed while the new API process was
  starting; the API then became ready and health returned 200. The logs do not
  establish when the previous VM shut down or whether requests were interrupted.
- A read-only production query at 2026-11-11 02:53 UTC found zero facilities
  named `Synthetic V2 deployment pilot marker`.
- The production read replica reported `max_connections = 450`,
  `superuser_reserved_connections = 4`, and `reserved_connections = 0`. This
  gives 446 application-usable connections and a rounded-down 80% planning
  ceiling of 356. These are capacity settings, not an overlap measurement.
- A `pg_stat_activity` sample from the production read replica showed one
  connection. Because production SQL reads use a replica, that value is not a
  count of application connections to the primary and cannot establish the
  publish/restart peak.
- Replit endpoint monitoring for 2026-11-11 02:20–02:40 UTC recorded two
  `/api/healthz` requests with zero 4xx/5xx responses and 213.5 ms average
  latency, plus nine `/__ready` requests with zero 4xx/5xx. Startup readiness
  failures are separately recorded in deployment logs; endpoint metrics do not
  establish whether the old VM shut down cleanly.
- The deployment time-series metric query was unavailable. The documented
  database Monitoring views show active-query snapshots and query-performance
  statistics, not a historical total-connection peak.
- The observed VM creation is evidence of a published VM startup, but it does
  not establish a separate full compute restart, a harmless update independent
  of that publish, or the database connection peak during overlap.

## V2 application pool instrumentation

The API and worker emit structured `v2_db_pool` observations at process
startup, on each physical pool connection creation or removal, and at
shutdown. Each observation contains a UTC timestamp, an ephemeral process
instance ID, the V2 service name, current open/idle/waiting counts, the
process-local open-connection peak, and the configured pool maximum. It does
not include a database host, URL, user, SQL, or V1 identifier. The event-based
records avoid periodic sampling gaps and allow the open connection count to be
reconstructed for each instrumented process.

To capture the production replacement peak, first deploy this instrumentation
to the authorized V2 deployment, then perform a separate V2 compute restart
or publish/restart overlap while both the outgoing and incoming V2 processes
are instrumented. The initial deployment cannot measure the outgoing
uninstrumented process. From the resulting `v2_db_pool` logs, order
observations by `observedAt`; retain the original log order when timestamps
match. Track the latest `connectionsOpen` value for each `instanceId`, and sum
active V2 API and worker instances at each event to find the overlap peak. A
`shutdown` observation removes that instance from subsequent totals. Record
only the UTC capture interval, the summed peak, the 80% planning ceiling (356),
and the resulting headroom or exceedance here.
The deterministic fixture in `artifacts/api-server/test/db-pool-metrics.test.mjs`
reconstructs a 12-connection peak across overlapping API and worker instances;
it verifies the aggregation behavior and is not a production measurement.
Exclude replica `pg_stat_activity` values from this calculation; they do not
measure primary application connections. Do not access V1.

## Remaining gates

- Confirm the exact Reserved VM machine configuration in the Publishing UI.
- Exercise a full compute restart and a separate harmless published update;
  verify API and worker recovery after each.
- Deploy the pool instrumentation to V2, then capture the actual connection
  peak during an instrumented V2 replacement overlap and compare it with the
  356-connection planning ceiling.

Do not treat the V2 pilot as passed until the remaining live-deployment checks
are completed in an authorized V2 deployment environment.
