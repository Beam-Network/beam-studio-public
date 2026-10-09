import { createHash } from "node:crypto";
import type { ActionResult } from "@beam-studio/core";
import {
  artifactPublicationPlanSchema,
  roomArtifactManifestSchema,
  type ArtifactPublicationPlan,
  type RoomArtifactManifest,
} from "@beam-studio/shared";
import { pgOne, type PgClient } from "./postgres.js";

export class ArtifactAcceptanceError extends Error {
  readonly code = "artifact_result_invalid";
}

type Identity = {
  workflowRunId: string;
  stepRunId: string;
  taskId: string;
  assignmentId: string;
  attempt: number;
};

type Assessment = {
  manifest: RoomArtifactManifest;
  plan: ArtifactPublicationPlan;
  identityHash: string;
  pendingReason: string | null;
  providerEvidence: readonly ProviderArtifactEvidence[];
};

/** Created only by Studio's independent Coordinator status read. */
export type CoreArtifactTransferEvidence = {
  artifactId: string;
  publicationId: string;
  transferId: string;
  destinationMemberId: string;
  sha256: string;
  sizeBytes: number;
  verifiedAt: string;
  verificationBasis: "recipient_final_receipt" | "provider_finalization";
  /** Core's current file.identity is path/stat identity, not a content digest. */
  contentHashVerified: boolean;
};

/** Produced by Studio after reading the exact provider object version and its
 * compliance-mode retention. Agent finalization is never sufficient here. */
export type ProviderArtifactEvidence = {
  artifactId: string;
  memberId: string;
  locator: string;
  sha256: string;
  sizeBytes: number;
  bucket: string;
  objectKey: string;
  versionId: string;
  retainedUntil: string;
  verifiedAt: string;
};

