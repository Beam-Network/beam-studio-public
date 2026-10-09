import {
  GetObjectRetentionCommand,
  PutObjectRetentionCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { ProviderDestinationConfig } from "@beam-network/sdk";

/** Core finalization follows only after the exact object version is locked and
 * the provider reads back COMPLIANCE retention through the frozen deadline. */
export async function retainArtifactObjectVersion(
  provider: ProviderDestinationConfig,
  objectKey: string,
  versionId: string | undefined,
  requiredUntil: string,
  signal: AbortSignal,
) {
  if (
    !versionId ||
    !objectKey ||
    !("bucket" in provider) ||
    !("access_key_id" in provider) ||
    !("secret_access_key" in provider) ||
    !Number.isFinite(Date.parse(requiredUntil)) ||
    Date.parse(requiredUntil) <= Date.now()
  )
    throw new Error("room_storage_artifact_retention_unavailable");
  const deadline = new Date(requiredUntil);
  const client = new S3Client({
    region: "region" in provider ? provider.region || "us-east-1" : "us-east-1",
    endpoint: provider.endpoint_url,
    forcePathStyle:
      "force_path_style" in provider ? provider.force_path_style : undefined,
    credentials: {
      accessKeyId: provider.access_key_id,
      secretAccessKey: provider.secret_access_key,
      sessionToken:
        "session_token" in provider ? provider.session_token : undefined,
    },
    maxAttempts: 1,
  });
  try {
    const read = () =>
      client.send(
        new GetObjectRetentionCommand({
          Bucket: provider.bucket,
          Key: objectKey,
          VersionId: versionId,
        }),
        { abortSignal: signal },
      );
    try {
      const existing = await read();
      if (
        existing.Retention?.Mode === "COMPLIANCE" &&
        existing.Retention.RetainUntilDate &&
        existing.Retention.RetainUntilDate.getTime() >= deadline.getTime()
      )
        return;
    } catch {
      // A bucket without Object Lock can fail this read; the write and final
      // readback below still have to succeed before Core finalization.
    }
    await client.send(
      new PutObjectRetentionCommand({
        Bucket: provider.bucket,
        Key: objectKey,
        VersionId: versionId,
        Retention: { Mode: "COMPLIANCE", RetainUntilDate: deadline },
      }),
      { abortSignal: signal },
    );
    const observed = await read();
    if (
      observed.Retention?.Mode !== "COMPLIANCE" ||
      !observed.Retention.RetainUntilDate ||
      observed.Retention.RetainUntilDate.getTime() < deadline.getTime()
    )
      throw new Error("room_storage_artifact_retention_unavailable");
  } finally {
    client.destroy();
  }
}
