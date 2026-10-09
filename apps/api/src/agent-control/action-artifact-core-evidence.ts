import { createHash } from "node:crypto";
import type { ActionResult } from "@beam-studio/core";
import type { CoreArtifactTransferEvidence } from "@beam-studio/db";
import { roomArtifactManifestSchema } from "@beam-studio/shared";
import { resolveBeamEnvironmentTemplate } from "../studio/store.js";
import { roomServiceForOrganization } from "./room-service.js";

type Row = Record<string, any>;
const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};

/** Core's final receipt commits to each range hash. Recompute that commitment
 * from the bounded result bytes; Core's file.identity is path/stat, not SHA-256. */
export function artifactManifestCommitment(bytes: Buffer, chunkSize: number) {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || !bytes.length)
    throw new Error("Invalid Core artifact chunk layout.");
  const digest = createHash("sha256");
  digest.update(`beam:room-file-manifest\0${bytes.length}\n`);
  for (
    let index = 0, offset = 0;
    offset < bytes.length;
    index++, offset += chunkSize
  ) {
    const chunk = bytes.subarray(
      offset,
      Math.min(offset + chunkSize, bytes.length),
    );
    const rangeHash = createHash("sha256").update(chunk).digest("hex");
    digest.update(`${index}\n${offset}\n${chunk.length}\n${rangeHash}\n`);
  }
  return digest.digest("hex");
}

export function coreArtifactEvidence(
  result: ActionResult,
  publicationId: string,
  statusValue: unknown,
  executionValue: unknown,
): CoreArtifactTransferEvidence[] {
  const manifest = roomArtifactManifestSchema.parse(result.artifactManifest);
  const status = object(object(statusValue).status ?? statusValue);
  const publisher = object(status.publisher);
  const preflight = object(publisher.preflight);
  const transferStatus = object(publisher.room_transfer);
  const execution = object(object(executionValue).execution ?? executionValue);
  const publicationTransfers = manifest.transfers.filter(
    (item) => item.publicationId === publicationId,
  );
  const coreTransferId = publicationTransfers[0]?.transferId;
  if (
    transferStatus.status !== "completed" ||
    transferStatus.full_delivery_verified !== true ||
    transferStatus.transfer_id !== coreTransferId ||
    execution.publication_id !== publicationId ||
    execution.transfer_id !== coreTransferId
  )
    return [];
  if (
    !publicationTransfers.length ||
    publicationTransfers.some((item) => item.transferId !== coreTransferId) ||
    preflight.publication_id !== publicationId ||
    preflight.room_id !== publicationTransfers[0]!.roomId ||
    preflight.channel_id !== publicationTransfers[0]!.channelId ||
    preflight.publisher_member_id !== publicationTransfers[0]!.sourceMemberId ||
    publicationTransfers.some(
      (item) =>
        item.roomId !== preflight.room_id ||
        item.channelId !== preflight.channel_id ||
        item.sourceMemberId !== preflight.publisher_member_id,
    )
  )
    return [];
  const size = Number(execution.file_size_bytes);
  const chunkSize = Number(execution.chunk_size_bytes);
  const count = Number(execution.chunk_count);
  if (
    !Number.isSafeInteger(size) ||
    !Number.isSafeInteger(chunkSize) ||
    count !== Math.ceil(size / chunkSize)
  )
    return [];
  const deliveries = Array.isArray(publisher.deliveries)
    ? publisher.deliveries
    : [];
  const targets = Array.isArray(execution.targets) ? execution.targets : [];
  const expectedMembers = new Set(
    publicationTransfers.map((item) => item.destinationMemberId),
  );
  if (
    deliveries.length !== expectedMembers.size ||
    targets.length !== expectedMembers.size ||
    deliveries.some((item: Row) => !expectedMembers.has(item.member_id)) ||
    targets.some((item: Row) => !expectedMembers.has(item.member_id))
  )
    return [];
  const evidence: CoreArtifactTransferEvidence[] = [];
  for (const item of manifest.artifacts) {
    const transfers = manifest.transfers.filter(
      (transfer) =>
        transfer.artifactId === item.artifactId &&
        transfer.publicationId === publicationId,
    );
    if (!transfers.length) continue;
    const artifact = (result.artifacts ?? []).find(
      (candidate) =>
        candidate.metadata?.port === item.port &&
        candidate.metadata?.sha256 === item.sha256,
    );
    if (
      !artifact ||
      item.sizeBytes > 32 * 1024 ||
      artifact.uri.length > 128 + Math.ceil((32 * 1024) / 3) * 4
    )
      continue;
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]*)$/.exec(
      artifact?.uri ?? "",
    );
    if (!match || match[1] !== item.mediaType) continue;
    const bytes = Buffer.from(match[2]!, "base64");
    if (
      bytes.toString("base64") !== match[2] ||
      bytes.length !== size ||
      bytes.length !== item.sizeBytes ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
        item.sha256
    )
      continue;
    const commitment = artifactManifestCommitment(bytes, chunkSize);
    for (const transfer of transfers) {
      const delivery = deliveries.find(
        (entry: Row) => entry.member_id === transfer.destinationMemberId,
      );
      const target = targets.find(
        (entry: Row) => entry.member_id === transfer.destinationMemberId,
      );
      const finalization = object(target?.finalization);
      const basis = delivery?.verification_basis;
      if (
        transfer.transferId !== coreTransferId ||
        delivery?.state !== "delivered" ||
        !["recipient_final_receipt", "provider_finalization"].includes(basis) ||
        typeof delivery?.verified_at !== "string" ||
        !Number.isFinite(Date.parse(delivery.verified_at)) ||
        target?.state !== "completed" ||
        finalization.transfer_id !== transfer.transferId ||
        finalization.target_member_id !== transfer.destinationMemberId ||
        Number(finalization.file_size_bytes) !== size ||
        finalization.manifest_sha256 !== commitment
      )
        continue;
      evidence.push({
        artifactId: item.artifactId,
        publicationId,
        transferId: transfer.transferId,
        destinationMemberId: transfer.destinationMemberId,
        sha256: item.sha256,
        sizeBytes: size,
        verifiedAt: delivery.verified_at,
        verificationBasis: basis,
        contentHashVerified: true,
      });
    }
  }
  return evidence;
}

