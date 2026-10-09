import { calculateNextRunAt } from "@beam-studio/core/scheduling";
import {
  normalizeScheduleTriggerConfig,
  type ScheduleTriggerConfig,
} from "../scheduling/schedule-config";
import type { JsonObject, WorkflowTriggerType } from "./workflow-graph-types";

export type WorkflowTriggerEditorDraft = {
  config: Record<string, unknown>;
  enabled: boolean;
  name: string;
  type: WorkflowTriggerType;
};

export type WorkflowTriggerEditorSubmit = {
  config: JsonObject;
  enabled: boolean;
  name: string;
  type: WorkflowTriggerType;
};

export type WorkflowTriggerEditorSubmitResult =
  | { ok: true; trigger: WorkflowTriggerEditorSubmit }
  | { issue: string; ok: false };

export function workflowTriggerDefaultName(type: WorkflowTriggerType) {
  if (type === "schedule") {
    return "On a schedule";
  }
  if (type === "webhook") {
    return "Webhook HTTP";
  }
  if (type === "date") {
    return "At a specific time";
  }
  if (type === "completion") {
    return "After workflow";
  }
  return "Trigger manually";
}

export function nextWorkflowTriggerName({
  currentName,
  currentType,
  nextType,
}: {
  currentName: string;
  currentType: WorkflowTriggerType;
  nextType: WorkflowTriggerType;
}) {
  const trimmed = currentName.trim();
  if (!trimmed || trimmed === workflowTriggerDefaultName(currentType)) {
    return workflowTriggerDefaultName(nextType);
  }
  return currentName;
}

export function prepareWorkflowTriggerEditorSubmit(
  draft: WorkflowTriggerEditorDraft,
  options: { currentEnabled?: boolean; now?: Date } = {},
): WorkflowTriggerEditorSubmitResult {
  const type = draft.type;
  const name = draft.name.trim() || workflowTriggerDefaultName(type);
  const trigger = {
    config: draft.config as JsonObject,
    enabled: draft.enabled,
    name,
    type,
  };

  if (type !== "schedule") {
    return { ok: true, trigger };
  }

  const config = normalizeScheduleTriggerConfig(draft.config);
  const currentEnabled = options.currentEnabled ?? true;
  const shouldResumeSchedule =
    draft.enabled &&
    !currentEnabled &&
    isPastOrNow(config.nextRunAt, options.now);

  if (!shouldResumeSchedule) {
    return {
      ok: true,
      trigger: { ...trigger, config: config as unknown as JsonObject },
    };
  }

  const nextRunAt = nextFutureScheduleRun(config, options.now ?? new Date());
  if (!nextRunAt) {
    return {
      issue: "Schedule cannot be enabled until its timing allows a future run.",
      ok: false,
    };
  }

  return {
    ok: true,
    trigger: {
      ...trigger,
      config: { ...config, nextRunAt } as unknown as JsonObject,
    },
  };
}

function nextFutureScheduleRun(config: ScheduleTriggerConfig, now: Date) {
  return calculateNextRunAt(config.nextRunAt, config.frequency, {
    after: now,
    endAt: config.endAt,
    timezone: config.timezone,
    windowDays: config.windowDays,
    windowEndTime: config.windowEndTime,
    windowStartTime: config.windowStartTime,
  });
}

function isPastOrNow(value: string, now = new Date()) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() <= now.getTime();
}
