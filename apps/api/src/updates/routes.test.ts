import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { buildServer } from "../server.js";
import { admittedInstance } from "../auth/instance-admission.fixture.js";
import type { StudioSessionManager } from "../auth/session-manager.js";
import type { UpdateMode } from "./update-policy.js";
import {
  createUpdaterClient,
  type UpdaterCheck,
  type UpdaterClient,
  type UpdaterStatus,
} from "./updater-client.js";

const SESSION = "beam-studio.session=signed-in";
const OWNER_ORG = "org_owner";

const idleStatus: UpdaterStatus = {
  operationId: null,
  operation: null,
  phase: "idle",
  currentVersion: "1.4.0",
  targetVersion: null,
  previousVersion: null,
  message: null,
  error: null,
  startedAt: null,
  completedAt: null,
  updatedAt: "2026-09-25T10:00:00Z",
};

const newerRelease: UpdaterCheck = {
  channel: "stable",
  currentVersion: "1.4.0",
  latestVersion: "1.5.0",
  updateAvailable: true,
  publishedAt: "2026-09-24T10:00:00Z",
  releaseNotesUrl:
    "https://github.com/Beam-Network/beam-studio-public/releases/tag/studio-v1.5.0",
  requiresBackup: true,
};

function fakeUpdater(overrides: Partial<UpdaterClient> = {}) {
  const calls: string[] = [];
  const updater: UpdaterClient = {
    async status() {
      calls.push("status");
      return idleStatus;
    },
    async check() {
      calls.push("check");
      return newerRelease;
    },
    async apply() {
      calls.push("apply");
      return { operationId: "op_1" };
    },
    ...overrides,
  };
  return { updater, calls };
}

/**
 * A session manager with one signed-in member of the organization that owns
 * this installation. Updating the host is an act of ownership, so a session
 * alone is no longer enough.
 */
function sessions(role = "owner") {
  const services = {
    oauth: { hasSession: async () => true, shutdown() {} },
    beamApi: {
      getJson: async (path: string) => {
        if (path === "/api/me") return { id: "user_1", platformRole: "USER" };
        if (path === "/api/organizations") {
          return { organizations: [{ id: OWNER_ORG, role }] };
        }
        throw new Error(`unexpected Beam API call ${path}`);
      },
    },
  };
  return {
    get: (cookie: string | null) => (cookie === "signed-in" ? services : null),
    shutdown() {},
  } as unknown as StudioSessionManager;
}

async function server(
  t: TestContext,
  mode: UpdateMode,
  updater: UpdaterClient,
  options: { role?: string } = {},
) {
  const app = await buildServer({
    pgPool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
    sessions: sessions(options.role),
    admission: admittedInstance([OWNER_ORG]),
    updates: { mode, updater },
  });
  t.after(async () => {
    await app.close();
  });
  return app;
}

const orgHeaders = (cookie: string | null) =>
  cookie ? { cookie, "x-organization-id": OWNER_ORG } : {};

const get = (url: string, cookie: string | null = SESSION) => ({
  method: "GET" as const,
  url,
  headers: orgHeaders(cookie),
});
const apply = (
  payload: unknown = { confirm: true },
  cookie: string | null = SESSION,
) => ({
  method: "POST" as const,
  url: "/studio/updates/apply",
  headers: orgHeaders(cookie),
  payload: payload as Record<string, unknown>,
});

test("managed: reports channel, versions, and lets a signed-in member install", async (t) => {
  const { updater, calls } = fakeUpdater();
  const app = await server(t, "managed", updater);

  const status = await app.inject(get("/studio/updates/status"));
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(status.json().mode, "managed");
  assert.equal(status.json().installedVersion, "1.4.0");
  assert.equal(status.json().status.phase, "idle");

  const check = await app.inject(get("/studio/updates/check"));
  assert.equal(check.statusCode, 200, check.body);
  assert.deepEqual(
    {
      channel: check.json().channel,
      installed: check.json().installedVersion,
      available: check.json().availableVersion,
      updateAvailable: check.json().updateAvailable,
      canApply: check.json().canApply,
    },
    {
      channel: "stable",
      installed: "1.4.0",
      available: "1.5.0",
      updateAvailable: true,
      canApply: true,
    },
  );
  // Reading status and checking never installs anything.
  assert.deepEqual(calls, ["status", "check"]);

  const accepted = await app.inject(apply());
  assert.equal(accepted.statusCode, 202, accepted.body);
  assert.equal(accepted.json().operationId, "op_1");
  assert.equal(accepted.json().targetVersion, "1.5.0");
  assert.deepEqual(calls, ["status", "check", "check", "apply"]);
});

