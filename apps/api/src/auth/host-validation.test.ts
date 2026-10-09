import assert from "node:assert/strict";
import test from "node:test";
import type { PgPool } from "@beam-studio/db";
import { buildServer } from "../server.js";

const stubPool = () =>
  ({ query: async () => ({ rows: [], rowCount: 0 }) }) as unknown as PgPool;

async function withServer(
  run: (server: Awaited<ReturnType<typeof buildServer>>) => Promise<void>,
) {
  const server = await buildServer({ pgPool: stubPool() });
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

test("a rebound hostname is refused before the route runs", async () => {
  await withServer(async (server) => {
    const response = await server.inject({
      method: "GET",
      url: "/health",
      headers: { host: "evil.example.com" },
    });
    assert.equal(response.statusCode, 421);
    assert.equal(response.json().code, "host_not_allowed");
  });
});

test("the refusal covers routes that need no credential at all", async () => {
  // /health and /metrics are deliberately unauthenticated, so Host is the
  // only thing standing between them and a rebound page.
  await withServer(async (server) => {
    for (const url of ["/health", "/metrics"]) {
      const response = await server.inject({
        method: "GET",
        url,
        headers: { host: "attacker.test" },
      });
      assert.equal(response.statusCode, 421, url);
    }
  });
});

test("loopback and IP-literal hosts still work with nothing configured", async () => {
  const previous = process.env.BEAM_STUDIO_ALLOWED_HOSTS;
  delete process.env.BEAM_STUDIO_ALLOWED_HOSTS;
  try {
    await withServer(async (server) => {
      for (const host of [
        "localhost:8787",
        "127.0.0.1:8787",
        // The common client install is reached at its bare IP; an IP Host
        // cannot be produced by DNS rebinding.
        "203.0.113.9:8787",
      ]) {
        const response = await server.inject({
          method: "GET",
          url: "/health",
          headers: { host },
        });
        assert.notEqual(response.statusCode, 421, host);
      }
    });
  } finally {
    if (previous === undefined) delete process.env.BEAM_STUDIO_ALLOWED_HOSTS;
    else process.env.BEAM_STUDIO_ALLOWED_HOSTS = previous;
  }
});

test("a configured hostname is accepted", async () => {
  const previous = process.env.BEAM_STUDIO_ALLOWED_HOSTS;
  process.env.BEAM_STUDIO_ALLOWED_HOSTS = "studio.example.com";
  try {
    await withServer(async (server) => {
      const allowed = await server.inject({
        method: "GET",
        url: "/health",
        headers: { host: "studio.example.com:3004" },
      });
      assert.notEqual(allowed.statusCode, 421);
      // A suffix must not be enough, or every subdomain an attacker can
      // create under it would be trusted too.
      const sibling = await server.inject({
        method: "GET",
        url: "/health",
        headers: { host: "evil.studio.example.com" },
      });
      assert.equal(sibling.statusCode, 421);
    });
  } finally {
    if (previous === undefined) delete process.env.BEAM_STUDIO_ALLOWED_HOSTS;
    else process.env.BEAM_STUDIO_ALLOWED_HOSTS = previous;
  }
});
