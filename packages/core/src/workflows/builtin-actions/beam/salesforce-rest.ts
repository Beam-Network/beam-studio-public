import {
  ActionInputError,
  type ActionExecute,
  type ActionJson,
} from "../../actions.js";
import { salesforceSession } from "./salesforce/auth.js";
import { salesforceFetch, requireText, str } from "./salesforce/http.js";
import { beamActionManifest } from "./manifest.js";

const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"];

export const salesforceRestActionManifest = beamActionManifest({
  name: "@beam/salesforce-rest",
  displayName: "Salesforce REST",
  description:
    "Calls any Salesforce REST endpoint with the bound credential. An escape hatch for what the other actions do not cover.",
  configSchema: {
    type: "object",
    required: ["credentialId", "path"],
    additionalProperties: false,
    properties: {
      credentialId: { type: "string", title: "Salesforce credential" },
      method: { type: "string", title: "Method", enum: METHODS, default: "GET" },
      path: {
        type: "string",
        title: "Path",
        description:
          "Relative to the instance, for example /services/data/v62.0/limits. A bare path is resolved under the credential's API version.",
      },
    },
  },
  inputs: {
    credentialId: { type: "string" },
    body: { type: "object" },
  },
  outputs: {
    status: { type: "number" },
    response: { type: "object" },
    content: { type: "string" },
  },
  permissions: ["network:https", "secrets:read"],
  catalog: {
    category: "crm",
    maturity: "experimental",
    tags: ["salesforce", "crm", "rest", "escape-hatch"],
    credentialRequirements: [
      {
        key: "salesforce",
        displayName: "Salesforce credentials",
        required: true,
        cardinality: "one",
        purpose: "crm-read",
        acceptedCredentialTypes: ["salesforce_client_credentials", "salesforce_jwt"],
        configPaths: ["config.credentialId", "inputs.credentialId"],
        permissions: ["secrets:read"],
      },
    ],
  },
});

const salesforceRestExecute: ActionExecute = async (
  { config, inputs },
  context,
) => {
  const credentialId = requireText(
    inputs.credentialId ?? config.credentialId,
    "A Salesforce credential",
  );
  const path = requireText(config.path, "A request path");
  const method = (str(config.method) || "GET").toUpperCase();
  if (!METHODS.includes(method)) {
    throw new ActionInputError(
      `Method "${method}" must be one of ${METHODS.join(", ")}.`,
    );
  }

  const session = await salesforceSession(context, credentialId);

  // Only the credential's own instance is reachable: an absolute URL elsewhere
  // would turn this escape hatch into an arbitrary outbound request.
  if (/^https?:\/\//i.test(path)) {
    throw new ActionInputError(
      "Provide a path relative to the Salesforce instance, not a full URL.",
    );
  }

  const suffix = path.startsWith("/") ? path : `/${path}`;
  const url = suffix.startsWith("/services/")
    ? `${session.instanceUrl}${suffix}`
    : `${session.instanceUrl}/services/data/${session.apiVersion}${suffix}`;

  const body = inputs.body;
  const hasBody = method !== "GET" && method !== "DELETE" && body !== undefined;

  const response = await salesforceFetch({
    url,
    method,
    accessToken: session.accessToken,
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });

  context.logger.info("Salesforce REST call", { method, status: response.status });

  return {
    outputs: {
      status: response.status,
      response: parseJson(response.text),
      content: response.text,
    },
  };
};

export const salesforceRestAction = {
  manifest: salesforceRestActionManifest,
  execute: salesforceRestExecute,
};

/** Not every endpoint returns JSON; the raw text is always available too. */
function parseJson(text: string): ActionJson {
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as ActionJson;
  } catch {
    return {};
  }
}
