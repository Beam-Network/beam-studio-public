import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { ActionJson } from "@beam-studio/core";
import { pgOne, type PgPool } from "@beam-studio/db";
import {
  getProviderProfile,
  normalizeCredentialPayloadAliases,
  resolveProviderProfileEndpointUrl,
  resolveProviderProfileForcePathStyle,
  resolveProviderProfileRegion,
} from "@beam-studio/shared";
import { decryptString, vaultSecretFromEnv } from "@beam-studio/vault";
import type { WorkflowObjectStorageEndpoint } from "./taskTypes.js";
import { downloadWorkerFile } from "./workerFileResolver.js";

type Row = Record<string, unknown>;

type WorkflowObjectOptions = {
  workerFileSigningSecret?: string;
};

export async function downloadWorkflowObject(
  pool: PgPool,
  endpoint: WorkflowObjectStorageEndpoint,
  options: WorkflowObjectOptions = {},
) {
  const workerFileUri = endpoint.uri?.startsWith("beam-worker://")
    ? endpoint.uri
    : endpoint.provider === "beam-worker" && endpoint.objectKey
      ? endpoint.objectKey
      : null;
  if (workerFileUri) {
    if (!options.workerFileSigningSecret) {
      throw new Error("Worker file downloads require a signing secret.");
    }
    return downloadWorkerFile(pool, workerFileUri, {
      signingSecret: options.workerFileSigningSecret,
    });
  }
  if (endpoint.sourceType === "directory") {
    throw new Error("Download requires a file endpoint.");
  }
  const client = await objectStorageClient(pool, endpoint);
  const result = await client.send(
    new GetObjectCommand({
      Bucket: endpoint.bucket,
      Key: endpoint.objectKey,
    }),
  );
  const body = result.Body;
  if (!body || typeof body !== "object" || !("transformToByteArray" in body)) {
    throw new Error("Downloaded object body was empty.");
  }
  const bytes = Buffer.from(await body.transformToByteArray());
  return {
    content: bytes.toString("utf8"),
    bytes: bytes.byteLength,
    uri: `memory://downloads/${encodeURIComponent(objectName(endpoint.objectKey))}`,
    mediaType: result.ContentType ?? undefined,
    metadata: {
      etag: (result.ETag ?? null) as ActionJson,
      lastModified: (result.LastModified?.toISOString() ?? null) as ActionJson,
    },
  };
}

export async function uploadWorkflowObject(
  pool: PgPool,
  endpoint: WorkflowObjectStorageEndpoint,
  content: string,
  options: { mediaType?: string } = {},
) {
  if (endpoint.sourceType === "directory") {
    throw new Error("Upload requires a file endpoint.");
  }
  const client = await objectStorageClient(pool, endpoint);
  const body = Buffer.from(content);
  const result = await client.send(
    new PutObjectCommand({
      Bucket: endpoint.bucket,
      Key: endpoint.objectKey,
      Body: body,
      ContentType: options.mediaType,
    }),
  );
  return {
    bytes: body.byteLength,
    uri: `s3://${endpoint.bucket}/${endpoint.objectKey}`,
    mediaType: options.mediaType,
    metadata: {
      etag: (result.ETag ?? null) as ActionJson,
      versionId: (result.VersionId ?? null) as ActionJson,
    },
  };
}

export async function deleteWorkflowObject(
  pool: PgPool,
  endpoint: WorkflowObjectStorageEndpoint,
) {
  if (endpoint.sourceType === "directory" || endpoint.objectKey.endsWith("/")) {
    throw new Error("Delete requires a file endpoint.");
  }
  const client = await objectStorageClient(pool, endpoint);
  const result = await client.send(
    new DeleteObjectCommand({
      Bucket: endpoint.bucket,
      Key: endpoint.objectKey,
    }),
  );
  return {
    uri: `s3://${endpoint.bucket}/${endpoint.objectKey}`,
    metadata: {
      deleteMarker: (result.DeleteMarker ?? null) as ActionJson,
      versionId: (result.VersionId ?? null) as ActionJson,
    },
  };
}

async function objectStorageClient(
  pool: PgPool,
  endpoint: WorkflowObjectStorageEndpoint,
) {
  const credential = await getCredentialContext(pool, endpoint.credentialId);
  if (!credential) {
    throw new Error(
      `Credential is required for endpoint "${endpoint.name ?? endpoint.objectKey}".`,
    );
  }
  const provider = (
    credential.providerProfileId ?? endpoint.provider
  ).toLowerCase();
  const payload = credential.payload;
  const accessKeyId = text(payload.access_key_id ?? payload.api_key);
  const secretAccessKey = text(payload.secret_access_key ?? payload.api_secret);
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      `Credential is incomplete for endpoint "${endpoint.name ?? endpoint.objectKey}".`,
    );
  }

  const profileValues: Record<string, unknown> = { ...payload };
  if (endpoint.region) {
    profileValues.region = endpoint.region;
  }
  if (endpoint.endpointUrl) {
    profileValues.endpoint_url = endpoint.endpointUrl;
  }
  const endpointUrl = resolveProviderProfileEndpointUrl(
    provider,
    profileValues,
  );
  const profile = getProviderProfile(provider);
  if (profile && provider !== "s3" && provider !== "r2" && !endpointUrl) {
    throw new Error(
      `${profile.name} requires endpoint_url for endpoint "${endpoint.name ?? endpoint.objectKey}".`,
    );
  }

  return new S3Client({
    credentials: { accessKeyId, secretAccessKey },
    endpoint: endpointUrl,
    forcePathStyle:
      resolveProviderProfileForcePathStyle(provider, profileValues) ??
      Boolean(endpointUrl),
    region:
      resolveProviderProfileRegion(provider, profileValues) ||
      (provider === "r2" ? "auto" : "us-east-1"),
  });
}

export async function getCredentialContext(
  pool: PgPool,
  credentialId: string | undefined,
): Promise<{
  payload: Row;
  providerProfileId: string | null;
  credentialType: string;
} | null> {
  if (!credentialId) {
    return null;
  }
  const row = await pgOne<Row>(
    pool,
    `
    SELECT
      cv.encrypted_payload,
      pp.id AS provider_profile_id,
      ct.slug AS credential_type
    FROM secrets.credentials c
    JOIN secrets.credential_versions cv ON cv.credential_id = c.id
    JOIN secrets.credential_types ct ON ct.id = c.credential_type_id
    LEFT JOIN secrets.provider_profiles pp ON pp.id = c.provider_profile_id
    WHERE c.id = $1
      AND c.status = 'active'
      AND cv.status = 'active'
    ORDER BY cv.version DESC
    LIMIT 1
    `,
    [credentialId],
  );
  if (!row) {
    return null;
  }
  return {
    payload: normalizeCredentialPayloadAliases(
      JSON.parse(
        decryptString(String(row.encrypted_payload), vaultSecretFromEnv()),
      ) as Row,
    ),
    providerProfileId: row.provider_profile_id
      ? String(row.provider_profile_id)
      : null,
    credentialType: String(row.credential_type),
  };
}

function text(value: unknown) {
  const result = String(value ?? "").trim();
  return result || null;
}

function objectName(key: string) {
  return key.split("/").filter(Boolean).pop() ?? key;
}
