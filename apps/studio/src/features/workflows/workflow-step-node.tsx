import {
  WORKFLOW_NODE_HANDLE_Y,
  WORKFLOW_NODE_HEADER_HEIGHT,
} from "./workflow-node-geometry";
import { useEffect, useRef, useState, type ReactElement } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  Archive,
  ArrowRightLeft,
  Box,
  Braces,
  Clock3,
  Database,
  Download,
  GitBranch,
  Merge,
  Network,
  Package,
  Plus,
  ShieldCheck,
  Upload,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import {
  getProviderProfile,
  nativeProviderDisplay,
} from "@beam-studio/shared";
import { cn } from "@/lib/utils";
import {
  BEAM_TRANSFER_DESTINATION_HANDLE,
  BEAM_TRANSFER_SOURCE_HANDLE,
  FAN_OUT_ACTION,
  JOIN_ACTION,
  WORKFLOW_INPUT_HANDLE,
  WORKFLOW_OUTPUT_HANDLE,
  isControlFlowAction,
} from "./workflow-graph-constants";
import {
  workflowNodeCardClassName,
  WorkflowNodeHeader,
  WorkflowNodeStatus,
} from "./workflow-node-card";
import { waitDurationSummary } from "./workflow-action-summary";
import { formatBytes } from "@/lib/format-bytes";
import type { JsonObject, WorkflowNodeData } from "./workflow-graph-types";

export function WorkflowStepNode({
  data,
  selected,
}: NodeProps<Node<WorkflowNodeData, "workflowStep">>) {
  const manifest = data.action?.manifest ?? data.manifest ?? {};
  const catalog = manifest.catalog as JsonObject | undefined;
  if (isControlFlowAction(data.actionPackageName)) {
    return (
      <WorkflowControlFlowNode
        catalog={catalog}
        data={data}
        manifest={manifest}
        selected={selected}
      />
    );
  }
  // The operator's label wins over the action package, so a canvas of five
  // transfers is readable and so ${steps.x.name} says something meaningful.
  const displayName = String(
    data.name?.trim() ||
      manifest.displayName ||
      (data.kind === "workflow"
        ? "Workflow call"
        : humanizeActionName(data.actionPackageName)),
  );
  const Icon = actionIcon(data.actionPackageName);
  // A first-party integration action IS the service, so its mark comes from the
  // action itself and shows before anything is configured. The bound
  // credential is the fallback, which covers a generic action pointed at a
  // provider, and the Lucide glyph is the last resort.
  const credentialLogo =
    nativeProviderLogo(actionProviderId(data.actionPackageName) ?? "") ??
    (data.credentialProvider
      ? nativeProviderLogo(data.credentialProvider)
      : undefined);
  const summary =
    data.kind === "workflow"
      ? "Workflow call · public output"
      : stepSummary(data);

  if (data.definition.presentation === "resource") {
    return <ObjectStorageEndpointNode data={data} selected={selected} />;
  }

  if (data.definition.presentation === "composite") {
    return (
      <BeamTransferStepNode
        data={data}
        displayName={displayName}
        selected={selected}
        summary={summary}
      />
    );
  }

  return (
    <StepConfigPreview config={data.config}>
      <div
        aria-label={`${displayName}. ${summary}. Double-click to configure.`}
        className="group relative w-[292px]"
        role="button"
        title={`${displayName} — double-click to configure`}
      >
        <Handle
          id={portId(data, "input", "workflow-in")}
          className={nodeHandleClass(selected)}
          position={Position.Left}
          style={{ top: WORKFLOW_NODE_HANDLE_Y }}
          type="target"
        />
        <Handle
          id={portId(data, "output", "workflow-out")}
          className={nodeHandleClass(selected)}
          position={Position.Right}
          style={{ top: WORKFLOW_NODE_HANDLE_Y }}
          type="source"
        />
        <div className={workflowNodeCardClassName(data, selected)}>
          <WorkflowNodeHeader
            displayName={displayName}
            summary={summary}
            icon={
              credentialLogo ? (
                <ProviderLogo
                  name={displayName}
                  provider={data.credentialProvider ?? ""}
                  src={credentialLogo}
                />
              ) : (
                <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
              )
            }
          />
          <WorkflowNodeStatus data={data} />
        </div>
      </div>
    </StepConfigPreview>
  );
}

