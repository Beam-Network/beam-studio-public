import crypto, { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import * as tar from "tar";
import {
  ActionRuntimeCompatibilityError,
  ActionTrustError,
  createBuiltinActionRegistry,
  type ActionManifest,
  type RegisteredActionPackage,
} from "@beam-studio/core";
import {
  actionDeclaresPermission,
  assertExecutorCanLoadAction,
  sandboxRpcMethodsForAction,
} from "./actionPermissions.js";
import { redactSignedUrls, sandboxedActionExecute } from "./actionSandbox.js";
import type { ActionRuntimeOptions } from "./types.js";
import { probeActionResourceBudgets } from "./resource-budgets.js";

export type ActionStepSnapshot = {
  actionPackage: string;
  versionRange: string;
  resolvedVersion?: string | null;
  manifestSnapshot?: ActionManifest | null;
  artifactChecksum?: string | null;
  mediaType?: string | null;
  sourceRegistry?: string | null;
  registryArtifactUrl?: string | null;
  hippiusBucket?: string | null;
  hippiusKey?: string | null;
  hippiusEndpoint?: string | null;
  signature?: string | null;
  publisherSignature?: string | null;
  publisherPublicKey?: string | null;
  publisherSignatureAlgorithm?: string | null;
};

const artifactDownloadAttempts = 3;

/**
 * An HTTP artifact download the source refused. `code` is the source's
 * machine-readable error code when it sent one (for example the Registry's
 * `artifact_url_expired`), so a caller holding the authority can re-issue
 * the URL instead of failing the step.
 */
export class ActionArtifactDownloadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "ActionArtifactDownloadError";
  }
}
const registryOnlyActionPackages = new Set([
  "@beam/transfer",
  "@beam/room-transfer",
]);

export async function resolveActionPackage(
  step: ActionStepSnapshot,
  options: ActionRuntimeOptions,
  /**
   * Bounds resolution, which runs before the step timeout is armed. The task
   * owns this signal, so a stalled download cannot outlive its task.
   */
  signal: AbortSignal,
): Promise<RegisteredActionPackage> {
  if ((step.registryArtifactUrl || step.hippiusKey) && step.artifactChecksum) {
    return loadRemoteActionPackage(step, options, signal);
  }
  if (
    options.requireArtifact ||
    registryOnlyActionPackages.has(step.actionPackage)
  ) {
    throw new Error(
      `Action "${step.actionPackage}" must resolve to a Registry artifact with a sha256 checksum.`,
    );
  }
  const resolvedPackage = createBuiltinActionRegistry().resolvePackage(
    step.actionPackage,
    step.resolvedVersion ?? step.versionRange,
  );
  if (resolvedPackage.manifest.apiVersion === "workflow-actions/v2") {
    throw new ActionTrustError(
      "Registry v2 requires a pinned action artifact and an isolated sandbox.",
    );
  }
  assertExecutorCanLoadAction(resolvedPackage.manifest, {
    actionPackage: step.actionPackage,
    resolvedVersion: step.resolvedVersion,
    allowedActionPermissions: options.allowedActionPermissions,
    placement: options.placement,
  });
  return resolvedPackage;
}

