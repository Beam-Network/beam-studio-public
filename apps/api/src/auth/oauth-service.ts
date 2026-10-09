import { randomUUID } from "node:crypto";
import { webEnv } from "../env.js";
import type { RefreshTokenStore } from "./secure-token-store.js";

export const STUDIO_OAUTH_CLIENT_ID = "beam-studio";
export const STUDIO_OAUTH_SCOPE = "studio:access";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const SLOW_DOWN_SECONDS = 5;
const MAX_NETWORK_BACKOFF_SECONDS = 30;

export type DeviceAuthorization = {
  attempt_id: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

export type DevicePollResult =
  | { status: "authorization_pending"; interval: number; expires_in: number }
  | { status: "slow_down"; interval: number; expires_in: number }
  | { status: "network_error"; interval: number; expires_in: number }
  | { status: "connected"; scope: string };

type DeviceAuthorizationPayload = Omit<DeviceAuthorization, "attempt_id"> & {
  device_code: string;
};

type TokenPayload = {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
};

type DeviceAttempt = DeviceAuthorizationPayload & {
  expires_at: number;
  network_failures: number;
};

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

export class StudioOAuthService {
  private readonly attempts = new Map<string, DeviceAttempt>();
  private expired = false;
  private storeMutation: Promise<unknown> = Promise.resolve();
  private readonly polls = new Map<string, Promise<DevicePollResult>>();
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private refreshPromise: Promise<string> | null = null;

  constructor(
    private readonly options: {
      authUrl: string;
      fetch: typeof globalThis.fetch;
      store: RefreshTokenStore;
      now: () => number;
    },
  ) {}

  async authorizeDevice(): Promise<DeviceAuthorization> {
    this.assertActive();
    let response: Response;
    try {
      response = await this.oauthRequest("/oauth/device/authorize", {
        client_id: STUDIO_OAUTH_CLIENT_ID,
        scope: STUDIO_OAUTH_SCOPE,
      });
    } catch {
      throw new OAuthError(
        "temporary_auth_error",
        "Beam Auth is temporarily unavailable",
        503,
        true,
      );
    }
    const data = await responseJson(response);
    if (!response.ok) {
      throw oauthResponseError(
        data,
        response.status,
        "Unable to start device login",
      );
    }

    this.assertActive();
    const payload = parseDeviceAuthorization(data);
    const attemptId = randomUUID();
    this.attempts.set(attemptId, {
      ...payload,
      expires_at: this.options.now() + payload.expires_in * 1_000,
      network_failures: 0,
    });
    return {
      attempt_id: attemptId,
      user_code: payload.user_code,
      verification_uri: payload.verification_uri,
      verification_uri_complete: payload.verification_uri_complete,
      expires_in: payload.expires_in,
      interval: payload.interval,
    };
  }

  pollDevice(attemptId: string): Promise<DevicePollResult> {
    const existing = this.polls.get(attemptId);
    if (existing) return existing;
    const pending = this.performDevicePoll(attemptId).finally(() =>
      this.polls.delete(attemptId),
    );
    this.polls.set(attemptId, pending);
    return pending;
  }

  private async performDevicePoll(
    attemptId: string,
  ): Promise<DevicePollResult> {
    this.assertActive();
    const attempt = this.requiredAttempt(attemptId);
    const remaining = remainingSeconds(attempt.expires_at, this.options.now());
    if (remaining <= 0) {
      this.attempts.delete(attemptId);
      throw new OAuthError("expired_token", "The device code has expired", 400);
    }

    let response: Response;
    try {
      response = await this.oauthRequest("/oauth/token", {
        grant_type: DEVICE_GRANT,
        client_id: STUDIO_OAUTH_CLIENT_ID,
        device_code: attempt.device_code,
      });
    } catch {
      attempt.network_failures += 1;
      const interval = boundedNetworkBackoff(
        attempt.interval,
        attempt.network_failures,
        remaining,
      );
      return { status: "network_error", interval, expires_in: remaining };
    }

    const data = await responseJson(response);
    if (!response.ok) {
      const code = stringField(data, "error") ?? "oauth_error";
      if (code === "authorization_pending") {
        attempt.network_failures = 0;
        return {
          status: "authorization_pending",
          interval: attempt.interval,
          expires_in: remaining,
        };
      }
      if (code === "slow_down") {
        attempt.network_failures = 0;
        attempt.interval += SLOW_DOWN_SECONDS;
        return {
          status: "slow_down",
          interval: attempt.interval,
          expires_in: remaining,
        };
      }
      if (["access_denied", "expired_token", "invalid_grant"].includes(code)) {
        this.attempts.delete(attemptId);
      }
      if (response.status >= 500) {
        attempt.network_failures += 1;
        const interval = boundedNetworkBackoff(
          attempt.interval,
          attempt.network_failures,
          remaining,
        );
        return { status: "network_error", interval, expires_in: remaining };
      }
      throw oauthResponseError(
        data,
        response.status,
        "Unable to finish device login",
      );
    }

    const token = parseTokenPayload(data);
    try {
      await this.acceptRotatedToken(
        token,
        () => this.attempts.get(attemptId) === attempt,
      );
    } catch (error) {
      this.attempts.delete(attemptId);
      await this.expireSession();
      if (error instanceof OAuthError) throw error;
      throw new OAuthError(
        "secure_storage_error",
        "Studio could not persist the OAuth session securely",
        500,
      );
    }
    this.attempts.delete(attemptId);
    return { status: "connected", scope: token.scope };
  }

  cancelDevice(attemptId: string) {
    this.attempts.delete(attemptId);
  }

  shutdown() {
    this.attempts.clear();
  }

  async hasSession() {
    if (this.expired) return false;
    const present = Boolean(
      this.accessToken || (await this.options.store.load()),
    );
    return !this.expired && present;
  }

  async getAccessToken(options: { forceRefresh?: boolean } = {}) {
    this.assertActive();
    if (
      !options.forceRefresh &&
      this.accessToken &&
      this.accessTokenExpiresAt > this.options.now() + 30_000
    ) {
      return this.accessToken;
    }
    return this.refreshAccessToken();
  }

  async logout() {
    // Invalidate immediately, before any asynchronous rotation or revocation.
    this.expired = true;
    this.clearMemory();
    this.attempts.clear();
    const refreshToken = await this.mutateStore(async () => {
      const token = await this.options.store.load();
      await this.options.store.clear();
      return token;
    });
    if (refreshToken) {
      await this.oauthRequest("/oauth/revoke", {
        client_id: STUDIO_OAUTH_CLIENT_ID,
        token: refreshToken,
        token_type_hint: "refresh_token",
      }).catch(() => undefined);
    }
  }

  async expireSession() {
    this.expired = true;
    this.clearMemory();
    this.attempts.clear();
    await this.mutateStore(() => this.options.store.clear());
  }

  private refreshAccessToken() {
    if (!this.refreshPromise) {
      this.refreshPromise = this.performRefresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async performRefresh() {
    const refreshToken = await this.options.store.load();
    this.assertActive();
    if (!refreshToken) {
      throw new OAuthError("session_expired", "Sign in is required", 401);
    }

    let response: Response;
    try {
      response = await this.oauthRequest("/oauth/token", {
        grant_type: "refresh_token",
        client_id: STUDIO_OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
      });
    } catch {
      throw new OAuthError(
        "temporary_auth_error",
        "Beam Auth is temporarily unavailable",
        503,
        true,
      );
    }
    const data = await responseJson(response);
    if (!response.ok) {
      if (response.status >= 500) {
        throw new OAuthError(
          "temporary_auth_error",
          "Beam Auth is temporarily unavailable",
          503,
          true,
        );
      }
      // A rejected rotating token can never safely be retried.
      await this.expireSession();
      throw oauthResponseError(data, 401, "The Studio session has expired");
    }

    const token = parseTokenPayload(data);
    try {
      await this.acceptRotatedToken(token);
    } catch (error) {
      // The server has already consumed the prior generation. Never reuse it.
      await this.expireSession();
      throw error;
    }
    return token.access_token;
  }

  private async acceptRotatedToken(token: TokenPayload, valid = () => true) {
    await this.mutateStore(async () => {
      this.assertActive();
      if (!valid())
        throw new OAuthError(
          "invalid_grant",
          "The device login attempt was cancelled",
          400,
        );
      await this.options.store.save(token.refresh_token);
      this.assertActive();
      if (!valid())
        throw new OAuthError(
          "invalid_grant",
          "The device login attempt was cancelled",
          400,
        );
      this.accessToken = token.access_token;
      this.accessTokenExpiresAt = this.options.now() + token.expires_in * 1_000;
    });
  }

  private mutateStore<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.storeMutation.then(operation);
    this.storeMutation = pending.catch(() => undefined);
    return pending;
  }

  private assertActive() {
    if (this.expired)
      throw new OAuthError("session_expired", "Sign in is required", 401);
  }

  private clearMemory() {
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
  }

  private requiredAttempt(attemptId: string) {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      throw new OAuthError(
        "invalid_grant",
        "The device login attempt is no longer valid",
        400,
      );
    }
    return attempt;
  }

  private oauthRequest(path: string, fields: Record<string, string>) {
    return this.options.fetch(new URL(path, this.options.authUrl), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
      cache: "no-store",
    });
  }
}

