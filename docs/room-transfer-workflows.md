# Room transfer workflows

Room member lists and summaries show the editable Studio machine or storage-binding
name. Renaming a member preserves its coordinator identity, grants, and transfer
configuration; machine hostnames and coordinator labels remain fallback labels.

The sidebar lists enrolled agents under **Remote Machines**. The **Beta** badge
beside **Beam Studio** describes the application as a whole. The Rooms inventory
toolbar contains Create room without an environment selector; its existing
selected template context remains unchanged. Development environment controls
remain in General Settings and the relevant room/action configuration screens.

Room overviews include a [member permission graph](room-member-graph.md) showing
channel-specific communication rights, provider identities and presence. It uses
the same exact-action permission evaluator as the room transfer controls.

Publication startup stays pending until Studio has committed the coordinator
binding, including when the underlying transfer is already prepared and marked
running. After binding, status comes from the coordinator; a missing publication
is an error and cannot be reported as a successful transfer.

For storage-backed publications, completed Runtime delivery coverage remains
in progress until the storage adapter has verified provider finalization and
settled its durable job. Coverage and recipient evidence remain visible during
this interval. Workflow completion never precedes resource cleanup confirmation;
an unfinished adapter cannot turn successful delivery into a cleanup race.

Studio implements `@beam/room-transfer@2.1.2` through the normal workflow
graph, registry lock, trigger, task claim, worker, retry, cancellation, and run
history paths. **Rooms → Transfers → Send file** creates that same workflow and
opens its run. The workflow editor supports manual and scheduled room transfers.

## Configuration and authorization

CLI storage publications use the billing identity recorded when their room was
created. Studio resolves that identity only to an exactly matching credential
owned by the same organization. Selecting a Beam environment does not authorize
charging a different key. Historical rooms without a billing identity must be
recreated through normal public room creation with an explicit billing key;
existing room memberships and workflows are not rewritten automatically.

Required configuration is `environmentTemplateKey`, `roomId`, `channelId`, and
`source: {memberId, locator}`. An agent source uses an `agent_path` locator; an
object-storage member uses a `bucket_object` locator. Action configuration stores
only the stable template key and member identities. Studio resolves its coordinator URL from the organization template
when it issues a room command or reconciles cancellation. The migration removes
retired `environment` and `coordinatorUrl` fields and locks current room workflows
to the matching immutable action release. Historical run snapshots are preserved.
An optional [workflow room](workflow-room-context.md) supplies `roomId` and
`environmentTemplateKey` before action validation, including through nested calls.
Without an effective workflow room these fields remain the action's own selection.
This does not move computation off the Studio Action Runner or change recipients.
Optional configuration remains `targetMemberIds` (empty selects all authorized
subscribers), `ttlSeconds` (30–86400, default 600), and `allowPartial` (default
false). Agent sources must be nonempty regular files inside enrolled filesystem
roots. Bucket sources are selected through the existing credential and object
browser and are frozen by size and provider object identity before execution.

The source needs active membership and a publish grant on an active object
channel. Agent sources also need `room-workflows/v1`; bucket sources need the
`source` capability and a Studio binding backed by an available credential.
Destinations need subscribe grants and the applicable agent or bucket capability.
The coordinator freezes recipients when publication is
authorized. Joining later does not add a recipient. Leaving, going offline,
losing authorization, or exceeding the TTL can make a recipient unavailable.
Room/channel closure and membership revocation retain their normal authorization
semantics; workflow execution does not bypass them.

Object-storage room members are thin bindings over the existing organization
credential, provider-profile, vault-version, and storage-browser systems. A
binding records the bucket, Beam environment template, coordinator resource
identity, object channels, destination layout, collision policy, and source
delegates. It does not copy credentials or create a second storage inventory.
Supported profiles are S3, R2, MinIO, Wasabi, Backblaze B2, custom S3-compatible
endpoints, Hippius S3, and Hugging Face Storage Buckets through the namespace
scoped `s3.hf.co` profile. The same stable bucket resource may be attached to
multiple rooms. Credential deletion is blocked while a binding references it;
rotating the credential version preserves the binding.

