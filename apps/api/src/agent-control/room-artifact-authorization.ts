import { WorkflowAuthorizationError } from "@beam-studio/db";
import { roomMemberCan } from "./room-workflow-options.js";

type Snapshot = Record<string, unknown>;

/** A location is selected from a frozen task or accepted manifest, never from an agent request. */
export type RoomArtifactLocation = {
  roomId: string;
  channelId: string;
  sourceMemberId: string;
  recipientMemberIds: string[];
};

export type FrozenArtifactInput = {
  manifestId: string;
  artifactId: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  location: {
    kind: "member" | "storage";
    roomId: string;
    channelId: string;
    sourceMemberId: string;
    memberId: string;
    transferId: string;
  };
};

export type FrozenArtifactPublication = {
  roomId: string;
  channelId: string;
  sourceMemberId: string;
  targetMemberIds: string[];
  retentionObligationId: string;
  requiredUntil: string;
  availability: "durable" | "temporary";
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const id = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 160;
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);

/** The task metadata is frozen by Studio before dispatch. A request only selects port/index. */
export function frozenArtifactInput(
  metadata: unknown,
  port: string,
  index: number,
): FrozenArtifactInput {
  const values = record(record(metadata)?.artifactInputs)?.[port];
  const input = Array.isArray(values) ? record(values[index]) : null;
  const location = record(input?.location);
  if (
    !id(input?.manifestId) ||
    !id(input.artifactId) ||
    !hash(input.sha256) ||
    !Number.isSafeInteger(input.sizeBytes) ||
    Number(input.sizeBytes) < 0 ||
    !id(input.mediaType) ||
    (location?.kind !== "member" && location?.kind !== "storage") ||
    !id(location.roomId) ||
    !id(location.channelId) ||
    !id(location.sourceMemberId) ||
    !id(location.memberId) ||
    !id(location.transferId)
  )
    throw new WorkflowAuthorizationError("executor_artifact_input_unavailable");
  return input as FrozenArtifactInput;
}

export function frozenArtifactPublications(
  metadata: unknown,
): Record<string, FrozenArtifactPublication> {
  const publications = record(record(metadata)?.artifactPublications);
  if (!publications) return {};
  const result: Record<string, FrozenArtifactPublication> = Object.create(null);
  for (const [port, value] of Object.entries(publications)) {
    const plan = record(value);
    if (
      !/^[a-z][a-zA-Z0-9_]*$/.test(port) ||
      !id(plan?.roomId) ||
      !id(plan.channelId) ||
      !id(plan.sourceMemberId) ||
      !id(plan.retentionObligationId) ||
      typeof plan.requiredUntil !== "string" ||
      !Number.isFinite(Date.parse(plan.requiredUntil)) ||
      !Array.isArray(plan.targetMemberIds) ||
      plan.targetMemberIds.some((member) => !id(member)) ||
      (plan.availability !== undefined &&
        plan.availability !== "durable" &&
        plan.availability !== "temporary")
    )
      throw new WorkflowAuthorizationError(
        "executor_artifact_publication_invalid",
      );
    result[port] = {
      ...(plan as FrozenArtifactPublication),
      availability: (plan.availability ?? "durable") as "durable" | "temporary",
    };
  }
  return result;
}

export function assertFrozenRoomArtifactPlansAuthorized(
  snapshot: Snapshot,
  effectiveRoomId: string,
  executorMemberId: string,
  metadata: unknown,
) {
  const inputs = record(record(metadata)?.artifactInputs);
  for (const [port, values] of Object.entries(inputs ?? {})) {
    if (!Array.isArray(values))
      throw new WorkflowAuthorizationError(
        "executor_artifact_input_unavailable",
      );
    for (let index = 0; index < values.length; index++) {
      const input = frozenArtifactInput(metadata, port, index);
      if (input.location.memberId !== executorMemberId)
        throw new WorkflowAuthorizationError("executor_artifact_reader_denied");
      assertRoomArtifactOperationAuthorized(snapshot, effectiveRoomId, {
        kind: "input.read",
        readerMemberId: executorMemberId,
        location: {
          roomId: input.location.roomId,
          channelId: input.location.channelId,
          sourceMemberId: input.location.sourceMemberId,
          recipientMemberIds: [executorMemberId],
        },
      });
    }
  }
  for (const plan of Object.values(frozenArtifactPublications(metadata))) {
    if (plan.sourceMemberId !== executorMemberId)
      throw new WorkflowAuthorizationError(
        "executor_artifact_publisher_denied",
      );
    assertRoomArtifactOperationAuthorized(snapshot, effectiveRoomId, {
      kind: "output.publish",
      location: {
        roomId: plan.roomId,
        channelId: plan.channelId,
        sourceMemberId: plan.sourceMemberId,
        recipientMemberIds: plan.targetMemberIds,
      },
    });
  }
}

export type RoomArtifactOperation =
  | {
      kind: "input.read" | "input.copy" | "input.recover";
      readerMemberId: string;
      location: RoomArtifactLocation;
    }
  | {
      kind: "output.publish" | "output.copy" | "output.recover";
      location: RoomArtifactLocation;
    };

/** Current room grants are checked for each protected read, copy and publication. */
export function assertRoomArtifactOperationAuthorized(
  snapshot: Snapshot,
  effectiveRoomId: string,
  operation: RoomArtifactOperation,
) {
  const { location } = operation;
  if (
    !location.roomId ||
    location.roomId !== effectiveRoomId ||
    !location.channelId ||
    !location.sourceMemberId ||
    !Array.isArray(location.recipientMemberIds) ||
    location.recipientMemberIds.some((id) => typeof id !== "string" || !id)
  )
    throw new WorkflowAuthorizationError("executor_artifact_location_invalid");
  const channel = (Array.isArray(snapshot.channels) ? snapshot.channels : [])
    .map(record)
    .find((candidate) => candidate?.channel_id === location.channelId);
  if (channel?.kind !== "object" || channel.state !== "active" ||
      channel.rotation_required === true)
    throw new WorkflowAuthorizationError("executor_artifact_channel_unavailable");
  if (
    !roomMemberCan(
      snapshot,
      effectiveRoomId,
      location.channelId,
      location.sourceMemberId,
      "publish",
    )
  )
    throw new WorkflowAuthorizationError("executor_artifact_publish_denied");
  for (const recipient of location.recipientMemberIds)
    if (
      !roomMemberCan(
        snapshot,
        effectiveRoomId,
        location.channelId,
        recipient,
        "subscribe",
      )
    )
      throw new WorkflowAuthorizationError(
        "executor_artifact_destination_denied",
      );
  if (
    operation.kind === "input.read" ||
    operation.kind === "input.copy" ||
    operation.kind === "input.recover"
  ) {
    if (!location.recipientMemberIds.includes(operation.readerMemberId))
      throw new WorkflowAuthorizationError("executor_artifact_reader_denied");
    if (
      !roomMemberCan(
        snapshot,
        effectiveRoomId,
        location.channelId,
        operation.readerMemberId,
        "subscribe",
      )
    )
      throw new WorkflowAuthorizationError("executor_artifact_read_denied");
  }
}
