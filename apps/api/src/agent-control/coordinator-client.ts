import { createHash } from "node:crypto";

const snapshotReadScopes = [
  "rooms:list",
  "room:read",
  "room:memberships:read",
  "room:roles:read",
  "room:channels:read",
  "room:invitations:read",
  "room:grants:read",
] as const;

type JsonObject = Record<string, unknown>;

type Delegation = {
  accessToken: string;
  expiresAt: number;
  organizationId: string;
};

export class CoordinatorRoomClient {
  private readonly delegations = new Map<string, Delegation>();

  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly requestTimeoutMs = 10_000,
  ) {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
      throw new Error(
        "Coordinator URLs must use HTTPS outside loopback; use https://coordinator.b1m.ai.",
      );
    }
    this.baseUrl = url.toString().replace(/\/$/, "");
  }

  get url() {
    return this.baseUrl;
  }

  async createAgentEnrollment(
    organizationId: string,
    label: string,
    publicKeyFingerprint: string,
    accessToken: string,
  ) {
    const response = await this.request<{
      enrollment_id?: string;
      enrollment_token?: string;
      expires_at?: string;
    }>("/v1/agent-enrollments", accessToken, {
      method: "POST",
      body: JSON.stringify({
        label,
        public_key_fingerprint: publicKeyFingerprint,
      }),
      headers: { "X-Beam-Organization-ID": organizationId },
    });
    if (!response.enrollment_id || !response.enrollment_token) {
      throw new CoordinatorRoomError(
        "Coordinator returned an invalid agent enrollment.",
        502,
        "coordinator_agent_enrollment_invalid",
      );
    }
    return response as {
      enrollment_id: string;
      enrollment_token: string;
      expires_at?: string;
    };
  }

  async listRooms(
    organizationId: string,
    agentId: string,
    accessToken: string,
  ) {
    const delegation = await this.delegation(
      organizationId,
      agentId,
      ["rooms:list"],
      accessToken,
    );
    return this.request<{ rooms?: JsonObject[] }>(
      "/studio/v1/rooms",
      delegation.accessToken,
    );
  }

  async listOrganizationRooms(organizationId: string, accessToken: string) {
    const delegation = await this.delegation(
      organizationId,
      null,
      ["rooms:list"],
      accessToken,
    );
    return this.request<{ rooms?: JsonObject[] }>(
      "/studio/v1/rooms",
      delegation.accessToken,
    );
  }

  async attachOrganizationRoomConsumer(
    organizationId: string,
    roomId: string,
    agentId: string,
    idempotencyKey: string,
    accessToken: string,
  ) {
    const delegation = await this.delegation(
      organizationId,
      null,
      ["room:memberships:write"],
      accessToken,
    );
    return this.request<JsonObject>(
      `/studio/v1/rooms/${encodeURIComponent(roomId)}/consumers/${encodeURIComponent(agentId)}`,
      delegation.accessToken,
      {
        method: "PUT",
        body: "{}",
        headers: { "Idempotency-Key": idempotencyKey },
      },
    );
  }

  async attachOrganizationRoomStorage(
    organizationId: string,
    roomId: string,
    resource: {
      resourceId: string;
      displayName: string;
      objectCapabilities: string[];
      available: boolean;
    },
    idempotencyKey: string,
    accessToken: string,
  ) {
    const delegation = await this.delegation(
      organizationId,
      null,
      ["room:memberships:write"],
      accessToken,
    );
    return this.request<{ membership?: JsonObject; created?: boolean }>(
      `/studio/v1/rooms/${encodeURIComponent(roomId)}/storage-members`,
      delegation.accessToken,
      {
        method: "POST",
        body: JSON.stringify({
          resource_id: resource.resourceId,
          display_name: resource.displayName,
          object_capabilities: resource.objectCapabilities,
          available: resource.available,
        }),
        headers: { "Idempotency-Key": idempotencyKey },
      },
    );
  }

  async roomSnapshot(
    organizationId: string,
    agentId: string,
    roomId: string,
    accessToken: string,
  ) {
    const delegation = await this.delegation(
      organizationId,
      agentId,
      snapshotReadScopes,
      accessToken,
    );
    return this.request<JsonObject>(
      `/studio/v1/rooms/${encodeURIComponent(roomId)}/snapshot`,
      delegation.accessToken,
    );
  }

  async organizationRoomSnapshot(
    organizationId: string,
    roomId: string,
    accessToken: string,
    freshAuthorization = false,
  ) {
    const delegation = await this.delegation(
      organizationId,
      null,
      snapshotReadScopes,
      accessToken,
      freshAuthorization,
    );
    return this.request<JsonObject>(
      `/studio/v1/rooms/${encodeURIComponent(roomId)}/snapshot`,
      delegation.accessToken,
    );
  }

  async listRoomObjects(
    organizationId: string,
    agentId: string,
    roomId: string,
    channelId: string,
    accessToken: string,
  ) {
    const delegation = await this.delegation(
      organizationId,
      agentId,
      ["room:objects:read"],
      accessToken,
    );
    return this.request<{ objects?: JsonObject[] }>(
      `/studio/v1/rooms/${encodeURIComponent(roomId)}/channels/${encodeURIComponent(channelId)}/objects`,
      delegation.accessToken,
    );
  }

  async organizationObjectStatus(
    organizationId: string,
    roomId: string,
    channelId: string,
    publicationId: string,
    accessToken: string,
  ) {
    const delegation = await this.delegation(
      organizationId,
      null,
      ["room:objects:read"],
      accessToken,
    );
    return this.request<JsonObject>(
      `/studio/v1/rooms/${encodeURIComponent(roomId)}/channels/${encodeURIComponent(channelId)}/objects/${encodeURIComponent(publicationId)}`,
      delegation.accessToken,
    );
  }

  async startOrganizationStorageTransfer(
    organizationId: string,
    roomId: string,
    channelId: string,
    input: JsonObject,
    idempotencyKey: string,
    accessToken: string,
  ) {
    const delegation = await this.delegation(
      organizationId,
      null,
      ["room:objects:publish"],
      accessToken,
    );
    return this.request<JsonObject>(
      `/studio/v1/rooms/${encodeURIComponent(roomId)}/channels/${encodeURIComponent(channelId)}/storage-transfers`,
      delegation.accessToken,
      {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "Idempotency-Key": idempotencyKey },
      },
    );
  }

  async cancelOrganizationStorageTransfer(
    organizationId: string,
    roomId: string,
    channelId: string,
    publicationId: string,
    idempotencyKey: string,
    accessToken: string,
  ) {
    const delegation = await this.delegation(
      organizationId,
      null,
      ["room:objects:publish"],
      accessToken,
    );
    return this.request<JsonObject>(
      `/studio/v1/rooms/${encodeURIComponent(roomId)}/channels/${encodeURIComponent(channelId)}/storage-transfers/${encodeURIComponent(publicationId)}/cancel`,
      delegation.accessToken,
      {
        method: "POST",
        body: "{}",
        headers: { "Idempotency-Key": idempotencyKey },
      },
    );
  }

  async storageControl(
    organizationId: string,
    roomId: string,
    channelId: string,
    publicationId: string | null,
    operation: "plan" | "authorize-route" | "audit" | "finalize",
    input: JsonObject,
    accessToken: string,
  ) {
    const delegation = await this.delegation(
      organizationId,
      null,
      ["room:objects:publish"],
      accessToken,
    );
    const path = publicationId
      ? encodeURIComponent(publicationId) + "/" + operation
      : operation;
    return this.request<JsonObject>(
      `/studio/v1/rooms/${encodeURIComponent(roomId)}/channels/${encodeURIComponent(channelId)}/storage-transfers/${path}`,
      delegation.accessToken,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  async organizationObjectExecution(
    organizationId: string,
    roomId: string,
    channelId: string,
    publicationId: string,
    accessToken: string,
  ) {
    const delegation = await this.delegation(
      organizationId,
      null,
      ["room:objects:read"],
      accessToken,
    );
    return this.request<JsonObject>(
      `/studio/v1/rooms/${encodeURIComponent(roomId)}/channels/${encodeURIComponent(channelId)}/objects/${encodeURIComponent(publicationId)}/execution`,
      delegation.accessToken,
    );
  }

  async listOrganizationRoomTransfers(
    organizationId: string,
    roomId: string,
    channelId: string | null,
    accessToken: string,
  ) {
    const delegation = await this.delegation(
      organizationId,
      null,
      ["room:objects:read"],
      accessToken,
    );
    return this.request<{ transfers?: JsonObject[] }>(
      channelId
        ? `/studio/v1/rooms/${encodeURIComponent(roomId)}/channels/${encodeURIComponent(channelId)}/transfers`
        : `/studio/v1/rooms/${encodeURIComponent(roomId)}/transfers`,
      delegation.accessToken,
    );
  }

  async mutateRoom(
    organizationId: string,
    agentId: string,
    operation: string,
    payload: JsonObject,
    idempotencyKey: string,
    accessToken: string,
  ) {
    const mutation = roomMutation(operation, payload);
    const delegation = await this.delegation(
      organizationId,
      agentId,
      [mutation.scope],
      accessToken,
    );
    const result = await this.request<JsonObject>(
      mutation.path,
      delegation.accessToken,
      {
        method: mutation.method,
        body: JSON.stringify(mutation.body),
        headers: { "Idempotency-Key": idempotencyKey },
      },
    );
    return normalizeMutationResult(operation, result);
  }

  async mutateOrganizationRoom(
    organizationId: string,
    operation: string,
    payload: JsonObject,
    idempotencyKey: string,
    accessToken: string,
    /**
     * Beam API key to charge the room to. Starting a room is billable, and the
     * coordinator refuses a create that names no key: an organization may hold
     * several keys with different caps, so the payer is explicit.
     */
    apiKey?: string | null,
  ) {
    const mutation = roomMutation(operation, payload);
    const delegation = await this.delegation(
      organizationId,
      null,
      [mutation.scope],
      accessToken,
    );
    const result = await this.request<JsonObject>(
      mutation.path,
      delegation.accessToken,
      {
        method: mutation.method,
        body: JSON.stringify(mutation.body),
        headers: {
          "Idempotency-Key": idempotencyKey,
          ...(apiKey ? { "X-Api-Key": apiKey } : {}),
        },
      },
    );
    return normalizeMutationResult(operation, result);
  }

  /** Whether this Coordinator delegates organization room authority to the key. */
  async acceptsOrganizationKey(organizationId: string, accessToken: string) {
    try {
      await this.delegation(organizationId, null, ["rooms:list"], accessToken);
      return true;
    } catch (error) {
      if (error instanceof CoordinatorRoomError && [401, 403].includes(error.statusCode)) return false;
      throw error;
    }
  }

  private async delegation(
    organizationId: string,
    agentId: string | null,
    scopes: readonly string[],
    accessToken: string,
    freshAuthorization = false,
  ) {
    const requestedScopes = [...new Set(scopes)].sort();
    const cacheKey = `${organizationId}:${agentId ?? "organization"}:${requestedScopes.join(",")}:${tokenFingerprint(accessToken)}`;
    const cached = this.delegations.get(cacheKey);
    if (!freshAuthorization && cached && cached.expiresAt - Date.now() > 15_000)
      return cached;

    const response = await this.request<{
      access_token?: string;
      expires_in?: number;
      organization_id?: string;
    }>("/studio/v1/delegations", accessToken, {
      method: "POST",
      body: JSON.stringify({
        ...(agentId ? { agent_id: agentId } : {}),
        scopes: requestedScopes,
        ttl_seconds: 120,
      }),
      headers: {
        "X-Beam-Organization-ID": organizationId,
        ...(agentId ? { "X-Beam-Agent-ID": agentId } : {}),
      },
    });
    if (
      !response.access_token ||
      response.organization_id !== organizationId ||
      !Number.isFinite(response.expires_in)
    ) {
      throw new CoordinatorRoomError(
        "Coordinator returned an invalid Studio delegation.",
        502,
        "coordinator_delegation_invalid",
      );
    }
    const delegation = {
      accessToken: response.access_token,
      expiresAt: Date.now() + Number(response.expires_in) * 1_000,
      organizationId,
    };
    // Per-user session bearers each get their own entry; drop expired ones so
    // the cache stays bounded by concurrently active users.
    for (const [key, entry] of this.delegations)
      if (entry.expiresAt <= Date.now()) this.delegations.delete(key);
    this.delegations.set(cacheKey, delegation);
    return delegation;
  }

  private async request<T>(
    path: string,
    token: string,
    init: RequestInit = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
        redirect: "error",
        signal: controller.signal,
      });
      const body = await response.text();
      if (body.length > 2 * 1024 * 1024) {
        throw new CoordinatorRoomError(
          "Coordinator response exceeded the Studio limit.",
          502,
          "coordinator_response_too_large",
        );
      }
      const payload = parseObject(body);
      if (!response.ok) {
        throw new CoordinatorRoomError(
          stringValue(payload.error) ??
            `Coordinator request failed with status ${response.status}.`,
          response.status >= 500 ? 502 : response.status,
          stringValue(payload.code) ?? "coordinator_request_failed",
        );
      }
      return payload as T;
    } catch (error) {
      if (error instanceof CoordinatorRoomError) throw error;
      throw new CoordinatorRoomError(
        error instanceof Error && error.name === "AbortError"
          ? "Coordinator request timed out."
          : "Coordinator is unavailable.",
        503,
        "coordinator_unavailable",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function roomMutation(operation: string, payload: JsonObject) {
  const roomId = optionalString(payload.room_id);
  const channelId = optionalString(payload.channel_id);
  const roleId = optionalString(payload.role_id);
  const memberId = optionalString(payload.member_id);
  const grantId = optionalString(payload.grant_id);
  const invitationId = optionalString(payload.invitation_id);
  const roomPath = roomId
    ? `/studio/v1/rooms/${encodeURIComponent(roomId)}`
    : "";
  switch (operation) {
    case "room.create":
      return mutation("room:create", "POST", "/studio/v1/rooms", payload);
    case "room.close":
      return mutation(
        "room:close",
        "POST",
        `${requiredPath(roomPath, "room_id")}/close`,
        withoutIdentifiers(payload),
      );
    case "room.invitation.create":
      return mutation(
        "room:invitations:write",
        "POST",
        `${requiredPath(roomPath, "room_id")}/invitations`,
        withoutIdentifiers(payload),
      );
    case "room.invitation.revoke":
      return mutation(
        "room:invitations:write",
        "DELETE",
        `${requiredPath(roomPath, "room_id")}/invitations/${encodeURIComponent(requiredValue(invitationId, "invitation_id"))}`,
        withoutIdentifiers(payload),
      );
    case "room.membership.remove":
      return mutation(
        "room:memberships:write",
        "DELETE",
        `${requiredPath(roomPath, "room_id")}/memberships/${encodeURIComponent(requiredValue(memberId, "member_id"))}`,
        withoutIdentifiers(payload),
      );
    case "room.role.create":
      return mutation(
        "room:roles:write",
        "POST",
        `${requiredPath(roomPath, "room_id")}/roles`,
        withoutIdentifiers(payload),
      );
    case "room.role.assign":
    case "room.role.revoke":
      return mutation(
        "room:roles:write",
        operation.endsWith("revoke") ? "DELETE" : "PUT",
        `${requiredPath(roomPath, "room_id")}/roles/${encodeURIComponent(requiredValue(roleId, "role_id"))}/members/${encodeURIComponent(requiredValue(memberId, "member_id"))}`,
        withoutIdentifiers(payload),
      );
    case "room.role.delete":
      return mutation(
        "room:roles:write",
        "DELETE",
        `${requiredPath(roomPath, "room_id")}/roles/${encodeURIComponent(requiredValue(roleId, "role_id"))}`,
        withoutIdentifiers(payload),
      );
    case "room.channel.create":
      return mutation(
        "room:channels:write",
        "POST",
        `${requiredPath(roomPath, "room_id")}/channels`,
        withoutIdentifiers(payload),
      );
    case "room.channel.activate":
      return mutation(
        "room:channels:write",
        "POST",
        `${requiredPath(roomPath, "room_id")}/channels/${encodeURIComponent(requiredValue(channelId, "channel_id"))}/key-epoch`,
        withoutIdentifiers(payload),
      );
    case "room.channel.update":
    case "room.channel.close":
      return mutation(
        "room:channels:write",
        "POST",
        `${requiredPath(roomPath, "room_id")}/channels/${encodeURIComponent(requiredValue(channelId, "channel_id"))}/${operation.endsWith("close") ? "close" : "policy"}`,
        withoutIdentifiers(payload),
      );
    case "room.grant.put":
      return mutation(
        "room:grants:write",
        "PUT",
        `${requiredPath(roomPath, "room_id")}/channels/${encodeURIComponent(requiredValue(channelId, "channel_id"))}/grants`,
        withoutIdentifiers(payload),
      );
    case "room.grant.revoke":
      return mutation(
        "room:grants:write",
        "DELETE",
        `${requiredPath(roomPath, "room_id")}/channels/${encodeURIComponent(requiredValue(channelId, "channel_id"))}/grants/${encodeURIComponent(requiredValue(grantId, "grant_id"))}`,
        withoutIdentifiers(payload),
      );
    default:
      throw new CoordinatorRoomError(
        `Studio delegation does not support ${operation}.`,
        400,
        "coordinator_operation_unsupported",
      );
  }
}

function mutation(
  scope: string,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body: JsonObject,
) {
  return { scope, method, path, body };
}

function normalizeMutationResult(operation: string, result: JsonObject) {
  if (operation === "room.create") {
    return {
      room: {
        room: recordValue(result.room),
        membership: recordValue(result.owner_membership),
      },
    };
  }
  if (operation === "room.close") {
    return { room: { room: recordValue(result.room) } };
  }
  if (operation === "room.invitation.create") {
    return { invitation: result };
  }
  return result;
}

function withoutIdentifiers(payload: JsonObject) {
  const {
    room_id: _roomId,
    channel_id: _channelId,
    role_id: _roleId,
    member_id: _memberId,
    grant_id: _grantId,
    invitation_id: _invitationId,
    ...body
  } = payload;
  return body;
}

function requiredPath(value: string, name: string) {
  if (!value) throw invalidMutation(name);
  return value;
}

function requiredValue(value: string | null, name: string) {
  if (!value) throw invalidMutation(name);
  return value;
}

function invalidMutation(name: string) {
  return new CoordinatorRoomError(
    `${name} is required for the delegated mutation.`,
    400,
    "coordinator_mutation_invalid",
  );
}

export class CoordinatorRoomError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
  }
}

function parseObject(value: string): JsonObject {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    return {};
  }
}

function recordValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isLoopback(hostname: string) {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

function tokenFingerprint(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}