async function loadRemoteActionPackage(
  step: ActionStepSnapshot,
  options: ActionRuntimeOptions,
  signal: AbortSignal,
): Promise<RegisteredActionPackage> {
  const artifactChecksum = normalizeSha256(step.artifactChecksum ?? "");
  if (!artifactChecksum) {
    throw new Error(
      `Remote action "${step.actionPackage}" is missing a sha256 artifact checksum.`,
    );
  }
  if (
    registryOnlyActionPackages.has(step.actionPackage) &&
    !step.manifestSnapshot
  ) {
    throw new Error(
      `Registry action "${step.actionPackage}" is missing its manifest snapshot.`,
    );
  }
  const manifest =
    step.manifestSnapshot ??
    createBuiltinActionRegistry().resolvePackage(
      step.actionPackage,
      step.resolvedVersion ?? step.versionRange,
    ).manifest;
  if (
    manifest.apiVersion === "workflow-actions/v2" &&
    !options.processOwnership
  ) {
    throw new ActionRuntimeCompatibilityError(
      "Registry v2 action budgets require durable process ownership.",
    );
  }
  assertExecutorCanLoadAction(manifest, {
    actionPackage: step.actionPackage,
    resolvedVersion: step.resolvedVersion,
    allowedActionPermissions: options.allowedActionPermissions,
    placement: options.placement,
    v2BudgetsAvailable:
      manifest.apiVersion === "workflow-actions/v2"
        ? await probeActionResourceBudgets()
        : false,
  });
  assertSupportedRemoteRuntime(manifest);
  const isolation = manifest.execution?.isolation ?? "sandboxed-esm";
  if (isolation === "trusted-node") {
    assertTrustedNodeActionAllowed(step, manifest, options);
  }
  const artifactPath = await ensureCachedArtifact(
    step,
    artifactChecksum,
    step.mediaType ?? "application/javascript",
    options,
    signal,
  );
  const cachePath = await actionEntrypointPath(
    artifactPath,
    artifactChecksum,
    manifest,
  );
  return {
    source: "remote",
    manifest,
    checksum: artifactChecksum,
    execute: sandboxedActionExecute({
      entrypointPath: cachePath,
      actionCacheDir: options.actionCacheDir,
      processOwnership: options.processOwnership,
      timeoutMs: options.actionSandboxTimeoutMs,
      abortGraceMs: 30_000,
      memoryLimitMb: options.actionSandboxMemoryMb,
      resourceBudget:
        manifest.apiVersion === "workflow-actions/v2"
          ? manifest.contracts!.resources
          : undefined,
      isolation,
      allowedNetwork:
        isolation === "trusted-node" &&
        (manifest.permissions ?? []).some((permission) =>
          permission.startsWith("network:"),
        )
          ? options.trustedNodeAllowedNetwork
          : undefined,
      diskWrite:
        options.allowScratchWrites &&
        actionDeclaresPermission(manifest, "filesystem:write")
          ? {
              scratchDir:
                options.actionScratchDir ?? "/tmp/beam-action-scratch",
              maxBytes:
                options.actionScratchMaxBytes ?? 10 * 1024 * 1024 * 1024,
            }
          : undefined,
      logger: options.logger,
      allowedRpcMethods: sandboxRpcMethodsForAction(manifest),
    }),
  };
}

function assertSupportedRemoteRuntime(manifest: ActionManifest) {
  const runtime = manifest.execution?.runtime;
  if (runtime !== undefined && runtime !== "node") {
    throw new ActionTrustError(
      `Remote action "${manifest.name}" requests unsupported native runtime "${String(runtime)}". Native action execution remains disabled until a strongly isolated runtime is available.`,
    );
  }
}

function assertTrustedNodeActionAllowed(
  step: ActionStepSnapshot,
  manifest: ActionManifest,
  options: ActionRuntimeOptions,
) {
  if (!manifest.name.startsWith("@beam/")) {
    throw new ActionTrustError(
      `Trusted Node runtime is reserved for first-party @beam/* action packages.`,
    );
  }
  if (manifest.trustLevel !== "builtin" && manifest.trustLevel !== "verified") {
    throw new ActionTrustError(
      `Trusted Node action "${manifest.name}" must use builtin or verified trust.`,
    );
  }
  if (step.sourceRegistry !== "public-registry") {
    throw new ActionTrustError(
      `Trusted Node action "${manifest.name}" must originate from the public Registry.`,
    );
  }
  if (!options.trustedNodeActionPackages?.includes(manifest.name)) {
    throw new ActionTrustError(
      `Trusted Node action "${manifest.name}" is not allowlisted by this worker.`,
    );
  }
  if (
    (manifest.permissions ?? []).some((permission) =>
      permission.startsWith("network:"),
    ) &&
    !options.trustedNodeAllowedNetwork?.length
  ) {
    throw new ActionTrustError(
      `Trusted Node action "${manifest.name}" requires an explicit worker network allowlist.`,
    );
  }
}

