import { BillingKeySelect } from "@/features/billing/billing-key-select";
import { memberCanPerformAction } from "./room-permissions";
import { apiSend } from "@/lib/api-client";
import { selectedRoomTemplate } from "@/lib/beam-environments";
import { useBeamEnvironmentSettings } from "@/features/settings/beam-environment-data";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOutput, Plus, Send, X } from "lucide-react";
import {
  EmptyState,
  FilterBar,
  FilterSelect,
  ResultCounter,
  SearchInput,
} from "@/components/data-page";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  roomChannels,
  runRoomCommand,
  text,
  type RoomAgent,
  type RoomSnapshot,
} from "./room-data";
import {
  fetchRoomTransfers,
  roomTransfersQueryKey,
  type RoomTransfer,
} from "./room-transfer-data";
import { RoomTransferItem } from "./room-transfer-components";
import { RoomChannelSidebarAction } from "./room-channels-page";
import { useRoomData } from "./room-hooks";
import { RoomPageFrame } from "./room-page-frame";

const terminalStates = new Set([
  "completed",
  "partial",
  "failed",
  "cancelled",
  "expired",
]);

export function RoomTransfersPage({ roomId }: { roomId: string }) {
  const { query, room, refreshMutation } = useRoomData(roomId);
  const eligibleAgents = useMemo(
    () => transferAgents(room, query.data?.agents ?? []),
    [query.data?.agents, room],
  );
  const objectChannels = useMemo(
    () =>
      roomChannels(room).filter(
        (channel) => channel.kind === "object" && channel.state === "active",
      ),
    [room],
  );
  const [agentChoice, setAgentChoice] = useState("");
  const [channelChoice, setChannelChoice] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const agentId = eligibleAgents.some((agent) => agent.id === agentChoice)
    ? agentChoice
    : (eligibleAgents[0]?.id ?? "");
  const channelId = objectChannels.some(
    (channel) => channel.id === channelChoice,
  )
    ? channelChoice
    : (objectChannels[0]?.id ?? "");
  const transfersQuery = useQuery({
    queryKey: roomTransfersQueryKey(roomId),
    queryFn: () => fetchRoomTransfers(roomId),
    enabled: Boolean(roomId),
    refetchInterval: 5_000,
  });
  const filteredTransfers = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (transfersQuery.data ?? []).filter((transfer) => {
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
  }, [search, statusFilter, transfersQuery.data]);
  const selectedAgent = eligibleAgents.find((agent) => agent.id === agentId);

  return (
    <RoomPageFrame
      activeView="transfers"
      actionError={refreshMutation.error ?? transfersQuery.error}
      actions={
        room ? (
          <Button
            disabled={
              !agentId ||
              !channelId ||
              selectedAgent?.status !== "online" ||
              !room.memberships.some(
                (member) =>
                  member.agent_id === agentId &&
                  memberCanPerformAction(room, channelId, member, "publish"),
              )
            }
            onClick={() => setCreateOpen(true)}
            size="sm"
          >
            <Plus className="size-4" /> Send file
          </Button>
        ) : null
      }
      channelAction={room ? <RoomChannelSidebarAction room={room} /> : null}
      error={query.error}
      isPending={query.isPending}
      room={room}
      roomId={roomId}
      title="Transfers"
    >
      {room ? (
        <div className="grid gap-4">
          <div className="flex flex-wrap gap-3">
            <Field label="Source agent">
              <select
                className={inputClass}
                value={agentId}
                onChange={(event) => setAgentChoice(event.target.value)}
              >
                {eligibleAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name || agent.machineName || agent.id}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Object channel">
              <select
                className={inputClass}
                value={channelId}
                onChange={(event) => setChannelChoice(event.target.value)}
              >
                {objectChannels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <FilterBar>
            <SearchInput
              placeholder="Search transfers..."
              value={search}
              onChange={setSearch}
            />
            <FilterSelect
              label="Status"
              options={[
                ["all", "All statuses"],
                ["pending", "Pending"],
                ["in_progress", "In progress"],
                ["completed", "Completed"],
                ["partial", "Partial"],
                ["failed", "Failed"],
                ["cancelled", "Cancelled"],
              ]}
              value={statusFilter}
              onChange={setStatusFilter}
            />
            <ResultCounter
              totalCount={transfersQuery.data?.length ?? 0}
              visibleCount={filteredTransfers.length}
            />
          </FilterBar>

          {filteredTransfers.length ? (
            <div className="grid gap-2">
              {filteredTransfers.map((transfer, index) => (
                <TransferRow
                  agentId={
                    text(
                      room.memberships.find(
                        (member) =>
                          member.member_id === transfer.sourceMemberId,
                      )?.agent_id,
                    ) ?? undefined
                  }
                  channelName={
                    objectChannels.find(
                      (channel) => channel.id === transfer.channelId,
                    )?.name ?? transfer.channelId
                  }
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
                    : "Room transfers published in this room will appear here."
              }
              icon={FolderOutput}
              title={
                transfersQuery.isPending
                  ? "Loading transfers"
                  : "No transfers found"
              }
            />
          )}

          {agentId && channelId ? (
            <SendTransferDialog
              agentId={agentId}
              channelId={channelId}
              onOpenChange={setCreateOpen}
              open={createOpen}
              room={room}
            />
          ) : null}
        </div>
      ) : null}
    </RoomPageFrame>
  );
}

function TransferRow({
  agentId,
  channelName,
  defaultOpen,
  room,
  transfer,
}: {
  agentId?: string;
  channelName: string;
  defaultOpen: boolean;
  room: RoomSnapshot;
  transfer: RoomTransfer;
}) {
  const queryClient = useQueryClient();
  const cancelMutation = useMutation({
    mutationFn: () => {
      if (!agentId) {
        throw new Error("A transfer-capable room agent is required.");
      }
      if (transfer.workflowRunId)
        return apiSend(
          "POST",
          `/studio/workflow-runs/${transfer.workflowRunId}/cancel`,
          {},
        );
      return runRoomCommand(agentId, "room.channel.object.cancel", {
        room_id: room.id,
        channel_id: transfer.channelId,
        publication_id: transfer.id,
      });
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: roomTransfersQueryKey(room.id),
        }),
        queryClient.invalidateQueries({
          queryKey: roomTransfersQueryKey(room.id, transfer.channelId),
        }),
      ]),
  });
  return (
    <RoomTransferItem
      channelName={channelName}
      defaultOpen={defaultOpen}
      room={room}
      transfer={transfer}
      footer={
        <>
          {agentId &&
          transfer.role === "publisher" &&
          !terminalStates.has(transfer.state) ? (
            <div className="flex items-center justify-between gap-3 border-t pt-3">
              <p className="text-xs text-muted-foreground">
                Recipient coverage and state refresh every 5 seconds.
              </p>
              <Button
                disabled={cancelMutation.isPending}
                onClick={() => cancelMutation.mutate()}
                size="sm"
                variant="outline"
              >
                <X className="size-4" />{" "}
                {cancelMutation.isPending ? "Cancelling..." : "Cancel"}
              </Button>
            </div>
          ) : null}
          {transfer.workflowRunId ? (
            <a
              className="text-sm underline"
              href={`/workflows/runs/${transfer.workflowRunId}`}
            >
              View workflow run
            </a>
          ) : null}
          {cancelMutation.error ? (
            <p className="text-sm text-destructive">
              {errorMessage(cancelMutation.error)}
            </p>
          ) : null}
        </>
      }
    />
  );
}

