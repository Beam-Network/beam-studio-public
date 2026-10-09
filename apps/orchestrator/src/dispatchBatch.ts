/** Independent dispatch work shares a bounded pool, never a serial network wait. */
export async function dispatchBatch<T>(
  items: readonly T[],
  callback: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(4, items.length) },
    async () => {
      while (next < items.length) {
        const item = items[next++]!;
        await callback(item);
      }
    },
  );
  // Drain started work before returning an error: no transaction or outbox
  // publication can escape the tick that owns it.
  const settled = await Promise.allSettled(workers);
  const failure = settled.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