function invalid(message: string): never {
  throw new ArtifactAcceptanceError(message);
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sameRoom(
  value: { roomId: string; channelId: string; sourceMemberId: string },
  expected: { roomId: string; channelId: string; sourceMemberId: string },
) {
  return (
    value.roomId === expected.roomId &&
    value.channelId === expected.channelId &&
    value.sourceMemberId === expected.sourceMemberId
  );
}

/** Validate identity before persisting even a pending transfer. The frozen plan
 * decides destinations and retention; executor evidence can only satisfy it. */
export function assessRoomArtifactResult(
  result: ActionResult,
  rawPlan: unknown,
  identity: Identity,
  now = new Date(),
  coreEvidence: readonly CoreArtifactTransferEvidence[] = [],
  providerEvidence: readonly ProviderArtifactEvidence[] = [],
): Assessment | null {
  const artifacts = result.artifacts ?? [];
  if (!artifacts.length && !result.artifactManifest) return null;
  const manifest = roomArtifactManifestSchema.parse(result.artifactManifest);
  const plan = artifactPublicationPlanSchema.parse(rawPlan ?? {});
  if (!artifacts.length || artifacts.length !== manifest.artifacts.length)
    invalid("Artifact collection is incomplete.");
  if (manifest.publicationId !== identity.assignmentId)
    invalid("Artifact publication belongs to another assignment.");
  const grouped = new Map<string, number>();
  const keys = new Set<string>();
  const ids = new Set<string>();
  let totalBytes = 0;
  for (let i = 0; i < artifacts.length; i++) {
    const artifact = artifacts[i]!;
    const item = manifest.artifacts[i]!;
    const port = artifact.metadata?.port;
    if (typeof port !== "string" || !Object.hasOwn(plan, port))
      invalid("Artifact output has no frozen publication plan.");
    const index = grouped.get(port) ?? 0;
    grouped.set(port, index + 1);
    if (
      item.port !== port ||
      item.index !== index ||
      (artifact.id && artifact.id !== item.artifactId) ||
      artifact.mediaType !== item.mediaType ||
      artifact.metadata?.sha256 !== item.sha256 ||
      artifact.metadata?.bytes !== item.sizeBytes ||
      artifact.metadata?.workflowRunId !== identity.workflowRunId ||
      artifact.metadata?.stepRunId !== identity.stepRunId ||
      artifact.metadata?.taskId !== identity.taskId ||
      artifact.metadata?.assignmentId !== identity.assignmentId ||
      artifact.metadata?.attempt !== identity.attempt
    )
      invalid(
        "Artifact bytes or provenance differ from the immutable manifest.",
      );
    if (ids.has(item.artifactId) || keys.has(`${port}:${index}`))
      invalid("Artifact identity is duplicated.");
    if (
      item.sizeBytes > 32 * 1024 ||
      (totalBytes += item.sizeBytes) > 64 * 1024 ||
      artifact.uri.length > 128 + Math.ceil((32 * 1024) / 3) * 4
    )
      invalid("Artifact result exceeds the bounded runtime limits.");
    ids.add(item.artifactId);
    keys.add(`${port}:${index}`);
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]*)$/.exec(artifact.uri);
    if (!match || match[1] !== item.mediaType)
      invalid("Artifact bytes have no bounded data URI.");
    const bytes = Buffer.from(match[2]!, "base64");
    if (
      bytes.toString("base64") !== match[2] ||
      bytes.length !== item.sizeBytes ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
        item.sha256
    )
      invalid("Artifact bytes do not match their pinned digest.");
  }
  let pendingReason: string | null = null;
  const locations = new Set<string>();
  for (const location of manifest.locations) {
    const artifact = manifest.artifacts.find(
      (item) => item.artifactId === location.artifactId,
    );
    if (!artifact) invalid("Location refers to an unknown artifact.");
    const expected = plan[artifact.port]!;
    if (
      !sameRoom(location, expected) ||
      (location.kind === "member" &&
        (!location.memberId ||
          (location.memberId !== expected.sourceMemberId &&
            !expected.targetMemberIds.includes(location.memberId))))
    )
      invalid("Location differs from the frozen room or source.");
    const key = JSON.stringify([
      location.artifactId,
      location.kind,
      location.locator,
      location.memberId ?? null,
    ]);
    if (locations.has(key)) invalid("Location is duplicated.");
    locations.add(key);
    const obligation = `${expected.retentionObligationId}:${artifact.index}`;
    if (
      location.kind === "member" &&
      location.memberId === expected.sourceMemberId &&
      location.retentionObligationId !== obligation
    )
      invalid("Location has no matching retention obligation.");
    if (
      location.kind === "storage" &&
      location.verificationBasis !== "provider_finalization"
    )
      invalid("Durable storage location lacks provider finalization evidence.");
    if (
      location.kind === "member" &&
      location.memberId !== expected.sourceMemberId &&
      location.verificationBasis === "local_hash"
    )
      invalid("Recipient location lacks final delivery evidence.");
    if (Date.parse(location.verifiedAt) > now.getTime() + 60_000)
      invalid("Location verification is in the future.");
  }
  const transfers = new Map<
    string,
    RoomArtifactManifest["transfers"][number]
  >();
  const verified = new Map(
    coreEvidence.map((item) => [
      `${item.artifactId}:${item.destinationMemberId}`,
      item,
    ]),
  );
  const providerVerified = new Map(
    providerEvidence.map((item) => [
      `${item.artifactId}:${item.memberId}:${item.locator}`,
      item,
    ]),
  );
  for (const transfer of manifest.transfers) {
    const artifact = manifest.artifacts.find(
      (item) => item.artifactId === transfer.artifactId,
    );
    if (!artifact) invalid("Transfer refers to an unknown artifact.");
    const expected = plan[artifact.port]!;
    if (
      !sameRoom(transfer, expected) ||
      !expected.targetMemberIds.includes(transfer.destinationMemberId)
    )
      invalid("Transfer has an unauthorized destination.");
    const key = `${transfer.artifactId}:${transfer.destinationMemberId}`;
    if (transfers.has(key)) invalid("Transfer evidence is duplicated.");
    transfers.set(key, transfer);
  }
  for (const artifact of manifest.artifacts) {
    const expected = plan[artifact.port]!;
    if (
      new Set(expected.targetMemberIds).size !== expected.targetMemberIds.length
    )
      invalid("Frozen transfer destinations are duplicated.");
    if (Date.parse(expected.requiredUntil) <= now.getTime())
      invalid("Frozen retention deadline has expired.");
    const available = manifest.locations.some((location) => {
      if (location.artifactId !== artifact.artifactId) return false;
      if (expected.availability === "temporary")
        return (
          location.durableUntil !== null &&
          Date.parse(location.durableUntil) >=
            Date.parse(expected.requiredUntil) &&
          location.kind === "member" &&
          location.memberId === expected.sourceMemberId &&
          location.verificationBasis === "local_hash"
        );
      if (
        location.kind !== "storage" ||
        !location.memberId ||
        location.verificationBasis !== "provider_finalization" ||
        !expected.targetMemberIds.includes(location.memberId)
      )
        return false;
      const proof = providerVerified.get(
        `${artifact.artifactId}:${location.memberId}:${location.locator}`,
      );
      return (
        !!proof &&
        proof.sha256 === artifact.sha256 &&
        proof.sizeBytes === artifact.sizeBytes &&
        Date.parse(proof.retainedUntil) >= Date.parse(expected.requiredUntil) &&
        Date.parse(proof.verifiedAt) <= now.getTime() + 60_000 &&
        Date.parse(proof.verifiedAt) >= Date.parse(location.verifiedAt)
      );
    });
    if (!available)
      pendingReason =
        expected.availability === "durable"
          ? "artifact_provider_evidence_unavailable"
          : "artifact_availability_insufficient";
    for (const memberId of expected.targetMemberIds) {
      const transfer = transfers.get(`${artifact.artifactId}:${memberId}`);
      if (
        !transfer ||
        transfer.status !== "completed" ||
        transfer.fullDeliveryVerified !== true
      )
        pendingReason = "artifact_transfer_incomplete";
      if (!transfer) continue;
      const proof = verified.get(`${artifact.artifactId}:${memberId}`);
      if (!proof) {
        pendingReason = "artifact_core_evidence_unavailable";
      } else if (
        proof.publicationId !== transfer.publicationId ||
        proof.transferId !== transfer.transferId ||
        proof.sha256 !== artifact.sha256 ||
        proof.sizeBytes !== artifact.sizeBytes ||
        !manifest.locations.some(
          (location) =>
            location.artifactId === artifact.artifactId &&
            (location.kind === "member" ||
              (location.kind === "storage" &&
                proof.verificationBasis === "provider_finalization")) &&
            location.memberId === memberId &&
            location.verificationBasis === proof.verificationBasis &&
            Date.parse(location.verifiedAt) === Date.parse(proof.verifiedAt),
        )
      ) {
        invalid(
          "Coordinator evidence conflicts with artifact identity or recipient.",
        );
      }
      if (proof && !proof.contentHashVerified)
        pendingReason = "artifact_content_readback_unavailable";
    }
  }
  return {
    manifest,
    plan,
    identityHash: hash(manifest.artifacts),
    pendingReason,
    providerEvidence: providerEvidence.filter((proof) =>
      manifest.locations.some(
        (location) =>
          location.kind === "storage" &&
          location.artifactId === proof.artifactId &&
          location.memberId === proof.memberId &&
          location.locator === proof.locator,
      ),
    ),
  };
}

