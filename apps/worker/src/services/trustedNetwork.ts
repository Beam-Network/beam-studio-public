import type { PgPool } from "@beam-studio/db";
import { referencedCredentialIds } from "@beam-studio/core";

type Row = Record<string, unknown>;

const credentialUrlFields = [
  "endpointUrl",
  "endpoint_url",
  "baseUrl",
  "base_url",
  "natsUrl",
  "nats_url",
  // A Salesforce org authenticates against its login host and then serves every
  // API call from a separate instance host, so both must reach the allowlist or
  // the token exchange succeeds and the first real request is denied.
  "instanceUrl",
  "instance_url",
  "loginUrl",
  "login_url",
] as const;
const defaultPorts: Record<string, string> = {
  "http:": "80",
  "https:": "443",
  "ws:": "80",
  "wss:": "443",
  "nats:": "4222",
  "tls:": "4222",
};

export async function trustedCredentialNetworkTargetsPg(
  pool: PgPool,
  organizationId: string,
  ...actionValues: unknown[]
) {
  const credentialIds = referencedCredentialIds(...actionValues);
  if (!credentialIds.length) {
    return [];
  }
  const result = await pool.query<Row>(
    `
    SELECT metadata_json
    FROM secrets.credentials
    WHERE organization_id = $1
      AND status = 'active'
      AND id = ANY($2::text[])
    `,
    [organizationId, credentialIds],
  );
  return credentialMetadataNetworkTargets(result.rows);
}

export function credentialMetadataNetworkTargets(rows: Row[]) {
  const targets = new Set<string>();
  for (const row of rows) {
    const metadata = objectValue(row.metadata_json);
    for (const field of credentialUrlFields) {
      const target = networkTargetFromUrl(metadata[field]);
      if (target) targets.add(target);
    }
  }
  return [...targets];
}

export function networkTargetFromUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const url = new URL(value.trim());
    const port = url.port || defaultPorts[url.protocol];
    if (!url.hostname || !port) {
      return null;
    }
    return `${url.hostname}:${port}`;
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Row {
  if (typeof value === "string") {
    try {
      return objectValue(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
}
