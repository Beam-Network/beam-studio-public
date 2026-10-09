import { isS3CompatibleProvider } from "@beam-studio/shared";

/** Hugging Face tokens browse repositories through the storage browser too. */
const HUGGING_FACE_KINDS = new Set(["huggingface-hub", "huggingface_token"]);

/**
 * Whether a credential can open object storage: an S3-compatible provider
 * profile, or a Hugging Face token. A Beam API key or a service credential
 * (Slack, Salesforce, Zapier) cannot back a storage endpoint.
 */
export function isStorageCredentialKind(kind?: string | null) {
  const normalized = (kind ?? "").trim().toLowerCase();
  return (
    Boolean(normalized) &&
    (isS3CompatibleProvider(normalized) || HUGGING_FACE_KINDS.has(normalized))
  );
}

/**
 * Whether a credential form shows STORAGE_NETWORK_HINT: every storage
 * credential, plus Google Cloud Storage service accounts, which back storage
 * endpoints without opening the storage browser.
 */
export function showsStorageNetworkHint(kind?: string | null) {
  return (
    isStorageCredentialKind(kind) || (kind ?? "").trim().toLowerCase() === "gcs"
  );
}