function BeamTransferStepNode({
  data,
  displayName,
  selected,
  summary,
}: {
  data: WorkflowNodeData;
  displayName: string;
  selected: boolean;
  summary: string;
}) {
  const sourceCount = bindingCount(data.inputBindings.sourceEndpoints);
  const destinationCount = bindingCount(
    data.inputBindings.destinationEndpoints,
  );
  const canAddEndpoint = Boolean(
    data.endpointActionAvailable && data.onQuickAddEndpoint,
  );

  return (
    <StepConfigPreview config={data.config}>
      <div
        aria-label={`${displayName}. ${summary}. Double-click to configure.`}
        className="group relative w-[292px]"
        role="button"
        title={`${displayName} — double-click to configure`}
      >
        <Handle
          id={portId(data, "input", WORKFLOW_INPUT_HANDLE)}
          className={nodeHandleClass(selected)}
          position={Position.Left}
          style={{ top: WORKFLOW_NODE_HANDLE_Y }}
          type="target"
        />
        <Handle
          id={portId(data, "output", WORKFLOW_OUTPUT_HANDLE)}
          className={nodeHandleClass(selected)}
          position={Position.Right}
          style={{ top: WORKFLOW_NODE_HANDLE_Y }}
          type="source"
        />
        <div className={workflowNodeCardClassName(data, selected)}>
          <WorkflowNodeHeader
            displayName={displayName}
            summary={summary}
            icon={
              <>
                <img
                  alt=""
                  aria-hidden="true"
                  className="size-5 object-contain dark:hidden"
                  src="/beam-logo-black.svg"
                />
                <img
                  alt=""
                  aria-hidden="true"
                  className="hidden size-5 object-contain dark:block"
                  src="/beam-logo-white.svg"
                />
              </>
            }
          />
          <WorkflowNodeStatus data={data} />
        </div>
        <div className="flex justify-center gap-16 px-6">
          <EndpointPort
            count={sourceCount}
            disabled={!canAddEndpoint}
            handleId={portId(data, "input", BEAM_TRANSFER_SOURCE_HANDLE)}
            handleType="target"
            label="Source"
            onAdd={() => data.onQuickAddEndpoint?.("source")}
            selected={selected}
          />
          <EndpointPort
            count={destinationCount}
            disabled={!canAddEndpoint}
            handleId={portId(data, "output", BEAM_TRANSFER_DESTINATION_HANDLE)}
            handleType="source"
            label="Destination"
            onAdd={() => data.onQuickAddEndpoint?.("destination")}
            selected={selected}
          />
        </div>
      </div>
    </StepConfigPreview>
  );
}

function ObjectStorageEndpointNode({
  data,
  selected,
}: {
  data: WorkflowNodeData;
  selected: boolean;
}) {
  const provider = configText(data.config.provider);
  const objectKey = configText(data.config.objectKey);
  const profile = provider ? getProviderProfile(provider) : undefined;
  const providerName =
    profile?.name || (provider ? humanizeKey(provider) : "Endpoint");
  const label =
    objectKey || configText(data.config.name) || "Object storage endpoint";
  const rawSize = data.config.objectSize;
  const sizeLabel = typeof rawSize === "number" ? formatBytes(rawSize) : null;

  return (
    <div
      aria-label={`${providerName} endpoint. ${label}. Double-click to configure.`}
      className={cn(
        "group relative flex w-[248px] items-center gap-3 rounded-full border bg-card/95 py-2.5 pl-2.5 pr-4 text-card-foreground shadow-sm transition-[border-color,box-shadow]",
        "hover:border-foreground/25 hover:shadow-md",
        selected &&
          "border-primary bg-primary/[0.06] shadow-md ring-2 ring-primary/20",
        !data.enabled && "opacity-60",
        data.issues.length && "border-destructive/70",
      )}
      role="button"
      style={{ height: WORKFLOW_NODE_HEADER_HEIGHT }}
      title={`${label} — double-click to configure`}
    >
      <Handle
        id={portId(data, "input", "resource-in")}
        className={nodeHandleClass(selected)}
        position={Position.Left}
        type="target"
      />
      <Handle
        id={portId(data, "output", "resource-out")}
        className={nodeHandleClass(selected)}
        position={Position.Right}
        type="source"
      />
      <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-full border bg-background">
        <ProviderLogo
          name={providerName}
          provider={provider}
          src={profile?.logo}
        />
      </span>
      <span className="min-w-0 flex-1">
        <strong
          className="block truncate text-sm font-semibold tracking-tight"
          title={label}
        >
          {label}
        </strong>
        <span className="block truncate text-[11px] text-muted-foreground">
          {sizeLabel ?? providerName}
        </span>
      </span>
      {data.issues.length ? (
        <span
          aria-label={`${data.issues.length} issues`}
          className="absolute right-3 top-1/2 size-2.5 -translate-y-1/2 rounded-full bg-destructive"
          title={data.issues.join(" ")}
        />
      ) : null}
    </div>
  );
}

