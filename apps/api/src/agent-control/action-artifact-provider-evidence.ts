import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  GetObjectRetentionCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { ActionResult } from "@beam-studio/core";
import type {
  PgPool,
  ProviderArtifactEvidence,
} from "@beam-studio/db";
import {
  artifactPublicationPlanSchema,
  roomArtifactManifestSchema,
} from "@beam-studio/shared";
import { getRoomStorageBindingByMember } from "../studio/store.js";
import { providerConfig } from "./room-storage-transfer-manager.js";

type Row = Record<string, any>;

/** Only an independently read object version with compliance retention is a
 * durable provider copy. Unsupported providers leave acceptance pending. */
export async function readProviderArtifactEvidence(
  pool: PgPool,
  result: ActionResult,
  rawPlan: unknown,
  organizationId: string,
  room: { environmentTemplateKey: string; roomId: string },
): Promise<ProviderArtifactEvidence[]> {
  const manifest = roomArtifactManifestSchema.parse(result.artifactManifest);
  const plan = artifactPublicationPlanSchema.parse(rawPlan ?? {});
  const proofs: ProviderArtifactEvidence[] = [];
  for (const [index, artifact] of manifest.artifacts.entries()) {
    const policy = plan[artifact.port];
    if (policy?.availability !== "durable" || policy.roomId !== room.roomId)
      continue;
    const encoded = (result.artifacts ?? [])[index]?.uri ?? "";
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]*)$/.exec(encoded);
    if (
      !match ||
      match[1] !== artifact.mediaType ||
      artifact.sizeBytes > 32 * 1024
    )
      continue;
    const bytes = Buffer.from(match[2]!, "base64");
    if (
      bytes.toString("base64") !== match[2] ||
      bytes.length !== artifact.sizeBytes ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
        artifact.sha256
    )
      continue;
    for (const location of manifest.locations) {
      if (
        location.artifactId !== artifact.artifactId ||
        location.kind !== "storage" ||
        !location.memberId ||
        location.verificationBasis !== "provider_finalization" ||
        !policy.targetMemberIds.includes(location.memberId)
      )
        continue;
      const transfer = manifest.transfers.find(
        (item) =>
          item.artifactId === artifact.artifactId &&
          item.destinationMemberId === location.memberId &&
          item.transferId === location.locator,
      );
      if (!transfer) continue;
      const binding = await getRoomStorageBindingByMember(
        organizationId,
        room.environmentTemplateKey,
        room.roomId,
        location.memberId,
      );
      if (!binding) continue;
      const session = await pool.query<Row>(
        `SELECT s.object_key,s.parts_json FROM studio.room_storage_multipart_sessions s
         JOIN studio.room_storage_transfer_jobs j ON j.organization_id=s.organization_id
           AND j.publication_id=s.publication_id
         WHERE s.organization_id=$1 AND s.publication_id=$2
           AND s.target_member_id=$3 AND s.binding_id=$4 AND s.state='completed'
           AND j.environment_template_key=$5 AND j.room_id=$6 AND j.channel_id=$7
           AND j.source_member_id=$8 AND j.workflow_run_id=$9
           AND j.workflow_step_run_id=$10 AND j.status IN ('completed','partial')
         ORDER BY s.updated_at DESC LIMIT 1`,
        [
          organizationId,
          transfer.publicationId,
          location.memberId,
          binding.id,
          room.environmentTemplateKey,
          policy.roomId,
          policy.channelId,
          policy.sourceMemberId,
          (result.artifacts ?? [])[index]?.metadata?.workflowRunId,
          (result.artifacts ?? [])[index]?.metadata?.stepRunId,
        ],
      );
      const row = session.rows[0];
      const finalObject = row?.parts_json?.finalObject;
      const versionId = String(finalObject?.versionId ?? "");
      if (!row?.object_key || !versionId) continue;
      try {
        const provider = await providerConfig(
          pool,
          organizationId,
          binding,
          row.object_key,
        );
        const proof = await verifyProviderArtifactVersion({
          provider,
          artifactId: artifact.artifactId,
          memberId: location.memberId,
          locator: location.locator,
          sha256: artifact.sha256,
          bytes,
          versionId,
          etag: String(finalObject?.etag ?? ""),
          requiredUntil: policy.requiredUntil,
        });
        if (proof) proofs.push(proof);
      } catch {
        // Provider outage, missing permissions, or unsupported Object Lock
        // cannot satisfy the durable policy. The retained result is retried.
      }
    }
  }
  return proofs;
}

