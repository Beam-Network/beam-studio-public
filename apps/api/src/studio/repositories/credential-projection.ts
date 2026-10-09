import { createHash } from "node:crypto";
import { LOCAL_ORGANIZATION_ID } from "@beam-studio/db";
import { normalizeCredentialPayloadAliases } from "@beam-studio/shared";
import type { CredentialRecord } from "../store.js";
import {
  credentialText,
  parsePayload,
  timestampText,
  type Row,
} from "./record-helpers.js";
import { StudioValidationError } from "../validation-error.js";

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Row)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableJson(nested)]),
    );
  }
  return value;
}

/**
 * Safe projections of credential rows.
 *
 * These are pure: they map stored rows and metadata into the shapes the API
 * returns, and they are what keeps secret values out of those shapes. They live
 * apart from the repository so both it and the remaining store code can use one
 * definition rather than drifting copies.
 */
export function credentialRecordFromRow(row: Row): CredentialRecord {
  const metadata = parsePayload(row.metadata_json);
  const providerProfileId =
    credentialText(row.provider_profile_id) ||
    credentialText(row.provider_profile_slug) ||
    null;
  const credentialType = credentialText(row.credential_type_slug);
  const providerDisplayName = credentialText(row.provider_display_name) || null;
  return {
    id: String(row.id),
    organizationId: String(row.organization_id ?? LOCAL_ORGANIZATION_ID),
    projectId: row.project_id ? String(row.project_id) : null,
    name: String(row.name),
    kind: providerProfileId ?? credentialType,
    credentialType,
    credentialTypeId: String(row.credential_type_id),
    providerProfileId,
    providerDisplayName,
    status: String(row.status ?? "active"),
    metadata,
    payloadPreview: credentialPayloadPreview(metadata),
    managedBy:
      row.external_source === "beam_studio_instance" ? "studio-instance" : null,
    createdAt: timestampText(row.created_at),
    updatedAt: timestampText(row.updated_at),
  };
}

export function prepareCredentialPayload(input: {
  payload: Row;
  credentialTypeSlug: string;
  providerProfileId: string;
  providerDisplayName: string;
  providerDefaults: Row;
  requiredFields: string[];
}) {
  const rawPayload: Row = {
    ...input.providerDefaults,
    ...input.payload,
  };
  if (
    input.credentialTypeSlug === "s3_compatible_access_key" &&
    input.providerProfileId === "hippius"
  ) {
    if (!credentialValuePresent(rawPayload.access_key_id)) {
      rawPayload.access_key_id = rawPayload.api_key;
    }
    if (!credentialValuePresent(rawPayload.secret_access_key)) {
      rawPayload.secret_access_key = rawPayload.api_secret;
    }
  }
  const payload = normalizeCredentialPayload(rawPayload);
  const missingFields = input.requiredFields.filter(
    (field) => !credentialValuePresent(payload[field]),
  );
  if (missingFields.length) {
    throw new StudioValidationError(
      "credential_payload_incomplete",
      `Credential payload is missing required field(s): ${missingFields.join(", ")}.`,
      { field: "payload", missingFields },
    );
  }

  const prefix = credentialPrefix(payload);
  const metadata = credentialMetadata({
    payload,
    prefix,
    credentialTypeSlug: input.credentialTypeSlug,
    providerProfileId: input.providerProfileId,
    providerDisplayName: input.providerDisplayName,
  });

  return {
    payload,
    metadata,
    prefix,
    fingerprintHash: createHash("sha256")
      .update(JSON.stringify(stableJson(payload)))
      .digest("hex"),
  };
}

export function normalizeCredentialPayload(payload: Row) {
  const normalized = normalizeCredentialPayloadAliases(payload);
  if (typeof normalized.force_path_style === "string") {
    normalized.force_path_style = ["1", "true", "yes", "on"].includes(
      normalized.force_path_style.toLowerCase(),
    );
  }
  return normalized;
}

