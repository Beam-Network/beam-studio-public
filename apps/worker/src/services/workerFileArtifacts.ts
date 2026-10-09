import type {
  ActionArtifact,
  ActionJson,
  ActionResult,
} from "@beam-studio/core";
import { createHash } from "node:crypto";
import { artifactPortLimits } from "@beam-studio/action-runtime";
import type {
  PublishedWorkerFile,
  WorkerFileServer,
} from "./workerFileServer.js";

export type WorkerArtifactContext = {
  config: Record<string, ActionJson>;
  inputs: Record<string, ActionJson>;
  fileServer?: Pick<WorkerFileServer, "publishLocalFile">;
};

export async function publishWorkerArtifact(
  artifact: ActionArtifact,
  context: WorkerArtifactContext,
) {
  return publishMemoryArtifact(artifact, context, {});
}

export async function localizeResultArtifacts(
  result: ActionResult,
  context: WorkerArtifactContext,
): Promise<ActionResult> {
  if (!context.fileServer || !result.artifacts?.length) {
    return result;
  }
  const uriRewrites = new Map<string, string>();
  const artifacts: ActionArtifact[] = [];
  for (const artifact of result.artifacts) {
    const localized = await publishMemoryArtifact(artifact, context, {
      outputs: result.outputs ?? {},
    });
    artifacts.push(localized);
    if (localized.uri !== artifact.uri) {
      uriRewrites.set(artifact.uri, localized.uri);
    }
  }
  if (!uriRewrites.size) {
    return { ...result, artifacts };
  }
  return {
    ...result,
    outputs: rewriteOutputUris(result.outputs ?? {}, uriRewrites),
    artifacts,
  };
}

async function publishMemoryArtifact(
  artifact: ActionArtifact,
  context: WorkerArtifactContext,
  extra: { outputs?: Record<string, ActionJson> },
) {
  if (artifact.uri.startsWith("data:")) {
    if (
      artifact.uri.length >
      128 + Math.ceil(artifactPortLimits.maxArtifactBytes / 3) * 4
    )
      throw new Error("Artifact publication exceeds the per-port byte limit.");
    const match = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=]*)$/.exec(
      artifact.uri,
    );
    if (!match)
      throw new Error("Artifact data cannot be published by this Runner.");
    const content = Buffer.from(match[2]!, "base64");
    if (
      content.byteLength > artifactPortLimits.maxArtifactBytes ||
      content.toString("base64") !== match[2] ||
      artifact.metadata?.bytes !== content.byteLength ||
      artifact.metadata?.sha256 !==
        `sha256:${createHash("sha256").update(content).digest("hex")}`
    )
      throw new Error(
        "Artifact publication failed integrity or size verification.",
      );
    if (!context.fileServer) return artifact;
    const published = await context.fileServer.publishLocalFile({
      source: content,
      mediaType: match[1],
      name: artifact.name,
    });
    return workerFileArtifact(artifact, published);
  }
  if (!context.fileServer || !artifact.uri.startsWith("memory://")) {
    return artifact;
  }
  const content = inferArtifactContent(artifact, context, extra.outputs ?? {});
  if (content === null) {
    return artifact;
  }
  const published = await context.fileServer.publishLocalFile({
    source: Buffer.from(content),
    mediaType: artifact.mediaType,
    name: artifact.name,
  });
  return workerFileArtifact(artifact, published);
}

function workerFileArtifact(
  artifact: ActionArtifact,
  published: PublishedWorkerFile,
): ActionArtifact {
  return {
    ...artifact,
    uri: published.uri,
    mediaType: artifact.mediaType ?? published.mediaType,
    metadata: {
      ...(artifact.metadata ?? {}),
      bytes: metadataNumber(artifact.metadata?.bytes) ?? published.size,
      source: artifact.uri.startsWith("data:")
        ? { sha256: artifact.metadata?.sha256 ?? null }
        : { uri: artifact.uri },
      fileExport: {
        workerId: published.workerId,
        exportId: published.exportId,
        size: published.size,
        etag: published.etag,
        expiresAt: published.expiresAt,
        supportsRange: published.supportsRange,
      },
    },
  };
}

function inferArtifactContent(
  artifact: ActionArtifact,
  context: WorkerArtifactContext,
  outputs: Record<string, ActionJson>,
) {
  const byOutput = contentFromOutputs(artifact, outputs);
  if (byOutput !== null) {
    return byOutput;
  }
  const content = context.inputs.content ?? context.config.content;
  if (typeof content === "string") {
    return content;
  }
  return null;
}

function contentFromOutputs(
  artifact: ActionArtifact,
  outputs: Record<string, ActionJson>,
) {
  if (typeof outputs.content === "string") {
    return outputs.content;
  }
  if (looksLikeJson(artifact) && typeof outputs.json === "string") {
    return outputs.json;
  }
  if (looksLikeCsv(artifact) && typeof outputs.csv === "string") {
    return outputs.csv;
  }
  if (typeof outputs.value === "string") {
    return outputs.value;
  }
  return null;
}

function looksLikeJson(artifact: ActionArtifact) {
  return (
    artifact.mediaType === "application/json" ||
    artifact.name.toLowerCase().endsWith(".json")
  );
}

function looksLikeCsv(artifact: ActionArtifact) {
  return (
    artifact.mediaType === "text/csv" ||
    artifact.name.toLowerCase().endsWith(".csv")
  );
}

function rewriteOutputUris(
  outputs: Record<string, ActionJson>,
  rewrites: Map<string, string>,
): Record<string, ActionJson> {
  return rewriteValue(outputs, rewrites) as Record<string, ActionJson>;
}

function rewriteValue(
  value: ActionJson,
  rewrites: Map<string, string>,
): ActionJson {
  if (typeof value === "string") {
    return rewrites.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteValue(entry, rewrites));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        rewriteValue(entry, rewrites),
      ]),
    ) as Record<string, ActionJson>;
  }
  return value;
}

function metadataNumber(value: ActionJson | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