export async function verifyProviderArtifactVersion(input: {
  provider: {
    bucket: string;
    key: string;
    region?: string;
    endpoint_url?: string;
    force_path_style?: boolean;
    access_key_id: string;
    secret_access_key: string;
    session_token?: string;
  };
  artifactId: string;
  memberId: string;
  locator: string;
  sha256: string;
  bytes: Buffer;
  versionId: string;
  etag: string;
  requiredUntil: string;
}): Promise<ProviderArtifactEvidence | null> {
  const { provider } = input;
  if (!input.versionId || input.bytes.length > 32 * 1024) return null;
  const client = new S3Client({
    region: provider.region || "us-east-1",
    endpoint: provider.endpoint_url,
    forcePathStyle: provider.force_path_style,
    credentials: {
      accessKeyId: provider.access_key_id,
      secretAccessKey: provider.secret_access_key,
      sessionToken: provider.session_token,
    },
    maxAttempts: 1,
  });
  try {
    const signal = AbortSignal.timeout(15_000);
    const object = await client.send(
      new GetObjectCommand({
        Bucket: provider.bucket,
        Key: provider.key,
        VersionId: input.versionId,
      }),
      { abortSignal: signal },
    );
    if (object.ContentLength !== input.bytes.length || !object.Body)
      return null;
    const chunks: Buffer[] = [];
    let readLength = 0;
    for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
      readLength += chunk.length;
      if (readLength > input.bytes.length) return null;
      chunks.push(Buffer.from(chunk));
    }
    const readback = Buffer.concat(chunks, readLength);
    const retention = await client.send(
      new GetObjectRetentionCommand({
        Bucket: provider.bucket,
        Key: provider.key,
        VersionId: input.versionId,
      }),
      { abortSignal: signal },
    );
    return providerArtifactAttestation(input, {
      versionId: object.VersionId,
      etag: object.ETag,
      readback,
      retentionMode: retention.Retention?.Mode,
      retainedUntil: retention.Retention?.RetainUntilDate,
    });
  } finally {
    client.destroy();
  }
}

export function providerArtifactAttestation(
  input: Parameters<typeof verifyProviderArtifactVersion>[0],
  observed: {
    versionId?: string;
    etag?: string;
    readback: Buffer;
    retentionMode?: string;
    retainedUntil?: Date;
  },
): ProviderArtifactEvidence | null {
  if (
    !input.versionId ||
    !input.provider.bucket ||
    !input.provider.key ||
    input.bytes.length > 32 * 1024 ||
    observed.versionId !== input.versionId ||
    (input.etag && observed.etag !== input.etag) ||
    observed.readback.length !== input.bytes.length ||
    !observed.readback.equals(input.bytes) ||
    `sha256:${createHash("sha256").update(observed.readback).digest("hex")}` !==
      input.sha256 ||
    observed.retentionMode !== "COMPLIANCE" ||
    !observed.retainedUntil ||
    observed.retainedUntil.getTime() < Date.parse(input.requiredUntil)
  )
    return null;
  return {
    artifactId: input.artifactId,
    memberId: input.memberId,
    locator: input.locator,
    sha256: input.sha256,
    sizeBytes: input.bytes.length,
    bucket: input.provider.bucket,
    objectKey: input.provider.key,
    versionId: input.versionId,
    retainedUntil: observed.retainedUntil.toISOString(),
    verifiedAt: new Date().toISOString(),
  };
}
