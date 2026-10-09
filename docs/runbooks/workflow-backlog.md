# Runbook: workflow backlog

Alert: `BeamWorkflowBacklogHigh`.

1. Confirm both queue depth and oldest age on the Beam Runtime Operations dashboard.
2. Check `beam_workers{status="healthy"}` and worker `/health`; follow the stale-worker runbook if capacity disappeared.
3. Compare `beam_orchestrator_command_outbox_pending` with `pending_with_error`. A publication backlog with errors points to NATS connectivity; a task backlog without publication errors points to worker capacity or blocked actions.
4. Use the oldest run's `workflowRunId` to search correlated events, traces, and logs. Never use it as a metric label.
5. Restore NATS/worker capacity or correct the blocked action. Do not manually change task status, lease, attempts, or outbox state.
6. Verify oldest age and depth fall continuously before resolving the alert.
