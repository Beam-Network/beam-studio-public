# Remote execution through the Beam Orchestrator

The Studio Action Dispatcher can delegate explicitly targeted actions through the
Beam Orchestrator. Studio Action Runner targets retain their own execution path.
This integration remains gated because the current connector does not confirm
remote cancellation or support authenticated lease renewal. See the
[common executor lifecycle and remaining gates](workflow-executors.md).

`REMOTE_EXECUTION_ENABLED` defaults to `false`. The Node subprocess modes
`sandboxed-esm` and `trusted-node` described in
[Worker Action Runtime](worker-action-runtime.md) belong to `apps/worker`.
Here, Studio sends a sandbox profile to an external Beam Worker through the
Beam Orchestrator; selecting `wasi` or `oci` does not enable those runtimes in
the Studio worker.

## Transport

Studio and the Beam Orchestrator share NATS JetStream, but use dedicated subjects:

```text
Studio Action Dispatcher -> beam.workloads.studio.tasks   -> Beam Orchestrator
Studio Action Dispatcher <- beam.workloads.studio.results <- Beam Orchestrator
```

Before publication, Studio transactionally claims the PostgreSQL workflow task,
creates a stable attempt, and materializes the locked workflow/action snapshot.
The JetStream payload contains the action version, artifact checksum and download
capability, entrypoint, inputs, config, permissions, sandbox profile, and lease.

The Beam Orchestrator chooses a compatible Worker and executes the workload over WCP. Studio
commits a returned result transactionally to the workflow task, attempt, step,
events, and artifacts before replying `{"acknowledged":true}`. Duplicate and
stale results are handled idempotently. A failed attempt returns to Studio's
existing retry/dead-letter state machine.

## Local configuration

```dotenv
REMOTE_EXECUTION_ENABLED=true
REMOTE_EXECUTION_TASK_SUBJECT=beam.workloads.studio.tasks
REMOTE_EXECUTION_RESULT_SUBJECT=beam.workloads.studio.results
REMOTE_EXECUTION_OWNER_ID=beam-orchestrator
REMOTE_EXECUTION_LEASE_MS=3600000
REMOTE_EXECUTION_SANDBOX_RUNTIME=node-legacy
```

Configure the Beam Orchestrator against the same NATS server and Studio stream:

```bash
beam-orchestrator serve \
  --studio-nats-url nats://127.0.0.1:4222 \
  --studio-nats-stream BEAM_WORKFLOW_TASKS \
  --studio-nats-task-subject beam.workloads.studio.tasks \
  --studio-nats-result-subject beam.workloads.studio.results
```

Studio Action Runners only claim their own target category. Remote tasks use a
dedicated subject outside the Studio Action Runner's
`beam.workflow.tasks.*` filters.

For `node-legacy`, the selected Worker must enable the legacy Node sandbox. It
also needs either the checksum-pinned action under its configured action root or
a `registryArtifactUrl` in the locked Studio action snapshot. For OCI/WASI,
every action must provide a downloadable artifact compatible with that runtime;
`REMOTE_EXECUTION_ARTIFACT_URL_BASE` can provide a checksum-addressed local registry
fallback during integration testing.

Actions whose Registry media type is
`application/vnd.beam.builtin-action+json` are embedded functions rather than
executable artifacts. The Action Dispatcher rejects and rolls back their remote claim
until those actions are packaged and published in the Registry. Remote actions,
including the Registry version of `@beam/transfer`, can be delegated directly.

The current outgoing task sets `timeout_seconds` from the step timeout, falling
back to 300 seconds. It does not apply the Studio worker's manifest timeout
precedence or extended trusted-action timeout policy. It also sends an empty
`host_rpc_methods` list, so the Studio worker's host IPC capabilities must not
be assumed to be available on the delegated path.

Studio-to-Beam-Orchestrator cancellation propagation is not yet part of the NATS contract.
Cancelling a workflow makes a later result stale and harmless, but the remote
Worker continues until its assignment lease or execution completes.
