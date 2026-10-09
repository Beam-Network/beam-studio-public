import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { webEnv } from "../env.js";
import { registerStudioAuthKernel } from "../auth/request-context.js";
import { auth } from "../auth/policy.js";
import {
  createStudioBrowserSession,
  STUDIO_SESSION_COOKIE,
} from "../auth/browser-session.js";
import {
  resetRoomServiceClients,
  roomServiceForRequest,
} from "./room-service.js";

const template = { key: "dev", coordinatorUrl: "http://127.0.0.1:1" };

/** A Studio server whose only route lists rooms with the request's session. */
async function requestServer(
  t: test.TestContext,
  options: {
    authenticated: boolean;
    fetcher?: typeof fetch;
  },
) {
  const previousSecret = process.env.BEAM_STUDIO_SECRET_KEY;
  const previousFetch = globalThis.fetch;
  process.env.BEAM_STUDIO_SECRET_KEY = "test-browser-secret";
  if (options.fetcher) globalThis.fetch = options.fetcher;
  // Request clients are cached per Coordinator URL; start from a clean cache
  // so the client is constructed with this test's fetch.
  resetRoomServiceClients();
  const server = Fastify();
  t.after(async () => {
    await server.close();
    globalThis.fetch = previousFetch;
    if (previousSecret === undefined) delete process.env.BEAM_STUDIO_SECRET_KEY;
    else process.env.BEAM_STUDIO_SECRET_KEY = previousSecret;
    resetRoomServiceClients();
  });
  const services = {
    oauth: {
      hasSession: async () => true,
      getAccessToken: async () => "session-bearer",
    },
    beamApi: {
      getJson: async (path: string) =>
        path === "/api/me"
          ? { id: "user-a" }
          : { organizations: [{ id: "org-a" }] },
    },
  };
  registerStudioAuthKernel(server, {
    get: (cookie: string | null) => (cookie ? services : null),
  } as never);
  server.get(
    "/studio/test-rooms",
    { config: { auth: auth.read() } },
    async (request) => {
      const service = await roomServiceForRequest(request, template);
      return service.client.listOrganizationRooms("org-a", service.token);
    },
  );
  return server.inject({
    method: "GET",
    url: "/studio/test-rooms",
    headers: {
      "x-organization-id": "org-a",
      ...(options.authenticated
        ? {
            cookie: `${STUDIO_SESSION_COOKIE}=${createStudioBrowserSession("test-browser-secret")}`,
          }
        : {}),
    },
  });
}

test("request-scoped room service delegates with the user's session bearer", async (t) => {
  const calls: Array<{ url: string; authorization: string }> = [];
  const response = await requestServer(t, {
    authenticated: true,
    fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        authorization: String(
          (init?.headers as Record<string, string> | undefined)?.Authorization,
        ),
      });
      const body = url.endsWith("/studio/v1/delegations")
        ? {
            access_token: "delegated",
            expires_in: 120,
            organization_id: "org-a",
          }
        : { rooms: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(calls, [
    {
      url: "http://127.0.0.1:1/studio/v1/delegations",
      authorization: "Bearer session-bearer",
    },
    {
      url: "http://127.0.0.1:1/studio/v1/rooms",
      authorization: "Bearer delegated",
    },
  ]);
});

test("request-scoped room service rejects requests without a Beam Auth session", async (t) => {
  // There is no longer a way to reach a handler with a Studio context but no
  // OAuth services: the dev bypass was the only thing that produced one, and
  // the auth kernel refuses the request before the route runs.
  const response = await requestServer(t, {
    authenticated: false,
    fetcher: (async () => {
      throw new Error("Coordinator must not be called without a session.");
    }) as typeof fetch,
  });
  assert.equal(response.statusCode, 401, response.body);
  assert.equal(response.json().code, "studio_session_required");
});
