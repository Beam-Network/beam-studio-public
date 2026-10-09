import { useEffect, useRef, useState } from "react";
import { LoaderCircle, RadioTower, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiSend, apiWebSocketUrlForPath } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type { RoomChannel, RoomSnapshot } from "./room-data";

const mediaSessionsContentType = "application/vnd.beam.media-sessions+json";
const maxMediaTiles = 12;
const playableMediaStates = new Set(["ready", "running", "draining"]);

type MediaPlayerState =
  | "connecting"
  | "waiting"
  | "signaling"
  | "live"
  | "reconnecting"
  | "offline";

type MediaSession = {
  workloadId: string;
  status: string;
  updatedAt: string;
};

export function RoomMediaPlayer({
  channel,
  room,
}: {
  channel: RoomChannel;
  room: RoomSnapshot;
}) {
  const discovery = useMediaSessions(room, channel);
  const activeSessions = discovery.sessions;
  const visibleSessions = activeSessions.slice(0, maxMediaTiles);
  const hiddenSessions = Math.max(0, activeSessions.length - maxMediaTiles);

  return (
    <div className="grid content-start gap-4 p-4 sm:p-6 xl:min-h-0 xl:flex-1 xl:overflow-y-auto">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 text-sm">
          <RadioTower
            className={cn(
              "size-4 text-muted-foreground",
              discovery.state === "live" && "text-success",
            )}
          />
          <span className="font-medium">Live publishers</span>
          {discovery.snapshotReceived ? (
            <Badge variant="secondary">{discovery.sessions.length}</Badge>
          ) : (
            <Badge variant="outline">discovering</Badge>
          )}
        </div>
        <span className="ml-auto text-xs text-muted-foreground">
          {discoveryLabel(discovery)}
        </span>
      </div>

      {visibleSessions.length ? (
        <div
          className={cn(
            "grid gap-4",
            visibleSessions.length > 1 && "md:grid-cols-2 2xl:grid-cols-3",
          )}
        >
          {visibleSessions.map((session, index) => (
            <MediaTile
              channel={channel}
              key={session.workloadId}
              label={`Publisher ${index + 1}`}
              room={room}
              session={session}
              workloadId={session.workloadId}
            />
          ))}
        </div>
      ) : (
        <div className="grid min-h-80 place-items-center rounded-surface border border-dashed bg-muted/10 p-8 text-center">
          <div className="grid max-w-md justify-items-center gap-3">
            <RadioTower className="size-8 text-muted-foreground" />
            <div>
              <p className="font-medium">No live publisher</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Start publishing from any authorized room member. Its video will
                appear here automatically.
              </p>
            </div>
          </div>
        </div>
      )}

      {hiddenSessions ? (
        <p className="text-center text-xs text-muted-foreground">
          {hiddenSessions} additional live stream
          {hiddenSessions === 1 ? " is" : "s are"} hidden to keep browser
          resource usage bounded.
        </p>
      ) : null}
    </div>
  );
}

