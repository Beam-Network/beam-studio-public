import assert from "node:assert/strict";
import test from "node:test";
import { resolveRoomStorageApiKeyId } from "./room-storage-api-key.js";

test("room storage API key resolver returns a directly decryptable Studio key", async () => {
  const resolved = await resolveRoomStorageApiKeyId(
    { organizationId: "org_1", roomApiKeyId: "studio_key_1" },
    {
      decryptApiKey: async (apiKeyId) =>
        apiKeyId === "studio_key_1" ? "raw-secret" : null,
      listApiKeys: async () => {
        throw new Error("direct keys should not enumerate candidates");
      },
      resolveBillingKeyId: async () => {
        throw new Error("direct keys should not call billing verification");
      },
    },
  );

  assert.equal(resolved, "studio_key_1");
});

test("room storage API key resolver maps a Beam billing key id to a stored Studio credential", async () => {
  const resolved = await resolveRoomStorageApiKeyId(
    { organizationId: "org_1", roomApiKeyId: "beam_billing_key_1" },
    {
      decryptApiKey: async (apiKeyId) =>
        apiKeyId === "studio_key_2" ? "raw-secret-2" : null,
      listApiKeys: async () => [
        { id: "studio_key_1", secretAvailable: true },
        { id: "studio_key_2", secretAvailable: true },
      ],
      resolveBillingKeyId: async (rawApiKey) =>
        rawApiKey === "raw-secret-2" ? "beam_billing_key_1" : "other_key",
    },
  );

  assert.equal(resolved, "studio_key_2");
});

test("room storage API key resolver skips unavailable or rejected stored keys", async () => {
  const resolved = await resolveRoomStorageApiKeyId(
    { organizationId: "org_1", roomApiKeyId: "beam_billing_key_1" },
    {
      decryptApiKey: async (apiKeyId) =>
        apiKeyId === "studio_key_1"
          ? "bad-secret"
          : apiKeyId === "studio_key_3"
            ? "raw-secret-3"
            : null,
      listApiKeys: async () => [
        { id: "studio_key_0", secretAvailable: false },
        { id: "studio_key_1", secretAvailable: true },
        { id: "studio_key_2", secretAvailable: true },
        { id: "studio_key_3", secretAvailable: true },
      ],
      resolveBillingKeyId: async (rawApiKey) => {
        if (rawApiKey === "bad-secret") throw new Error("invalid key");
        return rawApiKey === "raw-secret-3"
          ? "beam_billing_key_1"
          : "other_key";
      },
    },
  );

  assert.equal(resolved, "studio_key_3");
});

test("room storage API key resolver rejects a unique available credential belonging to another payer", async () => {
  const resolved = await resolveRoomStorageApiKeyId(
    {
      organizationId: "org_1",
      roomApiKeyId: "external_beam_billing_key",
    },
    {
      decryptApiKey: async (apiKeyId) =>
        apiKeyId === "studio_prod_key"
          ? "raw-prod"
          : apiKeyId === "studio_dev_key"
            ? "raw-dev"
            : null,
      listApiKeys: async () => [
        { id: "studio_prod_key", secretAvailable: true },
        { id: "studio_dev_key", secretAvailable: true },
      ],
      resolveBillingKeyId: async (rawApiKey) =>
        rawApiKey === "raw-dev" ? "dev_key_id" : "prod_key_id",
    },
  );

  assert.equal(resolved, null);
});

test("room storage API key resolver rejects multiple credentials belonging to other payers", async () => {
  const resolved = await resolveRoomStorageApiKeyId(
    {
      organizationId: "org_1",
      roomApiKeyId: "external_beam_billing_key",
    },
    {
      decryptApiKey: async (apiKeyId) =>
        apiKeyId.startsWith("studio_dev_key") ? `raw-${apiKeyId}` : null,
      listApiKeys: async () => [
        { id: "studio_dev_key_1", secretAvailable: true },
        { id: "studio_dev_key_2", secretAvailable: true },
      ],
      resolveBillingKeyId: async (rawApiKey) => `${rawApiKey}-billing-id`,
    },
  );

  assert.equal(resolved, null);
});

test("room storage API key resolver returns null when no stored key matches", async () => {
  const resolved = await resolveRoomStorageApiKeyId(
    { organizationId: "org_1", roomApiKeyId: "beam_billing_key_missing" },
    {
      decryptApiKey: async (apiKeyId) =>
        apiKeyId === "studio_key_1" ? "raw-secret-1" : null,
      listApiKeys: async () => [{ id: "studio_key_1", secretAvailable: true }],
      resolveBillingKeyId: async () => "beam_billing_key_1",
    },
  );

  assert.equal(resolved, null);
});

test("room storage API key resolver cannot decrypt a foreign organization's matching credential", async () => {
  const requests: Array<[string, string]> = [];
  const resolved = await resolveRoomStorageApiKeyId(
    { organizationId: "org_1", roomApiKeyId: "foreign_studio_key" },
    {
      decryptApiKey: async (id, organizationId) => {
        requests.push([id, organizationId]);
        return organizationId === "org_2" ? "foreign-secret" : null;
      },
      listApiKeys: async (scope) => {
        assert.equal(scope.organizationId, "org_1");
        return [];
      },
    },
  );
  assert.equal(resolved, null);
  assert.deepEqual(requests, [["foreign_studio_key", "org_1"]]);
});

test("room storage API key resolver verifies keys against the room environment API", async () => {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return Response.json({ valid: true, keyId: "beam_billing_key_1" });
  }) as typeof fetch;
  try {
    const resolved = await resolveRoomStorageApiKeyId(
      { organizationId: "org_1", roomApiKeyId: "beam_billing_key_1", apiUrl: "https://api.dev.example" },
      {
        decryptApiKey: async (apiKeyId) => (apiKeyId === "studio_key_1" ? "raw-secret" : null),
        listApiKeys: async () => [{ id: "studio_key_1", secretAvailable: true }],
      },
    );
    assert.equal(resolved, "studio_key_1");
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(urls.length > 0 && urls.every((url) => url.startsWith("https://api.dev.example/")));
});
