import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
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
  record,
  roomsQueryKey,
  runRoomCommand,
  text,
  type RoomChannel,
  type RoomSnapshot,
} from "./room-data";
import { roomErrorMessage } from "./room-hooks";

const grantActions = [
  "discover",
  "publish",
  "subscribe",
  "manage",
  "request",
  "respond",
  "observe",
] as const;

export function RoomChannelPolicyDialog({
  channel,
  room,
}: {
  channel: RoomChannel;
  room: RoomSnapshot;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(channel.name);
  const [contentType, setContentType] = useState(
    text(channel.raw.content_type) ?? "application/json",
  );
  const [schemaRef, setSchemaRef] = useState(
    text(channel.raw.schema_ref) ?? "",
  );
  const [visibility, setVisibility] = useState(
    text(channel.raw.visibility) ?? "restricted",
  );
  const delivery = record(channel.raw.delivery);
  const qos = record(channel.raw.qos);
  const [reliability, setReliability] = useState(
    text(delivery.reliability) ?? "reliable",
  );
  const [acknowledgement, setAcknowledgement] = useState(
    text(delivery.acknowledgement) ?? "accepted",
  );
  const [backpressure, setBackpressure] = useState(
    text(delivery.backpressure) ?? "disconnect",
  );
  const [ordering, setOrdering] = useState(
    text(channel.raw.ordering) ?? "per_publisher",
  );
  const [qosClass, setQosClass] = useState(text(qos.class) ?? "standard");
  const [maxLatencyMillis, setMaxLatencyMillis] = useState(
    durationMillis(qos.max_latency),
  );
  const [preferredRateBps, setPreferredRateBps] = useState(
    numeric(qos.preferred_rate_bps),
  );
  const mutation = useMutation({
    mutationFn: () =>
      runRoomCommand(room.agent?.id ?? null, "room.channel.update", {
        ...channelPolicyPayload(channel),
        channel_id: channel.id,
        content_type: contentType.trim(),
        delivery: { reliability, acknowledgement, backpressure },
        expected_authorization_epoch: numeric(
          room.metadata.authorization_epoch,
        ),
        expected_channel_revision: numeric(channel.raw.channel_revision),
        name: name.trim(),
        ordering,
        qos: {
          class: qosClass,
          max_latency_millis: maxLatencyMillis,
          preferred_rate_bps: preferredRateBps,
        },
        room_id: room.id,
        schema_ref: schemaRef.trim() || undefined,
        visibility,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: roomsQueryKey });
      setOpen(false);
    },
  });

  if (!room.canManage || channel.state === "closed") return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button disabled={room.readOnly} size="sm" variant="outline">
          <Pencil className="size-3.5" />
          Edit policy
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit channel policy</DialogTitle>
          <DialogDescription>
            Update metadata, delivery guarantees and quality-of-service intent.
            Existing resource limits are preserved.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-5 pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <input
                className={inputClass}
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="Content type">
              <input
                className={inputClass}
                required
                value={contentType}
                onChange={(event) => setContentType(event.target.value)}
              />
            </Field>
            <Field label="Schema reference">
              <input
                className={inputClass}
                placeholder="Optional"
                value={schemaRef}
                onChange={(event) => setSchemaRef(event.target.value)}
              />
            </Field>
            <Field label="Visibility">
              <select
                className={inputClass}
                value={visibility}
                onChange={(event) => setVisibility(event.target.value)}
              >
                <option value="restricted">Restricted</option>
                <option value="room">Entire room</option>
              </select>
            </Field>
            <Field label="Reliability">
              <select
                className={inputClass}
                value={reliability}
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
              >
                <option value="reliable">Reliable</option>
                <option value="best_effort">Best effort</option>
              </select>
            </Field>
            <Field label="Acknowledgement">
              <select
                className={inputClass}
                value={acknowledgement}
                onChange={(event) => setAcknowledgement(event.target.value)}
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
                value={backpressure}
                onChange={(event) => setBackpressure(event.target.value)}
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
                value={ordering}
                onChange={(event) => setOrdering(event.target.value)}
              >
                <option value="none">None</option>
                <option value="per_flow">Per flow</option>
                <option value="per_publisher">Per publisher</option>
              </select>
            </Field>
            <Field label="QoS class">
              <select
                className={inputClass}
                value={qosClass}
                onChange={(event) => setQosClass(event.target.value)}
              >
                <option value="interactive">Interactive</option>
                <option value="standard">Standard</option>
                <option value="bulk">Bulk</option>
              </select>
            </Field>
            <Field label="Max latency (ms)">
              <input
                className={inputClass}
                min={1}
                type="number"
                value={maxLatencyMillis}
                onChange={(event) =>
                  setMaxLatencyMillis(Number(event.target.value))
                }
              />
            </Field>
            <Field label="Preferred rate (bytes/s)">
              <input
                className={inputClass}
                min={1}
                type="number"
                value={preferredRateBps}
                onChange={(event) =>
                  setPreferredRateBps(Number(event.target.value))
                }
              />
            </Field>
          </div>
          {mutation.error ? <ErrorMessage error={mutation.error} /> : null}
          <div className="flex justify-end gap-3 border-t pt-4">
            <DialogClose asChild>
              <Button
                disabled={mutation.isPending}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
            </DialogClose>
            <Button
              disabled={
                mutation.isPending || !name.trim() || !contentType.trim()
              }
              type="submit"
            >
              {mutation.isPending ? "Saving…" : "Save policy"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RoomChannelGrants({
  channel,
  room,
}: {
  channel: RoomChannel;
  room: RoomSnapshot;
}) {
  const queryClient = useQueryClient();
  const [subjectType, setSubjectType] = useState<"role" | "member">("role");
  const [subjectId, setSubjectId] = useState("");
  const [actions, setActions] = useState<string[]>(["discover", "subscribe"]);
  const grants = useMemo(
    () =>
      room.grants.filter(
        (grant) =>
          text(grant.channel_id) === channel.id &&
          (text(grant.state) ?? "active") === "active",
      ),
    [channel.id, room.grants],
  );
  const subjects = subjectOptions(room, subjectType);
  const selectedSubject = subjects.some((subject) => subject.id === subjectId)
    ? subjectId
    : (subjects[0]?.id ?? "");
  const mutation = useMutation({
    mutationFn: (input: {
      operation: string;
      payload: Record<string, unknown>;
    }) =>
      runRoomCommand(room.agent?.id ?? null, input.operation, {
        channel_id: channel.id,
        expected_authorization_epoch: numeric(
          room.metadata.authorization_epoch,
        ),
        expected_channel_revision: numeric(channel.raw.channel_revision),
        room_id: room.id,
        ...input.payload,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: roomsQueryKey }),
  });

  if (!room.canManage) return null;
  return (
    <section className="border bg-card">
      <div className="flex items-start justify-between gap-4 border-b px-4 py-3 sm:px-5">
        <div>
          <h2 className="text-sm font-semibold">Channel access</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Grant channel actions to a room role or an individual member.
          </p>
        </div>
        <Badge variant="secondary">{grants.length} grants</Badge>
      </div>
      {grants.length ? (
        <div className="divide-y">
          {grants.map((grant) => {
            const grantId = text(grant.grant_id) ?? "";
            const target = subjectLabel(
              room,
              text(grant.subject_type) ?? undefined,
              text(grant.subject_id) ?? undefined,
            );
            const grantedActions = Array.isArray(grant.actions)
              ? grant.actions.map(String)
              : [];
            return (
              <div
                className="flex items-center gap-3 px-4 py-3 sm:px-5"
                key={grantId}
              >
                <KeyRound className="size-4 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{target}</p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {grantedActions.join(", ") || "No actions"}
                  </p>
                </div>
                <ConfirmationDialog
                  confirmLabel="Revoke grant"
                  description={`Remove channel access currently granted to ${target}.`}
                  onConfirm={() =>
                    mutation.mutateAsync({
                      operation: "room.grant.revoke",
                      payload: { grant_id: grantId },
                    })
                  }
                  title="Revoke this channel grant?"
                  trigger={
                    <Button
                      disabled={mutation.isPending || room.readOnly}
                      size="icon"
                      variant="ghost"
                    >
                      <Trash2 className="size-4" />
                      <span className="sr-only">Revoke grant</span>
                    </Button>
                  }
                />
              </div>
            );
          })}
        </div>
      ) : (
        <p className="px-4 py-3 text-sm text-muted-foreground sm:px-5">
          No explicit grants for this channel.
        </p>
      )}
      {channel.state !== "closed" ? (
        <form
          className="grid gap-4 border-t bg-muted/20 p-4 sm:grid-cols-[150px_minmax(180px,1fr)_minmax(260px,2fr)_auto] sm:items-end sm:p-5"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate({
              operation: "room.grant.put",
              payload: {
                actions,
                subject_id: selectedSubject,
                subject_type: subjectType,
              },
            });
          }}
        >
          <Field label="Subject type">
            <select
              className={inputClass}
              value={subjectType}
              onChange={(event) => {
                setSubjectType(event.target.value as "role" | "member");
                setSubjectId("");
              }}
            >
              <option value="role">Role</option>
              <option value="member">Member</option>
            </select>
          </Field>
          <Field label={subjectType === "role" ? "Role" : "Member"}>
            <select
              className={inputClass}
              value={selectedSubject}
              onChange={(event) => setSubjectId(event.target.value)}
            >
              {subjects.map((subject) => (
                <option key={subject.id} value={subject.id}>
                  {subject.label}
                </option>
              ))}
            </select>
          </Field>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">Actions</legend>
            <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2 rounded-control border bg-background px-3 py-2">
              {grantActions.map((action) => (
                <label
                  className="flex items-center gap-1.5 text-xs"
                  key={action}
                >
                  <input
                    checked={actions.includes(action)}
                    onChange={(event) =>
                      setActions((current) =>
                        event.target.checked
                          ? [...current, action]
                          : current.filter((item) => item !== action),
                      )
                    }
                    type="checkbox"
                  />
                  {action}
                </label>
              ))}
            </div>
          </fieldset>
          <Button
            disabled={
              mutation.isPending ||
              room.readOnly ||
              !selectedSubject ||
              !actions.length
            }
            type="submit"
          >
            <Plus className="size-4" />
            {mutation.isPending ? "Saving…" : "Add grant"}
          </Button>
        </form>
      ) : null}
      {mutation.error ? (
        <div className="p-4 sm:p-5">
          <ErrorMessage error={mutation.error} />
        </div>
      ) : null}
    </section>
  );
}