function MediaTile({
  channel,
  label,
  room,
  session,
  workloadId,
}: {
  channel: RoomChannel;
  label: string;
  room: RoomSnapshot;
  session: MediaSession;
  workloadId: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<MediaPlayerState>("connecting");
  const [detail, setDetail] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const agentId = room.consumer?.id;
    if (!agentId) {
      setState("offline");
      setDetail("The Studio room consumer is unavailable.");
      return;
    }
    const consumerAgentId = agentId;
    let disposed = false;
    let socket: WebSocket | null = null;
    let peer: RTCPeerConnection | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let started = false;

    const closePeer = (notifyWorker: boolean) => {
      if (disconnectTimer) clearTimeout(disconnectTimer);
      disconnectTimer = null;
      if (notifyWorker && socket?.readyState === WebSocket.OPEN && started) {
        socket.send(JSON.stringify({ type: "media.close" }));
      }
      peer?.close();
      peer = null;
      started = false;
      if (videoRef.current) videoRef.current.srcObject = null;
    };

    const closeTransport = (notifyWorker: boolean) => {
      const closingSocket = socket;
      closePeer(notifyWorker);
      socket = null;
      if (!closingSocket) return;
      if (closingSocket.readyState === WebSocket.CONNECTING) {
        closingSocket.addEventListener(
          "open",
          () => closingSocket.close(1000, "media session replaced"),
          { once: true },
        );
      } else if (closingSocket.readyState === WebSocket.OPEN) {
        closingSocket.close(1000, "media session replaced");
      }
    };

    const scheduleReconnect = (reason?: string) => {
      if (disposed || reconnectTimer) return;
      closeTransport(true);
      const delay = Math.min(
        1_000 * 2 ** Math.min(reconnectAttempt, 4),
        15_000,
      );
      reconnectAttempt += 1;
      setState(reconnectAttempt === 1 ? "waiting" : "reconnecting");
      setDetail(reason ?? null);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
    };

    const startViewer = async (currentSocket: WebSocket) => {
      if (disposed || started || socket !== currentSocket) return;
      started = true;
      const currentPeer = new RTCPeerConnection();
      peer = currentPeer;
      currentPeer.addTransceiver("video", { direction: "recvonly" });
      currentPeer.addTransceiver("audio", { direction: "recvonly" });
      currentPeer.addEventListener("track", (event) => {
        if (peer !== currentPeer) return;
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => undefined);
        }
      });
      currentPeer.addEventListener("connectionstatechange", () => {
        if (disposed || peer !== currentPeer) return;
        if (currentPeer.connectionState === "connected") {
          if (disconnectTimer) clearTimeout(disconnectTimer);
          disconnectTimer = null;
          reconnectAttempt = 0;
          setState("live");
          setDetail(null);
        } else if (currentPeer.connectionState === "failed") {
          scheduleReconnect("The media path was interrupted.");
        } else if (
          currentPeer.connectionState === "disconnected" &&
          !disconnectTimer
        ) {
          disconnectTimer = setTimeout(() => {
            disconnectTimer = null;
            if (
              !disposed &&
              peer === currentPeer &&
              currentPeer.connectionState === "disconnected"
            ) {
              scheduleReconnect("The media path was interrupted.");
            }
          }, 8_000);
        }
      });
      const offer = await currentPeer.createOffer();
      await currentPeer.setLocalDescription(offer);
      await iceGatheringComplete(currentPeer);
      if (
        disposed ||
        peer !== currentPeer ||
        socket !== currentSocket ||
        currentSocket.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      currentSocket.send(
        JSON.stringify({
          type: "media.offer",
          workloadId,
          sdp: currentPeer.localDescription?.sdp,
        }),
      );
    };

    async function connect() {
      if (disposed) return;
      setState(reconnectAttempt ? "reconnecting" : "connecting");
      if (!reconnectAttempt) setDetail(null);
      try {
        const mediaSession = await apiSend<{ websocketPath: string }>(
          "POST",
          `/studio/agents/${encodeURIComponent(consumerAgentId)}/rooms/${encodeURIComponent(room.id)}/channels/${encodeURIComponent(channel.id)}/media-session`,
        );
        if (disposed) return;
        const currentSocket = new WebSocket(
          apiWebSocketUrlForPath(mediaSession.websocketPath),
        );
        socket = currentSocket;
        currentSocket.addEventListener("message", (event) => {
          if (
            disposed ||
            socket !== currentSocket ||
            typeof event.data !== "string"
          ) {
            return;
          }
          const envelope = parseEnvelope(event.data);
          if (!envelope) return;
          if (
            envelope.type === "channel.status" &&
            envelope.payload.state === "live"
          ) {
            setState("signaling");
            setDetail(null);
            void startViewer(currentSocket).catch((cause) =>
              scheduleReconnect(errorMessage(cause)),
            );
          } else if (envelope.type === "media.answer" && peer) {
            const currentPeer = peer;
            const sdp = textValue(envelope.payload.sdp) ?? "";
            if (!sdp) {
              scheduleReconnect("The Worker returned an empty media answer.");
              return;
            }
            void currentPeer
              .setRemoteDescription({ type: "answer", sdp })
              .catch((cause) => scheduleReconnect(errorMessage(cause)));
          } else if (envelope.type === "channel.error") {
            scheduleReconnect(
              textValue(envelope.payload.message) ??
                "No live media publisher is available yet.",
            );
          }
        });
        currentSocket.addEventListener("close", (event) => {
          if (disposed || socket !== currentSocket) return;
          socket = null;
          closePeer(false);
          scheduleReconnect(
            event.reason || "The Studio room consumer connection closed.",
          );
        });
        currentSocket.addEventListener("error", () => {
          if (disposed || socket !== currentSocket) return;
          setDetail("Unable to reach the Studio room consumer.");
        });
      } catch (cause) {
        scheduleReconnect(errorMessage(cause));
      }
    }

    void connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      closeTransport(true);
    };
  }, [channel.id, retryKey, room.consumer?.id, room.id, workloadId]);

  const waiting = state !== "live" && state !== "offline";
  return (
    <article className="overflow-hidden rounded-surface border bg-card shadow-sm">
      <div className="relative overflow-hidden bg-black">
        <video
          autoPlay
          className="aspect-video w-full object-contain"
          controls
          muted
          playsInline
          ref={videoRef}
        />
        {state !== "live" ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/65 text-white">
            <div className="grid justify-items-center gap-2 px-5 text-center">
              {waiting ? (
                <LoaderCircle className="size-6 animate-spin" />
              ) : (
                <RadioTower className="size-6" />
              )}
              <p className="text-sm font-medium">
                {state === "offline"
                  ? "Consumer unavailable"
                  : "Connecting stream…"}
              </p>
            </div>
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-3 p-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{label}</span>
            <Badge
              className="shrink-0 text-[10px]"
              variant={state === "live" ? "secondary" : "outline"}
            >
              {state === "live" ? "live" : session.status}
            </Badge>
          </div>
          <p
            className="mt-1 truncate font-mono text-[10px] text-muted-foreground"
            title={workloadId}
          >
            {workloadId}
          </p>
          {detail && state !== "live" ? (
            <p className="mt-1 line-clamp-2 text-[10px] text-muted-foreground">
              {detail}
            </p>
          ) : null}
        </div>
        {state !== "live" && room.consumer?.id ? (
          <Button
            aria-label={`Retry ${label}`}
            onClick={() => setRetryKey((value) => value + 1)}
            size="icon"
            type="button"
            variant="outline"
          >
            <RefreshCw className="size-4" />
          </Button>
        ) : null}
      </div>
    </article>
  );
}

