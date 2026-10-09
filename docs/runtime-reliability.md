# Workflow runtime reliability

## Startup schema contention

CLI initialization and runtime startup use the same transaction-scoped PostgreSQL
advisory lock before applying the complete target schema. Successful startup still
requires every schema statement and validation to pass. Failed attempts roll back
all DDL before retrying only deadlocks (`40P01`) or lock timeouts (`55P03`).
There are at most four attempts, with a three-second lock timeout, a sixty-second
statement timeout and bounded exponential backoff. Invalid schema changes,
statement timeouts and exhausted contention fail startup rather than reporting
readiness. Locks and timeout settings are released at the transaction boundary.

## Runtime coordination

PostgreSQL is the source of truth for workflow commands and task state. NATS
JetStream is a wake-up channel, not the durable owner of a task.

The dispatcher advances independent workflow runs and publishes claimed task
wakeups with at most four concurrent operations per batch. Already-committed
wakeups are published before advancing another workflow batch. A slow authority
request therefore does not serially block unrelated work. Each run retains its
transaction lock and fresh authorization; each publication retains its durable
claim and idempotent executor assignment. Started operations settle before a
batch error returns. This does not increase worker capacity or run timeouts.
Unresolved child invocation records also fence terminal parent outcomes until
their results are reconciled, even if a concurrently advanced child is already
terminal. Preserved failure-notification calls finish before parent failure.

Required CI passes its isolated PostgreSQL connection settings through Turbo
only to test tasks (`DATABASE_URL`, `BEAM_TEST_POSTGRES_URL`, and
`ASSISTANT_TEST_DATABASE_URL`). Database-backed
composition and authorization suites must execute rather than silently skip
because of strict environment filtering. Test results are not cached.
Disposable database fixtures close their pools before dropping databases without
forced connection termination. Leaked connections fail teardown instead of
being hidden by forced drops or surfacing as unrelated socket errors.
Dynamic-region cancellation remains requested until owned execution and cleanup
reconcile. Repeated pending requests preserve the original request record and
timestamp and do not emit duplicate cancellation events.

`WORKER_CONCURRENCY` limits active actions inside one worker process.
`WORKER_FLEET_CONCURRENCY` sets `max_ack_pending` on the shared durable
consumer and must equal the sum of local concurrency across worker replicas.
Every worker reconciles an existing durable consumer to that fleet value at
startup, so scaling a deployment does not leave the shared queue pinned to the
capacity of one process. Worker-specific direct consumers remain limited by
the local `WORKER_CONCURRENCY` value. At startup, workers remove stale inactive
direct worker consumers left by previous container ids, while preserving any
consumer with pending messages, acknowledgements, or active pull waiters.

Workers share durable pull consumers and request work only up to their local
capacity. This keeps long-running tasks available to idle replicas instead of
prefetching them behind work already running in another process.
Idle workers renew bounded pull requests before NATS pull expiration, so a
scheduled workflow that starts after a quiet period still fans out across the full
worker fleet instead of collapsing onto the last worker that handled work.

Workers send JetStream progress acknowledgements while a task handler is alive.
This allows `NATS_TASK_ACK_WAIT_MS` to stay short enough for fast restart
recovery without redelivering healthy long-running transfers. Startup
reconciliation updates both the shared durable consumer capacity and its
`ack_wait`, so old broker state cannot leave a newly scaled deployment pinned
to stale delivery settings.
Every PostgreSQL pool is created by `createPostgresPool` (`packages/db`), which
always attaches the idle-connection error handler, and the synchronous bridge
used by the API store and the MCP server (`openSynchronousPostgres`) reconnects
on the next query. So the API, MCP server, orchestrator and workers log a
database restart through their service logger (credential-free fields only) and
recover without a process restart. While PostgreSQL is unreachable, API routes
answer `503 database_unavailable` (`retryable: true`) and MCP requests a JSON-RPC
`503`, instead of the process exiting.

The API `/health` and `/studio/health` and the MCP `/health` include a
`database` check and answer `503` while PostgreSQL is unreachable, like the
worker's `/health`; they return to `200` on their own once it is back. The
compose healthchecks only mark the container unhealthy: `restart:
unless-stopped` acts on process exit, not on health, so an outage does not
start a restart loop. After an update, the updater's probe of the API
`/health` therefore also confirms that the API reaches its database.

A reference deployment runs twelve worker replicas with local
concurrency `1`, fleet concurrency `12`, and a 60-second NATS task ack wait.
This gives the scheduled 1 TB transfer workflow enough headroom to launch all ten
100 GB workflow lanes together, even if a prior finalizer or recovery task is
still settling, while preventing one worker process from claiming multiple
long-running transfer actions.
Worker replicas roll as one stateless batch during deploys so the
fleet does not spend minutes split across old and new task-consumer logic.

## Durable command publication

`execution.command_outbox` exposes every durable command and its delivery
state. API-created runs insert a `workflow_run.queued` command in the same
transaction as the queued run. The orchestrator consumes those commands via
PostgreSQL and also polls queued runs, so a missing command notification cannot
strand a run.

Each task attempt inserts a `workflow_task.wakeup` command in the same
transaction as the task. The NATS message ID is `<task-id>:<attempt-number>`:
republication of one attempt is deduplicated by JetStream, while a real retry
gets a new message ID. Publication failures remain `pending` with `last_error`,
`publish_attempts`, and a bounded retry delay. `publishing` rows have a
30-second claim lease so another orchestrator can resume after a publisher
crash. PostgreSQL polling recycles published wake-ups for tasks that remain
claimable, preserving recovery after a missed or lost NATS wake-up.

