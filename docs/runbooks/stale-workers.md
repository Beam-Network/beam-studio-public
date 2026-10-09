# Runbook: stale workers

Alert: `BeamWorkerStale`.

1. Confirm the stale count and `beam_worker_heartbeat_age_seconds` on the dashboard.
2. Check the worker operational `/health` endpoint, process status, PostgreSQL connectivity, and NATS connection logs.
3. If the worker is intentionally draining or stopped, verify its runtime status is accurate; otherwise restore the process or dependency.
4. Expect leases to expire and be recovered by existing retry/dead-letter rules. Do not clear leases or decrement attempts manually.
5. Follow affected `workflowRunId` values in traces and logs and watch `expired_lease` retry/dead-letter counters.
6. Resolve only after a fresh heartbeat is visible and queue age is decreasing.
