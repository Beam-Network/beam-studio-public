type ConsumerCandidate = {
  id: string;
  status: string;
  capabilities: readonly string[];
};

/**
 * Why no consumer can serve the organization's rooms:
 * - `not_enrolled`: the organization has no active `studio-room-consumer` agent.
 * - `not_authorized`: consumers exist, but the coordinator authorized none of
 *   them for this organization (foreign organization, revoked on the
 *   coordinator, or the coordinator could not be reached).
 * - `offline`: an authorized consumer exists, but none is connected to Studio.
 */
export type RoomConsumerUnavailableReason =
  | "not_enrolled"
  | "not_authorized"
  | "offline";

export type RoomConsumerSelection<T> =
  | { consumer: T; reason: null }
  | { consumer: null; reason: RoomConsumerUnavailableReason };

/** Every active consumer identity, connected or not. */
export function roomConsumerCandidates<T extends ConsumerCandidate>(
  agents: T[],
): T[] {
  return agents.filter(
    (agent) =>
      agent.status !== "revoked" &&
      agent.capabilities.includes("studio-room-consumer"),
  );
}

/**
 * The consumer Studio attaches to rooms: coordinator-authorized and online.
 * Successful coordinator identity authorization is required, even for an
 * empty inventory, and an offline consumer is never selected because it
 * cannot load the room it would be attached to.
 */
export function selectRoomConsumer<T extends ConsumerCandidate>(
  agents: T[],
  authorizedIds: ReadonlySet<string>,
): RoomConsumerSelection<T> {
  const candidates = roomConsumerCandidates(agents);
  if (candidates.length === 0) {
    return { consumer: null, reason: "not_enrolled" };
  }
  const authorized = candidates.filter((agent) => authorizedIds.has(agent.id));
  if (authorized.length === 0) {
    return { consumer: null, reason: "not_authorized" };
  }
  const online = authorized.find((agent) => agent.status === "online");
  return online
    ? { consumer: online, reason: null }
    : { consumer: null, reason: "offline" };
}

export async function resolveRoomConsumer<T extends ConsumerCandidate>(
  agents: T[],
  authorize: (agentId: string) => Promise<unknown>,
): Promise<RoomConsumerSelection<T>> {
  const candidates = roomConsumerCandidates(agents);
  const authorizedIds = new Set<string>();
  await Promise.all(
    candidates.map(async (agent) => {
      try {
        await authorize(agent.id);
        authorizedIds.add(agent.id);
      } catch {
        /* Unavailable or foreign identity: fail closed. */
      }
    }),
  );
  return selectRoomConsumer(candidates, authorizedIds);
}