The Add bucket member form accepts the exact provider bucket name, not its display
label, URL, or object path. Bucket access checks wait until typing has stopped for
500 ms. Invalid names, missing buckets, and rejected credentials display actionable
errors without provider request details. Input validation failures are not retried;
attachment remains disabled until the current credential and bucket are verified.
The provider remains authoritative for naming rules, including Hugging Face bucket
names containing underscores.

Beam environment selection is independent of the Studio deployment.
Public/default Studio mode has no selector and forces the built-in PROD template
server-side, ignoring browser template overrides. When
`BEAM_STUDIO_DEV_SETTINGS_ENABLED=true`, General Settings exposes Beam
environment templates. PROD remains the default template, DEV is available for
development work, and PROD cannot be edited through Studio because it is owned
by deployment defaults. The Rooms header, room creation dialog, quick-send, and
room-transfer action node select a template instead of redefining endpoint URLs.
Studio validates the browser's organization, then uses an
organization/template-scoped service credential for coordinator access. The
source also checks the coordinator URL against its own enrollment before
accepting a workflow command. Changing the selected template clears room,
channel, source, and recipient choices. Switching organizations reloads Studio
and discards cached room data.

The workflow billing key pays the normal Studio workflow invocation charge.
Room authorization and the room's BeamCore billing binding govern data transfer;
no browser bearer, Beam API key, or service credential is passed to the action.

## Editor experience

The action editor loads a paginated room list, then fetches channels, eligible
sources, and recipients only for the selected room. Room and member pickers are
searchable. The recipient picker supports role, presence, and selected-only
filters, server-side pagination, and select-all-matching. An empty recipient
selection is the constant-size **Everyone eligible** mode; explicit selections
have no Studio-defined count limit. Coordinator authorization and active-channel
capacity remain authoritative at execution time.

When a room has one eligible object channel or source agent, Studio selects it
automatically. Source paths are checked for absolute syntax using the selected
agent platform and recent successful paths for that agent and Beam environment
are offered without browsing its filesystem. Strict or partial completion and
transfer lifetime controls live under Advanced delivery settings.

## Execution and recovery

The worker exposes permission-gated `beam.rooms.publish/status/cancel` RPCs.
Its API requests carry the current task claim. The API obtains organization,
source, Beam environment template, and payload from the locked run snapshot, not
caller fields. Status reads use the coordinator's organization object status
endpoint and keep working when the source agent goes offline.

For direct room transfers, the initial publication expiry is an admission
window, not a total execution lifetime. A progressing publication has a
300-second idle deadline renewed only by Core-verified new recipient coverage.
Studio accepts that deadline only from its direct Coordinator status read when
the preflight's publication-key digest, room, channel, publisher and publication
match the locked workflow step. It persists the deadline under the live task
claim and uses it to guard the worker sandbox and assignment lifecycle. A
duplicate result or action-reported progress cannot renew execution. Manual
progressing runs have no separate fixed total-lifetime cap; explicit
cancellation, revocation and the scheduled-run maximum still apply.

Temporary control or execution-authority unavailability pauses room status and
result finalization within those existing deadlines. Requests retry serially
with bounded backoff and the same command identity and claim; failed requests
never renew a deadline. Finalization requires fresh successful authorization,
and confirmed denial stops immediately. Cancellation retains a separate bounded
cleanup window after the execution signal is aborted. Generic actions keep
their existing retry behavior.

Each step run has one publication key, `workflow-step:<stepRunId>`. Command
delivery attempts use separate identifiers; uncertain POST retries retain the
same command ID. Agent retries reuse the publication, and retained cancellation
tombstones prevent late commands or restarts from republishing it. A new workflow
run deliberately creates a new publication. After an uncertain manual run-start
response, open the created workflow to inspect its runs before starting another.

Success requires every snapshotted recipient to complete. Explicit partial mode
also accepts Core's terminal `partial` status when at least one recipient
completed. Per-recipient states, unavailable reasons, completed chunks, filename,
file size, chunk size, chunk count, environment template key, expiry, and
publication identity appear in step state and successful outputs. Room history
links back to the originating workflow run.