function ProviderLogo({
  name,
  provider,
  src,
}: {
  name: string;
  provider: string;
  src?: string;
}) {
  const resolved = src ?? nativeProviderLogo(provider);
  const [failed, setFailed] = useState(false);
  if (resolved && !failed) {
    return (
      <img
        alt=""
        aria-hidden="true"
        className="size-6 object-contain"
        onError={() => setFailed(true)}
        src={resolved}
      />
    );
  }
  return (
    <Database
      aria-label={name}
      className="size-5 text-muted-foreground"
      strokeWidth={1.8}
    />
  );
}

/**
 * Integration actions whose identity is the service they talk to.
 *
 * Kept as an explicit map rather than a substring match on the package name:
 * "@beam/object-storage-delete" contains "storage" and would happily claim a
 * logo it has no business showing.
 */
const ACTION_PROVIDER_IDS: Record<string, string> = {
  "@beam/slack": "slack-bot",
  "@beam/zapier": "zapier",
  "@beam/zapier-tools": "zapier",
  "@beam/salesforce-query": "salesforce",
  "@beam/salesforce-record": "salesforce",
  "@beam/salesforce-rest": "salesforce",
  "@beam/salesforce-upsert": "salesforce",
};

function actionProviderId(actionPackageName: string): string | undefined {
  return ACTION_PROVIDER_IDS[actionPackageName.trim().toLowerCase()];
}

function nativeProviderLogo(provider: string): string | undefined {
  const id = provider.trim().toLowerCase();
  // "google-cloud-storage" is an alias older step configs still write.
  return nativeProviderDisplay(id === "google-cloud-storage" ? "gcs" : id)
    ?.logo;
}

function configText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function portId(
  data: WorkflowNodeData,
  direction: "input" | "output",
  fallback: string,
) {
  return (
    data.definition.ports.find(
      (port) => port.direction === direction && port.id === fallback,
    )?.id ??
    data.definition.ports.find((port) => port.direction === direction)?.id ??
    fallback
  );
}

function EndpointPort({
  count,
  disabled,
  handleId,
  handleType,
  label,
  onAdd,
  selected,
}: {
  count: number;
  disabled: boolean;
  handleId: string;
  handleType: "source" | "target";
  label: string;
  onAdd(): void;
  selected: boolean;
}) {
  return (
    <div className="relative flex flex-col items-center">
      <span aria-hidden="true" className="h-4 w-px bg-border/70" />
      <span aria-hidden="true" className="size-[26px]" />
      <span className="mt-1.5 whitespace-nowrap text-[11px] font-medium leading-none text-muted-foreground">
        {label}
        {count ? <span className="ml-1 text-info">{count}</span> : null}
      </span>
      <Handle
        id={handleId}
        aria-label={
          disabled ? `${label} endpoint` : `Add ${label.toLowerCase()} endpoint`
        }
        className={endpointPortHandleClass(selected)}
        position={Position.Bottom}
        style={{
          top: 16,
          bottom: "auto",
          left: "50%",
          transform: "translateX(-50%)",
        }}
        type={handleType}
        onClick={
          disabled
            ? undefined
            : (event) => {
                event.stopPropagation();
                onAdd();
              }
        }
        title={
          disabled
            ? "Endpoint action unavailable"
            : `Add ${label.toLowerCase()}`
        }
      >
        <Plus
          aria-hidden="true"
          className="pointer-events-none"
          size={13}
          strokeWidth={2.5}
        />
      </Handle>
    </div>
  );
}

