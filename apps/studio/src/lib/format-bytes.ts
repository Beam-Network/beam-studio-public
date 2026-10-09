const IEC_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/**
 * A byte count in binary units with IEC labels: 20,000,000,000 bytes is
 * "18.6 GiB". Beam prices transfers per GiB, so a size shown next to a price
 * has to say which unit it is; dividing by 1024 and printing "GB" did not.
 *
 * One decimal below 100 of a unit, none from 100 up. Returns null for a value
 * that is not a byte count, so each caller decides how to show "unknown".
 */
export function formatBytes(bytes: number | null | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return null;
  }
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < IEC_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded =
    unit === 0 || value >= 100 ? value.toFixed(0) : value.toFixed(1);
  // 1023.96 KiB rounds to "1024.0"; show the next unit instead.
  if (unit < IEC_UNITS.length - 1 && Number(rounded) >= 1024) {
    return `1.0 ${IEC_UNITS[unit + 1]}`;
  }
  return `${rounded} ${IEC_UNITS[unit]}`;
}