function channelPolicyPayload(channel: RoomChannel) {
  const persistence = record(channel.raw.persistence);
  const limits = record(channel.raw.limits);
  return {
    kind: channel.kind,
    limits: {
      max_payload_bytes: numeric(limits.max_payload_bytes),
      max_rate_bps: numeric(limits.max_rate_bps),
      max_inflight: numeric(limits.max_inflight),
      max_queue_messages: numeric(limits.max_queue_messages),
      max_queue_bytes: numeric(limits.max_queue_bytes),
      max_subscribers: numeric(limits.max_subscribers),
      max_fanout_degree: numeric(limits.max_fanout_degree),
      max_tree_depth: numeric(limits.max_tree_depth),
      deduplication_window_seconds: durationSeconds(
        limits.deduplication_window,
      ),
      publication_ttl_seconds: durationSeconds(limits.publication_ttl),
    },
    persistence: {
      mode: text(persistence.mode) ?? "none",
      allowed_modes: Array.isArray(persistence.allowed_modes)
        ? persistence.allowed_modes.map(String)
        : [text(persistence.mode) ?? "none"],
      max_bytes: numeric(persistence.max_bytes),
      max_age_seconds: durationSeconds(persistence.max_age),
    },
  };
}

function subjectOptions(room: RoomSnapshot, type: "role" | "member") {
  return (type === "role" ? room.roles : room.memberships)
    .map((item) => {
      const id = text(item[type === "role" ? "role_id" : "member_id"]);
      if (!id) return null;
      return {
        id,
        label: text(item[type === "role" ? "name" : "principal_id"]) ?? id,
      };
    })
    .filter((item): item is { id: string; label: string } => item !== null);
}

function subjectLabel(room: RoomSnapshot, type?: string, id?: string) {
  if (!id) return "Unknown subject";
  const item = (type === "role" ? room.roles : room.memberships).find(
    (candidate) =>
      text(candidate[type === "role" ? "role_id" : "member_id"]) === id,
  );
  return text(item?.[type === "role" ? "name" : "principal_id"]) ?? id;
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

function ErrorMessage({ error }: { error: unknown }) {
  return (
    <p className="rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
      {roomErrorMessage(error)}
    </p>
  );
}

function numeric(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function durationMillis(value: unknown) {
  return Math.round(numeric(value) / 1_000_000);
}

function durationSeconds(value: unknown) {
  return Math.round(numeric(value) / 1_000_000_000);
}

const inputClass =
  "h-10 w-full rounded-control border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
