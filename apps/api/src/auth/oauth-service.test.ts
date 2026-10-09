import assert from "node:assert/strict";
import { test } from "node:test";
import {
  StudioOAuthService,
  STUDIO_OAUTH_CLIENT_ID,
  STUDIO_OAUTH_SCOPE,
} from "./oauth-service.js";
import type { RefreshTokenStore } from "./secure-token-store.js";

class MemoryStore implements RefreshTokenStore {
  value: string | null = null;
  saves: string[] = [];
  clearCount = 0;

  async load() {
    return this.value;
  }

  async save(value: string) {
    this.saves.push(value);
    this.value = value;
  }

  async clear() {
    this.clearCount += 1;
    this.value = null;
  }
}

test("uses OAuth form fields and snake_case device authorization data", async () => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const service = createService({
    fetch: async (input, init) => {
      requests.push({ url: new URL(String(input)), init });
      return jsonResponse({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://auth.example/device",
        verification_uri_complete:
          "https://auth.example/device?user_code=ABCD-EFGH",
        expires_in: 600,
        interval: 5,
      });
    },
  });

  const authorization = await service.authorizeDevice();
  assert.equal(requests[0]?.url.pathname, "/oauth/device/authorize");
  assert.equal(
    new Headers(requests[0]?.init?.headers).get("Content-Type"),
    "application/x-www-form-urlencoded",
  );
  const fields = new URLSearchParams(String(requests[0]?.init?.body));
  assert.equal(fields.get("client_id"), STUDIO_OAUTH_CLIENT_ID);
  assert.equal(fields.get("scope"), STUDIO_OAUTH_SCOPE);
  assert.equal(authorization.user_code, "ABCD-EFGH");
  assert.equal("device_code" in authorization, false);
});

test("reports a device authorization network failure as temporary", async () => {
  const service = createService({
    fetch: async () => {
      throw new Error("offline");
    },
  });
  await assert.rejects(
    service.authorizeDevice(),
    (error: unknown) =>
      (error as { statusCode?: unknown }).statusCode === 503 &&
      (error as { retryable?: unknown }).retryable === true,
  );
});

test("polling handles pending, slow_down, success, and refresh token rotation", async () => {
  const store = new MemoryStore();
  const responses = [
    jsonResponse(deviceAuthorization()),
    jsonResponse({ error: "authorization_pending" }, 400),
    jsonResponse({ error: "slow_down" }, 400),
    jsonResponse(successfulToken("access-1", "refresh-1")),
  ];
  const requests: Array<{ url: URL; fields: URLSearchParams }> = [];
  const service = createService({
    store,
    fetch: async (input, init) => {
      requests.push({
        url: new URL(String(input)),
        fields: new URLSearchParams(String(init?.body)),
      });
      return responses.shift()!;
    },
  });

  const authorization = await service.authorizeDevice();
  assert.deepEqual(await service.pollDevice(authorization.attempt_id), {
    status: "authorization_pending",
    interval: 5,
    expires_in: 600,
  });
  assert.deepEqual(await service.pollDevice(authorization.attempt_id), {
    status: "slow_down",
    interval: 10,
    expires_in: 600,
  });
  assert.deepEqual(await service.pollDevice(authorization.attempt_id), {
    status: "connected",
    scope: STUDIO_OAUTH_SCOPE,
  });
  assert.deepEqual(store.saves, ["refresh-1"]);
  assert.equal(requests[1]?.url.pathname, "/oauth/token");
  assert.equal(
    requests[1]?.fields.get("grant_type"),
    "urn:ietf:params:oauth:grant-type:device_code",
  );
  assert.equal(requests[1]?.fields.get("device_code"), "device-secret");
});

test("network polling uses bounded backoff and retains the attempt", async () => {
  let calls = 0;
  const service = createService({
    fetch: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(deviceAuthorization());
      if (calls < 5) throw new Error("offline");
      return jsonResponse({ error: "authorization_pending" }, 400);
    },
  });
  const authorization = await service.authorizeDevice();
  assert.equal(
    pollInterval(await service.pollDevice(authorization.attempt_id)),
    5,
  );
  assert.equal(
    pollInterval(await service.pollDevice(authorization.attempt_id)),
    10,
  );
  assert.equal(
    pollInterval(await service.pollDevice(authorization.attempt_id)),
    20,
  );
  assert.equal(
    (await service.pollDevice(authorization.attempt_id)).status,
    "authorization_pending",
  );
});

test("denial, expiration, invalid grants, and explicit cancellation stop polling", async () => {
  for (const code of ["access_denied", "expired_token", "invalid_grant"]) {
    const responses = [
      jsonResponse(deviceAuthorization()),
      jsonResponse({ error: code }, 400),
    ];
    const service = createService({
      fetch: async () => responses.shift()!,
    });
    const authorization = await service.authorizeDevice();
    await assert.rejects(
      service.pollDevice(authorization.attempt_id),
      (error: unknown) => (error as { code?: unknown }).code === code,
    );
    await assert.rejects(
      service.pollDevice(authorization.attempt_id),
      (error: unknown) =>
        (error as { code?: unknown }).code === "invalid_grant",
    );
  }

  const service = createService({
    fetch: async () => jsonResponse(deviceAuthorization()),
  });
  const authorization = await service.authorizeDevice();
  service.cancelDevice(authorization.attempt_id);
  await assert.rejects(
    service.pollDevice(authorization.attempt_id),
    (error: unknown) => (error as { code?: unknown }).code === "invalid_grant",
  );
});