/** Called under the task/assignment lock and in the same transaction as settlement. */
export async function persistArtifactAssessmentPg(
  client: PgClient,
  input: Identity & { result: ActionResult; assessment: Assessment },
) {
  const { manifest, plan, identityHash, pendingReason, providerEvidence } =
    input.assessment;
  const existing = await pgOne<{
    id: string;
    artifact_identity_hash: string;
    status: string;
  }>(
    client,
    `SELECT id,artifact_identity_hash,status FROM execution.workflow_artifact_manifests
     WHERE task_id=$1 AND attempt=$2 FOR UPDATE`,
    [input.taskId, input.attempt],
  );
  if (existing && existing.artifact_identity_hash !== identityHash)
    invalid("A retry attempted to replace immutable artifact content.");
  if (existing?.status === "accepted")
    return { status: "accepted" as const, id: existing.id };
  const id = existing?.id ?? `manifest_${input.assignmentId}`;
  await client.query(
    `INSERT INTO execution.workflow_artifact_manifests
      (id,workflow_run_id,workflow_step_run_id,task_id,assignment_id,attempt,publication_id,artifact_identity_hash,artifacts_json,result_json,status,error,accepted_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,CASE WHEN $11='accepted' THEN now() ELSE NULL END)
     ON CONFLICT(id) DO UPDATE SET result_json=EXCLUDED.result_json,status=EXCLUDED.status,
       error=EXCLUDED.error,accepted_at=EXCLUDED.accepted_at,updated_at=now()`,
    [
      id,
      input.workflowRunId,
      input.stepRunId,
      input.taskId,
      input.assignmentId,
      input.attempt,
      manifest.publicationId,
      identityHash,
      JSON.stringify(manifest.artifacts),
      JSON.stringify(input.result),
      pendingReason ? "pending" : "accepted",
      pendingReason,
    ],
  );
  for (const artifact of manifest.artifacts) {
    const recorded =
      (await pgOne<{
        sha256: string;
        size_bytes: string;
        workflow_run_id: string;
        task_id: string;
        media_type: string;
      }>(
        client,
        `INSERT INTO execution.workflow_artifact_identities
        (artifact_id,workflow_run_id,task_id,sha256,size_bytes,media_type)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(artifact_id) DO NOTHING
       RETURNING sha256,size_bytes,workflow_run_id,task_id,media_type`,
        [
          artifact.artifactId,
          input.workflowRunId,
          input.taskId,
          artifact.sha256,
          artifact.sizeBytes,
          artifact.mediaType,
        ],
      )) ??
      (await pgOne(
        client,
        `SELECT sha256,size_bytes,workflow_run_id,task_id,media_type FROM execution.workflow_artifact_identities WHERE artifact_id=$1`,
        [artifact.artifactId],
      ));
    if (
      recorded?.sha256 !== artifact.sha256 ||
      Number(recorded?.size_bytes) !== artifact.sizeBytes ||
      recorded?.workflow_run_id !== input.workflowRunId ||
      recorded?.task_id !== input.taskId ||
      recorded?.media_type !== artifact.mediaType
    )
      invalid("Artifact ID already names different content or provenance.");
  }
  await client.query(
    `DELETE FROM execution.workflow_artifact_locations WHERE manifest_id=$1`,
    [id],
  );
  await client.query(
    `DELETE FROM execution.workflow_artifact_transfers WHERE manifest_id=$1`,
    [id],
  );
  for (const location of manifest.locations)
    await client.query(
      `INSERT INTO execution.workflow_artifact_locations
       (manifest_id,artifact_id,kind,locator,member_id,room_id,channel_id,source_member_id,verified_at,verification_basis,durable_until,retention_obligation_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        location.artifactId,
        location.kind,
        location.locator,
        location.memberId ?? null,
        location.roomId,
        location.channelId,
        location.sourceMemberId,
        location.verifiedAt,
        location.verificationBasis,
        providerEvidence.find(
          (proof) =>
            location.kind === "storage" &&
            proof.artifactId === location.artifactId &&
            proof.memberId === location.memberId &&
            proof.locator === location.locator,
        )?.retainedUntil ?? location.durableUntil,
        location.retentionObligationId ?? null,
      ],
    );
  for (const proof of providerEvidence) {
    const recorded = await pgOne<{
      bucket: string;
      object_key: string;
      version_id: string;
      sha256: string;
      size_bytes: string;
    }>(
      client,
      `SELECT bucket,object_key,version_id,sha256,size_bytes
       FROM execution.workflow_artifact_provider_attestations
       WHERE manifest_id=$1 AND artifact_id=$2 AND member_id=$3 AND locator=$4 FOR UPDATE`,
      [id, proof.artifactId, proof.memberId, proof.locator],
    );
    if (
      recorded &&
      (recorded.bucket !== proof.bucket ||
        recorded.object_key !== proof.objectKey ||
        recorded.version_id !== proof.versionId ||
        recorded.sha256 !== proof.sha256 ||
        Number(recorded.size_bytes) !== proof.sizeBytes)
    )
      invalid("Provider attestation changed the accepted object version.");
    await client.query(
      `INSERT INTO execution.workflow_artifact_provider_attestations
       (manifest_id,artifact_id,member_id,locator,bucket,object_key,version_id,sha256,size_bytes,retained_until,verified_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT(manifest_id,artifact_id,member_id,locator) DO UPDATE SET
         retained_until=GREATEST(execution.workflow_artifact_provider_attestations.retained_until,EXCLUDED.retained_until),
         verified_at=GREATEST(execution.workflow_artifact_provider_attestations.verified_at,EXCLUDED.verified_at)`,
      [
        id,
        proof.artifactId,
        proof.memberId,
        proof.locator,
        proof.bucket,
        proof.objectKey,
        proof.versionId,
        proof.sha256,
        proof.sizeBytes,
        proof.retainedUntil,
        proof.verifiedAt,
      ],
    );
  }
  for (const transfer of manifest.transfers)
    await client.query(
      `INSERT INTO execution.workflow_artifact_transfers
       (manifest_id,artifact_id,destination_member_id,publication_id,transfer_id,room_id,channel_id,source_member_id,status,full_delivery_verified)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        transfer.artifactId,
        transfer.destinationMemberId,
        transfer.publicationId,
        transfer.transferId,
        transfer.roomId,
        transfer.channelId,
        transfer.sourceMemberId,
        transfer.status,
        transfer.fullDeliveryVerified,
      ],
    );
  for (const artifact of manifest.artifacts) {
    const policy = plan[artifact.port]!;
    const held = manifest.locations.some(
      (location) =>
        location.artifactId === artifact.artifactId &&
        location.kind === "member" &&
        location.memberId === policy.sourceMemberId &&
        location.retentionObligationId ===
          `${policy.retentionObligationId}:${artifact.index}`,
    );
    const obligationId = `${policy.retentionObligationId}:${artifact.index}`;
    const existingObligation = await pgOne<{
      manifest_id: string;
      artifact_id: string;
      required_until: string;
    }>(
      client,
      `SELECT manifest_id,artifact_id,required_until FROM execution.workflow_artifact_obligations
       WHERE obligation_id=$1 FOR UPDATE`,
      [obligationId],
    );
    if (
      existingObligation &&
      (existingObligation.manifest_id !== id ||
        existingObligation.artifact_id !== artifact.artifactId ||
        Date.parse(String(existingObligation.required_until)) !==
          Date.parse(policy.requiredUntil))
    )
      invalid(
        "Retention obligation ID already names another artifact or deadline.",
      );
    await client.query(
      `INSERT INTO execution.workflow_artifact_obligations
       (obligation_id,manifest_id,artifact_id,required_until,status)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(obligation_id) DO UPDATE SET status=CASE
         WHEN execution.workflow_artifact_obligations.status='pending' AND EXCLUDED.status='active'
         THEN 'active' ELSE execution.workflow_artifact_obligations.status END`,
      [
        obligationId,
        id,
        artifact.artifactId,
        policy.requiredUntil,
        held ? "active" : "pending",
      ],
    );
  }
  return {
    status: pendingReason ? ("pending" as const) : ("accepted" as const),
    id,
  };
}

