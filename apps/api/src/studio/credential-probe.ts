import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  randomUUID,
} from "node:crypto";
import { McpError, listMcpTools } from "@beam-studio/core";

/**
 * Live reachability checks for a credential, run before it is saved.
 *
 * These run in the API process, not in a worker sandbox, so they are not
 * subject to the trusted-node network allowlist. They are still deliberately
 * narrow: each probe performs the cheapest call that proves the credential can
 * authenticate, with a short timeout, and never echoes secret material into an
 * error message.
 *
 * Results are recorded in secrets.credential_validation_events.
 */

export type CredentialProbeStatus = "valid" | "invalid" | "error" | "skipped";

export type CredentialProbeResult = {
  status: CredentialProbeStatus;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
};

type Payload = Record<string, unknown>;

const PROBE_TIMEOUT_MS = 15_000;

export async function probeCredential(input: {
  credentialType: string;
  payload: Payload;
}): Promise<CredentialProbeResult> {
  const probe = probes[input.credentialType];
  if (!probe) {
    return {
      status: "skipped",
      errorCode: "no_probe",
      errorMessage: `No connection test is defined for ${input.credentialType}.`,
    };
  }
  try {
    return await probe(input.payload);
  } catch (error) {
    // A thrown probe means the check itself failed, which is distinct from the
    // credential being rejected: the caller may choose to save anyway.
    return {
      status: "error",
      errorCode: "probe_failed",
      errorMessage: redact(errorText(error), input.payload),
    };
  }
}

const probes: Record<
  string,
  (payload: Payload) => Promise<CredentialProbeResult>
