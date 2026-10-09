import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerAgentControlRoutes } from "./routes.js";
import { webEnv } from "../env.js";
import { registerStudioAuthKernel } from "../auth/request-context.js";
import {
  createStudioBrowserSession,
  STUDIO_SESSION_COOKIE,
} from "../auth/browser-session.js";

test("agent rename requires a session and uses the authorized organization and actor", async (t) => {
  const previousSecret = process.env.BEAM_STUDIO_SECRET_KEY;
  process.env.BEAM_STUDIO_SECRET_KEY = "test-browser-secret";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.BEAM_STUDIO_SECRET_KEY;
    else process.env.BEAM_STUDIO_SECRET_KEY = previousSecret;
  });
  const calls: unknown[][] = [];
  const server = Fastify();
  t.after(() => server.close());
  const services = {
    oauth: {
      hasSession: async () => true,
      getAccessToken: async () => "test-token",
    },
    beamApi: {
      getJson: async (path: string) =>
        path === "/api/me"
          ? { id: "user-a" }
          : { organizations: [{ id: "org-a" }] },
    },
  };
  // 50b1916 moved Studio authorization out of the routes and into this
  // server-level hook, which buildServer installs. Registering the routes on a
  // bare Fastify instance leaves every request without a context, so the hook
  // has to be installed here too.
  registerStudioAuthKernel(server, {
    get: (cookie: string | null) => (cookie ? services : null),
  } as never);
  await registerAgentControlRoutes(server, {
    repository: {
      renameAgent: async (...args: unknown[]) => {
        calls.push(args);
        return { id: args[1], name: args[2] };
      },
    },
    gateway: {},
    ...services,
  } as unknown as Parameters<typeof registerAgentControlRoutes>[1]);
  const headers = {
    cookie: `${STUDIO_SESSION_COOKIE}=${createStudioBrowserSession("test-browser-secret")}`,
    "x-organization-id": "org-a",
  };
  assert.equal(
    (
      await server.inject({
        method: "PATCH",
        url: "/studio/agents/agent-a",
        headers: { "x-organization-id": "org-a" },
        payload: { name: "Bad" },
      })
    ).statusCode,
    // A request with no session cookie is unauthenticated, not forbidden.
    // 50b1916 moved this to studio_session_required/401 and left the old
    // expectation behind; no CI job ran the suite, so it stayed red on dev.
    401,
  );
  assert.equal(calls.length, 0);
  assert.equal(
    (
      await server.inject({
        method: "PATCH",
        url: "/studio/agents/agent-a",
        headers,
        payload: {
          name: "Production",
          organizationId: "org-evil",
          actorId: "user-evil",
        },
      })
    ).statusCode,
    200,
  );
  assert.deepEqual(calls, [["org-a", "agent-a", "Production", "user-a"]]);
  assert.equal(
    (
      await server.inject({
        method: "PATCH",
        url: "/studio/agents/agent-a",
        headers: { ...headers, "x-organization-id": "org-evil" },
        payload: { name: "Bad" },
      })
    ).statusCode,
    403,
  );
  assert.equal(calls.length, 1);
});