/** Verify frozen artifact bytes without loading or executing the action. */
export async function readVerifiedActionArtifact(
  step: ActionStepSnapshot,
  options: ActionRuntimeOptions,
  signal: AbortSignal,
) {
  const expected = String(step.artifactChecksum ?? "").replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/i.test(expected))
    throw new ActionTrustError(
      "A frozen SHA-256 artifact checksum is required.",
    );
  const file = await ensureCachedArtifact(
    step,
    expected,
    step.mediaType ?? "application/javascript",
    options,
    signal,
  );
  const bytes = await readFile(file);
  verifySha256(bytes, expected, actionSourceLabel(step));
  verifyPublisherSignature(bytes, step);
  return bytes;
}

async function ensureCachedArtifact(
  step: ActionStepSnapshot,
  expectedSha256: string,
  mediaType: string,
  options: ActionRuntimeOptions,
  signal: AbortSignal,
) {
  const extension = mediaType.includes("json") ? ".json" : ".mjs";
  const resolvedExtension = isArchiveMediaType(mediaType) ? ".tgz" : extension;
  const cacheDir = options.actionCacheDir ?? "/tmp/beam-action-cache";
  const cachePath = path.join(
    cacheDir,
    `${expectedSha256}${resolvedExtension}`,
  );
  await mkdir(cacheDir, { recursive: true });
  await removeStaleCacheEntries(cacheDir, options);

  try {
    const existing = await readFile(cachePath);
    verifySha256(existing, expectedSha256, actionSourceLabel(step));
    verifyPublisherSignature(existing, step);
    return cachePath;
  } catch {
    // Cache miss or invalid cached bytes; fetch and replace below.
  }

  const bytes = await downloadArtifactWithRetry(step, options, signal);
  verifySha256(bytes, expectedSha256, actionSourceLabel(step));
  verifyPublisherSignature(bytes, step);
  // Publish by rename so an interrupted write can never be mistaken for a
  // complete artifact, and so concurrent loads of the same checksum converge
  // on one entry instead of writing over each other.
  const pendingPath = `${cachePath}.${randomUUID()}.partial`;
  try {
    await writeFile(pendingPath, bytes);
    await rename(pendingPath, cachePath);
  } catch (error) {
    await rm(pendingPath, { force: true });
    // Windows refuses replacement while another loader has the completed file
    // open. Reuse that winner only after verifying its exact bytes and signature.
    try {
      const winner = await readFile(cachePath);
      verifySha256(winner, expectedSha256, actionSourceLabel(step));
      verifyPublisherSignature(winner, step);
    } catch {
      throw error;
    }
  }
  options.logger.info(
    {
      actionArtifactUrl: redactSignedUrls(step.registryArtifactUrl),
      hippiusBucket: step.hippiusBucket,
      hippiusKey: step.hippiusKey,
      artifactChecksum: `sha256:${expectedSha256}`,
      cachePath,
    },
    "Cached remote action artifact",
  );
  return cachePath;
}

async function downloadArtifactWithRetry(
  step: ActionStepSnapshot,
  options: ActionRuntimeOptions,
  signal: AbortSignal,
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= artifactDownloadAttempts; attempt += 1) {
    signal.throwIfAborted();
    try {
      return step.registryArtifactUrl
        ? await downloadHttpArtifact(step.registryArtifactUrl, options, signal)
        : await downloadHippiusArtifact(step, options, signal);
    } catch (error) {
      lastError = error;
      if (error instanceof ActionTrustError) throw error;
      // An expired signed URL stays expired; retrying it only delays renewal.
      if (
        error instanceof ActionArtifactDownloadError &&
        error.code === "artifact_url_expired"
      )
        throw error;
      // Cancellation is the answer, not something to retry around.
      signal.throwIfAborted();
      if (attempt >= artifactDownloadAttempts) {
        break;
      }
      const retryDelayMs = attempt * 250;
      options.logger.warn(
        {
          attempt,
          retryDelayMs,
          actionPackage: step.actionPackage,
          actionArtifactUrl: redactSignedUrls(step.registryArtifactUrl),
          hippiusBucket: step.hippiusBucket,
          hippiusKey: step.hippiusKey,
          error: redactSignedUrls(
            error instanceof Error ? error.message : String(error),
          ),
        },
        "Remote action artifact download failed; retrying",
      );
      await delay(retryDelayMs, undefined, { signal });
    }
  }
  throw lastError;
}