test("an expired local device authorization is rejected without another token request", async () => {
  let now = 1_000_000;
  let requests = 0;
  const service = new StudioOAuthService({
    authUrl: "https://auth.example",
    fetch: async () => {
      requests += 1;
      return jsonResponse({ ...deviceAuthorization(), expires_in: 1 });
    },
    store: new MemoryStore(),
    now: () => now,
  });
  const authorization = await service.authorizeDevice();
  now += 1_001;
  await assert.rejects(
    service.pollDevice(authorization.attempt_id),
    (error: unknown) => (error as { code?: unknown }).code === "expired_token",
  );
  assert.equal(requests, 1);
});

test("concurrent refreshes share one request and persist only the new generation", async () => {
  const store = new MemoryStore();
  store.value = "refresh-old";
  let refreshCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = createService({
    store,
    fetch: async (_input, init) => {
      const fields = new URLSearchParams(String(init?.body));
      assert.equal(fields.get("refresh_token"), "refresh-old");
      refreshCalls += 1;
      await gate;
      return jsonResponse(successfulToken("access-new", "refresh-new"));
    },
  });

  const first = service.getAccessToken();
  const second = service.getAccessToken();
  release();
  assert.deepEqual(await Promise.all([first, second]), [
    "access-new",
    "access-new",
  ]);
  assert.equal(refreshCalls, 1);
  assert.deepEqual(store.saves, ["refresh-new"]);
  assert.equal(store.value, "refresh-new");
});

test("logout revokes the refresh token and always clears local credentials", async () => {
  const store = new MemoryStore();
  store.value = "refresh-current";
  const requests: URLSearchParams[] = [];
  const service = createService({
    store,
    fetch: async (_input, init) => {
      requests.push(new URLSearchParams(String(init?.body)));
      throw new Error("revoke unavailable");
    },
  });

  await service.logout();
  assert.equal(requests[0]?.get("client_id"), STUDIO_OAUTH_CLIENT_ID);
  assert.equal(requests[0]?.get("token"), "refresh-current");
  assert.equal(requests[0]?.get("token_type_hint"), "refresh_token");
  assert.equal(store.value, null);
  assert.equal(store.clearCount, 1);
});

function createService(options: {
  fetch: typeof globalThis.fetch;
  store?: RefreshTokenStore;
}) {
  return new StudioOAuthService({
    authUrl: "https://auth.example",
    fetch: options.fetch,
    store: options.store ?? new MemoryStore(),
    now: () => 1_000_000,
  });
}

function deviceAuthorization() {
  return {
    device_code: "device-secret",
    user_code: "ABCD-EFGH",
    verification_uri: "https://auth.example/device",
    verification_uri_complete:
      "https://auth.example/device?user_code=ABCD-EFGH",
    expires_in: 600,
    interval: 5,
  };
}

function successfulToken(access_token: string, refresh_token: string) {
  return {
    access_token,
    token_type: "Bearer",
    expires_in: 900,
    refresh_token,
    scope: STUDIO_OAUTH_SCOPE,
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pollInterval(
  result: Awaited<ReturnType<StudioOAuthService["pollDevice"]>>,
) {
  assert.notEqual(result.status, "connected");
  return result.status === "connected" ? 0 : result.interval;
}

test("logout cannot be undone by a refresh response already in flight", async () => {
  const store = new MemoryStore();
  store.value = "refresh-old";
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = createService({
    store,
    fetch: async (_url, init) => {
      const fields = new URLSearchParams(String(init?.body));
      if (fields.get("grant_type") === "refresh_token") {
        started();
        await gate;
        return jsonResponse(successfulToken("access-new", "refresh-new"));
      }
      return jsonResponse({});
    },
  });
  const refresh = service.getAccessToken();
  const rejected = assert.rejects(refresh, /sign in is required/i);
  await entered;
  await service.logout();
  release();
  await rejected;
  assert.equal(await service.hasSession(), false);
  assert.equal(store.value, null);
  assert.deepEqual(store.saves, []);
});

test("logout waits for a concurrent token write and removes its result", async () => {
  const store = new MemoryStore();
  store.value = "refresh-old";
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const save = store.save.bind(store);
  store.save = async (value) => {
    started();
    await gate;
    await save(value);
  };
  const service = createService({
    store,
    fetch: async () =>
      jsonResponse(successfulToken("access-new", "refresh-new")),
  });
  const refresh = service.getAccessToken();
  const rejected = assert.rejects(refresh, /sign in is required/i);
  await entered;
  const logout = service.logout();
  assert.equal(await service.hasSession(), false);
  release();
  await Promise.all([logout, rejected]);
  assert.equal(store.value, null);
  await assert.rejects(service.getAccessToken(), /sign in is required/i);
});

test("cancelling a pending login prevents its late success from creating a session", async () => {
  const store = new MemoryStore();
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = createService({
    store,
    fetch: async (url) => {
      if (String(url).endsWith("/oauth/device/authorize"))
        return jsonResponse(deviceAuthorization());
      started();
      await gate;
      return jsonResponse(successfulToken("access-new", "refresh-new"));
    },
  });
  const attempt = await service.authorizeDevice();
  const poll = service.pollDevice(attempt.attempt_id);
  const rejected = assert.rejects(poll);
  await entered;
  service.cancelDevice(attempt.attempt_id);
  release();
  await rejected;
  assert.equal(await service.hasSession(), false);
  assert.equal(store.value, null);
});
