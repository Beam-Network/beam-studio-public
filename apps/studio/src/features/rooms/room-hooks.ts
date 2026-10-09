import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchRoomsSnapshot,
  roomsQueryKey,
  runRoomCommand,
  type RoomSnapshot,
  type RoomChannel,
} from "./room-data";
import { apiWebSocketUrlForPath } from "@/lib/api-client";
import { useBeamEnvironmentSettings } from "@/features/settings/beam-environment-data";
import { selectedRoomTemplate } from "@/lib/beam-environments";

export type ChannelSessionState = "connecting" | "live" | "offline" | "error";

export type ChannelMessage = {
  id: string;
  clientMessageId?: string;
  publicationId?: string;
  author: string;
  publisherMemberId?: string;
  text: string;
  createdAt: string;
  local: boolean;
  status?: string;
  workloadKind?: string;
  contentType?: string;
  workloadId?: string;
  eof?: boolean;
};

export function useRoomsData() {
  const settingsQuery = useBeamEnvironmentSettings();
  const beamTemplate = selectedRoomTemplate(settingsQuery.data);
  const roomControlAvailable = beamTemplate?.roomControlAvailable === true;
  const query = useQuery({
    queryKey: roomsQueryKey,
    queryFn: () => {
      if (!beamTemplate || !roomControlAvailable) {
        throw new Error(
          "Room control is not configured for the selected Beam environment.",
        );
      }
      return fetchRoomsSnapshot({ templateKey: beamTemplate.key });
    },
    enabled: settingsQuery.isSuccess,
    refetchInterval: roomControlAvailable ? 2_500 : false,
    retry: roomControlAvailable,
  });
  const refreshMutation = useMutation({
    mutationFn: async () => {
      const result = await query.refetch();
      if (result.error) throw result.error;
    },
  });

  return {
    query,
    refreshMutation,
    beamTemplate,
    roomControlAvailable,
    settingsQuery,
  };
}

