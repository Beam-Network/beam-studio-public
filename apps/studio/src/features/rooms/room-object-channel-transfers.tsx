import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FolderOutput, LoaderCircle } from "lucide-react";
import {
  EmptyState,
  FilterBar,
  FilterSelect,
  ResultCounter,
  SearchInput,
} from "@/components/data-page";
import { Button } from "@/components/ui/button";
import { apiWebSocketUrlForPath } from "@/lib/api-client";
import { formatBytes } from "@/lib/format-bytes";
import type { RoomChannel, RoomSnapshot } from "./room-data";
import { RoomTransferItem } from "./room-transfer-components";
import {
  fetchRoomTransfers,
  roomTransfersQueryKey,
} from "./room-transfer-data";

const statusOptions: Array<[string, string]> = [
  ["all", "All statuses"],
  ["pending", "Pending"],
  ["in_progress", "In progress"],
  ["completed", "Completed"],
  ["partial", "Partial"],
  ["failed", "Failed"],
  ["cancelled", "Cancelled"],
];

export function RoomObjectChannelTransfers({
  channel,
  room,
}: {
  channel: RoomChannel;
  room: RoomSnapshot;
}) {
  const inbox = useObjectInbox(room, channel);
  const transfersQuery = useQuery({
    queryKey: roomTransfersQueryKey(room.id, channel.id),
    queryFn: () => fetchRoomTransfers(room.id, channel.id),
    refetchInterval: 5_000,
  });
  const transfers = transfersQuery.data ?? [];
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const filteredTransfers = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return transfers.filter((transfer) => {
      const matchesStatus =
        statusFilter === "all" || transfer.state === statusFilter;
      const haystack = [
        transfer.id,
        transfer.filename,
        transfer.channelId,
        transfer.state,
        transfer.role,
        ...transfer.deliveries.flatMap((delivery) => [
          delivery.memberId,
          delivery.state,
          delivery.unavailableReason ?? "",
        ]),
      ]
        .join(" ")
        .toLowerCase();
      return matchesStatus && haystack.includes(needle);
    });
  }, [search, statusFilter, transfers]);

  return (
    <div className="grid auto-rows-max content-start gap-4 p-4 sm:p-6 xl:min-h-0 xl:flex-1 xl:overflow-y-auto">
      <section className="grid gap-3 rounded-surface border bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Consumer inbox</h3>
            <p className="text-xs text-muted-foreground">
              Completed objects decrypted by the Studio room consumer. Workers
              carry end-to-end encrypted chunks only.
            </p>
          </div>
          <span className="text-xs text-muted-foreground">{inbox.state}</span>
        </div>
        {inbox.error ? (
          <p className="text-sm text-destructive">{inbox.error}</p>
        ) : null}
        {inbox.objects.length ? (
          <div className="grid gap-2">
            {inbox.objects.map((object) => (
              <div
                className="flex items-center justify-between gap-3 rounded-control border px-3 py-2"
                key={object.transferId}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {object.filename}
                  </p>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {formatBytes(object.sizeBytes) ?? "—"} · {object.transferId}
                  </p>
                </div>
                <Button
                  disabled={
                    inbox.downloading === object.transferId ||
                    inbox.state !== "live"
                  }
                  onClick={() => inbox.download(object)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {inbox.downloading === object.transferId ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <Download className="size-4" />
                  )}
                  Download
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No completed object has reached this consumer yet.
          </p>
        )}
      </section>
      <FilterBar>
        <SearchInput
          placeholder="Search transfers..."
          value={search}
          onChange={setSearch}
        />
        <FilterSelect
          label="Status"
          options={statusOptions}
          value={statusFilter}
          onChange={setStatusFilter}
        />
        <ResultCounter
          totalCount={transfers.length}
          visibleCount={filteredTransfers.length}
        />
      </FilterBar>

      {transfersQuery.error ? (
        <p className="rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {errorMessage(transfersQuery.error)}
        </p>
      ) : filteredTransfers.length ? (
        <div className="grid gap-2">
          {filteredTransfers.map((transfer, index) => (
            <RoomTransferItem
              channelName={channel.name}
              defaultOpen={index === 0}
              key={transfer.id}
              room={room}
              transfer={transfer}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          description={
            transfersQuery.isPending
              ? "Loading transfers from the coordinator."
              : search || statusFilter !== "all"
                ? "Try a different search or status filter."
                : "Transfers published in this object channel will appear here."
          }
          icon={FolderOutput}
          title={
            transfersQuery.isPending
              ? "Loading transfers"
              : "No transfers found"
          }
        />
      )}
    </div>
  );
}

type InboxObject = { transferId: string; filename: string; sizeBytes: number };

function useObjectInbox(room: RoomSnapshot, channel: RoomChannel) {
  const socketRef = useRef<WebSocket | null>(null);
  const downloads = useRef(
    new Map<
      string,
      { object: InboxObject; chunks: Uint8Array[]; offset: number }
    >(),
  );
  const [objects, setObjects] = useState<InboxObject[]>([]);
  const [state, setState] = useState("connecting");
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  useEffect(() => {
    const agentId = room.consumer?.id;
    if (!agentId) {
      setState("offline");
      setError("Attach the Studio room consumer to inspect its inbox.");
      return;
    }
    const path = `/studio/agents/${encodeURIComponent(agentId)}/rooms/${encodeURIComponent(room.id)}/channels/${encodeURIComponent(channel.id)}/connect`;
    const socket = new WebSocket(apiWebSocketUrlForPath(path));
    socketRef.current = socket;
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const envelope = parseEnvelope(event.data);
      if (!envelope) return;
      if (envelope.type === "channel.status") {
        setState(
          typeof envelope.payload.state === "string"
            ? envelope.payload.state
            : "error",
        );
        return;
      }
      if (envelope.type === "channel.delivery") {
        const metadata = objectValue(envelope.payload.metadata);
        const transferId = stringValue(metadata.transfer_id);
        const filename = stringValue(metadata.filename);
        const sizeBytes = Number(metadata.size_bytes);
        if (!transferId || !filename || !Number.isFinite(sizeBytes)) return;
        setObjects((current) => [
          { transferId, filename, sizeBytes },
          ...current.filter((item) => item.transferId !== transferId),
        ]);
        return;
      }
      if (envelope.type === "object.chunk") {
        const requestId = stringValue(envelope.payload.requestId);
        const download = requestId ? downloads.current.get(requestId) : null;
        if (!requestId || !download) return;
        const offset = Number(envelope.payload.offset);
        if (offset !== download.offset) {
          downloads.current.delete(requestId);
          setDownloading(null);
          setError("The object download stream was incomplete.");
          return;
        }
        const encoded = stringValue(envelope.payload.payloadBase64);
        if (encoded) {
          const chunk = base64Bytes(encoded);
          download.chunks.push(chunk);
          download.offset += chunk.byteLength;
        }
        if (envelope.payload.eof === true) {
          downloads.current.delete(requestId);
          saveObject(download.object.filename, download.chunks);
          setDownloading(null);
        }
        return;
      }
      if (envelope.type === "channel.error") {
        setError(
          stringValue(envelope.payload.message) ??
            "Object inbox request failed.",
        );
        setDownloading(null);
      }
    });
    socket.addEventListener("close", () => setState("offline"));
    socket.addEventListener("error", () =>
      setError("Unable to reach the Studio room consumer."),
    );
    return () => {
      socketRef.current = null;
      socket.close(1000, "object inbox closed");
      downloads.current.clear();
    };
  }, [channel.id, room.consumer?.id, room.id]);

  const download = (object: InboxObject) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const requestId = crypto.randomUUID();
    downloads.current.set(requestId, { object, chunks: [], offset: 0 });
    setDownloading(object.transferId);
    setError(null);
    socket.send(
      JSON.stringify({
        type: "object.download",
        requestId,
        transferId: object.transferId,
      }),
    );
  };
  return { objects, state, error, downloading, download };
}

function parseEnvelope(value: string) {
  try {
    const envelope = JSON.parse(value) as { type?: unknown; payload?: unknown };
    if (
      typeof envelope.type !== "string" ||
      !envelope.payload ||
      typeof envelope.payload !== "object"
    )
      return null;
    return envelope as { type: string; payload: Record<string, unknown> };
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function base64Bytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function saveObject(filename: string, chunks: Uint8Array[]) {
  const url = URL.createObjectURL(new Blob(chunks as BlobPart[]));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