export function createStudioOAuthService(options: {
  authUrl?: string;
  fetch?: typeof globalThis.fetch;
  store: RefreshTokenStore;
  now?: () => number;
}) {
  return new StudioOAuthService({
    authUrl: options.authUrl ?? webEnv.authUrl,
    fetch: options.fetch ?? globalThis.fetch,
    store: options.store,
    now: options.now ?? Date.now,
  });
}

function parseDeviceAuthorization(
  data: Record<string, unknown>,
): DeviceAuthorizationPayload {
  return {
    device_code: requiredString(data, "device_code"),
    user_code: requiredString(data, "user_code"),
    verification_uri: requiredUrl(data, "verification_uri"),
    verification_uri_complete: requiredUrl(data, "verification_uri_complete"),
    expires_in: positiveNumber(data, "expires_in"),
    interval: positiveNumber(data, "interval"),
  };
}

function parseTokenPayload(data: Record<string, unknown>): TokenPayload {
  const tokenType = requiredString(data, "token_type");
  const scope = requiredString(data, "scope");
  if (tokenType.toLowerCase() !== "bearer") {
    throw new OAuthError(
      "invalid_token_response",
      "Beam Auth returned an unsupported token type",
      502,
    );
  }
  if (!scope.split(/\s+/).includes(STUDIO_OAUTH_SCOPE)) {
    throw new OAuthError(
      "invalid_scope",
      "Beam Auth did not grant Studio access",
      403,
    );
  }
  return {
    access_token: requiredString(data, "access_token"),
    token_type: tokenType,
    expires_in: positiveNumber(data, "expires_in"),
    refresh_token: requiredString(data, "refresh_token"),
    scope,
  };
}

