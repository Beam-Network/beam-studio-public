import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  Circle,
  Database,
  KeyRound,
  Minus,
  Plus,
  ShieldCheck,
  Trash2,
  UserMinus,
  UserRound,
} from "lucide-react";
import { isS3CompatibleProvider } from "@beam-studio/shared";
import {
  EmptyState,
  FilterBar,
  FilterSelect,
  ResultCounter,
  SearchInput,
} from "@/components/data-page";
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
import { cn } from "@/lib/utils";
import {
  type RoomSnapshot,
  type RoomAgent,
  attachRoomStorageMember,
  fetchRoomStorageBindings,
  removeRoomStorageMember,
  roomStorageBindingsQueryKey,
  roomsQueryKey,
  runRoomCommand,
  text,
} from "./room-data";
import { roomActionUnavailableReason } from "@/lib/room-access";
import { ApiError } from "@/lib/api-errors";
import { apiGet } from "@/lib/api-client";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import {
  credentialBucketsFromPayload,
  fetchStorageObjects,
} from "@/features/workflows/workflow-storage-browser";
import type {
  CredentialDetail,
  CredentialRecord,
} from "@/features/workflows/workflow-graph-types";
import { roomErrorMessage, useRoomData } from "./room-hooks";
import { RoomPageFrame } from "./room-page-frame";
import { RoomChannelSidebarAction } from "./room-channels-page";

type RoomMemberRow = {
  agentId: string;
  bindingId: string | null;
  kind: "agent" | "object_storage";
  memberId: string;
  presence: string;
  principal: string;
  roleIds: string[];
  roles: string[];
  owner: boolean;
};

type RoomRoleOption = {
  description: string;
  id: string;
  name: string;
};

export function RoomMembersPage({ roomId }: { roomId: string }) {
  const queryClient = useQueryClient();
  const { query, room, refreshMutation, actionMutation } = useRoomData(roomId);
  const [search, setSearch] = useState("");
  const [presenceFilter, setPresenceFilter] = useState("all");
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const storageQuery = useQuery({
    enabled: Boolean(room),
    queryKey: roomStorageBindingsQueryKey(roomId),
    queryFn: () => fetchRoomStorageBindings(roomId),
  });
  const members = useMemo(
    () =>
      room
        ? roomMemberRows(
            room,
            storageQuery.data?.bindings ?? [],
            query.data?.agents ?? [],
          )
        : [],
    [room, storageQuery.data?.bindings, query.data?.agents],
  );
  const selectedMember =
    members.find((member) => member.memberId === selectedMemberId) ?? null;
  const visibleMembers = useMemo(() => {
    const needle = search.trim().toLowerCase();

    return members.filter((member) => {
      const matchesSearch = [
        member.principal,
        member.memberId,
        member.agentId,
        member.presence,
        ...member.roles,
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
      const matchesPresence =
        presenceFilter === "all" || member.presence === presenceFilter;

      return matchesSearch && matchesPresence;
    });
  }, [members, presenceFilter, search]);
  const presenceOptions = useMemo(
    () =>
      [...new Set(members.map((member) => member.presence))]
        .sort()
        .map(
          (presence) =>
            [presence, titleCase(presence)] satisfies [string, string],
        ),
    [members],
  );

  function changeRole(roleId: string, assigned: boolean) {
    if (!room || !selectedMember) return;
    actionMutation.mutate({
      operation: assigned ? "room.role.revoke" : "room.role.assign",
      payload: {
        expected_authorization_epoch: numeric(
          room.metadata.authorization_epoch,
        ),
        member_id: selectedMember.memberId,
        role_id: roleId,
      },
    });
  }

  function removeMember() {
    if (!room || !selectedMember || selectedMember.owner) return;
    if (selectedMember.kind === "object_storage" && selectedMember.bindingId) {
      removeRoomStorageMember(room.id, selectedMember.bindingId).then(
        async () => {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: roomsQueryKey }),
            queryClient.invalidateQueries({
              queryKey: roomStorageBindingsQueryKey(room.id),
            }),
          ]);
          setSelectedMemberId(null);
        },
      );
      return;
    }
    actionMutation.mutate(
      {
        operation: "room.membership.remove",
        payload: { member_id: selectedMember.memberId },
      },
      { onSuccess: () => setSelectedMemberId(null) },
    );
  }

  return (
    <RoomPageFrame
      activeView="members"
      actionError={refreshMutation.error ?? actionMutation.error}
      actions={
        room ? (
          <div className="flex items-center gap-2">
            <AddBucketMemberDialog
              room={room}
              agents={query.data?.agents ?? []}
            />
            <RoomRoleCreateDialog room={room} />
          </div>
        ) : null
      }
      channelAction={room ? <RoomChannelSidebarAction room={room} /> : null}
      error={query.error}
      isPending={query.isPending}
      room={room}
      roomId={roomId}
      title="Members"
    >
      {room ? (
        <div className="grid gap-3">
          {room.canManage ? (
            <RoomAccessControls
              pending={actionMutation.isPending}
              room={room}
              run={(operation, payload) =>
                actionMutation.mutate({ operation, payload })
              }
            />
          ) : null}
          <FilterBar>
            <SearchInput
              placeholder="Search members..."
              value={search}
              onChange={setSearch}
            />
            <FilterSelect
              label="Presence"
              options={[["all", "All presences"], ...presenceOptions]}
              value={presenceFilter}
              onChange={setPresenceFilter}
            />
            <ResultCounter
              totalCount={members.length}
              visibleCount={visibleMembers.length}
            />
          </FilterBar>

          {visibleMembers.length ? (
            <div className="overflow-hidden rounded-control border bg-card">
              <div className="divide-y">
                {visibleMembers.map((member) => (
                  <MemberRow
                    key={member.memberId}
                    member={member}
                    onSelect={() => {
                      actionMutation.reset();
                      setSelectedMemberId(member.memberId);
                    }}
                  />
                ))}
              </div>
            </div>
          ) : (
            <EmptyState
              description={
                members.length
                  ? "No members match the current search and presence filter."
                  : "The coordinator did not return any memberships for this room."
              }
              icon={UserRound}
              title={members.length ? "No members match" : "No members found"}
            />
          )}
          <MemberActionsDialog
            error={actionMutation.error}
            member={selectedMember}
            pending={actionMutation.isPending}
            room={room}
            onOpenChange={(open) => {
              if (!open) {
                actionMutation.reset();
                setSelectedMemberId(null);
              }
            }}
            onRoleChange={changeRole}
            onRemove={removeMember}
          />
        </div>
      ) : null}
    </RoomPageFrame>
  );
}

