export type CredentialPayload = Record<string, unknown>;

const credentialPayloadAliasPairs: Array<[camel: string, snake: string]> = [
  ["accessKeyId", "access_key_id"],
  ["secretAccessKey", "secret_access_key"],
  ["sessionToken", "session_token"],
  ["endpointUrl", "endpoint_url"],
  ["forcePathStyle", "force_path_style"],
  ["apiKey", "api_key"],
  ["apiSecret", "api_secret"],
  ["baseUrl", "base_url"],
  ["natsUrl", "nats_url"],
  ["projectId", "project_id"],
  ["clientEmail", "client_email"],
  ["privateKey", "private_key"],
  ["webhookUrl", "webhook_url"],
  ["hfToken", "token"],
];

export function normalizeCredentialPayloadAliases(
  payload: CredentialPayload,
): CredentialPayload {
  const normalized: CredentialPayload = { ...payload };
  for (const [camel, snake] of credentialPayloadAliasPairs) {
    const snakeValue = normalized[snake];
    const camelValue = normalized[camel];
    const canonicalValue = credentialValuePresent(snakeValue)
      ? snakeValue
      : camelValue;

    if (credentialValuePresent(canonicalValue)) {
      normalized[snake] = canonicalValue;
    }
    delete normalized[camel];
  }
  return normalized;
}

/**
 * Fields whose values are secrets. They are never returned to a browser, and a
 * blank incoming value means "keep the stored one" rather than "erase it".
 */
const secretCredentialFieldNames = new Set([
  "api_key",
  "api_secret",
  "client_secret",
  "private_key",
  "private_key_passphrase",
  "secret_access_key",
  "session_token",
  "token",
]);

/**
 * Unknown fields fail closed: anything that reads like a secret is treated as
 * one, so a provider added later cannot leak by default.
 */
const secretCredentialFieldPattern =
  /secret|password|passphrase|token|private_key|credential/i;

export function isSecretCredentialField(field: string) {
  return (
    secretCredentialFieldNames.has(field) ||
    secretCredentialFieldPattern.test(field)
  );
}

export function mergeCredentialPayload(
  existing: CredentialPayload,
  incoming: CredentialPayload,
): CredentialPayload {
  const base = normalizeCredentialPayloadAliases(existing);
  const update = normalizeCredentialPayloadAliases(incoming);
  const merged: CredentialPayload = { ...base };
  for (const [field, value] of Object.entries(update)) {
    // A blank secret means the editor never loaded it, which is now always the
    // case: submitting the form must not erase a stored secret. Non-secret
    // fields stay clearable.
    if (isSecretCredentialField(field) && !credentialValuePresent(value)) {
      continue;
    }
    merged[field] = value;
  }
  return merged;
}

/**
 * The projection safe to hand a browser: configuration without secret values,
 * plus which secrets are on file so the editor can say so.
 */
export function safeCredentialPayload(payload: CredentialPayload) {
  const normalized = normalizeCredentialPayloadAliases(payload);
  const safe: CredentialPayload = {};
  const secretFields: string[] = [];
  for (const [field, value] of Object.entries(normalized)) {
    if (isSecretCredentialField(field)) {
      if (credentialValuePresent(value)) secretFields.push(field);
      continue;
    }
    safe[field] = value;
  }
  return { payload: safe, secretFields: secretFields.sort() };
}

function credentialValuePresent(value: unknown) {
  return typeof value === "string"
    ? value.trim().length > 0
    : value !== undefined && value !== null;
}
