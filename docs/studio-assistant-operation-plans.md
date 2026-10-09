# Studio Assistant operation plans

The Home assistant answers contextual read-only questions directly. Explicit
searches and inspections may use server-owned `read` tools automatically, but
their internal plan is not presented as an action card. Drafts, mutations,
executions, security changes and destructive operations use visible
server-owned operation plans. Markdown remains a display fallback, but it is
never interpreted as an executable instruction.

## Trust boundary

The model may produce an intent, a readable plan and a declarative workflow
patch. It never receives a business mutation function and never calls one.

The API performs the following steps:

1. route the user request to a stable Studio intent;
2. normalize the model response into `AssistantOperationPlan`;
3. persist the draft in `assistant.operation_plans`;
4. validate scope, permissions, dependencies, tool arguments and Registry
   references;
5. generate a server preview and validation hash;
6. record an explicit confirmation for that exact hash;
7. revalidate and atomically claim the plan before execution;
8. invoke the existing Studio service through the selected tool;
9. store operation results and append redacted audit events.

The validated server copy is authoritative. A plan returned by the browser is
never accepted as an execution payload.

## Shared contracts

Provider-independent contracts live in
`packages/shared/src/assistant-operation-plan.ts`.

- `AssistantOperationPlan` contains intent, operations, inputs, assumptions,
  risks, estimates, preview, confirmation and lifecycle status.
- `AssistantOperation` contains a stable tool name, typed JSON arguments,
  dependencies, risk, reversibility and execution result.
- `AssistantInputRequest` identifies missing data and an optional server-owned
  argument path.
- `AssistantToolDescriptor` exposes JSON input/output schemas, permissions,
  confirmation policy and rollback capability.

Secrets use `secure_secret` inputs. They must be collected by a dedicated
secure Studio form and are rejected by the generic plan validation endpoint.
Credential references are allowed; credential payloads are not.

## Risk and confirmation policy

| Risk          | Behaviour                                   | Confirmation                 |
| ------------- | ------------------------------------------- | ---------------------------- |
| `read`        | Read current scoped state                   | None                         |
| `draft`       | Generate an unpersisted business draft      | None                         |
| `write`       | Create or update Studio state after preview | Simple                       |
| `execute`     | Start work with cost or external effects    | Inputs and effects           |
| `security`    | Change credentials, tokens or access        | Reinforced and secure form   |
| `destructive` | Delete or irreversibly alter state          | Explicit impact confirmation |

The highest operation risk determines the plan confirmation policy.

## Home and workflow editor

Home and the workflow editor use the same conversational capabilities:
entity mentions, Markdown rendering, conversation history, contextual reads,
operation plan cards, previews, confirmations, execution progress, retry,
rollback and result links.

Inside the workflow editor, the current graph, metadata, selected node and
validation errors are injected automatically and take precedence over saved
workflow summaries. Graph edits use the editor patch contract and remain local
until the user chooses **Keep**; **Undo** restores the exact pre-patch graph.
Requests concerning other Studio resources continue through the universal
server-owned plan lifecycle.

## Tool catalogue

The catalogue is returned by `GET /studio/assistant/tools`. Every descriptor
contains a stable name, JSON input/output schemas, permissions, risk,
confirmation policy, reversibility and rollback strategy where applicable.

The catalogue covers:

- workflows: create, metadata/graph/contract update, clone, delete, run, cancel
  and failed-only retry; compose sequential or parallel child workflow calls
  with explicit input bindings, public output contracts and failure policies;
- legacy Transfers: templates, source/destination endpoints, enable/disable,
  run, cancel and retry;
- schedules: create/update/enable/disable/delete with timezone, windows,
  limits, credit budget and overlap policy;
- credentials and storage: secure form preparation, usage analysis,
  server-side access validation, browsing and deletion;
- Registry: search/compare and public package installation;
- runs, queue and dead-letter: search, details, bounded monitoring,
  deterministic diagnosis, cancel and retry;
- orchestration: worker/location inspection and secure execution-location
  creation;
- MCP: least-privilege token creation, audit, revocation and deletion;
- workspace search and safe navigation.

All five workflow editor trigger types are accepted: `manual`, `schedule`,
`webhook`, `date` and `completion`. Workflow patches also support step and
edge update/removal, disconnect, trigger update/removal, runtime placement and
workflow metadata. Registry packages are resolved dynamically and unknown
actions fail server validation.

Legacy Transfers remain a separate surface. Workflows compose other workflows
through call steps. When children must be created, the planner emits their
`workflow.create` operations first; the parent `workflow.create` references their
results through explicit operation dependencies and `calledWorkflowId` bindings.

## Execution and recovery

Plan creation uses a persistent idempotency key. Operations use stable IDs and
the server atomically claims `confirmed -> running`, so a double submission
cannot execute twice. Dependencies are topologically validated before
execution.

On partial failure, completed reversible operations are compensated in reverse
order and remaining operations are skipped. A completed plan may also expose a
manual rollback action when at least one operation is reversible. Every state
transition and operation result is written to the redacted audit log.

Destructive previews are hydrated from current scoped data and include
dependent parent workflows, runs, steps, endpoints, schedules or credential references as
applicable.

## Secret handling

Raw secrets are rejected in plan arguments, prompts, persisted conversation
payloads and audit details. Credential creation and rotation use secure forms
outside model context.

MCP token creation returns a short-lived receipt only. The raw token is held
in a one-time server receipt, consumed through the dedicated endpoint and kept
only in Home component memory. It is never persisted in the plan or
conversation.

## API

```text
GET  /studio/assistant/tools
POST /studio/assistant/plan
GET  /studio/assistant/plans/:id
POST /studio/assistant/plans/:id/validate
POST /studio/assistant/plans/:id/confirm
POST /studio/assistant/plans/:id/execute
POST /studio/assistant/plans/:id/cancel
POST /studio/assistant/plans/:id/rollback
POST /studio/assistant/secrets/:id
```

`validate` may receive values only for declared non-sensitive input requests.
`execute`, `cancel` and `rollback` receive no client plan payload.

Read tools are validated and executed automatically because they require no
confirmation. Their results are summarized as a concise conversational answer,
without preview, assumptions, risk panels or confirmation controls. Draft,
write, execute, security and destructive plans remain visible when the user
needs to inspect or act on them; write and higher risks stop at preview and
follow the confirmation policy above.

For Transfer run acceptance checks, use only the Registry action `e2e/wait`.
The assistant test suite does not start real Transfer runs.
