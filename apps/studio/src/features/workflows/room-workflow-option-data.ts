import { apiFetch } from "@/lib/api-client";

export type RoomWorkflowRoomOption = {
  id: string;
  name: string;
  state: string;
};
export type RoomWorkflowChannelOption = {
  id: string;
  name: string;
  description: string | null;
};
export type RoomWorkflowSourceOption = {
  id: string;
  agentId: string | null;
  kind: "agent" | "object_storage";
  name: string;
  platform: string | null;
  channelIds: string[];
  credentialId: string | null;
  providerProfileId: string | null;
  bucket: string | null;
};
export type RoomWorkflowRoleOption = { id: string; name: string };
export type RoomWorkflowRecipientOption = {
  memberId: string;
  agentId: string | null;
  kind: "agent" | "object_storage" | "unknown";
  name: string;
  presence: string;
  roleIds: string[];
  roleNames: string[];
  eligible: boolean;
  unavailableReason: string | null;
};
export type RoomWorkflowContext = {
  room: RoomWorkflowRoomOption;
  channels: RoomWorkflowChannelOption[];
  sources: RoomWorkflowSourceOption[];
  roles: RoomWorkflowRoleOption[];
  templateKey: string;
};
export type RecipientFilters = {
  query: string;
  roleId: string;
  presence: string;
  selectedOnly: boolean;
};

function templateHeaders(templateKey: string) {
  return { "x-beam-environment-template": templateKey };
}

export function fetchRoomWorkflowRooms(
  templateKey: string,
  query: string,
  cursor = "",
) {
  const params = new URLSearchParams({ query, limit: "50" });
  if (cursor) params.set("cursor", cursor);
  return apiFetch<{
    items: RoomWorkflowRoomOption[];
    total: number;
    nextCursor: string | null;
  }>(`/studio/room-workflow-options/rooms?${params}`, {
    cache: "no-store",
    headers: templateHeaders(templateKey),
  });
}

export function fetchRoomWorkflowContext(templateKey: string, roomId: string) {
  return apiFetch<RoomWorkflowContext>(
    `/studio/room-workflow-options/rooms/${encodeURIComponent(roomId)}/context`,
    { cache: "no-store", headers: templateHeaders(templateKey) },
  );
}

export function fetchRoomWorkflowRecipients(input: {
  templateKey: string;
  roomId: string;
  channelId: string;
  sourceMemberId: string;
  selectedMemberIds: string[];
  filters: RecipientFilters;
  cursor?: string;
}) {
  return apiFetch<{
    items: RoomWorkflowRecipientOption[];
    total: number;
    nextCursor: string | null;
    selectedCount: number;
    ineligibleSelectedCount: number;
  }>(
    `/studio/room-workflow-options/rooms/${encodeURIComponent(input.roomId)}/recipients/search`,
    {
      method: "POST",
      headers: templateHeaders(input.templateKey),
      body: JSON.stringify({
        channelId: input.channelId,
        sourceMemberId: input.sourceMemberId,
        selectedMemberIds: input.selectedMemberIds,
        ...input.filters,
        cursor: input.cursor,
        limit: 100,
      }),
    },
  );
}

export function resolveRoomWorkflowRecipients(input: {
  templateKey: string;
  roomId: string;
  channelId: string;
  sourceMemberId: string;
  filters: Omit<RecipientFilters, "selectedOnly">;
}) {
  return apiFetch<{ memberIds: string[] }>(
    `/studio/room-workflow-options/rooms/${encodeURIComponent(input.roomId)}/recipients/resolve`,
    {
      method: "POST",
      headers: templateHeaders(input.templateKey),
      body: JSON.stringify({
        channelId: input.channelId,
        sourceMemberId: input.sourceMemberId,
        ...input.filters,
      }),
    },
  );
}

export function fetchRecentRoomSourcePaths(
  templateKey: string,
  sourceMemberId: string,
) {
  const params = new URLSearchParams({ sourceMemberId, limit: "8" });
  return apiFetch<{ paths: string[] }>(
    `/studio/room-workflow-options/recent-paths?${params}`,
    { cache: "no-store", headers: templateHeaders(templateKey) },
  );
}
