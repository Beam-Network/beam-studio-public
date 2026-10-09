import {
  ActionInputError,
  type ActionExecute,
  type ActionJson,
} from "../../actions.js";
import { beamActionManifest } from "./manifest.js";

/** Repo kinds the Hub exposes. Buckets are readable but hold no LFS endpoint to write to. */
const REPO_TYPES = ["model", "dataset", "space", "kernel", "bucket"] as const;

export const huggingFaceEndpointActionManifest = beamActionManifest({
  name: "@beam/huggingface-endpoint",
  displayName: "Hugging Face endpoint",
  description:
    "Declares a Hugging Face Hub file as a transfer endpoint. The Hub addresses content by repo and path rather than bucket and key, and authenticates with a single access token.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", title: "Name" },
      repoId: { type: "string", title: "Repo ID" },
      path: { type: "string", title: "Path in repo" },
      repoType: {
        type: "string",
        title: "Repo type",
        enum: [...REPO_TYPES],
        default: "dataset",
      },
      revision: { type: "string", title: "Revision" },
      objectSize: { type: "number", title: "Object size" },
      endpointUrl: { type: "string", title: "Hub endpoint" },
      credentialId: { type: "string", title: "Credential ID" },
      commitMessage: { type: "string", title: "Commit message" },
      createPr: { type: "boolean", title: "Open as a pull request" },
    },
    required: ["repoId", "path", "credentialId"],
  },
  inputs: {
    repoId: { type: "string" },
    path: { type: "string" },
  },
  outputs: {
    endpoint: { type: "object" },
    provider: { type: "string" },
    repoId: { type: "string" },
    path: { type: "string" },
    uri: { type: "string" },
  },
  permissions: ["storage:read"],
  catalog: {
    category: "storage",
    maturity: "experimental",
    tags: ["endpoint", "huggingface", "storage"],
    credentialRequirements: [
      {
        key: "huggingface",
        displayName: "Hugging Face token",
        required: true,
        cardinality: "one",
        purpose: "storage-endpoint",
        acceptedCredentialTypes: ["huggingface_token"],
        configPaths: ["inputs.credentialId", "config.credentialId"],
        permissions: ["storage:read"],
      },
    ],
  },
});

const huggingFaceEndpointExecute: ActionExecute = ({ config, inputs }) => {
  const repoId = text(inputs.repoId) || text(config.repoId);
  const path = text(inputs.path) || text(config.path);
  const credentialId = text(config.credentialId);
  const repoType = text(config.repoType) || "dataset";

  if (!repoId) {
    throw new ActionInputError("Hugging Face endpoint requires a repo ID.");
  }
  if (!repoId.includes("/")) {
    throw new ActionInputError(
      `Hugging Face repo ID "${repoId}" must be written as <namespace>/<name>.`,
    );
  }
  if (!path) {
    throw new ActionInputError("Hugging Face endpoint requires a path in the repo.");
  }
  if (!credentialId) {
    throw new ActionInputError("Hugging Face endpoint requires a credential.");
  }
  if (!(REPO_TYPES as readonly string[]).includes(repoType)) {
    throw new ActionInputError(
      `Hugging Face repo type "${repoType}" is not one of ${REPO_TYPES.join(", ")}.`,
    );
  }

  const revision = text(config.revision) || "main";
  const endpoint = compactJsonObject({
    name: text(config.name) || "Hugging Face endpoint",
    provider: "huggingface",
    repoId,
    path,
    repoType,
    revision,
    endpointUrl: text(config.endpointUrl),
    credentialId,
    commitMessage: text(config.commitMessage),
    ...(config.createPr === true ? { createPr: true } : {}),
  });

  return {
    outputs: {
      endpoint,
      provider: "huggingface",
      repoId,
      path,
      // The Hub's own URI grammar: hf://[<type>/]<org>/<repo>[@<revision>]/<path>.
      uri: `hf://${repoType === "model" ? "" : `${repoType}s/`}${repoId}@${revision}/${path}`,
    },
  };
};

export const huggingFaceEndpointAction = {
  manifest: huggingFaceEndpointActionManifest,
  execute: huggingFaceEndpointExecute,
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function compactJsonObject(values: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== ""),
  ) as Record<string, ActionJson>;
}
