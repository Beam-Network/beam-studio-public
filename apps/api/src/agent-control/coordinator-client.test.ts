import assert from "node:assert/strict";
import test from "node:test";

test("workflow status uses organization object scope without contacting a source agent", async () => {
  const paths:string[]=[];
  const client=new CoordinatorRoomClient("http://127.0.0.1:8789",(async(input,init)=>{
    const path=new URL(String(input)).pathname;paths.push(path);
    if(path.endsWith("delegations")) {
      const body=JSON.parse(String(init?.body));
      assert.deepEqual(body.scopes,["room:objects:read"]);assert.equal(body.agent_id,undefined);
      return Response.json({access_token:"test-delegation",expires_in:120,organization_id:"org"});
    }
    return Response.json({status:{publisher:{room_transfer:{status:"completed"}}}});
  }) as typeof fetch);
  const result=await client.organizationObjectStatus("org","room/a","channel/a","publication/a","test-token");
  assert.deepEqual(result,{status:{publisher:{room_transfer:{status:"completed"}}}});
  assert.equal(paths[1],"/studio/v1/rooms/room%2Fa/channels/channel%2Fa/objects/publication%2Fa");
});
import { CoordinatorRoomClient } from "./coordinator-client.js";

test("CoordinatorRoomClient creates a key-bound canonical agent enrollment", async () => {
  const requests: Array<{
    authorization: string | null;
    body: unknown;
    organizationId: string | null;
    path: string;
  }> = [];
  const client = new CoordinatorRoomClient("http://127.0.0.1:8789", (async (
    input,
    init,
  ) => {
    requests.push({
      authorization: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      organizationId: new Headers(init?.headers).get("x-beam-organization-id"),
      path: new URL(String(input)).pathname,
    });
    return Response.json(
      {
        enrollment_id: "agenr-a",
        enrollment_token: "agenr-secret",
      },
      { status: 201 },
    );
  }) as typeof fetch);

  const result = await client.createAgentEnrollment(
    "org-a",
    "Studio consumer",
    "a".repeat(64),
    "studio-access",
  );

  assert.equal(result.enrollment_token, "agenr-secret");
  assert.deepEqual(requests, [
    {
      authorization: "Bearer studio-access",
      body: {
        label: "Studio consumer",
        public_key_fingerprint: "a".repeat(64),
      },
      organizationId: "org-a",
      path: "/v1/agent-enrollments",
    },
  ]);
});

test("CoordinatorRoomClient exchanges the authenticated Studio bearer for a cached scoped delegation", async () => {
  const requests: Array<{
    authorization: string | null;
    body: unknown;
    path: string;
  }> = [];
  const client = new CoordinatorRoomClient("http://127.0.0.1:8789", (async (
    input,
    init,
  ) => {
    const url = new URL(String(input));
    requests.push({
      authorization: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      path: url.pathname,
    });
    if (url.pathname === "/studio/v1/delegations") {
      return Response.json(
        {
          access_token: "short-delegation",
          expires_in: 120,
          organization_id: "org-a",
        },
        { status: 201 },
      );
    }
    return Response.json({ rooms: [] });
  }) as typeof fetch);

  await client.listRooms("org-a", "agent-a", "studio-access-token");
  await client.listRooms("org-a", "agent-a", "studio-access-token");

  assert.equal(
    requests.filter((request) => request.path === "/studio/v1/delegations")
      .length,
    1,
  );
  assert.deepEqual(requests[0], {
    authorization: "Bearer studio-access-token",
    body: {
      agent_id: "agent-a",
      scopes: ["rooms:list"],
      ttl_seconds: 120,
    },
    path: "/studio/v1/delegations",
  });
  assert.equal(requests[1]?.authorization, "Bearer short-delegation");
  assert.equal(requests[2]?.authorization, "Bearer short-delegation");
});