function useMediaSessions(room: RoomSnapshot, channel: RoomChannel) {
  const [state, setState] = useState<MediaPlayerState>("connecting");
  const [sessions, setSessions] = useState<MediaSession[]>([]);
  const [snapshotReceived, setSnapshotReceived] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSessions([]);
    setSnapshotReceived(false);
    setError(null);
    const agentId = room.consumer?.id;
    if (!agentId) {
      setState("offline");
      setError("Studio room consumer unavailable");
      return;
    }
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;

    const connect = () => {
      if (disposed) return;
      setState(reconnectAttempt ? "reconnecting" : "connecting");
      const path = `/studio/agents/${encodeURIComponent(agentId)}/rooms/${encodeURIComponent(room.id)}/channels/${encodeURIComponent(channel.id)}/connect`;
      const currentSocket = new WebSocket(apiWebSocketUrlForPath(path));
      socket = currentSocket;
      currentSocket.addEventListener("message", (event) => {
        if (
          disposed ||
          socket !== currentSocket ||
          typeof event.data !== "string"
        ) {
          return;
        }
        const envelope = parseEnvelope(event.data);
        if (!envelope) return;
        if (envelope.type === "channel.status") {
          if (envelope.payload.state === "live") {
            reconnectAttempt = 0;
            setState("live");
            setError(null);
          }
          return;
        }
        if (
          envelope.type === "channel.delivery" &&
          textValue(envelope.payload.contentType)?.startsWith(
            mediaSessionsContentType,
          )
        ) {
          const next = decodeMediaSessions(envelope.payload.payloadBase64);
          if (next) {
            setSessions(next);
            setSnapshotReceived(true);
          }
          return;
        }
        if (envelope.type === "channel.error") {
          setState("offline");
          setError(
            textValue(envelope.payload.message) ??
              "Media session discovery failed.",
          );
        }
      });
      currentSocket.addEventListener("close", (event) => {
        if (disposed || socket !== currentSocket) return;
        socket = null;
        setState("reconnecting");
        if (event.reason) setError(event.reason);
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(
          connect,
          Math.min(1_000 * 2 ** Math.min(reconnectAttempt, 4), 15_000),
        );
      });
      currentSocket.addEventListener("error", () => {
        if (!disposed) setError("Unable to discover live media sessions.");
      });
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const currentSocket = socket;
      socket = null;
      if (!currentSocket) return;
      if (currentSocket.readyState === WebSocket.CONNECTING) {
        currentSocket.addEventListener(
          "open",
          () => currentSocket.close(1000, "media discovery closed"),
          { once: true },
        );
      } else if (currentSocket.readyState === WebSocket.OPEN) {
        currentSocket.close(1000, "media discovery closed");
      }
    };
  }, [channel.id, room.consumer?.id, room.id]);

  return { error, sessions, snapshotReceived, state };
}

