import { createSign } from "node:crypto";
import {
  ActionExecutionError,
  ActionInputError,
  type ActionContext,
} from "../../../actions.js";
import { str } from "./http.js";

/**
 * Resolves a Salesforce access token for a step.
 *
 * The credential payload arrives through context.secrets.get, which the worker
 * only serves for a credential the manifest declares at one of its configPaths.
 * The shape tells us which flow to use — there is no separate type field in the
 * decrypted payload.
 *
 * Request shapes here mirror apps/api/src/studio/credential-probe.ts, which is
 * already verified against live Salesforce endpoints. Keep them in step.
 */

export type SalesforceSession = {
  accessToken: string;
  instanceUrl: string;
  apiVersion: string;
};

const DEFAULT_API_VERSION = "v62.0";
const TOKEN_STATE_KEY = "salesforceSession";

export async function salesforceSession(
  context: ActionContext,
  credentialId: string,
): Promise<SalesforceSession> {
  // A token is good for the life of a step run, and a bulk job can make many
  // calls, so mint once and keep it in step state.
  const cached = cachedSession(context);
  if (cached) {
    return cached;
  }

  const raw = await context.secrets.get(credentialId);
  if (!raw) {
    throw new ActionInputError(
      `Credential "${credentialId}" was not found for this organization.`,
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ActionExecutionError("The Salesforce credential is unreadable.", {
      retryable: false,
    });
  }

  const session = str(payload.private_key)
    ? await jwtBearerSession(payload)
    : await clientCredentialsSession(payload);

  await context.state.patch({ [TOKEN_STATE_KEY]: { ...session } });
  return session;
}

function cachedSession(context: ActionContext): SalesforceSession | null {
  const state = context.state.get()[TOKEN_STATE_KEY];
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return null;
  }
  const record = state as Record<string, unknown>;
  const accessToken = str(record.accessToken);
  const instanceUrl = str(record.instanceUrl);
  if (!accessToken || !instanceUrl) {
    return null;
  }
  return {
    accessToken,
    instanceUrl,
    apiVersion: str(record.apiVersion) || DEFAULT_API_VERSION,
  };
}

async function clientCredentialsSession(payload: Record<string, unknown>) {
  const instanceUrl = requireUrl(payload.instance_url, "Instance URL");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: str(payload.client_id),
    client_secret: str(payload.client_secret),
  });
  return exchange(
    `${instanceUrl}/services/oauth2/token`,
    body,
    instanceUrl,
    payload,
  );
}

async function jwtBearerSession(payload: Record<string, unknown>) {
  const loginUrl =
    optionalUrl(payload.login_url) || "https://login.salesforce.com";
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt(
    {
      iss: str(payload.client_id),
      sub: str(payload.username),
      aud: loginUrl,
      exp: now + 180,
    },
    str(payload.private_key),
  );
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  return exchange(
    `${loginUrl}/services/oauth2/token`,
    body,
    optionalUrl(payload.instance_url),
    payload,
  );
}

async function exchange(
  tokenUrl: string,
  body: URLSearchParams,
  storedInstanceUrl: string,
  payload: Record<string, unknown>,
): Promise<SalesforceSession> {
  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new ActionExecutionError(
      `Could not reach Salesforce to authenticate: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { retryable: true },
    );
  }

  const json = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (!response.ok || !str(json.access_token)) {
    // A rejected credential will be rejected again; only a 5xx is worth a retry.
    throw new ActionExecutionError(
      `Salesforce refused the credential: ${
        str(json.error_description) || str(json.error) || `HTTP ${response.status}`
      }`,
      { retryable: response.status >= 500 },
    );
  }

  const returned = str(json.instance_url);
  // The org serves API calls from the host it names here, which can differ from
  // the stored one after a pod migration. Surface that plainly rather than
  // letting every subsequent call fail against the wrong host.
  if (storedInstanceUrl && returned && !sameHost(storedInstanceUrl, returned)) {
    throw new ActionExecutionError(
      `Salesforce issued a token for ${returned}, but the credential names ` +
        `${storedInstanceUrl}. Update the credential's instance URL.`,
      { retryable: false },
    );
  }

  return {
    accessToken: str(json.access_token),
    instanceUrl: returned || storedInstanceUrl,
    apiVersion: str(payload.api_version) || DEFAULT_API_VERSION,
  };
}

function signJwt(claims: Record<string, unknown>, privateKey: string) {
  if (!privateKey) {
    throw new ActionInputError("The credential has no private key.");
  }
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  return `${signingInput}.${signer.sign(privateKey).toString("base64url")}`;
}

function sameHost(left: string, right: string) {
  try {
    return new URL(left).host === new URL(right).host;
  } catch {
    return false;
  }
}

function requireUrl(value: unknown, label: string) {
  const url = optionalUrl(value);
  if (!url) {
    throw new ActionInputError(`The credential is missing its ${label}.`);
  }
  return url;
}

function optionalUrl(value: unknown) {
  const text = str(value).replace(/\/+$/, "");
  if (!text) {
    return "";
  }
  try {
    new URL(text);
  } catch {
    throw new ActionInputError(`"${text}" is not a valid URL.`);
  }
  return text;
}

/** `/services/data/vXX.X` prefix shared by every REST call. */
export function dataPath(session: SalesforceSession, suffix = "") {
  return `${session.instanceUrl}/services/data/${session.apiVersion}${suffix}`;
}