/** A read may use only an accepted identity with a currently available copy.
 * The caller must separately authorize this exact room/location, including caches. */
export async function availableWorkflowArtifactPg(
  client: PgClient,
  artifactId: string,
) {
  const row = await pgOne<{
    artifact_id: string;
    sha256: string;
    size_bytes: string;
    manifest_id: string;
  }>(
    client,
    `SELECT i.artifact_id,i.sha256,i.size_bytes,m.id AS manifest_id
     FROM execution.workflow_artifact_identities i
     JOIN execution.workflow_artifact_manifests m ON m.task_id=i.task_id
       AND m.status='accepted'
     WHERE i.artifact_id=$1 AND m.artifacts_json @> jsonb_build_array(jsonb_build_object('artifactId',$1))
       AND EXISTS(SELECT 1 FROM execution.workflow_artifact_locations l
         WHERE l.manifest_id=m.id AND l.artifact_id=i.artifact_id AND l.state='available'
           AND (l.durable_until IS NULL OR l.durable_until>now()))
     LIMIT 1`,
    [artifactId],
  );
  if (!row)
    throw new ArtifactAcceptanceError(
      "Artifact has no verified available copy; recovery is required.",
    );
  const locations = await client.query<{
    kind: string;
    locator: string;
    member_id: string | null;
    room_id: string;
    channel_id: string;
    source_member_id: string;
  }>(
    `SELECT kind,locator,member_id,room_id,channel_id,source_member_id
     FROM execution.workflow_artifact_locations
     WHERE manifest_id=$1 AND artifact_id=$2 AND state='available'
       AND (durable_until IS NULL OR durable_until>now())`,
    [row.manifest_id, artifactId],
  );
  return {
    artifactId,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    locations: locations.rows,
  };
}

