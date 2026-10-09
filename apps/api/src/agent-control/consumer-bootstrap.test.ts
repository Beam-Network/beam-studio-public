import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import { registerAgentControlRoutes } from "./routes.js";
import { registerStudioAuthKernel } from "../auth/request-context.js";
import { roomAuthorityKeyUnavailable } from "./room-service.js";
import type { ConsumerInstanceReader } from "./consumer-bootstrap.js";

const SECRET = "consumer-bootstrap-secret";
const FINGERPRINT = "a".repeat(64);

type Harness = {
  instance?: ConsumerInstanceReader;
  consumerOrganizationId?: string;
  sharedSecret?: string;
  hasKey?: boolean;
};

async function bootstrapServer(t: TestContext, harness: Harness) {
  const previous = {
    secret: process.env.BEAM_STUDIO_SHARED_SECRET,
    organization: process.env.BEAM_STUDIO_CONSUMER_ORGANIZATION_ID,
  };
  process.env.BEAM_STUDIO_SHARED_SECRET = harness.sharedSecret ?? SECRET;
  if (harness.consumerOrganizationId === undefined)
    delete process.env.BEAM_STUDIO_CONSUMER_ORGANIZATION_ID;
  else
    process.env.BEAM_STUDIO_CONSUMER_ORGANIZATION_ID =
      harness.consumerOrganizationId;
  t.after(() => {
    for (const [name, value] of [
      ["BEAM_STUDIO_SHARED_SECRET", previous.secret],
      ["BEAM_STUDIO_CONSUMER_ORGANIZATION_ID", previous.organization],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const calls = {
    enrollments: [] as string[],
    coordinator: [] as string[],
    roomService: [] as string[],
  };
  const server = Fastify();
  t.after(() => server.close());
  registerStudioAuthKernel(server, { get: () => null } as never);
  await registerAgentControlRoutes(server, {
    repository: {
      createEnrollment: async (input: { organizationId: string }) => {
        calls.enrollments.push(input.organizationId);
        return { code: "studio-code", expiresAt: "2026-09-28T00:00:00.000Z" };
      },
    },
    gateway: {},
    instance: harness.instance,
    consumerRoomService: async (organizationId: string) => {
      calls.roomService.push(organizationId);
      if (harness.hasKey === false) throw roomAuthorityKeyUnavailable("prod");
      return {
        token: "org-api-key",
        apiKeyId: "key-1",
        client: {
          url: "https://coordinator.test",
          createAgentEnrollment: async (organization: string) => {
            calls.coordinator.push(organization);
            return { enrollment_token: "coordinator-token" };
          },
        },
      };
    },
  } as unknown as Parameters<typeof registerAgentControlRoutes>[1]);

  const bootstrap = (secret = SECRET) =>
    server.inject({
      method: "POST",
      url: "/agent-control/v1/bootstrap",
      headers: { authorization: `Bearer ${secret}` },
      payload: { publicKeyFingerprint: FINGERPRINT },
    });
  return { bootstrap, calls };
}

const claimedBy =
  (owner: string): ConsumerInstanceReader =>
  async () => ({ state: "claimed", ownerOrganizationId: owner });

test("the configured consumer organization overrides the instance owner", async (t) => {
  let instanceReads = 0;
  const { bootstrap, calls } = await bootstrapServer(t, {
    consumerOrganizationId: "org_hosted",
    instance: async () => {
      instanceReads += 1;
      return { state: "claimed", ownerOrganizationId: "org_owner" };
    },
  });
  const response = await bootstrap();
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().organizationId, "org_hosted");
  assert.equal(response.json().coordinatorEnrollmentToken, "coordinator-token");
  assert.deepEqual(calls.enrollments, ["org_hosted"]);
  assert.deepEqual(calls.coordinator, ["org_hosted"]);
  assert.equal(instanceReads, 0, "the override needs no instance record");
});

test("without a configured organization the consumer enrolls for the instance owner", async (t) => {
  const { bootstrap, calls } = await bootstrapServer(t, {
    instance: claimedBy("org_owner"),
  });
  const response = await bootstrap();
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().organizationId, "org_owner");
  assert.equal(response.json().studioEnrollmentCode, "studio-code");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(calls.enrollments, ["org_owner"]);
  assert.deepEqual(calls.coordinator, ["org_owner"]);
});

test("a blank configured organization falls back to the instance owner", async (t) => {
  const { bootstrap } = await bootstrapServer(t, {
    consumerOrganizationId: "  ",
    instance: claimedBy("org_owner"),
  });
  const response = await bootstrap();
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().organizationId, "org_owner");
});

for (const instance of [
  { state: "unclaimed", ownerOrganizationId: null },
  // Adopted from before instance ownership: served, but nobody owns it yet.
  { state: "adopted", ownerOrganizationId: null },
] as const) {
  test(`an ${instance.state} instance with no owner answers 503 instance_unclaimed`, async (t) => {
    const { bootstrap, calls } = await bootstrapServer(t, {
      instance: async () => instance,
    });
    const response = await bootstrap();
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, "instance_unclaimed");
    assert.equal(response.json().retryable, true);
    assert.deepEqual(calls.enrollments, []);
    assert.deepEqual(calls.roomService, []);
  });
}

test("an organization without a stored Beam API key answers a retryable 503", async (t) => {
  const { bootstrap, calls } = await bootstrapServer(t, {
    instance: claimedBy("org_owner"),
    hasKey: false,
  });
  const response = await bootstrap();
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, "room_authority_key_unavailable");
  assert.equal(response.json().retryable, true);
  assert.deepEqual(calls.roomService, ["org_owner"]);
  assert.deepEqual(calls.enrollments, [], "no enrollment is created");
});

test("a wrong shared secret is rejected before the instance is read", async (t) => {
  let instanceReads = 0;
  const { bootstrap, calls } = await bootstrapServer(t, {
    instance: async () => {
      instanceReads += 1;
      return { state: "unclaimed", ownerOrganizationId: null };
    },
  });
  const response = await bootstrap("wrong-secret");
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().code, "consumer_bootstrap_rejected");
  assert.equal(instanceReads, 0, "an unauthenticated caller learns nothing");
  assert.deepEqual(calls.roomService, []);
});

test("without a shared secret bootstrap is unavailable", async (t) => {
  const { bootstrap } = await bootstrapServer(t, {
    sharedSecret: "",
    instance: claimedBy("org_owner"),
  });
  const response = await bootstrap();
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, "consumer_bootstrap_unavailable");
});
