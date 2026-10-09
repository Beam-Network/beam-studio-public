import type { FastifyRequest } from "fastify";
import type { BeamEnvironmentTemplate } from "@beam-studio/shared";
import { studioRequestAuth } from "../auth/request-context.js";
import {
  defaultBillingApiKeyId,
  getDecryptedApiKey,
  listBillingApiKeys,
} from "../studio/store.js";
import { webEnv } from "../env.js";
import { CoordinatorRoomClient } from "./coordinator-client.js";

// One client per Coordinator: the client caches delegations by bearer
// fingerprint, so different users or keys never share a delegation.
const clients = new Map<string, CoordinatorRoomClient>();

/** Clears cached Coordinator clients (tests construct them with a stub fetch). */
export function resetRoomServiceClients() {
  clients.clear();
}

function coordinatorClient(coordinatorUrl: string) {
  let client = clients.get(coordinatorUrl);
  if (!client) {
    client = new CoordinatorRoomClient(coordinatorUrl);
    clients.set(coordinatorUrl, client);
  }
  return client;
}

/** Coordinator access for a user-initiated request uses the user's own Beam
 * Auth session bearer, so the Coordinator authorizes the acting user rather
 * than a static service credential. */
export async function roomServiceForRequest(
  request: FastifyRequest,
  template: Pick<BeamEnvironmentTemplate, "coordinatorUrl">,
) {
  const token = await studioRequestAuth(request).oauth.getAccessToken();
  return { client: coordinatorClient(template.coordinatorUrl), token };
}

/**
 * Coordinator access for work without a user session (V3 resolution,
 * execution authorization, controller provisioning, transfer evidence,
 * storage jobs, consumer bootstrap). Studio delegates with an organization
 * Beam API key it already holds; the Coordinator verifies the key and its
 * organization. Callers pass the key bound to their context (run execution
 * key, storage job key); otherwise the organization's default billing key,
 * then its first active stored key, is used. There is no static credential.
 */
export async function roomServiceForOrganization(
  organizationId: string,
  template: Pick<BeamEnvironmentTemplate, "key" | "coordinatorUrl">,
  apiKeyId?: string | null,
) {
  const client = coordinatorClient(template.coordinatorUrl);
  const explicit = apiKeyId?.trim() || null;
  const keys = (await listBillingApiKeys({ organizationId })).filter(
    (key) => key.status === "ACTIVE" && key.secretAvailable !== false,
  );
  const environments = new Map(keys.map((key) => [key.id, key.environment]));
  // A key stored for another Beam environment never controls this room.
  const scoped = (id: string) => {
    const environment = environments.get(id);
    return !environment || !["dev", "prod"].includes(template.key) || environment === template.key;
  };
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  const preferred = await defaultBillingApiKeyId(organizationId);
  if (preferred && scoped(preferred)) candidates.push(preferred);
  for (const key of keys) if (key.environment === template.key) candidates.push(key.id);
  for (const key of keys) if (key.environment !== template.key && scoped(key.id)) candidates.push(key.id);
  for (const candidate of new Set(candidates)) {
    const token = await getDecryptedApiKey(candidate, organizationId);
    if (!token) continue;
    // The caller's bound key is authoritative; fallbacks must be accepted by
    // this Coordinator for this organization before they control the room.
    if (candidate !== explicit && !(await client.acceptsOrganizationKey(organizationId, token))) continue;
    return { client, token, apiKeyId: candidate };
  }
  throw roomAuthorityKeyUnavailable(template.key);
}

export function roomAuthorityKeyUnavailable(templateKey: string) {
  return Object.assign(
    new Error(
      webEnv.instanceKeyEnabled
        ? "Room control needs this Studio's instance key. Approve it under Settings → Access."
        : "Room control needs an organization Beam API key. Add one under Credentials → New credentials → Beam.",
    ),
    {
      code: "room_authority_key_unavailable",
      details: { templateKey },
      expose: true,
      retryable: false,
      statusCode: 503,
    },
  );
}