/** The distributed task planner freezes this reference in task metadata before
 * dispatch. Runtime reads still recheck authorization and current availability. */
export async function freezeWorkflowArtifactInputPg(
  client: PgClient,
  input: {
    manifestId: string;
    artifactId: string;
    destinationMemberId: string;
  },
) {
  type FrozenLocation = {
    sha256: string;
    size_bytes: string;
    media_type: string;
    room_id: string;
    channel_id: string;
    source_member_id: string;
    member_id: string;
    transfer_id: string;
  };
  const local = await pgOne<FrozenLocation>(
    client,
    `SELECT i.sha256,i.size_bytes,i.media_type,
       l.room_id,l.channel_id,l.source_member_id,l.member_id,l.locator AS transfer_id
     FROM execution.workflow_artifact_manifests m
     JOIN execution.workflow_artifact_identities i ON i.task_id=m.task_id
       AND i.artifact_id=$2
     JOIN execution.workflow_artifact_locations l ON l.manifest_id=m.id
       AND l.artifact_id=i.artifact_id AND l.kind='member'
       AND l.member_id=$3 AND l.source_member_id=$3
       AND l.verification_basis='local_hash' AND l.state='available'
       AND l.durable_until>now()
     JOIN execution.workflow_artifact_obligations o ON o.manifest_id=m.id
       AND o.artifact_id=i.artifact_id AND o.obligation_id=l.retention_obligation_id
       AND o.status='active'
     WHERE m.id=$1 AND m.status='accepted'
     ORDER BY l.verified_at DESC LIMIT 1`,
    [input.manifestId, input.artifactId, input.destinationMemberId],
  );
  const row =
    local ??
    (await pgOne<FrozenLocation>(
      client,
      `SELECT i.sha256,i.size_bytes,i.media_type,
       l.room_id,l.channel_id,l.source_member_id,l.member_id,t.transfer_id
     FROM execution.workflow_artifact_manifests m
     JOIN execution.workflow_artifact_identities i ON i.task_id=m.task_id
       AND i.artifact_id=$2
     JOIN execution.workflow_artifact_transfers t ON t.manifest_id=m.id
       AND t.artifact_id=i.artifact_id AND t.destination_member_id=$3
       AND t.status='completed' AND t.full_delivery_verified=true
     JOIN execution.workflow_artifact_locations l ON l.manifest_id=m.id
       AND l.artifact_id=i.artifact_id AND l.kind='member'
       AND l.member_id=t.destination_member_id AND l.room_id=t.room_id
       AND l.channel_id=t.channel_id AND l.source_member_id=t.source_member_id
       AND l.verification_basis IN ('recipient_final_receipt','provider_finalization')
       AND l.state='available' AND (l.durable_until IS NULL OR l.durable_until>now())
     WHERE m.id=$1 AND m.status='accepted'
     ORDER BY l.verified_at DESC LIMIT 1`,
      [input.manifestId, input.artifactId, input.destinationMemberId],
    ));
  if (!row)
    throw new ArtifactAcceptanceError(
      "Routed artifact lacks verified recipient availability.",
    );
  return {
    manifestId: input.manifestId,
    artifactId: input.artifactId,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    mediaType: row.media_type,
    location: {
      kind: "member" as const,
      roomId: row.room_id,
      channelId: row.channel_id,
      sourceMemberId: row.source_member_id,
      memberId: row.member_id,
      transferId: row.transfer_id,
    },
  };
}

