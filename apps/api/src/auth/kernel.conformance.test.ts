import assert from "node:assert/strict";
import test from "node:test";
import type { PgPool } from "@beam-studio/db";
import Fastify from "fastify";
import { buildServer } from "../server.js";
import { registerAuthKernel } from "./kernel.js";
import { isMcpScope } from "@beam-studio/shared";
import { auth } from "./policy.js";
import { PUBLIC_ROUTES } from "./public-routes.snapshot.js";
import { CLAIM_FUNNEL_ROUTES } from "./claim-funnel.snapshot.js";

const stubPool = () =>
  ({ query: async () => ({ rows: [], rowCount: 0 }) }) as unknown as PgPool;

async function booted() {
  const server = await buildServer({ pgPool: stubPool() });
  // Forces every deferred register() to run, so the registry is complete.
  await server.ready();
  return server;
}

/** HEAD routes Fastify generates from a GET carry the same config. */
const declared = (server: Awaited<ReturnType<typeof booted>>) =>
  [...server.authPolicies.entries()].filter(
    ([key]) => !key.startsWith("HEAD "),
  );

test("a route cannot be registered without an auth policy", () => {
  const server = Fastify();
  registerAuthKernel(server, { verify: async () => {} });
  // onRoute runs synchronously inside the registration call, so this throws
  // out of server.get rather than failing later at request time.
  assert.throws(
    () => server.get("/unpoliced", async () => ({})),
    /declares no auth policy/,
  );
});

test("every route in the router declares a policy", async () => {
  const server = await booted();
  try {
    const routes = declared(server);
    // A truncated registry would make every other assertion vacuous.
    assert.ok(
      routes.length > 150,
      `route table looks truncated: ${routes.length}`,
    );
    for (const [key, policy] of routes) {
      assert.ok(policy?.kind, `${key} has no policy kind`);
    }
  } finally {
    await server.close();
  }
});

test("the unauthenticated surface is exactly the committed snapshot", async () => {
  const server = await booted();
  try {
    const actual = declared(server)
      .filter(([, policy]) => policy.kind === "public")
      .map(([key]) => key)
      .sort();
    assert.deepEqual(
      actual,
      [...PUBLIC_ROUTES].sort(),
      "update public-routes.snapshot.ts deliberately, as a security decision",
    );
  } finally {
    await server.close();
  }
});

test("the claim funnel is exactly the committed snapshot", async () => {
  const server = await booted();
  try {
    const actual = declared(server)
      .filter(
        ([, policy]) =>
          policy.kind === "session" && policy.instance === "claimFunnel",
      )
      .map(([key]) => key)
      .sort();
    assert.deepEqual(
      actual,
      [...CLAIM_FUNNEL_ROUTES].sort(),
      "update claim-funnel.snapshot.ts deliberately: every route here is one an unadmitted stranger can reach",
    );
  } finally {
    await server.close();
  }
});

test("no update route is reachable without instance administration", async () => {
  const server = await booted();
  try {
    const updateRoutes = declared(server).filter(([key]) =>
      key.includes("/studio/updates/"),
    );
    assert.ok(updateRoutes.length > 0, "no update routes were registered");
    for (const [key, policy] of updateRoutes) {
      assert.equal(
        policy.kind === "session" && policy.instance,
        "admin",
        `${key} lets a caller who does not own this installation reach it`,
      );
    }
  } finally {
    await server.close();
  }
});

test("each plane uses the policy class it is supposed to", async () => {
  const server = await booted();
  try {
    for (const [key, policy] of declared(server)) {
      const url = key.slice(key.indexOf(" ") + 1);
      if (PUBLIC_ROUTES.includes(key)) continue;
      if (url.startsWith("/internal/") || url.startsWith("/api/internal/")) {
        assert.ok(
          ["capability", "serviceSecret", "signedRequest"].includes(
            policy.kind,
          ),
          `${key} is on the internal plane but is ${policy.kind}`,
        );
      }
      if (url.startsWith("/mcp/")) {
        assert.equal(policy.kind, "mcp", key);
      }
      if (url.startsWith("/agent-control/")) {
        assert.ok(
          ["agent", "serviceSecret", "credentialExchange"].includes(
            policy.kind,
          ),
          `${key} is agent control but is ${policy.kind}`,
        );
      }
      if (url.startsWith("/studio/")) {
        assert.ok(
          ["session", "loginSession", "agent"].includes(policy.kind),
          `${key} is a Studio route but is ${policy.kind}`,
        );
      }
    }
  } finally {
    await server.close();
  }
});

test("machine tokens are not granted where a user session is required", async () => {
  const server = await booted();
  try {
    // These either delegate to Beam or the coordinator with the signed-in
    // user's bearer, which a token does not have, or would let a token widen
    // its own authority. A grant here is a mistake, not a preference.
    const forbidden =
      /\/studio\/(assistant|ai|mcp|organizations|projects|session)|-context$|\/studio\/(rooms|agents|room-)/;
    for (const [key, policy] of declared(server)) {
      if (policy.kind !== "session" || !policy.machine) continue;
      const url = key.slice(key.indexOf(" ") + 1);
      assert.ok(
        !forbidden.test(url),
        `${key} grants machine scopes but needs a user session`,
      );
    }
  } finally {
    await server.close();
  }
});

test("every granted machine scope is one the vocabulary defines", async () => {
  const server = await booted();
  try {
    let granted = 0;
    for (const [key, policy] of declared(server)) {
      if (policy.kind !== "session" || !policy.machine) continue;
      granted += 1;
      for (const scope of policy.machine) {
        assert.ok(isMcpScope(scope), `${key} requires unknown scope ${scope}`);
      }
    }
    assert.ok(granted > 40, `expected a substantial machine surface, got ${granted}`);
  } finally {
    await server.close();
  }
});

test("a HEAD route inherits the policy of its GET", async () => {
  const server = await booted();
  try {
    for (const [key, policy] of server.authPolicies) {
      if (!key.startsWith("HEAD ")) continue;
      const get = server.authPolicies.get(key.replace(/^HEAD /, "GET "));
      if (get) assert.deepEqual(policy, get, key);
    }
  } finally {
    await server.close();
  }
});

test("no Studio business route is reachable without a session", async () => {
  const server = await booted();
  try {
    const sample = declared(server).filter(
      ([key, policy]) =>
        policy.kind === "session" &&
        // The probe reports "signed out" rather than refusing; that is its job.
        policy.anonymous !== "probe" &&
        !key.includes(":") &&
        key.startsWith("GET "),
    );
    assert.ok(sample.length > 5, "expected several parameterless GET routes");
    for (const [key] of sample) {
      const url = key.slice(key.indexOf(" ") + 1);
      const response = await server.inject({ method: "GET", url });
      assert.equal(
        response.statusCode,
        401,
        `${key} answered ${response.statusCode} without a session`,
      );
    }
  } finally {
    await server.close();
  }
});
