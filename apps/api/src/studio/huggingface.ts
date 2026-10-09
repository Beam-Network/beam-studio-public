/**
 * Hugging Face Hub access for the storage browser and the source size probe.
 *
 * The Hub is not S3: content is addressed by `repo_id` + `path` and authenticated with a
 * single bearer token. Studio's browse and metadata surfaces pass a bucket-shaped pair, so a
 * Hub location is spelled the way the Hub's own `hf://` URIs spell it — the repo type is a
 * prefix on the "bucket":
 *
 *   datasets/org/corpus  +  data/train.parquet
 *   buckets/org/store    +  archive.bin
 *   org/model            +  model.safetensors   (no prefix means a model repo)
 */

import { StudioValidationError } from "./validation-error.js";

const HUGGINGFACE_DEFAULT_ENDPOINT = "https://huggingface.co";

/** Mirrors `constants.HF_URI_TYPE_PREFIXES`; a model repo carries no prefix. */
const REPO_TYPE_PREFIXES: Record<string, string> = {
  models: "model",
  datasets: "dataset",
  spaces: "space",
  kernels: "kernel",
  buckets: "bucket",
};

const REPO_TYPE_URL_PREFIXES: Record<string, string> = {
  model: "",
  dataset: "datasets/",
  space: "spaces/",
  kernel: "kernels/",
  bucket: "buckets/",
};

export type HuggingFaceLocation = {
  repoType: string;
  repoId: string;
  endpoint: string;
};

export type HuggingFaceEntry = {
  path: string;
  type: "file" | "directory";
  size: number | null;
};

/**
 * Matches only the token-based Hub provider.
 *
 * The `huggingface` id belongs to the S3 gateway profile, which is an ordinary
 * s3-compatible credential and must keep using the S3 code paths.
 */
export function isHuggingFaceCredential(kind: string): boolean {
  const normalized = kind.trim().toLowerCase();
  return normalized === "huggingface-hub" || normalized === "huggingface_token";
}

export function huggingFaceToken(payload: Record<string, unknown>): string {
  const token = String(payload.token ?? "").trim();
  if (!token) {
    throw new StudioValidationError(
      "credential_token_missing",
      "The selected Hugging Face credential has no access token.",
    );
  }
  return token;
}

/** Split a `[<type>/]<org>/<name>` bucket string into a repo type and id. */
export function parseHuggingFaceLocation(
  bucket: string,
  payload: Record<string, unknown> = {},
): HuggingFaceLocation {
  const endpoint = String(payload.endpoint ?? "").trim() || HUGGINGFACE_DEFAULT_ENDPOINT;
  const segments = bucket.trim().replace(/^\/+|\/+$/g, "").split("/");

  let repoType = "model";
  if (segments.length > 2 && REPO_TYPE_PREFIXES[segments[0]!]) {
    repoType = REPO_TYPE_PREFIXES[segments.shift()!]!;
  }
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new StudioValidationError(
      "huggingface_repo_invalid",
      `"${bucket}" is not a Hugging Face repo. Use "<org>/<name>", optionally prefixed with ` +
        `datasets/, spaces/, kernels/, or buckets/.`,
    );
  }

  return { repoType, repoId: segments.join("/"), endpoint: endpoint.replace(/\/+$/, "") };
}

/**
 * Resolve URL for a file. Buckets are unversioned and escape their whole key as one
 * component; git repos take a revision segment and keep path separators.
 */
export function huggingFaceResolveUrl(
  location: HuggingFaceLocation,
  path: string,
  revision = "main",
): string {
  const prefix = REPO_TYPE_URL_PREFIXES[location.repoType] ?? "";
  if (location.repoType === "bucket") {
    return `${location.endpoint}/${prefix}${location.repoId}/resolve/${encodeURIComponent(path)}`;
  }
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${location.endpoint}/${prefix}${location.repoId}/resolve/${encodeURIComponent(revision)}/${encodedPath}`;
}

/**
 * Size of one file, read from the Hub's HEAD response.
 *
 * `X-Linked-Size` is authoritative: on a redirect the `Content-Length` describes the redirect
 * body, not the object.
 */
export async function readHuggingFaceObjectSize(input: {
  location: HuggingFaceLocation;
  path: string;
  revision?: string;
  token: string;
}): Promise<number> {
  const url = huggingFaceResolveUrl(input.location, input.path, input.revision);
  const response = await fetch(url, {
    method: "HEAD",
    redirect: "manual",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Accept-Encoding": "identity",
    },
  });
  if (response.status >= 400) {
    throw new Error(
      `Hugging Face could not read ${input.location.repoId}/${input.path} (status ${response.status}).`,
    );
  }

  const raw = response.headers.get("x-linked-size") ?? response.headers.get("content-length");
  const size = Number(raw);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(
      `Hugging Face did not report a size for ${input.location.repoId}/${input.path}.`,
    );
  }
  return size;
}

/** List one level of a repo or bucket, shaped like the storage browser's object listing. */
export async function listHuggingFaceEntries(input: {
  location: HuggingFaceLocation;
  prefix?: string | null;
  revision?: string;
  token: string;
}): Promise<HuggingFaceEntry[]> {
  const { location } = input;
  const prefix = (input.prefix ?? "").replace(/^\/+/, "");

  // Buckets have their own listing endpoint and no revision; git repos use the tree API.
  const url =
    location.repoType === "bucket"
      ? `${location.endpoint}/api/buckets/${location.repoId}/tree` +
        (prefix ? `?prefix=${encodeURIComponent(prefix)}` : "")
      : `${location.endpoint}/api/${location.repoType}s/${location.repoId}/tree/` +
        `${encodeURIComponent(input.revision ?? "main")}${prefix ? `/${prefix}` : ""}`;

  const response = await fetch(url, { headers: { Authorization: `Bearer ${input.token}` } });
  if (response.status >= 400) {
    throw new Error(
      `Hugging Face could not list ${location.repoId} (status ${response.status}).`,
    );
  }

  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload.map((item) => {
    const entry = item as Record<string, unknown>;
    const size = typeof entry.size === "number" ? entry.size : null;
    return {
      path: String(entry.path ?? ""),
      type: entry.type === "directory" ? "directory" : "file",
      size,
    };
  });
}