Useful operational query:

```sql
SELECT id, command_type, aggregate_id, state, publish_attempts,
       available_at, claim_expires_at, published_at, last_error, updated_at
FROM execution.command_outbox
ORDER BY updated_at DESC;
```

The orchestrator also exposes aggregate state at
`GET /commands/publication` and Prometheus gauges under
`beam_orchestrator_command_outbox_*` on `GET /metrics`.

## Crash boundaries

Execution authority unavailability is a retryable 503, distinct from a confirmed
403 revocation. The dispatcher defers the affected run until a fresh check
succeeds. A worker cannot renew its lease without that successful check; during
a temporary outage its existing deadline and cancellation polling still apply.
If authority remains unavailable, the original lease expires and stops work.
Before resolving or starting an action, the Runner also waits for fresh authority
under that same claim and cancellation fence, with bounded backoff. Temporary
unavailability at this boundary does not launch an action or consume another
business attempt. Only typed authority unavailability is retried; confirmed
denial and invalid configuration remain terminal. One sanitized warning per
claimed task records a deferred launch without credential or request data.
Confirmed revocation still aborts immediately. Billing reservations retain their
durable identity when the billing authority is temporarily unavailable. No
permission decision is cached, and no outage extends a workflow timeout.
Permission probes read only authorization fields. Periodic run checks omit the
immutable child dependency tree unless checking a specific workflow-call step;
they never load completed outputs merely to renew execution authority.


| Boundary                                                      | Durable state                                          | Recovery                                                                                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API stops before commit                                       | No run or command is visible                           | The caller can safely retry.                                                                                                                                                                   |
| API stops after commit                                        | Queued run and run command are both visible            | Orchestrator PostgreSQL polling activates the run without requiring NATS.                                                                                                                      |
| Orchestrator stops after task commit                          | Task and per-attempt wake-up are both visible          | A later orchestrator claims and publishes the pending command.                                                                                                                                 |
| NATS is unavailable                                           | Wake-up stays pending with the error and attempt count | The resilient broker reconnects on a later orchestration tick.                                                                                                                                 |
| NATS stores a message but its publish acknowledgement is lost | Outbox claim eventually expires                        | The same message ID is republished; JetStream deduplicates it.                                                                                                                                 |
| Orchestrator stops after claiming an outbox row               | Row stays `publishing` until its claim expires         | Another orchestrator reclaims it after 30 seconds.                                                                                                                                             |
| NATS wake-up is missed or NATS state is recreated             | PostgreSQL task stays queued or retry-scheduled        | Polling recycles/recreates its attempt wake-up.                                                                                                                                                |
| Two workers receive a wake-up                                 | PostgreSQL compare-and-set claim is authoritative      | Only one changes the task to `running` and increments counters. The other acknowledges and ignores it.                                                                                         |
| Worker disappears after claim                                 | Task lease remains durable and worker heartbeat stops  | Orchestrator reclaims it after the heartbeat is stale for 45 seconds, or at lease expiry, then moves it to `retry_scheduled` without incrementing attempts, or dead-letters an exhausted task. |
| Worker disappears with an unacked NATS message                | The broker redelivers after the short ack wait         | PostgreSQL remains authoritative; stale running tasks are recovered from worker heartbeat, and healthy tasks keep extending their broker wait with progress acknowledgements. |
| PostgreSQL is unavailable after a worker claim                | The committed claim and lease remain authoritative     | No partial terminal state commits; after connectivity returns, lease recovery schedules the next claim.       |
| Worker is healthy during a long wait                          | Worker renews its tokenized lease                      | Lease recovery ignores the task.                                                                              |
| Old worker returns after rescue                               | Its claim token no longer matches                      | Completion/failure writes affect zero rows and cannot overwrite the new owner.                                |
| Completed-task notification is delivered again                | Task is terminal and unclaimable                       | Worker acknowledges and ignores it; no event or output is duplicated.                                         |
| Cancellation arrives during Registry wait                     | Orchestrator cancels task/step and clears the lease    | The worker's cancellation poll detects lease loss within `WORKER_CANCELLATION_POLL_INTERVAL_MS`, aborts the action so provider cleanup can run, and stale completion cannot commit. |
| Required action throws with `retryable: false`                 | Task becomes `dead_letter` with reason `non_retryable` | The worker terminalizes the task, step, and workflow once without emitting `TaskRetryScheduled`.               |
| Final attempt fails or its lease expires                      | Task becomes `dead_letter`                             | A unique `workflow_task_dead_letters` row is inserted once and the run fails once.                            |

## Repeatable verification

`pnpm test:runtime-reliability` creates a uniquely named disposable PostgreSQL
database, applies the target schema, starts a temporary file-backed NATS
JetStream server on an unused local port, and drops all state afterward. It
uses only the Registry `@beam/e2e-wait` action. Set `BEAM_TEST_POSTGRES_URL` if
the PostgreSQL maintenance database is not available at
`postgresql:///postgres`.

The suite covers NATS outage and recovery, outbox publisher crash/restart,
missed wake-up polling, duplicate completed delivery, two-worker claim races,
PostgreSQL loss after claim, expired and stale-worker leases, healthy leases,
per-claim counters, retryable execution failures, immediate non-retryable
dead-lettering, one durable max-attempts dead-letter,
pre-claim cancellation, and cancellation during wait execution.
