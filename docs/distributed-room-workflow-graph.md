# Distributed room workflow graph contract

`workflow-graph/v3` is the first graph version that can **describe** distribution
over room members. Its wire shape is `version`, `controls`, `edges`, and
`distribution`. The `controls` and `edges` fields keep the v2 DAG rules. V1 and
v2 definitions and historical snapshots retain their previous interpretation;
distribution is never inferred from a v2 fan-out or a room transfer's recipient
list. The v3 authoring API stores the complete object in `workflow.templates.graph_json`
and returns it through the workflow graph read path. An update to an existing v3
definition that omits `distribution` retains it; downgrading the version is
rejected to avoid accidental deletion by older editors.

The canonical [valid fixture](../packages/core/src/workflows/fixtures/distributed-graph-v3.json),
[invalid fixtures](../packages/core/src/workflows/fixtures/distributed-graph-v3-invalid.json),
[resolved plan fixture](../packages/core/src/workflows/fixtures/distributed-graph-v3-plan.json),
and [port conformance fixture](../packages/core/src/workflows/fixtures/distributed-graph-v3-port-conformance.json)
are JSON files intended for Studio, Registry, and Go agent conformance suites. The exported
validator and resolver live in `@beam-studio/core/workflows/graph-v3`.
Consumers must match the version string exactly and reject unknown required
fields. The graph contract does not redefine an action manifest or its checksum.

## Definition

`distribution.partitions[]` gives each member set a unique name. `members` is
either `{kind:"explicit",memberIds:[...]}` or
`{kind:"eligible",requiredCapabilities?:[...]}`. Explicit lists must be
nonempty and duplicate-free. Eligible selection is a **query**, not a persisted
membership snapshot. At launch, the coordinator must authorize the effective
workflow room, channel, requester, member grants, and advertised capabilities,
then freeze the selected member IDs and any association keys in the run snapshot.
An empty result fails launch. `order:"member-id"` sorts ASCII member IDs by
code unit, without locale collation;
`order:"declared"` follows an explicit list and is forbidden for eligible
selection. The frozen order controls position and ring successor semantics.

`distribution.steps[]` binds one existing enabled top-level workflow step to one partition.
The step has `placement:"studio"` or `"room-member"`, plus named `inputs` and
`outputs`. Port kinds are `json`, `artifact`, `member-id`, and `member-id-list`;
data ports declare `cardinality:"one"|"optional"|"many"|"non-empty-many"`
and a single exact MIME `format`. Generated `member-id` and `member-id-list`
ports have cardinality `one` and `many` respectively, without a MIME format.
Port names follow the Registry's `[a-z][a-zA-Z0-9_]*` rule. Matching kind,
cardinality, and format is required for a route;
matching JSON shapes alone does not establish artifact interchangeability.
Placement is where the action computes and does not select transfer recipients.
The locked registry manifest must independently permit the placement and port
semantics. Action package versions, artifact checksums, and manifest checksums
remain fixed by the existing definition/run lock.
For routed artifact outputs, each room-member action target names an
`artifactChannelId` in addition to its command `channelId`. The artifact
channel must be an active object channel. Launch checks the frozen source's
publish grant and each recipient's subscribe grant; dispatch and artifact reads
recheck current channel state and grants. The command channel remains an
independent request/reply channel.
Routed V3 artifacts are held as temporary run intermediates through the frozen
retention deadline. Each executor keeps a verified local copy. When a logical
task runs on its route recipient, dispatch omits that member from remote object
transfers and the next step reads the held local copy.

### Registry and runtime compatibility

The Registry v2 manifest format
declares each named artifact directly in `inputs` or `outputs` with
`type:"artifact"`, `cardinality:"one"|"many"`, one exact MIME `format`,
and a Boolean `required`. Graph `one`, `optional`, `many`, and `non-empty-many`
map respectively to `(one,true)`, `(one,false)`, `(many,false)`, and
`(many,true)`. `assertGraphV3RegistryPort` checks all four fields against the
locked manifest. Registry v2 has only artifact ports; a graph `json` port cannot
bind to a v2 action without a separately specified conversion. Matching a
format alone does not authorize package substitution or establish semantic
equivalence.

The bounded runtime v1 format
uses action schema `type:"artifact"` for scalar and `type:"artifact[]"`
(or `type:"artifact",cardinality:"many"`) for a collection. `required:true`
distinguishes `one` from `optional` and `non-empty-many` from `many`.
`assertGraphV3RuntimeArtifactPort` requires this shape and an exact matching
`format`; the runtime currently handles at most 32 KiB per artifact, 64 KiB and
16 artifacts per invocation. Registry's required capability, the runtime
invocation protocol, and the member's `artifactPorts` advertisement all use
`action-artifact-ports/v1`. Partition `requiredCapabilities` accepts this name
and rejects the superseded `artifact-ports/v1`. Eligibility must still verify
the installed runtime, advertised support, policy, and resources.