test("CoordinatorRoomClient requests admin snapshot scopes for invitations and grants", async () => {
  const requests: Array<{ body: unknown; method: string; path: string }> = [];
  const client = new CoordinatorRoomClient("http://127.0.0.1:8789", (async (
    input,
    init,
  ) => {
    const url = new URL(String(input));
    requests.push({
      body: init?.body ? JSON.parse(String(init.body)) : null,
      method: init?.method ?? "GET",
      path: url.pathname,
    });
    if (url.pathname === "/studio/v1/delegations") {
      return Response.json(
        {
          access_token: "snapshot-delegation",
          expires_in: 120,
          organization_id: "org-a",
        },
        { status: 201 },
      );
    }
    return Response.json({ room: { room_id: "room-a" } });
  }) as typeof fetch);

  await client.roomSnapshot(
    "org-a",
    "agent-a",
    "room-a",
    "studio-access-token",
  );

  assert.deepEqual(requests[0]?.body, {
    agent_id: "agent-a",
    scopes: [
      "room:channels:read",
      "room:grants:read",
      "room:invitations:read",
      "room:memberships:read",
      "room:read",
      "room:roles:read",
      "rooms:list",
    ],
    ttl_seconds: 120,
  });
  assert.deepEqual(requests[1], {
    body: null,
    method: "GET",
    path: "/studio/v1/rooms/room-a/snapshot",
  });
});

test("CoordinatorRoomClient reads room objects with the minimal transfer scope", async () => {
  const requests: Array<{
    authorization: string | null;
    body: unknown;
    path: string;
  }> = [];
  const client = new CoordinatorRoomClient("http://127.0.0.1:8789", (async (
    input,
    init,
  ) => {
    const url = new URL(String(input));
    requests.push({
      authorization: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      path: url.pathname,
    });
    if (url.pathname === "/studio/v1/delegations") {
      return Response.json(
        {
          access_token: "object-delegation",
          expires_in: 120,
          organization_id: "org-a",
        },
        { status: 201 },
      );
    }
    return Response.json({ objects: [{ publisher: { state: "active" } }] });
  }) as typeof fetch);

  const result = await client.listRoomObjects(
    "org-a",
    "agent-a",
    "room/a",
    "channel/a",
    "studio-access-token",
  );

  assert.deepEqual(requests[0], {
    authorization: "Bearer studio-access-token",
    body: {
      agent_id: "agent-a",
      scopes: ["room:objects:read"],
      ttl_seconds: 120,
    },
    path: "/studio/v1/delegations",
  });
  assert.deepEqual(requests[1], {
    authorization: "Bearer object-delegation",
    body: null,
    path: "/studio/v1/rooms/room%2Fa/channels/channel%2Fa/objects",
  });
  assert.deepEqual(result, { objects: [{ publisher: { state: "active" } }] });
});

test("CoordinatorRoomClient reads persisted organization room transfers without an agent delegation", async () => {
  const requests: Array<{ body: unknown; path: string }> = [];
  const client = new CoordinatorRoomClient("http://127.0.0.1:8789", (async (
    input,
    init,
  ) => {
    const url = new URL(String(input));
    requests.push({
      body: init?.body ? JSON.parse(String(init.body)) : null,
      path: url.pathname,
    });
    if (url.pathname === "/studio/v1/delegations") {
      return Response.json(
        {
          access_token: "organization-object-delegation",
          expires_in: 120,
          organization_id: "org-a",
        },
        { status: 201 },
      );
    }
    return Response.json({ transfers: [] });
  }) as typeof fetch);

  await client.listOrganizationRoomTransfers(
    "org-a",
    "room/a",
    "channel/a",
    "studio-access-token",
  );

  assert.deepEqual(requests[0], {
    body: {
      scopes: ["room:objects:read"],
      ttl_seconds: 120,
    },
    path: "/studio/v1/delegations",
  });
  assert.deepEqual(requests[1], {
    body: null,
    path: "/studio/v1/rooms/room%2Fa/channels/channel%2Fa/transfers",
  });

  await client.listOrganizationRoomTransfers(
    "org-a",
    "room/a",
    null,
    "studio-access-token",
  );
  assert.deepEqual(requests[2], {
    body: null,
    path: "/studio/v1/rooms/room%2Fa/transfers",
  });
});