export function useRoomData(roomId: string) {
  const queryClient = useQueryClient();
  const { query } = useRoomsData();
  const room = query.data?.rooms.find((item) => item.id === roomId) ?? null;
  const refreshMutation = useMutation({
    mutationFn: async () => {
      const result = await query.refetch();
      if (result.error) throw result.error;
    },
  });
  const actionMutation = useMutation({
    mutationFn: async (input: {
      operation: string;
      payload?: Record<string, unknown>;
    }) => {
      if (!room) throw new Error("Room not found.");
      if (room.readOnly) {
        throw new Error(
          "This organization room is read-only until a managed agent or Studio joins it.",
        );
      }
      return runRoomCommand(room.agent?.id ?? null, input.operation, {
        room_id: room.id,
        ...(input.payload ?? {}),
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: roomsQueryKey }),
  });

  return { query, room, refreshMutation, actionMutation };
}

export function useChannelMessages(room: RoomSnapshot, channel: RoomChannel) {
  const socketRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<ChannelSessionState>("connecting");
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasGap, setHasGap] = useState(false);

  useEffect(() => {
    if (
      !["message", "datagram", "command", "request-reply", "stream"].includes(
        channel.kind,
      )
    ) {
      setState("offline");
      return;
    }
    const agentId = room.consumer?.id ?? room.agent?.id;
    if (!agentId) {
      setState("offline");
      setError(
        "An agent must join this room before opening a live channel session.",
      );
      return;
    }
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let hasBeenLive = false;

    const connect = () => {
      if (disposed) return;
      setState("connecting");
      const path = `/studio/agents/${encodeURIComponent(agentId)}/rooms/${encodeURIComponent(room.id)}/channels/${encodeURIComponent(channel.id)}/connect`;
      const socket = new WebSocket(apiWebSocketUrlForPath(path));
      socketRef.current = socket;
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        const envelope = browserChannelEnvelope(event.data);
        if (!envelope) return;
        if (envelope.type === "channel.status") {
          const next = channelState(envelope.payload.state);
          setState(next === "offline" && hasBeenLive ? "connecting" : next);
          if (next === "live") {
            hasBeenLive = true;
            reconnectAttempt = 0;
            setError(null);
          }
          return;
        }
        if (envelope.type === "channel.local_message") {
          const clientMessageId = valueText(envelope.payload.clientMessageId);
          const text = valueText(envelope.payload.text);
          if (!clientMessageId || !text) return;
          upsertChannelMessage(setMessages, {
            id: clientMessageId,
            clientMessageId,
            author: localChannelAuthor(room),
            text,
            createdAt:
              valueText(envelope.payload.sentAt) ?? new Date().toISOString(),
            local: true,
            status: "sending",
          });
          return;
        }
        if (envelope.type === "channel.delivery") {
          const publicationId =
            valueText(envelope.payload.publicationId) ??
            valueText(envelope.payload.workloadId) ??
            crypto.randomUUID();
          const publisherMemberId = valueText(
            envelope.payload.publisherMemberId,
          );
          const text =
            channel.kind === "message"
              ? decodeChannelPayload(envelope.payload.payloadBase64)
              : decodeObservationPayload(envelope.payload, channel.kind);
          if (text === null) return;
          upsertChannelMessage(setMessages, {
            id: publicationId,
            publicationId,
            publisherMemberId: publisherMemberId ?? undefined,
            author: publisherMemberId
              ? channelMemberName(room, publisherMemberId)
              : `${channel.kind} workload`,
            text,
            createdAt:
              valueText(envelope.payload.receivedAt) ??
              new Date().toISOString(),
            local: false,
            workloadKind: valueText(envelope.payload.kind) ?? channel.kind,
            contentType: valueText(envelope.payload.contentType) ?? undefined,
            workloadId: valueText(envelope.payload.workloadId) ?? undefined,
            eof: envelope.payload.eof === true,
          });
          return;
        }
        if (envelope.type === "channel.publication") {
          const clientMessageId = valueText(envelope.payload.clientMessageId);
          if (!clientMessageId) return;
          setMessages((current) =>
            current.map((message) =>
              message.clientMessageId === clientMessageId
                ? {
                    ...message,
                    publicationId:
                      valueText(envelope.payload.publicationId) ??
                      message.publicationId,
                    status: publicationStatus(envelope.payload),
                  }
                : message,
            ),
          );
          return;
        }
        if (envelope.type === "channel.error") {
          const message =
            valueText(envelope.payload.message) ??
            "Channel communication failed.";
          const clientMessageId = valueText(envelope.payload.clientMessageId);
          if (clientMessageId) {
            setMessages((current) =>
              current.map((item) =>
                item.clientMessageId === clientMessageId
                  ? { ...item, status: "failed" }
                  : item,
              ),
            );
          } else {
            setState("error");
            setError(message);
          }
        }
      });
      socket.addEventListener("close", (event) => {
        if (socketRef.current === socket) socketRef.current = null;
        if (disposed) return;
        if (hasBeenLive) setHasGap(true);
        setState(hasBeenLive ? "connecting" : "offline");
        if (event.reason) setError(event.reason);
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(
          connect,
          Math.min(1_000 * 2 ** Math.min(reconnectAttempt, 4), 15_000),
        );
      });
      socket.addEventListener("error", () => {
        if (!disposed)
          setError("Unable to reach the managed agent channel session.");
      });
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const socket = socketRef.current;
      socketRef.current = null;
      if (!socket) return;
      if (socket.readyState === WebSocket.CONNECTING) {
        socket.addEventListener(
          "open",
          () => socket.close(1000, "channel view closed"),
          { once: true },
        );
        return;
      }
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000, "channel view closed");
      }
    };
  }, [channel.id, channel.kind, room.agent?.id, room.consumer?.id, room.id]);

  const publish = useCallback((text: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("The channel is not connected.");
    }
    const clientMessageId = crypto.randomUUID();
    socket.send(
      JSON.stringify({ type: "channel.publish", clientMessageId, text }),
    );
    return clientMessageId;
  }, []);

  return { state, messages, error, hasGap, publish };
}