function MemberRow({
  member,
  onSelect,
}: {
  member: RoomMemberRow;
  onSelect(): void;
}) {
  return (
    <button
      aria-label={`Manage ${member.principal}`}
      className="grid min-h-14 w-full grid-cols-[minmax(240px,1fr)_120px_minmax(160px,240px)_180px_32px] items-center gap-4 px-3 py-3 text-left text-sm transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring max-xl:grid-cols-[minmax(220px,1fr)_120px_minmax(160px,240px)_32px] max-lg:grid-cols-[minmax(0,1fr)_100px_32px]"
      onClick={onSelect}
      type="button"
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          {member.kind === "object_storage" ? (
            <Database className="size-4 shrink-0 text-primary" />
          ) : null}
          <span className="truncate font-medium" title={member.principal}>
            {member.principal}
          </span>
          {member.roles.includes("Owner") ? (
            <Badge className="shrink-0" variant="outline">
              Owner
            </Badge>
          ) : null}
          <Badge className="shrink-0" variant="secondary">
            {member.kind === "object_storage" ? "Bucket" : "Agent"}
          </Badge>
        </div>
        <div
          className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
          title={member.memberId}
        >
          {member.memberId}
        </div>
      </div>
      <PresenceCell presence={member.presence} />
      <span
        className="truncate text-muted-foreground max-lg:hidden"
        title={member.roles.join(", ")}
      >
        {member.roles.length ? member.roles.join(", ") : "No roles"}
      </span>
      <span
        className="truncate font-mono text-xs text-muted-foreground max-xl:hidden"
        title={member.agentId}
      >
        {member.agentId}
      </span>
      <ChevronRight className="size-4 text-muted-foreground" />
    </button>
  );
}

