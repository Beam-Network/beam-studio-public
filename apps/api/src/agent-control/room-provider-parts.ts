import { ListPartsCommand, S3Client } from "@aws-sdk/client-s3";
import {
  isS3CompatibleProvider,
  s3CompatibleEndpoint,
  s3CompatibleForcePathStyle,
  s3CompatibleRegion,
  type ProviderDestinationConfig,
} from "@beam-network/sdk";

export type VerifiedProviderPart = {
  partNumber: number;
  etag: string;
  size: number;
  uploadedAt?: string;
};

// Read provider metadata directly. Participant receipts cannot supply this time.
export async function listRoomProviderParts(
  provider: ProviderDestinationConfig,
  objectKey: string,
  uploadId: string,
  signal: AbortSignal,
): Promise<VerifiedProviderPart[]> {
  if (!isS3CompatibleProvider(provider))
    throw new Error("room_storage_provider_unsupported");
  const endpoint = s3CompatibleEndpoint(provider);
  const client = new S3Client({
    endpoint,
    region: s3CompatibleRegion(provider),
    forcePathStyle: s3CompatibleForcePathStyle(provider, endpoint),
    credentials: {
      accessKeyId: provider.access_key_id,
      secretAccessKey: provider.secret_access_key,
      sessionToken: "session_token" in provider ? provider.session_token : undefined,
    },
    maxAttempts: 1,
  });
  const parts: VerifiedProviderPart[] = [];
  let marker: string | undefined;
  try {
    do {
      const page = await client.send(new ListPartsCommand({
        Bucket: provider.bucket, Key: objectKey, UploadId: uploadId,
        MaxParts: 1000, PartNumberMarker: marker,
      }), { abortSignal: signal });
      for (const part of page.Parts ?? []) {
        if (!Number.isSafeInteger(part.PartNumber) || !part.ETag ||
            !Number.isSafeInteger(part.Size) || part.Size! < 0)
          throw new Error("room_storage_provider_part_invalid");
        const time = part.LastModified?.getTime();
        parts.push({ partNumber: part.PartNumber!, etag: part.ETag, size: part.Size!,
          ...(time !== undefined && Number.isFinite(time)
            ? { uploadedAt: new Date(time).toISOString() } : {}),
        });
      }
      if (parts.length > 16384) throw new Error("room_storage_provider_parts_limit");
      if (!page.IsTruncated) break;
      if (!page.NextPartNumberMarker || Number(page.NextPartNumberMarker) <= Number(marker ?? 0))
        throw new Error("room_storage_provider_page_invalid");
      marker = page.NextPartNumberMarker;
    } while (true);
    return parts;
  } finally { client.destroy(); }
}