export function roomErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function roomUpdatedAt(room: RoomSnapshot) {
  if (!room.updatedAt) return "Never";
  const date = new Date(room.updatedAt);
  return Number.isNaN(date.getTime()) ? room.updatedAt : date.toLocaleString();
}

function browserChannelEnvelope(value: string) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const record = parsed as Record<string, unknown>;
    const payload = record.payload;
    if (
      typeof record.type !== "string" ||
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      return null;
    }
    return {
      type: record.type,
      payload: payload as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

function channelState(value: unknown): ChannelSessionState {
  return value === "live" || value === "offline" || value === "error"
    ? value
    : "connecting";
}

function decodeChannelPayload(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  try {
    const bytes = Uint8Array.from(atob(value), (character) =>
      character.charCodeAt(0),
    );
    const decoded = new TextDecoder().decode(bytes);
    const payload = JSON.parse(decoded) as Record<string, unknown>;
    if (payload.type === "message.created") return valueText(payload.text);
    return decoded;
  } catch {
    return null;
  }
}

function decodeObservationPayload(
  payload: Record<string, unknown>,
  kind: string,
) {
  if (payload.eof === true) return "Stream closed";
  const encoded = valueText(payload.payloadBase64);
  const metadata =
    payload.metadata &&
    typeof payload.metadata === "object" &&
    !Array.isArray(payload.metadata)
      ? (payload.metadata as Record<string, unknown>)
      : null;
  if (!encoded) {
    return metadata ? JSON.stringify(metadata, null, 2) : null;
  }
  try {
    const bytes = Uint8Array.from(atob(encoded), (character) =>
      character.charCodeAt(0),
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const contentType = valueText(payload.contentType) ?? "";
    let body = text;
    if (contentType.includes("json") || kind === "command") {
      try {
        body = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Keep valid UTF-8 as-is when the producer mislabeled the content.
      }
    }
    return metadata ? `${body}\n\n${JSON.stringify(metadata, null, 2)}` : body;
  } catch {
    return `[${kind} binary payload · ${Math.floor((encoded.length * 3) / 4)} bytes]`;
  }
}

function localChannelAuthor(room: RoomSnapshot) {
  return (
    valueText(room.membership.principal_id) ??
    valueText(room.membership.principal) ??
    room.agent?.machineName ??
    room.agent?.name ??
    room.agent?.id ??
    "Studio organization"
  );
}

function channelMemberName(room: RoomSnapshot, memberId: string) {
  const membership = room.memberships.find(
    (item) => valueText(item.member_id) === memberId,
  );
  return valueText(membership?.principal_id) ?? memberId;
}

function publicationStatus(payload: Record<string, unknown>) {
  const delivered = valueNumber(payload.deliveredDeliveries);
  const accepted = valueNumber(payload.acceptedDeliveries);
  const failed = valueNumber(payload.failedDeliveries);
  const expired = valueNumber(payload.expiredDeliveries);
  const skipped = valueNumber(payload.skippedOnlineOnly);
  if (delivered > 0) return failed > 0 || expired > 0 ? "partial" : "delivered";
  if (accepted > 0) return "accepted";
  if (skipped > 0) return "no recipients";
  if (failed > 0 || expired > 0) return "failed";
  return "published";
}

function upsertChannelMessage(
  setMessages: Dispatch<SetStateAction<ChannelMessage[]>>,
  message: ChannelMessage,
) {
  setMessages((current) => {
    const index = current.findIndex(
      (item) =>
        item.id === message.id ||
        (message.publicationId && item.publicationId === message.publicationId),
    );
    if (index >= 0) {
      return current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...message } : item,
      );
    }
    return [...current.slice(-499), message];
  });
}

function valueText(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function valueNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
