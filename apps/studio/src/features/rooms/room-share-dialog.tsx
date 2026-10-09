import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Check,
  Clock3,
  Copy,
  KeyRound,
  LoaderCircle,
  Network,
  Share2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, type ButtonProps } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { beamCliBinary, isDevRoomTemplate } from "@/lib/beam-environments";
import { roomActionUnavailableReason } from "@/lib/room-access";
import { record, runRoomCommand, text, type RoomSnapshot } from "./room-data";
import { roomErrorMessage } from "./room-hooks";

const defaultInvitationUses = 200;
const maxInvitationUses = 512;
const defaultInvitationTTLSeconds = 60 * 60;
const channelActions = [
  "discover",
  "publish",
  "subscribe",
  "manage",
  "request",
  "respond",
  "observe",
] as const;

export const RoomShareTrigger = forwardRef<
  HTMLButtonElement,
  ButtonProps & { room: RoomSnapshot }
>(({ disabled, room, ...props }, ref) => {
  const reason = roomActionUnavailableReason(room);
  // The reason rides on the button itself rather than a wrapper: this trigger
  // is rendered through DialogTrigger asChild, and an enabled wrapper element
  // would take the click the disabled button is meant to refuse.
  return (
    <Button
      {...props}
      disabled={disabled || reason !== null}
      ref={ref}
      size="sm"
      title={reason ?? props.title}
      type="button"
    >
      <Share2 className="size-4" />
      Share room
      {reason ? <span className="sr-only">{reason}</span> : null}
    </Button>
  );
});
RoomShareTrigger.displayName = "RoomShareTrigger";

