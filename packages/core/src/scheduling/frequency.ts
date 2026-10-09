export type ScheduleFrequency =
  | { kind: "manual" }
  | { kind: "interval"; every: number; unit: "minutes" | "hours" | "days" };

export function parseScheduleFrequency(value: string): ScheduleFrequency | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "manual") {
    return { kind: "manual" };
  }

  const match = /^every\s+(\d+)\s+(minute|minutes|hour|hours|day|days)$/i.exec(
    trimmed,
  );
  if (!match) {
    return null;
  }

  const every = Number(match[1]);
  if (!Number.isSafeInteger(every) || every < 1) {
    return null;
  }

  const unit = match[2]?.toLowerCase();
  return {
    kind: "interval",
    every,
    unit:
      unit === "minute" || unit === "minutes"
        ? "minutes"
        : unit === "hour" || unit === "hours"
          ? "hours"
          : "days",
  };
}

export function describeFrequency(frequency: ScheduleFrequency) {
  if (frequency.kind === "manual") {
    return "manual";
  }

  const unit =
    frequency.every === 1 ? frequency.unit.replace(/s$/, "") : frequency.unit;
  return `every ${frequency.every} ${unit}`;
}
