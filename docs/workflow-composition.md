# Workflow definitions, contracts, and child runs

Workflow composition is coordinated by the Studio Action Dispatcher. A step is
either an action invocation (`kind: "action"`) or a workflow invocation
(`kind: "workflow", calledWorkflowId: "…"`). Calling a workflow creates a child
run; it does not consume a Studio Action Runner slot. Actions retain their
declared execution placement.

## Saved action versions in the editor

Each saved step's manifest comes from its action lock, including the resolved
version and manifest checksum. Installing a newer release does not change that
manifest or invalidate an older installed version. The editor resolves each
step independently, keeping its saved version when compatible with the declared
range. Changing the range selects a compatible installed version; an unavailable
version remains a validation error. Configuration controls use the selected
manifest, and Registry checks apply to the package and selected version.

Opening the action catalog does not upgrade saved steps. Definition saves and
explicit lock changes retain the existing server-side confirmation and execution
authorization checks.

Definitions also expose [named managed-agent and resource bindings](workflow-reference-bindings.md).
These references are frozen separately from executable steps and remain subject
to current access checks.

## Public contract

Definitions declare `inputSchema` and `output: { schema, bindings }`. Schemas use
JSON Schema draft-07, validated with Ajv. Validation does not coerce values,
insert defaults, remove properties, or load remote schemas. Document-local
`$ref` values are supported; asynchronous schemas are rejected.

For example, a child can publish a result independent of its internal graph:

```json
{
  "inputSchema": { "type": "object", "additionalProperties": true },
  "output": {
    "schema": {
      "type": "object",
      "properties": { "file": { "type": "string" } },
      "required": ["file"],
      "additionalProperties": false
    },
    "bindings": { "file": "${steps.upload.outputs.uri}" }
  }
}
```

The parent reads `${steps.childCall.outputs.file}`. Only the validated public
output is exposed by the call. Invocation metadata is separate:
`${steps.childCall.runId}`, `${steps.childCall.status}`, and
`${steps.childCall.error}`. Parent bindings cannot traverse child-internal steps.
Outputs can also be scalar, array, or null values when their schema permits it.
There is no implicit last-step output. Missing mappings and invalid outputs fail
the contract; failed and cancelled runs have no business output.

The initial contract for existing definitions accepts an object input and
explicitly produces `{}`. Authors must add mappings to expose useful results.

Use `{ "$literal": value }` to preserve a JSON value without interpreting binding
expressions in it. Migration uses this for former Job item inputs. Workflow
Settings edits the public contract; the graph editor adds workflow calls and
offers child public fields in binding pickers. Run history links parent and child
runs and separates invocation metadata from validated output.

## Editor and navigation

Navigation uses lightweight run summaries; full immutable history and business
output remain available by opening a run. See [read-path performance](workflow-loading-performance.md).

The floating canvas toolbar groups **Actions**, **Workflow**, and **Room**.
While the graph loads, the same toolbar is displayed with every control disabled;
its labels, icons, order and responsive layout match the ready editor.
**Workflow** opens a searchable saved-workflow picker and adds a child-call node;
configure that call's inputs in its node dialog. **Room** opens the optional
shared-room configuration, and its indicator shows when a room is associated.
Without a workflow room, actions that need a room keep their own selection.

Drag a workflow onto another in the sidebar to nest it visually. Expand or
collapse parents with their chevrons. Drop onto the **Workflows** heading to
return a workflow to the top level, or use **Move workflow…** in its menu to
choose a parent or **Top level** with the keyboard. Self-nesting and cycles are
rejected. Search reveals matching workflows with their ancestors. Favorites
remain direct shortcuts. Parent relationships are saved in Studio for the selected
organization and are shared across browsers. Moves require current write access,
reject concurrent cycles, and display errors if saving fails. Collapse state is a
browser preference. Workflows whose parent is outside the selected project's view
appear at the top level until both workflows are visible. Deleting a parent returns surviving
children to the top level. This hierarchy does not add calls or change execution,
saved definition revisions, schedules or room context.

On desktop, drag the sidebar's right edge to resize it between 240 and 480 pixels;
the maximum also preserves 320 pixels for content. The expanded width is saved in
this browser and restored after collapse or reload. Focus the edge and use arrow
keys (Shift for larger increments), Home/End for the bounds, or Enter to reset to
256 pixels. Double-click also resets. The sidebar toggle and shortcut still
collapse it; mobile keeps its fixed-width drawer.