/** An observed missing/corrupt copy is durable evidence, never silently replaced. */
export async function recordWorkflowArtifactLocationLostPg(
  client: PgClient,
  input: {
    manifestId: string;
    artifactId: string;
    kind: "member" | "storage";
    locator: string;
    memberId: string;
  },
) {
  const manifest = await pgOne<{
    id: string;
    status: string;
    workflow_run_id: string;
  }>(
    client,
    `SELECT id,status,workflow_run_id FROM execution.workflow_artifact_manifests WHERE id=$1 FOR UPDATE`,
    [input.manifestId],
  );
  if (!manifest || !["accepted", "unavailable"].includes(manifest.status))
    throw new ArtifactAcceptanceError("Artifact manifest is not accepted.");
  await client.query(
    `UPDATE execution.workflow_artifact_locations SET state='lost',lost_at=COALESCE(lost_at,now()),updated_at=now()
     WHERE manifest_id=$1 AND artifact_id=$2 AND kind=$3 AND locator=$4
       AND member_id=$5 AND state='available'`,
    [
      input.manifestId,
      input.artifactId,
      input.kind,
      input.locator,
      input.memberId,
    ],
  );
  const surviving = await pgOne<{ available: boolean }>(
    client,
    `SELECT EXISTS(SELECT 1 FROM execution.workflow_artifact_locations
       WHERE manifest_id=$1 AND artifact_id=$2 AND state='available'
         AND (durable_until IS NULL OR durable_until>now())) AS available`,
    [input.manifestId, input.artifactId],
  );
  if (!surviving?.available) {
    await client.query(
      `UPDATE execution.workflow_artifact_manifests SET status='unavailable',
       error='All verified copies of an accepted artifact are lost; authorized recovery is required.',
       updated_at=now() WHERE id=$1`,
      [input.manifestId],
    );
    // Completed runs retain their historical status, but their output is no
    // longer valid. Active consumers fail immediately on the next authorized
    // read because the manifest is unavailable.
    await client.query(
      `UPDATE execution.workflow_runs SET output_validation='invalid',
       error=COALESCE(error,'Accepted artifact became unavailable after its last verified copy was lost.'),
       updated_at=now() WHERE id=$1 AND status='completed'`,
      [manifest.workflow_run_id],
    );
  }
  return surviving?.available
    ? ("available" as const)
    : ("unavailable" as const);
}

