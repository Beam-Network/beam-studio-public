import { webEnv } from "../env.js";
import { STUDIO_OAUTH_CLIENT_ID } from "../auth/oauth-service.js";

/** The scope of the one-time grant that lets Studio mint its instance key. */
export const INSTANCE_KEY_SCOPE = "studio:instance-key";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const REQUEST_TIMEOUT_MS = 15_000;

export class InstanceKeyError extends Error {
  /** Written for the owner; shown even for a 503 from Beam. */
  readonly expose = true;

  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "InstanceKeyError";
  }
}

export type InstanceKeyConsent = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

export type InstanceKeyConsentPoll =
  | { status: "authorization_pending" }
  | { status: "slow_down" }
  | { status: "approved"; grant: string };

export type MintedInstanceKey = {
  apiKey: {
    id: string;
    name: string;
    prefix: string | null;
    organizationId: string;
    studioInstanceId: string;
    createdAt: string | null;
  };
  secret: string;
  rotated: boolean;
};

/**
 * Beam's side of the instance key: consent at Beam Auth, minting and
 * self-revocation at the Beam API.
 *
 * The consent is a device authorization started with the signed-in owner's
 * `studio:access` token. It ends in a short-lived grant scoped
 * `studio:instance-key`, which only the mint endpoint accepts. Studio never
 * mints with the owner's session token itself.
 */
export class InstanceKeyClient {
  constructor(
    private readonly options: {
      authUrl: string;
      apiUrl: string;
      fetch: typeof globalThis.fetch;
    },
  ) {}

  async startConsent(input: {
    accessToken: string;
    organizationId: string;
    instanceId: string;
    instanceName: string;
  }): Promise<InstanceKeyConsent> {
    const response = await this.request(
      new URL("/oauth/device/authorize", this.options.authUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: STUDIO_OAUTH_CLIENT_ID,
          scope: INSTANCE_KEY_SCOPE,
          organization_id: input.organizationId,
          instance_id: input.instanceId,
          instance_name: input.instanceName,
        }),
      },
    );
    const data = await json(response);
    if (!response.ok) {
      throw refusal(response.status, data, "Beam Auth refused the request.");
    }
    return {
      deviceCode: requiredText(data, "device_code"),
      userCode: requiredText(data, "user_code"),
      verificationUri: requiredText(data, "verification_uri"),
      verificationUriComplete:
        text(data.verification_uri_complete) ??
        requiredText(data, "verification_uri"),
      expiresIn: requiredPositive(data, "expires_in"),
      interval: requiredPositive(data, "interval"),
    };
  }

  async pollConsent(deviceCode: string): Promise<InstanceKeyConsentPoll> {
    const response = await this.request(
      new URL("/oauth/token", this.options.authUrl),
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: DEVICE_GRANT,
          client_id: STUDIO_OAUTH_CLIENT_ID,
          device_code: deviceCode,
        }),
      },
    );
    const data = await json(response);
    if (!response.ok) {
      const code = text(data.error) ?? "oauth_error";
      if (code === "authorization_pending") {
        return { status: "authorization_pending" };
      }
      if (code === "slow_down") return { status: "slow_down" };
      throw refusal(response.status, data, "Beam Auth refused the consent.");
    }
    const grant = requiredText(data, "access_token");
    const scopes = (text(data.scope) ?? "").split(/\s+/);
    if (!scopes.includes(INSTANCE_KEY_SCOPE)) {
      throw new InstanceKeyError(
        "invalid_scope",
        "Beam Auth returned a grant without the instance key scope.",
        502,
      );
    }
    return { status: "approved", grant };
  }

  /** Redeems a grant. Beam rotates the instance's existing key, if any. */
  async mintKey(input: {
    grant: string;
    instanceId: string;
    instanceName: string;
  }): Promise<MintedInstanceKey> {
    const response = await this.request(
      new URL(
        `/api/studio/instances/${encodeURIComponent(input.instanceId)}/key`,
        this.options.apiUrl,
      ),
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${input.grant}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ instanceName: input.instanceName }),
      },
    );
    const data = await json(response);
    if (!response.ok) {
      throw refusal(response.status, data, "Beam did not create the key.");
    }
    const apiKey = record(data.apiKey);
    return {
      apiKey: {
        id: requiredText(apiKey, "id"),
        name: text(apiKey.name) ?? "Studio instance key",
        prefix: text(apiKey.prefix) ?? null,
        organizationId: requiredText(apiKey, "organizationId"),
        studioInstanceId: requiredText(apiKey, "studioInstanceId"),
        createdAt: text(apiKey.createdAt) ?? null,
      },
      secret: requiredText(data, "secret"),
      rotated: data.rotated === true,
    };
  }

  /**
   * Revokes the key with itself. A key Beam no longer accepts (already
   * revoked in the Console, or deleted) is reported as gone rather than as a
   * failure: there is nothing left to revoke.
   */
  async revokeKey(secret: string): Promise<"revoked" | "already_revoked"> {
    const response = await this.request(
      new URL("/v1/studio/instance-key", this.options.apiUrl),
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${secret}` },
      },
    );
    if (response.status === 204 || response.ok) return "revoked";
    if (response.status === 401) return "already_revoked";
    throw refusal(
      response.status,
      await json(response),
      "Beam did not revoke the key.",
    );
  }

  private async request(url: URL, init: RequestInit) {
    try {
      return await this.options.fetch(url, {
        ...init,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new InstanceKeyError(
        "beam_unreachable",
        `Studio could not reach Beam at ${url.origin}.`,
        503,
        true,
      );
    }
  }
}

export function createInstanceKeyClient(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
) {
  return new InstanceKeyClient({
    authUrl: webEnv.authUrl,
    apiUrl: webEnv.apiUrl,
    fetch: fetchImpl,
  });
}

/**
 * Beam Auth answers in OAuth form ({ error: code, error_description }); the
 * Beam API answers { code, error: message }. Both map to one error.
 */
function refusal(
  status: number,
  data: Record<string, unknown>,
  fallback: string,
) {
  const apiCode = text(data.code);
  const code = apiCode ?? text(data.error) ?? "beam_refused";
  const message =
    (apiCode ? text(data.error) : text(data.error_description)) ?? fallback;
  return new InstanceKeyError(
    code,
    message,
    status >= 500 ? 503 : status,
    status >= 500 || status === 429,
  );
}

async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    return record(await response.json());
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredText(data: Record<string, unknown>, field: string) {
  const value = text(data[field]);
  if (!value) {
    throw new InstanceKeyError(
      "invalid_beam_response",
      `Beam's response is missing ${field}.`,
      502,
    );
  }
  return value;
}

function requiredPositive(data: Record<string, unknown>, field: string) {
  const number = Number(data[field]);
  if (!Number.isFinite(number) || number <= 0) {
    throw new InstanceKeyError(
      "invalid_beam_response",
      `Beam's response is missing ${field}.`,
      502,
    );
  }
  return number;
}
