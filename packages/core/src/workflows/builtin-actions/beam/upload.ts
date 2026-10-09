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

type ObjectStorageUploadAdapter = {
  upload(
    input: ObjectStorageEndpoint,
    content: string,
    options?: { mediaType?: string },
  ): Promise<{
    bytes?: number;
    uri?: string;
    mediaType?: string;
    metadata?: Record<string, ActionJson>;
  }>;
};

export const uploadActionManifest = beamActionManifest({
  name: "@beam/upload",
  displayName: "Upload",
  description: "Uploads workflow content to an object storage endpoint.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      mediaType: {
        type: "string",
        title: "Media type",
        description: "Media type used for the uploaded object and artifact.",
      },
    },
  },
  inputs: {
    endpoint: { type: "object" },
    content: { type: "string" },
    provider: { type: "string" },
    bucket: { type: "string" },
    objectKey: { type: "string" },
    credentialId: { type: "string" },
  },
  outputs: {
    uri: { type: "string" },
    bytes: { type: "number" },
  },
  permissions: ["storage:write"],
  catalog: {
    category: "storage",
    maturity: "experimental",
    tags: ["upload", "s3", "storage"],
    credentialRequirements: [
      {
        key: "object-storage",
        displayName: "S3-compatible credentials",
        required: true,
        cardinality: "one",
        purpose: "storage-write",
        acceptedCredentialTypes: ["s3_compatible_access_key", "gcs_service_account", "huggingface_token"],
        configPaths: ["inputs.endpoint.credentialId", "inputs.credentialId"],
        permissions: ["storage:write"],
      },
    ],
  },
});

const uploadExecute: ActionExecute = async ({ config, inputs }, context) => {
  const endpoint = endpointFromInputs(inputs);
  const adapter = objectStorageAdapter(context.beam);
  if (!adapter) {
    throw new ActionExecutionError(
      "Upload requires a local worker object storage adapter.",
      { retryable: false },
    );
  }

  const content = String(inputs.content ?? config.content ?? "");
  const configuredMediaType =
    text(config.mediaType) || "application/octet-stream";
  const result = await adapter.upload(endpoint, content, {
    mediaType: configuredMediaType,
  });
  const name = objectName(endpoint.objectKey);
  const bytes = result.bytes ?? Buffer.byteLength(content);
  const uri = result.uri ?? `s3://${endpoint.bucket}/${endpoint.objectKey}`;
  const mediaType = result.mediaType ?? configuredMediaType;
  const artifact = await context.artifacts.publish({
    name,
    type: "object",
    uri,
    mediaType,
    metadata: {
      bytes,
      provider: endpoint.provider,
      bucket: endpoint.bucket,
      objectKey: endpoint.objectKey,
      ...(result.metadata ?? {}),
    },
  });

  return {
    outputs: {
      uri: artifact.uri,
      bytes,
    },
    artifacts: [artifact],
  };
};

export const uploadAction = {
  manifest: uploadActionManifest,
  execute: uploadExecute,
};

function endpointFromInputs(
  inputs: Record<string, ActionJson>,
): ObjectStorageEndpoint {
  const rawEndpoint = inputs.endpoint;
  const endpoint =
    rawEndpoint &&
    typeof rawEndpoint === "object" &&
    !Array.isArray(rawEndpoint)
      ? (rawEndpoint as Record<string, ActionJson>)
      : {};
  const provider = text(endpoint.provider ?? inputs.provider) || "s3";
  const bucket = text(endpoint.bucket ?? inputs.bucket);
  const objectKey = text(endpoint.objectKey ?? inputs.objectKey);
  const credentialId = text(endpoint.credentialId ?? inputs.credentialId);
  if (!bucket) {
    throw new ActionInputError("Upload requires an endpoint bucket.");
  }
  if (!objectKey) {
    throw new ActionInputError("Upload requires an endpoint object key.");
  }
  if (!credentialId) {
    throw new ActionInputError("Upload requires an endpoint credential.");
  }
  return {
    name: text(endpoint.name) || undefined,
    provider,
    bucket,
    objectKey,
    sourceType:
      text(endpoint.sourceType) === "directory" ? "directory" : "file",
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
    "upload" in objectStorage &&
    typeof (objectStorage as ObjectStorageUploadAdapter).upload === "function"
  ) {
    return objectStorage as ObjectStorageUploadAdapter;
  }
  return null;
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function objectName(key: string) {
  return key.split("/").filter(Boolean).pop() ?? "upload";
}
