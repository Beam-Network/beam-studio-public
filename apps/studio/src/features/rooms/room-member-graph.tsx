import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Minus, Pause, Play, Plus, RotateCcw } from "lucide-react";
import "./room-member-graph.css";
import { Button } from "@/components/ui/button";
import {
  fetchRoomStorageBindings,
  roomStorageBindingsQueryKey,
  type RoomAgent,
  type RoomSnapshot,
} from "./room-data";
import {
  accessLabel,
  buildRoomGraph,
  roomGraphKey,
  type GraphInput,
} from "./room-member-graph-model";
import { mountRoomGraph } from "./room-member-graph-canvas";

export function RoomMemberGraph({
  room,
  agents,
}: {
  room: RoomSnapshot;
  agents: RoomAgent[];
}) {
  const storage = useQuery({
    queryKey: roomStorageBindingsQueryKey(room.id),
    queryFn: () => fetchRoomStorageBindings(room.id),
  });
  const key = roomGraphKey(room, storage.data?.bindings ?? [], agents);
  const graph = useMemo(
    () => buildRoomGraph(JSON.parse(key) as GraphInput),
    [key],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const dense = graph.links.length > 500;
  const selected =
    graph.nodes.find((node) => node.id === selectedId) ??
    (dense ? graph.nodes[0] : undefined);
  const detail = graph.nodes.find((node) => node.id === hoveredId) ?? selected;
  const presenceKey = JSON.stringify(
    room.memberships.map((m) => [m.member_id, m.presence]),
  );
  const presence = useMemo(
    () => Object.fromEntries(JSON.parse(presenceKey)) as Record<string, string>,
    [presenceKey],
  );
  const canvas = useRef<HTMLCanvasElement>(null);
  const controller = useRef<ReturnType<typeof mountRoomGraph>>(null);
  const id = useId();
  useEffect(() => {
    controller.current = mountRoomGraph(
      canvas.current!,
      setSelectedId,
      setHoveredId,
    );
    return () => {
      controller.current?.dispose();
      controller.current = null;
    };
  }, []);
  useEffect(() => {
    controller.current?.update(graph, presence, selected?.id ?? null, paused);
  }, [graph, presence, selected?.id, paused]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const detailIndex = detail ? graph.nodes.indexOf(detail) : -1;
  const connections = detail
    ? graph.links.filter(
        (link) => link.source === detailIndex || link.target === detailIndex,
      )
    : [];
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="room-graph min-w-0 border bg-card"
    >
      <header className="border-b px-4 py-3 sm:px-5">
        <h2 id={`${id}-title`} className="text-sm font-semibold">
          Room connections
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {graph.nodes.length} members · {graph.links.length} permitted
          connections
        </p>
      </header>
      <div className="room-graph-layout p-4 sm:p-5">
        <div className="room-graph-info grid min-w-0 content-start gap-6">
          <div className="flex items-center justify-end gap-1">
            <Button
              size="icon"
              variant="secondary"
              className="size-9 rounded-control text-muted-foreground"
              title={
                reduced
                  ? "Reduced motion enabled"
                  : paused
                    ? "Resume rotation"
                    : "Pause rotation"
              }
              aria-label={paused ? "Resume rotation" : "Pause rotation"}
              disabled={reduced}
              onClick={() => setPaused(!paused)}
            >
              {paused || reduced ? (
                <Play className="size-3.5" />
              ) : (
                <Pause className="size-3.5" />
              )}
            </Button>
            <Button
              size="icon"
              variant="secondary"
              className="size-9 rounded-control text-muted-foreground"
              title="Zoom out"
              aria-label="Zoom out"
              onClick={() => controller.current?.zoom(0.85)}
            >
              <Minus className="size-3.5" />
            </Button>
            <Button
              size="icon"
              variant="secondary"
              className="size-9 rounded-control text-muted-foreground"
              title="Zoom in"
              aria-label="Zoom in"
              onClick={() => controller.current?.zoom(1.15)}
            >
              <Plus className="size-3.5" />
            </Button>
            <Button
              size="icon"
              variant="secondary"
              className="size-9 rounded-control text-muted-foreground"
              title="Reset view"
              aria-label="Reset view"
              onClick={() => controller.current?.reset()}
            >
              <RotateCcw className="size-3.5" />
            </Button>
          </div>
          <div
            className="grid grid-cols-2 gap-x-4 gap-y-3 text-[11px] text-muted-foreground"
            aria-label="Graph legend"
          >
            {[
              ["●", "Send & receive"],
              ["○", "Receive only"],
              ["◐", "Send only"],
              ["⊘", "No data access"],
              ["◇", "Studio service"],
              ["◎", "Owner / admin"],
              ["▧", "Provider logo"],
              ["↔", "Two-way"],
              ["···→", "One-way"],
              ["◌", "Offline / inactive"],
            ].map(([symbol, label]) => (
              <span key={label} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="w-5 shrink-0 text-center text-sm text-foreground/70"
                >
                  {symbol}
                </span>
                {label}
              </span>
            ))}
          </div>
          {dense ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Over 500 connections · Showing selected member’s links. All
              members remain visible.
            </p>
          ) : null}
          {storage.isError ? (
            <p className="text-xs text-destructive">
              Storage provider details could not load. Memberships and
              permissions remain visible.
            </p>
          ) : null}
          {detail ? (
            <div
              className="grid min-w-0 gap-2 text-xs leading-relaxed"
              aria-live="polite"
            >
              <p className="break-words font-medium text-sm">{detail.name}</p>
              <p className="break-words text-muted-foreground">
                {detail.provider ||
                  (detail.kind === "service"
                    ? "Studio service"
                    : "Member")}{" "}
                · {detail.roles.join(", ") || "No assigned role"} ·{" "}
                {detail.active
                  ? presence[detail.id] || "Unknown presence"
                  : "Inactive"}
              </p>
              <p className="text-primary">{accessLabel(detail)}</p>
              <details className="min-w-0">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  Permissions & {connections.length} connections
                </summary>
                <div className="mt-3 max-h-52 space-y-2 overflow-y-auto break-words pr-2 text-muted-foreground">
                  {detail.permissions.map((p) => (
                    <p key={p.channelId}>
                      {p.channel}: {p.actions.join(", ") || "No permissions"}
                    </p>
                  ))}
                  {connections.map((link) => {
                    const other =
                      graph.nodes[
                        link.source === detailIndex ? link.target : link.source
                      ]!;
                    const outgoing =
                      link.source === detailIndex ? link.forward : link.reverse;
                    const incoming =
                      link.source === detailIndex ? link.reverse : link.forward;
                    return (
                      <div className="break-words pt-1" key={other.id}>
                        <span className="text-foreground">{other.name}</span>
                        {outgoing.map((d) => (
                          <p key={`out-${d.channelId}`}>
                            → {d.channel}: {d.send} → {d.receive}
                          </p>
                        ))}
                        {incoming.map((d) => (
                          <p key={`in-${d.channelId}`}>
                            ← {d.channel}: {d.send} → {d.receive}
                          </p>
                        ))}
                      </div>
                    );
                  })}
                  {!connections.length ? (
                    <p>
                      No compatible communication permissions with another
                      member.
                    </p>
                  ) : null}
                </div>
              </details>
            </div>
          ) : null}
        </div>
        <div className="room-graph-scene relative min-w-0">
          <p id={`${id}-keyboard`} className="sr-only">
            Use arrow keys to explore members, Home or End to jump, and Escape
            to clear selection. Member details appear beside the graph.
          </p>
          <canvas
            ref={canvas}
            role="img"
            aria-label="3D room permission graph"
            aria-describedby={`${id}-keyboard`}
            tabIndex={0}
            onKeyDown={(event) => {
              if (
                ![
                  "ArrowLeft",
                  "ArrowRight",
                  "ArrowUp",
                  "ArrowDown",
                  "Home",
                  "End",
                  "Escape",
                ].includes(event.key)
              )
                return;
              event.preventDefault();
              setHoveredId(null);
              if (event.key === "Escape") {
                setSelectedId(null);
                return;
              }
              const count = graph.nodes.length;
              if (!count) return;
              const current = graph.nodes.findIndex(
                (node) => node.id === selected?.id,
              );
              const direction =
                event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
              let next =
                current < 0 ? 0 : (current + direction + count) % count;
              if (event.key === "Home") next = 0;
              if (event.key === "End") next = count - 1;
              setSelectedId(graph.nodes[next]!.id);
            }}
            className="room-graph-canvas block w-full touch-none cursor-grab text-foreground outline-none focus-visible:rounded-control focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
          />
          {!graph.nodes.length ? (
            <p className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
              No room members
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
