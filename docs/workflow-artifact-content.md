# Read accepted Room Workflow artifact content

`GET /studio/workflow-runs/:runId/artifacts/:artifactId/content` returns at
most 32 KiB of bytes from the accepted result of a completed Room Workflow
task. It uses the authenticated Studio browser session and requires authorized
`x-organization-id` scope. A selected `x-project-id` must match the run's
project exactly; with no selected project, only organization-scoped runs whose
`project_id` is null can be read.

Artifact acceptance already verifies each bounded inline result against its
manifest SHA-256 and byte count and persists that result. This route selects
the artifact identity from the scoped run and current accepted manifest, then
revalidates the matching result artifact's identity, provenance, canonical
base64, length, media type and SHA-256. It checks that the manifest remains
accepted before returning the bytes. The response is an attachment with
`application/octet-stream`, `Cache-Control: no-store`, and `nosniff`.
The API does not expose the stored result JSON or other task artifacts.

An absent or out-of-scope identity returns 404. An unavailable manifest or
invalid retained bytes returns 409
`workflow_artifact_content_unavailable`. The endpoint does not require a
storage provider; availability is still governed by the manifest's current
accepted status. It can prove reducer counts and final ring lot provenance
when those tasks have accepted output manifests.
