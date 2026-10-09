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
  uri?: string;
  sourceType?: "file" | "directory";
  region?: string;
  endpointUrl?: string;
  credentialId: string;
};

type ObjectStorageDownloadAdapter = {
  download(input: ObjectStorageEndpoint): Promise<{
    content?: string;
    bytes?: number;
    uri?: string;
    mediaType?: string;
    metadata?: Record<string, ActionJson>;
  }>;
};

export const downloadActionManifest = beamActionManifest({
  name: "@beam/download",
  displayName: "Download",
  description: "Downloads an object from an object storage endpoint.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      mediaType: {
        type: "string",
        title: "Media type",
        description: "Media type used for the published artifact.",
      },
    },
  },
  inputs: {
    endpoint: { type: "object" },
    uri: { type: "string" },
    provider: { type: "string" },
    bucket: { type: "string" },
    objectKey: { type: "string" },
    credentialId: { type: "string" },
  },
  outputs: {
    content: { type: "string" },
    uri: { type: "string" },
    bytes: { type: "number" },
  },
  permissions: ["storage:read"],
  catalog: {
    category: "storage",
    maturity: "experimental",
    tags: ["download", "s3", "storage"],
    credentialRequirements: [
      {
        key: "object-storage",
        displayName: "S3-compatible credentials",
        required: true,
        cardinality: "one",
        purpose: "storage-read",
        acceptedCredentialTypes: ["s3_compatible_access_key", "gcs_service_account", "huggingface_token"],
        configPaths: ["inputs.endpoint.credentialId", "inputs.credentialId"],
        permissions: ["storage:read"],
      },
    ],
  },
});

const downloadExecute: ActionExecute = async ({ config, inputs }, context) => {
  const endpoint = endpointFromInputs(inputs);
  const adapter = objectStorageAdapter(context.beam);
  if (!adapter) {
    throw new ActionExecutionError(
      "Download requires a local worker object storage adapter.",
      { retryable: false },
    );
  }

  const result = await adapter.download(endpoint);
  const name = objectName(endpoint.objectKey || endpoint.uri || "download");
  const content = result.content ?? "";
  const bytes = result.bytes ?? Buffer.byteLength(content);
  const uri = result.uri ?? `memory://downloads/${encodeURIComponent(name)}`;
  const mediaType =
    (result.mediaType ?? text(config.mediaType)) || "application/octet-stream";
  const artifact = await context.artifacts.publish({
    name,
    type: "object",
    uri,
    mediaType,
    metadata: {
      bytes,
      provider: endpoint.provider,
      ...(endpoint.bucket ? { bucket: endpoint.bucket } : {}),
      ...(endpoint.objectKey ? { objectKey: endpoint.objectKey } : {}),
      ...(endpoint.uri ? { uri: endpoint.uri } : {}),
      ...(result.metadata ?? {}),
    },
  });

  return {
    outputs: {
      content,
      uri: artifact.uri,
      bytes,
    },
    artifacts: [artifact],
  };
};

export const downloadAction = {
  manifest: downloadActionManifest,
  execute: downloadExecute,
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
  const uri = text(endpoint.uri ?? inputs.uri);
  if (uri.startsWith("beam-worker://")) {
    return {
      name: text(endpoint.name) || undefined,
      provider: "beam-worker",
      bucket: "",
      objectKey: uri,
      uri,
      credentialId: "",
    };
  }
  const provider = text(endpoint.provider ?? inputs.provider) || "s3";
  const bucket = text(endpoint.bucket ?? inputs.bucket);
  const objectKey = text(endpoint.objectKey ?? inputs.objectKey);
  const credentialId = text(endpoint.credentialId ?? inputs.credentialId);
  if (!bucket) {
    throw new ActionInputError("Download requires an endpoint bucket.");
  }
  if (!objectKey) {
    throw new ActionInputError("Download requires an endpoint object key.");
  }
  if (!credentialId) {
    throw new ActionInputError("Download requires an endpoint credential.");
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
    "download" in objectStorage &&
    typeof (objectStorage as ObjectStorageDownloadAdapter).download ===
      "function"
  ) {
    return objectStorage as ObjectStorageDownloadAdapter;
  }
  return null;
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function objectName(key: string) {
  return key.split("/").filter(Boolean).pop() ?? "download";
}
