import type { CoordinatorRoomClient } from "./coordinator-client.js";
import {
  resolveRoomConsumer,
  type RoomConsumerUnavailableReason,
} from "./room-consumer.js";

type JsonObject = Record<string, unknown>;

type ConsumerCandidate = {
  id: string;
  status: string;
  capabilities: readonly string[];
};

export type RoomCreateCoordinator = Pick<
  CoordinatorRoomClient,
  "listRooms" | "mutateOrganizationRoom"
>;

export type RoomCreateOutcome<T extends ConsumerCandidate> =
  | { created: false; reason: RoomConsumerUnavailableReason }
  | {
      created: true;
      result: JsonObject;
      consumer: T;
      membership: JsonObject | null;
      consumerAttachmentError: string | null;
    };

export function roomConsumerUnavailableCode(
  reason: RoomConsumerUnavailableReason,
) {
  return reason === "offline"
    ? "room_consumer_offline"
    : "room_consumer_unavailable";
}

export function roomConsumerUnavailableMessage(
  reason: RoomConsumerUnavailableReason,
) {
  switch (reason) {
    case "not_enrolled":
      return "No Studio room consumer is enrolled for this organization. The room was not created and no credit was charged. Enroll a room consumer, then try again.";
    case "not_authorized":
      return "The Studio room consumer enrolled for this organization could not be authorized by the coordinator. The room was not created and no credit was charged. Check that the consumer belongs to this organization and is connected, then try again.";
    case "offline":
      return "The Studio room consumer enrolled for this organization is offline. The room was not created and no credit was charged. Start the room consumer, then try again once it is online.";
  }
}

/**
 * Creates an organization room only when an online Studio room consumer can
 * join it.
 *
 * The coordinator commits the room credit as soon as the room exists, and a
 * room without the consumer has no Studio member to run MLS, media, or object
 * observation. The consumer is therefore resolved first, and nothing billable
 * is requested when none is available. `attachConsumer` attaches the consumer
 * and waits until it has loaded the new room.
 */
export async function createRoomWithConsumer<T extends ConsumerCandidate>(
  input: {
    organizationId: string;
    agents: T[];
    coordinator: RoomCreateCoordinator;
    token: string;
    payload: JsonObject;
    idempotencyKey: string;
    apiKey: string;
    attachConsumer: (consumer: T, roomId: string) => Promise<JsonObject>;
  },
  onAttachmentFailure?: (consumer: T, roomId: string, error: unknown) => void,
): Promise<RoomCreateOutcome<T>> {
  const { organizationId, coordinator, token } = input;
  const selection = await resolveRoomConsumer(input.agents, (agentId) =>
    coordinator.listRooms(organizationId, agentId, token),
  );
  if (selection.reason) {
    return { created: false, reason: selection.reason };
  }
  const consumer = selection.consumer;

  const result = await coordinator.mutateOrganizationRoom(
    organizationId,
    "room.create",
    input.payload,
    input.idempotencyKey,
    token,
    input.apiKey,
  );
  const roomId = createdRoomId(result);
  let membership: JsonObject | null = null;
  let consumerAttachmentError: string | null = null;
  if (roomId) {
    try {
      membership = await input.attachConsumer(consumer, roomId);
    } catch (error) {
      // The room already exists and is paid for; the consumer can still join
      // and load it later through reconciliation, so report rather than fail.
      consumerAttachmentError =
        error instanceof Error ? error.message : "Consumer attachment failed.";
      onAttachmentFailure?.(consumer, roomId, error);
    }
  }
  return {
    created: true,
    result,
    consumer,
    membership,
    consumerAttachmentError,
  };
}

function createdRoomId(result: JsonObject): string | null {
  const created = asObject(result.room);
  return (
    optionalText(asObject(created.room).room_id) ??
    optionalText(created.room_id)
  );
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
