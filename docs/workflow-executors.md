# Workflow executor lifecycle

The Action Dispatcher selects the backend from the frozen action target. Studio
Action Runners, opted-in room members, and the gated remote transport share the
PostgreSQL assignment and result model in `packages/db/src/executor-assignments.ts`.
Workflow calls create child runs directly and do not receive executor assignments.
Durable wakeup commands select the backend from the saved step placement when
claimed; message metadata does not choose the executor. This also applies when
an existing pending command is recovered after a dispatcher restart.

`ExecutorBackend` exposes dispatch, lease renewal, cancellation, reconciliation,
and settlement. Its implementations run inside Studio services; the PostgreSQL
client in this internal interface is never sent to a managed agent. Transport
delivery carries a scoped invocation or wakeup, with assignment persistence before
computation. External-worker dispatch remains disabled.

## Durable ownership and settlement

An assignment identifies the backend, executor, task attempt, declared target,
lease, cancellation request, executor termination, and cleanup confirmation.
Result settlement locks the current task, run, step, and assignment. It rejects
stale claims and discards business output after cancellation or lease expiry.
Only the dispatcher finalizes workflow outcomes after evaluating failure handlers.

All backends use one transaction to settle task output, attempt, step, artifacts,
events, retry scheduling, and dead letters. A failed partition cancels its remaining
siblings. A duplicate result cannot repeat those writes.

Studio Runners enforce a local monotonic lease deadline independently of database
or authorization latency. State writes use the same claim fence as results, and
the action sees updated state only after it commits. Renewal cannot revive an
expired claim. Room members additionally fence control-session generations and
use their durable local invocation journal.

Cancellation keeps claims until executor termination and resource cleanup are
confirmed. The shared sandbox reports completion only after observing process
exit (or failure to spawn); sending a kill signal or waiting for a cleanup timeout
does not release execution ownership. Migration `0026_executor_resource_evidence.sql` adds API-owned resource
evidence separate from action business state. An action cannot certify cleanup by
writing `cancellationStatus` or a fabricated transfer status. Room cancellation
uses the original durable publication and source identity even after membership
or grants change. Failed delivery remains visible and retries use durable command
identities.
Final cancellation preserves the recorded authorization, timeout, or user reason
in run history and the terminal event so the underlying failure remains actionable.

Studio Runners and managed agents persist native process ownership before sending
an action to its sandbox. After an owner crashes, recovery fences delayed launch,
terminates matching controller/sandbox identities and observes their exit before
confirming process cleanup. Runner recovery uses the machine/namespace identity,
so a new Runner registration can reconcile the previous process's assignments.
See [durable process ownership](action-process-ownership.md) for the preparation
barrier, supported platforms and unavailable-evidence behavior. Lease expiry alone
does not establish cleanup; resource cleanup remains a separate requirement.

## Distributed actions

The PostgreSQL dispatcher reads partition/reduce configuration from the frozen
manifest. It creates single, map/reduce, or hierarchical-reduce plans; source
ordering, shard identity, and the declared parallelism bound are preserved.
Intermediate and final reductions are created under the parent-run lock, so
concurrent dispatchers create each reduction once. Room recipients are unrelated
to these executor assignments.

## Remote transport limits

The existing remote connector requires `REMOTE_EXECUTION_ENABLED=true` and an
explicit remote-transport target. Enabling it does not redirect Studio actions.
Uncertain publication reuses the existing attempt and its original lease.
It has no authenticated lease-renewal or confirmed cancellation handshake;
cancellation remains visibly unconfirmed and prevents reassignment. This gated
transport does not satisfy the complete workflow execution guarantees yet.

## Verification

`tests/executor-integration.test.ts` runs the dispatcher and Studio Runner against
an isolated PostgreSQL database. It covers concurrent hierarchical reduction,
blocked renewal, stale state/result writes, cancellation cleanup, and dispatcher
ownership of final failure. API assignment tests cover the managed backend,
generation fencing, permission revocation, and resource cleanup. CI runs the
integration suite using `BEAM_TEST_POSTGRES_URL`.

Hard-crash tests cover the shared runtime and the managed agent with its actual
runtime and SQLite journal. Isolated live managed-member acceptance passed.
Lost records and inaccessible original process scopes remain visibly
unconfirmed until authoritative termination evidence is available.
