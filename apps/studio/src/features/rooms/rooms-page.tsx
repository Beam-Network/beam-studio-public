import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronRight,
  Circle,
  LoaderCircle,
  Plus,
  RadioTower,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import {
  EmptyState,
  FilterBar,
  FilterSelect,
  ResultCounter,
  SearchInput,
  TableSkeleton,
} from "@/components/data-page";
import { Button } from "@/components/ui/button";
import { BillingKeySelect } from "@/features/billing/billing-key-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { apiSend } from "@/lib/api-client";
import {
  record,
  roomAgentName,
  roomCoordinator,
  roomDisplayName,
  roomsQueryKey,
  runRoomCommand,
  text,
  updateRoomLabel,
  type RoomConsumerUnavailableReason,
  type RoomSnapshot,
} from "./room-data";
import { roomErrorMessage, roomUpdatedAt, useRoomsData } from "./room-hooks";

export function RoomsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { query, refreshMutation, roomControlAvailable, beamTemplate } =
    useRoomsData();
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [label, setLabel] = useState("");
  // Starting a room is billable, so the create names the key that pays for it.
  const [apiKeyId, setApiKeyId] = useState("");
  const rooms = query.data?.rooms ?? [];
  const consumer = query.data?.consumer ?? null;
  const consumerUnavailableReason =
    query.data?.consumerUnavailableReason ?? null;
  const consumerEnrolled =
    Boolean(consumer) ||
    (consumerUnavailableReason !== null &&
      consumerUnavailableReason !== "not_enrolled");
  // Room creation is refused server-side without an online consumer, before
  // anything is charged. Say so up front instead of letting the user submit.
  const consumerMissing = Boolean(query.data) && !consumer;
  const stateOptions = useMemo(
    () =>
      [...new Set(rooms.map((room) => room.state.toLowerCase()))]
        .sort()
        .map((state) => [state, titleCase(state)] as [string, string]),
    [rooms],
  );
  const visibleRooms = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rooms.filter((room) => {
      const haystack = [
        room.id,
        room.label,
        room.state,
        roomAgentName(room.agent),
        roomCoordinator(room),
        text(room.metadata.owner_principal_id),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        haystack.includes(needle) &&
        (stateFilter === "all" || room.state.toLowerCase() === stateFilter)
      );
    });
  }, [rooms, search, stateFilter]);
  const createMutation = useMutation({
    mutationFn: async () => {
      const command = await runRoomCommand(null, "room.create", {}, apiKeyId);
      const createdRoom = record(command.result?.room);
      const roomId = text(record(createdRoom.room).room_id);
      if (roomId && label.trim()) {
        await updateRoomLabel(roomId, label.trim());
      }
      return roomId;
    },
    onSuccess: async (roomId) => {
      await queryClient.invalidateQueries({ queryKey: roomsQueryKey });
      setCreateOpen(false);
      setLabel("");
      setApiKeyId("");
      if (roomId) navigate({ to: `/rooms/${roomId}` as never });
    },
  });
  const reconcileConsumerMutation = useMutation({
    mutationFn: () =>
      apiSend(
        "POST",
        `/studio/room-consumers/${encodeURIComponent(consumer!.id)}/reconcile`,
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: roomsQueryKey });
    },
  });
  const openCreateDialog = () => {
    setLabel("");
    setApiKeyId("");
    createMutation.reset();
    setCreateOpen(true);
  };

  return (
    <AppShell
      contentClassName="px-3 py-4"
      headerActions={
        <>
          <Dialog
            open={createOpen}
            onOpenChange={(open) => {
              if (open) {
                openCreateDialog();
              } else {
                setCreateOpen(false);
              }
            }}
          >
            <DialogTrigger asChild>
              <Button
                disabled={!roomControlAvailable}
                size="sm"
                type="button"
                variant="default"
              >
                <Plus className="size-4" />
                Create room
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create a room</DialogTitle>
                <DialogDescription>
                  Studio will create an organization-owned room directly on the
                  coordinator. Agents can join it later with an invitation.
                </DialogDescription>
              </DialogHeader>
              <form
                className="grid gap-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  createMutation.mutate();
                }}
              >
                <label className="grid gap-2 text-sm font-medium">
                  Label
                  <input
                    autoComplete="off"
                    className={inputClass}
                    maxLength={120}
                    onChange={(event) => setLabel(event.target.value)}
                    placeholder="e.g. Production transfers"
                    value={label}
                  />
                  <span className="text-xs font-normal text-muted-foreground">
                    Optional. The technical Room ID remains available.
                  </span>
                </label>
                <BillingKeySelect
                  beamTemplate={beamTemplate}
                  onChange={setApiKeyId}
                  value={apiKeyId}
                />
                {consumerMissing ? (
                  <p className="rounded-control border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
                    {roomConsumerUnavailableText(consumerUnavailableReason)} No
                    credit is charged while room creation is unavailable.
                  </p>
                ) : null}
                {createMutation.error ? (
                  <p className="rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                    {roomErrorMessage(createMutation.error)}
                  </p>
                ) : null}
                <div className="flex justify-end gap-2">
                  <Button
                    disabled={createMutation.isPending}
                    onClick={() => setCreateOpen(false)}
                    type="button"
                    variant="ghost"
                  >
                    Cancel
                  </Button>
                  <Button
                    disabled={
                      !roomControlAvailable ||
                      consumerMissing ||
                      createMutation.isPending ||
                      !apiKeyId
                    }
                    type="submit"
                  >
                    {createMutation.isPending ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : (
                      <Plus className="size-4" />
                    )}
                    {createMutation.isPending ? "Creating…" : "Create room"}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </>
      }
      title="Rooms"
    >
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-control border bg-card px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className={cn(
                "size-2.5 shrink-0 rounded-full bg-muted-foreground",
                consumer?.status === "online" && "bg-success",
              )}
            />
            <div className="min-w-0">
              <p className="text-sm font-medium">Studio room consumer</p>
              <p className="truncate text-xs text-muted-foreground">
                {consumer
                  ? `${roomAgentName(consumer)} · ${consumer.status}`
                  : roomConsumerUnavailableText(consumerUnavailableReason)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {consumer ? (
              <Button
                disabled={
                  !roomControlAvailable || reconcileConsumerMutation.isPending
                }
                onClick={() => reconcileConsumerMutation.mutate()}
                size="sm"
                type="button"
                variant="outline"
              >
                {reconcileConsumerMutation.isPending ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <RadioTower className="size-4" />
                )}
                Sync rooms
              </Button>
            ) : null}
            <Button asChild size="sm" variant="outline">
              <Link to={"/agents" as never}>
                {consumerEnrolled ? "Manage consumer" : "Enroll consumer"}
              </Link>
            </Button>
          </div>
        </div>
        {reconcileConsumerMutation.error ? (
          <p className="rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {roomErrorMessage(reconcileConsumerMutation.error)}
          </p>
        ) : null}
        <FilterBar>
          <SearchInput
            placeholder="All rooms..."
            value={search}
            onChange={setSearch}
          />
          <FilterSelect
            label="State"
            options={[["all", "All states"], ...stateOptions]}
            value={stateFilter}
            onChange={setStateFilter}
          />
          <ResultCounter
            isPending={query.isPending}
            totalCount={rooms.length}
            visibleCount={visibleRooms.length}
          />
        </FilterBar>

        {query.error || refreshMutation.error ? (
          <div className="rounded-control border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {roomErrorMessage(query.error ?? refreshMutation.error)}
          </div>
        ) : query.isPending ? (
          <TableSkeleton />
        ) : visibleRooms.length ? (
          <div className="overflow-hidden rounded-control border bg-card">
            <div className="divide-y">
              {visibleRooms.map((room) => (
                <RoomRow key={room.id} room={room} />
              ))}
            </div>
          </div>
        ) : (
          <EmptyState
            action={
              rooms.length ? null : (
                <Button
                  disabled={!roomControlAvailable}
                  onClick={openCreateDialog}
                  size="sm"
                  variant="default"
                >
                  <Plus className="size-4" />
                  Create room
                </Button>
              )
            }
            description={
              rooms.length
                ? "No rooms match the current search and state filter."
                : "No rooms have been created for this organization yet."
            }
            icon={RadioTower}
            title={rooms.length ? "No rooms match" : "No rooms yet"}
          />
        )}
      </div>
    </AppShell>
  );
}

