# Runbook: workflow failure rate

Alert: `BeamWorkflowFailureRateHigh`.

1. Split `beam_workflow_action_executions_total` by bounded `status` and `action_source`.
2. Compare retry and dead-letter rates by `reason`; an `expired_lease` spike indicates worker loss, while `action_failure` suggests action inputs/configuration or a dependency failure.
3. Select a failed run in the product and follow its `workflowRunId` through API, orchestrator, NATS, and worker spans.
4. Inspect redacted worker logs and the durable workflow event journal. Obtain secrets only from the approved credential system, never telemetry.
5. Inspect a failed workflow call's child run and public-contract error. Retry retains frozen definitions and completed child outputs; correcting a definition requires a fresh launch. Wait for descendant cancellation before retrying. Historical runs without a frozen revision require a fresh launch. See [Workflow composition](../workflow-composition.md).
6. Confirm the 10-minute failure ratio returns below 10% and no new dead letters appear.
