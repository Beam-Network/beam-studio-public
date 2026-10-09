import { auth } from "./policy.js";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { buildServer } from "../server.js";
import { admittedInstance } from "./instance-admission.fixture.js";
import { webEnv } from "../env.js";
import { studioScope } from "../agent-control/routes.js";
import { createStudioOAuthService } from "./oauth-service.js";
import { createBeamApiClient } from "./beam-api-client.js";
import { EncryptedFileRefreshTokenStore } from "./secure-token-store.js";
import { StudioSessionManager } from "./session-manager.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "studio-session-isolation-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  let nextUser = "A";
  let apiUnavailable = false;
  const revoked: string[] = [];
  const memberships = new Map<string, Array<{ id: string; role?: string }>>([
    ["A", [{ id: "org-A", role: "owner" }]],
    ["B", [{ id: "org-B", role: "owner" }]],
  ]);
  const fetchMock: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const fields = new URLSearchParams(String(init?.body ?? ""));
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/oauth/device/authorize")
      return json({
        device_code: nextUser,
        user_code: nextUser,
        verification_uri: "https://auth.test/device",
        verification_uri_complete: "https://auth.test/device",
        expires_in: 600,
        interval: 5,
      });
    if (url.pathname === "/oauth/token") {
      const user =
        fields.get("device_code") ?? fields.get("refresh_token")?.split(":")[1];
      return json({
        access_token: `access:${user}`,
        refresh_token: `refresh:${user}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "studio:access",
      });
    }
    if (url.pathname === "/oauth/revoke") {
      revoked.push(fields.get("token")!);
      return json({});
    }
    if (apiUnavailable) return json({ error: "unavailable" }, 503);
    const user =
      new Headers(init?.headers).get("Authorization")?.split(":")[1] ?? "";
    if (url.pathname === "/api/me") return json({ id: user });
    if (url.pathname === "/api/organizations")
      return json({ organizations: memberships.get(user) ?? [] });
    if (url.pathname === "/api/projects")
      return json({
        projects: [{ id: `project-${user}`, organizationId: `org-${user}` }],
      });
    throw new Error(`Unexpected mock request: ${url.pathname}`);
  };
  const manager = () =>
    new StudioSessionManager({
      secret: "test-browser-secret",
      createServices: (id) => {
        const oauth = createStudioOAuthService({
          authUrl: "https://auth.test",
          fetch: fetchMock,
          store: new EncryptedFileRefreshTokenStore(
            join(directory, `${id}.json`),
            "test-vault-secret",
          ),
        });
        return {
          oauth,
          beamApi: createBeamApiClient(oauth, {
            apiUrl: "https://api.test",
            fetch: fetchMock,
          }),
        };
      },
    });
  const start = async () => {
    const server = await buildServer({
      // buildServer starts RoomStorageTransferManager, which scans through the
      // pool on startup. An empty object throws before any assertion runs.
      pgPool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
      sessions: manager(),
      // This deployment serves both organizations, so what these cases prove
      // is isolation between tenants rather than admission to the host.
      admission: admittedInstance(["org-A", "org-A2", "org-B"]),
    });
    server.get(
      "/studio/test-scope",
      { config: { auth: auth.read() } },
      (request) => studioScope(request),
    );
    t.after(() => server.close());
    return server;
  };
  const server = await start();
  const startLogin = async (user: string) => {
    nextUser = user;
    const response = await server.inject({
      method: "POST",
      url: "/studio/auth/device/authorize",
    });
    assert.equal(response.statusCode, 200, response.body);
    return {
      attempt: response.json().attempt_id as string,
      cookie: cookie(response.headers["set-cookie"], "beam-studio.login"),
    };
  };
  const login = async (user: string) => {
    const pending = await startLogin(user);
    const response = await server.inject({
      method: "POST",
      url: "/studio/auth/device/poll",
      headers: { cookie: pending.cookie },
      payload: { attempt_id: pending.attempt },
    });
    assert.equal(response.statusCode, 200, response.body);
    return cookie(response.headers["set-cookie"], "beam-studio.session");
  };
  return {
    server,
    start,
    login,
    startLogin,
    directory,
    revoked,
    memberships,
    setUnavailable: (value: boolean) => {
      apiUnavailable = value;
    },
  };
}
function cookie(header: string | string[] | undefined, name: string) {
  const value = (Array.isArray(header) ? header : [header]).find((item) =>
    item?.startsWith(`${name}=`),
  );
  assert.ok(value, `Missing ${name} cookie`);
  return value.split(";")[0]!;
}

test("two browser accounts and organizations remain isolated after login, refresh and API restart", async (t) => {
  const f = await fixture(t);
  const a = await f.login("A");
  const b = await f.login("B");
  assert.notEqual(a, b);
  for (const server of [f.server, await f.start()]) {
    const results = await Promise.all(
      [a, b].map((cookie) =>
        server.inject({
          method: "GET",
          url: "/studio/session",
          headers: { cookie },
        }),
      ),
    );
    assert.deepEqual(
      results.map((result) => result.json().session.userId),
      ["A", "B"],
    );
    for (const [browser, user] of [
      [a, "A"],
      [b, "B"],
    ]) {
      const scope = await server.inject({
        method: "GET",
        url: "/studio/test-scope",
        headers: {
          cookie: `${browser}; beam-studio.organization-id=org-${user}`,
        },
      });
      assert.equal(scope.statusCode, 200, scope.body);
      assert.equal(scope.json().userId, user);
      assert.equal(scope.json().organizationId, `org-${user}`);
      assert.equal(scope.json().accessToken, `access:${user}`);
    }
  }
  const files = await readdir(f.directory);
  assert.equal(files.length, 2);
  for (const file of files)
    assert.equal(
      (await readFile(join(f.directory, file), "utf8")).includes("refresh:"),
      false,
    );
});

test("logout affects only its browser and old cookies cannot access a later login", async (t) => {
  const f = await fixture(t);
  const a = await f.login("A");
  const b = await f.login("B");
  await f.server.inject({ method: "POST", url: "/studio/auth/logout" });
  assert.equal(
    (
      await f.server.inject({
        method: "GET",
        url: "/studio/session",
        headers: { cookie: a },
      })
    ).json().session.userId,
    "A",
  );
  await f.server.inject({
    method: "POST",
    url: "/studio/auth/logout",
    headers: { cookie: a },
  });
  await f.login("A");
  assert.deepEqual(f.revoked, ["refresh:A"]);
  for (const server of [f.server, await f.start()]) {
    assert.equal(
      (
        await server.inject({
          method: "GET",
          url: "/studio/session",
          headers: { cookie: a },
        })
      ).json().session,
      null,
    );
    assert.equal(
      (
        await server.inject({
          method: "GET",
          url: "/studio/session",
          headers: { cookie: b },
        })
      ).json().session.userId,
      "B",
    );
  }
});

test("device polling and cancellation are bound to the initiating browser", async (t) => {
  const f = await fixture(t);
  const a = await f.startLogin("A");
  const b = await f.startLogin("B");
  const poll = (cookie?: string) =>
    f.server.inject({
      method: "POST",
      url: "/studio/auth/device/poll",
      headers: cookie ? { cookie } : {},
      payload: { attempt_id: a.attempt },
    });
  assert.equal((await poll()).statusCode, 401);
  assert.equal((await poll(b.cookie)).statusCode, 400);
  await f.server.inject({
    method: "POST",
    url: "/studio/auth/device/cancel",
    headers: { cookie: b.cookie },
    payload: { attempt_id: a.attempt },
  });
  assert.equal((await poll(a.cookie)).json().status, "connected");
});

test("all Studio business routes reject anonymous requests before reading or mutating data", async (t) => {
  const f = await fixture(t);
  await f.login("A");
  for (const [method, url] of [
    ["GET", "/studio/credentials"],
    ["GET", "/studio/organizations"],
    ["GET", "/studio/workflows"],
    ["GET", "/studio/workflow-runs/run/artifacts/artifact/content"],
    ["GET", "/studio/agents"],
    ["GET", "/studio/assistant/conversations"],
    ["POST", "/studio/workflows"],
    ["PATCH", "/studio/workflows/foreign-id/sidebar-parent"],
    ["POST", "/studio/organization-context"],
    ["POST", "/workflows/foreign-id/runs"],
    ["DELETE", "/studio/credentials/foreign-id"],
  ] as const) {
    const result = await f.server.inject({
      method,
      url,
      headers: { "x-organization-id": "org-A" },
      ...(method === "POST" ? { payload: { organizationId: "org-A" } } : {}),
      ...(method === "PATCH" ? { payload: { parentId: null } } : {}),
    });
    assert.equal(result.statusCode, 401, `${method} ${url}: ${result.body}`);
  }
});

test("artifact content allows organization scope but rejects a foreign project", async (t) => {
  const f = await fixture(t);
  const session = await f.login("A");
  const url = "/studio/workflow-runs/run/artifacts/artifact/content";
  const noProject = await f.server.inject({
    method: "GET",
    url,
    headers: { cookie: session, "x-organization-id": "org-A" },
  });
  assert.equal(noProject.statusCode, 404);
  assert.equal(noProject.json().code, "workflow_artifact_not_found");
  const foreignProject = await f.server.inject({
    method: "GET",
    url,
    headers: {
      cookie: session,
      "x-organization-id": "org-A",
      "x-project-id": "project-B",
    },
  });
  assert.equal(foreignProject.statusCode, 403);
});

test("missing, foreign and revoked organizations fail closed; project and write permissions are checked", async (t) => {
  const f = await fixture(t);
  const a = await f.login("A");
  for (const extra of [
    {},
    { "x-organization-id": "org-B" },
    { cookie: `${a}; beam-studio.organization-id=org-B` },
  ]) {
    const response = await f.server.inject({
      method: "GET",
      url: "/studio/credentials",
      headers: { cookie: a, ...extra },
    });
    assert.equal(
      response.statusCode,
      Object.keys(extra).length ? 403 : 400,
      response.body,
    );
  }
  const switchOrg = await f.server.inject({
    method: "POST",
    url: "/studio/organization-context",
    headers: { cookie: a },
    payload: { organizationId: "org-B" },
  });
  assert.equal(switchOrg.statusCode, 403);
  const project = await f.server.inject({
    method: "POST",
    url: "/studio/project-context",
    headers: { cookie: a, "x-organization-id": "org-A" },
    payload: { projectId: "project-B" },
  });
  assert.equal(project.statusCode, 403);
  f.memberships.set("A", [{ id: "org-A", role: "viewer" }]);
  const write = await f.server.inject({
    method: "DELETE",
    url: "/studio/credentials/id",
    headers: { cookie: a, "x-organization-id": "org-A" },
  });
  assert.equal(write.statusCode, 403);
  assert.equal(write.json().code, "organization_read_only");
  const move = await f.server.inject({
    method: "PATCH",
    url: "/studio/workflows/id/sidebar-parent",
    headers: { cookie: a, "x-organization-id": "org-A" },
    payload: { parentId: null },
  });
  assert.equal(move.statusCode, 403);
  assert.equal(move.json().code, "organization_read_only");
  f.memberships.set("A", []);
  const revoked = await f.server.inject({
    method: "GET",
    url: "/studio/test-scope",
    headers: { cookie: a, "x-organization-id": "org-A" },
  });
  assert.equal(revoked.statusCode, 403);
});

test("an upstream outage preserves each browser session", async (t) => {
  const f = await fixture(t);
  const a = await f.login("A");
  f.setUnavailable(true);
  assert.equal(
    (
      await f.server.inject({
        method: "GET",
        url: "/studio/session",
        headers: { cookie: a },
      })
    ).statusCode,
    503,
  );
  f.setUnavailable(false);
  assert.equal(
    (
      await f.server.inject({
        method: "GET",
        url: "/studio/session",
        headers: { cookie: a },
      })
    ).json().session.userId,
    "A",
  );
});

test("switching an authorized organization clears project context without affecting another browser", async (t) => {
  const f = await fixture(t);
  const a = await f.login("A");
  const b = await f.login("B");
  f.memberships.set("A", [
    { id: "org-A", role: "owner" },
    { id: "org-A2", role: "owner" },
  ]);
  const response = await f.server.inject({
    method: "POST",
    url: "/studio/organization-context",
    headers: {
      cookie: `${a}; beam-studio.organization-id=org-A; beam-studio.project-id=project-A`,
    },
    payload: { organizationId: "org-A2" },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(
    cookie(response.headers["set-cookie"], "beam-studio.organization-id"),
    "beam-studio.organization-id=org-A2",
  );
  assert.equal(
    cookie(response.headers["set-cookie"], "beam-studio.project-id"),
    "beam-studio.project-id=",
  );
  const other = await f.server.inject({
    method: "GET",
    url: "/studio/test-scope",
    headers: { cookie: `${b}; beam-studio.organization-id=org-B` },
  });
  assert.equal(other.json().userId, "B");
  assert.equal(other.json().organizationId, "org-B");
});

test("a new login in the same browser rotates its session and invalidates its old cookie", async (t) => {
  const f = await fixture(t);
  const a = await f.login("A");
  const b = await f.login("B");
  const pending = await f.startLogin("B");
  const response = await f.server.inject({
    method: "POST",
    url: "/studio/auth/device/poll",
    headers: {
      cookie: `${a}; ${pending.cookie}; beam-studio.organization-id=org-A`,
    },
    payload: { attempt_id: pending.attempt },
  });
  assert.equal(response.statusCode, 200, response.body);
  const replacement = cookie(
    response.headers["set-cookie"],
    "beam-studio.session",
  );
  assert.notEqual(replacement, a);
  assert.equal(
    cookie(response.headers["set-cookie"], "beam-studio.organization-id"),
    "beam-studio.organization-id=",
  );
  assert.equal(
    (
      await f.server.inject({
        method: "GET",
        url: "/studio/session",
        headers: { cookie: a },
      })
    ).json().session,
    null,
  );
  for (const browser of [replacement, b]) {
    assert.equal(
      (
        await f.server.inject({
          method: "GET",
          url: "/studio/session",
          headers: { cookie: browser },
        })
      ).json().session.userId,
      "B",
    );
  }
  assert.deepEqual(f.revoked, ["refresh:A"]);
});
