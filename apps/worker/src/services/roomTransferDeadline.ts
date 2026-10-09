export const roomTransferIdleTimeoutMs = 300_000;

export function initialRoomTransferDeadline(
  now: number,
  publicationId: unknown,
  storedLease: Record<string, unknown>,
): number {
  const stored = Date.parse(String(storedLease.idleExpiresAt ?? ""));
  if (storedLease.publicationId !== publicationId || !Number.isFinite(stored))
    return now + roomTransferIdleTimeoutMs;
  // A restarted executor gets a bounded chance to fetch fresh Coordinator
  // status even when Studio's last persisted snapshot is already stale.
  return Math.max(
    now + 30_000,
    Math.min(now + roomTransferIdleTimeoutMs, stored),
  );
}

export function acceptRoomTransferDeadline(
  current: number,
  candidate: string,
  now: number,
): number {
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) &&
    parsed > current &&
    parsed <= now + roomTransferIdleTimeoutMs + 10_000
    ? parsed
    : current;
}
