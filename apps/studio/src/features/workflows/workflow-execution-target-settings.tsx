import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  actionTargetPlacement,
  type ActionExecutionTarget,
} from "@beam-studio/shared";
import { apiGet } from "@/lib/api-client";
import { useBeamEnvironmentSettings } from "@/features/settings/beam-environment-data";
import { FieldRow, NativeSelect, TextInput } from "./workflow-form-controls";
import { studioEnv } from "@/lib/env";
import { SearchableSelect } from "./searchable-select";
import { fetchRoomWorkflowRooms } from "./room-workflow-option-data";
import type { WorkflowNodeData } from "./workflow-graph-types";

type Options = {
  members: Array<{
    id: string;
    name: string;
    capable: boolean;
    status: string;
  }>;
  channels: Array<{ id: string; name: string }>;
  artifactChannels: Array<{ id: string; name: string }>;
};
export function WorkflowExecutionTargetSettings({
  data,
  onChange,
}: {
  data: WorkflowNodeData;
  onChange(patch: Partial<WorkflowNodeData>): void;
}) {
  const target = data.executionTarget ?? { kind: "studio" };
  const [search, setSearch] = useState("");
  const environment = useBeamEnvironmentSettings();
  const room =
    data.workflowRoom ??
    (target.kind === "room-member" ? target.room : undefined);
  const rooms = useInfiniteQuery({
    queryKey: ["executor-room-options", room?.environmentTemplateKey, search],
    queryFn: ({ pageParam }) =>
      fetchRoomWorkflowRooms(room!.environmentTemplateKey, search, pageParam),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled:
      target.kind === "room-member" &&
      !data.workflowRoom &&
      Boolean(room?.environmentTemplateKey),
  });
  const options = useQuery({
    queryKey: [
      "workflow-executor-options",
      room?.environmentTemplateKey,
      room?.roomId,
    ],
    queryFn: () =>
      apiGet<Options>(
        `/studio/workflow-executor-options?environmentTemplateKey=${encodeURIComponent(room!.environmentTemplateKey)}&roomId=${encodeURIComponent(room!.roomId)}`,
      ),
    enabled:
      target.kind === "room-member" &&
      Boolean(room?.environmentTemplateKey && room?.roomId),
  });
  const set = (executionTarget: ActionExecutionTarget) =>
    onChange({
      executionTarget,
      placement: actionTargetPlacement(executionTarget),
      executionLocationId:
        executionTarget.kind === "remote-transport"
          ? (executionTarget.executionLocationId ?? null)
          : null,
    });
  const manifest = data.action?.manifest ?? data.manifest ?? {};
  const runtime = manifest.runtime as { placements?: string[] } | undefined;
  const execution = manifest.execution as
    | { supportedPlacements?: string[] }
    | undefined;
  const placements =
    execution?.supportedPlacements ?? runtime?.placements ?? [];
  return (
    <div className="grid gap-4">
      <FieldRow
        label="Execution target"
        hint="Select where this action computes. Room recipients are configured separately."
      >
        <NativeSelect
          value={target.kind}
          onChange={(event) => {
            if (event.target.value === "studio") set({ kind: "studio" });
            if (event.target.value === "room-member")
              set({
                kind: "room-member",
                memberIds: [],
                channelId: "",
                artifactChannelId: undefined,
                requesterMemberId: "",
              });
            if (event.target.value === "remote-transport")
              set({ kind: "remote-transport" });
          }}
        >
          <option
            value="studio"
            disabled={!placements.includes("local-workers")}
          >
            Studio Action Runner
          </option>
          <option
            value="room-member"
            disabled={!placements.includes("room-members")}
          >
            Capable room member
          </option>
          {(target.kind === "remote-transport" ||
            placements.includes("beamcore-public") ||
            placements.includes("custom")) && (
            <option value="remote-transport">Remote transport (opt-in)</option>
          )}
          <option value="external-worker" disabled>
            External worker (not available)
          </option>
        </NativeSelect>
      </FieldRow>
      {target.kind === "room-member" && (
        <>
          {data.workflowRoom ? (
            <p className="text-xs text-muted-foreground">
              Inherited room: {data.workflowRoom.environmentTemplateKey} /{" "}
              {data.workflowRoom.roomId}
            </p>
          ) : (
            <>
              <FieldRow label="Beam environment">
                <SearchableSelect
                  value={room?.environmentTemplateKey ?? ""}
                  options={(environment.data?.templates ?? []).map((item) => ({
                    id: item.key,
                    name: item.name,
                    disabled: !item.roomControlAvailable,
                  }))}
                  placeholder="Select environment"
                  onChange={(key) =>
                    set({
                      ...target,
                      room: { environmentTemplateKey: key, roomId: "" },
                      memberIds: [],
                      channelId: "",
                      artifactChannelId: undefined,
                      requesterMemberId: "",
                    })
                  }
                />
              </FieldRow>
              <FieldRow label="Action room">
                <SearchableSelect
                  value={room?.roomId ?? ""}
                  options={(
                    rooms.data?.pages.flatMap((page) => page.items) ?? []
                  ).map((item) => ({ id: item.id, name: item.name }))}
                  placeholder="Select this action’s room"
                  onSearchChange={setSearch}
                  onChange={(roomId) =>
                    set({
                      ...target,
                      room: {
                        environmentTemplateKey:
                          room?.environmentTemplateKey ?? "",
                        roomId,
                      },
                      memberIds: [],
                      channelId: "",
                      artifactChannelId: undefined,
                      requesterMemberId: "",
                    })
                  }
                  hasMore={rooms.hasNextPage}
                  onLoadMore={() => void rooms.fetchNextPage()}
                />
              </FieldRow>
            </>
          )}
          <FieldRow label="Request/reply channel">
            <SearchableSelect
              value={target.channelId}
              options={options.data?.channels ?? []}
              placeholder="Select execution channel"
              onChange={(channelId) => set({ ...target, channelId })}
            />
          </FieldRow>
          {studioEnv.roomWorkflowsEnabled || target.artifactChannelId ? (
            <FieldRow
              label="Artifact object channel"
              hint="V3 routed action artifacts use this object channel. Executors need publish access and recipients need subscribe access."
            >
              <SearchableSelect
                value={target.artifactChannelId ?? ""}
                options={options.data?.artifactChannels ?? []}
                placeholder="Select object channel"
                onChange={(artifactChannelId) =>
                  set({ ...target, artifactChannelId })
                }
              />
            </FieldRow>
          ) : null}
          <FieldRow label="Requesting member">
            <SearchableSelect
              value={target.requesterMemberId}
              options={options.data?.members ?? []}
              placeholder="Select requesting member"
              onChange={(requesterMemberId) =>
                set({ ...target, requesterMemberId })
              }
            />
          </FieldRow>
          <FieldRow
            label="Permitted executors"
            hint="Only opted-in managed members can execute. Current grants, runtime compatibility and capacity are checked at dispatch."
          >
            <div className="grid gap-2">
              {options.data?.members.map((member) => (
                <label key={member.id} className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    disabled={!member.capable}
                    checked={target.memberIds.includes(member.id)}
                    onChange={(event) =>
                      set({
                        ...target,
                        memberIds: event.target.checked
                          ? [...target.memberIds, member.id]
                          : target.memberIds.filter((id) => id !== member.id),
                      })
                    }
                  />
                  {member.name} —{" "}
                  {member.capable ? member.status : "execution not enabled"}
                </label>
              ))}
            </div>
          </FieldRow>
          {(options.error || rooms.error) && (
            <p role="alert" className="text-sm text-destructive">
              {options.error?.message ?? rooms.error?.message}
            </p>
          )}
        </>
      )}
      {target.kind === "remote-transport" && (
        <FieldRow
          label="Execution location"
          hint="Leave empty for the existing public Beam transport. Remote transport must be enabled by the deployment."
        >
          <TextInput
            value={target.executionLocationId ?? ""}
            onChange={(event) =>
              set({
                kind: "remote-transport",
                ...(event.target.value
                  ? { executionLocationId: event.target.value }
                  : {}),
              })
            }
          />
        </FieldRow>
      )}
    </div>
  );
}
