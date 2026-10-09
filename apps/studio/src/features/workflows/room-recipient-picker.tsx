import { useDeferredValue, useState } from "react";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NativeSelect, TextInput } from "./workflow-form-controls";
import {
  fetchRoomWorkflowRecipients,
  resolveRoomWorkflowRecipients,
  type RecipientFilters,
  type RoomWorkflowRoleOption,
} from "./room-workflow-option-data";

const initialFilters: RecipientFilters = {
  query: "",
  roleId: "all",
  presence: "all",
  selectedOnly: false,
};

export function RoomRecipientPicker({
  channelId,
  disabled,
  onChange,
  roles,
  roomId,
  sourceMemberId,
  targetMemberIds,
  templateKey,
}: {
  channelId: string;
  disabled?: boolean;
  onChange(memberIds: string[]): void;
  roles: RoomWorkflowRoleOption[];
  roomId: string;
  sourceMemberId: string;
  targetMemberIds: string[];
  templateKey: string;
}) {
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState(initialFilters);
  const deferredQuery = useDeferredValue(filters.query);
  const specific = targetMemberIds.length > 0;
  const effectiveFilters = { ...filters, query: deferredQuery };
  const query = useInfiniteQuery({
    queryKey: [
      "room-workflow-recipients",
      templateKey,
      roomId,
      channelId,
      sourceMemberId,
      effectiveFilters,
      targetMemberIds,
    ],
    queryFn: ({ pageParam }) =>
      fetchRoomWorkflowRecipients({
        templateKey,
        roomId,
        channelId,
        sourceMemberId,
        selectedMemberIds: targetMemberIds,
        filters: effectiveFilters,
        cursor: pageParam,
      }),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: open && Boolean(roomId && channelId && sourceMemberId),
  });
  const recipients = query.data?.pages.flatMap((page) => page.items) ?? [];
  const summary = query.data?.pages[0];
  const resolve = useMutation({
    mutationFn: async () => {
      const result = await resolveRoomWorkflowRecipients({
        templateKey,
        roomId,
        channelId,
        sourceMemberId,
        filters: {
          query: deferredQuery,
          roleId: filters.roleId,
          presence: filters.presence,
        },
      });
      if (!result.memberIds.length) {
        throw new Error("No eligible members match the current filters.");
      }
      return result;
    },
    onSuccess: ({ memberIds }) => onChange(memberIds),
  });
  const selected = new Set(targetMemberIds);
  const updateFilter = (patch: Partial<RecipientFilters>) =>
    setFilters((current) => ({ ...current, ...patch }));

  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-2 gap-2">
        <button
          className={`rounded-control border p-3 text-left text-sm ${!specific ? "border-primary bg-primary/5" : "bg-background"}`}
          disabled={disabled}
          type="button"
          onClick={() => onChange([])}
        >
          <span className="block font-medium">Everyone eligible</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            Resolved and frozen when execution begins.
          </span>
        </button>
        <button
          className={`rounded-control border p-3 text-left text-sm ${specific ? "border-primary bg-primary/5" : "bg-background"}`}
          disabled={disabled}
          type="button"
          onClick={() => setOpen(true)}
        >
          <span className="block font-medium">Specific members</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {specific
              ? `${targetMemberIds.length.toLocaleString()} selected`
              : "Search and select recipients"}
          </span>
        </button>
      </div>
      {specific ? (
        <Button
          className="justify-self-start"
          size="sm"
          variant="outline"
          type="button"
          onClick={() => setOpen(true)}
        >
          Edit recipients
        </Button>
      ) : null}
      <p className="text-xs leading-5 text-muted-foreground">
        Eligibility comes from the room, active object channel, membership, and
        grants. Studio does not impose a recipient count limit.
      </p>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Select recipients</DialogTitle>
            <DialogDescription>
              Search eligible members or filter by role and presence. Selections
              remain visible if authorization later changes.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
            <TextInput
              className="sm:col-span-2"
              placeholder="Search members"
              value={filters.query}
              onChange={(event) => updateFilter({ query: event.target.value })}
            />
            <NativeSelect
              value={filters.roleId}
              onChange={(event) => updateFilter({ roleId: event.target.value })}
            >
              <option value="all">All roles</option>
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              value={filters.presence}
              onChange={(event) =>
                updateFilter({ presence: event.target.value })
              }
            >
              <option value="all">Any presence</option>
              <option value="online">Online</option>
              <option value="offline">Offline</option>
              <option value="unknown">Unknown</option>
            </NativeSelect>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-y py-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={filters.selectedOnly}
                onChange={(event) =>
                  updateFilter({ selectedOnly: event.target.checked })
                }
              />
              Selected only
            </label>
            <span className="text-muted-foreground">
              {targetMemberIds.length.toLocaleString()} selected
              {summary ? ` · ${summary.total.toLocaleString()} matching` : ""}
            </span>
            <div className="flex gap-2">
              <Button
                disabled={
                  resolve.isPending ||
                  filters.selectedOnly ||
                  summary?.total === 0
                }
                size="sm"
                variant="outline"
                type="button"
                onClick={() => resolve.mutate()}
              >
                Select all matching
              </Button>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() => {
                  onChange([]);
                  setFilters((current) => ({
                    ...current,
                    selectedOnly: false,
                  }));
                  setOpen(false);
                }}
              >
                Clear all · Everyone eligible
              </Button>
            </div>
          </div>
          {summary?.ineligibleSelectedCount ? (
            <p role="alert" className="text-sm text-destructive">
              {summary.ineligibleSelectedCount.toLocaleString()} selected
              member(s) are no longer eligible. Remove them before saving or
              running the workflow.
            </p>
          ) : null}
          <div className="min-h-48 flex-1 overflow-auto rounded-control border">
            {recipients.map((recipient) => (
              <label
                className="flex items-start gap-3 border-b px-3 py-2 text-sm last:border-b-0"
                key={recipient.memberId}
              >
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={selected.has(recipient.memberId)}
                  disabled={
                    !recipient.eligible && !selected.has(recipient.memberId)
                  }
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...targetMemberIds, recipient.memberId]
                        : targetMemberIds.filter(
                            (id) => id !== recipient.memberId,
                          ),
                    )
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {recipient.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {recipient.roleNames.join(", ") || "No role"} ·{" "}
                    {recipient.presence} · {recipient.memberId}
                  </span>
                  {!recipient.eligible ? (
                    <span className="block text-xs text-destructive">
                      {recipient.unavailableReason}
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
            {!recipients.length && !query.isPending ? (
              <p className="p-8 text-center text-sm text-muted-foreground">
                No matching recipients.
              </p>
            ) : null}
            {query.isPending ? (
              <p className="p-8 text-center text-sm text-muted-foreground">
                Loading recipients…
              </p>
            ) : null}
          </div>
          {query.hasNextPage ? (
            <Button
              disabled={query.isFetchingNextPage}
              variant="outline"
              type="button"
              onClick={() => void query.fetchNextPage()}
            >
              Load more
            </Button>
          ) : null}
          {query.error || resolve.error ? (
            <p role="alert" className="text-sm text-destructive">
              {query.error?.message ?? resolve.error?.message}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button type="button" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
