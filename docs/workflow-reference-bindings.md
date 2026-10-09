# Workflow agent and resource bindings

Definitions may name managed-agent and resource references alongside the public
input/output contract. They are bindings, not executable steps. An agent reference
does not select an action backend or grant execution capability. The action's
declared execution target and current permissions still govern execution.

The contract editor, workflow graph API and assistant workflow create/update-graph
operations accept `agentBindings` and `resourceBindings`. Names start with a letter
and contain letters, digits, underscores or hyphens, with at most 64 characters.
Each map supports at most 128 names. Unknown descriptor properties are rejected.

```json
{
  "agentBindings": { "source": { "agentId": "managed-agent-id" } },
  "resourceBindings": {
    "account": { "kind": "credential", "credentialId": "credential-id" },
    "sourceObject": {
      "kind": "storage",
      "endpoint": {
        "provider": "s3",
        "bucket": "source-bucket",
        "objectKey": "reports/input.csv",
        "credentialId": "storage-credential-id"
      }
    },
    "service": { "kind": "endpoint", "url": "https://example.com/api" },
    "settings": { "kind": "data", "value": { "batchSize": 100 } }
  }
}
```

`room-channel` resources contain `room: { environmentTemplateKey, roomId }` and
`channelId`. They describe an existing room resource; they do not establish a
workflow room or change siblings' context. An action using the reference still
passes the ordinary room resolution, conflict and permission checks.

Storage uses the existing object-storage endpoint descriptor. Endpoint URLs must
be HTTP(S), without user information, query parameters or fragments. Store secrets
in the vault and bind credential IDs; do not put secrets in literal data. Snapshot
creation never reads or copies credential payloads.

## Using a reference

Use a reference as the entire JSON string value in an action configuration or
an action/child-workflow input binding:

```json
{
  "agentId": "${workflow.agents.source.agentId}",
  "endpoint": "${workflow.resources.sourceObject.endpoint}",
  "batchSize": "${workflow.resources.settings.value.batchSize}"
}
```

The editor's reference picker exposes available expressions. Whole-value binding
retains objects, arrays, numbers and booleans. Named references do not support text
interpolation. Missing names/fields and reserved prototype paths fail clearly.
Literal data that resembles another expression stays literal, including inside
loops and fan-out. Reference values are never evaluated a second time.

Authored expressions remain in immutable definition history. Root-run creation
resolves each definition's own references into its frozen executable snapshot.
Editing a definition changes neither an accepted run nor its explicit retries;
running the definition again resolves the current references. Children receive
only their declared input bindings, including any values explicitly passed by the
parent. They do not inherit the parent's named bindings.

Managed-agent and credential references must belong to the definition's
organization and applicable project. Offline agents can be referenced; revoked
agents cannot. Current account authorization, agent revocation, credential expiry
and scope are checked again before launch, dispatch, retry, lease renewal and
protected resource access. Named bindings do not replace manifest-declared
credential requirements, membership, room grants or local executor policy.

## Verification

`packages/core/src/workflows/references.test.ts` covers descriptor validation,
missing/prototype references, typed resolution and literal expression isolation.
The PostgreSQL composition suite covers frozen child inputs, authored history,
retry and run-again. The API authorization suite verifies current revocation and
cross-organization rejection after references have been frozen.
