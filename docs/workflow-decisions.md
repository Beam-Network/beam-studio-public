# Decision nodes and node metadata

A gateway is a first-class graph object placed between steps. A binary Decision
routes to True or False. A Switch evaluates ordered predicate cases, takes the
first match, and otherwise takes its mandatory Default output.

It exists because an ordinary step edge carries exactly one meaning: _run only
if the upstream reached `completed`_. `successfulStatuses` is `{"completed"}`,
so a failed upstream could never take an edge and "if the transfer fails,
notify" was not expressible inside a workflow — only between workflows, through
the completion trigger's Completed/Failed checkboxes.

## Anatomy

A Decision is modelled on the trigger, not on an action: its own tables, its own
canvas node kind, its own settings dialog, and it is never dispatched to a
worker. The workflow engine settles it in the same pass where it decides which
steps to start.

| Table                                     | Holds                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `workflow.decisions`                      | kind (`if` or `switch`), name, enabled, join mode, handle-failure flag, configuration, canvas position |
| `workflow.decision_edges`                 | one endpoint each side, plus `branch` on edges leaving a decision                                      |
| `execution.workflow_decision_evaluations` | one row per decision per run: evaluated, result, taken branch, handled failures, reason                |

`branch` is a real column because port identity does not survive the graph
projection: `normalizeWorkflowEdges` re-derives ports as `workflow-out` and
`workflow-in`, so a branch encoded only as a React Flow handle would be lost on
save and reload.

A graph containing a decision is forced to `workflow-graph/v2`. Only the dynamic
graph engine resolves decisions; a v1 graph would take the static path and
ignore them silently.

## Join modes

Both modes wait for **every** input to reach a terminal state before the
decision resolves. The names say so rather than hiding it.

| Value         | Meaning                                     | Status                    |
| ------------- | ------------------------------------------- | ------------------------- |
| `all`         | every input settled and satisfied           | default                   |
| `any_settled` | every input settled, at least one satisfied | supported                 |
| `any_first`   | proceed as soon as one input is satisfied   | reserved, not implemented |

`any_settled` is a barrier, not a short circuit: a fast transfer and a slow
process feeding one decision both have to finish before it resolves. Inputs that
are `skipped` or `not_reached` satisfy the barrier and count as unsatisfied.

An unsatisfied join takes the **false** branch for a Decision or **Default** for
a Switch rather than refusing to evaluate.
That is what lets a failed input reach a recovery or notification branch; the
first implementation declined to run and made failure branching impossible.

Reachability is checked before that join: an untaken decision output, a skipped
step, or a step that was not reached does not activate its downstream decision.
An `all` join requires every incoming path to be reached; `any_settled` requires
at least one, still waiting for all paths to settle. A failed step counts as
reached, so recovery still takes the false branch. An unreachable or disabled
decision records `inputs_not_reached`, takes neither output, and handles no
failures. This state propagates through decision chains without leaving them
waiting forever.

## Handled failure

A decision may mark an upstream failure as handled, so the run does not end
`failed`. The rule is about what actually executed, never about what the graph
permits:

> A failed step is handled if and only if at least one decision that directly
> receives it as an input, actually became reachable and evaluated in this run,
> and has `handle_failure = true`, recorded that step id in its evaluation
> record.

Consequences, stated so they are not left to inference:

- A decision with `handle_failure = true` that **never evaluates** — blocked by
  another `all` input, or sitting behind an untaken branch — handles nothing.
  Configuration alone never suppresses a failure.
- A second decision on the same step with `handle_failure = false` does **not**
  veto the one that handled it. A veto rule would make the outcome depend on
  evaluation order.
- Handling is recorded per failed step id, so a run with two failed steps where
  only one is caught still ends `failed`.
- Handling suppresses only the run status. The step run stays `failed` with its
  error intact.

`finishIfTerminalPg` reads the evaluation records to resolve this. The existing
per-step **Required** toggle is unrelated: it suppresses the run-level failure
but does not let downstream steps run.

## The predicate

A structured, declarative JSON predicate. It compares resolved values and
combines them with `all` / `any` / `not`. It never parses or executes
user-supplied code, per the bounded-condition-language rule.

```jsonc
{
  "all": [
    {
      "left": { "step": "wfs_x", "field": "status" },
      "op": "eq",
      "right": "completed",
    },
    { "left": "${steps.wfs_x.outputs.bytes}", "op": "gt", "right": 0 },
  ],
}
```

