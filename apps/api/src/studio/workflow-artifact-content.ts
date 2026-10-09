import { createHash } from "node:crypto";
import { pgOne, type PgPool } from "@beam-studio/db";

type Row = Record<string, unknown>;
type Scope = { organizationId: string; projectId: string | null };
type Artifact = {
  workflow_run_id: string;
  organization_id: string;
  project_id: string | null;
  manifest_id: string;
  manifest_status: string;
  task_id: string;
  workflow_step_run_id: string;
  assignment_id: string;
  attempt: number;
  artifact_id: string;
  sha256: string;
  size_bytes: number | string;
  media_type: string;
  artifacts_json: unknown;
  result_json: unknown;
};
const maxArtifactBytes = 32 * 1024;
const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const hash = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Select an identity from a completed task and its current manifest in the exact scope. */
async function findAcceptedArtifact(
  pool: PgPool,
  input: Scope & { runId: string; artifactId: string },
) {
  return pgOne<Artifact>(
    pool,
    `SELECT r.id AS workflow_run_id,r.organization_id,r.project_id,
       m.id AS manifest_id,m.status AS manifest_status,m.task_id,m.assignment_id,
       m.attempt,m.workflow_step_run_id,m.artifacts_json,m.result_json,i.artifact_id,
       i.sha256,i.size_bytes,i.media_type
     FROM execution.workflow_runs r
     JOIN execution.workflow_artifact_manifests m ON m.workflow_run_id=r.id
       AND m.status IN ('accepted','unavailable')
     JOIN execution.workflow_tasks t ON t.id=m.task_id
       AND t.workflow_run_id=r.id AND t.status='completed'
     JOIN execution.workflow_artifact_identities i ON i.task_id=t.id
       AND i.workflow_run_id=r.id
       AND i.artifact_id=$4
     WHERE r.id=$1 AND r.organization_id=$2
       AND r.project_id IS NOT DISTINCT FROM $3::text
       AND m.artifacts_json @> jsonb_build_array(jsonb_build_object('artifactId',$4::text))
     LIMIT 1`,
    [input.runId, input.organizationId, input.projectId, input.artifactId],
  );
}
export type ContentDependencies = { findAcceptedArtifact: typeof findAcceptedArtifact };
const defaults: ContentDependencies = { findAcceptedArtifact };
export type ArtifactContentResult =
  | { status: "not_found" | "unavailable" }
  | { status: "ok"; bytes: Uint8Array; mediaType: string; sha256: string };

/** Revalidate the selected bytes against the pinned identity, even though acceptance did so. */
function acceptedBytes(artifact: Artifact): Uint8Array | null {
  const size = Number(artifact.size_bytes);
  if (
    !Number.isSafeInteger(size) || size < 0 || size > maxArtifactBytes ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.sha256) ||
    !/^[\w.+-]+\/[\w.+-]+$/.test(artifact.media_type)
  ) return null;
  const entries = Array.isArray(artifact.artifacts_json) ? artifact.artifacts_json : [];
  const result = record(artifact.result_json);
  const outputs = Array.isArray(result.artifacts) ? result.artifacts : [];
  const manifest = record(result.artifactManifest);
  const embedded = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const index = entries.findIndex((item) => record(item).artifactId === artifact.artifact_id);
  if (
    index < 0 || entries.length !== outputs.length ||
    entries.length !== embedded.length ||
    manifest.publicationId !== artifact.assignment_id
  ) return null;
  const pinned = record(entries[index]);
  const copy = record(embedded[index]);
  const output = record(outputs[index]);
  const metadata = record(output.metadata);
  if (
    pinned.artifactId !== artifact.artifact_id ||
    pinned.sha256 !== artifact.sha256 || pinned.sizeBytes !== size ||
    pinned.mediaType !== artifact.media_type ||
    copy.artifactId !== pinned.artifactId || copy.port !== pinned.port ||
    copy.index !== pinned.index || copy.sha256 !== pinned.sha256 ||
    copy.sizeBytes !== pinned.sizeBytes || copy.mediaType !== pinned.mediaType ||
    (output.id !== undefined && output.id !== artifact.artifact_id) ||
    output.mediaType !== artifact.media_type ||
    metadata.port !== pinned.port || metadata.sha256 !== artifact.sha256 ||
    metadata.bytes !== size || metadata.workflowRunId !== artifact.workflow_run_id ||
    metadata.stepRunId !== artifact.workflow_step_run_id ||
    metadata.taskId !== artifact.task_id ||
    metadata.assignmentId !== artifact.assignment_id ||
    metadata.attempt !== artifact.attempt ||
    typeof output.uri !== "string" ||
    output.uri.length > 128 + Math.ceil(maxArtifactBytes / 3) * 4
  ) return null;
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]*)$/.exec(output.uri);
  if (!match || match[1] !== artifact.media_type) return null;
  const bytes = Buffer.from(match[2]!, "base64");
  return bytes.length === size && bytes.toString("base64") === match[2] &&
    hash(bytes) === artifact.sha256 ? bytes : null;
}

/** Called only after Studio request-context authenticates the organization and any selected project. */
export async function readWorkflowArtifactContent(
  pool: PgPool,
  input: Scope & { runId: string; artifactId: string },
  deps: ContentDependencies = defaults,
): Promise<ArtifactContentResult> {
  if (!input.organizationId || !input.runId || !input.artifactId)
    return { status: "not_found" };
  const artifact = await deps.findAcceptedArtifact(pool, input);
  if (
    !artifact || artifact.workflow_run_id !== input.runId ||
    artifact.organization_id !== input.organizationId ||
    artifact.project_id !== input.projectId ||
    artifact.artifact_id !== input.artifactId
  ) return { status: "not_found" };
  if (artifact.manifest_status !== "accepted") return { status: "unavailable" };
  const bytes = acceptedBytes(artifact);
  if (!bytes) return { status: "unavailable" };
  const current = await deps.findAcceptedArtifact(pool, input);
  if (
    !current || current.workflow_run_id !== input.runId ||
    current.organization_id !== input.organizationId ||
    current.project_id !== input.projectId ||
    current.manifest_id !== artifact.manifest_id ||
    current.manifest_status !== "accepted" ||
    current.artifact_id !== artifact.artifact_id ||
    current.sha256 !== artifact.sha256 ||
    Number(current.size_bytes) !== bytes.length
  ) return { status: "unavailable" };
  return { status: "ok", bytes, mediaType: artifact.media_type, sha256: artifact.sha256 };
}
