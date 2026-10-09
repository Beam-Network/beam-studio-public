import { apiGet } from "@/lib/api-client";
import { stringValue } from "./workflow-config-schema";
import type { JsonObject, ObjectListPayload } from "./workflow-graph-types";

export async function fetchStorageObjects({
  bucket,
  credentialId,
  prefix,
}: {
  bucket: string;
  credentialId: string;
  prefix: string;
}) {
  const params = new URLSearchParams({ bucket, credentialId, prefix });
  return apiGet<ObjectListPayload>(
    `/studio/storage/browser?${params.toString()}`,
  );
}

export function credentialBucketsFromPayload(payload: JsonObject) {
  const buckets = Array.isArray(payload.buckets)
    ? payload.buckets
    : typeof payload.buckets === "string"
      ? payload.buckets.split(/\r?\n|,/)
      : [];
  const legacyBucket = stringValue(payload.bucket ?? payload.default_bucket);

  return [...buckets, legacyBucket]
    .map((bucket) => stringValue(bucket).trim())
    .filter(Boolean)
    .filter((bucket, index, all) => all.indexOf(bucket) === index);
}

export function objectName(key: string) {
  const normalized = key.replace(/\/$/, "");
  return normalized.split("/").filter(Boolean).at(-1) ?? key;
}

export function folderName(prefix: string) {
  return objectName(prefix) || "/";
}

export function parentPrefix(prefix: string) {
  const parts = prefix.replace(/\/$/, "").split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `${parts.join("/")}/` : "";
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}
