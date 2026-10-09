# Room artifact authorization

Room membership and a live executor session are necessary but do not grant
artifact access. Studio checks three current authorities for every protected
operation: the account's `actions:execute` grant (through the existing Website
authorization endpoint), the room channel grants, and the managed member's local
action policy. The assignment capability identifies one task attempt; it never
substitutes for a current grant. Authorization-only checks do not reserve billing
credits or return account, room or storage credentials.

| Operation                                | Room checks                                                                | Frozen source of destinations                              |
| ---------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Candidate placement and dispatch         | requester `request`, executor `respond`; all planned artifact grants below | task metadata and action target                            |
| Input read, cached copy, recovery        | source `publish`, executor `subscribe` on the source channel               | `workflow_tasks.metadata_json.artifactInputs[port][index]` |
| Output staging, publication, copy, retry | executor `publish`, every target `subscribe` on the destination channel    | `workflow_tasks.metadata_json.artifactPublications[port]`  |

For each input, the frozen `artifactInputs` entry contains `manifestId`,
`artifactId`, `sha256`, `sizeBytes`, `mediaType` and a room location with `kind`,
`roomId`, `channelId`, `sourceMemberId`, `memberId` and `transferId`. Studio
converts that entry into a `room-artifact:<artifactId>` invocation descriptor.
The input authorization endpoint selects by port and index; it does not accept a
caller-supplied source. It requires an accepted manifest, matching immutable
identity, an available verified copy, and current grants. A recipient copy also
requires a completed transfer with full delivery evidence. A retained source
copy uses its accepted local copy ID as `transferId` and is checked by hash on
the member before use. The same endpoint is called again for a cached copy.

`POST /api/internal/executor-assignments/:assignmentId/inputs/:port/:index/authorize`
accepts `input.read`, `input.copy` or `input.recover` and returns the artifact
identity and authorized location without an arbitrary URL. Output operations
call `POST /api/internal/executor-assignments/:assignmentId/artifacts/authorize`
with `output.copy`, `output.publish` or `output.recover`, a declared port and
artifact identity. Its response contains only the frozen publication plan.
Both endpoints require the assignment capability and a live lease. They
recheck the account and room authorities each time.

For artifact ports, placement requires the advertised
`action-execution/v1.maxArtifactBytes` and an effective local policy budget of
at least 128 KiB. The invocation freezes `storageReservationBytes=131072`,
covering the shared runtime's 64 KiB total artifact limit plus a bounded
working copy. An agent can still decline when its current quota or disk space
cannot reserve that amount.

Confirmed denial returns 403 and requests cancellation and applicable cleanup
on the next assignment reconciliation. An unavailable authority returns 503;
it never grants access or extends the lease. An expired or cancelled lease
returns 403 with `executor_lease_expired_or_cancelled`. Cleanup may use its
restricted existing capability to remove previously authorized resources; it
cannot publish or read a new artifact.

The accepted artifact tables and the helper that freezes routed input entries
are provided by the artifact acceptance package. Distributed v3 execution remains gated; this
contract does not enable that graph version by itself.
Until independent provider readback and retention attestation are available,
publication plans must select explicit `temporary` availability backed by an
accepted retained source copy. A `durable` plan remains pending.
While an assignment is active, a failed publication can resume from the same
artifact identity after a fresh authorization check. If the last accepted
copy is lost after task completion, the acceptance package marks the manifest unavailable and
refuses downstream input binding. A new post-completion recovery assignment is
outside this phase.