function StepConfigPreview({
  children,
  config,
}: {
  children: ReactElement;
  config: JsonObject;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const entries = Object.entries(config);
  const hasConfig = entries.length > 0;

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as globalThis.Node;
      if (
        triggerRef.current?.contains(target) ||
        contentRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <Tooltip.Provider>
      <Tooltip.Root open={open}>
        <Tooltip.Trigger
          ref={(node) => {
            triggerRef.current = node;
          }}
          asChild
          onClick={() => setOpen((current) => !current)}
          // A double-click opens the node's settings dialog; its two clicks
          // must not leave the preview open on top of it.
          onDoubleClick={() => setOpen(false)}
        >
          {children}
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            ref={contentRef}
            className="z-40 w-[min(360px,calc(100vw-32px))] rounded-control border bg-popover p-0 text-popover-foreground shadow-lg"
            collisionPadding={16}
            side="right"
            sideOffset={12}
          >
            <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Config
              </span>
              {hasConfig ? (
                <span className="rounded-control-compact bg-muted px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
                  {entries.length} {entries.length === 1 ? "key" : "keys"}
                </span>
              ) : null}
            </div>
            {hasConfig ? (
              <dl className="max-h-80 divide-y divide-border/60 overflow-auto">
                {entries.map(([key, value]) => (
                  <ConfigRow key={key} name={key} value={value} />
                ))}
              </dl>
            ) : (
              <p className="px-3 py-3 text-sm text-muted-foreground">
                No configuration.
              </p>
            )}
            <Tooltip.Arrow className="fill-border" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

function ConfigRow({ name, value }: { name: string; value: unknown }) {
  const nested = isNestedValue(value);

  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <dt className="font-mono text-[11px] font-medium leading-4 text-muted-foreground">
        {name}
      </dt>
      <dd className="min-w-0">
        {nested ? (
          <pre className="overflow-x-auto whitespace-pre rounded-control-compact bg-muted p-2 font-mono text-[11px] leading-4 text-foreground">
            {JSON.stringify(value, null, 2)}
          </pre>
        ) : (
          <ConfigScalar value={value} />
        )}
      </dd>
    </div>
  );
}

function ConfigScalar({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return (
      <span className="font-mono text-xs italic text-muted-foreground">
        {value === null ? "null" : "—"}
      </span>
    );
  }

  if (typeof value === "boolean") {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-control-compact px-1.5 py-0.5 font-mono text-[11px] leading-none",
          value
            ? "bg-success/10 text-success"
            : "bg-muted text-muted-foreground",
        )}
      >
        {String(value)}
      </span>
    );
  }

  if (typeof value === "number") {
    return (
      <span className="font-mono text-xs tabular-nums text-info">{value}</span>
    );
  }

  const text = String(value);
  return (
    <span
      className="block break-words font-mono text-xs leading-5 text-foreground"
      title={text}
    >
      {text.length ? (
        text
      ) : (
        <span className="italic text-muted-foreground">empty</span>
      )}
    </span>
  );
}