test("CoordinatorRoomClient attaches a consumer with the minimal attachment scope", async () => {
  const requests: Array<{
    body: unknown;
    key: string | null;
    method: string;
    path: string;
  }> = [];
  const client = new CoordinatorRoomClient("http://127.0.0.1:8789", (async (
    input,
    init,
  ) => {
    const path = new URL(String(input)).pathname;
    requests.push({
      body: init?.body ? JSON.parse(String(init.body)) : null,
      key: new Headers(init?.headers).get("idempotency-key"),
      method: init?.method ?? "GET",
      path,
    });
    if (path === "/studio/v1/delegations") {
      return Response.json({
        access_token: "membership-delegation",
        expires_in: 120,
        organization_id: "org-a",
      });
    }
    return Response.json({ membership: { agent_id: "agent-a" } });
  }) as typeof fetch);

  await client.attachOrganizationRoomConsumer(
    "org-a",
    "room/a",
    "agent/a",
    "attach-key",
    "studio-access",
  );

  assert.deepEqual(requests[0]?.body, {
    scopes: ["room:memberships:write"],
    ttl_seconds: 120,
  });
  assert.deepEqual(requests[1], {
    body: {},
    key: "attach-key",
    method: "PUT",
    path: "/studio/v1/rooms/room%2Fa/consumers/agent%2Fa",
  });
});

test("CoordinatorRoomClient uses a minimal write delegation for room creation", async () => {
  const requests: Array<{
    body: unknown;
    idempotencyKey: string | null;
    method: string;
    path: string;
  }> = [];
  const client = new CoordinatorRoomClient("http://127.0.0.1:8789", (async (
    input,
    init,
  ) => {
    const url = new URL(String(input));
    requests.push({
      body: init?.body ? JSON.parse(String(init.body)) : null,
      idempotencyKey: new Headers(init?.headers).get("idempotency-key"),
      method: init?.method ?? "GET",
      path: url.pathname,
    });
    if (url.pathname === "/studio/v1/delegations") {
      return Response.json(
        {
          access_token: "write-delegation",
          expires_in: 120,
          organization_id: "org-a",
        },
        { status: 201 },
      );
    }
    return Response.json({ room: { room_id: "room-a" } }, { status: 201 });
  }) as typeof fetch);

  const result = await client.mutateRoom(
    "org-a",
    "agent-a",
    "room.create",
    { lease_ttl_seconds: 120 },
    "create-key",
    "studio-access-token",
  );

  assert.deepEqual(requests[0]?.body, {
    agent_id: "agent-a",
    scopes: ["room:create"],
    ttl_seconds: 120,
  });
  assert.deepEqual(requests[1], {
    body: { lease_ttl_seconds: 120 },
    idempotencyKey: "create-key",
    method: "POST",
    path: "/studio/v1/rooms",
  });
  assert.deepEqual(result, {
    room: {
      room: { room_id: "room-a" },
      membership: {},
    },
  });
});