async function actionEntrypointPath(
  artifactPath: string,
  expectedSha256: string,
  manifest: ActionManifest,
) {
  if (!artifactPath.endsWith(".tgz")) {
    return artifactPath;
  }
  const extractDir = path.join(path.dirname(artifactPath), expectedSha256);
  const extractedManifestPath = path.join(extractDir, "beam-action.json");
  await publishExtractedArchive(
    artifactPath,
    extractDir,
    extractedManifestPath,
    manifest,
  );
  const archiveManifest = JSON.parse(
    await readFile(extractedManifestPath, "utf8"),
  ) as ActionManifest & { entrypoint?: string };
  if (
    archiveManifest.name !== manifest.name ||
    archiveManifest.version !== manifest.version
  ) {
    throw new ActionTrustError(
      `Remote action archive manifest does not match locked package ${manifest.name}@${manifest.version}.`,
    );
  }
  const entrypoint =
    archiveManifest.entrypoint ??
    (manifest as ActionManifest & { entrypoint?: string }).entrypoint ??
    "dist/index.mjs";
  if (
    !entrypoint ||
    path.isAbsolute(entrypoint) ||
    path.normalize(entrypoint).startsWith(`..${path.sep}`) ||
    path.normalize(entrypoint) === ".."
  ) {
    throw new ActionTrustError(
      `Remote action entrypoint is outside the extracted artifact: ${entrypoint}.`,
    );
  }
  const entrypointPath = path.join(extractDir, entrypoint);
  if (!existsSync(entrypointPath)) {
    // A directory published before extraction was atomic can hold the manifest
    // without the rest of the tree, and every later run would accept it and
    // fail here. Discard it and rebuild once.
    await rm(extractDir, { force: true, recursive: true });
    await publishExtractedArchive(
      artifactPath,
      extractDir,
      extractedManifestPath,
      manifest,
    );
    if (!existsSync(entrypointPath)) {
      throw new Error(`Remote action entrypoint is missing: ${entrypoint}`);
    }
  }
  const [resolvedExtractDir, resolvedEntrypointPath] = await Promise.all([
    realpath(extractDir),
    realpath(entrypointPath),
  ]);
  const relativeEntrypoint = path.relative(
    resolvedExtractDir,
    resolvedEntrypointPath,
  );
  if (
    relativeEntrypoint.startsWith("..") ||
    path.isAbsolute(relativeEntrypoint) ||
    relativeEntrypoint === ""
  ) {
    throw new ActionTrustError(
      `Remote action entrypoint resolves outside the extracted artifact: ${entrypoint}.`,
    );
  }
  return resolvedEntrypointPath;
}

async function downloadHttpArtifact(
  url: string,
  options: ActionRuntimeOptions,
  signal: AbortSignal,
) {
  const response = await fetch(url, {
    cache: "no-store",
    signal,
    ...(options.actionArtifactAuthorization
      ? {
          redirect: "error" as const,
          headers: { Authorization: options.actionArtifactAuthorization },
        }
      : {}),
  });
  if (!response.ok) {
    throw new ActionArtifactDownloadError(
      `Failed to download action artifact from ${redactSignedUrls(url)}: ${response.status} ${response.statusText}`,
      response.status,
      await downloadErrorCode(response),
    );
  }
  const maxBytes = artifactMaxBytes(options);
  // A declared length that already exceeds the limit is refused before reading
  // a single byte. A missing or dishonest one is caught by the running total.
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new ActionTrustError(
      `Action artifact from ${redactSignedUrls(url)} declares ${declared} bytes, over the ${maxBytes} byte limit.`,
    );
  }
  if (!response.body) {
    throw new Error(
      `Action artifact from ${redactSignedUrls(url)} returned no body.`,
    );
  }
  return collectBoundedStream(
    response.body as unknown as AsyncIterable<Uint8Array>,
    maxBytes,
    redactSignedUrls(url) ?? "the action registry",
    signal,
  );
}