test("managed: installing requires an explicit confirmation", async (t) => {
  const { updater, calls } = fakeUpdater();
  const app = await server(t, "managed", updater);
  for (const payload of [{}, { confirm: "yes" }, { confirm: false }]) {
    const response = await app.inject(apply(payload));
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(response.json().code, "update_confirmation_required");
  }
  assert.deepEqual(calls, []);
});

test("notify-only: reports the new version but refuses to install it", async (t) => {
  const { updater, calls } = fakeUpdater();
  const app = await server(t, "notify-only", updater);

  const check = await app.inject(get("/studio/updates/check"));
  assert.equal(check.statusCode, 200, check.body);
  assert.equal(check.json().mode, "notify-only");
  assert.equal(check.json().updateAvailable, true);
  assert.equal(check.json().availableVersion, "1.5.0");
  assert.equal(check.json().canApply, false);

  const status = await app.inject(get("/studio/updates/status"));
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(status.json().canApply, false);

  const refused = await app.inject(apply());
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().code, "updates_notify_only");
  assert.ok(!calls.includes("apply"));
});

test("disabled: the update surface does not exist and the updater is never contacted", async (t) => {
  const { updater, calls } = fakeUpdater();
  const app = await server(t, "disabled", updater);
  for (const request of [
    get("/studio/updates/status"),
    get("/studio/updates/check"),
    apply(),
  ]) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 404, request.url);
    assert.equal(response.json().code, "updates_disabled");
  }
  assert.deepEqual(calls, []);
});

test("every update route requires a Studio session", async (t) => {
  const { updater, calls } = fakeUpdater();
  const app = await server(t, "managed", updater);
  for (const request of [
    get("/studio/updates/status", null),
    get("/studio/updates/check", null),
    apply({ confirm: true }, null),
    get("/studio/updates/check", "beam-studio.session=forged"),
  ]) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 401, request.url);
    assert.equal(response.json().code, "studio_session_required");
  }
  assert.deepEqual(calls, []);
});

test("update routes belong to the organization that owns the installation", async (t) => {
  const { updater, calls } = fakeUpdater();
  const app = await server(t, "managed", updater);

  // A signed-in account acting as some other tenant cannot redeploy this host.
  const stranger = await app.inject({
    method: "GET",
    url: "/studio/updates/check",
    headers: { cookie: SESSION, "x-organization-id": "org_stranger" },
  });
  assert.equal(stranger.statusCode, 403, stranger.body);
  assert.equal(stranger.json().code, "organization_forbidden");

  const applied = await app.inject({
    method: "POST",
    url: "/studio/updates/apply",
    headers: { cookie: SESSION, "x-organization-id": "org_stranger" },
    payload: { confirm: true },
  });
  assert.equal(applied.statusCode, 403, applied.body);
  assert.deepEqual(calls, [], "a refused caller still reached the updater");

  // The owning organization still can.
  const owner = await app.inject(get("/studio/updates/check"));
  assert.equal(owner.statusCode, 200, owner.body);
});

test("a read-only member of the owning organization cannot install", async (t) => {
  const { updater, calls } = fakeUpdater();
  const app = await server(t, "managed", updater, { role: "viewer" });
  const response = await app.inject(apply());
  assert.equal(response.statusCode, 403, response.body);
  assert.deepEqual(calls, []);
});

test("no newer version: nothing to install and apply is refused", async (t) => {
  const { updater, calls } = fakeUpdater({
    async check() {
      calls.push("check");
      return {
        ...newerRelease,
        latestVersion: "1.4.0",
        updateAvailable: false,
      };
    },
  });
  const app = await server(t, "managed", updater);

  const check = await app.inject(get("/studio/updates/check"));
  assert.equal(check.statusCode, 200, check.body);
  assert.equal(check.json().updateAvailable, false);
  assert.equal(check.json().canApply, false);

  const refused = await app.inject(apply());
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().code, "update_not_available");
  assert.ok(!calls.includes("apply"));
});