Runtime v1 additionally understands `artifact[]` and legacy
`type:"artifact",cardinality:"many"` collections; Registry v2 pins the latter
form. The runtime validates and installs Registry v2 manifests but explicitly
refuses their execution. The current graph execution gate must remain until
invocation, admission, and format enforcement cover the selected port shape on
both backends.
The port conformance fixture is a small shared projection pinned to Registry
`a33dab7e4bbdae27ce4ce4d3b62c5ee3cc5b1b69` and runtime
`75162d03aaaa434262177d087f6a0283f4394ed4`. It does not replace either
repository's full fixture suite.

`distribution.routes[]` names source output and destination input ports and an
association. The graph must contain a dependency edge from source step to
destination step. Each destination port has at most one route:

| Association | Meaning                                         | Failure before task dispatch            |
| ----------- | ----------------------------------------------- | --------------------------------------- |
| `identity`  | Same member ID in the same partition            | Missing member match                    |
| `position`  | Same zero-based index in frozen partition order | Unequal partition sizes                 |
| `key`       | Equal nonempty frozen member keys               | Missing or duplicate key, missing match |
| `broadcast` | One source task to each destination task        | More than one source task               |
| `collect`   | Every frozen source to one aggregation action   | Missing action contract or source port  |

Keys are scoped to a partition and are explicit data in the frozen membership
snapshot. A route never guesses an association from array order or an artifact
filename. Duplicate member IDs, ambiguous keys, incompatible ports, unknown
ports, duplicate target bindings, self routes, and cross-region graph edges are
rejected. The v2 graph limits still apply; v3 additionally caps partitions and
distributed steps at 128 each, routes at 512, members per partition at 10,000,
expanded action tasks at 100,000, transfer recipient assignments at 1,000,000,
and routed task inputs at 1,000,000.

## Explicit aggregation

A v3 aggregation is a top-level action step with `placement:"room-member"` and
`aggregation:{"strategy":"flat"|"hierarchical"}`. Exactly one inbound
`collect` route names the source artifact port and the action's collection
input port. The source port has `one` cardinality; the destination port has
`non-empty-many` cardinality. A collect route is the only route that
intentionally changes cardinality. The resolver checks the locked Registry v2
manifest's exact input/output ports and contribution MIME format.
Every hierarchy invocation is assigned to the same frozen room member. The
resolver retains a logical route key separately from `assignedMemberId`.

The action manifest declares
`contracts.computation.aggregation:{inputPort,outputPort,contributionFormat,associative,closedUnderCombination}`.
The [term-count reduce fixture](../packages/core/src/workflows/fixtures/term-count-reduce-v2.json)
is pinned to the published action manifest revision it was taken from.
`flat` is the default strategy for any new partitioned v2 action; more than
eight partitions does not select a different algorithm. `hierarchical` must be
explicit in the graph or the v2 partitioning contract and requires an
associative action whose output can be passed as a contribution to another
invocation. An order-sensitive associative action is allowed: each group is a
contiguous slice of the frozen source order. A non-associative action uses a
single flat invocation. For artifact-array inputs, the resolver caps each
invocation at `maxArtifacts - 1` contributions to reserve one output artifact;
an oversized flat plan fails before dispatch.

Each planned aggregation invocation has a `collectionId` derived from the
workflow run scope, destination task identity, and its ordered expected source
task identities. These are logical task IDs, independent of which member runs
an attempt. Intermediate invocations carry the original leaf IDs forward so
the final invocation can validate the complete cohort. The
`prepareAggregationActionInput` helper returns no input until every frozen
source has one accepted result. It counts valid empty values, ignores identical
repeat notifications, rejects conflicting or unexpected contributions, and
returns the input in frozen order with a content checksum. The action config
comes from the admitted collection. For `@beam/term-count-reduce`, the
room-member assignment derives `collectionId` and `expectedDocumentIds` after
checking task metadata against the frozen plan. The action itself verifies
the expected document union.

The historical v1 `partitioned-reduce` planner keeps its threshold-based
behavior. New v2 `partitioned-reduce` manifests default to flat reduction and
can opt into hierarchy only with the existing `associative-commutative`
partitioning declaration. The PostgreSQL v2 reducer now checks the frozen
shard count and unique shard indexes before enqueuing the final task, including
empty outputs.

