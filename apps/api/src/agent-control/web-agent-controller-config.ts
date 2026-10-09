/** Instance administration stays in the API process environment. These values
 * are never serialized into a workflow snapshot, command, or browser response. */
export type WebAgentControllerBinding = {
  organizationId: string;
  roomId: string;
  agentId: string;
  memberId: string;
  url: string;
  origin: string;
  credential: string;
  channels: ReadonlyMap<string, string>;
};

const validId = /^[A-Za-z0-9_.:-]{1,160}$/;
const value = (input: unknown, name: string) => {
  if (typeof input !== "string" || !validId.test(input))
    throw new Error(`Invalid Web Agent controller ${name}.`);
  return input;
};

export function parseWebAgentControllerBindings(
  input = process.env.BEAM_STUDIO_WEB_AGENT_CONTROLLERS,
): readonly WebAgentControllerBinding[] {
  if (!input?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("BEAM_STUDIO_WEB_AGENT_CONTROLLERS must be JSON.");
  }
  if (!Array.isArray(parsed))
    throw new Error("BEAM_STUDIO_WEB_AGENT_CONTROLLERS must be an array.");
  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`Invalid Web Agent controller binding ${index}.`);
    const record = entry as Record<string, unknown>;
    const allowed = new Set([
      "organizationId", "roomId", "agentId", "memberId", "url",
      "origin", "credential", "channels",
    ]);
    if (Object.keys(record).some((key) => !allowed.has(key)))
      throw new Error(`Unknown Web Agent controller field at binding ${index}.`);
    const organizationId = value(record.organizationId, "organizationId");
    const roomId = value(record.roomId, "roomId");
    const agentId = value(record.agentId, "agentId");
    const memberId = value(record.memberId, "memberId");
    const key = `${organizationId}\0${roomId}`;
    if (seen.has(key))
      throw new Error("Duplicate Web Agent controller room binding.");
    seen.add(key);
    if (typeof record.url !== "string" || typeof record.origin !== "string")
      throw new Error("Web Agent controller URL and Origin are required.");
    const url = new URL(record.url);
    const origin = new URL(record.origin);
    const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      url.hostname,
    );
    if (
      (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) ||
      url.pathname !== "/v1/connect" || url.search || url.hash ||
      url.username || url.password ||
      !["https:", "http:"].includes(origin.protocol) ||
      origin.origin !== record.origin ||
      (origin.protocol === "http:" && !loopback)
    )
      throw new Error("Invalid Web Agent controller endpoint or Origin.");
    if (typeof record.credential !== "string" || record.credential.length < 32)
      throw new Error("Web Agent controller credential must have at least 32 characters.");
    if (!record.channels || typeof record.channels !== "object" || Array.isArray(record.channels))
      throw new Error("Web Agent controller channels must map members to channel IDs.");
    const channels = new Map<string, string>();
    for (const [recipient, channelId] of Object.entries(record.channels))
      channels.set(value(recipient, "recipientMemberId"), value(channelId, "controlChannelId"));
    if (
      !channels.size || channels.has(memberId) ||
      new Set(channels.values()).size !== channels.size
    )
      throw new Error("Web Agent controller requires pairwise recipient channels.");
    return Object.freeze({
      organizationId, roomId, agentId, memberId,
      url: url.toString(), origin: origin.origin,
      credential: record.credential, channels,
    });
  });
}

export function requireWebAgentControllerBinding(
  bindings: readonly WebAgentControllerBinding[],
  organizationId: string,
  roomId: string,
  recipientMemberId: string,
) {
  const binding = bindings.find(
    (candidate) =>
      candidate.organizationId === organizationId && candidate.roomId === roomId,
  );
  const controlChannelId = binding?.channels.get(recipientMemberId);
  if (!binding || !controlChannelId)
    throw Object.assign(new Error("No protected Web Agent channel is configured for this room member."), {
      code: "room_action_controller_unavailable",
      statusCode: 503,
    });
  return { binding, controlChannelId };
}