function requiredString(data: Record<string, unknown>, field: string) {
  const value = stringField(data, field);
  if (!value) {
    throw new OAuthError(
      "invalid_token_response",
      `Beam Auth omitted ${field}`,
      502,
    );
  }
  return value;
}

function requiredUrl(data: Record<string, unknown>, field: string) {
  const value = requiredString(data, field);
  try {
    return new URL(value).toString();
  } catch {
    throw new OAuthError(
      "invalid_token_response",
      `Beam Auth returned an invalid ${field}`,
      502,
    );
  }
}

function positiveNumber(data: Record<string, unknown>, field: string) {
  const value = data[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new OAuthError(
      "invalid_token_response",
      `Beam Auth returned an invalid ${field}`,
      502,
    );
  }
  return Math.floor(value);
}

function stringField(data: Record<string, unknown>, field: string) {
  const value = data[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function responseJson(
  response: Response,
): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function oauthResponseError(
  data: Record<string, unknown>,
  status: number,
  fallback: string,
) {
  const code = stringField(data, "error") ?? "oauth_error";
  const description = stringField(data, "error_description") ?? fallback;
  return new OAuthError(
    code,
    description,
    status >= 500 ? 503 : status,
    status >= 500,
  );
}

function remainingSeconds(expiresAt: number, now: number) {
  return Math.max(0, Math.ceil((expiresAt - now) / 1_000));
}

function boundedNetworkBackoff(
  base: number,
  failures: number,
  remaining: number,
) {
  const exponential = base * 2 ** Math.max(0, failures - 1);
  return Math.max(
    1,
    Math.min(MAX_NETWORK_BACKOFF_SECONDS, remaining, exponential),
  );
}