function SendTransferDialog({
  agentId,
  channelId,
  onOpenChange,
  open,
  room,
}: {
  agentId: string;
  channelId: string;
  onOpenChange(value: boolean): void;
  open: boolean;
  room: RoomSnapshot;
}) {
  const queryClient = useQueryClient();
  const beamSettingsQuery = useBeamEnvironmentSettings();
  const beamTemplate = selectedRoomTemplate(beamSettingsQuery.data);
  // Quick send creates the same room workflow as the step form, so it depends on
  // the same Registry action and is refused by the same 503.
  const roomTransferAction = beamSettingsQuery.data?.roomTransferAction;
  const actionUnavailable = roomTransferAction?.available === false;
  const [file, setFile] = useState("");
  const [apiKeyId, setApiKeyId] = useState("");
  const [allowPartial, setAllowPartial] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [createdWorkflowId, setCreatedWorkflowId] = useState<string | null>(
    null,
  );
  const [ttl, setTTL] = useState(3600);
  const [sendToAll, setSendToAll] = useState(true);
  const [targets, setTargets] = useState<string[]>([]);
  const sourceMember = room.memberships.find(
    (membership) => text(membership.agent_id) === agentId,
  );
  const recipients = room.memberships.filter(
    (membership) =>
      text(membership.member_id) &&
      text(membership.member_id) !== text(sourceMember?.member_id) &&
      memberCanPerformAction(room, channelId, membership, "subscribe"),
  );
  const publishMutation = useMutation({
    mutationFn: async () => {
      const created = await apiSend<{ id: string }>(
        "POST",
        "/studio/room-workflows",
        {
          requestId,
          apiKeyId,
          name: file.trim().split("/").pop() || "Room transfer",
          config: {
            environmentTemplateKey: beamTemplate?.key ?? "prod",
            roomId: room.id,
            channelId,
            source: {
              memberId: text(sourceMember?.member_id),
              locator: { type: "agent_path", path: file.trim() },
            },
            targetMemberIds: sendToAll ? [] : targets,
            ttlSeconds: ttl,
            allowPartial,
          },
        },
      );
      setCreatedWorkflowId(created.id);
      return apiSend<{ runId: string }>(
        "POST",
        `/studio/workflows/${created.id}/run`,
        {},
      );
    },
    onSuccess: async ({ runId }) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: roomTransfersQueryKey(room.id),
        }),
        queryClient.invalidateQueries({
          queryKey: roomTransfersQueryKey(room.id, channelId),
        }),
      ]);
      setFile("");
      setRequestId(crypto.randomUUID());
      setCreatedWorkflowId(null);
      setTargets([]);
      setSendToAll(true);
      onOpenChange(false);
      window.location.assign(`/workflows/runs/${runId}`);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a file</DialogTitle>
          <DialogDescription>
            The path is resolved on the selected agent and must be inside a
            filesystem root allowed during Studio enrollment.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-5 pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            publishMutation.mutate();
          }}
        >
          {actionUnavailable ? (
            <p
              role="alert"
              className="rounded-control border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              Room transfers are unavailable: the action{" "}
              <code className="font-mono">
                @beam/room-transfer@{roomTransferAction?.version}
              </code>{" "}
              is not installed on this deployment. Publish it to this
              deployment&apos;s action Registry, then reload.
            </p>
          ) : null}
          <Field label="Workflow billing key">
            <BillingKeySelect
              beamTemplate={beamTemplate}
              value={apiKeyId}
              onChange={setApiKeyId}
            />
          </Field>
          <Field label="File path on agent">
            <input
              className={inputClass}
              onChange={(event) => setFile(event.target.value)}
              placeholder="/srv/beam/releases/archive.tar.gz"
              required
              value={file}
            />
          </Field>
          <Field label="Transfer lifetime">
            <select
              className={inputClass}
              onChange={(event) => setTTL(Number(event.target.value))}
              value={ttl}
            >
              <option value={900}>15 minutes</option>
              <option value={3600}>1 hour</option>
              <option value={21600}>6 hours</option>
              <option value={86400}>24 hours</option>
            </select>
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              checked={sendToAll}
              onChange={(event) => setSendToAll(event.target.checked)}
              type="checkbox"
            />
            Send to every authorized room member
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={allowPartial}
              onChange={(event) => setAllowPartial(event.target.checked)}
            />
            Allow partial delivery
          </label>
          {!sendToAll ? (
            <div className="grid max-h-48 gap-2 overflow-y-auto rounded-control border p-3">
              {recipients.map((membership) => {
                const memberId = text(membership.member_id)!;
                return (
                  <label
                    className="flex items-center gap-2 text-sm"
                    key={memberId}
                  >
                    <input
                      checked={targets.includes(memberId)}
                      onChange={(event) =>
                        setTargets((current) =>
                          event.target.checked
                            ? [...current, memberId]
                            : current.filter((id) => id !== memberId),
                        )
                      }
                      type="checkbox"
                    />
                    {text(membership.principal_id) ??
                      text(membership.agent_id) ??
                      memberId}
                  </label>
                );
              })}
            </div>
          ) : null}
          {createdWorkflowId ? (
            <a
              className="text-sm underline"
              href={`/workflows/${createdWorkflowId}`}
            >
              Open created workflow
            </a>
          ) : null}
          {publishMutation.error ? (
            <p className="rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {errorMessage(publishMutation.error)}
            </p>
          ) : null}
          <div className="flex justify-end gap-3 border-t pt-4">
            <DialogClose asChild>
              <Button
                disabled={publishMutation.isPending}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
            </DialogClose>
            <Button
              disabled={
                actionUnavailable ||
                publishMutation.isPending ||
                Boolean(createdWorkflowId) ||
                !file.trim() ||
                !apiKeyId ||
                (!sendToAll && !targets.length)
              }
              type="submit"
            >
              <Send className="size-4" />{" "}
              {publishMutation.isPending ? "Starting..." : "Send file"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function transferAgents(room: RoomSnapshot | null, agents: RoomAgent[]) {
  if (!room) return [];
  const memberAgentIds = new Set(
    room.memberships
      .filter((member) => member.state === "active")
      .map((membership) => text(membership.agent_id))
      .filter(Boolean),
  );
  return agents.filter(
    (agent) =>
      memberAgentIds.has(agent.id) &&
      agent.status === "online" &&
      (agent.capabilities ?? []).includes("room-workflows/v1"),
  );
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const inputClass =
  "h-10 w-full rounded-control border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
