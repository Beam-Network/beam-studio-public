type AgentIdentity = {
  id: string;
  machineName?: string | null;
  name?: string | null;
  status?: string;
};

const agentNameCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

export function sortAgentsForInventory<T extends AgentIdentity>(
  agents: readonly T[],
): T[] {
  // API order follows updatedAt, which changes on every heartbeat.
  // Group online agents first, then use identity with a unique tie-breaker.
  // Preserve the query cache and ignore heartbeat timestamps.
  return [...agents].sort(
    (left, right) =>
      Number(right.status === "online") - Number(left.status === "online") ||
      agentNameCollator.compare(
        left.name || left.machineName || left.id,
        right.name || right.machineName || right.id,
      ) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
}
