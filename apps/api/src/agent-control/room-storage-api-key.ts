import { createCreditClient } from "../billing/credit-client.js";
import { getDecryptedApiKey, listBillingApiKeys } from "../studio/store.js";

type BillingKeyCandidate = {
  id: string;
  secretAvailable?: boolean | null;
};

type ResolverDependencies = {
  decryptApiKey?: (
    apiKeyId: string,
    organizationId: string,
  ) => Promise<string | null | undefined>;
  listApiKeys?: (filters: {
    organizationId: string;
  }) => Promise<BillingKeyCandidate[]>;
  resolveBillingKeyId?: (rawApiKey: string) => Promise<string>;
};

/**
 * Room snapshots expose the Beam billing key id. Studio storage jobs need the
 * local credential id because only that id can be decrypted when the job runs.
 * Direct Studio-created rooms already store the local id; public CLI-created
 * rooms store Beam's key id and are resolved by verifying the organization's
 * stored Beam API credentials without exposing the secret to the room path.
 */
export async function resolveRoomStorageApiKeyId(
  input: {
    organizationId: string;
    roomApiKeyId: string;
    /** The room's Beam environment website API; keys verify only there. */
    apiUrl?: string;
  },
  dependencies: ResolverDependencies = {},
): Promise<string | null> {
  const organizationId = input.organizationId.trim();
  const roomApiKeyId = input.roomApiKeyId.trim();
  if (!organizationId || !roomApiKeyId) return null;

  const decryptApiKey = dependencies.decryptApiKey ?? getDecryptedApiKey;
  const directSecret = await decryptApiKey(roomApiKeyId, organizationId);
  if (directSecret) return roomApiKeyId;

  const listApiKeys = dependencies.listApiKeys ?? listBillingApiKeys;
  const resolveBillingKeyId =
    dependencies.resolveBillingKeyId ??
    ((rawApiKey: string) => createCreditClient(globalThis.fetch, input.apiUrl || undefined).resolveKeyId(rawApiKey));

  const candidates = await listApiKeys({ organizationId });
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const candidateId = candidate.id.trim();
    if (!candidateId || candidate.secretAvailable === false) continue;
    if (seen.has(candidateId)) continue;
    seen.add(candidateId);

    const rawApiKey = await decryptApiKey(candidateId, organizationId);
    if (!rawApiKey) continue;

    try {
      const billingKeyId = await resolveBillingKeyId(rawApiKey);
      if (billingKeyId === roomApiKeyId) return candidateId;
    } catch {
      // Invalid, spent, or currently unreachable billing keys are not usable
      // for this room. Continue so another stored key can satisfy the room.
    }
  }

  return null;
}