The **Runs** page and the overview's **Runs** tab share the same run panel and
rows: status icon and label, run ID, trigger and relative time, duration, and a
link to run details. The overview previews ten runs; the dedicated page shows
history in pages of 50 with server-side search and status filters. Previous/Next
navigation reaches older executions without loading their snapshots into the editor.

## Saved definitions and execution snapshots

Saved revisions live in `workflow.plan_versions`. Definition writes and revision
creation are transactional. At launch, Studio reads the dependency closure at a
single PostgreSQL statement snapshot and captures resolved action identities,
manifests, artifact checksums, inputs, organization/project, initiating principal,
trigger, and billing references. Secret values are not part of execution context.
Current authorization remains an execution-time requirement.
Each root also owns a [durable billing attempt](workflow-billing.md). Dispatch
requires its confirmed reservation; child calls share the ancestor's hold and
explicit retries retain earlier settlement records.
Root runs also freeze the execution environment and non-secret Beam connection
defaults for the composed project scopes. Child calls and retries retain those
selectors; rotating credential metadata or deploying a differently configured
Action Runner cannot redirect an existing run. Current credentials and grants
are still checked before execution. Run again captures current configuration.

The root run freezes every referenced child definition. Child inputs are bound
when the call becomes runnable, using committed upstream public outputs. Edits
affect subsequent launches, not existing runs. Recursive references and call
trees exceeding sixteen definition levels are rejected. The existing expanded
graph limit also applies across composition.

`parent_run_id`, `root_run_id`, `invoking_step_run_id`, and `invocation_attempt`
identify the call tree. The child, call relationship, queue event, and durable
dispatch command commit together. A unique invocation constraint makes duplicate
delivery recover the same child. Child definitions' schedules and completion
triggers are not activated by a call.

## Retry and cancellation

Retry retains the frozen run and retries failed/cancelled work. Completed calls
keep their committed output and child identity. A retried call advances its
attempt before dispatch, preserving earlier child runs in history. A fresh launch
(Run again) resolves current definitions. Historical executions require a fresh launch.

An explicit retry starts a new duration clock, including for a scheduled run.
The frozen schedule timeout is unchanged and applies to the new attempt. Original
creation time and frozen snapshots remain unchanged; a `WorkflowRunRetried` event
retains the prior attempt's queue/start/completion timestamps and billing identity.

Cancellation requests propagate down the run tree. The dispatcher waits for
active descendants before settling the parent as cancelled. Retry is rejected
while descendant cancellation is outstanding. The dispatcher also waits for
[executor termination and resource cleanup](workflow-executors.md); a cancellation
request is not confirmation. [Native process ownership](action-process-ownership.md)
supports owner-crash recovery without duplicate invocation; unavailable evidence
keeps the assignment in reconciliation.

## Delivery boundary

Composition and contracts, the Job/history cutover and the product editors are
delivered together. Follow the operator cutover procedure before deploying over
an existing Job database. Optional room inheritance is documented in
[Workflow room context](workflow-room-context.md); capable room-member
execution and executor integration are documented in
[Workflow executors](workflow-executors.md). The public `beam-studio-runtime-*`
images remain the deployment baseline.

## Verification

Composed graphs retain the 100,000-instance expansion bound across workflow calls.
Each invocation counts once plus its child's expanded work; enclosing loops and
fan-outs multiply both. Data-dependent cardinalities use their configured maximum
(1,000 loop iterations and 10,000 fan-out items). Shared child definitions are
counted per call, with memoized validation rather than materialized expansion.
Over-budget saves and launches fail before allocating saved revisions or runs.

`apps/orchestrator/src/workflowComposition.test.ts` uses an isolated PostgreSQL
database created from `BEAM_TEST_POSTGRES_URL` (or CI's `DATABASE_URL`). It covers
immutable snapshots, concurrent dispatch, duplicate invocation recovery,
contract failures, failed-only retry, descendant cancellation, and dynamic calls.
The connection must permit creating and dropping the temporary database.

## Action execution targets

Action steps declare an execution target independently of resources and room
membership. See [Room-member execution](room-member-execution.md) for target
contracts, capability discovery, scoped host access and durable assignments.
Workflow calls remain dispatcher work and never acquire a runner assignment.