test("CoordinatorRoomClient activates a channel through its key epoch route", async () => {
  const requests: Array<{
    body: unknown;
    method: string;
    path: string;
  }> = [];
  const client = new CoordinatorRoomClient("http://127.0.0.1:8789", (async (
    input,
    init,
  ) => {
    const path = new URL(String(input)).pathname;
    requests.push({
      body: init?.body ? JSON.parse(String(init.body)) : null,
      method: init?.method ?? "GET",
      path,
    });
    if (path === "/studio/v1/delegations") {
      return Response.json({
        access_token: "channel-write-delegation",
        expires_in: 120,
        organization_id: "org-a",
      });
    }
    return Response.json({
      authorization_epoch: 5,
      channel: { channel_id: "channel/a", state: "active" },
    });
  }) as typeof fetch);

  await client.mutateRoom(
    "org-a",
    "agent-a",
    "room.channel.activate",
    {
      room_id: "room/a",
      channel_id: "channel/a",
      expected_authorization_epoch: 4,
      expected_channel_revision: 1,
      new_key_epoch: 2,
    },
    "activate-key",
    "studio-token",
  );

  assert.deepEqual(requests, [
    {
      body: {
        agent_id: "agent-a",
        scopes: ["room:channels:write"],
        ttl_seconds: 120,
      },
      method: "POST",
      path: "/studio/v1/delegations",
    },
    {
      body: {
        expected_authorization_epoch: 4,
        expected_channel_revision: 1,
        new_key_epoch: 2,
      },
      method: "POST",
      path: "/studio/v1/rooms/room%2Fa/channels/channel%2Fa/key-epoch",
    },
  ]);
});

test("CoordinatorRoomClient maps admin removal mutations to scoped delete routes", async () => {
  const requests: Array<{ body: unknown; method: string; path: string }> = [];
  const client = new CoordinatorRoomClient("http://127.0.0.1:8789", (async (
    input,
    init,
  ) => {
    const url = new URL(String(input));
    requests.push({
      body: init?.body ? JSON.parse(String(init.body)) : null,
      method: init?.method ?? "GET",
      path: url.pathname,
    });
    if (url.pathname === "/studio/v1/delegations") {
      return Response.json(
        {
          access_token: `delegation-${requests.length}`,
          expires_in: 120,
          organization_id: "org-a",
        },
        { status: 201 },
      );
    }
    return Response.json({ state: "revoked" });
  }) as typeof fetch);

  await client.mutateRoom(
    "org-a",
    "agent-a",
    "room.invitation.create",
    {
      room_id: "room-a",
      max_uses: 4,
      role_ids: ["role-a"],
      channel_access: [
        { channel_id: "channel-a", actions: ["discover", "subscribe"] },
      ],
    },
    "invite-create-key",
    "studio-token",
  );
  await client.mutateRoom(
    "org-a",
    "agent-a",
    "room.invitation.revoke",
    { room_id: "room-a", invitation_id: "invite-a" },
    "invite-key",
    "studio-token",
  );
  await client.mutateRoom(
    "org-a",
    "agent-a",
    "room.membership.remove",
    { room_id: "room-a", member_id: "member-a" },
    "member-key",
    "studio-token",
  );
  await client.mutateRoom(
    "org-a",
    "agent-a",
    "room.role.delete",
    {
      room_id: "room-a",
      role_id: "role-a",
      expected_authorization_epoch: 3,
    },
    "role-key",
    "studio-token",
  );

  assert.deepEqual(
    requests.filter((request) => request.path === "/studio/v1/delegations"),
    [
      {
        body: {
          agent_id: "agent-a",
          scopes: ["room:invitations:write"],
          ttl_seconds: 120,
        },
        method: "POST",
        path: "/studio/v1/delegations",
      },
      {
        body: {
          agent_id: "agent-a",
          scopes: ["room:memberships:write"],
          ttl_seconds: 120,
        },
        method: "POST",
        path: "/studio/v1/delegations",
      },
      {
        body: {
          agent_id: "agent-a",
          scopes: ["room:roles:write"],
          ttl_seconds: 120,
        },
        method: "POST",
        path: "/studio/v1/delegations",
      },
    ],
  );
  assert.deepEqual(
    requests.filter((request) => request.method === "DELETE"),
    [
      {
        body: {},
        method: "DELETE",
        path: "/studio/v1/rooms/room-a/invitations/invite-a",
      },
      {
        body: {},
        method: "DELETE",
        path: "/studio/v1/rooms/room-a/memberships/member-a",
      },
      {
        body: { expected_authorization_epoch: 3 },
        method: "DELETE",
        path: "/studio/v1/rooms/room-a/roles/role-a",
      },
    ],
  );
  assert.deepEqual(
    requests.find(
      (request) =>
        request.path === "/studio/v1/rooms/room-a/invitations" &&
        request.method === "POST",
    )?.body,
    {
      max_uses: 4,
      role_ids: ["role-a"],
      channel_access: [
        { channel_id: "channel-a", actions: ["discover", "subscribe"] },
      ],
    },
  );
});