function decodeMediaSessions(value: unknown): MediaSession[] | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const bytes = Uint8Array.from(atob(value), (character) =>
      character.charCodeAt(0),
    );
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as {
      sessions?: unknown;
    };
    if (!Array.isArray(payload.sessions)) return null;
    const sessions = new Map<string, MediaSession>();
    for (const value of payload.sessions.slice(0, 64)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const workloadId = textValue(record.workloadId);
      const status = textValue(record.status) ?? "";
      if (!workloadId || !playableMediaStates.has(status)) continue;
      sessions.set(workloadId, {
        workloadId,
        status,
        updatedAt: textValue(record.updatedAt) ?? "",
      });
    }
    return [...sessions.values()].sort((left, right) =>
      left.workloadId.localeCompare(right.workloadId),
    );
  } catch {
    return null;
  }
}

function discoveryLabel(discovery: {
  error: string | null;
  snapshotReceived: boolean;
  state: MediaPlayerState;
}) {
  if (discovery.state === "live") {
    return discovery.snapshotReceived
      ? "Updating automatically"
      : "Waiting for the media workload inventory";
  }
  if (isMissingMediaCapability(discovery.error)) {
    return "Waiting for a live publisher";
  }
  return discovery.error ?? "Connecting to the Studio consumer…";
}

function isMissingMediaCapability(value: string | null) {
  return value?.toLowerCase().includes("required channel kind") === true;
}

function iceGatheringComplete(peer: RTCPeerConnection) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const listener = () => {
      if (peer.iceGatheringState !== "complete") return;
      peer.removeEventListener("icegatheringstatechange", listener);
      resolve();
    };
    peer.addEventListener("icegatheringstatechange", listener);
  });
}

function parseEnvelope(value: string) {
  try {
    const envelope = JSON.parse(value) as { type?: unknown; payload?: unknown };
    if (
      typeof envelope.type !== "string" ||
      !envelope.payload ||
      typeof envelope.payload !== "object"
    ) {
      return null;
    }
    return envelope as { type: string; payload: Record<string, unknown> };
  } catch {
    return null;
  }
}

function textValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : "Media signaling failed.";
}
