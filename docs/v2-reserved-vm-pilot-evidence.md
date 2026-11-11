# V2 Reserved VM pilot evidence

**Status: incomplete.** The latest published build uses the confirmed 1 vCPU /
4 GiB configuration, replaced the VM, and the API and worker recovered.
Production pool-event logs still have sequence gaps and missing shutdown
records, so no reliable overlap peak can be reported.

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
  successful current build. The user reported a machine configuration of
  1 CPU and 4 GiB RAM, which the latest build configuration also confirmed.
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

### Latest instrumented update

A read-only SRE investigation identified the latest update build as created at
2026-11-11 16:26:07 UTC and successful at 16:28:39 UTC. The build configuration
confirmed 1 vCPU and 4 GiB RAM.

- Startup health checks briefly failed from 16:28:09–16:28:21 UTC. The API was
  listening and the worker database check succeeded by 16:28:21 UTC; health
  returned HTTP 200 at 16:28:44 UTC.
- Pool logs were present for both API and worker instances. Each process
  recorded a local peak of one open connection, with zero waiting requests.
  These process-local values do not prove an old/new instance overlap peak.
- Aggregate `compute_uptime` fell from about 50,759 seconds to 179 seconds
  around 16:31 UTC. Available telemetry has no instance count or instance ID,
  so this does not prove a user-triggered full compute restart or overlap.
- Monitoring covered a low-volume window and showed no persistent API or
  database failure after startup. It was not a load test.

### Separate no-schema-change publish

A read-only SRE investigation identified the next publish build as created at
2026-11-11 16:43:43 UTC and successful at 16:46:35 UTC. It used 1 vCPU and
4 GiB RAM.

- Startup health checks briefly failed from 16:46:04–16:46:15 UTC. The API
  started at 16:46:15 UTC, the worker database check passed at 16:46:16 UTC,
  and `/api/healthz` returned 200 at 16:46:42 UTC.
- Outgoing API and worker processes logged zero-connection shutdowns at
  16:46:27.651 and 16:46:27.643 UTC. Incoming API and worker startup events
  occurred about 12 seconds earlier, confirming instrumented process overlap.
- The pool-event capture is incomplete: outgoing API and both incoming
  processes have `remove` events without a preceding `connect` event. Incoming
  local peak fields report one, but the missing transitions make the summed
  overlap subtotal unreliable. Do not report it as a measured peak.
- Pool instrumentation did not yet include a per-process event sequence, so
  this capture cannot distinguish an omitted log event from a source gap.
- The process IDs in these logs are not VM identifiers. No user-triggered full
  compute restart is evidenced.
- Post-start monitoring showed no persistent API or database failure. It was
  not a load test.

### Event-sequenced telemetry publish

A read-only SRE investigation identified the latest build as created at
2026-11-11 17:01:58 UTC and successful at 17:04:46 UTC. It used 1 vCPU and
4 GiB RAM.

- Startup health checks briefly failed through 17:04:23 UTC. The API started
  at 17:04:25 UTC, the worker database check passed at 17:04:25 UTC, and
  `/api/healthz` returned 200 at 17:04:52 UTC.
- The outgoing processes were from the prior build and did not include
  `eventSequence`. They logged zero-count shutdowns at 17:04:37 UTC.
- The incoming worker sequence was contiguous from 1 through 18 in the
  observed window. The incoming API sequence was 1, 3, 4, 5: sequence 2 is
  missing, and its first removal has no matching recorded connection.
- The complete paged log query returned 129 matching records through
  17:08:27 UTC, but the API sequence gap makes the overlap capture incomplete.
  Do not report a measured peak from it.
- Build logs show VM creation during this publish and aggregate uptime reset.
  These indicate publish-time replacement, not a separate user-triggered full
  compute restart.

## V2 application pool instrumentation

The API and worker emit structured `v2_db_pool` observations at process
startup, on each physical pool connection creation or removal, and at
shutdown. Each observation contains a UTC timestamp, an ephemeral process
instance ID, a monotonically increasing per-process `eventSequence`, the V2
service name, current open/idle/waiting counts, the process-local open-connection
peak, and the configured pool maximum. It does not include a database host, URL,
user, SQL, or V1 identifier. The event-based records avoid periodic sampling
gaps and allow the open connection count to be reconstructed for each
instrumented process when the sequence and lifecycle checks pass.