test("CoordinatorRoomClient creates organization rooms without an agent delegation", async () => {
  const requests: Array<{
    agentHeader: string | null;
    body: unknown;
    path: string;
  }> = [];
  const client = new CoordinatorRoomClient("http://127.0.0.1:8789", (async (
    input,
    init,
  ) => {
    const url = new URL(String(input));
    requests.push({
      agentHeader: new Headers(init?.headers).get("x-beam-agent-id"),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      path: url.pathname,
    });
    if (url.pathname === "/studio/v1/delegations") {
      return Response.json(
        {
          access_token: "organization-delegation",
          expires_in: 120,
          organization_id: "org-a",
          organization_owner: true,
        },
        { status: 201 },
      );
    }
    return Response.json(
      { room: { room_id: "room-organization" } },
      { status: 201 },
    );
  }) as typeof fetch);

  const result = await client.mutateOrganizationRoom(
    "org-a",
    "room.create",
    { lease_ttl_seconds: 120 },
    "organization-create-key",
    "studio-access-token",
  );

  assert.deepEqual(requests[0], {
    agentHeader: null,
    body: {
      scopes: ["room:create"],
      ttl_seconds: 120,
    },
    path: "/studio/v1/delegations",
  });
  assert.deepEqual(result, {
    room: {
      room: { room_id: "room-organization" },
      membership: {},
    },
  });
});

test("CoordinatorRoomClient rejects delegation for another organization", async () => {
  const client = new CoordinatorRoomClient("http://localhost:8789", (async () =>
    Response.json(
      {
        access_token: "delegation",
        expires_in: 120,
        organization_id: "org-other",
      },
      { status: 201 },
    )) as typeof fetch);

  await assert.rejects(
    () => client.listRooms("org-a", "agent-a", "studio-access-token"),
    /invalid Studio delegation/,
  );
});

test("CoordinatorRoomClient requires TLS outside loopback", () => {
  assert.throws(
    () => new CoordinatorRoomClient("http://coordinator.example.com"),
    /must use HTTPS/,
  );
});

test("CoordinatorRoomClient rejects direct IP deployments over HTTP", () => {
  assert.throws(
    () => new CoordinatorRoomClient("http://203.0.113.10:8787"),
    /must use HTTPS/,
  );
});

test("CoordinatorRoomClient accepts canonical public coordinator URLs", () => {
  assert.equal(
    new CoordinatorRoomClient("http://127.0.0.1:8789/").url,
    "http://127.0.0.1:8789",
  );
  assert.equal(
    new CoordinatorRoomClient("https://coordinator.b1m.ai").url,
    "https://coordinator.b1m.ai",
  );
});

test("organization key acceptance follows the Coordinator delegation answer", async () => {
  const statuses = [401, 403, 201];
  const client = new CoordinatorRoomClient("http://127.0.0.1:8789", (async (input, init) => {
    assert.equal(new URL(String(input)).pathname, "/studio/v1/delegations");
    assert.equal(new Headers(init?.headers).get("X-Beam-Organization-ID"), "org");
    const status = statuses.shift()!;
    return status === 201
      ? Response.json({ access_token: "d", expires_in: 120, organization_id: "org" }, { status })
      : Response.json({ error: "Studio authentication required", code: "unauthenticated" }, { status });
  }) as typeof fetch);
  assert.equal(await client.acceptsOrganizationKey("org", "prod-key"), false);
  assert.equal(await client.acceptsOrganizationKey("org", "other-org-key"), false);
  assert.equal(await client.acceptsOrganizationKey("org", "dev-key"), true);
});
