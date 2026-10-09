export const RUN_STATUSES = [
  "queued",
  "running",
  "cancel_requested",
  "completed",
  "failed",
  "cancelled",
  "cancelled_timeout",
  "dead_letter",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export function isRunStatus(value: string): value is RunStatus {
  return (RUN_STATUSES as readonly string[]).includes(value);
}

export type FileStatus = "planned" | "skipped" | "running" | "completed" | "failed" | "cancelled";
