# Runtime observability

Beam correlates API requests, durable workflow events, task outbox payloads,
NATS messages, worker spans, and structured logs with the workflow run ID. The
API accepts a valid `X-Correlation-Id` for the request, but once a workflow run
is committed its `workflowRunId` becomes the durable `correlationId` returned
in the response and written to `execution.workflow_events.correlation_id`.

Trace propagation uses W3C `traceparent`. The API stores it under
`workflow_runs.metadata_json.observability`; the orchestrator creates a child
context in task metadata and the durable task wake-up payload; NATS transports
that context to the worker. Losing or receiving an invalid `traceparent` starts
a new trace without blocking workflow execution.

## Cardinality contract

Metric label schemas are fixed in `@beam-studio/telemetry`. Labels
containing run, task, worker, user, credential, token, URL, UUID, email, or
other IDs are rejected. Dynamic values are mapped to bounded enums, route
series are capped, and excess series collapse into `overflow`. IDs remain in
traces and logs, where they are needed for correlation and are not metric
dimensions.

Action labels expose only `builtin`, `registry`, or `unknown`. Placements expose
only `local-workers`, `specific-worker`, `execution-location`, `unassigned`, or
`unknown`. Never add package names, organization IDs, workflow IDs, subjects,
worker IDs, signed URLs, or error messages as metric labels.

## Metric semantics

| Metric                                   | Type      | Meaning                                                              |
| ---------------------------------------- | --------- | -------------------------------------------------------------------- |
| `beam_api_requests_total`                | counter   | Completed API requests by method, route template, and status class.  |
| `beam_api_request_duration_seconds`      | histogram | API response latency.                                                |
| `beam_workflow_runs_total`               | counter   | Confirmed durable run transitions by service, trigger, and status.   |
| `beam_workflow_tasks_queued_total`       | counter   | Tasks committed to PostgreSQL.                                       |
| `beam_workflow_task_claims_total`        | counter   | Claims returned after transaction commit.                            |
| `beam_workflow_task_duration_seconds`    | histogram | Worker attempt duration by task kind, action source, and outcome.    |
| `beam_workflow_task_retries_total`       | counter   | Retry transitions confirmed by the conditional durable update.       |
| `beam_workflow_task_dead_letters_total`  | counter   | Dead-letter transitions confirmed by the conditional durable update. |
| `beam_workflow_action_executions_total`  | counter   | Worker action outcomes.                                              |
| `beam_workflow_action_blocked_total`     | counter   | Permission, configuration, trust, or sandbox blocks.                 |
| `beam_workflow_placements_total`         | counter   | Bounded placement decisions for committed tasks.                     |
| `beam_nats_messages_total`               | counter   | Publish, receive, ack, nak, and dead-letter transport outcomes.      |
| `beam_workflow_queue_depth`              | gauge     | Current queued, retry-ready, running, and dead-letter task counts.   |
| `beam_workflow_queue_oldest_age_seconds` | gauge     | Age derivable from the oldest scheduled queued/retry-ready task.     |
| `beam_workers`                           | gauge     | Worker counts grouped into healthy, stale, draining, and stopped.    |
| `beam_worker_heartbeat_age_seconds`      | gauge     | Stalest observed heartbeat age, supporting staleness alerts.         |
| `beam_orchestrator_command_outbox_*`     | gauges    | Durable task publication backlog, errors, and oldest age.            |

Retry and dead-letter counters are updated only after the conditional database
transaction commits. A duplicate NATS delivery that cannot claim a task does
not increment claim, retry, or dead-letter counters.

## Redaction and exporter failure

Telemetry recursively redacts authorization, cookies, credentials, passwords,
secrets, signatures, tokens, API/access keys, and signed URLs before exporting
spans or logs. Action logger payloads use the same redaction. Do not attach raw
workflow inputs, credential payloads, artifact URLs, or exception objects to
telemetry.

`/health` and `/metrics` return `503` with a bounded, non-sensitive response
when their exporter check fails. The API and MCP `/health` also return `503`
with `checks.database: "unavailable"` while PostgreSQL is unreachable. Export failures never alter claim, retry,
dead-letter, or NATS acknowledgement behavior. Tests use only in-memory metric,
trace, and log exporters.

## Local operations

The dashboard and four initial alert rules are in `observability/`. Thresholds
are starting values for local validation and should be calibrated with real
traffic before production use. Runbooks are in `docs/runbooks/`.
