import { roomScopeKey } from "@/lib/beam-environments";
import { apiGet } from "@/lib/api-client";
import { record, records, text } from "./room-data";

export type RoomTransferDelivery = {
  agentId: string | null;
  completedChunks: number | null;
  coverageBase64: string | null;
  memberId: string;
  state: string;
  unavailableReason: string | null;
  updatedAt: string | null;
};

export type RoomTransfer = {
  sourceMemberId?: string | null;
  workflowRunId?: string | null;
  channelId: string;
  chunkCount: number;
  createdAt: string | null;
  deliveries: RoomTransferDelivery[];
  expiresAt: string | null;
  filename: string;
  id: string;
  role: "publisher" | "recipient";
  sizeBytes: number;
  state: string;
  updatedAt: string | null;
};

export const roomTransfersQueryKey = (
  roomId: string,
  channelId: string | null = null,
) => ["room-transfers", roomScopeKey(), roomId, channelId ?? "all"] as const;

export async function fetchRoomTransfers(
  roomId: string,
  channelId: string | null = null,
) {
  const response = await apiGet<{ transfers?: Record<string, unknown>[] }>(
    channelId
      ? `/studio/rooms/${encodeURIComponent(roomId)}/channels/${encodeURIComponent(channelId)}/transfers`
      : `/studio/rooms/${encodeURIComponent(roomId)}/transfers`,
  );
  return records(response.transfers)
    .map((value) => normalizePersistedRoomTransfer(value, channelId))
    .filter((value): value is RoomTransfer => value !== null)
    .sort((left, right) =>
      (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
    );
}

function normalizePersistedRoomTransfer(
  value: Record<string, unknown>,
  requestedChannelId: string | null,
): RoomTransfer | null {
  const id = text(value.transfer_id) ?? text(value.publication_id);
  if (!id) return null;
  const file = record(value.file);
  return {
    channelId: text(value.channel_id) ?? requestedChannelId ?? "",
    chunkCount: numeric(file.chunk_count),
    createdAt: text(value.created_at),
    deliveries: records(value.targets).map(normalizePersistentTarget),
    expiresAt: text(value.expires_at),
    filename: text(value.filename) ?? id,
    sourceMemberId: text(value.source_member_id),
    workflowRunId: text(value.workflowRunId),
    id,
    role: "publisher",
    sizeBytes: numeric(file.size_bytes),
    state: text(value.status) ?? "unknown",
    updatedAt: text(value.updated_at),
  };
}

function normalizePersistentTarget(
  value: Record<string, unknown>,
): RoomTransferDelivery {
  const status = text(value.status) ?? text(value.state) ?? "unknown";
  return {
    agentId: text(value.agent_id),
    completedChunks: optionalNumeric(value.completed_chunks),
    coverageBase64: text(value.coverage_base64),
    memberId: text(value.member_id) ?? "",
    state: status === "completed" ? "delivered" : status,
    unavailableReason: text(value.unavailable_reason),
    updatedAt: text(value.updated_at),
  };
}

function numeric(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumeric(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