Workflow cancellation and timeout send cancellation to the original source.
`cancellationStatus` distinguishes pending, confirmed, and unresolved cleanup.
An API reconciler continues cleanup after worker death or exhausted execution
retries, using the durable command journal. It retries expired deliveries until
the original TTL plus 60 seconds, then records unresolved cleanup. A cancelled
workflow does not by itself prove that the data plane acknowledged cancellation.
Recipient failures and terminal transfer failures are non-retryable; transient
control failures reattach to the same publication.
The run's Retry control is disabled when a failed/cancelled room step records a
failed/cancelled/expired publication, a cancellation request, or an expired lifetime. The
shared API/MCP retry lifecycle rejects these requests with HTTP 409 and
`room_transfer_retry_unavailable` before changing tasks, billing, or attempts.
Use Run again to create a new publication. A retry before publication or after a
transient control failure remains available and preserves its existing identity.
An interrupted successful completion/partial-result observation also remains
reattachable while its existing publication lifetime is valid.

Agent-only publications use `room-transfer/v1` and `room.transfer.e2ee.v2`.
Agents encrypt and decrypt using the room channel MLS keys; workers carry ciphertext.
Any publication involving storage freezes provider-TLS protection for **all** its
recipients, including agents. Workers see plaintext in these hybrid publications.
Bucket-only publications remain on the standard transfer lifecycle. Studio binds
the prepared transfer's existing ownership proof, plan fingerprint and exact
destination identities to the coordinator publication before distributing routes.
That proof is transient, never a workflow output or saved room credential.
Runtime supplies room progress and verified provider completion; Studio does not
manufacture recipient completion. Both the publication and standard Runtime
execution IDs remain available in execution evidence. Other storage
publications use `room-storage-transfer/v2` and `room.transfer.storage.v2`.

Runtime assigns disjoint source ranges, each carrying every selected destination.
A worker reads each chunk once and reuses that buffer across its destinations.
Recovery targets only missing chunk/destination coverage. Source inspection and
range serving remain on agents, which receive no provider URLs or storage commands.
Agents make outbound connections to TLS worker endpoints with certificate identity
bound by coordinator assignments; no agent ingress port is required.

The adapter prepares provider operations with the existing SDK and credential
inventory, submits one Runtime publication, verifies ListParts results, and finalizes
uploads. Only Runtime's accepted worker results plus provider verification or agent
receipts establish completion. Studio's queued/preparation status cannot claim delivery.
Routes expire within both the assignment and publication, with at most 60 seconds of
validity. Every refresh reauthorizes the worker, range, operation and current attempt.
Source requests bind the frozen ETag/version; uploads bind the worker's Content-MD5.
Storage uses the standard multipart attempt slots, without a room-specific part policy.

Publication preparation, frozen file identity, upload identities, and verified part
manifests are durable. Restart recovery signs new routes for the same operations.
A completed provider object can be recovered only with its operation marker and the
previously persisted verified manifest. Cancellation revokes Runtime work and agent
access, aborts unfinished uploads, and reports incomplete cleanup explicitly.
Provider completion is recorded before its coordinator acknowledgement. If that
acknowledgement is interrupted, cleanup reconciles upload absence, object identity,
and the durable verified part manifest; a completed object is preserved. This does
not change a cancelled publication into successful delivery. Unknown revocation
or provider cleanup remains `cancel_requested` with `room_storage_cleanup_incomplete`
and is retried through the existing storage-job lease lifecycle. Explicit cancellation
can also retry cleanup for historical failed jobs that still have active uploads.
A provisional executor-cleanup warning is superseded only after independent room
resource completion and Runner termination are verified. Terminal cancellation
reports the confirmed outcome; unrelated failures and uncertain cleanup remain visible.

Chunk layout is requested from Runtime's standard policy, including provider minimums,
jitter and multipart part limits. There is no Studio chunk-size override or independent
chunking calculation. Hippius S3 and Hugging Face Storage Buckets retain their existing
provider profiles; token-based Hub repository transfers are a different feature.