The 17:01 UTC published build emits `eventSequence`. Use sequence checks in the
next production capture; the API gap above must not be treated as complete.

### Republish after restart guidance

A read-only SRE investigation identified the latest successful build as
`05415e3e-30c5-4304-b839-f1aa2e1229ab`, created at 2026-11-11 19:31:57 UTC and
successful at 19:34:41 UTC. Its published machine configuration is
**0.5 vCPU / 2 GiB** (`e2-small`), which does not match the user's stated
1 vCPU / 4 GiB target.

- Build logs show a new VM being created from 19:33:06–19:33:26 UTC. The
  incoming API and worker processes started around 19:34:20 UTC; the prior API
  and worker shut down at 19:34:32 UTC. This publish replaced the running VM.
- Worker database check passed at 19:34:21 UTC. `/api/healthz` returned HTTP
  200 at 19:34:21 and 19:34:49 UTC. Startup checks had returned HTTP 500
  through 19:34:19 UTC while the service was starting.
- The outgoing worker stream was contiguous, sequences 1–598, and ended with a
  zero-open, zero-waiting shutdown. The outgoing API stream has sequence 2
  missing and an unmatched remove event.
- The incoming worker stream was contiguous through sequence 44 in the query
  window, but was still running and had no shutdown event. The incoming API
  stream begins at sequence 2 (missing startup sequence 1) and has no shutdown.
- The paged log queries were fully read, but the missing API events make the
  pool capture incomplete. Do not report a measured restart-window peak or
  compare a partial subtotal to the 356-connection planning ceiling.
- This user-triggered republish replaced the deployed VM; it is not evidence of
  an in-place compute restart. The next attempt must first use the requested
  1 vCPU / 4 GiB setting and then repeat the pool-event completeness checks.

### Corrected-capacity republish

A read-only SRE investigation identified build
`4218f825-c960-48c3-b64f-e02b5fc7dfb1`, created at 2026-11-11 20:53:18 UTC and
successful at 20:56:13 UTC. It uses the requested **1 vCPU / 4 GiB**
configuration (`n1-custom-1-4096`).

- Build logs recorded VM creation from 20:54:27–20:54:37 UTC. New API and
  worker processes started at 20:55:49 UTC, confirming deployment replacement.
- The worker database check passed at 20:55:50 UTC. The API listened on port
  8080 at 20:55:50 UTC, and `/api/healthz` returned HTTP 200 at 20:56:19 UTC.
  Startup checks had connection-refused/500 responses through 20:55:49 UTC.
- The incoming API and worker each show startup seq 1/open=0, then missing
  seq 2 and a remove at seq 3/open=0; sequence 2 is likely a missing connect
  record, but that event is not present in the captured logs. Later events
  continue, so process exit does not explain these initial gaps.
- The outgoing worker is contiguous through seq 326, but has no shutdown
  record. The outgoing API first appears at seq 2, with no startup or shutdown.
  A later paged query through 21:00:32 UTC found no outgoing shutdown record.
- Paged queries were complete and untruncated, but available production logs
  cannot distinguish an emitted line lost by stdout/log ingestion from an event
  that was never retained. No shutdown/pool-close errors were present in the
  queried logs; this does not rule out upstream loss or abrupt termination.
- The capture fails sequence and lifecycle completeness checks. Do not report
  a measured peak or compare a partial subtotal with the 356-connection
  planning ceiling.

### Check capture completeness before reporting a peak

Treat a capture as complete only when every observed `instanceId` has one
`startup` record with `connectionsOpen = 0`, followed by its lifecycle records
and one final `shutdown` record with `connectionsOpen = 0`. Each `connect`
record must increase that instance's open count by exactly one, and each
`remove` record must decrease it by exactly one. A first observed event other
than `startup`, a nonzero startup count, a missing shutdown at the end of the
capture, a connection-count mismatch, a shutdown with connections still open,
or any event after shutdown makes the capture incomplete. Each instance's
`eventSequence` must start at 1 with `startup` and increase by exactly one for
every subsequent event; a gap or duplicate indicates a missing or repeated log
record. An empty capture is incomplete as well. In particular, missing
`connect` or `remove` observations are surfaced by count mismatches or sequence
gaps.

