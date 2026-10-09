# Workflow Examples

Workflows expose an explicit input/output contract and can call other workflows.
See [Workflow composition](workflow-composition.md) for child-call bindings and
immutable run snapshots. Existing examples initially publish the explicit empty
object result; action outputs become public only through output mappings.

The Studio ships one first-party example:

| Template                       | Steps                             | Purpose                                          |
| ------------------------------ | --------------------------------- | ------------------------------------------------ |
| `wft_example_transfer_webhook` | `@beam/transfer -> @beam/webhook` | Transfer data, then notify an external endpoint. |

To read or write object storage inside a workflow, use `@beam/download` and
`@beam/upload` with an `@beam/object-storage-endpoint`.

## Branching on failure

A Decision node routes on the outcome of the steps feeding it, so a failure can
reach a notification instead of ending the run silently:

```
Trigger -> @beam/transfer -+-> Decision -- true  --> @beam/transfer  (next stage)
                            \             -- false --> @beam/slack     (alert)
```

The Decision joins every input with `all`, so any failed or skipped input takes
the false branch. Turning on **Mark upstream failure as handled** lets the run
finish `completed` after the alert; leaving it off reports the run as `failed`
while still sending the message.

The Slack step binds node metadata rather than outputs, because a failed step
has no outputs:

```
${steps.<transfer>.name} ${steps.<transfer>.status}: ${steps.<transfer>.error}
```

See `workflow-decisions.md` for join modes, the handled-failure rule, the
predicate language, and the full metadata namespace.

The examples are intentionally local-worker only. They validate the action
contract, bindings, manifest-driven configuration, and artifact persistence
without requiring the V2 remote registry.

## Agent file to room recipients

Use the registry action `@beam/room-transfer@2.0.0` with an explicit Beam
environment template, source agent, room, object channel, and local source path.
Select recipient members or leave the list empty for all authorized subscribers. Keep
`allowPartial=false` when every recipient is required. Connect the step to a
manual or schedule trigger using the normal workflow editor.
[Configuration and deployment details](room-transfer-workflows.md).
