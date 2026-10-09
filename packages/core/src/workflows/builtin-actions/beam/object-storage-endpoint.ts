import {
  ActionInputError,
  type ActionExecute,
  type ActionJson,
} from "../../actions.js";
import { beamActionManifest } from "./manifest.js";
import { objectStorageEndpointDescriptorSchema } from "@beam-studio/shared";

const originalManifest = beamActionManifest({
  name: "@beam/object-storage-endpoint",
  displayName: "Object storage endpoint",
  description:
    "Declares an S3-compatible object storage endpoint for workflow steps.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", title: "Name" },
      provider: { type: "string", title: "Provider" },
      bucket: { type: "string", title: "Bucket" },
      objectKey: { type: "string", title: "Object key" },
      objectSize: { type: "number", title: "Object size" },
      sourceType: {
        type: "string",
        title: "Endpoint type",
        enum: ["file", "directory"],
      },
      region: { type: "string", title: "Region" },
      endpointUrl: { type: "string", title: "Endpoint URL" },
      credentialId: { type: "string", title: "Credential ID" },
    },
    required: ["provider", "bucket", "objectKey", "credentialId"],
  },
  inputs: {
    bucket: { type: "string" },
    objectKey: { type: "string" },
  },
  outputs: {
    endpoint: { type: "object" },
    provider: { type: "string" },
    bucket: { type: "string" },
    objectKey: { type: "string" },
    uri: { type: "string" },
  },
  permissions: ["storage:read"],
  catalog: {
    category: "storage",
    maturity: "experimental",
    tags: ["endpoint", "s3", "storage"],
    credentialRequirements: [
      {
        key: "object-storage",
        displayName: "S3-compatible credentials",
        required: true,
        cardinality: "one",
        purpose: "storage-endpoint",
        acceptedCredentialTypes: ["s3_compatible_access_key", "gcs_service_account", "huggingface_token"],
        configPaths: ["inputs.credentialId", "config.credentialId"],
        permissions: ["storage:read"],
      },
    ],
  },
});

// Published builtin manifests are immutable: existing workflow locks retain v1.0.0.
export const objectStorageEndpointActionManifest = {
  ...originalManifest,
  version: "1.1.0",
  catalog: {
    ...originalManifest.catalog,
    changelog: [{ version: "1.1.0", notes: ["Add optional physical storage location."] }, ...originalManifest.catalog.changelog],
  },
  configSchema: {
    ...originalManifest.configSchema,
    properties: {
      ...(originalManifest.configSchema.properties as Record<string, unknown>),
      storageLocation: {
        type: "string",
        title: "Physical storage location",
        maxLength: 64,
        description: "Optional physical location, such as wnam or eu-west-1. Separate from the signing region; leave empty when unknown.",
      },
    },
  },
};

const objectStorageEndpointExecute: ActionExecute = ({ config, inputs }) => {
  const provider = text(config.provider) || "s3";
  const bucket = text(inputs.bucket) || text(config.bucket);
  const objectKey = text(inputs.objectKey) || text(config.objectKey);
  const credentialId = text(config.credentialId);
  if (!bucket) {
    throw new ActionInputError("Object storage endpoint requires a bucket.");
  }
  if (!objectKey) {
    throw new ActionInputError(
      "Object storage endpoint requires an object key.",
    );
  }
  if (!credentialId) {
    throw new ActionInputError(
      "Object storage endpoint requires a credential.",
    );
  }

  const endpoint = objectStorageEndpointDescriptorSchema.parse(compactJsonObject({
    name: text(config.name) || "Object storage endpoint",
    provider,
    bucket,
    objectKey,
    sourceType: text(config.sourceType) === "directory" ? "directory" : "file",
    region: text(config.region),
    storageLocation: text(config.storageLocation),
    endpointUrl: text(config.endpointUrl),
    credentialId,
  }));
  return {
    outputs: {
      endpoint,
      provider,
      bucket,
      objectKey,
      uri: `s3://${bucket}/${objectKey}`,
    },
  };
};

export const objectStorageEndpointAction = {
  manifest: objectStorageEndpointActionManifest,
  execute: objectStorageEndpointExecute,
};

export const originalObjectStorageEndpointAction = {
  manifest: originalManifest,
  execute: objectStorageEndpointExecute,
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function compactJsonObject(values: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== ""),
  ) as Record<string, ActionJson>;
}