Operators: `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `exists`, `empty`, `contains`.
Ordered comparisons coerce both sides to numbers and evaluate false when either
side is non-numeric — they never raise.

Evaluation never throws. An unresolvable operand or a malformed predicate
resolves to false with a reason, so a decision cannot crash a run. Reasons are
`predicate_true`, `predicate_false`, `predicate_absent`, `predicate_invalid`,
`join_unsatisfied`, `inputs_pending`.

Leaving the predicate empty is normal: the join alone then decides the branch.

## Switch

A Switch reuses the same predicate builder and expression resolver as a binary
Decision. Its persisted `cases` array is ordered. Every case has a stable id,
display name, and predicate; edges refer to `case:<id>`, so renaming or
reordering a case never silently retargets an edge. The fallback edge uses
`default`.

The API and editor reject an empty case list, duplicate or malformed case ids,
malformed predicates, edges that refer to removed cases, multiple edges leaving
one output, and a Switch without a connected Default output. This keeps one
selected output equivalent to one downstream lane.

Evaluation stops at the first matching case. The durable evaluation row records
`decision_kind` and only the selected branch plus the existing reason and
failure metadata; it never stores resolved operand values. Reasons add
`case_matched` and `switch_default`.

### Editing

The condition is edited with a guided builder: groups of **all / any / none of**
holding comparison rows, nestable two levels deep. The left operand uses the
same `@` mention field as an input binding, so one idea has one spelling
throughout the editor. `is set` and `is empty` compare against nothing, so the
right-hand field disappears.

Values typed into a row are converted on the way out: `10` becomes a number,
`true` a boolean, `null` a null, anything else a string.
Use quotes for text that resembles a typed value, for example `"001"` or
`"true"`. Existing literals are displayed with those quotes when necessary so
editing another row preserves their types. Explicit empty groups stay in JSON
mode because removing them can change the predicate's result.

A predicate the builder cannot draw — a bare boolean, an unknown operator, a
`not` wrapping anything other than an `any` group — opens as JSON and stays
there, rather than being rewritten into a shape the form can render. Normalising
it would discard meaning the author put there deliberately.

## Node metadata

Every node carries facts that can be referenced downstream. One resolver
(`packages/core/src/workflows/node-metadata.ts`) serves both input bindings and
decision predicates, so the two cannot drift into supporting different
expressions.

```
${steps.<id>.name}  .id  .action  .status  .error  .attempt
${steps.<id>.startedAt}  .completedAt  .durationMs
${steps.<id>.config.<key>}
${steps.<id>.outputs.<key>}     ${steps.<id>.artifacts.<path>}
${decisions.<id>.branch}  .result  .joinMode  .name
${workflow.name}  .runId  .triggerType
${workflow.input.<path>}  ${workflow.config.<path>}
```

The distinction that matters: **outputs exist only after a step succeeds;
metadata exists whatever the step did**. Binding a failed step's output raises
`ActionInputError`, which is correct — silently substituting null would swap
real values for empty ones. Binding its `status` or `error` works, which is what
makes a failure-branch notification possible.

`durationMs` is derived from the timestamps when the store did not record it.
An unknown node resolves to `not_reached` for `status` and null elsewhere rather
than raising, because the notifications and decisions that read metadata exist
precisely for the cases where something did not run.

`${steps.<id>.config.*}` is **not redacted**. It is what makes a transfer's
source reachable, but it will carry whatever an action stored in config into an
outbound message. Credentials themselves live in the vault behind ids, so this
is references rather than secrets.

## Authoring

Only **inputs** resolve expressions. Configuration is passed to an action
verbatim. The input-bindings editor states this, and actions that take per-run
values — such as `@beam/slack` — declare them as inputs only, so the same field
never appears in both places.

Type `@` in an input binding for two-stage autocomplete: nodes first, then that
node's values. The field stores canonical `${steps.<id>.…}` expressions rather
than names, because ids are stable and names are not — renaming a node must not
silently break every reference to it. A readable echo appears beneath the field
and flags an unresolvable expression in red.

## Assistant

The AI assistant can build a decision flow: `add_decision` takes a name, join
mode, handle-failure flag and predicate, and `connect` carries an optional
`branch`. A branch is required on an edge leaving a decision and refused on one
entering it, which is what makes the edge mean anything.

The plan normalizer rejects an unknown join mode or branch rather than coercing
it, so a plan that would silently build the wrong graph fails visibly instead.

## Observability

`execution.workflow_decision_evaluations` records one row per settled decision,
written with `ON CONFLICT … DO UPDATE` so restarts and duplicate delivery
converge. It is load-bearing rather than diagnostic: run finalization reads
`handled_failures` from it.

Like condition traces, it records the shape of the outcome and never resolved
operand values.

Run detail shows a **Decisions** panel: how each gateway resolved, its selected
branch, the join it used, the reason in words, and any failure it absorbed. It
reads the evaluation records rather than inferring outcomes from downstream
step statuses.

Condition traces are now written on the static orchestration path as well as the
dynamic one. The static path's rule is narrower — only a `skipped` upstream
blocks an edge there, where the dynamic path requires `completed` — and the
traces record what actually happened on that path rather than restating the
dynamic path's rules. The gate itself is unchanged, so graphs already running
behave exactly as before.

The "Branches taken" panel no longer prints the raw condition. It contradicted
the redaction applied to the traces themselves, which deliberately record the
shape of an evaluation and never its resolved values.

## Not yet built

- `any_first` short-circuit join.