> = {
  salesforce_client_credentials: async (payload) => {
    const instanceUrl = requireUrl(payload, "instance_url", "Instance URL");
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: text(payload.client_id),
      client_secret: text(payload.client_secret),
    });
    return tokenProbe(`${instanceUrl}/services/oauth2/token`, body, payload, {
      onSuccess: (json) => ({
        instanceUrl: text(json.instance_url) || instanceUrl,
        tokenType: text(json.token_type),
      }),
    });
  },

  salesforce_jwt: async (payload) => {
    const loginUrl =
      optionalUrl(payload, "login_url") || "https://login.salesforce.com";
    const assertion = signJwt(
      {
        iss: text(payload.client_id),
        sub: text(payload.username),
        aud: loginUrl,
        exp: Math.floor(Date.now() / 1000) + 180,
      },
      text(payload.private_key),
      text(payload.private_key_passphrase) || undefined,
    );
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });
    return tokenProbe(`${loginUrl}/services/oauth2/token`, body, payload, {
      onSuccess: (json) => ({ instanceUrl: text(json.instance_url) }),
    });
  },

  adobe_aep_oauth_s2s: async (payload) => {
    const loginUrl =
      optionalUrl(payload, "login_url") || "https://ims-na1.adobelogin.com";
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: text(payload.client_id),
      client_secret: text(payload.client_secret),
      scope: text(payload.scopes) || "openid,AdobeID,read_organizations",
    });
    return tokenProbe(`${loginUrl}/ims/token/v3`, body, payload, {
      onSuccess: (json) => ({ expiresIn: json.expires_in }),
    });
  },

  databricks_oauth_m2m: async (payload) => {
    const baseUrl = requireUrl(payload, "base_url", "Workspace URL");
    // Databricks documents the client credentials as HTTP Basic on this
    // endpoint rather than as form fields.
    return tokenProbe(
      `${baseUrl}/oidc/v1/token`,
      new URLSearchParams({
        grant_type: "client_credentials",
        scope: "all-apis",
      }),
      payload,
      {
        basicAuth: {
          user: text(payload.client_id),
          password: text(payload.client_secret),
        },
        onSuccess: (json) => ({ expiresIn: json.expires_in }),
      },
    );
  },

  databricks_pat: async (payload) => {
    const baseUrl = requireUrl(payload, "base_url", "Workspace URL");
    // SCIM "Me" is the cheapest call that proves the token authenticates and
    // is available on every workspace regardless of entitlements.
    const response = await fetch(`${baseUrl}/api/2.0/preview/scim/v2/Me`, {
      headers: {
        Authorization: `Bearer ${text(payload.token)}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const json = await safeJson(response);
    if (response.ok) {
      return { status: "valid", metadata: { userName: text(json.userName) } };
    }
    return {
      status: response.status >= 500 ? "error" : "invalid",
      errorCode: text(json.error_code) || `http_${response.status}`,
      errorMessage: redact(
        text(json.message) || `Databricks returned HTTP ${response.status}.`,
        payload,
      ),
    };
  },

  snowflake_pat: async (payload) =>
    snowflakeStatementProbe(
      payload,
      text(payload.token),
      "PROGRAMMATIC_ACCESS_TOKEN",
    ),

  snowflake_key_pair: async (payload) => {
    const account = snowflakeAccount(payload);
    const user = text(payload.user).toUpperCase();
    const privateKey = text(payload.private_key);
    const passphrase = text(payload.private_key_passphrase) || undefined;
    const fingerprint = snowflakePublicKeyFingerprint(privateKey, passphrase);
    const now = Math.floor(Date.now() / 1000);
    const jwt = signJwt(
      {
        iss: `${account}.${user}.${fingerprint}`,
        sub: `${account}.${user}`,
        iat: now,
        exp: now + 180,
      },
      privateKey,
      passphrase,
    );
    return snowflakeStatementProbe(payload, jwt, "KEYPAIR_JWT");
  },

  /** The Hub identifies a token through whoami, which also reveals its scope. */
  huggingface_token: async (payload) => {
    const token = text(payload.token);
    if (!token) {
      return {
        status: "invalid",
        errorCode: "no_token",
        errorMessage: "No access token was provided.",
      };
    }
    const endpoint =
      optionalUrl(payload, "endpoint") || "https://huggingface.co";
    const response = await fetch(`${endpoint}/api/whoami-v2`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        status: response.status >= 500 ? "error" : "invalid",
        errorCode: `http_${response.status}`,
        errorMessage:
          response.status === 401 || response.status === 403
            ? "Hugging Face rejected this token."
            : `Hugging Face returned status ${response.status}.`,
      };
    }
    const json = await safeJson(response);
    const auth = json.auth as { accessToken?: { role?: string } } | undefined;
    const role = text(auth?.accessToken?.role);
    return {
      status: "valid",
      metadata: {
        name: text(json.name) || null,
        role: role || null,
        // A read token authenticates fine but cannot push, which is worth
        // surfacing at save time rather than mid-transfer.
        note: role === "read" ? "Uploads need a write token." : null,
      },
    };
  },

  /**
   * Slack answers HTTP 200 even when it rejects the call, so `ok` is the only
   * reliable signal. A missing chat:write makes the token useless to the Slack
   * action, so that is a rejection; a missing users:read.email only costs the
   * ability to address a person by email, so the token is still valid.
   */
  slack_bot_token: async (payload) => {
    const token = text(payload.token);
    if (!token) {
      return {
        status: "invalid",
        errorCode: "no_token",
        errorMessage: "No bot token was provided.",
      };
    }
    const response = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        status: response.status >= 500 ? "error" : "invalid",
        errorCode: `http_${response.status}`,
        errorMessage: `Slack returned status ${response.status}.`,
      };
    }
    const json = await safeJson(response);
    if (json.ok !== true) {
      return {
        status: "invalid",
        errorCode: text(json.error) || "unknown_error",
        errorMessage: `Slack rejected this token: ${text(json.error) || "unknown error"}.`,
      };
    }
    const metadata = json.response_metadata as
      | { scopes?: string[] }
      | undefined;
    const scopes = metadata?.scopes;
    if (scopes && !scopes.includes("chat:write")) {
      return {
        status: "invalid",
        errorCode: "missing_scope",
        errorMessage:
          "This token is missing the chat:write scope and cannot post messages.",
      };
    }
    return {
      status: "valid",
      metadata: {
        team: text(json.team) || null,
        user: text(json.user) || null,
        note:
          scopes && !scopes.includes("users:read.email")
            ? "Without users:read.email this token can post to channels but cannot address a person by email address."
            : null,
      },
    };
  },

  /**
   * Listing tools is the cheapest call that proves the endpoint is reachable
   * and the credential accepted, and the count is the number a user actually
   * cares about: a server with no configured actions authenticates fine and is
   * useless to the Zapier action.
   */
  zapier_mcp: async (payload) => {
    const endpoint = requireUrl(payload, "base_url", "The MCP server URL");
    const apiKey = text(payload.api_key);
    try {
      const tools = await listMcpTools(
        {
          endpoint,
          ...(apiKey ? { apiKey } : {}),
          timeoutMs: PROBE_TIMEOUT_MS,
        },
        // One shot: a probe runs while someone waits on a form, so a backoff
        // ladder would read as a hang.
        { maxAttempts: 1 },
      );
      return {
        status: "valid",
        metadata: {
          toolCount: tools.length,
          tools: tools.slice(0, 25).map((tool) => tool.name),
          note: tools.length
            ? null
            : "This MCP server exposes no actions yet. Add some at mcp.zapier.com before using it in a workflow.",
        },
      };
    } catch (error) {
      if (error instanceof McpError) {
        return {
          // A refusal is the credential's fault; anything retryable is the
          // network's, and the caller may reasonably save anyway.
          status: error.retryable ? "error" : "invalid",
          errorCode:
            error.code === null ? "mcp_error" : `jsonrpc_${error.code}`,
          errorMessage: redact(error.message, payload),
        };
      }
      throw error;
    }
  },
};

/** POST an OAuth token request and classify the outcome. */
async function tokenProbe(
  url: string,
  body: URLSearchParams,
  payload: Payload,
  options: {
    onSuccess?: (json: Payload) => Record<string, unknown>;
    /** Some providers take the client credentials as Basic auth, not form fields. */
    basicAuth?: { user: string; password: string };
  } = {},
): Promise<CredentialProbeResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(options.basicAuth
        ? {
            Authorization: `Basic ${Buffer.from(
              `${options.basicAuth.user}:${options.basicAuth.password}`,
            ).toString("base64")}`,
          }
        : {}),
    },
    body,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const json = await safeJson(response);

  if (response.ok && text(json.access_token)) {
    return { status: "valid", metadata: options.onSuccess?.(json) ?? {} };
  }
  // A 4xx here means the provider understood us and refused the credential.
  const providerMessage =
    text(json.error_description) ||
    text(json.error_summary) ||
    text(json.error);
  return {
    status: response.status >= 500 ? "error" : "invalid",
    errorCode: text(json.error) || `http_${response.status}`,
    errorMessage: redact(
      providerMessage || `Provider returned HTTP ${response.status}.`,
      payload,
    ),
  };
}

async function snowflakeStatementProbe(
  payload: Payload,
  token: string,
  tokenType: string,
): Promise<CredentialProbeResult> {
  const baseUrl = requireUrl(payload, "base_url", "Account URL");
  const response = await fetch(`${baseUrl}/api/v2/statements`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Snowflake-Authorization-Token-Type": tokenType,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      statement: "select 1",
      timeout: 10,
      ...(text(payload.role) ? { role: text(payload.role) } : {}),
      ...(text(payload.warehouse)
        ? { warehouse: text(payload.warehouse) }
        : {}),
      ...(text(payload.database) ? { database: text(payload.database) } : {}),
      ...(text(payload.schema) ? { schema: text(payload.schema) } : {}),
    }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const json = await safeJson(response);
  if (response.ok) {
    return {
      status: "valid",
      metadata: { statementHandle: text(json.statementHandle) },
    };
  }
  return {
    status: response.status >= 500 ? "error" : "invalid",
    errorCode: text(json.code) || `http_${response.status}`,
    errorMessage: redact(
      text(json.message) || `Snowflake returned HTTP ${response.status}.`,
      payload,
    ),
  };
}

/** RS256 JWT. Both Salesforce and Snowflake use the same shape. */
function signJwt(claims: Payload, privateKey: string, passphrase?: string) {
  if (!privateKey.trim()) {
    throw new Error("A private key is required.");
  }
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(
    passphrase ? { key: privateKey, passphrase } : privateKey,
  );
  return `${signingInput}.${signature.toString("base64url")}`;
}

/**
 * Snowflake identifies a key pair by SHA256 of the DER public key, which it
 * expects as the `SHA256:<base64>` portion of the JWT issuer.
 */
function snowflakePublicKeyFingerprint(
  privateKey: string,
  passphrase?: string,
) {
  // createPublicKey does not accept a private-key input shape, so derive a
  // KeyObject first and let it project the public half.
  const publicKey = createPublicKey(
    createPrivateKey(passphrase ? { key: privateKey, passphrase } : privateKey),
  );
  const der = publicKey.export({ type: "spki", format: "der" });
  return `SHA256:${createHash("sha256").update(der).digest("base64")}`;
}

function snowflakeAccount(payload: Payload) {
  // Snowflake rejects a JWT whose account identifier contains periods.
  return text(payload.account).toUpperCase().split(".")[0] ?? "";
}

async function safeJson(response: Response): Promise<Payload> {
  try {
    const parsed = (await response.json()) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Payload) : {};
  } catch {
    return {};
  }
}

/**
 * Providers occasionally echo a submitted value back in an error. Strip every
 * secret-shaped field from the message before it reaches a log or a browser.
 */
function redact(message: string, payload: Payload) {
  let result = message;
  for (const key of [
    "client_secret",
    "private_key",
    "private_key_passphrase",
    "token",
    "api_key",
    "secret_access_key",
    "signing_secret",
    // Usually not secret, but Zapier's MCP endpoint carries a per-server secret
    // in its path, and a probe error is one of the few places a URL is echoed
    // back verbatim.
    "base_url",
  ]) {
    const value = text(payload[key]);
    if (value.length >= 4) {
      result = result.split(value).join("[redacted]");
    }
  }
  return result.slice(0, 500);
}

function requireUrl(payload: Payload, key: string, label: string) {
  const value = optionalUrl(payload, key);
  if (!value) {
    throw new Error(`${label} is required to test this credential.`);
  }
  return value;
}

function optionalUrl(payload: Payload, key: string) {
  const value = text(payload[key]).replace(/\/+$/, "");
  if (!value) {
    return "";
  }
  try {
    new URL(value);
  } catch {
    throw new Error(`"${value}" is not a valid URL.`);
  }
  return value;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function errorText(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (error.name === "TimeoutError") {
    return "The provider did not respond within 15 seconds.";
  }
  // Node wraps transport failures as a bare "fetch failed"; the useful detail
  // (ENOTFOUND, ECONNREFUSED, certificate errors) is on the cause.
  const cause = (error as { cause?: unknown }).cause;
  if (error.message === "fetch failed" && cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    if (code === "ENOTFOUND") {
      return "That host does not exist. Check the URL for a typo.";
    }
    if (code === "ECONNREFUSED") {
      return "The host refused the connection.";
    }
    return `${cause.message}${code ? ` (${code})` : ""}`;
  }
  return error.message;
}

export function probeEventId() {
  return `credval_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}
