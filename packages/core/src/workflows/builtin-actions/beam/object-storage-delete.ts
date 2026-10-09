import {
  ActionExecutionError,
  ActionInputError,
  type ActionExecute,
  type ActionJson,
} from "../../actions.js";
import { beamActionManifest } from "./manifest.js";

type ObjectStorageEndpoint = {
  name?: string;
  provider: string;
  bucket: string;
  objectKey: string;
  sourceType?: "file" | "directory";
  region?: string;
  endpointUrl?: string;
  credentialId: string;
};

type ObjectStorageDeleteAdapter = {
  delete(input: ObjectStorageEndpoint): Promise<{
    uri?: string;
    metadata?: Record<string, ActionJson>;
  }>;
};

export const objectStorageDeleteActionManifest = beamActionManifest({
  name: "@beam/object-storage-delete",
  displayName: "Object storage delete",
  description: "Deletes exact object keys from S3-compatible object storage.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      endpoint: { type: "object", title: "Endpoint" },
      endpoints: {
        type: "array",
        title: "Endpoints",
        items: { type: "object" },
      },
      provider: { type: "string", title: "Provider" },
      bucket: { type: "string", title: "Bucket" },
      objectKey: { type: "string", title: "Object key" },
      region: { type: "string", title: "Region" },
      endpointUrl: { type: "string", title: "Endpoint URL" },
      credentialId: { type: "string", title: "Credential ID" },
    },
  },
  inputs: {
    endpoint: { type: "object" },
    endpoints: { type: "array", items: { type: "object" } },
    provider: { type: "string" },
    bucket: { type: "string" },
    objectKey: { type: "string" },
    credentialId: { type: "string" },
  },
  outputs: {
    deletedCount: { type: "number" },
    uris: { type: "array", items: { type: "string" } },
    objects: { type: "array", items: { type: "object" } },
  },
  permissions: ["storage:delete"],
  catalog: {
    category: "storage",
    maturity: "experimental",
    tags: ["delete", "s3", "storage", "cleanup"],
    credentialRequirements: [
      {
        key: "object-storage",
        displayName: "S3-compatible credentials",
        required: true,
        cardinality: "one",
        purpose: "storage-delete",
        acceptedCredentialTypes: ["s3_compatible_access_key", "gcs_service_account", "huggingface_token"],
        configPaths: [
          "inputs.endpoint.credentialId",
          "inputs.endpoints[].credentialId",
          "inputs.credentialId",
          "config.endpoint.credentialId",
          "config.endpoints[].credentialId",
          "config.credentialId",
        ],
        permissions: ["storage:delete"],
      },
    ],
  },
});

const objectStorageDeleteExecute: ActionExecute = async (
  { config, inputs },
  context,
) => {
  const endpoints = endpointsFromValues(inputs, config);
  const adapter = objectStorageAdapter(context.beam);
  if (!adapter) {
    throw new ActionExecutionError(
      "Object storage delete requires a local worker object storage adapter.",
      { retryable: false },
    );
  }

  const objects = [];
  for (const endpoint of endpoints) {
    const result = await adapter.delete(endpoint);
    const uri = result.uri ?? `s3://${endpoint.bucket}/${endpoint.objectKey}`;
    objects.push({
      uri,
      provider: endpoint.provider,
      bucket: endpoint.bucket,
      objectKey: endpoint.objectKey,
      ...(result.metadata ? { metadata: result.metadata } : {}),
    });
  }

  return {
    outputs: {
      deletedCount: objects.length,
      uris: objects.map((object) => object.uri),
      objects,
    },
  };
};

export const objectStorageDeleteAction = {
  manifest: objectStorageDeleteActionManifest,
  execute: objectStorageDeleteExecute,
};

function endpointsFromValues(
  inputs: Record<string, ActionJson>,
  config: Record<string, ActionJson>,
) {
  const rawEndpoints = arrayValue(inputs.endpoints ?? config.endpoints);
  if (rawEndpoints.length) {
    return rawEndpoints.map((endpoint, index) =>
      endpointFromObject(endpoint, `endpoints[${index}]`),
    );
  }
  return [endpointFromInputs(inputs, config)];
}

function endpointFromInputs(
  inputs: Record<string, ActionJson>,
  config: Record<string, ActionJson>,
) {
  const rawEndpoint = inputs.endpoint ?? config.endpoint;
  const endpoint =
    rawEndpoint &&
    typeof rawEndpoint === "object" &&
    !Array.isArray(rawEndpoint)
      ? (rawEndpoint as Record<string, ActionJson>)
      : {};
  return endpointFromObject(
    {
      ...config,
      ...inputs,
      ...endpoint,
    },
    "endpoint",
  );
}

function endpointFromObject(
  value: ActionJson,
  label: string,
): ObjectStorageEndpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ActionInputError(`Delete requires ${label} to be an object.`);
  }
  const endpoint = value as Record<string, ActionJson>;
  const provider = text(endpoint.provider) || "s3";
  const bucket = text(endpoint.bucket);
  const objectKey = text(endpoint.objectKey);
  const credentialId = text(endpoint.credentialId);
  if (!bucket) {
    throw new ActionInputError("Delete requires an endpoint bucket.");
  }
  if (!objectKey) {
    throw new ActionInputError("Delete requires an endpoint object key.");
  }
  if (objectKey.endsWith("/") || text(endpoint.sourceType) === "directory") {
    throw new ActionInputError("Delete requires exact file object keys.");
  }
  if (objectKey.includes("*")) {
    throw new ActionInputError("Delete does not accept wildcard object keys.");
  }
  if (!credentialId) {
    throw new ActionInputError("Delete requires an endpoint credential.");
  }
  return {
    name: text(endpoint.name) || undefined,
    provider,
    bucket,
    objectKey,
    sourceType: "file",
    region: text(endpoint.region) || undefined,
    endpointUrl: text(endpoint.endpointUrl) || undefined,
    credentialId,
  };
}

function objectStorageAdapter(beam: Record<string, unknown>) {
  const objectStorage = beam.objectStorage;
  if (
    objectStorage &&
    typeof objectStorage === "object" &&
    "delete" in objectStorage &&
    typeof (objectStorage as ObjectStorageDeleteAdapter).delete === "function"
  ) {
    return objectStorage as ObjectStorageDeleteAdapter;
  }
  return null;
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown) {
  return String(value ?? "").trim();
}
