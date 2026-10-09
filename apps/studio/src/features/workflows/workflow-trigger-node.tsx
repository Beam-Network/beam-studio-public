import { WORKFLOW_NODE_HEADER_HEIGHT } from "./workflow-node-geometry";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  CalendarClock,
  CalendarDays,
  GitFork,
  MousePointerClick,
  Webhook,
  Zap,
} from "lucide-react";
import { nativeProviderDisplay } from "@beam-studio/shared";
import { cn } from "@/lib/utils";
import type { WorkflowTriggerNodeData } from "./workflow-graph-types";

/**
 * Logo for the service a trigger represents, if it names one.
 *
 * Checked against the same catalog the credential pickers use, so a trigger
 * called "Zapier" or "Slack" gets that service's mark and anything else keeps
 * the generic icon. Name-based, which means renaming the trigger changes the
 * icon -- acceptable because the name is the only signal a generic webhook
 * carries about who is on the other end.
 */
function triggerProviderLogo(data: WorkflowTriggerNodeData) {
  const candidates = [
    typeof data.config?.provider === "string" ? data.config.provider : "",
    data.name ?? "",
  ];
  for (const candidate of candidates) {
    const key = candidate.trim().toLowerCase().replace(/\s+/g, "-");
    if (!key) continue;
    const logo = nativeProviderDisplay(TRIGGER_NAME_ALIASES[key] ?? key)?.logo;
    if (logo) return logo;
  }
  return undefined;
}

/**
 * People name a trigger after the service, not after a catalog id. "Slack" is
 * the obvious thing to type and "slack-bot" is not, so the names that would
 * otherwise silently fall through to a generic icon are mapped here.
 */
const TRIGGER_NAME_ALIASES: Record<string, string> = {
  slack: "slack-bot",
  huggingface: "huggingface-hub",
  "hugging-face": "huggingface-hub",
  hf: "huggingface-hub",
  "google-cloud-storage": "gcs",
  "google-cloud": "gcs",
  webhook: "http",
};

export function WorkflowTriggerNode({
  data,
  selected,
}: NodeProps<Node<WorkflowTriggerNodeData, "workflowTrigger">>) {
  const Icon =
    data.type === "schedule"
      ? CalendarClock
      : data.type === "date"
        ? CalendarDays
        : data.type === "webhook"
          ? Webhook
          : data.type === "completion"
            ? GitFork
            : data.type === "manual"
              ? MousePointerClick
              : Zap;
  // A webhook trigger cannot know who calls it, so the caller is named rather
  // than detected: config.provider when something set it, otherwise the
  // trigger's own name, which is what someone types when they add a "Zapier"
  // trigger. Unrecognised names fall through to the generic webhook glyph.
  const providerLogo = triggerProviderLogo(data);
  const label =
    data.type === "schedule"
      ? "Scheduled trigger"
      : data.type === "date"
        ? "One-time date trigger"
        : data.type === "webhook"
          ? "Webhook trigger"
          : data.type === "completion"
            ? "Completion trigger"
            : data.type === "manual"
              ? "Manual trigger"
              : `${data.type} trigger`;

  return (
    <div
      aria-label={`${label}. Double-click to configure.`}
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
        id={
          data.definition.ports.find((port) => port.direction === "output")?.id
        }
        className={cn(
          "!size-3 !rounded-full !border-2 !border-card !bg-muted-foreground/70 !opacity-0 !transition-[opacity,background-color] group-hover:!bg-primary group-hover:!opacity-100",
          selected && "!bg-primary !opacity-100",
        )}
        position={Position.Right}
        type="source"
      />
      <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-full bg-primary/10 text-primary">
        {providerLogo ? (
          <img
            alt=""
            aria-hidden="true"
            className="size-6 object-contain"
            src={providerLogo}
          />
        ) : (
          <Icon aria-hidden="true" className="h-5 w-5" strokeWidth={1.8} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block truncate text-sm font-semibold tracking-tight">
          {data.name || label}
        </strong>
        <span className="block truncate text-[11px] text-muted-foreground">
          {triggerDescription(data.type)}
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

function triggerDescription(type: string) {
  if (type === "schedule") return "Starts on a schedule";
  if (type === "date") return "Starts once at a chosen time";
  if (type === "webhook") return "Starts when a request arrives";
  if (type === "completion") return "Starts after another run";
  if (type === "manual") return "Starts when you press Run";
  return "Starts this workflow";
}
