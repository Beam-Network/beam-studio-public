import {
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  getProviderProfile,
  normalizeCredentialPayloadAliases,
  resolveProviderProfileEndpointUrl,
  resolveProviderProfileForcePathStyle,
  resolveProviderProfileRegion,
} from "@beam-studio/shared";
import {
  isHuggingFaceCredential,
  listHuggingFaceEntries,
  parseHuggingFaceLocation,
  huggingFaceToken,
} from "./huggingface.js";
import { vaultSecretFromEnv } from "@beam-studio/vault";
import type { PgPool } from "@beam-studio/db";
import { CredentialRepository } from "./repositories/credential-repository.js";
import { organizationScope } from "./repositories/organization-scope.js";
import { StudioValidationError } from "./validation-error.js";

type StorageClientInput = {
  // Required, and threaded rather than defaulted: browsing storage decrypts a
  // stored secret, so a caller that cannot name its organization has no
  // business resolving a credential by ID.
  pool: PgPool;
  organizationId: string;
  credentialId: string;
};

const credentialsFor = (input: StorageClientInput) =>
  new CredentialRepository(input.pool, vaultSecretFromEnv);

type StorageObjectInput = StorageClientInput & {
  bucket: string;
  prefix?: string | null;
};

type ProviderStorageInput = {
  provider: string;
  payload: Record<string, unknown>;
};

type StorageListError = Error & {
  code: "storage_list_access_denied";
  statusCode: 403;
  action: string;
  details: { bucket: string };
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

export function credentialBuckets(payload: Record<string, unknown>) {
  const buckets = Array.isArray(payload.buckets)
    ? payload.buckets
    : typeof payload.buckets === "string"
      ? payload.buckets.split(/\r?\n|,/)
      : [];
  const legacyBucket = text(payload.bucket ?? payload.default_bucket);

  return [...buckets, legacyBucket]
    .map((bucket) => text(bucket))
    .filter(Boolean)
    .filter((bucket, index, all) => all.indexOf(bucket) === index);
}

export async function listCredentialObjects(input: StorageObjectInput) {
  const huggingFace = await huggingFaceCredential(input);
  if (huggingFace) {
    return listHuggingFaceObjects({ ...input, ...huggingFace });
  }

  const { client } = await storageClient(input);
  const prefix = input.prefix?.trim() ?? "";
  let result;
  try {
    result = await client.send(
      new ListObjectsV2Command({
        Bucket: input.bucket,
        Delimiter: "/",
        Prefix: prefix,
        MaxKeys: 1000,
      }),
    );
  } catch (error) {
    throw storageListError(error, input.bucket);
  }

  return {
    prefixes: (result.CommonPrefixes ?? [])
      .map((item) => item.Prefix)
      .filter((value): value is string => Boolean(value)),
    objects: (result.Contents ?? [])
      .filter((item) => item.Key && item.Key !== prefix)
      .map((item) => ({
        key: item.Key ?? "",
        size: item.Size ?? null,
        updatedAt: item.LastModified?.toISOString() ?? null,
      })),
    prefix,
    truncated: Boolean(result.IsTruncated),
  };
}

export async function storageObjectExists(input: StorageObjectInput) {
  const { client } = await storageClient(input);
  try {
    await client.send(
      new HeadObjectCommand({ Bucket: input.bucket, Key: input.prefix ?? "" }),
    );
    return true;
  } catch (error) {
    const status = Number(
      (error as { $metadata?: { httpStatusCode?: unknown } })?.$metadata
        ?.httpStatusCode,
    );
    const name = String(
      (error as { name?: unknown })?.name ?? "",
    ).toLowerCase();
    if (status === 404 || name === "notfound" || name === "nosuchkey") {
      return false;
    }
    throw error;
  }
}

/** Resolve a credential to its Hub payload, or null when it is not a Hugging Face credential. */
async function huggingFaceCredential(input: StorageClientInput) {
  const credential = (
    await credentialsFor(input).list(organizationScope(input.organizationId))
  ).find((item) => item.id === input.credentialId);

  if (!credential || !isHuggingFaceCredential(credential.kind)) {
    return null;
  }

  const payload = await credentialsFor(input).payload(
    organizationScope(input.organizationId),
    input.credentialId,
  );
  if (!payload) {
    throw new Error("The selected credential could not be decrypted.");
  }
  return { payload };
}

/** The Hub's tree listing, shaped like the S3 listing the browser expects. */
async function listHuggingFaceObjects(
  input: StorageObjectInput & { payload: Record<string, unknown> },
) {
  const prefix = input.prefix?.trim() ?? "";
  const location = parseHuggingFaceLocation(input.bucket, input.payload);

  let entries;
  try {
    entries = await listHuggingFaceEntries({
      location,
      prefix,
      token: huggingFaceToken(input.payload),
    });
  } catch (error) {
    throw storageListError(error, input.bucket);
  }

  return {
    prefixes: entries
      .filter((entry) => entry.type === "directory")
      .map((entry) => `${entry.path}/`),
    objects: entries
      .filter((entry) => entry.type === "file")
      .map((entry) => ({ key: entry.path, size: entry.size, updatedAt: null })),
    prefix,
    // The Hub's tree endpoint pages on its own cursor; one level is always complete here.
    truncated: false,
  };
}

export async function validateProviderBuckets(
  input: ProviderStorageInput & {
    buckets: string[];
  },
) {
  const buckets = input.buckets
    .map((bucket) => bucket.trim())
    .filter(Boolean)
    .filter((bucket, index, all) => all.indexOf(bucket) === index);
  if (!buckets.length) {
    return;
  }

  const { client } = storageClientFromProviderPayload(input);
  for (const bucket of buckets) {
    try {
      await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          MaxKeys: 1,
        }),
      );
    } catch (error) {
      if (!isStorageListAccessDenied(error)) {
        throw error;
      }
    }
  }
}