Execution evidence exposes publication, Runtime transfer, orchestrator, worker, range,
source-read counters, destination coverage and finalization identities. It never includes
provider routes, headers, path tokens, credentials, or room keys.
The run page loads durable detail first, then requests
`GET /studio/workflow-runs/:id/evidence` independently. That endpoint and
`beam.get_workflow_run` share organization-scoped coordinator inspection,
including after terminal delivery. Evidence carries the step-run ID, attempt,
publication ID and inspection status/time; the UI only overlays matching diagnostics
into `state.executionInspection` and `state.execution`. Failed or denied inspection
hides stale diagnostics while the durable run remains available.
This refresh never changes the saved run, its public output, or settlement. Pending
projection and unavailable source-read counters are shown explicitly, never as zero.
The source display accepts the action's authored `source.memberId` and the
coordinator endpoint's `source.member_id`. Historical recipient displays may use
refreshed encrypted execution evidence only when its publication identity,
`room-transfer/v1` schema, AEAD protection, and target member all match. Missing
or conflicting evidence remains unknown; room membership alone never implies
E2EE. This display does not rewrite historical recipients or protection summaries.
Detailed inspection is nullable when unavailable and does not replace authoritative
publication settlement or recipient receipts.

## API and MCP

- `POST /studio/room-workflows`: `{name, apiKeyId, requestId, config}` creates a
  canonical workflow. Reusing `requestId` with different configuration is rejected.
- Existing workflow run, run-detail, retry, child workflow, and schedule APIs execute it.
- MCP: `beam.list_rooms`, `beam.create_room_workflow`, `beam.run_workflow`,
  `beam.get_workflow_run`, `beam.cancel_workflow_run`. They require, respectively,
  `read:transfers`, `write:transfers`, `run:transfers`, `read:runs`, `cancel:runs`.
  The API verifies the original MCP token hash, expiry, revocation, organization,
  and scope. A token ID or supplied organization header is not authority.

## Deployment dependencies

1. Apply BeamCore coordinator migration `0028_room_object_control.sql` and deploy
   coordinator plus Transfer Runtime together. They must share the room-control
   signing secret. Object history now comes from the coordinator's durable
   projection, not cross-service reads of Core tables.
2. Upgrade full source and destination agents to advertise `room-workflows/v1`
   and `room.transfer.storage.v2`. Keep their
   publication state directory persistent. Enroll each with the intended Beam
   coordinator/template and Studio organization; configure filesystem roots and
   grants. Agents need outbound TLS access to hybrid-capable workers.
3. Deploy participant workers with `room.transfer`,
   `room.transfer.direct.v1`, and `room.transfer.e2ee.v2`, plus a reachable `BEAM_ROOM_TRANSFER_PORT` and
   matching advertised URL. Expose that TCP port alongside the media signaling
   port. Workers without the direct and E2EE capabilities are ineligible.
4. Build and register the immutable room-transfer action artifact as
   `@beam/room-transfer@2.1.2`, including its manifest and checksum. Workers require
   the registry artifact; there is no bundled fallback. Refresh the registry
   catalog before creating the workflow. Deployment preflight reports whether the
   public Registry exposes the template-only config schema and immutable artifact
   metadata; it does not block the deployment. On first startup, the API installs
   that exact immutable version through Studio's existing public Registry
   installer, verifies it is present locally, and only then migrates saved
   workflows and locks. If it cannot be installed, or the installed manifest
   still carries the retired `environment` or `coordinatorUrl` fields, the API
   still starts: room transfers report themselves unavailable and the install is
   retried, so publishing the release restores them without a restart. Later restarts read the installed version without a Registry write.
   The action marketplace creates new nodes from the latest installed package
   version shown on its card, so the saved version range and manifest cannot
   silently come from an older installed row.
5. Deploy Studio API, storage adapter, worker, MCP, and frontend. Set `BEAM_STUDIO_API_URL` on the
   worker and MCP to the internal Studio API. The deployment templates include
   this URL and add `@beam/room-transfer` to
   `WORKER_TRUSTED_NODE_ACTION_PACKAGES`.