const inputClass =
  "h-10 rounded-control border bg-background px-3 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring";

function RoomRow({ room }: { room: RoomSnapshot }) {
  const owner = text(room.metadata.owner_principal_id) ?? "Unknown principal";

  return (
    <Link
      className="grid min-h-14 grid-cols-[minmax(240px,1fr)_120px_160px_100px_180px_160px_32px] items-center gap-4 px-3 py-3 text-sm transition-colors hover:bg-secondary/60 max-xl:grid-cols-[minmax(220px,1fr)_120px_160px_160px_32px] max-lg:grid-cols-[minmax(0,1fr)_100px_32px]"
      to={`/rooms/${room.id}` as never}
    >
      <div className="min-w-0">
        <div className="truncate font-medium" title={roomDisplayName(room)}>
          {roomDisplayName(room)}
        </div>
        <div
          className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
          title={room.id}
        >
          {room.id}
        </div>
      </div>
      <RoomState state={room.state} />
      <span
        className="truncate text-muted-foreground max-lg:hidden"
        title={roomAgentName(room.agent)}
      >
        {roomAgentName(room.agent)}
      </span>
      <span className="truncate font-mono text-xs text-muted-foreground max-xl:hidden">
        {room.memberships.length} member
        {room.memberships.length === 1 ? "" : "s"}
      </span>
      <span
        className="truncate text-muted-foreground max-xl:hidden"
        title={owner}
      >
        {owner}
      </span>
      <span
        className="truncate text-muted-foreground max-lg:hidden"
        title={roomUpdatedAt(room)}
      >
        {roomUpdatedAt(room)}
      </span>
      <ChevronRight className="size-4 text-muted-foreground" />
    </Link>
  );
}

function RoomState({ state }: { state: string }) {
  const normalized = state.trim().toLowerCase();
  const tone =
    normalized === "active"
      ? "text-success"
      : ["inactive", "closed", "expired"].includes(normalized)
        ? "text-muted-foreground"
        : ["failed", "error"].includes(normalized)
          ? "text-destructive"
          : "text-warning";

  return (
    <span className="flex min-w-0 items-center gap-2">
      <Circle className={cn("size-2.5 shrink-0 fill-current", tone)} />
      <span className="truncate">{titleCase(normalized || "unknown")}</span>
    </span>
  );
}

function roomConsumerUnavailableText(
  reason: RoomConsumerUnavailableReason | null,
) {
  switch (reason) {
    case "offline":
      return "The Studio room consumer is offline. Rooms and media open once it reconnects.";
    case "not_authorized":
      return "The coordinator did not authorize the enrolled Studio room consumer for this organization.";
    default:
      return "No containerized consumer is enrolled for this organization.";
  }
}

function titleCase(value: string) {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
