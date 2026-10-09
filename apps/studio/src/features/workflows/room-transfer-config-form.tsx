import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { WorkflowRoomContext } from "@beam-studio/shared";
import type { BeamEnvironmentTemplate } from "@beam-studio/shared";
import { useBeamEnvironmentSettings } from "@/features/settings/beam-environment-data";
import { configTemplate } from "@/lib/beam-environments";
import { FieldRow, NativeSelect, TextInput } from "./workflow-form-controls";
import { RoomRecipientPicker } from "./room-recipient-picker";
import {
  SearchableSelect,
  type SearchableSelectOption,
} from "./searchable-select";
import {
  fetchRecentRoomSourcePaths,
  fetchRoomWorkflowContext,
  fetchRoomWorkflowRooms,
  type RoomWorkflowSourceOption,
} from "./room-workflow-option-data";
import { roomSourcePathIssue } from "./room-source-path";
import { formatBytes } from "@/lib/format-bytes";
import { fetchStorageObjects } from "./workflow-storage-browser";
import type { JsonObject } from "./workflow-graph-types";

const ttlPresets = [600, 900, 3600, 21600, 86400];

export function RoomTransferConfigForm({
  config: savedConfig,
  workflowRoom,
  onChange,
}: {
  config: JsonObject;
  workflowRoom?: WorkflowRoomContext | null;
  onChange(config: JsonObject): void;
}) {
  const [useCallingRoom, setUseCallingRoom] = useState(
    () =>
      Boolean(savedConfig.channelId) &&
      !savedConfig.roomId &&
      !savedConfig.environmentTemplateKey,
  );
  const [previewRoom, setPreviewRoom] = useState<JsonObject>({});
  const [customTtlEditing, setCustomTtlEditing] = useState(
    () => !ttlPresets.includes(Number(savedConfig.ttlSeconds ?? 600)),
  );
  const config = useMemo(
    () =>
      workflowRoom
        ? { ...savedConfig, ...workflowRoom }
        : useCallingRoom
          ? { ...savedConfig, ...previewRoom }
          : savedConfig,
    [savedConfig, workflowRoom, useCallingRoom, previewRoom],
  );
  const roomConflict = Boolean(
    workflowRoom &&
    ((savedConfig.roomId && savedConfig.roomId !== workflowRoom.roomId) ||
      (savedConfig.environmentTemplateKey &&
        savedConfig.environmentTemplateKey !==
          workflowRoom.environmentTemplateKey)),
  );
  const settingsQuery = useBeamEnvironmentSettings();
  const settings = settingsQuery.data;
  const selectedTemplate = configTemplate(settings, config);
  const roomControlAvailable = selectedTemplate?.roomControlAvailable === true;
  // Installation-wide, so it is reported whichever Beam environment is picked.
  const roomTransferAction = settings?.roomTransferAction;
  const actionUnavailable = roomTransferAction?.available === false;
  const templateKey =
    selectedTemplate?.key ??
    String(
      config.environmentTemplateKey ?? settings?.defaultTemplateKey ?? "prod",
    );
  const roomId = String(config.roomId ?? "");
  const channelId = String(config.channelId ?? "");
  const source = objectValue(config.source);
  const locator = objectValue(source.locator);
  const sourceMemberId = String(source.memberId ?? "");
  const sourcePath =
    locator.type === "agent_path" ? String(locator.path ?? "") : "";
  const sourceObjectKey =
    locator.type === "bucket_object" ? String(locator.objectKey ?? "") : "";
  const targets = Array.isArray(config.targetMemberIds)
    ? config.targetMemberIds.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const [roomSearch, setRoomSearch] = useState("");
  const [objectPrefix, setObjectPrefix] = useState("");
  const deferredRoomSearch = useDeferredValue(roomSearch);
  const targetPatch = useCallback(
    (template: BeamEnvironmentTemplate | null) => ({
      environmentTemplateKey: template?.key ?? templateKey,
    }),
    [templateKey],
  );
  const patch = useCallback(
    (next: JsonObject) => {
      const updated: JsonObject = {
        ttlSeconds: 600,
        allowPartial: false,
        targetMemberIds: [],
        ...savedConfig,
        ...(workflowRoom ? {} : targetPatch(selectedTemplate)),
        ...next,
      };
      if (useCallingRoom && !workflowRoom) {
        setPreviewRoom({
          roomId: updated.roomId ?? previewRoom.roomId ?? "",
          environmentTemplateKey: updated.environmentTemplateKey ?? templateKey,
        });
        delete updated.roomId;
        delete updated.environmentTemplateKey;
      }
      onChange(updated);
    },
    [
      savedConfig,
      workflowRoom,
      onChange,
      selectedTemplate,
      targetPatch,
      useCallingRoom,
      previewRoom.roomId,
      templateKey,
    ],
  );

  const roomsQuery = useInfiniteQuery({
    queryKey: ["room-workflow-room-options", templateKey, deferredRoomSearch],
    queryFn: ({ pageParam }) =>
      fetchRoomWorkflowRooms(templateKey, deferredRoomSearch, pageParam),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: roomControlAvailable,
  });
  const contextQuery = useQuery({
    queryKey: ["room-workflow-context", templateKey, roomId],
    queryFn: () => fetchRoomWorkflowContext(templateKey, roomId),
    enabled: roomControlAvailable && Boolean(roomId),
  });
  const recentPathsQuery = useQuery({
    queryKey: ["room-workflow-recent-paths", templateKey, sourceMemberId],
    queryFn: () => fetchRecentRoomSourcePaths(templateKey, sourceMemberId),
    enabled:
      roomControlAvailable &&
      Boolean(sourceMemberId) &&
      locator.type === "agent_path",
  });
  const context = contextQuery.data;
  const rooms = useMemo(() => {
    const values = roomsQuery.data?.pages.flatMap((page) => page.items) ?? [];
    if (context?.room && !values.some((room) => room.id === context.room.id))
      return [context.room, ...values];
    if (roomId && !values.some((room) => room.id === roomId))
      return [{ id: roomId, name: roomId, state: "unknown" }, ...values];
    return values;
  }, [context?.room, roomId, roomsQuery.data]);
  const channels = context?.channels ?? [];
  const sources = useMemo(
    () =>
      (context?.sources ?? []).filter(
        (source) => !channelId || source.channelIds.includes(channelId),
      ),
    [channelId, context?.sources],
  );
  const selectedSource =
    sources.find((source) => source.id === sourceMemberId) ??
    context?.sources.find((source) => source.id === sourceMemberId);
  const pathIssue = roomSourcePathIssue(sourcePath, selectedSource?.platform);
  const sourceObjectsQuery = useQuery({
    queryKey: [
      "room-workflow-source-objects",
      selectedSource?.credentialId,
      selectedSource?.bucket,
      objectPrefix,
    ],
    queryFn: () =>
      fetchStorageObjects({
        credentialId: selectedSource!.credentialId!,
        bucket: selectedSource!.bucket!,
        prefix: objectPrefix,
      }),
    enabled:
      selectedSource?.kind === "object_storage" &&
      Boolean(selectedSource.credentialId && selectedSource.bucket),
  });

  const resetSource = {
    memberId: "",
    locator: { type: "agent_path", path: "" },
  };

  useEffect(() => {
    const onlyChannel = channels.length === 1 ? channels[0] : undefined;
    if (!channelId && onlyChannel)
      patch({
        channelId: onlyChannel.id,
        source: resetSource,
        targetMemberIds: [],
      });
  }, [channelId, channels, patch]);
  useEffect(() => {
    const onlySource = sources.length === 1 ? sources[0] : undefined;
    if (channelId && !sourceMemberId && onlySource)
      patch({
        source: sourceForOption(onlySource),
        targetMemberIds: [],
      });
  }, [channelId, patch, sourceMemberId, sources]);

  const roomOptions: SearchableSelectOption[] = rooms.map((room) => ({
    id: room.id,
    name: room.name,
    description: room.id,
  }));
  const channelOptions: SearchableSelectOption[] = channels.map((channel) => ({
    id: channel.id,
    name: channel.name,
    description: [channel.description, channel.id].filter(Boolean).join(" · "),
  }));
  const sourceOptions: SearchableSelectOption[] = sources.map((source) => ({
    id: source.id,
    name: source.name,
    description: [
      source.kind === "object_storage"
        ? "Object-storage bucket"
        : source.platform,
      source.id,
    ]
      .filter(Boolean)
      .join(" · "),
  }));
  const currentTtl = Number(config.ttlSeconds ?? 600);
  const ttlPreset =
    !customTtlEditing && ttlPresets.includes(currentTtl)
      ? String(currentTtl)
      : "custom";

  return (
    <div className="grid gap-4">
      {!workflowRoom && (
        <label className="rounded-control border p-3 text-sm">
          <input
            type="checkbox"
            className="mr-2"
            checked={useCallingRoom}
            onChange={(event) => {
              const enabled = event.target.checked;
              setUseCallingRoom(enabled);
              if (enabled) {
                setPreviewRoom({
                  roomId: savedConfig.roomId ?? "",
                  environmentTemplateKey:
                    savedConfig.environmentTemplateKey ?? templateKey,
                });
                const { roomId, environmentTemplateKey, ...rest } = savedConfig;
                onChange(rest);
              } else onChange({ ...savedConfig, ...previewRoom });
            }}
          />
          Use the calling workflow’s room
          {useCallingRoom && (
            <span className="mt-1 block text-xs text-muted-foreground">
              Choose a preview room below to configure its channel and members.
              The caller supplies the room at execution; this workflow requires
              an inherited room to run.
            </span>
          )}
        </label>
      )}
      {workflowRoom && (
        <p className="rounded-control border p-3 text-sm">
          Inherited workflow room: {workflowRoom.environmentTemplateKey} /{" "}
          {workflowRoom.roomId}
        </p>
      )}
      {roomConflict && (
        <div role="alert" className="text-sm text-destructive">
          The saved action room conflicts with the workflow room.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => {
              const { roomId, environmentTemplateKey, ...rest } = savedConfig;
              onChange(rest);
            }}
          >
            Use inherited room
          </button>
        </div>
      )}
      {!workflowRoom && settings?.devSettingsEnabled ? (
        <details className="rounded-control border bg-card/50 p-3">
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
            Beam environment
          </summary>
          <div className="mt-3">
            <FieldRow
              hint="Templates are defined in General Settings."
              label="Beam environment"
            >
              <SearchableSelect
                disabled={settingsQuery.isPending}
                options={(settings?.templates ?? []).map((template) => ({
                  id: template.key,
                  name: template.name,
                  disabled: !template.roomControlAvailable,
                }))}
                placeholder="Select Beam environment"
                value={templateKey}
                onChange={(key) => {
                  const nextTemplate =
                    settings?.templates.find(
                      (template) => template.key === key,
                    ) ?? null;
                  patch({
                    ...targetPatch(nextTemplate),
                    roomId: "",
                    channelId: "",
                    source: resetSource,
                    targetMemberIds: [],
                  });
                }}
              />
            </FieldRow>
          </div>
        </details>
      ) : null}
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
      {!roomControlAvailable && settingsQuery.isSuccess ? (
        <p
          role="alert"
          className="rounded-control border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          Room control is not configured for the selected Beam environment.
        </p>
      ) : null}

      <section className="grid gap-3 rounded-control border p-3">
        <div>
          <h3 className="text-sm font-semibold">1. Transfer source</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Choose the room, object channel, and eligible publishing member.
          </p>
        </div>
        <FieldRow label="Room">
          <SearchableSelect
            disabled={Boolean(workflowRoom) || !roomControlAvailable}
            hasMore={roomsQuery.hasNextPage}
            loading={roomsQuery.isFetching}
            options={roomOptions}
            placeholder="Select room"
            searchPlaceholder="Search rooms"
            value={roomId}
            onLoadMore={() => void roomsQuery.fetchNextPage()}
            onSearchChange={setRoomSearch}
            onChange={(value) =>
              patch({
                roomId: value,
                channelId: "",
                source: resetSource,
                targetMemberIds: [],
              })
            }
          />
        </FieldRow>
        {roomId ? (
          <FieldRow label="Object channel">
            <SearchableSelect
              disabled={!context || !roomControlAvailable}
              options={channelOptions}
              placeholder="Select active object channel"
              value={channelId}
              onChange={(value) =>
                patch({
                  channelId: value,
                  source: resetSource,
                  targetMemberIds: [],
                })
              }
            />
          </FieldRow>
        ) : null}
        {roomId && channelId ? (
          <FieldRow label="Source member">
            <SearchableSelect
              disabled={!context || !roomControlAvailable}
              emptyText="No eligible publishing member is eligible"
              options={sourceOptions}
              placeholder="Select eligible member"
              value={sourceMemberId}
              onChange={(value) => {
                const option = sources.find(
                  (candidate) => candidate.id === value,
                );
                patch({
                  source: option ? sourceForOption(option) : resetSource,
                  targetMemberIds: [],
                });
                setObjectPrefix("");
              }}
            />
          </FieldRow>
        ) : null}
        {sourceMemberId && selectedSource?.kind === "agent" ? (
          <FieldRow
            label="File path on source agent"
            hint="The path must be inside a root enrolled for room publishing. Studio does not browse the agent filesystem."
          >
            <div className="grid gap-2">
              <TextInput
                aria-invalid={Boolean(pathIssue)}
                value={sourcePath}
                onChange={(event) =>
                  patch({
                    source: {
                      memberId: sourceMemberId,
                      locator: { type: "agent_path", path: event.target.value },
                    },
                  })
                }
                placeholder={
                  /win/i.test(selectedSource?.platform ?? "")
                    ? "C:\\Transfers\\file.bin"
                    : "/srv/transfers/file.bin"
                }
              />
              {pathIssue ? (
                <span role="alert" className="text-xs text-destructive">
                  {pathIssue}
                </span>
              ) : null}
              {recentPathsQuery.data?.paths.length ? (
                <div className="flex flex-wrap gap-1">
                  {recentPathsQuery.data.paths.map((path) => (
                    <button
                      className="max-w-full truncate rounded-control border px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent"
                      key={path}
                      title={path}
                      type="button"
                      onClick={() =>
                        patch({
                          source: {
                            memberId: sourceMemberId,
                            locator: { type: "agent_path", path },
                          },
                        })
                      }
                    >
                      {path}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </FieldRow>
        ) : null}
        {sourceMemberId && selectedSource?.kind === "object_storage" ? (
          <FieldRow
            label="Object in source bucket"
            hint="Select an object through the existing storage browser. Its size and provider identity are frozen when the transfer begins."
          >
            <div className="grid gap-2">
              <TextInput
                value={sourceObjectKey}
                onChange={(event) =>
                  patch({
                    source: {
                      memberId: sourceMemberId,
                      locator: {
                        type: "bucket_object",
                        objectKey: event.target.value,
                      },
                    },
                  })
                }
                placeholder="path/to/file.bin"
              />
              <TextInput
                value={objectPrefix}
                onChange={(event) => setObjectPrefix(event.target.value)}
                placeholder="Browse prefix"
              />
              <div className="max-h-44 divide-y overflow-y-auto rounded-control border">
                {(sourceObjectsQuery.data?.objects ?? []).map((item) => (
                  <button
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent"
                    key={item.key}
                    type="button"
                    onClick={() =>
                      patch({
                        source: {
                          memberId: sourceMemberId,
                          locator: {
                            type: "bucket_object",
                            objectKey: item.key,
                          },
                        },
                      })
                    }
                  >
                    <span className="truncate">{item.key}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatBytes(item.size) ?? "Unknown size"}
                    </span>
                  </button>
                ))}
                {sourceObjectsQuery.isPending ? (
                  <p className="p-3 text-sm text-muted-foreground">
                    Loading objects…
                  </p>
                ) : null}
              </div>
            </div>
          </FieldRow>
        ) : null}
      </section>

      {roomId && channelId && sourceMemberId ? (
        <section className="grid gap-3 rounded-control border p-3">
          <div>
            <h3 className="text-sm font-semibold">2. Recipients</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Choose everyone eligible or an explicit set of room members.
            </p>
          </div>
          <RoomRecipientPicker
            key={`${templateKey}:${roomId}:${channelId}:${sourceMemberId}`}
            channelId={channelId}
            disabled={!roomControlAvailable}
            roles={context?.roles ?? []}
            roomId={roomId}
            sourceMemberId={sourceMemberId}
            targetMemberIds={targets}
            templateKey={templateKey}
            onChange={(targetMemberIds) => patch({ targetMemberIds })}
          />
          <p className="rounded-control border bg-muted/30 p-3 text-xs text-muted-foreground">
            Agent-only publications use room E2EE. If the source or any
            recipient is a bucket, all deliveries use TLS and Beam workers
            handle plaintext, including deliveries to agents. Bucket credentials
            stay in Studio. With Everyone eligible, this protection is frozen
            with the authorized recipient list when the transfer starts.
          </p>
        </section>
      ) : null}

      <details className="rounded-control border p-3">
        <summary className="cursor-pointer text-sm font-semibold">
          Advanced delivery settings
        </summary>
        <div className="mt-4 grid gap-4">
          <FieldRow label="Completion policy">
            <div className="grid grid-cols-2 gap-2">
              <label
                className={`rounded-control border p-3 text-sm ${config.allowPartial !== true ? "border-primary bg-primary/5" : ""}`}
              >
                <input
                  className="mr-2"
                  type="radio"
                  name="room-completion-policy"
                  checked={config.allowPartial !== true}
                  onChange={() => patch({ allowPartial: false })}
                />
                Strict completion
                <span className="mt-1 block text-xs text-muted-foreground">
                  Fail unless every frozen recipient completes.
                </span>
              </label>
              <label
                className={`rounded-control border p-3 text-sm ${config.allowPartial === true ? "border-primary bg-primary/5" : ""}`}
              >
                <input
                  className="mr-2"
                  type="radio"
                  name="room-completion-policy"
                  checked={config.allowPartial === true}
                  onChange={() => patch({ allowPartial: true })}
                />
                Partial delivery
                <span className="mt-1 block text-xs text-muted-foreground">
                  Complete when at least one recipient succeeds.
                </span>
              </label>
            </div>
          </FieldRow>
          <FieldRow label="Transfer lifetime">
            <div className="grid gap-2">
              <NativeSelect
                value={ttlPreset}
                onChange={(event) => {
                  if (event.target.value === "custom") {
                    setCustomTtlEditing(true);
                    return;
                  }
                  setCustomTtlEditing(false);
                  patch({ ttlSeconds: Number(event.target.value) });
                }}
              >
                <option value="600">10 minutes</option>
                <option value="900">15 minutes</option>
                <option value="3600">1 hour</option>
                <option value="21600">6 hours</option>
                <option value="86400">24 hours</option>
                <option value="custom">Custom</option>
              </NativeSelect>
              {ttlPreset === "custom" ? (
                <TextInput
                  type="number"
                  min={30}
                  max={86400}
                  value={String(currentTtl)}
                  onChange={(event) =>
                    patch({ ttlSeconds: Number(event.target.value) })
                  }
                />
              ) : null}
            </div>
          </FieldRow>
        </div>
      </details>

      {roomsQuery.error || contextQuery.error || recentPathsQuery.error ? (
        <p role="alert" className="text-sm text-destructive">
          {roomsQuery.error?.message ??
            contextQuery.error?.message ??
            recentPathsQuery.error?.message}
        </p>
      ) : null}
    </div>
  );
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function sourceForOption(source: RoomWorkflowSourceOption): JsonObject {
  return {
    memberId: source.id,
    locator:
      source.kind === "object_storage"
        ? { type: "bucket_object", objectKey: "" }
        : { type: "agent_path", path: "" },
  };
}
