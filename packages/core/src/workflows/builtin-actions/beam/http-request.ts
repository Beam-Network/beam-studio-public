import {
  ActionInputError,
  type ActionExecute,
  type ActionJson,
} from "../../actions.js";
import {
  DEFAULT_HTTP_TIMEOUT_SECONDS,
  HTTP_METHODS,
  httpMethod,
  httpTimeoutMs,
  httpUrl,
  requestWithRetry,
  resolveHttpCredential,
  responseBody,
  responseHeaders,
} from "./http/request.js";
import { beamActionManifest } from "./manifest.js";

export const httpRequestActionManifest = beamActionManifest({
  name: "@beam/http-request",
  displayName: "HTTP Request",
  description:
    "Calls an HTTP endpoint and exposes its status, headers, and parsed response body.",
  configSchema: {
    type: "object",
    required: ["url"],
    additionalProperties: true,
    properties: {
      url: { type: "string", title: "URL" },
      method: {
        type: "string",
        title: "Method",
        enum: HTTP_METHODS,
        default: "GET",
      },
      credentialId: { type: "string", title: "HTTP credential" },
      timeoutSeconds: {
        type: "number",
        title: "Timeout (seconds)",
        default: DEFAULT_HTTP_TIMEOUT_SECONDS,
      },
      headers: { type: "object", title: "Headers" },
    },
  },
  inputs: {
    body: { title: "Request body" },
    headers: { type: "object", title: "Headers" },
    credentialId: { type: "string" },
  },
  outputs: {
    status: { type: "number" },
    headers: { type: "object" },
    body: {},
  },
  permissions: ["network:http", "secrets:read"],
  catalog: {
    category: "integration",
    maturity: "stable",
    tags: ["http", "api", "request", "integration"],
    credentialRequirements: [
      {
        key: "http",
        displayName: "HTTP credential",
        description: "Optional bearer token for the request.",
        required: false,
        cardinality: "one",
        purpose: "integration",
        acceptedCredentialTypes: ["http_bearer_token"],
        configPaths: ["config.credentialId", "inputs.credentialId"],
        permissions: ["secrets:read"],
      },
    ],
  },
});

export const httpRequestExecute: ActionExecute = async (
  { config, inputs },
  context,
) => {
  const url = httpUrl(config.url, "HTTP Request action");
  const method = httpMethod(config.method);
  const credentialId =
    stringValue(config.credentialId) || stringValue(inputs.credentialId);
  const credential = credentialId
    ? await resolveHttpCredential(context, credentialId)
    : null;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...headerRecord(config.headers),
    ...headerRecord(inputs.headers),
  };
  if (credential?.token) headers.Authorization = `Bearer ${credential.token}`;

  const body = requestBody(inputs.body, method, headers);
  const response = await requestWithRetry({
    url,
    init: { method, headers, ...(body === undefined ? {} : { body }) },
    timeoutMs: httpTimeoutMs(config.timeoutSeconds),
    signal: context.signal,
    subject: "HTTP endpoint",
  });

  return {
    outputs: {
      status: response.status,
      headers: responseHeaders(response.headers),
      body: (await responseBody(response)) as ActionJson,
    },
  };
};

function requestBody(
  body: ActionJson | undefined,
  method: string,
  headers: Record<string, string>,
) {
  if (body === undefined || method === "GET" || method === "HEAD")
    return undefined;
  if (typeof body === "string") return body;
  if (
    !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")
  ) {
    headers["Content-Type"] = "application/json";
  }
  return JSON.stringify(body);
}

function headerRecord(value: ActionJson | undefined) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ActionInputError("HTTP headers must be an object.");
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new ActionInputError(`HTTP header "${key}" must be a string.`);
    }
    result[key] = entry;
  }
  return result;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export const httpRequestAction = {
  manifest: httpRequestActionManifest,
  execute: httpRequestExecute,
};