/** The `code` of a small JSON error body, read without trusting its size. */
async function downloadErrorCode(response: Response) {
  try {
    const text = await collectBoundedStream(
      (response.body ?? []) as unknown as AsyncIterable<Uint8Array>,
      4096,
      "an artifact error response",
      AbortSignal.timeout(5_000),
    );
    const code = (
      JSON.parse(text.toString("utf8")) as {
        code?: unknown;
      }
    ).code;
    return typeof code === "string" ? code : null;
  } catch {
    await response.body?.cancel().catch(() => {});
    return null;
  }
}

function artifactMaxBytes(options: ActionRuntimeOptions) {
  return options.actionArtifactMaxBytes ?? 256 * 1024 * 1024;
}

/**
 * Accumulates a stream while enforcing a byte ceiling, so a hostile or
 * misconfigured source cannot exhaust worker memory before the checksum is
 * ever computed.
 */
async function collectBoundedStream(
  stream: AsyncIterable<Uint8Array>,
  maxBytes: number,
  label: string,
  signal: AbortSignal,
) {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    signal.throwIfAborted();
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new ActionTrustError(
        `Action artifact from ${label} exceeds the ${maxBytes} byte limit.`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Extracts the archive into a private directory and publishes it with a single
 * rename, so a cache entry only becomes visible once its whole tree is present.
 *
 * tar writes entries in archive order, so the presence of beam-action.json says
 * nothing about the rest: an interruption after that entry landed used to leave
 * a directory that every later run accepted and then failed on.
 */
async function publishExtractedArchive(
  artifactPath: string,
  extractDir: string,
  extractedManifestPath: string,
  manifest: ActionManifest,
) {
  if (existsSync(extractedManifestPath)) return;
  const pendingDir = `${extractDir}.${randomUUID()}.partial`;
  await mkdir(pendingDir, { recursive: true });
  try {
    await tar.x({
      file: artifactPath,
      cwd: pendingDir,
      strict: true,
      filter: (archivePath, entry) => {
        const normalized = path.posix.normalize(archivePath);
        return (
          normalized !== ".." &&
          !normalized.startsWith("../") &&
          !path.posix.isAbsolute(normalized) &&
          (!("type" in entry) ||
            (entry.type !== "SymbolicLink" && entry.type !== "Link"))
        );
      },
    });
    if (!existsSync(path.join(pendingDir, "beam-action.json"))) {
      throw new ActionTrustError(
        `Remote action archive for ${manifest.name}@${manifest.version} has no beam-action.json.`,
      );
    }
    await rename(pendingDir, extractDir);
  } catch (error) {
    await rm(pendingDir, { force: true, recursive: true });
    // Another loader publishing the same checksum first is the expected outcome
    // of a race, not a failure: its tree is identical by definition.
    if (!existsSync(extractedManifestPath)) throw error;
  }
}

/**
 * Removes artifacts and extraction directories left half-written by an
 * interrupted run. They are never visible to a reader, because publication is a
 * rename, but they would otherwise accumulate on disk.
 */
async function removeStaleCacheEntries(
  cacheDir: string,
  options: ActionRuntimeOptions,
) {
  try {
    const entries = await readdir(cacheDir);
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".partial"))
        .map(async (entry) => {
          const candidate = path.join(cacheDir, entry);
          const info = await stat(candidate).catch(() => null);
          // A different process may still be publishing a recent partial file.
          if (info && Date.now() - info.mtimeMs > 24 * 60 * 60 * 1000)
            await rm(candidate, { force: true, recursive: true });
        }),
    );
  } catch (error) {
    options.logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Could not sweep stale action cache entries",
    );
  }
}

