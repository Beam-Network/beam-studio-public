import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarClock,
  CalendarDays,
  Check,
  Copy,
  GitFork,
  MousePointerClick,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createDefaultScheduleTriggerConfig,
  normalizeScheduleTriggerConfig,
} from "@/features/scheduling/schedule-config";
import { ScheduleTriggerSettings } from "@/features/scheduling/schedule-trigger-settings";
import { apiUrlForPath } from "@/lib/api-client";
import { secureRandomHex } from "@/lib/secure-random";
import { cn } from "@/lib/utils";
import {
  nextWorkflowTriggerName,
  prepareWorkflowTriggerEditorSubmit,
  workflowTriggerDefaultName,
  type WorkflowTriggerEditorSubmit,
} from "./workflow-trigger-editor-state";
import type {
  WorkflowSourceSummary,
  WorkflowTriggerType,
} from "./workflow-graph-types";

export const workflowTriggerOptions: Array<{
  description: string;
  icon: LucideIcon;
  label: string;
  type: WorkflowTriggerType;
}> = [
  {
    description: "Run from the editor or an explicit API call.",
    icon: MousePointerClick,
    label: "Trigger manually",
    type: "manual",
  },
  {
    description: "Run from a recurring schedule.",
    icon: CalendarClock,
    label: "On a schedule",
    type: "schedule",
  },
  {
    description: "Accept an authenticated HTTP POST request.",
    icon: Webhook,
    label: "Webhook HTTP",
    type: "webhook",
  },
  {
    description: "Run once at a specific date and time.",
    icon: CalendarDays,
    label: "At a specific time",
    type: "date",
  },
  {
    description: "Run after a workflow completes or fails.",
    icon: GitFork,
    label: "After workflow",
    type: "completion",
  },
];