6. Room control needs no Studio secret. Background delegation uses the
   organization Beam API keys stored in Studio (run execution key, storage job
   key, or the organization's default billing key); the coordinator verifies
   them with the Beam API. Existing consumer bootstrap credentials remain separate.

## Verification boundary

Local coverage includes action success/partial policy/retry attachment/timeout,
claim and template isolation, command retry identity, durable cancellation,
agent tombstones, and coordinator mismatch rejection. Studio validates action
configuration against the resolved manifest when a graph is saved and again in
every manual, event, scheduled, and child workflow resolution path; incompatible
configuration is rejected before a run is queued or billed. Existing worker registry,
sandbox, credential-default, and retry tests remain relevant. TypeScript checks
and Go compilation cover changed services. One existing Windows agent filesystem
test requires symlink privileges; run that full suite on Linux. Local checks do
not prove provider behavior, file integrity, service credentials, or browser
behavior.

## Provider verification and cleanup

Provider verification runs independently of the publication polling loop. Slow ListParts, completion, or HEAD calls have an abortable timeout; cancellation revokes coordinator access and interrupts in-flight metadata calls before aborting unfinished uploads. Transient provider control failures retry within the publication lifetime. If completion was accepted before cancellation, cleanup reports the ambiguous final object instead of claiming it was removed.

Temporary coordinator status/evidence outages (transport errors, timeouts, rate
limits and server errors) retry within the existing publication deadline and
retain its multipart identity and accepted coverage. Coordinator verification
calls during provider finalization use the same transient classification.
Ownership loss interrupts the polling wait; user cancellation is checked on
each iteration. Authorization failures and oversized control responses remain
terminal. A restart never creates a replacement publication to hide a failure.

Both bucket-only and hybrid cleanup use the SDK to abort each unfinished upload and confirm `NoSuchUpload` with ListParts. A successful Abort response alone is insufficient. HEAD checks distinguish an unrelated earlier object from an object committed by this execution. Uncertain sessions remain active and the job reports `room_storage_cleanup_incomplete`; completed destinations are retained.

Hugging Face's canonical S3 endpoint does not return user metadata on HEAD. Its existing provider profile declares this limitation. Hybrid finalization still verifies accepted parts, the durable range manifest, final object size and ETag; other endpoints also require the operation metadata marker. Recovery uses the saved verified parts. Cleanup consults current Runtime coverage and durable completed sessions before aborting uploads. An existing object on an endpoint without metadata readback is uncertain cleanup, never proof that an upload was aborted. Adapter failure details remain visible in Studio and CLI status while Runtime delivery coverage is retained; internal assignment cancellation does not turn a provider failure into a user cancellation.

Bucket-only adapter recovery passes the complete saved multipart identities to SDK resume, which re-streams routes with the same upload IDs. Coordinator binding completes in the SDK's `onPrepared` callback before any route publication. The job's ownership signal fences SDK metadata requests, initial routes and background signing; missing or inconsistent saved upload identities fail closed.

Job lease renewal fails closed. A process that loses ownership stops its metadata work without cancelling a replacement process's publication. Multipart identities and their session rows are persisted together under the current job lease. An interrupted multipart-create response without a durable upload ID is explicitly `room_storage_cleanup_incomplete`; a restart never creates a second upload to hide that ambiguity.

API shutdown stops job scanning, aborts active metadata/signing operations, and
stops renewing their ownership leases. A replacement API resumes after the
retained lease expires, using the same publication and multipart identities.
Shutdown does not cancel the user's transfer or abort its resumable uploads.

CLI status and cancellation responses contain canonical publication status only.
Detailed Runtime attempt history remains on the execution API and Studio run
outputs; it is not copied into bounded agent WebSocket control frames. This
keeps terminal replies usable after many recovery attempts without relaxing
transport size limits.

Explicit cancellation of a failed adapter always re-enters independent resource
cleanup, even when no active multipart session remains. A failed job does not
certify Runtime revocation. The normal adapter reconciles coordinator terminal
state and provider cleanup before confirming cancellation; completed/partial
jobs remain preserved.

The normal adapter scan also reclaims failed jobs whose owning organization-scoped
workflow is already cancelled. This repairs interrupted cleanup even when no
Runner assignment or active resource annotation remains. The existing lease
fences concurrent recovery; successful jobs and failed/running workflows are
not reopened. Provider verification preserves an already finalized object and
aborts only unfinished multipart uploads before confirming cancellation.
