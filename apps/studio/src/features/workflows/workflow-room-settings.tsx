import { useEffect, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { Users } from "lucide-react";
import { workflowRoomContext } from "@beam-studio/shared";
import { SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { useBeamEnvironmentSettings } from "@/features/settings/beam-environment-data";
import { apiSend } from "@/lib/api-client";
import { SearchableSelect } from "./searchable-select";
import { fetchRoomWorkflowRooms } from "./room-workflow-option-data";
import type { WorkflowBundle } from "./workflow-graph-types";

export function WorkflowRoomSettings({
  workflow,
}: {
  workflow: WorkflowBundle;
}) {
  const saved = workflow.template.room;
  const settings = useBeamEnvironmentSettings();
  const cache = useQueryClient();
  const [enabled, setEnabled] = useState(Boolean(saved));
  const [templateKey, setTemplateKey] = useState(
    saved?.environmentTemplateKey ?? "",
  );
  const [roomId, setRoomId] = useState(saved?.roomId ?? "");
  const [search, setSearch] = useState("");
  useEffect(() => {
    setEnabled(Boolean(saved));
    setTemplateKey(saved?.environmentTemplateKey ?? "");
    setRoomId(saved?.roomId ?? "");
  }, [workflow.template.id, saved?.environmentTemplateKey, saved?.roomId]);
  const rooms = useInfiniteQuery({
    queryKey: ["room-workflow-room-options", templateKey, search],
    queryFn: ({ pageParam }) =>
      fetchRoomWorkflowRooms(templateKey, search, pageParam),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: enabled && Boolean(templateKey),
  });
  const options =
    rooms.data?.pages
      .flatMap((page) => page.items)
      .map((room) => ({
        id: room.id,
        name: room.name,
        description: room.id,
      })) ?? [];
  if (roomId && !options.some((room) => room.id === roomId))
    options.unshift({ id: roomId, name: roomId, description: roomId });
  const save = useMutation({
    mutationFn: () =>
      apiSend<WorkflowBundle>(
        "PATCH",
        `/studio/workflows/${workflow.template.id}`,
        {
          room: enabled
            ? workflowRoomContext({
                environmentTemplateKey: templateKey,
                roomId,
              })
            : null,
        },
      ),
    onSuccess: (result) =>
      cache.setQueryData(["/studio/workflows", workflow.template.id], result),
  });
  return (
    <SettingsSection
      icon={Users}
      title="Shared room"
      description="Optionally apply one room to all actions and child workflows."
    >
      <div className="grid gap-4">
        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => {
              setEnabled(event.target.checked);
              save.reset();
            }}
          />
          Associate a room
        </label>
        {enabled && (
          <>
            <label className="grid gap-2 text-sm">
              Beam environment
              <SearchableSelect
                value={templateKey}
                options={(settings.data?.templates ?? []).map((template) => ({
                  id: template.key,
                  name: template.name,
                  disabled: !template.roomControlAvailable,
                }))}
                placeholder="Select Beam environment"
                onChange={(key) => {
                  setTemplateKey(key);
                  setRoomId("");
                  save.reset();
                }}
              />
            </label>
            <label className="grid gap-2 text-sm">
              Room
              <SearchableSelect
                value={roomId}
                options={options}
                placeholder="Select shared room"
                disabled={!templateKey}
                onSearchChange={setSearch}
                onChange={(id) => {
                  setRoomId(id);
                  save.reset();
                }}
                hasMore={rooms.hasNextPage}
                onLoadMore={() => void rooms.fetchNextPage()}
              />
            </label>
          </>
        )}
        <p className="text-xs text-muted-foreground">
          Without a workflow room, actions that need a room select their own. A
          parent workflow's room is inherited by every child. Conflicting saved
          associations must be corrected before saving or running.
        </p>
        {(save.error || rooms.error) && (
          <p role="alert" className="text-sm text-destructive">
            {save.error?.message ?? rooms.error?.message}
          </p>
        )}
        {save.isSuccess && (
          <p className="text-sm text-muted-foreground">
            Room association saved. Existing runs keep their frozen context.
          </p>
        )}
        <Button
          type="button"
          disabled={save.isPending || (enabled && (!templateKey || !roomId))}
          onClick={() => save.mutate()}
        >
          Save room
        </Button>
      </div>
    </SettingsSection>
  );
}
