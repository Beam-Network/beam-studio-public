export type ArtifactCopySourceLocator = {
  type: "artifact_copy";
  assignmentId: string;
  attempt: number;
  port: string;
  index: number;
  artifactId: string;
  copyId: string;
  sha256: string;
  sizeBytes: number;
  retentionObligationId: string;
  requiredUntil: string;
  storageMemberIds: string[];
};

export function artifactCopyOriginKey(input: {
  assignmentId: string;
  attempt: number;
  port: string;
  index: number;
  recoveryGeneration: number;
}) {
  return `artifact:${input.assignmentId}:${input.attempt}:${input.port}:${input.index}:${input.recoveryGeneration}`;
}

/** Mirrors the agent's immutable output identity; a caller cannot relabel an
 * input CopyID as a planned output port. */
export function expectedActionArtifactId(input: {
  assignmentId: string;
  attempt: number;
  port: string;
  index: number;
  sha256: string;
}) {
  return createHash("sha256")
    .update(
      `${input.assignmentId}\0${input.attempt}\0${input.port}\0${input.index}\0${input.sha256}`,
    )
    .digest("hex");
}

export function parseArtifactCopySourceLocator(
  value: unknown,
): ArtifactCopySourceLocator {
  const locator = object(value);
  if (
    locator.type !== "artifact_copy" ||
    !identifier(locator.assignmentId) ||
    !Number.isSafeInteger(locator.attempt) ||
    Number(locator.attempt) < 1 ||
    typeof locator.port !== "string" ||
    !/^[a-z][a-zA-Z0-9_]*$/.test(locator.port) ||
    !Number.isSafeInteger(locator.index) ||
    Number(locator.index) < 0 ||
    Number(locator.index) >= 16 ||
    !identifier(locator.artifactId) ||
    !identifier(locator.copyId) ||
    typeof locator.sha256 !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(locator.sha256) ||
    !Number.isSafeInteger(locator.sizeBytes) ||
    Number(locator.sizeBytes) <= 0 ||
    !identifier(locator.retentionObligationId) ||
    typeof locator.requiredUntil !== "string" ||
    !Number.isFinite(Date.parse(locator.requiredUntil)) ||
    !Array.isArray(locator.storageMemberIds) ||
    locator.storageMemberIds.some((member) => !identifier(member)) ||
    new Set(locator.storageMemberIds).size !== locator.storageMemberIds.length
  )
    throw new Error("room_storage_artifact_copy_locator_invalid");
  return locator as ArtifactCopySourceLocator;
}

export function artifactCopyCommandSource(locator: ArtifactCopySourceLocator) {
  return {
    assignment_id: locator.assignmentId,
    attempt: locator.attempt,
    artifact_id: locator.artifactId,
    copy_id: locator.copyId,
    sha256: locator.sha256,
    size_bytes: locator.sizeBytes,
    retention_obligation_id: locator.retentionObligationId,
    required_until: locator.requiredUntil,
  };
}

export function assertArtifactCopyInspection(
  locator: ArtifactCopySourceLocator,
  inspected: unknown,
) {
  const source = object(object(inspected).source);
  const file = object(source.file);
  if (
    source.kind !== "output" ||
    source.artifact_id !== locator.artifactId ||
    source.copy_id !== locator.copyId ||
    source.sha256 !== locator.sha256 ||
    Number(file.size_bytes) !== locator.sizeBytes ||
    typeof file.identity !== "string" ||
    !file.identity ||
    !Number.isFinite(Date.parse(String(source.retained_until ?? ""))) ||
    Date.parse(String(source.retained_until)) <
      Date.parse(locator.requiredUntil) ||
    !Number.isFinite(Date.parse(String(source.inspected_at ?? ""))) ||
    Math.abs(Date.now() - Date.parse(String(source.inspected_at))) > 300_000
  )
    throw Object.assign(
      new Error(
        "The agent's retained copy does not match the frozen artifact identity.",
      ),
      { code: "room_storage_artifact_copy_mismatch", statusCode: 409 },
    );
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160;
}
import { createHash } from "node:crypto";
