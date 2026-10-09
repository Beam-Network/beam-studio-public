import { setTimeout as delay } from "node:timers/promises";

/** Wait under the caller's existing claim/idle fence; this never renews it. */
export async function withControlRecovery<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  retryable: (error: unknown) => boolean,
): Promise<T> {
  let backoffMs = 250;
  for (;;) {
    signal.throwIfAborted();
    try {
      const result = await operation();
      signal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      if (!retryable(error)) throw error;
      await delay(backoffMs, undefined, { signal });
      backoffMs = Math.min(backoffMs * 2, 2_000);
    }
  }
}