export function RoomShareDialog({
  room,
  trigger,
}: {
  room: RoomSnapshot;
  trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [maxUses, setMaxUses] = useState(defaultInvitationUses);
  const [ttlSeconds, setTTLSeconds] = useState(defaultInvitationTTLSeconds);
  const [roleId, setRoleId] = useState(
    () =>
      text(
        room.roles.find((role) => text(role.template) === "member")?.role_id,
      ) ??
      text(
        room.roles.find((role) => text(role.template) !== "owner")?.role_id,
      ) ??
      "",
  );
  const roleIds = roleId ? [roleId] : [];
  const [channelAccess, setChannelAccess] = useState<Record<string, string[]>>(
    {},
  );
  const invitationMutation = useMutation({
    mutationFn: async () => {
      const requestedMaxUses = maxUses;
      const requestedTTLSeconds = ttlSeconds;
      const command = await runRoomCommand(
        room.agent?.id ?? null,
        "room.invitation.create",
        {
          room_id: room.id,
          max_uses: requestedMaxUses,
          ttl_seconds: requestedTTLSeconds,
          role_ids: roleIds,
          channel_access: Object.entries(channelAccess)
            .filter(([, actions]) => actions.length)
            .map(([channelId, actions]) => ({
              channel_id: channelId,
              actions,
            })),
        },
      );
      const result = record(command.result?.invitation);
      const token = text(result.invitation_token);
      if (!token)
        throw new Error("The Coordinator did not return an invitation token.");
      return {
        clipboardCommand: roomJoinCommand(room.id, token),
        displayedCommand: roomJoinCommand(room.id, "[REDACTED]"),
        expiresAt: text(record(result.invitation).expires_at),
        maxUses: requestedMaxUses,
        roleCount: roleIds.length,
        channelCount: Object.values(channelAccess).filter(
          (actions) => actions.length,
        ).length,
      };
    },
  });

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) return;
    setCopied(false);
    invitationMutation.reset();
  }

  async function copyCommand() {
    if (!invitationMutation.data) return;
    await copyText(invitationMutation.data.clipboardCommand);
    setCopied(true);
  }

  function changeRole(nextRoleId: string) {
    setRoleId(nextRoleId);
    setChannelAccess((current) => {
      const next: Record<string, string[]> = {};
      for (const [channelId, actions] of Object.entries(current)) {
        const included = roleGrantedActions(room, nextRoleId, channelId);
        const additionalActions = actions.filter(
          (action) => !included.has(action),
        );
        if (additionalActions.length) next[channelId] = additionalActions;
      }
      return next;
    });
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90svh] w-[min(1200px,calc(100vw-32px))] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Share this room</DialogTitle>
          <DialogDescription>
            Create an invitation and copy the command a Beam agent can run to
            join this room. Joining does not require a Beam account.
          </DialogDescription>
        </DialogHeader>

        {invitationMutation.data ? (
          <div className="grid gap-4 pt-2">
            <div className="grid gap-2">
              <label
                className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground"
                htmlFor="room-share-command"
              >
                Join command
              </label>
              <textarea
                className="min-h-28 resize-none rounded-control border bg-muted/30 p-3 font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                id="room-share-command"
                readOnly
                spellCheck={false}
                value={invitationMutation.data.displayedCommand}
              />
              {isDevRoomTemplate() ? (
                <p className="text-xs leading-5 text-muted-foreground">
                  This room lives on the development coordinator, so the command
                  names the development CLI. The recipient needs{" "}
                  <code className="font-mono">beam-dev</code> installed; the
                  production <code className="font-mono">beam</code> binary
                  cannot find this room.
                </p>
              ) : null}
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              This command contains a shared bearer invitation. It can admit up
              to {invitationMutation.data.maxUses} agents and expires
              {invitationMutation.data.expiresAt
                ? ` (${new Date(invitationMutation.data.expiresAt).toLocaleString()})`
                : ""}
              . Anyone with the command can use one admission, so share it only
              with the intended group. Each admission creates a distinct machine
              identity.
            </p>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">
                {invitationMutation.data.roleCount} role
                {invitationMutation.data.roleCount === 1 ? "" : "s"}
              </Badge>
              <Badge variant="secondary">
                {invitationMutation.data.channelCount} channel
                {invitationMutation.data.channelCount === 1 ? "" : "s"}
              </Badge>
            </div>
            <div className="flex justify-end">
              <Button onClick={() => void copyCommand()} type="button">
                {copied ? (
                  <Check className="size-4" />
                ) : (
                  <Copy className="size-4" />
                )}
                {copied ? "Copied" : "Copy command"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 pt-2">
            <div className="grid items-start gap-4 lg:grid-cols-3">
              <section className="overflow-hidden rounded-surface border">
                <div className="flex items-center gap-3 border-b bg-muted/20 px-4 py-3">
                  <Clock3 className="size-4 text-primary" />
                  <div>
                    <h3 className="text-sm font-medium">Invitation limits</h3>
                    <p className="text-xs text-muted-foreground">
                      Limit admissions and invitation lifetime.
                    </p>
                  </div>
                </div>
                <div className="grid gap-4 p-4">
                  <label className="grid gap-2 text-sm font-medium">
                    Maximum joins
                    <input
                      className="h-10 rounded-control border bg-background px-3 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      disabled={invitationMutation.isPending}
                      max={maxInvitationUses}
                      min={1}
                      onChange={(event) =>
                        setMaxUses(Number(event.target.value))
                      }
                      type="number"
                      value={maxUses}
                    />
                  </label>
                  <label className="grid gap-2 text-sm font-medium">
                    Expires after
                    <select
                      className="h-10 rounded-control border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      disabled={invitationMutation.isPending}
                      onChange={(event) =>
                        setTTLSeconds(Number(event.target.value))
                      }
                      value={ttlSeconds}
                    >
                      <option value={15 * 60}>15 minutes</option>
                      <option value={60 * 60}>1 hour</option>
                      <option value={6 * 60 * 60}>6 hours</option>
                      <option value={24 * 60 * 60}>24 hours</option>
                    </select>
                  </label>
                </div>
              </section>
              <InvitationRoleSelector
                roleId={roleId}
                room={room}
                onChange={changeRole}
              />
              <InvitationChannelSelector
                access={channelAccess}
                roleId={roleId}
                room={room}
                onChange={setChannelAccess}
              />
            </div>
            <div className="rounded-control border border-amber-500/30 bg-amber-500/10 p-3 text-sm leading-6 text-amber-800 dark:text-amber-300">
              This is a bearer invitation. Share it only with the intended
              participant or group and never commit it to source control.
            </div>
            {invitationMutation.error ? (
              <p className="rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {roomErrorMessage(invitationMutation.error)}
              </p>
            ) : null}
            <div className="flex justify-end">
              <Button
                disabled={
                  invitationMutation.isPending ||
                  !roleId ||
                  maxUses < 1 ||
                  maxUses > maxInvitationUses
                }
                onClick={() => invitationMutation.mutate()}
                type="button"
              >
                {invitationMutation.isPending ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Share2 className="size-4" />
                )}
                {invitationMutation.isPending
                  ? "Creating invitation…"
                  : "Create join command"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function InvitationRoleSelector({
  onChange,
  roleId,
  room,
}: {
  onChange(roleId: string): void;
  roleId: string;
  room: RoomSnapshot;
}) {
  const roles = room.roles.filter(
    (role) => text(role.template) !== "owner" && text(role.role_id),
  );
  return (
    <section className="overflow-hidden rounded-surface border">
      <div className="flex items-center gap-3 border-b bg-muted/20 px-4 py-3">
        <KeyRound className="size-4 text-primary" />
        <div>
          <h3 className="text-sm font-medium">Role granted on join</h3>
          <p className="text-xs text-muted-foreground">
            Every agent using this code receives this room role.
          </p>
        </div>
      </div>
      <div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-1">
        {roles.map((role) => {
          const candidateRoleId = text(role.role_id)!;
          const name = text(role.name) ?? candidateRoleId;
          return (
            <label
              className="flex items-start gap-3 rounded-control border bg-background p-3 text-sm"
              key={candidateRoleId}
            >
              <input
                checked={candidateRoleId === roleId}
                className="mt-0.5"
                name={`room-share-role-${room.id}`}
                onChange={() => onChange(candidateRoleId)}
                type="radio"
              />
              <span className="min-w-0">
                <span className="block truncate font-medium">{name}</span>
                <span className="block truncate font-mono text-xs text-muted-foreground">
                  {text(role.template) ?? "custom"}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </section>
  );
}

function InvitationChannelSelector({
  access,
  onChange,
  roleId,
  room,
}: {
  access: Record<string, string[]>;
  onChange(access: Record<string, string[]>): void;
  roleId: string;
  room: RoomSnapshot;
}) {
  const channels = room.channels.filter(
    (channel) => text(channel.state) !== "closed" && text(channel.channel_id),
  );
  const selectableActionsByChannel = new Map(
    channels.map((channel) => {
      const channelId = text(channel.channel_id)!;
      const included = roleGrantedActions(room, roleId, channelId);
      return [
        channelId,
        channelActions.filter((action) => !included.has(action)),
      ] as const;
    }),
  );
  const hasSelectableChannelPermissions = [...selectableActionsByChannel].some(
    ([, actions]) => actions.length > 0,
  );
  const allChannelsSelected =
    hasSelectableChannelPermissions &&
    [...selectableActionsByChannel].every(([channelId, actions]) =>
      actions.every((action) => (access[channelId] ?? []).includes(action)),
    );
  const someChannelsSelected = channels.some((channel) => {
    const channelId = text(channel.channel_id)!;
    return (access[channelId] ?? []).length > 0;
  });

  function toggleAllChannels(checked: boolean) {
    const nextAccess = { ...access };
    for (const channel of channels) {
      const channelId = text(channel.channel_id)!;
      const selectableActions = selectableActionsByChannel.get(channelId) ?? [];
      if (checked && selectableActions.length) {
        nextAccess[channelId] = [...selectableActions];
      } else delete nextAccess[channelId];
    }
    onChange(nextAccess);
  }

  return (
    <section className="overflow-hidden rounded-surface border">
      <div className="flex items-center gap-3 border-b bg-muted/20 px-4 py-3">
        <Network className="size-4 text-primary" />
        <div>
          <h3 className="text-sm font-medium">Channel permissions</h3>
          <p className="text-xs text-muted-foreground">
            Direct member grants applied automatically during the join.
          </p>
        </div>
      </div>
      {channels.length ? (
        <>
          <label className="flex items-center gap-2 border-b bg-muted/10 px-4 py-3 text-sm font-medium">
            <SelectionCheckbox
              checked={allChannelsSelected}
              disabled={!hasSelectableChannelPermissions}
              indeterminate={someChannelsSelected && !allChannelsSelected}
              onChange={toggleAllChannels}
            />
            All channels
          </label>
          <div className="divide-y">
            {channels.map((channel) => {
              const channelId = text(channel.channel_id)!;
              const selected = access[channelId] ?? [];
              const included = roleGrantedActions(room, roleId, channelId);
              const selectableActions =
                selectableActionsByChannel.get(channelId) ?? [];
              const allActionsSelected =
                selectableActions.length > 0 &&
                selectableActions.every((action) => selected.includes(action));
              const effectiveActionCount = channelActions.filter(
                (action) => included.has(action) || selected.includes(action),
              ).length;
              return (
                <div className="grid gap-3 p-4" key={channelId}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {text(channel.name) ?? channelId}
                      </p>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {text(channel.kind) ?? "channel"}
                      </p>
                    </div>
                    {effectiveActionCount ? (
                      <Badge variant="secondary">
                        {effectiveActionCount} actions
                      </Badge>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    <label className="flex items-center gap-1.5 text-xs font-medium">
                      <SelectionCheckbox
                        checked={allActionsSelected}
                        disabled={!selectableActions.length}
                        indeterminate={
                          selected.length > 0 && !allActionsSelected
                        }
                        onChange={(checked) =>
                          onChange({
                            ...access,
                            [channelId]: checked ? [...selectableActions] : [],
                          })
                        }
                      />
                      All
                    </label>
                    {channelActions.map((action) => {
                      const includedWithRole = included.has(action);
                      return (
                        <label
                          className={`flex items-center gap-1.5 text-xs${includedWithRole ? " text-muted-foreground" : ""}`}
                          key={action}
                          title={
                            includedWithRole
                              ? "Included with the selected role"
                              : undefined
                          }
                        >
                          <input
                            checked={
                              includedWithRole || selected.includes(action)
                            }
                            disabled={includedWithRole}
                            onChange={(event) => {
                              const actions = event.target.checked
                                ? [...selected, action]
                                : selected.filter(
                                    (candidate) => candidate !== action,
                                  );
                              onChange({ ...access, [channelId]: actions });
                            }}
                            type="checkbox"
                          />
                          {action}
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          No active channel is available for this invitation.
        </p>
      )}
    </section>
  );
}

function SelectionCheckbox({
  checked,
  disabled = false,
  indeterminate,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  indeterminate: boolean;
  onChange(checked: boolean): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
      ref={inputRef}
      type="checkbox"
    />
  );
}

function roleGrantedActions(
  room: RoomSnapshot,
  roleId: string,
  channelId: string,
) {
  const actions = new Set<string>();
  for (const grant of room.grants) {
    if (
      text(grant.subject_type) !== "role" ||
      text(grant.subject_id) !== roleId ||
      text(grant.channel_id) !== channelId ||
      (text(grant.state) ?? "active") !== "active" ||
      !Array.isArray(grant.actions)
    ) {
      continue;
    }
    for (const action of grant.actions) actions.add(String(action));
  }
  return actions;
}

function roomJoinCommand(roomId: string, invitationToken: string) {
  // `beam room join` is canonical. The older `tunnel` namespace is only a
  // compatibility alias kept for existing scripts, so a freshly generated
  // command must not spread the deprecated form to everyone it is shared with.
  return `${beamCliBinary()} room join ${shellQuote(roomId)} --invitation-token ${shellQuote(invitationToken)}`;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function copyText(value: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    /* Fall through for HTTP development origins. */
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("clipboard unavailable");
}