The Registry v2 extension above must be accepted and retained by the
Registry before publishing an aggregation manifest. The existing v3 execution gate still
applies. Its orchestrator integration must persist the resolved collection IDs
and expected sources, wait for the accepted artifact manifests of the
artifact acceptance package,
then call `prepareAggregationActionInput` and supply the returned input plus
the action's expected-ID config. The logical partition IDs and concurrency
limits of the logical partition plan
must be frozen in the same plan. The current v3 graph resolver still expands
one task per selected member. For document maps, the separate
`planAggregationForFrozenPartitions` adapter accepts the `logical/v1`
`partition-map` plan, maps each `step-partition.logicalId` to one frozen
document ID, takes the graph's frozen `assignedMemberId`, rejects a member
outside the map cohort, and builds the same aggregation groups. Its test plans 100
documents with three eligible members per task, producing eight explicit
reduce invocations (seven groups and a root). `persistFrozenAggregationPlanPg`
freezes that serializable plan in the reduce step's existing
`execution.execution_plans.plan_json` slot and rejects a conflicting replay.
`admitFrozenAggregationInvocationPg` locks that plan row in the caller's
transaction, finds source tasks by frozen `logicalPartition.id` (or
`aggregation.id` for intermediate groups), requires a completed task and one
accepted artifact manifest per source, checks its MIME and available copy,
then freezes the accepted artifact references for that member and closes the
collection. It invokes a caller callback to persist the reduce task and records
admission in the same transaction; retries cannot enqueue it twice. A terminal
source failure invokes a transactional `block` callback and persists a blocked
record, so the caller can mark the dependent step `not_reached`. The caller
rechecks live room read authorization before commit. No
broker publish occurs inside this helper. The v3 dispatcher must connect these
functions to the run lifecycle and provide intermediate task metadata with
`aggregation.id`; the adapter and tests do not claim a v3 run executes end to
end yet. Removing the gate before that connection is complete would bypass
acceptance and closure.
Studio's local Runner currently refuses `workflow-actions/v2`, so this
aggregation contract uses the room-member Agent path once the V3 gate lifts.

## Transfer topology and task identity

A distributed step can declare `transfer` with `topology:"ring"` or
`"all-to-all"`, and name its generated `member-id` source input and
`member-id-list` recipient input. These inputs cannot also be routed from
another step. For a partition of N members (N ≥ 2), this **one authored step**
resolves to N action tasks. Each task carries its source member ID explicitly.
Ring task _i_ receives exactly the next member in frozen order, wrapping from
N−1 to 0. All-to-all task _i_ receives all N−1 other members in frozen order.
No transfer action is asked to infer a successor or an implicit “everyone” list.
The existing `@beam/room-transfer` action still performs authorization and
delivery; its empty `targetMemberIds` convention does not stand for a v3
recipient set.

Task identity must include run ID, distributed step ID, source member ID, and
attempt. Retries reuse the frozen membership, route, action lock, and publication
identity for their task; a new run resolves a new snapshot. Cancellation and
cleanup remain per task and retain the existing room transfer and executor
guarantees. The planner returns explicit task and route records without
credential material or provider URLs.

## Integration and release boundary

The v3 schema, round-trip authoring, validation, deterministic planning, and
shared fixtures are implemented here. **V3 execution is gated** at definition
capture, run enqueue, and orchestrator version dispatch. This is intentional:
the existing v1/v2 orchestrator cannot safely dispatch a v3 graph. Therefore
the planner's N records are a contract for future persisted tasks, not a claim
that v3 runs are already executable. The Studio editor has no v3 authoring UI;
the graph API accepts v3 directly and older editor saves cannot downgrade it.

To enable execution, the remaining integration must:

1. Extend the frozen definition and run snapshot with the resolved partition
   membership, keys, graph distribution, port map, and task plan; preserve the
   original v3 version in history.
2. Have the PostgreSQL orchestrator persist exactly one task per planned
   `(run, step, member)` before publishing, enforce the 100,000-task bound, and
   replay the same plan after a crash. Pass the explicit source and recipient
   IDs to each room transfer action, and enforce each route before the target
   task starts.
3. Use the versioned registry manifest's port format, cardinality, placement,
   resource, and recovery declarations from the Registry and the shared
   artifact runtime.
   Do not accept schema-compatible but semantically different packages.
4. Have the opted-in agent enforce the same locked package, declared ports,
   permissions, capabilities, and resource admission described by the agent's
   action-execution policy.
   An advertised capability is not a reservation.
5. Add PostgreSQL recovery and end-to-end acceptance for membership changes,
   duplicate dispatch, ambiguous association, partial failure, cancellation,
   and restart before removing the execution gate.

The API still uses the workflow's inherited room context described in
[workflow room context](workflow-room-context.md). A partition never changes a
child workflow's context or grants. A v3 graph should be authored only for a
workflow with an effective room, and launch must reauthorize it before freezing
membership.
