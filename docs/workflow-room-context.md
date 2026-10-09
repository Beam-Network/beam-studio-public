# Optional workflow room context

A workflow may declare `room: { environmentTemplateKey, roomId }`. Omit it or
save `null` for no workflow room. The Beam environment template is part of room
identity; identical room IDs in different environments are not interchangeable.

| Definition and caller                                     | Effective room                         |
| --------------------------------------------------------- | -------------------------------------- |
| Workflow declares a room                                  | Applies to its actions and child calls |
| Caller supplies a room                                    | Inherited throughout the child         |
| Caller has no room; child declares one                    | Applies only to that child subtree     |
| Neither declares a room; room-transfer action selects one | Applies only to that action            |
| Neither declares a room; action needs none                | No room is required                    |

Matching explicit associations are valid. Conflicting action or child associations
reject saving or launching the composition. One resolver serves authoring,
snapshot creation and execution. Inherited room fields are filled before action
configuration validation. The published `@beam/room-transfer` contract still
requires its complete room configuration at execution.

The floating editor toolbar's **Room** button edits the optional room. Action and workflow-call settings show
the inherited context; the action room picker stays available without a workflow
room. A reusable child can select **Use the calling workflow's room**, configure
channels and members using a preview room, and save without its own room fields.
It then requires a compatible inherited room at execution. Existing action room
selections are preserved and are never promoted to workflow settings automatically.

Each run freezes its effective room in `execution_context_json`. Child runs inherit
that context and resolve their own frozen definition against it. Definition edits
cannot change a run's room. Run history displays the frozen room.

A room is not required to establish an execution environment. Root creation
freezes the selected billing credential's environment (including known Beam
endpoint inference), falling back to the deployment environment. The scoped
credential catalog includes only IDs and non-secret Beam connection selectors;
credential payloads and URL authentication data are excluded. Children and retries
inherit the snapshot. A room selects its own authorization environment. A standard
Beam transfer additionally checks its actual frozen target environment, so a room
grant cannot authorize a transfer into a different environment by itself.

## Computation and transfer participation

The room governs participants, resources, exchanges and permissions. It does not
change the action's execution target. The Studio Action Runner still executes
`@beam/room-transfer`; source and recipient members participate in the transfer.
Membership and storage capability do not make a member an action executor.

An empty recipient list still means every other eligible member. The coordinator
freezes recipients at publication authorization. Workflow inheritance neither
narrows that list nor chooses executors from it.

## Current authorization

Immutable snapshots record intent, not permission grants. The Action Dispatcher
and Action Runner call the Studio API before dispatch, child launch, retry, lease
renewal and protected resource operations. The API checks the current execution
credential, account and project access, initiating user or MCP token, referenced
credentials, action trust/checksums, configured execution location, and effective
room. Room checks use a fresh coordinator delegation and current membership and
channel grants. Credential reads also reject disabled, expired and revoked keys.
MCP runs retain their initiating token ID and recheck its current run scope, expiry
and revocation. Empty or malformed stored MCP scopes grant no permissions.

The account authority is `POST /v1/workflow-execution/authorize` in the Beam
account API. Studio calls it with the run's execution key as
`Authorization: Bearer <key>`, and Beam takes the organization from that key.
Deploy that endpoint before enabling the new execution services. Set
`BEAM_STUDIO_API_URL` on both Dispatcher and Runners.
Absent or unavailable authority blocks work. Authorization failures cannot renew
an expired task lease. No account, vault or room-service secret is passed to an
action; internal requests use a per-run capability or current task claim.

Revocation requests recursive cancellation. Cancellation APIs return
`cancelRequested`, which is distinct from confirmed executor/resource cleanup.
Transfer cleanup uses the original durable publication dispatch or storage job,
so a revoked publishing grant cannot authorize new work or prevent the cleanup
request. Cleanup remains pending when no durable publication identity is yet
available. Common executor settlement and cleanup fencing are part of the
[executor integration](workflow-executors.md).

## Verification

- `workflowRoomContext.test.ts`: transitive inheritance, child-only context,
  action-local selections, conflicts, frozen definitions, and concurrent catalog
  changes sharing the definition snapshot.
- `execution-authorization.test.ts`: real PostgreSQL credential/action revocation,
  account denial, task identity and lease fencing, and room grant revocation.
- `workflow-routes.test.ts`: original publication identity and cleanup without a
  fresh membership lookup.

These checks use an isolated PostgreSQL database. A deployed Studio has
executed both DEV and PROD Beam room workflows. Live member respond-grant
revocation rejected result settlement and confirmed cleanup.
