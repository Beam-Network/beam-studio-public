import {
  ActionInputError,
  type ActionExecute,
  type ActionJson,
} from "../../actions.js";
import { dataPath, salesforceSession } from "./salesforce/auth.js";
import { salesforceFetch, requireText, str } from "./salesforce/http.js";
import { beamActionManifest } from "./manifest.js";

const OPERATIONS = ["create", "update", "upsert", "delete"];

export const salesforceRecordActionManifest = beamActionManifest({
  name: "@beam/salesforce-record",
  displayName: "Salesforce record",
  description:
    "Creates, updates, upserts, or deletes a single Salesforce record over the REST API.",
  configSchema: {
    type: "object",
    required: ["credentialId", "object", "operation"],
    additionalProperties: false,
    properties: {
      credentialId: { type: "string", title: "Salesforce credential" },
      object: { type: "string", title: "sObject" },
      operation: {
        type: "string",
        title: "Operation",
        enum: OPERATIONS,
        default: "update",
      },
      recordId: {
        type: "string",
        title: "Record ID",
        description: "Required for update and delete.",
      },
      externalIdField: {
        type: "string",
        title: "External ID field",
        description: "Required for upsert; recordId is then the external ID value.",
      },
    },
  },
  inputs: {
    credentialId: { type: "string" },
    recordId: { type: "string" },
    fields: { type: "object" },
  },
  outputs: {
    id: { type: "string" },
    success: { type: "boolean" },
    status: { type: "number" },
  },
  permissions: ["network:https", "secrets:read"],
  catalog: {
    category: "crm",
    maturity: "experimental",
    tags: ["salesforce", "crm", "record", "rest", "write"],
    credentialRequirements: [
      {
        key: "salesforce",
        displayName: "Salesforce credentials",
        required: true,
        cardinality: "one",
        purpose: "crm-write",
        acceptedCredentialTypes: ["salesforce_client_credentials", "salesforce_jwt"],
        configPaths: ["config.credentialId", "inputs.credentialId"],
        permissions: ["secrets:read"],
      },
    ],
  },
});

const salesforceRecordExecute: ActionExecute = async (
  { config, inputs },
  context,
) => {
  const credentialId = requireText(
    inputs.credentialId ?? config.credentialId,
    "A Salesforce credential",
  );
  const object = requireText(config.object, "An sObject name");
  const operation = str(config.operation) || "update";
  if (!OPERATIONS.includes(operation)) {
    throw new ActionInputError(
      `Operation "${operation}" must be one of ${OPERATIONS.join(", ")}.`,
    );
  }

  const recordId = str(inputs.recordId ?? config.recordId);
  const externalIdField = str(config.externalIdField);
  const fields = objectValue(inputs.fields);

  if (operation !== "create" && !recordId) {
    throw new ActionInputError(`A ${operation} requires a record ID.`);
  }
  if (operation === "upsert" && !externalIdField) {
    throw new ActionInputError(
      "An upsert requires an external ID field; the record ID is then its value.",
    );
  }

  const session = await salesforceSession(context, credentialId);
  const base = dataPath(session, `/sobjects/${encodeURIComponent(object)}`);
  const target =
    operation === "create"
      ? base
      : operation === "upsert"
        ? `${base}/${encodeURIComponent(externalIdField)}/${encodeURIComponent(recordId)}`
        : `${base}/${encodeURIComponent(recordId)}`;

  const method =
    operation === "create" ? "POST" : operation === "delete" ? "DELETE" : "PATCH";

  const response = await salesforceFetch({
    url: target,
    method,
    accessToken: session.accessToken,
    ...(operation === "delete" ? {} : { body: JSON.stringify(fields) }),
  });

  // Salesforce answers a successful PATCH or DELETE with 204 and no body, so
  // the id has to come from the request rather than the response.
  const parsed = response.text ? safeJson(response.text) : {};
  const id = str(parsed.id) || recordId;

  context.logger.info("Salesforce record written", { object, operation, id });

  return {
    outputs: { id, success: true, status: response.status },
    externalRef: id || null,
  };
};

export const salesforceRecordAction = {
  manifest: salesforceRecordActionManifest,
  execute: salesforceRecordExecute,
};

function objectValue(value: unknown): Record<string, ActionJson> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, ActionJson>)
    : {};
}

function safeJson(text: string): Record<string, ActionJson> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, ActionJson>)
      : {};
  } catch {
    return {};
  }
}