export function isStorageListAccessDenied(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    Code?: unknown;
    message?: unknown;
  };
  return [
    candidate.name,
    candidate.code,
    candidate.Code,
    candidate.message,
  ].some((value) =>
    ["accessdenied", "forbidden"].includes(
      String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z]/g, ""),
    ),
  );
}

export function storageListError(error: unknown, bucket: string): unknown {
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    Code?: unknown;
  } | null;
  const codes = [candidate?.name, candidate?.code, candidate?.Code].map(
    (value) =>
      String(value ?? "")
        .toLowerCase()
        .replace(/[^a-z]/g, ""),
  );
  const knownError = [
    {
      names: ["invalidbucketname"],
      code: "storage_bucket_name_invalid",
      statusCode: 400,
      message:
        "The bucket name is invalid. Enter the actual bucket name, not its display name, URL, or object path.",
      action:
        "Choose a saved bucket or copy its exact name from your storage provider.",
    },
    {
      names: ["nosuchbucket"],
      code: "storage_bucket_not_found",
      statusCode: 404,
      message:
        "The bucket was not found for this credential. Check the bucket name and credential endpoint.",
      action:
        "Choose a saved bucket or check its name and endpoint in Credentials.",
    },
    {
      names: [
        "invalidaccesskeyid",
        "signaturedoesnotmatch",
        "expiredtoken",
        "invalidtoken",
      ],
      code: "storage_credential_rejected",
      statusCode: 403,
      message:
        "The storage provider rejected this credential. Check its access keys, endpoint, and region.",
      action:
        "Update the selected credential on the Credentials page, then verify the bucket again.",
    },
  ].find((definition) => definition.names.some((name) => codes.includes(name)));
  if (knownError) {
    // Provider messages can contain request routes or signing details; expose only
    // curated messages and the user-supplied bucket identity.
    return Object.assign(new Error(knownError.message), {
      name: "StorageBrowserError",
      code: knownError.code,
      statusCode: knownError.statusCode,
      action: knownError.action,
      details: { bucket },
      retryable: false,
    });
  }
  if (!isStorageListAccessDenied(error)) {
    return error;
  }

  const denied = new Error(
    `This credential cannot list objects in bucket "${bucket}". It can still be saved and used for transfers that do not require object listing.`,
  ) as StorageListError;
  denied.name = "StorageListAccessDeniedError";
  denied.code = "storage_list_access_denied";
  denied.statusCode = 403;
  denied.action =
    "Grant the credential permission to list this bucket to use the object browser.";
  denied.details = { bucket };
  return denied;
}

async function storageClient(input: StorageClientInput) {
  const credential = (
    await credentialsFor(input).list(organizationScope(input.organizationId))
  ).find((item) => item.id === input.credentialId);

  if (!credential) {
    throw new Error("The selected credential could not be found.");
  }

  const provider = credential.kind.toLowerCase();
  const payload = await credentialsFor(input).payload(
    organizationScope(input.organizationId),
    input.credentialId,
  );
  if (!payload) {
    throw new Error("The selected credential could not be decrypted.");
  }

  return storageClientFromProviderPayload({ provider, payload });
}

export function storageClientFromProviderPayload(input: ProviderStorageInput) {
  const provider = input.provider.toLowerCase();
  const payload = normalizeCredentialPayloadAliases(input.payload);

  const accessKeyId = text(payload.access_key_id ?? payload.api_key);
  const secretAccessKey = text(payload.secret_access_key ?? payload.api_secret);

  if (!accessKeyId || !secretAccessKey) {
    throw new StudioValidationError(
      "credential_storage_unsupported",
      "The selected credential cannot list storage objects.",
    );
  }

  const profile = getProviderProfile(provider);
  const endpoint = resolveProviderProfileEndpointUrl(provider, payload);
  if (profile && provider !== "s3" && provider !== "r2" && !endpoint) {
    const templateFields = profile.endpoint?.template_variables?.length
      ? ` or profile fields: ${profile.endpoint.template_variables.join(", ")}`
      : "";
    throw new StudioValidationError(
      "credential_endpoint_required",
      `${profile.name} requires endpoint_url${templateFields} to browse storage.`,
    );
  }

  const region =
    resolveProviderProfileRegion(provider, payload) ||
    (provider === "r2" ? "auto" : "us-east-1");
  const forcePathStyle = resolveProviderProfileForcePathStyle(
    provider,
    payload,
  );

  return {
    provider,
    client: new S3Client({
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      endpoint,
      forcePathStyle: forcePathStyle ?? Boolean(endpoint),
      region,
    }),
  };
}