If any check fails, label the reconstructed value a **partial observed
subtotal**, not a measured peak; it is not a reliable bound on the true peak.
Do not compare it with the planning ceiling as though it were a complete
measurement. Extend or recapture the log window so it includes each instance's
startup through shutdown, and investigate count mismatches before reporting a
peak. These checks detect lifecycle gaps and count discontinuities, but logs
whose omitted events happen to leave the counts consistent cannot be proven
complete from these fields alone. Confirm the logging source retained the
whole capture interval and reconcile the observed instances with the expected
API and worker processes; an instance with no captured records cannot be
identified from the pool observations alone.

To capture the production replacement peak, first deploy this instrumentation
to the authorized V2 deployment, then perform a separate V2 compute restart
or publish/restart overlap while both the outgoing and incoming V2 processes
are instrumented. The initial deployment cannot measure the outgoing
uninstrumented process. From the resulting `v2_db_pool` logs, order
observations by `observedAt`; retain the original log order when timestamps
match. First apply the completeness checks above. Only for a complete capture,
track the latest `connectionsOpen` value for each `instanceId`, and sum active
V2 API and worker instances at each event to find the overlap peak. A
`shutdown` observation removes that instance from subsequent totals. Record
only the UTC capture interval, the measured summed peak, the 80% planning
ceiling (356), and the resulting headroom or exceedance here.

A service emits its terminal `shutdown` observation only after its database
pool closes successfully. If `pool.end()` fails during API or worker shutdown
(including worker cleanup after a failed database check), no terminal event is
emitted: the event stream cannot prove the instance is gone, so do not remove it
from reconstructed totals based on a missing event. Treat the capture as
incomplete and investigate the corresponding shutdown error.

The deterministic fixture in `artifacts/api-server/test/db-pool-metrics.test.mjs`
reconstructs a 12-connection peak across overlapping API and worker instances;
it verifies both aggregation and lifecycle completeness and is not a
production measurement.
Exclude replica `pg_stat_activity` values from this calculation; they do not
measure primary application connections. Do not access V1.

## Preflight for the next published update

Observed 2026-11-11 15:58 UTC before the next V2 publish:

- Deployment metadata reported an active, public `vm` deployment with a
  successful current build.
- A read-only production `GET /api/healthz` returned HTTP 200 with
  `{"status":"ok"}`.
- The current V2 source contains the API and worker pool instrumentation.
  API/web typechecks and artifact builds passed; the session-cookie regression
  tests passed 3/3.
- At this preflight time, the current session-cookie fix and instrumentation
  had not yet been published. The later instrumented update is documented
  above; no restart-overlap measurement has been made.
- The user authorized the pilot. The prepared publish action remains
  user-initiated; no production database writes or V1 access occurred in this
  preflight.
- After the approved development-only constraint rewrite (2026-11-11 16:11
  UTC), the development table has one equivalent bounded-array check and its
  existing row still passes. A strict Drizzle push reports no further changes.
- The recomputed Publish diff now emits one `CHECK` wrapper for this table, with
  no structural data loss reported. Its broader compatibility flag remains
  true, so review any Publish warning before proceeding. Production was queried
  read-only and still has no `facility_station_layouts` table.
- The enum retry failure was traced to the same Publish diff: it added
  `run_status.planned` and then used that new value as the column default before
  the value could be committed. The development schema now keeps the existing
  production default (`draft`); the API explicitly writes `planned` for new
  runs. Development and production defaults match.
- The latest diff has 18 statements and only adds the `planned` enum value; it
  no longer sets the status default to `planned` in that transaction. No
  structural data loss or removals are reported. Review the remaining
  compatibility flag in Publish before confirming.
- The user corrected the Reserved VM size to 1 CPU and 4 GiB RAM.

## Remaining gates

- Determine whether the missing pool events are lost between Pino/stdout and
  the available Replit logs, or whether shutdown is not being delivered to the
  processes. The current telemetry cannot distinguish these causes.
- Capture a replacement window with complete startup-to-shutdown event streams
  for API and worker instances. Report a replacement peak only from a complete
  capture; compare it with the 356-connection planning ceiling.

Do not treat the V2 pilot as passed until the remaining live-deployment checks
are completed in an authorized V2 deployment environment.