/** Call only after the authenticated agent acknowledges release; retry is idempotent. */
export async function acknowledgeWorkflowArtifactReleasePg(
  client: PgClient,
  input: {
    assignmentId: string;
    obligationId: string;
    cleanupConfirmed: boolean;
  },
) {
  const result = await client.query<{
    manifest_id: string;
    artifact_id: string;
  }>(
    `UPDATE execution.workflow_artifact_obligations o SET
       status=CASE WHEN $3 THEN 'released' ELSE 'releasing' END,
       released_at=COALESCE(released_at,now()),
       cleanup_confirmed_at=CASE WHEN $3 THEN COALESCE(cleanup_confirmed_at,now())
         ELSE cleanup_confirmed_at END
     FROM execution.workflow_artifact_manifests m
     WHERE o.obligation_id=$1 AND o.manifest_id=m.id AND m.assignment_id=$2
       AND o.status IN ('active','releasing')
     RETURNING o.manifest_id,o.artifact_id`,
    [input.obligationId, input.assignmentId, input.cleanupConfirmed],
  );
  for (const row of result.rows) {
    await client.query(
      `UPDATE execution.workflow_artifact_locations SET state='revoked',updated_at=now()
       WHERE manifest_id=$1 AND artifact_id=$2 AND retention_obligation_id=$3
         AND kind='member' AND member_id=source_member_id AND state='available'`,
      [row.manifest_id, row.artifact_id, input.obligationId],
    );
    await client.query(
      `UPDATE execution.workflow_artifact_manifests m SET status='unavailable',
       error='Artifact retention ended and no verified copy remains.',updated_at=now()
       WHERE m.id=$1 AND m.status='accepted'
         AND NOT EXISTS (SELECT 1 FROM execution.workflow_artifact_locations l
           WHERE l.manifest_id=m.id AND l.artifact_id=$2 AND l.state='available'
             AND (l.durable_until IS NULL OR l.durable_until>now()))`,
      [row.manifest_id, row.artifact_id],
    );
  }
  return Number(result.rowCount ?? 0) > 0;
}
