/** Only display duration units that are explicit in the stored field name. */
export function waitDurationSummary(
  actionPackageName: string,
  config: Record<string, unknown>,
): string | undefined {
  if (actionPackageName.split("/").at(-1) !== "wait") return;
  const raw = config.durationSeconds ?? config.duration_seconds;
  if (typeof raw !== "number" && typeof raw !== "string") return;
  if (typeof raw === "string" && !raw.trim()) return;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return;

  const [amount, unit] =
    seconds > 0 && seconds % 3600 === 0
      ? [seconds / 3600, "hour"]
      : seconds > 0 && seconds % 60 === 0
        ? [seconds / 60, "minute"]
        : [seconds, "second"];
  return `Wait ${amount} ${unit}${amount === 1 ? "" : "s"}`;
}