function verifyPublisherSignature(bytes: Uint8Array, step: ActionStepSnapshot) {
  const signature = (step.publisherSignature ?? step.signature)?.trim();
  const publicKey = step.publisherPublicKey?.trim();
  if (!signature && !publicKey) {
    return;
  }
  if (!signature || !publicKey) {
    throw new ActionTrustError(
      `Remote action "${step.actionPackage}" must supply both publisher signature and public key.`,
    );
  }
  const algorithm = (
    step.publisherSignatureAlgorithm ?? "ed25519"
  ).toLowerCase();
  if (algorithm !== "ed25519") {
    throw new ActionTrustError(
      `Remote action "${step.actionPackage}" uses unsupported publisher signature algorithm "${algorithm}".`,
    );
  }
  let signatureBytes: Buffer;
  let verificationKey: crypto.KeyLike;
  try {
    signatureBytes = decodeSignature(signature);
    verificationKey = publicKey.includes("BEGIN PUBLIC KEY")
      ? publicKey
      : crypto.createPublicKey({
          key: Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"),
            decodeBase64(publicKey),
          ]),
          format: "der",
          type: "spki",
        });
  } catch {
    throw new ActionTrustError(
      `Remote action "${step.actionPackage}" has malformed publisher signature metadata.`,
    );
  }
  if (!crypto.verify(null, bytes, verificationKey, signatureBytes)) {
    throw new ActionTrustError(
      `Remote action "${step.actionPackage}" publisher signature verification failed.`,
    );
  }
}

function decodeSignature(value: string) {
  const encoded = value.replace(/^ed25519:/i, "");
  return /^[a-f0-9]{128}$/i.test(encoded)
    ? Buffer.from(encoded, "hex")
    : decodeBase64(encoded);
}

function decodeBase64(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Buffer.from(normalized, "base64");
  if (!bytes.length) {
    throw new Error("empty base64 value");
  }
  return bytes;
}

async function downloadHippiusArtifact(
  step: ActionStepSnapshot,
  options: ActionRuntimeOptions,
  signal: AbortSignal,
) {
  if (!step.hippiusBucket || !step.hippiusKey) {
    throw new Error(
      `Remote action "${step.actionPackage}" is missing Hippius bucket or key.`,
    );
  }
  const storage = options.actionArtifactStorage;
  const client = new S3Client({
    endpoint:
      step.hippiusEndpoint ?? storage?.endpoint ?? "https://s3.hippius.com",
    region: storage?.region ?? "decentralized",
    forcePathStyle: storage?.forcePathStyle ?? true,
    ...(storage?.accessKeyId && storage.secretAccessKey
      ? {
          credentials: {
            accessKeyId: storage.accessKeyId,
            secretAccessKey: storage.secretAccessKey,
          },
        }
      : {}),
  });
  const response = await client.send(
    new GetObjectCommand({
      Bucket: step.hippiusBucket,
      Key: step.hippiusKey,
    }),
    { abortSignal: signal },
  );
  if (!response.Body) {
    throw new Error(
      `Hippius object ${step.hippiusBucket}/${step.hippiusKey} is empty.`,
    );
  }
  const maxBytes = artifactMaxBytes(options);
  if (
    typeof response.ContentLength === "number" &&
    response.ContentLength > maxBytes
  ) {
    throw new Error(
      `Action artifact ${step.hippiusBucket}/${step.hippiusKey} declares ${response.ContentLength} bytes, over the ${maxBytes} byte limit.`,
    );
  }
  return collectBoundedStream(
    response.Body as AsyncIterable<Uint8Array>,
    maxBytes,
    `${step.hippiusBucket}/${step.hippiusKey}`,
    signal,
  );
}

function verifySha256(bytes: Uint8Array, expectedSha256: string, url: string) {
  const actual = crypto.createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha256) {
    throw new Error(
      `Action artifact checksum mismatch for ${url}: expected sha256:${expectedSha256}, got sha256:${actual}.`,
    );
  }
}

function actionSourceLabel(step: ActionStepSnapshot) {
  if (step.hippiusBucket && step.hippiusKey) {
    return `hippius://${step.hippiusBucket}/${step.hippiusKey}`;
  }
  return redactSignedUrls(step.registryArtifactUrl) ?? step.actionPackage;
}

function isArchiveMediaType(mediaType: string) {
  return (
    mediaType.includes("gzip") ||
    mediaType.includes("tar") ||
    mediaType.includes("tgz")
  );
}

function normalizeSha256(value: string) {
  const trimmed = value.trim();
  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  const prefixed = /^sha256[:-]([a-f0-9]{64})$/i.exec(trimmed);
  return prefixed?.[1]?.toLowerCase() ?? null;
}