/** Fail closed on Coordinator unavailability: settlement records a pending
 * manifest and retries publication/status, but cannot release dependents. */
export async function readCoreArtifactEvidence(
  result: ActionResult,
  organizationId: string,
  room: { environmentTemplateKey: string; roomId: string },
) {
  const manifest = roomArtifactManifestSchema.parse(result.artifactManifest);
  if (!manifest.transfers.length) return [];
  const template = await resolveBeamEnvironmentTemplate({
    organizationId,
    templateKey: room.environmentTemplateKey,
  });
  const service = await roomServiceForOrganization(organizationId, template);
  const publications = new Map<string, typeof manifest.transfers>();
  for (const transfer of manifest.transfers) {
    const group = publications.get(transfer.publicationId) ?? [];
    group.push(transfer);
    publications.set(transfer.publicationId, group);
  }
  const evidence: CoreArtifactTransferEvidence[] = [];
  for (const [publicationId, transfers] of publications) {
    const roomId = transfers[0]!.roomId;
    const channelId = transfers[0]!.channelId;
    if (
      roomId !== room.roomId ||
      transfers.some(
        (item) => item.roomId !== roomId || item.channelId !== channelId,
      )
    )
      continue;
    const [status, execution] = await Promise.all([
      service.client.organizationObjectStatus(
        organizationId,
        roomId,
        channelId,
        publicationId,
        service.token,
      ),
      service.client.organizationObjectExecution(
        organizationId,
        roomId,
        channelId,
        publicationId,
        service.token,
      ),
    ]);
    evidence.push(
      ...coreArtifactEvidence(result, publicationId, status, execution),
    );
  }
  return evidence;
}
