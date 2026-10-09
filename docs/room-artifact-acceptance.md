# Room artifact result acceptance

`room-artifact-manifest/v1` is an optional field of `ActionResult`. A room-member
result with artifact outputs must include it. The bounded runtime's existing
`artifacts[]` and port metadata remain the byte source: each artifact is a
canonical `data:` URI, at most 32 KiB, with at most 16 artifacts and 64 KiB in
the result. The collection manifest gives each ordered port output an immutable
`artifactId`, SHA-256, byte count and media type. Runtime run, step, task,
assignment and attempt metadata must agree. `publicationId` at the collection
level is the assignment ID; each `transfers[]` entry names its Core publication
and transfer IDs separately.

`execution.workflow_tasks.metadata_json.artifactPublications` is the frozen
per-task plan keyed by output port. Each entry fixes room/channel/source,
destinations, `retentionObligationId`, `requiredUntil` and `availability`.
`durable` is the default. `temporary` must be explicit and requires a verified
source-member copy held under `${retentionObligationId}:${index}` through
`requiredUntil`. Recipient delivery locations are observations, not retention
promises. A provider storage location cannot claim durable retention from Core
delivery alone. Studio accepts a versioned S3 storage destination only after
reading back the exact bounded bytes and verifying Object Lock `COMPLIANCE`
retention for that same version through `requiredUntil`. Studio persists the
object version, digest and retention proof. Unsupported providers remain pending.
This verifier currently requires Studio's completed multipart session to map a
Core publication to the provider object key and version. Direct Agent Core
publication does not create that session, so its durable policy remains pending
until the Agent/Core hybrid storage contract supplies the same identity.

For each expected recipient, Studio reads the Coordinator object status and
execution evidence with its organization service credential. It requires Core's
`full_delivery_verified`, the exact frozen recipient set, recipient verification
time/basis, matching publication and transfer IDs, and a final receipt whose
manifest commitment equals the commitment recomputed from the artifact's
actual bytes at Core's chunk size. Core `file.identity` is a path/stat identity,
so it is never treated as a content hash. An unavailable Coordinator or missing
receipt leaves the candidate pending; the agent's own Boolean cannot accept it.

Candidate manifest, locations, transfers, artifact identities and retention
obligations are committed in the same PostgreSQL transaction as task settlement.
An incomplete candidate keeps the original assignment/attempt active and
`action.publish` retries the retained bytes without running the action again.
Accepted manifests are immutable. The task claim, attempt and session generation
fence duplicate or superseded results; result metadata cannot replace the
frozen `artifactInputs` or `artifactPublications` plan. A lost last copy marks
the manifest `unavailable`; later input reads and route freezing fail explicitly.
Studio sends `action.artifact.release` only after the whole run is terminal and
the frozen retention deadline passes. An authenticated `released:true` response
with `cleanupConfirmed:false` moves the obligation to `releasing`; Studio
retries with a new command after other holds have been released. Only
`cleanupConfirmed:true` marks it `released`. A completed run whose last verified
copy is reported lost keeps its historical status but changes
`output_validation` to `invalid`; active consumers fail on their next read.
Release revokes the source-copy location immediately, since its hold no longer
guarantees availability. If no other verified copy remains after the contracted
retention period, the manifest becomes unavailable without changing the
historical completion result.

The v3 distributed graph execution gate remains in place. Its future task
planner must write `artifactPublications` when it inserts tasks and use
`freezeWorkflowArtifactInputPg` to place accepted, verified references in
`artifactInputs`. A source member may use its retained local CopyID while the
matching retention obligation is active; recipients require Core delivery
evidence. The current accepted-copy helpers expose the state needed by
distributed execution. Recovery after an already completed assignment needs a new scoped
assignment; this package reports an unavailable artifact instead of silently
claiming recovery. Ordinary provider finalization and governance retention do
not count as a durable hold.