function isNestedValue(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

function WorkflowControlFlowNode({
  data,
  selected,
}: {
  catalog: JsonObject | undefined;
  data: WorkflowNodeData;
  manifest: JsonObject;
  selected: boolean;
}) {
  const isFanOut = data.actionPackageName === FAN_OUT_ACTION;
  const Icon = isFanOut ? GitBranch : Network;
  const title = isFanOut ? "For each item" : "Continue after all items";
  const description = isFanOut
    ? "Runs the following actions once per item"
    : "Waits until every item has finished";
  return (
    <StepConfigPreview config={data.config}>
      <div
        aria-label={`${title}. ${description}. Double-click to configure.`}
        className="group relative w-[260px]"
        role="button"
        title={`${title} — double-click to configure`}
      >
        <Handle
          className={nodeHandleClass(selected)}
          position={Position.Left}
          style={{ top: WORKFLOW_NODE_HANDLE_Y }}
          type="target"
        />
        <Handle
          className={nodeHandleClass(selected)}
          position={Position.Right}
          style={{ top: WORKFLOW_NODE_HANDLE_Y }}
          type="source"
        />
        <div className={workflowNodeCardClassName(data, selected)}>
          <WorkflowNodeHeader
            displayName={title}
            summary={description}
            icon={<Icon aria-hidden="true" size={18} strokeWidth={1.8} />}
          />
          <WorkflowNodeStatus data={data} />
        </div>
      </div>
    </StepConfigPreview>
  );
}

/** "prod" and "dev" are the stored values; spell them out on the canvas. */
function beamEnvironmentLabel(environment: string) {
  const value = environment.trim().toLowerCase();
  if (value === "prod" || value === "production") return "Production";
  if (value === "dev" || value === "development") return "Development";
  return environment.trim();
}

function nodeHandleClass(selected: boolean) {
  return cn(
    "!size-3 !rounded-full !border-2 !border-card !bg-muted-foreground/70 !opacity-0 !transition-[opacity,background-color] group-hover:!bg-primary group-hover:!opacity-100",
    selected && "!bg-primary !opacity-100",
  );
}

function endpointPortHandleClass(selected: boolean) {
  return cn(
    "grid !size-[26px] !min-h-0 !min-w-0 !place-items-center !rounded-full !border !border-border !bg-card !text-muted-foreground !shadow-sm !transition-colors hover:!border-primary hover:!bg-primary/10 hover:!text-primary",
    selected && "!border-primary !text-primary",
  );
}

function bindingCount(value: unknown) {
  if (Array.isArray(value)) {
    return value.length;
  }
  return value === undefined || value === null || value === "" ? 0 : 1;
}

function actionIcon(actionPackageName: string): LucideIcon {
  const name = actionPackageName.toLowerCase();
  if (name.includes("download")) return Download;
  if (name.includes("upload")) return Upload;
  if (name.includes("transfer")) return ArrowRightLeft;
  if (name.includes("archive")) return Archive;
  if (name.includes("checksum")) return ShieldCheck;
  if (name.includes("webhook")) return Webhook;
  if (name.includes("wait")) return Clock3;
  if (name.includes("json")) return Braces;
  if (name.includes("merge")) return Merge;
  if (name.includes("storage") || name.includes("endpoint")) return Box;
  if (name.includes("package")) return Package;
  return Box;
}

function stepSummary(data: WorkflowNodeData) {
  if (data.definition.presentation === "composite") {
    // Which environment a transfer runs against is the thing worth seeing at a
    // glance; the broker's host and port is detail nobody reads off a canvas,
    // and reading it wrongly is how a dev transfer gets mistaken for a prod
    // one. The URL stays as the fallback so the information is never lost when
    // a credential predates the environment field.
    if (data.credentialEnvironment) {
      return beamEnvironmentLabel(data.credentialEnvironment);
    }
    if (data.credentialNatsUrl) {
      return shortValue(data.credentialNatsUrl);
    }
    if (data.credentialName) {
      return `Credential: ${shortValue(data.credentialName)}`;
    }
  }
  const { config, inputBindings } = data;
  const waitSummary = waitDurationSummary(data.actionPackageName, config);
  if (waitSummary) return waitSummary;
  const meaningful = Object.entries(config).find(
    ([key, value]) =>
      !/(credential|secret|token|password|key)$/i.test(key) &&
      value !== "" &&
      value !== null &&
      value !== undefined &&
      typeof value !== "object",
  );
  if (meaningful) {
    const [key, value] = meaningful;
    return `${humanizeKey(key)}: ${shortValue(value)}`;
  }
  const connectedInputs = Object.keys(inputBindings).length;
  if (connectedInputs) {
    return `${connectedInputs} connected input${connectedInputs === 1 ? "" : "s"}`;
  }
  return Object.keys(config).length
    ? "Configured and ready"
    : "No setup required";
}

function shortValue(value: unknown) {
  const text = String(value);
  return text.length > 42 ? `${text.slice(0, 39)}…` : text;
}

function humanizeActionName(actionPackageName: string) {
  return humanizeKey(actionPackageName.replace(/^@[^/]+\//, ""));
}

function humanizeKey(value: string) {
  const words = value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
