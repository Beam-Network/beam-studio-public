export const terminalCommandStates = new Set([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

export function compactAgentId(id: string): string {
  return id.length > 24 ? `${id.slice(0, 12)}…${id.slice(-6)}` : id;
}

export function compactDaemonVersion(version?: string | null): string {
  return (
    version
      ?.trim()
      .replace(
        /([.+-])([a-f0-9]{12,})(?=$|[.+-])/gi,
        (_, separator: string, hash: string) =>
          `${separator}${hash.slice(0, 7)}`,
      ) || "Unknown"
  );
}

export function refreshAfterCommand(operation: string): string[] {
  // Only operations that change endpoints refresh them. 3808032 replaced the
  // endpoint commands with room storage operations instead of adding to them,
  // which stopped refreshing after a tunnel or destination was created, and
  // 3f43a49 then removed those room storage operations again.
  return ["tunnel.create", "destination.create", "endpoint.close"].includes(
    operation,
  )
    ? ["endpoint.list", "metrics.snapshot"]
    : [];
}

export function capabilityLabel(value: unknown): string {
  const key = String(value);
  const labels: Record<string, string> = {
    endpoints: "Tunnels & destinations",
    operations: "Transfers",
    rooms: "Rooms",
    logs: "Live logs",
    metrics: "Runtime metrics",
    "room-messages": "Room messaging",
    "room-transfers": "Room file transfers",
    "studio-room-consumer": "Room hosting",
  };
  return (
    labels[key] ??
    key.replace(/[._-]+/g, " ").replace(/^./, (letter) => letter.toUpperCase())
  );
}

// Capabilities of the tunnel runtime. They are hidden while Studio offers only
// Rooms; older agents still report them.
const tunnelCapabilities = new Set([
  "endpoints",
  "operations",
  "operation.cancel",
  "operation.prune",
  "identity",
  "bridge",
  "tunnels",
]);

export function isTunnelCapability(value: unknown): boolean {
  return tunnelCapabilities.has(String(value));
}

// This is Studio's restriction policy, not proof of the machine's local permissions.
export function endpointPermissions(policy: Record<string, unknown> = {}) {
  const kinds = policy.tunnel_kinds ?? policy.tunnelKinds;
  const roots = policy.filesystem_roots ?? policy.filesystemRoots;
  return {
    kinds: ["http", "stream", "webrtc", "tcp", "file"].filter(
      (kind) => !Array.isArray(kinds) || kinds.includes(kind),
    ),
    publicAllowed: (policy.allow_public ?? policy.allowPublic) !== false,
    filesAllowed:
      (!Array.isArray(kinds) || kinds.includes("file")) &&
      (!Array.isArray(roots) || roots.length > 0),
    roots: Array.isArray(roots)
      ? roots.filter((root): root is string => typeof root === "string")
      : [],
  };
}

export type AgentLog = {
  key: string;
  time: string;
  level: string;
  message: string;
};
export function mergeAgentLogs(
  previous: AgentLog[],
  snapshot: unknown,
  events: { id: string; type: string; payload?: Record<string, unknown> }[],
): AgentLog[] {
  const incoming: unknown[] = Array.isArray(snapshot) ? [...snapshot] : [];
  for (const event of events) {
    if (event.type === "log") incoming.push(event.payload);
  }
  const merged = new Map(previous.map((log) => [log.key, log]));
  for (const value of incoming) {
    if (!value || typeof value !== "object") continue;
    const log = value as Record<string, unknown>;
    if (typeof log.message !== "string") continue;
    const time = String(log.time ?? "");
    const level = String(log.level ?? "info").toLowerCase();
    // Snapshot and stream carry the same timestamp and content, but no shared log ID.
    const key = JSON.stringify([
      time,
      level,
      log.message,
      log.endpoint_id,
      log.fields,
    ]);
    merged.set(key, { key, time, level, message: log.message });
  }
  return [...merged.values()]
    .sort((a, b) => a.time.localeCompare(b.time))
    .slice(-1000);
}