function MemberActionsDialog({
  error,
  member,
  pending,
  room,
  onOpenChange,
  onRoleChange,
  onRemove,
}: {
  error: unknown;
  member: RoomMemberRow | null;
  pending: boolean;
  room: RoomSnapshot;
  onOpenChange(open: boolean): void;
  onRoleChange(roleId: string, assigned: boolean): void;
  onRemove(): void;
}) {
  const roles = roomRoleOptions(room);
  const actionsAvailable =
    !room.readOnly &&
    room.state === "active" &&
    (room.agent === null || room.agent.status === "online");

  return (
    <Dialog open={member !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {member ? (
          <>
            <DialogHeader>
              <DialogTitle>{member.principal}</DialogTitle>
              <DialogDescription>
                Review this room member and manage their role assignments.
              </DialogDescription>
            </DialogHeader>

            <dl className="grid gap-px overflow-hidden rounded-surface border bg-border sm:grid-cols-3">
              <MemberMeta label="Member ID" value={member.memberId} />
              <MemberMeta
                label={member.kind === "object_storage" ? "Resource" : "Agent"}
                value={member.agentId}
              />
              <MemberMeta label="Presence" value={titleCase(member.presence)} />
            </dl>

            <div className="grid gap-2">
              <p className="text-sm font-medium">Roles</p>
              {roles.length ? (
                <div className="divide-y overflow-hidden rounded-control border">
                  {roles.map((role) => {
                    const assigned = member.roleIds.includes(role.id);
                    return (
                      <div
                        className="flex min-h-14 items-center gap-4 px-3 py-3"
                        key={role.id}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">
                              {role.name}
                            </span>
                            {assigned ? (
                              <Badge variant="secondary">Assigned</Badge>
                            ) : null}
                          </div>
                          <p
                            className="mt-0.5 truncate text-xs text-muted-foreground"
                            title={role.description}
                          >
                            {role.description}
                          </p>
                        </div>
                        <Button
                          disabled={pending || !actionsAvailable}
                          onClick={() => onRoleChange(role.id, assigned)}
                          size="sm"
                          type="button"
                          variant={assigned ? "outline" : "secondary"}
                        >
                          {assigned ? (
                            <Minus className="size-3.5" />
                          ) : (
                            <Plus className="size-3.5" />
                          )}
                          {assigned ? "Revoke" : "Assign"}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="rounded-control border border-dashed p-4 text-sm text-muted-foreground">
                  No assignable roles are available for this room.
                </p>
              )}
            </div>

            {!actionsAvailable ? (
              <p className="rounded-control border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                Role changes are unavailable while the room is inactive or its
                connected agent is offline.
              </p>
            ) : null}

            {error ? (
              <p className="rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {roomErrorMessage(error)}
              </p>
            ) : null}

            <div className="flex justify-end border-t pt-4">
              {!member.owner && room.canManage ? (
                <ConfirmationDialog
                  confirmLabel="Remove member"
                  description={`Remove ${member.principal} from this room and revoke their active channel access.`}
                  onConfirm={onRemove}
                  title="Remove this member?"
                  trigger={
                    <Button
                      className="mr-auto"
                      disabled={pending || !actionsAvailable}
                      type="button"
                      variant="destructive"
                    >
                      <UserMinus className="size-4" />
                      Remove member
                    </Button>
                  }
                />
              ) : null}
              <DialogClose asChild>
                <Button disabled={pending} type="button" variant="outline">
                  Close
                </Button>
              </DialogClose>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function MemberMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-card p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate font-mono text-xs font-medium" title={value}>
        {value}
      </dd>
    </div>
  );
}

function PresenceCell({ presence }: { presence: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Circle
        className={cn(
          "size-2.5 fill-current",
          presence === "online"
            ? "text-success"
            : presence === "offline"
              ? "text-muted-foreground"
              : "text-warning",
        )}
      />
      <span className="truncate">{titleCase(presence)}</span>
    </span>
  );
}

function roomMemberRows(
  room: RoomSnapshot,
  bindings: import("./room-data").RoomStorageBinding[],
  agents: RoomAgent[],
): RoomMemberRow[] {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  return room.memberships.map((membership, index) => {
    const memberId = text(membership.member_id) ?? `member-${index + 1}`;
    const assignedRoles = room.memberRoles
      .filter((assignment) => text(assignment.member_id) === memberId)
      .map((assignment) =>
        room.roles.find(
          (role) => text(role.role_id) === text(assignment.role_id),
        ),
      )
      .map((role) => text(role?.name))
      .filter((name): name is string => Boolean(name));
    const roles = [
      ...(membership.owner === true ? ["Owner"] : []),
      ...assignedRoles,
    ].filter(
      (role, roleIndex, allRoles) =>
        allRoles.findIndex(
          (candidate) => candidate.toLowerCase() === role.toLowerCase(),
        ) === roleIndex,
    );

    const kind =
      text(membership.kind) === "object_storage" ? "object_storage" : "agent";
    const resourceId = text(membership.resource_id);
    const agent = agentsById.get(text(membership.agent_id) ?? "");
    const binding = bindings.find(
      (candidate) =>
        candidate.coordinatorMemberId === memberId ||
        candidate.resourceId === resourceId,
    );
    return {
      agentId:
        kind === "object_storage"
          ? (resourceId ?? "Storage resource")
          : (text(membership.agent_id) ?? "No agent"),
      bindingId: binding?.id ?? null,
      kind,
      memberId,
      presence:
        text(membership.presence) ?? text(membership.state) ?? "unknown",
      principal:
        binding?.displayName ??
        agent?.name ??
        agent?.machineName ??
        text(membership.display_name) ??
        text(membership.principal_id) ??
        "Unknown principal",
      roleIds: room.memberRoles
        .filter((assignment) => text(assignment.member_id) === memberId)
        .map((assignment) => text(assignment.role_id))
        .filter((roleId): roleId is string => Boolean(roleId)),
      roles,
      owner: membership.owner === true,
    };
  });
}

function roomRoleOptions(room: RoomSnapshot): RoomRoleOption[] {
  return room.roles
    .map((role) => {
      const id = text(role.role_id);
      if (!id) return null;
      const name = text(role.name) ?? text(role.template) ?? id;
      return {
        description: text(role.description) ?? id,
        id,
        name,
      };
    })
    .filter((role): role is RoomRoleOption => role !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function RoomAccessControls({
  pending,
  room,
  run,
}: {
  pending: boolean;
  room: RoomSnapshot;
  run(operation: string, payload: Record<string, unknown>): void;
}) {
  const invitations = room.invitations
    .filter((invitation) => text(invitation.state) === "active")
    .sort((left, right) =>
      (text(right.created_at) ?? "").localeCompare(text(left.created_at) ?? ""),
    );
  const customRoles = room.roles.filter(
    (role) => role.built_in !== true && text(role.template) === "custom",
  );

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <section className="overflow-hidden rounded-surface border bg-card">
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <KeyRound className="size-4 text-primary" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">Active invitations</h2>
            <p className="text-xs text-muted-foreground">
              Revoke bearer links that should no longer admit members.
            </p>
          </div>
          <Badge variant="secondary">{invitations.length}</Badge>
        </div>
        {invitations.length ? (
          <div className="divide-y">
            {invitations.map((invitation) => {
              const invitationId = text(invitation.invitation_id) ?? "";
              return (
                <div
                  className="flex items-center gap-3 px-4 py-3"
                  key={invitationId}
                >
                  <div className="min-w-0 flex-1">
                    <p
                      className="truncate font-mono text-xs"
                      title={invitationId}
                    >
                      {invitationId}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {numeric(invitation.use_count)}/
                      {numeric(invitation.max_uses)} uses
                      {Array.isArray(invitation.role_ids)
                        ? ` · ${invitation.role_ids.length} roles`
                        : ""}
                      {Array.isArray(invitation.channel_access)
                        ? ` · ${invitation.channel_access.length} channels`
                        : ""}
                      {text(invitation.expires_at)
                        ? ` · expires ${formatDate(text(invitation.expires_at)!)} `
                        : ""}
                    </p>
                  </div>
                  <ConfirmationDialog
                    confirmLabel="Revoke invitation"
                    description="Agents holding this bearer will no longer be able to join with it. Existing members are unaffected."
                    onConfirm={() =>
                      run("room.invitation.revoke", {
                        invitation_id: invitationId,
                      })
                    }
                    title="Revoke this invitation?"
                    trigger={
                      <Button disabled={pending} size="icon" variant="ghost">
                        <Trash2 className="size-4" />
                        <span className="sr-only">Revoke invitation</span>
                      </Button>
                    }
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <p className="p-4 text-sm text-muted-foreground">
            No active invitations. Use Share room to create one.
          </p>
        )}
      </section>

      <section className="overflow-hidden rounded-surface border bg-card">
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <ShieldCheck className="size-4 text-primary" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">Custom roles</h2>
            <p className="text-xs text-muted-foreground">
              Reusable room roles for member and channel access.
            </p>
          </div>
          <Badge variant="secondary">{customRoles.length}</Badge>
        </div>
        {customRoles.length ? (
          <div className="divide-y">
            {customRoles.map((role) => {
              const roleId = text(role.role_id) ?? "";
              const assignmentCount = room.memberRoles.filter(
                (assignment) =>
                  text(assignment.role_id) === roleId &&
                  (text(assignment.state) ?? "active") === "active",
              ).length;
              return (
                <div className="flex items-center gap-3 px-4 py-3" key={roleId}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {text(role.name) ?? roleId}
                    </p>
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      {assignmentCount} assignment
                      {assignmentCount === 1 ? "" : "s"} · {roleId}
                    </p>
                  </div>
                  <ConfirmationDialog
                    confirmLabel="Delete role"
                    description="This removes the role and its active member assignments. Channel grants using it must be revoked first."
                    onConfirm={() =>
                      run("room.role.delete", {
                        expected_authorization_epoch: numeric(
                          room.metadata.authorization_epoch,
                        ),
                        role_id: roleId,
                      })
                    }
                    title="Delete this custom role?"
                    trigger={
                      <Button disabled={pending} size="icon" variant="ghost">
                        <Trash2 className="size-4" />
                        <span className="sr-only">Delete role</span>
                      </Button>
                    }
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <p className="p-4 text-sm text-muted-foreground">
            No custom roles. Built-in owner, admin and member roles stay
            protected.
          </p>
        )}
      </section>
    </div>
  );
}

function AddBucketMemberDialog({
  room,
  agents,
}: {
  room: RoomSnapshot;
  agents: RoomAgent[];
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [credentialId, setCredentialId] = useState("");
  const [bucket, setBucket] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [destinationPrefix, setDestinationPrefix] = useState("");
  const [destinationLayout, setDestinationLayout] = useState<
    "isolated" | "preserve_path" | "flat_name"
  >("isolated");
  const [collisionPolicy, setCollisionPolicy] = useState<
    "fail_if_exists" | "overwrite"
  >("fail_if_exists");
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [delegateMemberIds, setDelegateMemberIds] = useState<string[]>([]);
  const [delegateRoleIds, setDelegateRoleIds] = useState<string[]>([]);
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const credentialsQuery = useQuery({
    enabled: open,
    queryKey: ["/studio/credentials"],
    queryFn: () =>
      apiGet<{ credentials?: CredentialRecord[] }>("/studio/credentials"),
  });
  const compatibleCredentials = (
    credentialsQuery.data?.credentials ?? []
  ).filter((credential) => isS3CompatibleProvider(credential.kind));
  const credentialQuery = useQuery({
    enabled: open && Boolean(credentialId),
    queryKey: ["/studio/credentials", credentialId],
    queryFn: () =>
      apiGet<{ credential: CredentialDetail }>(
        `/studio/credentials/${encodeURIComponent(credentialId)}`,
      ),
  });
  const savedBuckets = credentialBucketsFromPayload(
    credentialQuery.data?.credential.payload ?? {},
  );
  const verificationInput = useMemo(
    () => ({ credentialId, bucket: bucket.trim() }),
    [credentialId, bucket],
  );
  const settledInput = useDebouncedValue(verificationInput, 500);
  const verificationCurrent =
    open &&
    verificationInput.credentialId === settledInput.credentialId &&
    verificationInput.bucket === settledInput.bucket;
  const browserQuery = useQuery({
    enabled:
      verificationCurrent &&
      Boolean(settledInput.credentialId && settledInput.bucket),
    queryKey: [
      "room-storage-bucket",
      settledInput.credentialId,
      settledInput.bucket,
    ],
    queryFn: () =>
      fetchStorageObjects({
        ...settledInput,
        prefix: "",
      }),
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.statusCode < 500) &&
      failureCount < 1,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const objectChannels = room.channels.filter(
    (channel) =>
      text(channel.kind) === "object" &&
      (text(channel.state) ?? "active") === "active",
  );
  const assignableRoles = roomRoleOptions(room).filter(
    (role) => !/^(owner|admin)$/i.test(role.name),
  );
  const delegateMembers = roomMemberRows(room, [], agents).filter(
    (member) => member.kind === "agent",
  );
  const mutation = useMutation({
    mutationFn: () =>
      attachRoomStorageMember(room.id, {
        credentialId,
        bucket: bucket.trim(),
        displayName: displayName.trim() || bucket.trim(),
        objectChannelIds: channelIds,
        destinationPrefix: destinationPrefix.trim(),
        destinationLayout,
        collisionPolicy,
        sourceDelegateMemberIds: delegateMemberIds,
        sourceDelegateRoleIds: delegateRoleIds,
        roleIds,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: roomsQueryKey }),
        queryClient.invalidateQueries({
          queryKey: roomStorageBindingsQueryKey(room.id),
        }),
      ]);
      reset();
      setOpen(false);
    },
  });

  function reset() {
    setCredentialId("");
    setBucket("");
    setDisplayName("");
    setDestinationPrefix("");
    setDestinationLayout("isolated");
    setCollisionPolicy("fail_if_exists");
    setChannelIds([]);
    setDelegateMemberIds([]);
    setDelegateRoleIds([]);
    setRoleIds([]);
    mutation.reset();
  }

  if (!room.canManage) return null;
  const canSubmit =
    credentialId.length > 0 &&
    bucket.trim().length > 0 &&
    channelIds.length > 0 &&
    verificationCurrent &&
    browserQuery.isSuccess &&
    !browserQuery.isFetching;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button
          disabled={roomActionUnavailableReason(room) !== null}
          size="sm"
          title={roomActionUnavailableReason(room) ?? undefined}
        >
          <Database className="size-4" />
          Add bucket member
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add an object-storage bucket</DialogTitle>
          <DialogDescription>
            Reuse an organization credential and attach its bucket to this room.
            Publications involving buckets use TLS with worker-visible plaintext
            for every recipient; they do not use room MLS encryption.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-5 pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) mutation.mutate();
          }}
        >
          <FormSelect
            label="Object-storage credential"
            value={credentialId}
            onChange={(value) => {
              setCredentialId(value);
              setBucket("");
            }}
            options={compatibleCredentials.map((credential) => [
              credential.id,
              credential.name,
            ])}
            placeholder="Select an existing credential"
          />
          {credentialsQuery.isSuccess && !compatibleCredentials.length ? (
            <p className="rounded-control border border-dashed p-3 text-sm text-muted-foreground">
              Add an S3-compatible, R2, MinIO, Wasabi, Backblaze B2, Hippius, or
              Hugging Face Storage Bucket credential on the Credentials page.
            </p>
          ) : null}
          {credentialId ? (
            <label className="grid gap-2 text-sm font-medium">
              Bucket
              {savedBuckets.length ? (
                <select
                  className="h-10 rounded-control border bg-background px-3 text-sm"
                  onChange={(event) => setBucket(event.target.value)}
                  value={savedBuckets.includes(bucket) ? bucket : ""}
                >
                  <option value="">Choose a saved bucket</option>
                  {savedBuckets.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              ) : null}
              <input
                className="h-10 rounded-control border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => setBucket(event.target.value)}
                placeholder="Bucket name"
                required
                value={bucket}
              />
              <span className="text-xs font-normal text-muted-foreground">
                Use the exact bucket name, not a display name, URL, or object
                path.
              </span>
              {verificationCurrent && browserQuery.isSuccess ? (
                <span className="text-xs font-normal text-success">
                  Bucket access verified through the existing storage browser.
                </span>
              ) : verificationCurrent && browserQuery.error ? (
                <span className="text-xs font-normal text-destructive">
                  {roomErrorMessage(browserQuery.error)}
                </span>
              ) : null}
            </label>
          ) : null}
          <label className="grid gap-2 text-sm font-medium">
            Display name
            <input
              className="h-10 rounded-control border bg-background px-3 text-sm"
              maxLength={120}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={bucket || "Archive bucket"}
              value={displayName}
            />
          </label>
          <MultiChoice
            description="Buckets can only join active object channels."
            label="Object channels"
            options={objectChannels.map((channel) => [
              text(channel.channel_id) ?? "",
              text(channel.name) ??
                text(channel.channel_id) ??
                "Object channel",
            ])}
            selected={channelIds}
            onChange={setChannelIds}
          />
          <MultiChoice
            description="Optional room roles assigned to this bucket member."
            label="Roles"
            options={assignableRoles.map((role) => [role.id, role.name])}
            selected={roleIds}
            onChange={setRoleIds}
          />
          <MultiChoice
            description="These room members may initiate transfers from this bucket. Organization owners are always allowed."
            label="Source delegates"
            options={delegateMembers.map((member) => [
              member.memberId,
              member.principal,
            ])}
            selected={delegateMemberIds}
            onChange={setDelegateMemberIds}
          />
          <MultiChoice
            description="Members holding these roles may initiate transfers from this bucket."
            label="Source delegate roles"
            options={assignableRoles.map((role) => [role.id, role.name])}
            selected={delegateRoleIds}
            onChange={setDelegateRoleIds}
          />
          <div className="grid gap-4 rounded-control border p-4 sm:grid-cols-2">
            <label className="grid gap-2 text-sm font-medium">
              Destination prefix
              <input
                className="h-10 rounded-control border bg-background px-3 text-sm"
                onChange={(event) => setDestinationPrefix(event.target.value)}
                placeholder="room-deliveries"
                value={destinationPrefix}
              />
            </label>
            <FormSelect
              label="Destination layout"
              value={destinationLayout}
              onChange={(value) =>
                setDestinationLayout(value as typeof destinationLayout)
              }
              options={[
                ["isolated", "Isolated by room and publication"],
                ["preserve_path", "Preserve relative path"],
                ["flat_name", "Flat file name"],
              ]}
            />
            <FormSelect
              label="When an object exists"
              value={collisionPolicy}
              onChange={(value) =>
                setCollisionPolicy(value as typeof collisionPolicy)
              }
              options={[
                ["fail_if_exists", "Fail without replacing"],
                ["overwrite", "Overwrite"],
              ]}
            />
          </div>
          {mutation.error ? (
            <p className="rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {roomErrorMessage(mutation.error)}
            </p>
          ) : null}
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
            <Button disabled={!canSubmit || mutation.isPending} type="submit">
              {mutation.isPending ? "Adding…" : "Add bucket member"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FormSelect({
  label,
  value,
  options,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  placeholder?: string;
  onChange(value: string): void;
}) {
  return (
    <label className="grid gap-2 text-sm font-medium">
      {label}
      <select
        className="h-10 rounded-control border bg-background px-3 text-sm"
        onChange={(event) => onChange(event.target.value)}
        required
        value={value}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
}

function MultiChoice({
  description,
  label,
  options,
  selected,
  onChange,
}: {
  description: string;
  label: string;
  options: [string, string][];
  selected: string[];
  onChange(value: string[]): void;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium">{label}</legend>
      <p className="text-xs text-muted-foreground">{description}</p>
      <div className="max-h-40 divide-y overflow-y-auto rounded-control border">
        {options.length ? (
          options.map(([value, name]) => (
            <label
              className="flex items-center gap-3 px-3 py-2 text-sm"
              key={value}
            >
              <input
                checked={selected.includes(value)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, value]
                      : selected.filter((item) => item !== value),
                  )
                }
                type="checkbox"
              />
              <span className="truncate">{name}</span>
            </label>
          ))
        ) : (
          <p className="p-3 text-sm text-muted-foreground">None available.</p>
        )}
      </div>
    </fieldset>
  );
}

function RoomRoleCreateDialog({ room }: { room: RoomSnapshot }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      runRoomCommand(room.agent?.id ?? null, "room.role.create", {
        expected_authorization_epoch: numeric(
          room.metadata.authorization_epoch,
        ),
        name: name.trim(),
        room_id: room.id,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: roomsQueryKey });
      setName("");
      setOpen(false);
    },
  });

  if (!room.canManage) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          disabled={roomActionUnavailableReason(room) !== null}
          size="sm"
          title={roomActionUnavailableReason(room) ?? undefined}
        >
          <Plus className="size-4" />
          Add role
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a custom role</DialogTitle>
          <DialogDescription>
            Create a reusable role, then assign it to members and channel
            grants.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-5 pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <label className="grid gap-2 text-sm font-medium">
            Role name
            <input
              className="h-10 rounded-control border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder="Publisher"
              required
              value={name}
            />
          </label>
          {mutation.error ? (
            <p className="rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {roomErrorMessage(mutation.error)}
            </p>
          ) : null}
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
            <Button disabled={mutation.isPending || !name.trim()} type="submit">
              {mutation.isPending ? "Creating…" : "Create role"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function numeric(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function titleCase(value: string) {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