export function credentialMetadata(input: {
  payload: Row;
  prefix: string | null;
  credentialTypeSlug: string;
  providerProfileId: string;
  providerDisplayName: string;
}) {
  const payload = input.payload;
  const metadata: Row = {
    credentialType: input.credentialTypeSlug,
    providerProfile: input.providerProfileId,
    providerDisplayName: input.providerDisplayName,
  };
  const accessKeyId = credentialText(payload.access_key_id);
  const apiKey = credentialText(payload.api_key);
  const token = credentialText(payload.token);
  const endpointUrl = credentialText(payload.endpoint_url);
  const baseUrl = credentialText(payload.base_url);
  const natsUrl = credentialText(payload.nats_url);
  // Projected so the worker can derive a sandbox network allowlist from
  // credential metadata without ever decrypting the payload. See
  // credentialUrlFields in apps/worker/src/services/trustedNetwork.ts.
  const instanceUrl = credentialText(payload.instance_url);
  const loginUrl = credentialText(payload.login_url);
  const apiVersion = credentialText(payload.api_version);
  // Non-secret tenant selectors. Safe to project and useful for telling two
  // credentials for the same provider apart in the list.
  const orgId = credentialText(payload.org_id);
  const sandboxName = credentialText(payload.sandbox_name);
  const account = credentialText(payload.account);
  const role = credentialText(payload.role);
  const warehouse = credentialText(payload.warehouse);
  const environment = credentialText(payload.environment);
  const region = credentialText(payload.region);
  const projectId = credentialText(payload.project_id);
  const clientEmail = credentialText(payload.client_email);
  const webhookUrl = credentialText(payload.webhook_url);
  const buckets = Array.isArray(payload.buckets)
    ? payload.buckets.map((bucket) => credentialText(bucket)).filter(Boolean)
    : [];

  if (input.prefix) {
    metadata.prefix = input.prefix;
  }
  if (accessKeyId) {
    metadata.accessKeyIdPrefix = safePrefix(accessKeyId);
  }
  if (apiKey) {
    metadata.apiKeyPrefix = secretHint(apiKey);
  }
  if (token) {
    metadata.tokenPrefix = secretHint(token);
  }
  if (endpointUrl) {
    metadata.endpointUrl = endpointUrl;
  }
  if (baseUrl) {
    // Origin only. Metadata is not secret — it is returned in credential
    // listings and rendered in the payload preview — but a base URL can be:
    // Zapier's MCP endpoint carries a per-server secret in its path. The
    // origin is all either consumer needs, since the network allowlist reduces
    // it to hostname:port and the preview only wants something recognisable.
    metadata.baseUrl = urlOrigin(baseUrl);
  }
  if (natsUrl) {
    metadata.natsUrl = natsUrl;
  }
  if (instanceUrl) {
    metadata.instanceUrl = instanceUrl;
  }
  if (loginUrl) {
    metadata.loginUrl = loginUrl;
  }
  if (apiVersion) {
    metadata.apiVersion = apiVersion;
  }
  if (orgId) {
    metadata.orgId = orgId;
  }
  if (sandboxName) {
    metadata.sandboxName = sandboxName;
  }
  if (account) {
    metadata.account = account;
  }
  if (role) {
    metadata.role = role;
  }
  if (warehouse) {
    metadata.warehouse = warehouse;
  }
  if (environment) {
    metadata.environment = environment;
  }
  if (region) {
    metadata.region = region;
  }
  if (typeof payload.force_path_style === "boolean") {
    metadata.forcePathStyle = payload.force_path_style;
  }
  if (projectId) {
    metadata.projectId = projectId;
  }
  if (clientEmail) {
    metadata.clientEmail = clientEmail;
  }
  if (webhookUrl) {
    metadata.webhookHost = safeUrlHost(webhookUrl);
  }
  if (buckets.length) {
    metadata.buckets = buckets;
    metadata.bucket = buckets[0] ?? "";
  }
  return metadata;
}

function credentialPayloadPreview(metadata: Row) {
  const parts = [
    credentialText(metadata.providerDisplayName),
    credentialText(metadata.region),
    credentialText(metadata.endpointUrl),
    credentialText(metadata.baseUrl),
    credentialText(metadata.instanceUrl),
    credentialText(metadata.sandboxName),
    credentialText(metadata.account),
    credentialText(metadata.warehouse),
    credentialText(metadata.natsUrl),
    credentialText(metadata.environment),
    credentialText(metadata.accessKeyIdPrefix),
    credentialText(metadata.apiKeyPrefix),
    credentialText(metadata.clientEmail),
  ].filter(Boolean);
  return parts.length ? parts.slice(0, 3).join(" / ") : "Encrypted payload";
}

export function credentialPrefix(payload: Row) {
  return (
    safePrefix(credentialText(payload.access_key_id)) ||
    secretHint(credentialText(payload.api_key)) ||
    secretHint(credentialText(payload.token)) ||
    safeUrlHost(credentialText(payload.webhook_url)) ||
    null
  );
}

export function credentialValuePresent(value: unknown) {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return true;
}

/**
 * Scheme, host and port, dropping any path, query or fragment that could carry
 * a secret. A value that is not a URL has no path to drop and is returned as
 * given.
 */
function urlOrigin(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

/**
 * Disambiguation hint for a PUBLIC identifier such as an S3 access key id.
 *
 * Never call this with a secret: metadata_json is not encrypted, and a short
 * value is echoed verbatim on purpose because an identifier is not sensitive.
 * Use secretHint for anything that authenticates.
 */
function safePrefix(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= 12) {
    return trimmed;
  }
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`;
}

/**
 * Disambiguation hint for a SECRET, stored in unencrypted metadata_json.
 *
 * Reveals at most the last four characters and never the leading bytes, so the
 * hint distinguishes two credentials without materially narrowing the secret.
 * A value too short to mask safely gets no hint at all.
 */
function secretHint(value: string) {
  const trimmed = value.trim();
  if (trimmed.length < 8) {
    return "";
  }
  return `...${trimmed.slice(-4)}`;
}

function safeUrlHost(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}