// The remaining tests drive the real Unix-socket client against a fake updater.

async function fakeUpdaterSocket(
  t: TestContext,
  handler: (method: string, path: string) => { status: number; body: unknown },
) {
  const directory = await mkdtemp(join(tmpdir(), "beam-updater-"));
  const socketPath = join(directory, "updater.sock");
  const requests: string[] = [];
  const socket: Server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const { status, body } = handler(request.method ?? "", request.url ?? "");
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => socket.listen(socketPath, resolve));
  t.after(async () => {
    await new Promise((resolve) => socket.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { socketPath, requests };
}

test("the socket client proxies status, check, and apply to the updater", async (t) => {
  const { socketPath, requests } = await fakeUpdaterSocket(
    t,
    (method, path) => {
      if (path === "/v1/status")
        return {
          status: 200,
          body: {
            phase: "pulling",
            operation: "apply",
            operationId: "op_9",
            currentVersion: "1.4.0",
            targetVersion: "1.5.0",
            message: "Pulling images",
            // Host details stay on the host.
            currentComposePath: "/opt/beam-studio/releases/1.4.0/compose.yml",
            currentImages: { api: "ghcr.io/x@sha256:abc" },
            updatedAt: "2026-09-25T10:00:00Z",
          },
        };
      if (path === "/v1/check")
        return { status: 200, body: { ...newerRelease, channel: "nightly" } };
      if (method === "POST" && path === "/v1/apply")
        return { status: 202, body: { accepted: true, operationId: "op_10" } };
      return { status: 404, body: { error: "not found" } };
    },
  );
  const client = createUpdaterClient({ socketPath });
  const status = await client.status();
  assert.equal(status.phase, "pulling");
  assert.equal(status.targetVersion, "1.5.0");
  assert.equal("currentComposePath" in status, false);
  assert.equal("currentImages" in status, false);
  assert.equal((await client.check()).channel, "nightly");
  assert.deepEqual(await client.apply(), { operationId: "op_10" });
  assert.deepEqual(requests, [
    "GET /v1/status",
    "GET /v1/check",
    "POST /v1/apply",
  ]);
});

test("updater errors surface as explicit API errors", async (t) => {
  const { socketPath } = await fakeUpdaterSocket(t, (_method, path) =>
    path === "/v1/check"
      ? {
          status: 502,
          body: { error: "release signature verification failed" },
        }
      : path === "/v1/apply"
        ? {
            status: 409,
            body: { error: "another updater operation is running" },
          }
        : { status: 500, body: { error: "state file unreadable" } },
  );
  const updater = createUpdaterClient({ socketPath });
  const app = await server(t, "managed", updater);

  const check = await app.inject(get("/studio/updates/check"));
  assert.equal(check.statusCode, 502, check.body);
  assert.equal(check.json().code, "updater_check_failed");
  assert.equal(check.json().error, "release signature verification failed");
  assert.equal(check.json().retryable, true);

  const status = await app.inject(get("/studio/updates/status"));
  assert.equal(status.statusCode, 502, status.body);
  assert.equal(status.json().code, "updater_status_failed");
  assert.equal(status.json().error, "state file unreadable");
});

test("an updater that rejects the apply reports a conflict", async (t) => {
  const { socketPath } = await fakeUpdaterSocket(t, (_method, path) =>
    path === "/v1/check"
      ? { status: 200, body: newerRelease }
      : {
          status: 409,
          body: { error: "another updater operation is running" },
        },
  );
  const app = await server(t, "managed", createUpdaterClient({ socketPath }));
  const response = await app.inject(apply());
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, "updater_conflict");
  assert.equal(response.json().error, "another updater operation is running");
});

test("a missing updater socket is reported as unavailable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "beam-updater-missing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const updater = createUpdaterClient({
    socketPath: join(directory, "absent.sock"),
  });
  const app = await server(t, "managed", updater);
  for (const request of [get("/studio/updates/status"), apply()]) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().code, "updater_unavailable");
    assert.match(response.json().error, /beam-updater\.service/);
  }
});
