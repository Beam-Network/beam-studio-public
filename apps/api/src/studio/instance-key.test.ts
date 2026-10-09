import assert from "node:assert/strict";
import test from "node:test";
import { InstanceKeyClient, InstanceKeyError } from "./instance-key-client.js";
import { InstanceKeyService, type InstanceKeyStore } from "./instance-key.js";

const ORG = "org_owner";
const INSTANCE = "5f0c7a52-8a3e-4b44-9a2f-0b1f5d2e9c11";

type Call = { method: string; url: string; headers: Headers; body: string };

/** A Beam that answers from a script of responses, recording every request. */
function fakeBeam(
  script: Record<string, Array<{ status: number; body?: unknown }>>,
) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: url.pathname,
      headers: new Headers(init?.headers),
      body: init?.body ? String(init.body) : "",
    });
    const next = script[`${method} ${url.pathname}`]?.shift();
    if (!next) throw new Error(`unexpected ${method} ${url.pathname}`);
    return new Response(
      next.body === undefined ? null : JSON.stringify(next.body),
      { status: next.status, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const client = new InstanceKeyClient({
    authUrl: "https://auth.example",
    apiUrl: "https://api.example",
    fetch: fetchImpl,
  });
  return { calls, client };
}

function memoryStore() {
  const state = {
    key: null as null | { credentialId: string; secret: string; name: string },
    stored: [] as Array<{ beamKeyId: string; secret: string }>,
    revoked: 0,
  };
  const store: InstanceKeyStore = {
    read: async () =>
      state.key
        ? {
            credentialId: state.key.credentialId,
            beamKeyId: "key_1",
            name: state.key.name,
            prefix: "b1m_abc",
            createdAt: "2026-09-29T00:00:00.000Z",
            updatedAt: "2026-09-29T00:00:00.000Z",
          }
        : null,
    store: async (input) => {
      state.stored.push({ beamKeyId: input.beamKeyId, secret: input.secret });
      const rotated = Boolean(state.key);
      state.key = {
        credentialId: state.key?.credentialId ?? "cred_instance",
        secret: input.secret,
        name: input.name,
      };
      return { credentialId: state.key.credentialId, rotated };
    },
    secret: async () =>
      state.key
        ? { credentialId: state.key.credentialId, secret: state.key.secret }
        : null,
    markRevoked: async () => {
      state.revoked += 1;
      state.key = null;
      return true;
    },
  };
  return { state, store };
}

const consent = {
  device_code: "device-1",
  user_code: "ABCD-EFGH",
  verification_uri: "https://auth.example/device",
  verification_uri_complete: "https://auth.example/device?code=ABCD-EFGH",
  expires_in: 600,
  interval: 5,
};

const minted = (overrides: Record<string, unknown> = {}) => ({
  apiKey: {
    id: "key_1",
    name: "Studio: studio.example.com",
    prefix: "b1m_abc",
    organizationId: ORG,
    studioInstanceId: INSTANCE,
    createdAt: "2026-09-29T00:00:00.000Z",
    ...overrides,
  },
  secret: "b1m_secret_value",
  rotated: false,
});

function service(beam: ReturnType<typeof fakeBeam>, store: InstanceKeyStore) {
  let now = 1_000_000;
  const instance = new InstanceKeyService({
    client: beam.client,
    store,
    now: () => now,
  });
  return { instance, advance: (ms: number) => (now += ms) };
}

async function started(instance: InstanceKeyService) {
  return instance.start({
    accessToken: "owner-session-token",
    organizationId: ORG,
    instanceId: INSTANCE,
    instanceName: "studio.example.com",
    userId: "user_owner",
  });
}

const owner = { organizationId: ORG, userId: "user_owner" };

test("consent is requested with the owner's session and the instance identity", async () => {
  const beam = fakeBeam({
    "POST /oauth/device/authorize": [{ status: 200, body: consent }],
  });
  const { instance } = service(beam, memoryStore().store);
  const start = await started(instance);

  assert.equal(start.userCode, "ABCD-EFGH");
  const [call] = beam.calls;
  assert.equal(
    call?.headers.get("authorization"),
    "Bearer owner-session-token",
  );
  const form = new URLSearchParams(call?.body);
  assert.equal(form.get("scope"), "studio:instance-key");
  assert.equal(form.get("client_id"), "beam-studio");
  assert.equal(form.get("organization_id"), ORG);
  assert.equal(form.get("instance_id"), INSTANCE);
  assert.equal(form.get("instance_name"), "studio.example.com");
});

test("an approved consent mints the key with the grant and stores it", async () => {
  const beam = fakeBeam({
    "POST /oauth/device/authorize": [{ status: 200, body: consent }],
    "POST /oauth/token": [
      { status: 400, body: { error: "authorization_pending" } },
      {
        status: 200,
        body: {
          access_token: "grant-jwt",
          token_type: "Bearer",
          expires_in: 300,
          scope: "studio:instance-key",
        },
      },
    ],
    [`PUT /api/studio/instances/${INSTANCE}/key`]: [
      { status: 200, body: minted() },
    ],
  });
  const memory = memoryStore();
  const { instance } = service(beam, memory.store);
  const { attemptId } = await started(instance);

  assert.equal(
    (await instance.poll(attemptId, owner)).status,
    "authorization_pending",
  );
  const result = await instance.poll(attemptId, owner);
  assert.equal(result.status, "connected");
  assert.deepEqual(memory.state.stored, [
    { beamKeyId: "key_1", secret: "b1m_secret_value" },
  ]);
  const mint = beam.calls.find((call) => call.method === "PUT");
  assert.equal(mint?.headers.get("authorization"), "Bearer grant-jwt");
  assert.deepEqual(JSON.parse(mint!.body), {
    instanceName: "studio.example.com",
  });
  // The grant is single-use: the attempt is over.
  await assert.rejects(instance.poll(attemptId, owner), {
    code: "instance_key_attempt_not_found",
  });
});

test("a second consent rotates the stored key", async () => {
  const approve = {
    status: 200,
    body: {
      access_token: "grant",
      expires_in: 300,
      scope: "studio:instance-key",
    },
  };
  const beam = fakeBeam({
    "POST /oauth/device/authorize": [
      { status: 200, body: consent },
      { status: 200, body: consent },
    ],
    "POST /oauth/token": [approve, approve],
    [`PUT /api/studio/instances/${INSTANCE}/key`]: [
      { status: 200, body: minted() },
      {
        status: 200,
        body: { ...minted(), secret: "b1m_rotated_secret", rotated: true },
      },
    ],
  });
  const memory = memoryStore();
  const { instance } = service(beam, memory.store);
  await instance.poll((await started(instance)).attemptId, owner);
  const rotation = await instance.poll(
    (await started(instance)).attemptId,
    owner,
  );

  assert.equal(rotation.status === "connected" && rotation.rotated, true);
  assert.equal(memory.state.key?.secret, "b1m_rotated_secret");
  assert.equal(memory.state.key?.credentialId, "cred_instance");
});

test("a replayed grant is refused and nothing is stored", async () => {
  const beam = fakeBeam({
    "POST /oauth/device/authorize": [{ status: 200, body: consent }],
    "POST /oauth/token": [
      {
        status: 200,
        body: {
          access_token: "grant",
          expires_in: 300,
          scope: "studio:instance-key",
        },
      },
    ],
    [`PUT /api/studio/instances/${INSTANCE}/key`]: [
      {
        status: 409,
        body: {
          success: false,
          code: "grant_already_used",
          error: "This grant was already used",
        },
      },
    ],
  });
  const memory = memoryStore();
  const { instance } = service(beam, memory.store);
  await assert.rejects(
    instance.poll((await started(instance)).attemptId, owner),
    (error: unknown) => {
      assert.ok(error instanceof InstanceKeyError);
      assert.equal(error.code, "grant_already_used");
      assert.match(error.message, /already used/);
      return true;
    },
  );
  assert.equal(memory.state.stored.length, 0);
});

test("an approver who lost the permission is told why", async () => {
  const beam = fakeBeam({
    "POST /oauth/device/authorize": [{ status: 200, body: consent }],
    "POST /oauth/token": [
      {
        status: 200,
        body: {
          access_token: "grant",
          expires_in: 300,
          scope: "studio:instance-key",
        },
      },
    ],
    [`PUT /api/studio/instances/${INSTANCE}/key`]: [
      {
        status: 403,
        body: {
          success: false,
          code: "permission_required",
          error: "Your role cannot create API keys",
        },
      },
    ],
  });
  const { instance } = service(beam, memoryStore().store);
  await assert.rejects(
    instance.poll((await started(instance)).attemptId, owner),
    { code: "permission_required", statusCode: 403 },
  );
});

test("a key for another organization or installation is revoked, never stored", async () => {
  for (const mismatch of [
    { organizationId: "org_other" },
    { studioInstanceId: "00000000-0000-4000-8000-000000000000" },
  ]) {
    const beam = fakeBeam({
      "POST /oauth/device/authorize": [{ status: 200, body: consent }],
      "POST /oauth/token": [
        {
          status: 200,
          body: {
            access_token: "grant",
            expires_in: 300,
            scope: "studio:instance-key",
          },
        },
      ],
      [`PUT /api/studio/instances/${INSTANCE}/key`]: [
        { status: 200, body: minted(mismatch) },
      ],
      "DELETE /v1/studio/instance-key": [{ status: 204 }],
    });
    const memory = memoryStore();
    const { instance } = service(beam, memory.store);
    await assert.rejects(
      instance.poll((await started(instance)).attemptId, owner),
      { code: "instance_key_mismatch" },
    );
    assert.equal(memory.state.stored.length, 0);
    const revoke = beam.calls.find((call) => call.method === "DELETE");
    assert.equal(
      revoke?.headers.get("authorization"),
      "Bearer b1m_secret_value",
    );
  }
});

test("only the owner who started the consent can finish it", async () => {
  const beam = fakeBeam({
    "POST /oauth/device/authorize": [{ status: 200, body: consent }],
  });
  const { instance } = service(beam, memoryStore().store);
  const { attemptId } = await started(instance);
  await assert.rejects(
    instance.poll(attemptId, { organizationId: ORG, userId: "someone_else" }),
    { code: "instance_key_attempt_not_found" },
  );
});

test("an expired consent is refused without asking Beam", async () => {
  const beam = fakeBeam({
    "POST /oauth/device/authorize": [{ status: 200, body: consent }],
  });
  const { instance, advance } = service(beam, memoryStore().store);
  const { attemptId } = await started(instance);
  advance(601_000);
  await assert.rejects(instance.poll(attemptId, owner), {
    code: "expired_token",
  });
  assert.equal(beam.calls.length, 1);
});

test("revoking uses the key itself, then marks it revoked here", async () => {
  const beam = fakeBeam({
    "DELETE /v1/studio/instance-key": [{ status: 204 }],
  });
  const memory = memoryStore();
  memory.state.key = {
    credentialId: "cred_instance",
    secret: "b1m_live",
    name: "Studio: studio.example.com",
  };
  const { instance } = service(beam, memory.store);
  assert.deepEqual(await instance.revoke(ORG), { revoked: true });
  assert.equal(beam.calls[0]?.headers.get("authorization"), "Bearer b1m_live");
  assert.equal(memory.state.revoked, 1);
});

test("a key Beam no longer accepts is still marked revoked here", async () => {
  const beam = fakeBeam({
    "DELETE /v1/studio/instance-key": [{ status: 401 }],
  });
  const memory = memoryStore();
  memory.state.key = { credentialId: "c", secret: "b1m_gone", name: "k" };
  const { instance } = service(beam, memory.store);
  assert.deepEqual(await instance.revoke(ORG), { revoked: true });
  assert.equal(memory.state.revoked, 1);
});

test("a revocation Beam cannot confirm leaves the key in place", async () => {
  const beam = fakeBeam({
    "DELETE /v1/studio/instance-key": [{ status: 503, body: {} }],
  });
  const memory = memoryStore();
  memory.state.key = { credentialId: "c", secret: "b1m_live", name: "k" };
  const { instance } = service(beam, memory.store);
  await assert.rejects(instance.revoke(ORG), { statusCode: 503 });
  assert.equal(memory.state.revoked, 0);
});

test("a denied consent is reported in Beam Auth's words", async () => {
  const beam = fakeBeam({
    "POST /oauth/device/authorize": [{ status: 200, body: consent }],
    "POST /oauth/token": [
      {
        status: 400,
        body: { error: "access_denied", error_description: "Denied" },
      },
    ],
  });
  const { instance } = service(beam, memoryStore().store);
  await assert.rejects(
    instance.poll((await started(instance)).attemptId, owner),
    { code: "access_denied", message: "The request was denied in Beam Auth." },
  );
});

test("a replaced secret cannot revoke the current key", async () => {
  const beam = fakeBeam({
    "DELETE /v1/studio/instance-key": [
      {
        status: 403,
        body: {
          success: false,
          code: "not_current_key",
          error: "Revoke with the key's current secret",
        },
      },
    ],
  });
  const memory = memoryStore();
  memory.state.key = { credentialId: "c", secret: "b1m_old", name: "k" };
  const { instance } = service(beam, memory.store);
  await assert.rejects(instance.revoke(ORG), {
    code: "not_current_key",
    message: "Revoke with the key's current secret",
  });
  assert.equal(memory.state.revoked, 0);
});

test("nothing to revoke is not an error", async () => {
  const beam = fakeBeam({});
  const { instance } = service(beam, memoryStore().store);
  assert.deepEqual(await instance.revoke(ORG), { revoked: false });
  assert.equal(beam.calls.length, 0);
});
