# Action execution on managed room members

Studio owns workflow definitions, runs, scheduling, dependencies and billing.
A managed room member is a separate action execution backend. It is never
registered as a Studio Action Runner and receives no PostgreSQL credentials.

## Declared targets

An action step has one `executionTarget`:

- `{ kind: "studio", runnerIds?: string[] }` selects Studio Action Runners.
- `{ kind: "room-member", memberIds: string[], channelId: string,
  artifactChannelId?: string,
  requesterMemberId: string, room?: { environmentTemplateKey, roomId } }`
  selects a permitted member set in the effective room.
- `{ kind: "remote-transport", executionLocationId?: string }` identifies the
  existing, separately gated remote transport.
- `external-worker` is reserved. Authoring rejects activation until onboarding
  and execution guarantees are implemented.

The manifest must permit the corresponding placement. Target identity is
frozen with the definition. An optional target room is local to that action;
an inherited workflow room must match it. Exchange source/recipient selection
does not select the machine that computes the action.
V3 steps with routed artifact outputs require `artifactChannelId` naming an
active object channel. `channelId` remains the request/reply channel for
commands. Studio checks publish access for each frozen source and subscribe
access for each frozen recipient at launch and again before artifact use.
Routed V3 intermediates use explicit temporary retention; a same-member route
reads the held local copy instead of requesting an object transfer to itself.

The editor lists managed members separately from ordinary members and storage
resources. An offline member can remain in a saved permitted member set;
dispatch still requires a fresh authenticated control session.

Launch readiness follows enabled workflow calls. Only actions targeted at Studio
require an active Studio Action Runner; runner allowlists and organization/project
scope apply to that check. A workflow using only room-member targets can launch
without a Studio runner registration. Member availability, capabilities and room
permissions are checked by the member backend when the action becomes runnable.
Disabled calls do not introduce a runner requirement for their child definitions.
Studio task claims enforce the same runner identity and organization/project
scope. Lease renewal, state writes and result settlement recheck current runner
scope; changing that scope cannot authorize a late result. A draining runner may
finish existing assignments but cannot claim new ones.

## Opt-in and capabilities

The managed agent must explicitly enable its local action policy and install
Node.js 22 or newer and the shared runtime. See the companion
[agent policy and installation instructions](https://github.com/Beam-Network/beam-tunnel-agent/blob/feat/115-managed-action-execution/docs/action-execution.md).
The Action Runner image includes the standalone runtime and its production
dependency closure at `/opt/beam-action-runtime`. Copy that directory to the
opted-in agent machine and configure its local `runtime_path` to
`/opt/beam-action-runtime/dist/cli.js`, along with the installed Node executable.
It is a standalone process host, separate from the worker entry point.
Its dependency closure and platform-specific `native/process-guard-*` binary are
required; copying the CLI file alone is insufficient. The Linux image supplies a
Linux helper; Windows installations require the matching Windows runtime package.
Default managed-agent installations do not acquire execution capability merely
by joining a room.

The `action-execution/v1` hello capability requires structured discovery of
the installed Node version, isolation modes, host operations, action allowlist,
permissions, capacity, maximum lease duration and a successful native process
ownership probe (`action-process-ownership/v1`). Only implemented Node
isolations are advertised. No native, OCI or WASI implementation is implied.
Organization policy intersects the local allowlist and can reduce limits.

Dispatch requires active membership, an active `request-reply` channel (select `request-reply` in the room channel editor), the
requester's request grant, the executor's respond grant, compatible runtime and
isolation, all required host operations, local action permission and capacity.
Current account access, action trust, frozen artifact integrity and credential
authorization are checked again at execution and lease renewal.

## Shared runtime and scoped host access

`packages/action-runtime` owns loading, immutable artifact verification,
sandboxing and host-capability construction. The Studio backend retains NATS,
database access, runner registration and task claims in `apps/worker`.

The managed backend downloads verified bytes through an invocation-scoped
Studio endpoint. Its capability grants access only to that assignment and
attempt. Redirects cannot forward this capability to another origin. Agent
commands and run history redact capabilities; capability records are kept out
of immutable execution snapshots.

Implemented managed-backend host operations cover bounded logging, committed
step state, artifact descriptors, manifest-bound credential reads, and the
existing room publication/status/cancellation service. Filesystem exports,
generic object-storage host operations and the legacy Beam transfer adapter
are not advertised as implemented by this backend. A manifest requiring one
of those operations receives a placement error before dispatch.

State writes recheck the active assignment and task attempt under a
transaction. Credential reads reuse the audited credential version used by
Studio Action Runners. Only authorized action credentials are returned to the
action host; agent machines never receive Studio database access.

## Durable dispatch and recovery

Migration `0025_workflow_executors.sql` adds explicit targets, structured agent
capabilities and `execution.executor_assignments`. Assignment, task attempt,
scoped capability and durable `action.invoke` command are committed together.
Concurrent dispatchers reattach to the same invocation. Socket delivery occurs
after commit. The generic stale-Studio-runner recovery path excludes unresolved
member assignments.

Studio reconciles durable command results and sends `action.renew`,
`action.cancel` and `action.reconcile`. Renewal requires an unexpired lease and
fresh permission checks; an unconfirmed renewal cannot extend indefinitely.
Session generations, task attempts and assignment identity fence stale work.
Results received after cancellation or expiry cannot create business output.

Cancellation requested and cleanup confirmed are separate fields. Workflows
retain active assignment claims during cleanup. An unresolved assignment
prevents retry and deletion of its managed agent. A daemon restart reconciles its
persisted controller and sandbox identities through the
[shared process guard](action-process-ownership.md). Missing native evidence or
uncertain resource cleanup stays visible and prevents reassignment.
Run history exposes target, actual executor, attempt, progress, placement
rejections and cleanup state without exposing invocation credentials.

## Delivery and acceptance

The common executor integration supplies
[shared settlement, protected resource evidence and distributed plans](workflow-executors.md).
Live managed-member execution, cancellation, revocation, restart/reconciliation
and explicit retry passed on an isolated Windows member.
The remote transport remains gated and does not claim its missing guarantees.

PostgreSQL coverage exercises concurrent dispatch, duplicate delivery,
capability rejection, permission revocation, expiry, stale results, atomic
host state and cleanup restrictions. Runtime process tests exercise actual
artifact loading, state RPC and cancellation; the companion agent suite tests
its local policy and durable invocation journal. A subprocess test kills the Go
daemon while the actual shared runtime is CPU-busy, reopens SQLite and confirms
process termination before rejecting duplicate invocation.
