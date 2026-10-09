import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  roomActionContentType,
  roomActionMinimumChannelPayloadBytes,
} from "@beam-studio/shared";
import {
  FileArchive,
  Globe2,
  Network,
  Plus,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { EmptyState } from "@/components/data-page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  type RoomChannel,
  type RoomSnapshot,
  record,
  roomChannels,
  roomsQueryKey,
  runRoomCommand,
  text,
} from "./room-data";
import { studioEnv } from "@/lib/env";
import { roomActionUnavailableReason } from "@/lib/room-access";
import { useRoomData } from "./room-hooks";
import { RoomPageFrame } from "./room-page-frame";

const channelKinds = [
  "message",
  "stream",
  "datagram",
  "request-reply",
  "media",
  "object",
] as const;

export function RoomChannelsPage({ roomId }: { roomId: string }) {
  const { query, room, refreshMutation } = useRoomData(roomId);
  const channels = useMemo(() => roomChannels(room), [room]);

  return (
    <RoomPageFrame
      activeView="channels"
      actionError={refreshMutation.error}
      actions={
        room ? (
          <RoomChannelCreateDialog
            room={room}
            trigger={
              <Button size="sm">
                <Plus className="size-4" />
                Add channel
              </Button>
            }
          />
        ) : null
      }
      channelAction={room ? <RoomChannelSidebarAction room={room} /> : null}
      error={query.error}
      isPending={query.isPending}
      room={room}
      roomId={roomId}
      title="Channels"
    >
      {room ? (
        channels.length ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {channels.map((channel) => (
              <Link
                className="group grid gap-4 rounded-surface border bg-card p-5 transition-colors hover:border-primary/40 hover:bg-accent/20"
                key={channel.id}
                to={`/rooms/${room.id}/channels/${channel.id}` as never}
              >
                <div className="flex items-start justify-between gap-4">
                  <span className="grid size-10 place-items-center rounded-control bg-primary/10 text-primary">
                    <ChannelIcon kind={channel.kind} />
                  </span>
                  <Badge variant="outline">{channel.state}</Badge>
                </div>
                <div className="min-w-0">
                  <h2 className="truncate font-medium group-hover:text-primary">
                    {channel.name}
                  </h2>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                    {channel.description}
                  </p>
                </div>
                <div className="flex items-center justify-between gap-3 border-t pt-3 text-xs text-muted-foreground">
                  <span>{channel.kind}</span>
                  <code className="max-w-[65%] truncate">{channel.id}</code>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <EmptyState
            action={
              <RoomChannelCreateDialog
                room={room}
                trigger={
                  <Button
                    disabled={roomActionUnavailableReason(room) !== null}
                    title={roomActionUnavailableReason(room) ?? undefined}
                  >
                    <Plus className="size-4" />
                    Add channel
                  </Button>
                }
              />
            }
            description="Create the first real channel for this room through its connected agent."
            icon={Network}
            title="No channels"
          />
        )
      ) : null}
    </RoomPageFrame>
  );
}

export function RoomChannelSidebarAction({ room }: { room: RoomSnapshot }) {
  return (
    <RoomChannelCreateDialog
      room={room}
      trigger={
        <button
          aria-label="Add channel"
          className="grid size-6 place-items-center rounded-control text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={roomActionUnavailableReason(room) ?? "Add channel"}
          type="button"
          disabled={roomActionUnavailableReason(room) !== null}
        >
          <Plus className="size-3.5" />
        </button>
      }
    />
  );
}

export function RoomChannelCreateDialog({
  room,
  trigger,
}: {
  room: RoomSnapshot;
  trigger: React.ReactNode;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<(typeof channelKinds)[number]>("message");
  const [initialState, setInitialState] = useState<"active" | "draft">(
    "active",
  );
  const [contentType, setContentType] = useState("application/json");
  const [schemaRef, setSchemaRef] = useState("");
  const [visibility, setVisibility] = useState<"restricted" | "room">(
    "restricted",
  );
  const [grantMode, setGrantMode] = useState<"room-roles" | "chosen-members">(
    "room-roles",
  );
  const [memberActions, setMemberActions] = useState<Record<string, string[]>>({});
  const initialDefaults = channelDefaults("message");
  const [reliability, setReliability] = useState(
    initialDefaults.delivery.reliability,
  );
  const [acknowledgement, setAcknowledgement] = useState(
    initialDefaults.delivery.acknowledgement,
  );
  const [backpressure, setBackpressure] = useState(
    initialDefaults.delivery.backpressure,
  );
  const [ordering, setOrdering] = useState(initialDefaults.ordering);
  const [qosClass, setQosClass] = useState(initialDefaults.qos.class);
  const [maxLatencyMillis, setMaxLatencyMillis] = useState(
    initialDefaults.qos.max_latency_millis,
  );
  const [preferredRateBps, setPreferredRateBps] = useState(
    initialDefaults.qos.preferred_rate_bps,
  );
  const [persistenceMode, setPersistenceMode] = useState("none");
  const [maxPayloadBytes, setMaxPayloadBytes] = useState(
    initialDefaults.maxPayloadBytes,
  );
  const [maxRateBps, setMaxRateBps] = useState(1_048_576);
  const [maxInflight, setMaxInflight] = useState(16);
  const [maxSubscribers, setMaxSubscribers] = useState(64);
  const ownerMemberId = text(room.metadata.owner_member_id);
  const availableActions = kind === "request-reply"
    ? ["request", "respond"]
    : contentType.trim() === roomActionContentType && kind === "message"
      ? ["publish", "subscribe", "manage"]
      : ["publish", "subscribe"];
  const members = room.memberships.filter((member) =>
    text(member.state) === "active" && text(member.member_id) &&
    (kind === "object" || text(member.kind) !== "object_storage"),
  );
  const selectChannelKind = (next: (typeof channelKinds)[number]) => {
    const defaults = channelDefaults(next);
    setKind(next);
    setMemberActions({});
    setContentType(channelContentType(next));
    setReliability(defaults.delivery.reliability);
    setAcknowledgement(defaults.delivery.acknowledgement);
    setBackpressure(defaults.delivery.backpressure);
    setOrdering(defaults.ordering);
    setQosClass(defaults.qos.class);
    setMaxLatencyMillis(defaults.qos.max_latency_millis);
    setPreferredRateBps(defaults.qos.preferred_rate_bps);
    setMaxPayloadBytes(defaults.maxPayloadBytes);
  };
  const toggleMemberAction = (memberId: string, action: string) => {
    setMemberActions((current) => {
      const actions = current[memberId] ?? [];
      return {
        ...current,
        [memberId]: actions.includes(action)
          ? actions.filter((item) => item !== action)
          : [...actions, action],
      };
    });
  };
  const createMutation = useMutation({
    mutationFn: async () => {
      if (room.readOnly) {
        throw new Error(
          "This organization room is read-only until a managed agent or Studio joins it.",
        );
      }
      if (contentType.trim() === roomActionContentType) {
        if (kind !== "message" || visibility !== "restricted" ||
            grantMode !== "chosen-members" ||
            maxPayloadBytes < roomActionMinimumChannelPayloadBytes) {
          throw new Error(
            `Room Workflow control requires a restricted message channel with only chosen members and at least ${roomActionMinimumChannelPayloadBytes} payload bytes.`,
          );
        }
        const participants = members.filter((member) => {
          const actions = memberActions[text(member.member_id)!] ?? [];
          return actions.includes("publish") || actions.includes("subscribe");
        });
        if (participants.length !== 2 ||
            !participants.every((member) => {
              const actions = memberActions[text(member.member_id)!] ?? [];
              return actions.includes("publish") && actions.includes("subscribe") &&
                text(member.agent_id);
            }) ||
            !participants.some((member) =>
              text(member.member_id) === ownerMemberId ||
              (memberActions[text(member.member_id)!] ?? []).includes("manage")) ||
            members.some((member) => {
              const memberId = text(member.member_id)!;
              return memberId !== ownerMemberId &&
                !participants.includes(member) &&
                (memberActions[memberId] ?? []).length > 0;
            })) {
          throw new Error(
            "Room Workflow control requires exactly two active agent members with publish and subscribe access, one with manage access; other members cannot receive grants.",
          );
        }
      }
      let initialGrants: Array<{ member_id: string; actions: string[] }> | undefined;
      if (grantMode === "chosen-members") {
        if (!ownerMemberId || !members.some((member) =>
          text(member.member_id) === ownerMemberId)) {
          throw new Error("The active room owner is required for private channel creation.");
        }
        const selectedActions = (memberId: string) =>
          (memberActions[memberId] ?? []).filter((action) =>
            availableActions.includes(action),
          );
        initialGrants = [
          { member_id: ownerMemberId,
            actions: [...new Set(["discover", "manage", ...selectedActions(ownerMemberId)])] },
          ...members.flatMap((member) => {
            const memberId = text(member.member_id)!;
            const actions = selectedActions(memberId);
            return memberId !== ownerMemberId && actions.length
              ? [{ member_id: memberId, actions: ["discover", ...actions] }]
              : [];
          }),
        ];
        if (!initialGrants.some((grant) => grant.actions.some((action) =>
          action === "publish" || action === "subscribe" ||
          action === "request" || action === "respond"))) {
          throw new Error("Choose at least one member action for a private channel.");
        }
      }
      const command = await runRoomCommand(
        grantMode === "chosen-members" ? null : room.agent?.id ?? null,
        "room.channel.create",
        {
          room_id: room.id,
          ...channelCreatePayload(room, {
            contentType,
            schemaRef,
            kind,
            name,
            visibility,
            initialGrants,
            delivery: { reliability, acknowledgement, backpressure },
            ordering,
            persistenceMode,
            qos: {
              class: qosClass,
              max_latency_millis: maxLatencyMillis,
              preferred_rate_bps: preferredRateBps,
            },
            limits: {
              max_payload_bytes: maxPayloadBytes,
              max_rate_bps: maxRateBps,
              max_inflight: maxInflight,
              max_subscribers: maxSubscribers,
            },
          }),
        },
      );
      const createdChannel = record(command.result?.channel);
      const channelId = text(createdChannel.channel_id);
      // The pairwise MLS controller activates this channel only after the
      // exact two-member group is ready. An early API activation would race it.
      if (initialState === "active" && channelId &&
          contentType.trim() !== roomActionContentType) {
        const authorizationEpoch = numeric(command.result?.authorization_epoch);
        const channelRevision = numeric(createdChannel.channel_revision);
        const keyEpoch = numeric(createdChannel.key_epoch);
        if (!authorizationEpoch || !channelRevision || !keyEpoch) {
          throw new Error(
            "The coordinator did not return the channel version required for activation.",
          );
        }
        await runRoomCommand(
          grantMode === "chosen-members" ? null : room.agent?.id ?? null,
          "room.channel.activate",
          {
            room_id: room.id,
            channel_id: channelId,
            expected_authorization_epoch: authorizationEpoch,
            expected_channel_revision: channelRevision,
            new_key_epoch: keyEpoch + 1,
          },
        );
      }
      return channelId;
    },
    onSuccess: async (channelId) => {
      await queryClient.invalidateQueries({ queryKey: roomsQueryKey });
      setOpen(false);
      navigate({
        to: channelId
          ? (`/rooms/${room.id}/channels/${channelId}` as never)
          : (`/rooms/${room.id}/channels` as never),
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add channel</DialogTitle>
          <DialogDescription>
            Create a channel in this room.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-6 pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            createMutation.mutate();
          }}
        >
          <div className="grid gap-5 md:grid-cols-2">
            <Field label="Name">
              <input
                className={inputClass}
                maxLength={160}
                onChange={(event) => setName(event.target.value)}
                placeholder="events"
                required
                value={name}
              />
            </Field>
            <Field label="Kind">
              <select
                className={inputClass}
                onChange={(event) => {
                  const next = event.target
                    .value as (typeof channelKinds)[number];
                  selectChannelKind(next);
                }}
                value={kind}
              >
                {channelKinds.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Content type">
              <input
                className={inputClass}
                onChange={(event) => {
                  const next = event.target.value;
                  setContentType(next);
                  if (next.trim() === roomActionContentType) {
                    setInitialState("active");
                    setMaxPayloadBytes((current) => Math.max(
                      current, roomActionMinimumChannelPayloadBytes,
                    ));
                  }
                }}
                required
                value={contentType}
              />
              {studioEnv.roomWorkflowsEnabled ? (
                <Button
                  className="mt-2"
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => {
                    selectChannelKind("message");
                    setContentType(roomActionContentType);
                    setGrantMode("chosen-members");
                    setVisibility("restricted");
                    setInitialState("active");
                    setMaxPayloadBytes(roomActionMinimumChannelPayloadBytes);
                  }}
                >
                  Use Room Workflow control preset
                </Button>
              ) : null}
            </Field>
            <Field label="Initial state">
              <select
                className={inputClass}
                disabled={contentType.trim() === roomActionContentType}
                onChange={(event) =>
                  setInitialState(event.target.value as "active" | "draft")
                }
                value={initialState}
              >
                <option value="active">Active</option>
                <option value="draft">Draft</option>
              </select>
              {contentType.trim() === roomActionContentType ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  This channel becomes active after both agents establish encryption.
                </p>
              ) : null}
            </Field>
            <Field label="Visibility">
              <select
                className={inputClass}
                onChange={(event) =>
                  setVisibility(event.target.value as "restricted" | "room")
                }
                value={visibility}
              >
                <option value="restricted">Restricted</option>
                <option disabled={grantMode === "chosen-members"} value="room">
                  Entire room
                </option>
              </select>
            </Field>
          </div>

          <section className="grid gap-3 rounded-surface border p-4">
            <Field label="Access at creation">
              <select
                className={inputClass}
                value={grantMode}
                onChange={(event) => {
                  const next = event.target.value as typeof grantMode;
                  setGrantMode(next);
                  if (next === "chosen-members") setVisibility("restricted");
                }}
              >
                <option value="room-roles">Standard room roles</option>
                <option value="chosen-members">Only chosen members</option>
              </select>
            </Field>
            {grantMode === "chosen-members" ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Choose each member's actions before creating the channel. The
                  room owner retains channel management; other room members
                  receive no access.
                </p>
                {contentType.trim() === roomActionContentType ? (
                  <p className="text-xs text-muted-foreground">
                    Give publish and subscribe to exactly the controller and one
                    executor. One of those agents also needs manage access.
                  </p>
                ) : null}
                <div className="grid gap-2">
                  {members.map((member) => {
                    const memberId = text(member.member_id)!;
                    return (
                      <div className="flex flex-wrap items-center justify-between gap-3 rounded-control border px-3 py-2" key={memberId}>
                        <span className="min-w-0 break-all text-sm">
                          {text(member.display_name) ?? text(member.principal_id) ?? memberId}
                          {memberId === ownerMemberId ? " (owner)" : ""}
                        </span>
                        <div className="flex gap-3">
                          {availableActions.map((action) => (
                            <label className="flex items-center gap-1.5 text-xs" key={action}>
                              <input
                                checked={(memberActions[memberId] ?? []).includes(action)}
                                onChange={() => toggleMemberAction(memberId, action)}
                                type="checkbox"
                              />
                              {action}
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : null}
          </section>

          <details className="group rounded-surface border bg-muted/20">
            <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm font-medium">
              <ShieldCheck className="size-4 text-primary" />
              Advanced channel policy
              <span className="ml-auto text-xs font-normal text-muted-foreground">
                delivery, storage, QoS and limits
              </span>
            </summary>
            <div className="grid gap-5 border-t p-4 md:grid-cols-2">
              <Field label="Schema reference">
                <input
                  className={inputClass}
                  onChange={(event) => setSchemaRef(event.target.value)}
                  placeholder="Optional URI or schema ID"
                  value={schemaRef}
                />
              </Field>
              <Field label="Reliability">
                <select
                  className={inputClass}
                  onChange={(event) => {
                    const next = event.target.value;
                    setReliability(next);
                    if (
                      next === "best_effort" &&
                      acknowledgement === "delivered"
                    ) {
                      setAcknowledgement("none");
                    }
                    if (next === "reliable" && backpressure === "drop_oldest") {
                      setBackpressure("disconnect");
                    }
                  }}
                  value={reliability}
                >
                  <option value="reliable">Reliable</option>
                  <option value="best_effort">Best effort</option>
                </select>
              </Field>
              <Field label="Acknowledgement">
                <select
                  className={inputClass}
                  onChange={(event) => setAcknowledgement(event.target.value)}
                  value={acknowledgement}
                >
                  <option value="none">None</option>
                  <option value="accepted">Accepted</option>
                  <option
                    disabled={reliability === "best_effort"}
                    value="delivered"
                  >
                    Delivered
                  </option>
                </select>
              </Field>
              <Field label="Backpressure">
                <select
                  className={inputClass}
                  onChange={(event) => setBackpressure(event.target.value)}
                  value={backpressure}
                >
                  <option value="disconnect">Disconnect</option>
                  <option
                    disabled={reliability === "reliable"}
                    value="drop_oldest"
                  >
                    Drop oldest
                  </option>
                  <option value="reject">Reject</option>
                </select>
              </Field>
              <Field label="Ordering">
                <select
                  className={inputClass}
                  onChange={(event) => setOrdering(event.target.value)}
                  value={ordering}
                >
                  <option value="none">None</option>
                  <option value="per_flow">Per flow</option>
                  <option value="per_publisher">Per publisher</option>
                </select>
              </Field>
              <Field label="Persistence">
                <select
                  className={inputClass}
                  onChange={(event) => setPersistenceMode(event.target.value)}
                  value={persistenceMode}
                >
                  <option value="none">None</option>
                  <option value="sender_local">Sender local</option>
                  <option value="receiver_local">Receiver local</option>
                </select>
              </Field>
              <Field label="QoS class">
                <select
                  className={inputClass}
                  onChange={(event) => setQosClass(event.target.value)}
                  value={qosClass}
                >
                  <option value="interactive">Interactive</option>
                  <option value="standard">Standard</option>
                  <option value="bulk">Bulk</option>
                </select>
              </Field>
              <NumberField
                label="Max latency (ms)"
                min={1}
                value={maxLatencyMillis}
                onChange={setMaxLatencyMillis}
              />
              <NumberField
                label="Preferred rate (bytes/s)"
                min={1}
                value={preferredRateBps}
                onChange={setPreferredRateBps}
              />
              <NumberField
                label="Max payload (bytes)"
                min={1}
                value={maxPayloadBytes}
                onChange={setMaxPayloadBytes}
              />
              <NumberField
                label="Max rate (bytes/s)"
                min={1}
                value={maxRateBps}
                onChange={setMaxRateBps}
              />
              <NumberField
                label="Max inflight"
                min={1}
                value={maxInflight}
                onChange={setMaxInflight}
              />
              <NumberField
                label="Max subscribers"
                min={1}
                value={maxSubscribers}
                onChange={setMaxSubscribers}
              />
            </div>
          </details>

          {createMutation.error ? (
            <p className="rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {createMutation.error instanceof Error
                ? createMutation.error.message
                : "Channel creation failed."}
            </p>
          ) : null}

          <div className="flex justify-end gap-3 border-t pt-5">
            <DialogClose asChild>
              <Button
                disabled={createMutation.isPending}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
            </DialogClose>
            <Button
              disabled={
                createMutation.isPending ||
                room.readOnly ||
                (grantMode === "room-roles" && room.agent !== null &&
                  room.agent.status !== "online")
              }
              type="submit"
            >
              <Plus className="size-4" />
              {createMutation.isPending ? "Creating…" : "Create channel"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function channelCreatePayload(
  room: RoomSnapshot,
  input: {
    contentType: string;
    schemaRef: string;
    kind: (typeof channelKinds)[number];
    name: string;
    visibility: "restricted" | "room";
    initialGrants?: Array<{ member_id: string; actions: string[] }>;
    delivery: Record<string, string>;
    ordering: string;
    persistenceMode: string;
    qos: Record<string, string | number>;
    limits: Record<string, number>;
  },
) {
  return {
    name: input.name.trim(),
    kind: input.kind,
    content_type: input.contentType.trim(),
    schema_ref: input.schemaRef.trim() || undefined,
    visibility: input.visibility,
    ...(input.initialGrants ? { initial_grants: input.initialGrants } : {}),
    delivery: input.delivery,
    persistence: {
      mode: input.persistenceMode,
      allowed_modes: [input.persistenceMode],
      max_bytes: input.persistenceMode === "none" ? 0 : 1_073_741_824,
      max_age_seconds: input.persistenceMode === "none" ? 0 : 86_400,
    },
    ordering: input.ordering,
    qos: input.qos,
    limits: {
      ...input.limits,
      max_queue_messages: 64,
      max_queue_bytes: 1_048_576,
      max_fanout_degree: 4,
      max_tree_depth: 4,
      deduplication_window_seconds: 60,
      publication_ttl_seconds: input.kind === "object" ? 86_400 : 60,
    },
    expected_authorization_epoch: numeric(room.metadata.authorization_epoch),
  };
}

function NumberField({
  label,
  min,
  onChange,
  value,
}: {
  label: string;
  min: number;
  onChange(value: number): void;
  value: number;
}) {
  return (
    <Field label={label}>
      <input
        className={inputClass}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
        type="number"
        value={value}
      />
    </Field>
  );
}

function channelDefaults(kind: (typeof channelKinds)[number]) {
  if (kind === "stream") {
    return {
      delivery: {
        reliability: "reliable",
        acknowledgement: "none",
        backpressure: "disconnect",
      },
      maxPayloadBytes: 65_536,
      ordering: "per_flow",
      qos: {
        class: "interactive",
        max_latency_millis: 1_000,
        preferred_rate_bps: 1_048_576,
      },
    };
  }
  if (kind === "datagram") {
    return {
      delivery: {
        reliability: "best_effort",
        acknowledgement: "none",
        backpressure: "drop_oldest",
      },
      maxPayloadBytes: 1_024,
      ordering: "none",
      qos: {
        class: "interactive",
        max_latency_millis: 1_000,
        preferred_rate_bps: 1_048_576,
      },
    };
  }
  if (kind === "media") {
    return {
      delivery: {
        reliability: "best_effort",
        acknowledgement: "none",
        backpressure: "drop_oldest",
      },
      maxPayloadBytes: 65_536,
      ordering: "per_flow",
      qos: {
        class: "interactive",
        max_latency_millis: 1_000,
        preferred_rate_bps: 8_388_608,
      },
    };
  }
  if (kind === "object") {
    return {
      delivery: {
        reliability: "reliable",
        acknowledgement: "delivered",
        backpressure: "disconnect",
      },
      maxPayloadBytes: 1_048_576,
      ordering: "per_flow",
      qos: {
        class: "bulk",
        max_latency_millis: 5_000,
        preferred_rate_bps: 8_388_608,
      },
    };
  }
  return {
    delivery: {
      reliability: "reliable",
      acknowledgement: "accepted",
      backpressure: "disconnect",
    },
    maxPayloadBytes: 1_048_576,
    ordering: "per_publisher",
    qos: {
      class: "standard",
      max_latency_millis: 1_000,
      preferred_rate_bps: 1_048_576,
    },
  };
}

function channelContentType(kind: (typeof channelKinds)[number]) {
  if (kind === "object" || kind === "stream" || kind === "datagram") {
    return "application/octet-stream";
  }
  if (kind === "media") return "application/webrtc";
  return "application/json";
}

function Field({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <label className="grid gap-2 text-sm font-medium">
      {label}
      {children}
    </label>
  );
}

function ChannelIcon({ kind }: { kind: string }) {
  const className = "size-4";
  if (["http", "https", "web"].includes(kind))
    return <Globe2 className={className} />;
  if (["object", "file", "blob"].includes(kind))
    return <FileArchive className={className} />;
  return <Terminal className={className} />;
}

function numeric(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const inputClass =
  "h-10 w-full rounded-control border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