export function WorkflowTriggerPickerDialog({
  currentConfig,
  currentEnabled,
  currentName,
  currentType,

  mode,
  onOpenChange,
  onSubmit,
  open,
  triggerId,
  workflowId,
  workflows,
}: {
  currentConfig?: Record<string, unknown>;
  currentEnabled?: boolean;
  currentName?: string;
  currentType?: WorkflowTriggerType;

  mode: "add" | "change";
  onOpenChange(open: boolean): void;
  onSubmit(trigger: WorkflowTriggerEditorSubmit): void;
  open: boolean;
  triggerId?: string;
  workflowId: string;
  workflows: WorkflowSourceSummary[];
}) {
  const [selectedType, setSelectedType] = useState<WorkflowTriggerType>(
    currentType ?? "manual",
  );
  const [enabled, setEnabled] = useState(currentEnabled ?? true);
  const [name, setName] = useState(
    () =>
      currentName?.trim() ||
      workflowTriggerDefaultName(currentType ?? "manual"),
  );
  const [config, setConfig] = useState<Record<string, unknown>>(() =>
    triggerConfig(currentType ?? "manual", currentConfig, workflows),
  );
  const selectedOptionRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const type = currentType ?? "manual";
    setSelectedType(type);
    setEnabled(currentEnabled ?? true);
    setName(currentName?.trim() || workflowTriggerDefaultName(type));
    setConfig(triggerConfig(type, currentConfig, workflows));
  }, [
    currentConfig,
    currentEnabled,
    currentName,
    currentType,

    open,
    workflows,
  ]);

  const submitResult = useMemo(
    () =>
      prepareWorkflowTriggerEditorSubmit(
        {
          config,
          enabled,
          name,
          type: selectedType,
        },
        { currentEnabled },
      ),
    [config, currentEnabled, enabled, name, selectedType],
  );
  const canSubmit =
    triggerConfigIsValid(selectedType, config) && submitResult.ok;
  const onEnabledChange = (nextEnabled: boolean) => {
    setEnabled(nextEnabled);
    if (
      !nextEnabled ||
      selectedType !== "schedule" ||
      currentEnabled !== false
    ) {
      return;
    }
    const prepared = prepareWorkflowTriggerEditorSubmit(
      {
        config,
        enabled: true,
        name,
        type: selectedType,
      },
      { currentEnabled },
    );
    if (prepared.ok) {
      setConfig(prepared.trigger.config);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="grid max-h-[calc(100dvh-32px)] w-[min(820px,calc(100vw-32px))] grid-rows-[auto_minmax(0,1fr)_auto]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          window.requestAnimationFrame(() => {
            selectedOptionRef.current?.focus({ preventScroll: true });
          });
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {mode === "add" ? "Add trigger" : "Configure trigger"}
          </DialogTitle>
          <DialogDescription>
            Choose how this workflow should start.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 overflow-y-auto pr-1">
          <div className="grid gap-3 sm:grid-cols-2">
            {workflowTriggerOptions.map((option) => {
              const Icon = option.icon;
              const selected = option.type === selectedType;
              return (
                <button
                  aria-pressed={selected}
                  className={cn(
                    "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-control border bg-background p-4 text-left transition-colors hover:bg-secondary hover:text-secondary-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected && "border-primary bg-primary/5",
                  )}
                  key={option.type}
                  onClick={() => {
                    const nextType = option.type;
                    setSelectedType(nextType);
                    setName((currentName) =>
                      nextWorkflowTriggerName({
                        currentName,
                        currentType: selectedType,
                        nextType,
                      }),
                    );
                    setConfig(
                      triggerConfig(
                        nextType,
                        nextType === currentType ? currentConfig : undefined,
                        workflows,
                      ),
                    );
                  }}
                  ref={
                    option.type === (currentType ?? "manual")
                      ? selectedOptionRef
                      : undefined
                  }
                  type="button"
                >
                  <span className="grid size-10 place-items-center rounded-control bg-muted text-muted-foreground">
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="min-w-0">
                    <strong className="block text-sm">{option.label}</strong>
                    <span className="mt-1 block text-sm leading-5 text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                  {selected ? (
                    <Check
                      aria-label="Selected trigger type"
                      className="h-4 w-4 text-primary"
                    />
                  ) : null}
                </button>
              );
            })}
          </div>

          <SettingsPanel
            description="Control whether this entry point can start workflow runs."
            title="Trigger availability"
          >
            <label className="flex items-center justify-between gap-3 text-sm font-medium">
              Enabled
              <input
                checked={enabled}
                className="size-4 accent-primary"
                type="checkbox"
                onChange={(event) => onEnabledChange(event.target.checked)}
              />
            </label>
            <label className="grid gap-2 text-sm font-medium">
              Name
              <input
                className={inputClassName}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          </SettingsPanel>

          <TriggerTypeSettings
            config={config}
            mode={mode}
            onChange={setConfig}
            triggerId={triggerId}
            type={selectedType}
            workflowId={workflowId}
            workflows={workflows}
          />

          {!submitResult.ok ? (
            <div className="rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {submitResult.issue}
            </div>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t pt-4">
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={() => {
              if (submitResult.ok) {
                onSubmit(submitResult.trigger);
              }
            }}
            type="button"
          >
            <Check className="h-4 w-4" />
            {mode === "add" ? "Add trigger" : "Save trigger"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TriggerTypeSettings({
  config,

  mode,
  onChange,
  triggerId,
  type,
  workflowId,
  workflows,
}: {
  config: Record<string, unknown>;

  mode: "add" | "change";
  onChange(config: Record<string, unknown>): void;
  triggerId?: string;
  type: WorkflowTriggerType;
  workflowId: string;
  workflows: WorkflowSourceSummary[];
}) {
  if (type === "schedule") {
    return <ScheduleTriggerSettings value={config} onChange={onChange} />;
  }
  if (type === "webhook") {
    const token = String(config.token ?? "");
    const signingSecret = String(config.signingSecret ?? "");
    const url =
      triggerId && token
        ? absoluteUrl(
            apiUrlForPath(
              `/hooks/workflows/${workflowId}/${triggerId}/${token}`,
            ),
          )
        : "";
    return (
      <SettingsPanel
        description="Send a JSON body with an HTTP POST request. The secret URL identifies and authenticates this trigger."
        title="Webhook endpoint"
      >
        {url ? (
          <div className="flex gap-2">
            <input className={inputClassName} readOnly value={url} />
            <Button
              aria-label="Copy webhook URL"
              onClick={() => navigator.clipboard.writeText(url)}
              size="icon"
              type="button"
              variant="outline"
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {mode === "add"
              ? "The endpoint URL will be available after adding the trigger."
              : "Save the trigger to generate its endpoint URL."}
          </p>
        )}
        <Button
          className="w-fit"
          onClick={() => onChange({ ...config, token: webhookToken() })}
          type="button"
          variant="outline"
        >
          Rotate secret URL
        </Button>
        <label className="rounded-control border p-3 text-sm">
          <input
            type="checkbox"
            className="mr-2"
            checked={config.requireSignature === true}
            onChange={(event) =>
              onChange({ ...config, requireSignature: event.target.checked })
            }
          />
          Require a signed body
          <p className="mt-1 text-sm text-muted-foreground">
            The sender must add <code>X-Beam-Timestamp</code> and{" "}
            <code>X-Beam-Signature: v1=&lt;hex&gt;</code>, the HMAC-SHA256 of{" "}
            <code>v1:&lt;timestamp&gt;:&lt;body&gt;</code>. Leave this off for
            senders that cannot set custom headers, such as Salesforce Flows.
          </p>
        </label>
        {signingSecret ? (
          <div className="grid gap-2 text-sm font-medium">
            Signing secret
            <div className="flex gap-2">
              <input
                className={inputClassName}
                readOnly
                value={signingSecret}
              />
              <Button
                aria-label="Copy signing secret"
                onClick={() => navigator.clipboard.writeText(signingSecret)}
                size="icon"
                type="button"
                variant="outline"
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Rotating the secret URL rotates this too.
            </p>
          </div>
        ) : config.requireSignature === true ? (
          <p className="text-sm text-muted-foreground">
            Save the trigger to reveal its signing secret.
          </p>
        ) : null}
      </SettingsPanel>
    );
  }
  if (type === "date") {
    return (
      <SettingsPanel
        description="This trigger runs once and disables itself after the workflow is queued."
        title="Execution date"
      >
        <label className="grid gap-2 text-sm font-medium">
          Date and time
          <input
            className={inputClassName}
            type="datetime-local"
            value={dateTimeInputValue(String(config.runAt ?? ""))}
            onChange={(event) =>
              onChange({
                ...config,
                runAt: dateTimeInputToIso(event.target.value),
              })
            }
          />
        </label>
        <label className="grid gap-2 text-sm font-medium">
          Timezone
          <input
            className={inputClassName}
            value={String(config.timezone ?? "")}
            onChange={(event) =>
              onChange({ ...config, timezone: event.target.value })
            }
          />
        </label>
      </SettingsPanel>
    );
  }
  if (type === "completion") {
    const sourceKind = "workflow";
    const sources = workflows;
    const statuses = Array.isArray(config.statuses)
      ? config.statuses.map(String)
      : [];
    return (
      <SettingsPanel
        description="The source output and terminal status are passed to this workflow as input."
        title="Source event"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-2 text-sm font-medium">
            Source
            <select
              className={inputClassName}
              value={String(config.sourceId ?? "")}
              onChange={(event) =>
                onChange({ ...config, sourceId: event.target.value })
              }
            >
              <option value="">Select a source</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid gap-2">
          <span className="text-sm font-medium">Run when</span>
          <div className="flex flex-wrap gap-3">
            {completionStatusOptions.map(({ label, value }) => (
              <label
                className="flex items-center gap-2 rounded-control border bg-background px-3 py-2 text-sm"
                key={value}
              >
                <input
                  checked={statuses.includes(value)}
                  className="size-4 accent-primary"
                  type="checkbox"
                  onChange={(event) =>
                    onChange({
                      ...config,
                      statuses: event.target.checked
                        ? [...new Set([...statuses, value])]
                        : statuses.filter((status) => status !== value),
                    })
                  }
                />
                {label}
              </label>
            ))}
          </div>
        </div>
      </SettingsPanel>
    );
  }
  return (
    <div className="rounded-control border border-dashed p-4 text-sm text-muted-foreground">
      This trigger starts when a user launches the workflow manually.
    </div>
  );
}

function SettingsPanel({
  children,
  description,
  title,
}: {
  children: React.ReactNode;
  description: string;
  title: string;
}) {
  return (
    <section className="grid gap-3 rounded-surface border bg-muted/20 p-4">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      </div>
      {children}
    </section>
  );
}

function triggerConfig(
  type: WorkflowTriggerType,
  current: Record<string, unknown> | undefined,
  workflows: WorkflowSourceSummary[],
) {
  if (type === "schedule") {
    return { ...normalizeScheduleTriggerConfig(current) };
  }
  if (type === "webhook") {
    // Spread first: this used to return the token alone, so opening the
    // dialog on an existing trigger and saving discarded its rate limit,
    // coalescing window and signature setting.
    return {
      ...current,
      token: String(current?.token ?? "") || webhookToken(),
    };
  }
  if (type === "date") {
    return {
      runAt: validIsoDate(current?.runAt) ?? nextHourIso(),
      timezone:
        String(current?.timezone ?? "") ||
        Intl.DateTimeFormat().resolvedOptions().timeZone ||
        "UTC",
    };
  }
  if (type === "completion") {
    const sourceKind = "workflow";
    const sources = workflows;
    const currentStatuses = Array.isArray(current?.statuses)
      ? current.statuses
          .map(String)
          .filter((status) => status === "completed" || status === "failed")
      : [];
    return {
      sourceKind,
      sourceId: String(current?.sourceId ?? "") || sources[0]?.id || "",
      statuses: currentStatuses.length
        ? currentStatuses
        : ["completed", "failed"],
    };
  }
  return {};
}

function triggerConfigIsValid(
  type: WorkflowTriggerType,
  config: Record<string, unknown>,
) {
  if (type === "date") {
    return Boolean(validIsoDate(config.runAt));
  }
  if (type === "completion") {
    return Boolean(
      String(config.sourceId ?? "") &&
      Array.isArray(config.statuses) &&
      config.statuses.length,
    );
  }
  if (type === "webhook") {
    return Boolean(String(config.token ?? ""));
  }
  return true;
}

function webhookToken() {
  return secureRandomHex(24);
}

function nextHourIso() {
  const date = new Date();
  date.setHours(date.getHours() + 1, 0, 0, 0);
  return date.toISOString();
}

function validIsoDate(value: unknown) {
  const date = new Date(String(value ?? ""));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function dateTimeInputValue(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(date.getDate()).padStart(2, "0")}T${String(
    date.getHours(),
  ).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function dateTimeInputToIso(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function absoluteUrl(value: string) {
  return new URL(value, window.location.origin).toString();
}

const inputClassName =
  "h-10 w-full rounded-control border bg-background px-3 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring";

const completionStatusOptions = [
  { label: "Completed", value: "completed" },
  { label: "Failed", value: "failed" },
] as const;
