import {
  RoomStorageHybridAdapter,
  HYBRID_SCHEMA,
  type HybridPreparation,
} from "./room-storage-hybrid.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  BeamClient,
  S3CompatibleProviderConfig,
  prepareProviderSource,
  type ProviderDestinationConfig,
  type ProviderMultipartGroupIdentity,
  type ProviderSourceConfig,
  type TransferPrepareResponse,
} from "@beam-network/sdk";
import {
  normalizeCredentialPayloadAliases,
  resolveProviderProfileEndpointUrl,
  resolveProviderProfileForcePathStyle,
  resolveProviderProfileRegion,
} from "@beam-studio/shared";
import {
  isPostgresUnavailableError,
  WorkflowAuthorityUnavailableError,
  withPostgresTransaction,
  workflowRunAuthorityGenerationPg,
  type PgPool,
} from "@beam-studio/db";
import { vaultSecretFromEnv } from "@beam-studio/vault";
import { CredentialRepository } from "../studio/repositories/credential-repository.js";
import { organizationScope } from "../studio/repositories/organization-scope.js";
import type { FastifyInstance } from "fastify";
import type { AgentControlRepository } from "./repository.js";
import type { AgentGateway } from "./gateway.js";
import { resolveBeamEnvironmentTemplate } from "../studio/store.js";
import {
  getDecryptedApiKey,
  listRoomStorageBindings,
  listRoomStorageBindingsAcrossTemplates,
} from "../studio/store.js";
import { storageObjectExists } from "../studio/storage-browser.js";
import { resolveRoomWorkflowRecipients } from "./room-workflow-options.js";
import { roomServiceForOrganization } from "./room-service.js";
import { resolveRoomStorageApiKeyId } from "./room-storage-api-key.js";
import { webEnv } from "../env.js";
import { standardRoomBindingInput } from "./room-standard-binding.js";
import { abortRoomMultipartUpload } from "./room-multipart-cleanup.js";
import { verifiedRoomDeliveryStatus } from "./room-delivery-evidence.js";
import {
  artifactCopyCommandSource,
  artifactCopyOriginKey,
  assertArtifactCopyInspection,
  parseArtifactCopySourceLocator,
  type ArtifactCopySourceLocator,
} from "./room-artifact-copy-source.js";

type Row = Record<string, any>;
type Logger = {
  info(payload: unknown, message: string): void;
  warn(payload: unknown, message: string): void;
};
type StorageBinding = Awaited<
  ReturnType<typeof listRoomStorageBindings>
>[number];
type ArtifactCopyPublication = {
  organizationId: string;
  environmentTemplateKey: string;
  roomId: string;
  channelId: string;
  workflowRunId: string;
  workflowStepRunId: string;
  roomApiKeyId: string;
  sourceMemberId: string;
  sourceAgentId: string;
  targetMemberIds: string[];
  assignmentId: string;
  attempt: number;
  port: string;
  index: number;
  artifactId: string;
  copyId: string;
  sha256: string;
  sizeBytes: number;
  retentionObligationId: string;
  requiredUntil: string;
  recoveryGeneration: number;
  roomSnapshot: Record<string, unknown>;
};
type RoomStorageFileLayout = {
  size_bytes: number;
  chunk_size_bytes: number;
  chunk_count: number;
  identity: string;
};
type FrozenSourceIdentity = {
  identity: string;
  object: {
    size_bytes: number;
    etag?: string;
    version_id?: string;
    last_modified?: string;
  };
};
type PreparedTarget = {
  memberId: string;
  childId: string;
  destinationId: string;
  config: ProviderDestinationConfig;
  bindingId?: string;
  finalObjectKey?: string;
};

class RoomStorageAgentCommandError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(roomStorageSafeErrorMessage({ code, message }));
    this.name = "RoomStorageAgentCommandError";
    this.code =
      normalizedErrorCode(code) || "room_storage_agent_command_failed";
    this.retryable = retryable;
  }
}

const activeStatuses = ["queued", "preparing", "running", "cancel_requested"];
const maxOpenTransfersPerOrganization = 512;
const maxOpenTransfersPerRun = 128;

/** Reclaim failed cleanup only when its owning workflow has already been cancelled. */
export async function claimRoomStorageTransferJobs(
  pool: PgPool,
  owner: string,
) {
  await pool.query(
    `UPDATE studio.room_storage_transfer_jobs
     SET status='failed',error_code='room_storage_admission_deadline',
       error_message='Transfer admission deadline exceeded.',
       provider_cleanup_confirmed_at=now(),updated_at=now()
     WHERE status='queued' AND admission_deadline_at<=clock_timestamp()`,
  );
  await pool.query(
    `UPDATE studio.room_storage_transfer_jobs j
     SET status=CASE WHEN j.status='queued' THEN 'cancelled' ELSE 'cancel_requested' END,
       error_code='executor_authority_superseded',
       error_message='Transfer belongs to a superseded orchestration authority.',
       provider_cleanup_confirmed_at=CASE WHEN j.status='queued' THEN now()
         ELSE j.provider_cleanup_confirmed_at END,updated_at=now()
     FROM execution.workflow_run_authority authority
     WHERE j.workflow_run_id=authority.workflow_run_id
       AND j.authority_generation IS NOT NULL
       AND j.authority_generation<>authority.generation
       AND j.status IN ('queued','preparing','running')`,
  );
  return pool.query<Row>(
    `UPDATE studio.room_storage_transfer_jobs j
     SET lease_owner=$1, lease_expires_at=now()+interval '45 seconds',
         status=CASE WHEN status='queued' THEN 'preparing' WHEN status='failed' THEN 'cancel_requested' ELSE status END,
         updated_at=now()
     WHERE j.id IN (
       SELECT candidate.id FROM studio.room_storage_transfer_jobs candidate
       WHERE (candidate.status=ANY($2::text[]) OR
         (candidate.status='failed' AND EXISTS (
           SELECT 1 FROM execution.workflow_runs r
           WHERE r.id=candidate.workflow_run_id AND r.organization_id=candidate.organization_id AND r.status='cancelled'
         ))) AND (candidate.lease_expires_at IS NULL OR candidate.lease_expires_at < now())
       ORDER BY candidate.created_at FOR UPDATE OF candidate SKIP LOCKED LIMIT 4
     ) RETURNING *`,
    [owner, activeStatuses],
  );
}
const ROOM_STORAGE_ROUTE_EXPIRY_FLOOR_SECONDS = 900;
const ROOM_STORAGE_ROUTE_EXPIRY_MARGIN_SECONDS = 300;

export function roomStorageProviderRouteTtlSeconds(transferTtlSeconds: number) {
  const transferTtl = Math.max(1, Math.ceil(transferTtlSeconds));
  return Math.max(
    ROOM_STORAGE_ROUTE_EXPIRY_FLOOR_SECONDS,
    transferTtl + ROOM_STORAGE_ROUTE_EXPIRY_MARGIN_SECONDS,
  );
}

export class RoomStorageTransferManager {
  private readonly owner = `room_storage_${randomUUID()}`;
  private readonly active = new Set<string>();
  private readonly ownerships = new Map<string, AbortController>();
  private stopped = false;
  private readonly hybrid: RoomStorageHybridAdapter;
  private artifactCopyAuthorization?: (
    job: {
      organizationId: string;
      roomId: string;
      channelId: string;
      sourceMemberId: string;
      targetMemberIds: string[];
      workflowRunId: string;
      workflowStepRunId: string;
    },
    locator: ArtifactCopySourceLocator,
  ) => Promise<void>;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly pool: PgPool,
    private readonly repository: AgentControlRepository,
    private readonly gateway: AgentGateway,
    private readonly logger: Logger,
  ) {
    this.hybrid = new RoomStorageHybridAdapter(pool, {
      load: async (publicationId) => {
        const result = await this.pool.query<Row>(
          "SELECT * FROM studio.room_storage_transfer_jobs WHERE publication_id=$1 AND status=ANY($2::text[])",
          [publicationId, activeStatuses],
        );
        if (!result.rows[0]) return null;
        const job = storageJob(result.rows[0]);
        const template = await resolveBeamEnvironmentTemplate({
          organizationId: job.organizationId,
          templateKey: job.environmentTemplateKey,
        });
        return {
          job,
          coordinator: await roomServiceForOrganization(job.organizationId, template, job.apiKeyId),
          bindings: await listRoomStorageBindings(
            job.organizationId,
            job.environmentTemplateKey,
            job.roomId,
          ),
        };
      },
      provider: (organizationId, binding, key) =>
        providerConfig(this.pool, organizationId, binding, key),
      destination: async (job, binding, filename) => {
        const objectKey = destinationObjectKey(
          binding,
          job.roomId,
          job.publicationId,
          sourceRelativePath(job.sourceLocator, filename),
        );
        if (
          binding.collisionPolicy === "fail_if_exists" &&
          (await storageObjectExists({
            pool: this.pool,
            organizationId: job.organizationId,
            credentialId: binding.credentialId,
            bucket: binding.bucket,
            prefix: objectKey,
          }))
        )
          throw new Error("room_storage_destination_exists");
        return {
          objectKey,
          config: await providerConfig(
            this.pool,
            job.organizationId,
            binding,
            objectKey,
          ),
        };
      },
      command: async (job, agentId, operation, payload, idempotencyKey) => {
        await this.requireArtifactCopyAuthorization(job);
        return this.runAgentCommandForOrganization(
          job.organizationId,
          job.ttlSeconds,
          agentId,
          operation,
          payload,
          idempotencyKey,
        );
      },
      authorize: (job) => this.requireArtifactCopyAuthorization(job),
      currentStatus: (job) => this.currentStatus(job),
      recordFailure: async (job, error) => {
        const result = await this.pool.query(
          `UPDATE studio.room_storage_transfer_jobs SET error_code=$2,error_message=$3,updated_at=now()
           WHERE id=$1 AND lease_owner=$4 AND lease_expires_at>now() RETURNING id`,
          [
            job.id,
            safeErrorCode(error),
            safeErrorMessage(error),
            job.leaseOwner,
          ],
        );
        if (result.rowCount !== 1)
          throw new Error("room_storage_job_lease_lost");
      },
      publicUrl: roomStorageWorkerRouteBaseUrl,
    });
  }

  setArtifactCopyAuthorization(
    authorize: NonNullable<
      RoomStorageTransferManager["artifactCopyAuthorization"]
    >,
  ) {
    this.artifactCopyAuthorization = authorize;
  }

  private async requireArtifactCopyAuthorization(job: {
    organizationId: string;
    roomId: string;
    channelId: string;
    sourceMemberId: string;
    targetMemberIds: string[];
    workflowRunId: string;
    workflowStepRunId: string;
    sourceLocator: Row;
  }) {
    if (job.sourceLocator.type !== "artifact_copy") return;
    if (!this.artifactCopyAuthorization)
      throw new Error("room_storage_artifact_authority_unavailable");
    await this.artifactCopyAuthorization(
      job,
      parseArtifactCopySourceLocator(job.sourceLocator),
    );
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.scanSoon(), 2_000);
    this.timer.unref();
    this.scanSoon();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const ownership of this.ownerships.values()) {
      ownership.abort(new Error("room_storage_job_lease_lost"));
    }
  }

  registerRoutes(server: FastifyInstance) {
    this.hybrid.registerRoutes(server);
  }
  async enqueue(input: {
    organizationId: string;
    environmentTemplateKey: string;
    roomId: string;
    channelId: string;
    workflowRunId: string;
    workflowStepRunId: string;
    apiKeyId: string;
    sourceMemberId: string;
    sourceLocator: Record<string, unknown>;
    targetMemberIds: string[];
    ttlSeconds: number;
    allowPartial: boolean;
  }) {
    const originKey = `workflow:${input.workflowStepRunId}`;
    return this.enqueueJob({
      ...input,
      publicationId: null,
      originKind: "workflow",
      originKey,
      initiatorAgentId: null,
      initiatorMemberId: null,
    });
  }

  /** An action output may start storage transfer before its result manifest is
   * persisted. The assignment/port/index key fixes its first claimed identity. */
  async enqueueArtifactCopy(input: ArtifactCopyPublication) {
    const sourceLocator: ArtifactCopySourceLocator = {
      type: "artifact_copy",
      assignmentId: input.assignmentId,
      attempt: input.attempt,
      port: input.port,
      index: input.index,
      artifactId: input.artifactId,
      copyId: input.copyId,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      retentionObligationId: input.retentionObligationId,
      requiredUntil: input.requiredUntil,
      storageMemberIds: [],
    };
    const originKey = artifactCopyOriginKey(input);
    const ttlSeconds = Math.min(
      900,
      Math.floor((Date.parse(input.requiredUntil) - Date.now()) / 1000),
    );
    const jobInput = {
      organizationId: input.organizationId,
      environmentTemplateKey: input.environmentTemplateKey,
      roomId: input.roomId,
      channelId: input.channelId,
      workflowRunId: input.workflowRunId,
      workflowStepRunId: input.workflowStepRunId,
      apiKeyId: "",
      sourceMemberId: input.sourceMemberId,
      sourceLocator,
      targetMemberIds: input.targetMemberIds,
      ttlSeconds,
      allowPartial: false,
      publicationId: null,
      originKind: "workflow" as const,
      originKey,
      initiatorAgentId: null,
      initiatorMemberId: null,
      assignmentFence: {
        assignmentId: input.assignmentId,
        attempt: input.attempt,
        agentId: input.sourceAgentId,
      },
    };
    const previous = await this.pool.query<Row>(
      `SELECT * FROM studio.room_storage_transfer_jobs
       WHERE organization_id=$1 AND origin_key=$2`,
      [input.organizationId, originKey],
    );
    if (previous.rows[0]) {
      jobInput.ttlSeconds = Number(previous.rows[0].ttl_seconds);
      sourceLocator.storageMemberIds = parseArtifactCopySourceLocator(
        previous.rows[0].source_locator_json,
      ).storageMemberIds;
      if (
        text(previous.rows[0].request_hash) !== roomStorageRequestHash(jobInput)
      )
        throw requestError(
          "room_storage_idempotency_conflict",
          "The artifact port and attempt already name another copy.",
          409,
        );
      return this.artifactCopyResult(storageJob(previous.rows[0]));
    }
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 15)
      throw requestError(
        "room_storage_artifact_retention_expiring",
        "The frozen retention deadline cannot cover another transfer.",
        409,
      );
    if (input.recoveryGeneration > 0) {
      const priorKey = artifactCopyOriginKey({
        ...input,
        recoveryGeneration: input.recoveryGeneration - 1,
      });
      const prior = await this.pool.query<Row>(
        `SELECT status,error_code,source_locator_json FROM studio.room_storage_transfer_jobs
         WHERE organization_id=$1 AND origin_key=$2`,
        [input.organizationId, priorKey],
      );
      const old = prior.rows[0];
      if (
        !old ||
        !["partial", "failed", "cancelled"].includes(text(old.status)) ||
        text(old.error_code) === "room_storage_cleanup_incomplete" ||
        object(old.source_locator_json).artifactId !== input.artifactId ||
        object(old.source_locator_json).sha256 !== input.sha256
      )
        throw requestError(
          "room_storage_recovery_not_allowed",
          "The previous artifact transfer is not safely terminal.",
          409,
        );
    }
    const artifactTemplate = await resolveBeamEnvironmentTemplate({
      organizationId: input.organizationId,
      templateKey: input.environmentTemplateKey,
    });
    const apiKeyId = await resolveRoomStorageApiKeyId({
      organizationId: input.organizationId,
      roomApiKeyId: input.roomApiKeyId,
      apiUrl: artifactTemplate.apiUrl,
    });
    if (!apiKeyId)
      throw requestError(
        "beam_api_key_unavailable",
        "The room billing API key is unavailable.",
        409,
      );
    jobInput.apiKeyId = apiKeyId;
    const memberships = records(input.roomSnapshot.memberships);
    const source = memberships.find(
      (member) => text(member.member_id) === input.sourceMemberId,
    );
    const targets = input.targetMemberIds.map((memberId) =>
      memberships.find((member) => text(member.member_id) === memberId),
    );
    const bindings = await listRoomStorageBindings(
      input.organizationId,
      input.environmentTemplateKey,
      input.roomId,
    );
    if (
      !source ||
      text(source.state) !== "active" ||
      text(source.kind) !== "agent" ||
      text(source.agent_id) !== input.sourceAgentId ||
      !targets.length ||
      new Set(input.targetMemberIds).size !== input.targetMemberIds.length ||
      targets.some((target) => !target || text(target.state) !== "active") ||
      !targets.some(
        (target) =>
          text(target?.kind) === "object_storage" &&
          bindings.some(
            (binding) => binding.coordinatorMemberId === target?.member_id,
          ),
      ) ||
      targets.some(
        (target) =>
          text(target?.kind) === "object_storage" &&
          !bindings.some(
            (binding) => binding.coordinatorMemberId === target?.member_id,
          ),
      )
    )
      throw requestError(
        "room_storage_artifact_destination_unavailable",
        "The frozen artifact route has no available storage destination.",
        409,
      );
    sourceLocator.storageMemberIds = targets
      .filter((target) => text(target?.kind) === "object_storage")
      .map((target) => text(target?.member_id));
    await this.requireArtifactCopyAuthorization(jobInput);
    const inspection = await this.runAgentCommandForOrganization(
      input.organizationId,
      ttlSeconds,
      input.sourceAgentId,
      "room.storage.source.inspect",
      { artifact_copy: artifactCopyCommandSource(sourceLocator) },
      `room-storage:${originKey}:inspect`,
    );
    assertArtifactCopyInspection(sourceLocator, inspection);
    const job = await this.enqueueJob(jobInput);
    return this.artifactCopyResult(job);
  }

  private async artifactCopyResult(job: ReturnType<typeof storageJob>) {
    const storageMemberIds = parseArtifactCopySourceLocator(
      job.sourceLocator,
    ).storageMemberIds;
    const result = {
      publicationId: job.publicationId,
      status: job.status,
      transferId: job.transferId ?? undefined,
      targetMemberIds: job.targetMemberIds,
      storageMemberIds,
      fullDeliveryVerified: false,
      verifiedAt: undefined as string | undefined,
      deliveries: [] as Array<{
        memberId: string;
        state: "delivered";
        verificationBasis: "recipient_final_receipt" | "provider_finalization";
        verifiedAt: string;
        recipientKind: "member" | "storage";
      }>,
    };
    if (job.status !== "completed") return result;
    const incompleteEvidence = async () => {
      if (Date.now() < Date.parse(job.updatedAt) + 60_000)
        return { ...result, status: "running", transferId: undefined };
      await this.pool.query(
        `UPDATE studio.room_storage_transfer_jobs
         SET status='failed',error_code='room_storage_delivery_evidence_mismatch',
           error_message='Core delivery evidence remained unavailable after completion.',
           provider_cleanup_confirmed_at=NULL,
           updated_at=now() WHERE id=$1 AND status='completed'`,
        [job.id],
      );
      return {
        ...result,
        status: "failed",
        transferId: undefined,
        errorCode: "room_storage_delivery_evidence_mismatch",
      };
    };
    let response: Row;
    try {
      const template = await resolveBeamEnvironmentTemplate({
        organizationId: job.organizationId,
        templateKey: job.environmentTemplateKey,
      });
      const coordinator = await roomServiceForOrganization(job.organizationId, template, job.apiKeyId);
      response = await coordinator.client.organizationObjectStatus(
        job.organizationId,
        job.roomId,
        job.channelId,
        job.publicationId,
        coordinator.token,
      );
    } catch {
      return incompleteEvidence();
    }
    const status = verifiedRoomDeliveryStatus(response.status as Row);
    const publisher = object(object(status).publisher);
    const transfer = object(publisher.room_transfer);
    if (
      text(transfer?.status) !== "completed" ||
      transfer?.full_delivery_verified !== true ||
      !text(transfer?.transfer_id)
    )
      return incompleteEvidence();
    const receipts = records(publisher.deliveries);
    const storage = new Set(storageMemberIds);
    if (
      receipts.length !== job.targetMemberIds.length ||
      job.targetMemberIds.some(
        (memberId) =>
          receipts.filter((receipt) => text(receipt.member_id) === memberId)
            .length !== 1,
      ) ||
      receipts.some(
        (receipt) =>
          receipt.state !== "delivered" ||
          !Number.isFinite(Date.parse(text(receipt.verified_at))) ||
          receipt.verification_basis !==
            (storage.has(text(receipt.member_id))
              ? "provider_finalization"
              : "recipient_final_receipt"),
      )
    )
      return incompleteEvidence();
    const deliveries = receipts.map((receipt) => ({
      memberId: text(receipt.member_id),
      state: "delivered" as const,
      verificationBasis: receipt.verification_basis as
        | "recipient_final_receipt"
        | "provider_finalization",
      verifiedAt: text(receipt.verified_at),
      recipientKind: storage.has(text(receipt.member_id))
        ? ("storage" as const)
        : ("member" as const),
    }));
    return {
      ...result,
      transferId: text(transfer.transfer_id),
      fullDeliveryVerified: true,
      verifiedAt: deliveries.reduce(
        (latest, receipt) =>
          Date.parse(receipt.verifiedAt) > Date.parse(latest)
            ? receipt.verifiedAt
            : latest,
        deliveries[0]!.verifiedAt,
      ),
      deliveries,
    };
  }

  /** Cleanup covers every bounded generation claimed by this output slot. */
  async cancelArtifactCopies(input: {
    organizationId: string;
    assignmentId: string;
    attempt: number;
    port: string;
    index: number;
    artifactId: string;
  }) {
    const keys = Array.from({ length: 9 }, (_, recoveryGeneration) =>
      artifactCopyOriginKey({ ...input, recoveryGeneration }),
    );
    const rows = await this.pool.query<Row>(
      `SELECT * FROM studio.room_storage_transfer_jobs
       WHERE organization_id=$1 AND origin_key=ANY($2::text[])`,
      [input.organizationId, keys],
    );
    for (const row of rows.rows) {
      const job = storageJob(row);
      const copy = parseArtifactCopySourceLocator(job.sourceLocator);
      if (
        copy.assignmentId !== input.assignmentId ||
        copy.attempt !== input.attempt ||
        copy.artifactId !== input.artifactId
      )
        throw requestError(
          "room_storage_artifact_identity_conflict",
          "The output slot names a different artifact.",
          409,
        );
    }
    for (const row of rows.rows) {
      const job = storageJob(row);
      if (
        ["completed", "partial", "cancelled", "failed"].includes(job.status) &&
        job.errorCode !== "room_storage_cleanup_incomplete"
      )
        continue;
      await this.requestCancelById(job.id);
      await this.waitForCancellation(job.id);
    }
    return { publicationCancellationConfirmed: true };
  }

  /** Studio owns transport cleanup even if the agent has restarted and lost
   * its assignment bearer. Retained completed objects are not deleted. */
  async cancelArtifactCopiesByAssignment(
    assignmentId: string,
    attempt: number,
  ) {
    const rows = await this.pool.query<Row>(
      `SELECT id,status,provider_cleanup_confirmed_at FROM studio.room_storage_transfer_jobs
       WHERE source_locator_json->>'type'='artifact_copy'
         AND source_locator_json->>'assignmentId'=$1
         AND source_locator_json->>'attempt'=$2`,
      [assignmentId, String(attempt)],
    );
    for (const row of rows.rows) {
      if (row.provider_cleanup_confirmed_at) continue;
      await this.requestCancelById(text(row.id));
    }
    return rows.rows.map((row) => text(row.id));
  }

  async waitForArtifactCopiesCancellation(
    assignmentId: string,
    attempt: number,
  ) {
    let completedDelivery = false;
    const ids = await this.cancelArtifactCopiesByAssignment(
      assignmentId,
      attempt,
    );
    for (const id of ids) {
      const result = await this.pool.query<Row>(
        "SELECT status,provider_cleanup_confirmed_at FROM studio.room_storage_transfer_jobs WHERE id=$1",
        [id],
      );
      const row = result.rows[0];
      if (!row?.provider_cleanup_confirmed_at)
        await this.waitForCancellation(id);
      const final = row?.provider_cleanup_confirmed_at
        ? row
        : (
            await this.pool.query<Row>(
              "SELECT status,provider_cleanup_confirmed_at FROM studio.room_storage_transfer_jobs WHERE id=$1",
              [id],
            )
          ).rows[0];
      if (!final?.provider_cleanup_confirmed_at)
        throw new Error("room_storage_cleanup_unconfirmed");
      completedDelivery ||= ["completed", "partial"].includes(
        text(final.status),
      );
    }
    return { completedDelivery };
  }

  /** Confirm only persisted terminal provider cleanup. The organization lock
   * serializes this absence check with job creation, and the fenced assignment
   * prevents a later request from creating a job after a no-job confirmation. */
  async hybridTransferConfirmationsForAssignment(
    input: {
      organizationId: string;
      assignmentId: string;
      attempt: number;
    },
    reportedTransfers: unknown,
  ) {
    if (!Array.isArray(reportedTransfers)) return [];
    const candidates = await this.pool.query<Row>(
      `SELECT * FROM studio.room_storage_transfer_jobs
       WHERE organization_id=$1 AND
         (assignment_id=$2 OR
          (source_locator_json->>'type'='artifact_copy' AND
           source_locator_json->>'assignmentId'=$2 AND
           source_locator_json->>'attempt'=$3))`,
      [input.organizationId, input.assignmentId, String(input.attempt)],
    );
    const verifiedCompleted = new Set<string>();
    for (const candidate of candidates.rows) {
      if (
        candidate.status !== "completed" ||
        !candidate.provider_cleanup_confirmed_at ||
        !candidate.transfer_id
      )
        continue;
      const proof = await this.artifactCopyResult(storageJob(candidate)).catch(
        () => null,
      );
      if (
        proof?.status === "completed" &&
        proof.fullDeliveryVerified === true &&
        proof.transferId === candidate.transfer_id
      )
        verifiedCompleted.add(String(candidate.id));
    }
    return withPostgresTransaction(this.pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`workflow-transfer:${input.organizationId}`],
      );
      const fence = await client.query<Row>(
        `SELECT a.state,a.cancel_requested_at,a.authority_generation,
          authority.generation AS current_authority_generation
         FROM execution.executor_assignments a
         JOIN execution.workflow_run_authority authority
           ON authority.workflow_run_id=a.workflow_run_id
         WHERE a.id=$1 AND a.organization_id=$2 AND a.attempt=$3
         FOR UPDATE OF a`,
        [input.assignmentId, input.organizationId, input.attempt],
      );
      const assignment = fence.rows[0];
      if (
        !assignment ||
        (!assignment.cancel_requested_at &&
          ["assigned", "dispatching", "running"].includes(
            text(assignment.state),
          ) &&
          String(assignment.authority_generation) ===
            String(assignment.current_authority_generation))
      )
        return [];
      const jobs = await client.query<Row>(
        `SELECT id,origin_key,publication_id,transfer_id,status,error_code,
          source_locator_json,provider_cleanup_confirmed_at
         FROM studio.room_storage_transfer_jobs
         WHERE organization_id=$1 AND
           (assignment_id=$2 OR
            (source_locator_json->>'type'='artifact_copy' AND
             source_locator_json->>'assignmentId'=$2 AND
             source_locator_json->>'attempt'=$3))`,
        [input.organizationId, input.assignmentId, String(input.attempt)],
      );
      const prefix = `artifact:${input.assignmentId}:${input.attempt}:`;
      const confirmations: Array<{
        artifactId: string;
        recoveryGeneration: number;
        publicationId: string;
        transferId: string;
        state: string;
        cleanupConfirmed: true;
        fullDeliveryVerified?: true;
      }> = [];
      for (const receipt of reportedTransfers) {
        if (
          !receipt ||
          typeof receipt !== "object" ||
          receipt.transport !== "hybrid" ||
          typeof receipt.artifactId !== "string" ||
          !receipt.artifactId ||
          !Number.isSafeInteger(receipt.recoveryGeneration) ||
          receipt.recoveryGeneration < 0 ||
          receipt.recoveryGeneration > 8 ||
          typeof receipt.publicationId !== "string" ||
          typeof receipt.transferId !== "string"
        )
          continue;
        const job = jobs.rows.find(
          (row) =>
            String(row.origin_key).startsWith(prefix) &&
            Number(String(row.origin_key).split(":").at(-1)) ===
              receipt.recoveryGeneration &&
            row.source_locator_json?.artifactId === receipt.artifactId,
        );
        if (!job) {
          if (receipt.publicationId || receipt.transferId) continue;
          confirmations.push({
            artifactId: receipt.artifactId,
            recoveryGeneration: receipt.recoveryGeneration,
            publicationId: "",
            transferId: "",
            state: "cancelled",
            cleanupConfirmed: true,
          });
          continue;
        }
        if (
          !job.provider_cleanup_confirmed_at ||
          job.error_code === "room_storage_delivery_evidence_mismatch" ||
          !["completed", "partial", "failed", "cancelled"].includes(
            text(job.status),
          ) ||
          (job.status === "completed" &&
            !verifiedCompleted.has(String(job.id))) ||
          (receipt.publicationId &&
            receipt.publicationId !== job.publication_id) ||
          (receipt.transferId && receipt.transferId !== text(job.transfer_id))
        )
          continue;
        confirmations.push({
          artifactId: receipt.artifactId,
          recoveryGeneration: receipt.recoveryGeneration,
          publicationId: text(job.publication_id),
          transferId: text(job.transfer_id),
          state: text(job.status),
          cleanupConfirmed: true,
          ...(job.status === "completed"
            ? { fullDeliveryVerified: true as const }
            : {}),
        });
      }
      return confirmations;
    });
  }

  async handleAgentRequest(
    agentId: string,
    request: {
      operation: "publish" | "status" | "cancel";
      roomId: string;
      channelId: string;
      publicationId?: string;
      sourceMemberId?: string;
      sourceLocator?: Record<string, unknown>;
      targetMemberIds?: string[];
      ttlSeconds?: number;
      allowPartial?: boolean;
      idempotencyKey: string;
    },
  ) {
    const agent = await this.repository.getAgentById(agentId);
    if (!agent || agent.status !== "online") {
      throw requestError(
        "room_storage_agent_offline",
        "The enrolled Studio agent is offline.",
        409,
      );
    }
    if (request.operation === "status") {
      return {
        publicationId: request.publicationId,
        status: await this.agentPublicationStatus(
          agent.organizationId,
          agentId,
          request.publicationId!,
        ),
      };
    }
    if (request.operation === "cancel") {
      const job = await this.agentPublicationJob(
        agent.organizationId,
        agentId,
        request.publicationId!,
      );
      await this.requestCancelById(job.id);
      await this.waitForCancellation(job.id);
      return {
        publicationId: job.publicationId,
        status: await this.coordinatorPublicationStatus(job),
      };
    }
    const bindings = await listRoomStorageBindingsAcrossTemplates(
      agent.organizationId,
      request.roomId,
    );
    if (!bindings.length) {
      throw requestError(
        "room_storage_binding_unavailable",
        "The room has no available object-storage member binding.",
        409,
      );
    }
    const templateKeys = [
      ...new Set(bindings.map((binding) => binding.environmentTemplateKey)),
    ];
    if (templateKeys.length !== 1) {
      throw requestError(
        "room_storage_template_ambiguous",
        "The room storage binding does not resolve to one Beam environment.",
        409,
      );
    }
    const templateKey = templateKeys[0]!;
    const template = await resolveBeamEnvironmentTemplate({
      organizationId: agent.organizationId,
      templateKey,
    });
    const coordinator = await roomServiceForOrganization(agent.organizationId, template);
    const snapshot = await coordinator.client.organizationRoomSnapshot(
      agent.organizationId,
      request.roomId,
      coordinator.token,
    );
    const authorization = authorizeAgentStoragePublication({
      agentId,
      roomId: request.roomId,
      channelId: request.channelId,
      sourceMemberId: request.sourceMemberId!,
      snapshot,
      bindings,
    });
    const roomApiKeyId = text(object(snapshot.room).api_key_id);
    const apiKeyId = roomApiKeyId
      ? await resolveRoomStorageApiKeyId({
          organizationId: agent.organizationId,
          roomApiKeyId,
          apiUrl: template.apiUrl,
        })
      : null;
    if (!apiKeyId) {
      throw requestError(
        "beam_api_key_unavailable",
        "The room billing API key is not available in this Studio organization.",
        409,
      );
    }
    const originKey = `agent:${agentId}:${request.idempotencyKey}`;
    const job = await this.enqueueJob({
      organizationId: agent.organizationId,
      environmentTemplateKey: templateKey,
      roomId: request.roomId,
      channelId: request.channelId,
      workflowRunId: null,
      workflowStepRunId: null,
      apiKeyId,
      sourceMemberId: request.sourceMemberId!,
      sourceLocator: request.sourceLocator!,
      targetMemberIds: request.targetMemberIds ?? [],
      ttlSeconds: request.ttlSeconds ?? 300,
      allowPartial: request.allowPartial ?? false,
      publicationId: null,
      originKind: "agent",
      originKey,
      initiatorAgentId: agentId,
      initiatorMemberId: authorization.initiatorMemberId,
    });
    return {
      publicationId: job.publicationId,
      status: storageJobStatus(job),
    };
  }

  private async enqueueJob(input: {
    organizationId: string;
    environmentTemplateKey: string;
    roomId: string;
    channelId: string;
    workflowRunId: string | null;
    workflowStepRunId: string | null;
    apiKeyId: string;
    sourceMemberId: string;
    sourceLocator: Record<string, unknown>;
    targetMemberIds: string[];
    ttlSeconds: number;
    allowPartial: boolean;
    publicationId?: string | null;
    originKind: "workflow" | "agent";
    originKey: string;
    initiatorAgentId: string | null;
    initiatorMemberId: string | null;
    assignmentFence?: {
      assignmentId: string;
      attempt: number;
      agentId: string;
    };
  }) {
    const publicationId = input.publicationId || roomPublicationId();
    const id = `rstj_${randomBytes(16).toString("hex")}`;
    const requestHash = roomStorageRequestHash(input);
    const result = await withPostgresTransaction(this.pool, async (client) => {
      if (input.workflowRunId) {
        const run = await client.query(
          `SELECT id FROM execution.workflow_runs
           WHERE id=$1 AND organization_id=$2 FOR UPDATE`,
          [input.workflowRunId, input.organizationId],
        );
        if (!run.rows[0])
          throw requestError(
            "room_storage_workflow_unavailable",
            "The workflow run is unavailable for this transfer.",
            404,
          );
      }
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`workflow-transfer:${input.organizationId}`],
      );
      const existing = await client.query<Row>(
        `SELECT * FROM studio.room_storage_transfer_jobs
         WHERE organization_id=$1 AND origin_key=$2`,
        [input.organizationId, input.originKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash)
          throw requestError(
            "room_storage_idempotency_conflict",
            "The room storage idempotency key was reused with another request.",
            409,
          );
        return existing;
      }
      {
        const open = await client.query<Row>(
          `SELECT COUNT(*)::int AS organization_count,
            COUNT(*) FILTER (WHERE workflow_run_id=$2)::int AS run_count
           FROM studio.room_storage_transfer_jobs
           WHERE organization_id=$1 AND status=ANY($3::text[])`,
          [input.organizationId, input.workflowRunId, activeStatuses],
        );
        if (
          Number(open.rows[0]?.organization_count ?? 0) >=
            maxOpenTransfersPerOrganization ||
          (input.workflowRunId !== null &&
            Number(open.rows[0]?.run_count ?? 0) >= maxOpenTransfersPerRun)
        )
          throw requestError(
            "room_storage_admission_full",
            "Transfer admission is full; retry this request after capacity is released.",
            429,
          );
      }
      const authorityGeneration = input.workflowRunId
        ? await workflowRunAuthorityGenerationPg(client, input.workflowRunId)
        : null;
      if (input.workflowRunId && authorityGeneration === null)
        throw requestError(
          "executor_authority_unavailable",
          "Workflow authority is unavailable for this transfer.",
          503,
        );
      return client.query<Row>(
        `INSERT INTO studio.room_storage_transfer_jobs (
        id, organization_id, environment_template_key, room_id, channel_id,
        publication_id, origin_kind, origin_key, request_hash, workflow_run_id, workflow_step_run_id,
        initiator_agent_id, initiator_member_id, api_key_id,
        source_member_id, source_locator_json, target_member_ids_json,
        ttl_seconds, allow_partial, status, admission_deadline_at,
        assignment_id, assignment_attempt, authority_generation
      ) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19,'queued',
        now()+interval '1 hour',$20,$21,$23
      WHERE ($10::text IS NULL OR EXISTS (
        SELECT 1 FROM execution.workflow_run_authority current_authority
        WHERE current_authority.workflow_run_id=$10
          AND current_authority.generation=$23
          AND current_authority.lease_expires_at>clock_timestamp()
      )) AND ($20::text IS NULL OR EXISTS (
        SELECT 1 FROM execution.executor_assignments a
        JOIN execution.workflow_tasks t ON t.id=a.task_id
        JOIN execution.workflow_runs r ON r.id=t.workflow_run_id
        JOIN execution.workflow_run_authority authority ON authority.workflow_run_id=r.id
        JOIN agent_control.agents agent ON agent.id=a.executor_id
        WHERE a.id=$20 AND a.attempt=$21 AND a.executor_id=$22
          AND a.member_id=$15 AND a.workflow_run_id=$10
          AND t.workflow_step_run_id=$11 AND t.attempt_count=a.attempt
          AND t.leased_by=a.executor_id AND t.status='running'
          AND r.organization_id=$2 AND r.status IN ('queued','running')
          AND a.state IN ('assigned','dispatching','running')
          AND a.cancel_requested_at IS NULL
          AND a.lease_expires_at>clock_timestamp()
          AND a.authority_generation=$23 AND authority.generation=$23
          AND authority.lease_expires_at>clock_timestamp()
          AND a.session_generation=agent.session_generation
          AND agent.revoked_at IS NULL))
      ON CONFLICT (organization_id, origin_key) DO UPDATE SET updated_at=now()
      WHERE studio.room_storage_transfer_jobs.request_hash=EXCLUDED.request_hash
      RETURNING *`,
        [
          id,
          input.organizationId,
          input.environmentTemplateKey,
          input.roomId,
          input.channelId,
          publicationId,
          input.originKind,
          input.originKey,
          requestHash,
          input.workflowRunId,
          input.workflowStepRunId,
          input.initiatorAgentId,
          input.initiatorMemberId,
          input.apiKeyId,
          input.sourceMemberId,
          JSON.stringify(input.sourceLocator),
          JSON.stringify(input.targetMemberIds),
          input.ttlSeconds,
          input.allowPartial,
          input.assignmentFence?.assignmentId ?? null,
          input.assignmentFence?.attempt ?? null,
          input.assignmentFence?.agentId ?? null,
          authorityGeneration,
        ],
      );
    });
    if (!result.rows[0]) {
      if (input.assignmentFence) {
        const conflict = await this.pool.query(
          "SELECT id FROM studio.room_storage_transfer_jobs WHERE organization_id=$1 AND origin_key=$2",
          [input.organizationId, input.originKey],
        );
        if (!conflict.rows[0])
          throw requestError(
            "executor_lease_expired_or_cancelled",
            "The action assignment is no longer active.",
            403,
          );
      }
      throw requestError(
        "room_storage_idempotency_conflict",
        "The room storage idempotency key was reused with another request.",
        409,
      );
    }
    this.scanSoon();
    return storageJob(result.rows[0]!);
  }

  async requestCancel(workflowStepRunId: string) {
    await this.pool.query(
      `UPDATE studio.room_storage_transfer_jobs
       SET status=CASE WHEN error_code='room_storage_cleanup_incomplete' OR status='failed'
         THEN 'cancel_requested' WHEN status IN ('completed','partial','failed','cancelled') THEN status ELSE 'cancel_requested' END,
           updated_at=now()
       WHERE workflow_step_run_id=$1`,
      [workflowStepRunId],
    );
    this.scanSoon();
  }

  async cancelAndWait(workflowStepRunId: string) {
    await this.requestCancel(workflowStepRunId);
    const deadline = Date.now() + 60_000;
    for (;;) {
      const job = await this.workflowStatus(workflowStepRunId);
      if (!job) throw new Error("room_storage_transfer_not_found");
      if (job.status === "cancelled") return job;
      if (["completed", "partial", "failed"].includes(job.status)) {
        throw new Error(`room_storage_cancel_not_confirmed:${job.status}`);
      }
      if (Date.now() >= deadline) {
        throw new Error("room_storage_cancel_timeout");
      }
      await delay(500);
    }
  }

  private async requestCancelById(jobId: string) {
    await this.pool.query(
      `UPDATE studio.room_storage_transfer_jobs
       SET status=CASE WHEN error_code='room_storage_cleanup_incomplete' OR status='failed'
         THEN 'cancel_requested' WHEN status IN ('completed','partial','failed','cancelled') THEN status ELSE 'cancel_requested' END,
           updated_at=now()
       WHERE id=$1`,
      [jobId],
    );
    this.scanSoon();
  }

  private async waitForCancellation(jobId: string) {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const result = await this.pool.query<Row>(
        "SELECT * FROM studio.room_storage_transfer_jobs WHERE id=$1",
        [jobId],
      );
      if (!result.rows[0]) throw new Error("room_storage_transfer_not_found");
      const job = storageJob(result.rows[0]);
      if (job.status === "cancelled") return;
      if (["completed", "partial", "failed"].includes(job.status)) {
        throw new Error(`room_storage_cancel_not_confirmed:${job.status}`);
      }
      if (Date.now() >= deadline)
        throw new Error("room_storage_cancel_timeout");
      await delay(500);
    }
  }

  async workflowStatus(workflowStepRunId: string) {
    const result = await this.pool.query<Row>(
      "SELECT * FROM studio.room_storage_transfer_jobs WHERE workflow_step_run_id=$1",
      [workflowStepRunId],
    );
    return result.rows[0] ? storageJob(result.rows[0]) : null;
  }

  private async agentPublicationJob(
    organizationId: string,
    agentId: string,
    publicationId: string,
  ) {
    const result = await this.pool.query<Row>(
      `SELECT * FROM studio.room_storage_transfer_jobs
       WHERE organization_id=$1 AND publication_id=$2 AND initiator_agent_id=$3`,
      [organizationId, publicationId, agentId],
    );
    if (!result.rows[0]) {
      throw requestError(
        "room_storage_transfer_not_found",
        "Room storage transfer not found for this initiating agent.",
        404,
      );
    }
    return storageJob(result.rows[0]);
  }

  private async agentPublicationStatus(
    organizationId: string,
    agentId: string,
    publicationId: string,
  ) {
    const job = await this.agentPublicationJob(
      organizationId,
      agentId,
      publicationId,
    );
    if (!job.coordinatorStarted) return storageJobStatus(job);
    return this.coordinatorPublicationStatus(job);
  }

  private async coordinatorPublicationStatus(
    job: ReturnType<typeof storageJob>,
  ) {
    const template = await resolveBeamEnvironmentTemplate({
      organizationId: job.organizationId,
      templateKey: job.environmentTemplateKey,
    });
    const coordinator = await roomServiceForOrganization(job.organizationId, template, job.apiKeyId);
    const response = await coordinator.client.organizationObjectStatus(
      job.organizationId,
      job.roomId,
      job.channelId,
      job.publicationId,
      coordinator.token,
    );
    // Detailed execution history belongs to the execution API, not the bounded
    // agent control envelope used by CLI status and cancellation replies.
    const latest = await this.pool.query<Row>(
      "SELECT status,error_code,error_message FROM studio.room_storage_transfer_jobs WHERE id=$1",
      [job.id],
    );
    const row = latest.rows[0];
    return roomStorageExecutionStatus(
      object(response.status),
      row
        ? {
            status: text(row.status),
            errorCode: text(row.error_code),
            errorMessage: text(row.error_message),
          }
        : job,
    );
  }

  /**
   * Runs a scan in the background. A failed scan (PostgreSQL restarting, for
   * one) is logged and retried by the next tick; left unhandled, the rejection
   * ended the API process.
   */
  private scanSoon() {
    void this.scan().catch((error: unknown) => {
      this.logger.warn(
        {
          code: isPostgresUnavailableError(error)
            ? "database_unavailable"
            : safeErrorCode(error),
        },
        "Room storage transfer scan failed; retrying on the next tick",
      );
    });
  }

  private async scan() {
    if (this.stopped) return;
    const candidates = await claimRoomStorageTransferJobs(
      this.pool,
      this.owner,
    );
    for (const row of candidates.rows) {
      if (this.stopped) return;
      const job = storageJob(row);
      if (this.active.has(job.id)) continue;
      this.active.add(job.id);
      void this.execute(job)
        .catch((error) => this.fail(job, error))
        .catch((error: unknown) => {
          // Recording the failure needs the database too. The lease expires
          // and a later scan reclaims the job.
          this.logger.warn(
            { jobId: job.id, code: safeErrorCode(error) },
            "Could not record the room storage transfer failure",
          );
        })
        .finally(() => this.active.delete(job.id));
    }
  }

  private async execute(job: ReturnType<typeof storageJob>) {
    const ownership = new AbortController();
    if (this.stopped) return;
    this.ownerships.set(job.id, ownership);
    let renewing = false;
    const lease = setInterval(() => {
      if (renewing || ownership.signal.aborted) return;
      renewing = true;
      void this.pool
        .query(
          `UPDATE studio.room_storage_transfer_jobs SET lease_expires_at=now()+interval '45 seconds'
         WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>now() RETURNING id`,
          [job.id, this.owner],
        )
        .then((result) => {
          if (result.rowCount !== 1)
            ownership.abort(new Error("room_storage_job_lease_lost"));
        })
        .catch(() => ownership.abort(new Error("room_storage_job_lease_lost")))
        .finally(() => {
          renewing = false;
        });
    }, 15_000);
    lease.unref();
    let client: BeamClient | null = null;
    let coordinator: Awaited<ReturnType<typeof roomServiceForOrganization>> | null = null;
    let standardTargets: PreparedTarget[] = [];
    try {
      const template = await resolveBeamEnvironmentTemplate({
        organizationId: job.organizationId,
        templateKey: job.environmentTemplateKey,
      });
      const activeCoordinator = await roomServiceForOrganization(job.organizationId, template, job.apiKeyId);
      coordinator = activeCoordinator;
      // Cleanup follows durable provider identities even after room membership
      // changes. It must not rediscover recipients or authorize new transfers.
      if (
        job.status === "cancel_requested" &&
        job.preparation?.schema === HYBRID_SCHEMA
      ) {
        const bindings = await listRoomStorageBindings(
          job.organizationId,
          job.environmentTemplateKey,
          job.roomId,
        );
        await this.hybrid.execute(
          job,
          activeCoordinator,
          {},
          [],
          bindings,
          ownership.signal,
        );
        return;
      }
      if (
        job.status === "cancel_requested" &&
        job.sourceLocator.type === "artifact_copy" &&
        !job.preparation &&
        !job.coordinatorStarted
      ) {
        await this.pool.query(
          `UPDATE studio.room_storage_transfer_jobs SET status='cancelled',
             lease_owner=NULL,lease_expires_at=NULL,
             provider_cleanup_confirmed_at=now(),updated_at=now()
           WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>now()`,
          [job.id, job.leaseOwner],
        );
        return;
      }
      const snapshot = await activeCoordinator.client.organizationRoomSnapshot(
        job.organizationId,
        job.roomId,
        activeCoordinator.token,
      );
      const memberships = records(snapshot.memberships);
      const member = memberships.find(
        (candidate) => text(candidate.member_id) === job.sourceMemberId,
      );
      if (!member || text(member.state) !== "active") {
        throw new Error("room_storage_source_inactive");
      }
      const agents = await this.repository.listAgents(job.organizationId);
      const bindings = await listRoomStorageBindings(
        job.organizationId,
        job.environmentTemplateKey,
        job.roomId,
      );
      const requestedTargets = job.targetMemberIds.length
        ? job.targetMemberIds
        : resolveRoomWorkflowRecipients(
            job.roomId,
            snapshot,
            agents,
            {
              channelId: job.channelId,
              sourceMemberId: job.sourceMemberId,
            },
            bindings,
          );
      if (!job.targetMemberIds.length) {
        job.targetMemberIds = requestedTargets;
        await this.pool.query(
          `UPDATE studio.room_storage_transfer_jobs
           SET target_member_ids_json=$2::jsonb, updated_at=now()
           WHERE id=$1`,
          [job.id, JSON.stringify(requestedTargets)],
        );
      }
      const targetMembers = requestedTargets.map((memberId) => {
        const target = memberships.find(
          (candidate) => text(candidate.member_id) === memberId,
        );
        if (!target) throw new Error("room_storage_target_inactive");
        return target;
      });
      if (
        text(member.kind) === "agent" ||
        targetMembers.some((target) => text(target.kind) === "agent")
      ) {
        await this.hybrid.execute(
          job,
          activeCoordinator,
          member,
          targetMembers,
          bindings,
          ownership.signal,
        );
        return;
      }
      const sourcePrepared = await this.sourceConfig({
        job,
        member,
        bindings,
      });
      const providerRouteTtlSeconds = roomStorageProviderRouteTtlSeconds(
        job.ttlSeconds,
      );
      const sourceHead = await prepareProviderSource(sourcePrepared.config, {
        expiresIn: providerRouteTtlSeconds,
        signal: ownership.signal,
      });
      const sourceIdentity = frozenIdentity(sourceHead);
      standardTargets = [];
      for (const [index, target] of targetMembers.entries()) {
        if (
          text(member.kind) !== "object_storage" &&
          text(target.kind) !== "object_storage"
        ) {
          continue;
        }
        const prepared = await this.destinationConfig({
          job,
          member: target,
          binding: bindings.find(
            (value) => value.coordinatorMemberId === text(target.member_id),
          ),
          sourceName: sourceHead.filename ?? "object",
          sourceLocator: job.sourceLocator,
          index,
        });
        standardTargets.push({
          memberId: text(target.member_id),
          childId: `${job.publicationId}:${text(target.member_id)}`,
          destinationId: `room_destination_${index}`,
          config: { ...prepared.config, id: `room_destination_${index}` },
          bindingId:
            text(target.kind) === "object_storage"
              ? bindings.find(
                  (value) =>
                    value.coordinatorMemberId === text(target.member_id),
                )?.id
              : undefined,
        });
      }
      if (!standardTargets.length) {
        throw new Error("room_storage_transfer_has_no_storage_leg");
      }
      const apiKey = await getDecryptedApiKey(job.apiKeyId, job.organizationId);
      if (!apiKey) throw new Error("beam_api_key_unavailable");
      client = new BeamClient({
        apiKey,
        natsUrl: template.natsUrl,
        environment: template.key,
      });
      let transferId = job.transferId;
      if (job.status === "cancel_requested") {
        await this.cancel(job, client, activeCoordinator);
        return;
      }
      const onPrepared = async (prepared: TransferPrepareResponse) => {
        ownership.signal.throwIfAborted();
        if ((await this.currentStatus(job)) === "cancel_requested")
          throw new Error("room_storage_cancelled");
        transferId = prepared.transfer_id;
        const bindingInput = standardRoomBindingInput(
          prepared,
          standardTargets.map((target) => ({
            memberId: target.memberId,
            destinationId: target.destinationId,
            resourceId: text(
              targetMembers.find(
                (member) => text(member.member_id) === target.memberId,
              )?.resource_id,
            ),
          })),
        );
        for (const target of standardTargets) {
          const destination = prepared.plan_descriptor.destinations.find(
            (value) => value.destination_id === target.destinationId,
          );
          target.finalObjectKey = destination
            ? Object.values(destination.final_object_keys)[0]
            : undefined;
          if (!target.finalObjectKey) {
            throw new Error("room_storage_destination_identity_unavailable");
          }
        }
        const chunkSize =
          prepared.chunk_size ?? prepared.plan_descriptor.chunk_size;
        const chunkCount =
          prepared.logical_chunks ??
          prepared.plan_descriptor.logical_chunk_count;
        const file = {
          size_bytes: sourceHead.size,
          chunk_size_bytes: chunkSize,
          chunk_count: chunkCount,
          identity: sourceIdentity.identity,
        };
        if (
          job.file &&
          text(job.file.identity) &&
          (job.file.identity !== file.identity ||
            job.file.size_bytes !== file.size_bytes ||
            job.file.chunk_size_bytes !== file.chunk_size_bytes ||
            job.file.chunk_count !== file.chunk_count)
        ) {
          throw new Error("room_source_changed");
        }
        job.file = file;
        job.transferId = transferId;
        job.status = "running";
        const updated = await this.pool.query(
          `UPDATE studio.room_storage_transfer_jobs
           SET transfer_id=$2, file_json=$3::jsonb,
               status='running', error_code=NULL, error_message=NULL, updated_at=now()
           WHERE id=$1 AND lease_owner=$4 AND lease_expires_at>now() AND status<>'cancel_requested'`,
          [job.id, transferId, JSON.stringify(file), job.leaseOwner],
        );
        if (updated.rowCount !== 1) {
          if ((await this.currentStatus(job)) === "cancel_requested")
            throw new Error("room_storage_cancelled");
          throw new Error("room_storage_job_lease_lost");
        }
        await activeCoordinator.client.startOrganizationStorageTransfer(
          job.organizationId,
          job.roomId,
          job.channelId,
          {
            schema_version: "room-storage-transfer/v2",
            ...bindingInput,
            publication_id: job.publicationId,
            source_member_id: job.sourceMemberId,
            target_member_ids: requestedTargets,
            filename: sourceHead.filename ?? "object",
            file,
            source_object:
              text(member.kind) === "object_storage"
                ? sourceIdentity.object
                : undefined,
            ttl_seconds: job.ttlSeconds,
            allow_partial: job.allowPartial,
            studio_workflow_run_id: job.workflowRunId,
            studio_workflow_step_run_id: job.workflowStepRunId,
          },
          `room-storage:${job.id}:start`,
          activeCoordinator.token,
        );
        job.coordinatorStarted = true;
        const bound = await this.pool.query(
          `UPDATE studio.room_storage_transfer_jobs
           SET coordinator_started=true, updated_at=now()
           WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>now()`,
          [job.id, job.leaseOwner],
        );
        if (bound.rowCount !== 1)
          throw new Error("room_storage_job_lease_lost");
      };
      const executionInput = {
        sources: [sourcePrepared.config],
        destinations: standardTargets.map((target) => target.config),
        name: `Room ${job.roomId} publication ${job.publicationId}`,
        expiresIn: providerRouteTtlSeconds,
        signal: ownership.signal,
        onPrepared,
        onMultipartGroupReady: (group: ProviderMultipartGroupIdentity) =>
          this.recordMultipartSession(job, standardTargets, group),
        throwIfCancelled: async () => {
          ownership.signal.throwIfAborted();
          const state = await this.currentStatus(job);
          if (state === "cancel_requested")
            throw new Error("room_storage_cancelled");
        },
      };
      const prepared = transferId
        ? await client.resumeProviderTransfer({
            ...executionInput,
            transferId,
            multipartGroups: await this.standardMultipartIdentities(job),
          })
        : await client.createTransfer({
            ...executionInput,
            idempotencyKey: `room-storage:${job.id}`,
          });
      transferId = prepared.transfer_id;
      while (true) {
        ownership.signal.throwIfAborted();
        const current = await this.currentStatus(job);
        if (current === "cancel_requested") {
          await this.cancel(job, client, activeCoordinator);
          return;
        }
        if (text(member.kind) === "object_storage") {
          await assertProviderSourceIdentity(
            sourcePrepared.config,
            sourceIdentity,
            providerRouteTtlSeconds,
          );
        }
        const status = await client.transferStatus(transferId!);
        if (
          status.status === "completed" &&
          text(member.kind) === "object_storage"
        ) {
          await assertProviderSourceIdentity(
            sourcePrepared.config,
            sourceIdentity,
            providerRouteTtlSeconds,
          );
        }
        if (status.status === "cancelled") {
          await this.cancel(job, client, activeCoordinator);
          return;
        }
        const completedDestinations = new Set(
          (status.destination_progress ?? [])
            .filter((value) => value.completion_verified)
            .map((value) => value.destination_id),
        );
        await Promise.all(
          standardTargets
            .filter((target) => completedDestinations.has(target.destinationId))
            .map((target) =>
              this.markTargetMultipartSessions(target.childId, "completed"),
            ),
        );
        if (["completed", "failed", "cancelled"].includes(status.status)) {
          const terminal =
            status.status === "completed"
              ? "completed"
              : status.status === "cancelled"
                ? "cancelled"
                : job.allowPartial && completedDestinations.size > 0
                  ? "partial"
                  : "failed";
          const cleanupFailures =
            terminal !== "completed"
              ? await this.abortUnfinishedStandard(job)
              : [];
          const failure = roomStorageTerminalFailure(
            terminal,
            status.error_message,
          );
          await this.pool.query(
            `UPDATE studio.room_storage_transfer_jobs SET status=$2, lease_owner=NULL,
             lease_expires_at=NULL,
             error_code=CASE WHEN $5 THEN $6::text WHEN $2 IN ('completed','partial') THEN NULL ELSE error_code END,
             error_message=CASE WHEN $5 THEN $7::text WHEN $2 IN ('completed','partial') THEN NULL ELSE error_message END,
             provider_cleanup_confirmed_at=CASE WHEN $4 THEN now() ELSE NULL END,
             updated_at=now() WHERE id=$1 AND lease_owner=$3 AND lease_expires_at>now()`,
            [
              job.id,
              terminal,
              job.leaseOwner,
              cleanupFailures.length === 0,
              failure !== null,
              failure?.errorCode ?? null,
              failure?.errorMessage ?? null,
            ],
          );
          if (cleanupFailures.length) {
            // Beam's reason stays first; the cleanup warning follows it.
            await this.pool.query(
              `UPDATE studio.room_storage_transfer_jobs SET error_code='room_storage_cleanup_incomplete',
              error_message=CASE WHEN error_message IS NULL THEN 'Provider cleanup could not be verified.'
                ELSE error_message || '; provider cleanup could not be verified.' END,
              updated_at=now() WHERE id=$1 AND status=$2`,
              [job.id, terminal],
            );
          }
          return;
        }
        await delay(2_000);
      }
    } catch (error) {
      if (
        ownership.signal.aborted ||
        (error as Error)?.message === "room_storage_job_lease_lost"
      )
        return;
      if (
        (await this.currentStatus(job).catch(() => "")) ===
          "cancel_requested" &&
        client &&
        coordinator
      ) {
        await this.cancel(job, client, coordinator);
        return;
      }
      if (client && job.transferId) {
        await client.cancelTransfer(job.transferId).catch(() => undefined);
        const cleanupFailures = await this.abortUnfinishedStandard(job);
        if (cleanupFailures.length)
          throw new Error("room_storage_cleanup_incomplete");
      }
      throw error;
    } finally {
      clearInterval(lease);
      this.ownerships.delete(job.id);
      await client?.close().catch(() => undefined);
    }
  }

  private async sourceConfig(input: {
    job: ReturnType<typeof storageJob>;
    member: Row;
    bindings: StorageBinding[];
  }): Promise<{ config: ProviderSourceConfig }> {
    if (text(input.member.kind) === "object_storage") {
      const binding = input.bindings.find(
        (value) => value.coordinatorMemberId === input.job.sourceMemberId,
      );
      if (!binding || text(input.job.sourceLocator.type) !== "bucket_object") {
        throw new Error("room_storage_source_binding_unavailable");
      }
      return {
        config: await providerConfig(
          this.pool,
          input.job.organizationId,
          binding,
          text(input.job.sourceLocator.objectKey),
        ),
      };
    }
    if (text(input.job.sourceLocator.type) !== "agent_path") {
      throw new Error("room_storage_agent_source_locator_invalid");
    }
    throw new Error("room_storage_agent_source_requires_direct_assignment");
  }

  private async destinationConfig(input: {
    job: ReturnType<typeof storageJob>;
    member: Row;
    binding?: StorageBinding;
    sourceName: string;
    sourceLocator: Row;
    index: number;
  }): Promise<{
    config: ProviderDestinationConfig;
  }> {
    if (text(input.member.kind) === "object_storage") {
      if (!input.binding)
        throw new Error("room_storage_target_binding_unavailable");
      const key = destinationObjectKey(
        input.binding,
        input.job.roomId,
        input.job.publicationId,
        sourceRelativePath(input.sourceLocator, input.sourceName),
      );
      if (
        input.binding.collisionPolicy === "fail_if_exists" &&
        (await storageObjectExists({
          pool: this.pool,
          organizationId: input.job.organizationId,
          credentialId: input.binding.credentialId,
          bucket: input.binding.bucket,
          prefix: key,
        }))
      ) {
        throw new Error("room_storage_destination_exists");
      }
      return {
        config: await providerConfig(
          this.pool,
          input.job.organizationId,
          input.binding,
          key,
        ),
      };
    }
    throw new Error("room_storage_agent_requires_hybrid_execution");
  }

  private async runAgentCommand(
    job: ReturnType<typeof storageJob>,
    agentId: string,
    operation: Parameters<
      AgentControlRepository["createCommand"]
    >[0]["operation"],
    payload: Row,
    idempotencyKey: string,
    timeoutMs = 150_000,
  ) {
    return this.runAgentCommandForOrganization(
      job.organizationId,
      job.ttlSeconds,
      agentId,
      operation,
      payload,
      idempotencyKey,
      timeoutMs,
    );
  }

  private async runAgentCommandForOrganization(
    organizationId: string,
    ttlSeconds: number,
    agentId: string,
    operation: Parameters<
      AgentControlRepository["createCommand"]
    >[0]["operation"],
    payload: Row,
    idempotencyKey: string,
    timeoutMs = 150_000,
  ) {
    const command = await this.repository.createCommand({
      organizationId,
      agentId,
      operation,
      payload,
      idempotencyKey,
      ttlSeconds: Math.min(ttlSeconds, 600),
    });
    const terminal = await this.gateway.dispatchAndWait(
      agentId,
      command.id,
      timeoutMs,
    );
    if (terminal.state !== "completed" || !terminal.result) {
      throw new RoomStorageAgentCommandError(
        text(terminal.error?.code) || "room_storage_agent_endpoint_failed",
        text(terminal.error?.message) || "The agent command failed.",
        terminal.error?.retryable === true,
      );
    }
    return terminal.result;
  }

  private async cancel(
    job: ReturnType<typeof storageJob>,
    client: BeamClient,
    coordinator: Awaited<ReturnType<typeof roomServiceForOrganization>>,
  ) {
    await this.currentStatus(job);
    if (job.transferId) {
      const status = await client.transferStatus(job.transferId);
      if (!["completed", "failed", "cancelled"].includes(status.status))
        await client.cancelTransfer(job.transferId);
    }
    if (job.coordinatorStarted)
      await coordinator.client.cancelOrganizationStorageTransfer(
        job.organizationId,
        job.roomId,
        job.channelId,
        job.publicationId,
        `room-storage:${job.id}:cancel`,
        coordinator.token,
      );
    const failures = await this.abortUnfinishedStandard(job);
    await this.pool.query(
      `UPDATE studio.room_storage_transfer_jobs SET status='cancelled', lease_owner=NULL,
       lease_expires_at=NULL,error_code=$3,error_message=$4,
       provider_cleanup_confirmed_at=CASE WHEN $5 THEN now() ELSE NULL END,
       updated_at=now() WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>now()`,
      [
        job.id,
        job.leaseOwner,
        failures.length ? "room_storage_cleanup_incomplete" : null,
        failures.length ? "Provider cleanup could not be verified." : null,
        failures.length === 0,
      ],
    );
  }

  private async fail(job: ReturnType<typeof storageJob>, error: unknown) {
    const code = safeErrorCode(error);
    if (error instanceof WorkflowAuthorityUnavailableError) {
      await this.pool.query(
        `UPDATE studio.room_storage_transfer_jobs
         SET status=CASE WHEN status='cancel_requested' THEN status
           WHEN coordinator_started THEN 'running' ELSE 'queued' END,
           error_code=$2,error_message=$3,lease_owner=NULL,
           lease_expires_at=now()+interval '5 seconds',updated_at=now()
         WHERE id=$1 AND lease_owner=$4 AND lease_expires_at>now()`,
        [job.id, code, safeErrorMessage(error), job.leaseOwner],
      );
      return;
    }
    await this.pool.query(
      `UPDATE studio.room_storage_transfer_jobs
       SET status=CASE WHEN status='cancel_requested' THEN status ELSE 'failed' END,
       error_code=CASE WHEN status='cancel_requested' THEN 'room_storage_cleanup_incomplete' ELSE $2 END,
       error_message=CASE WHEN status='cancel_requested' THEN 'Cancellation cleanup is awaiting reconciliation.' ELSE $3 END,
       provider_cleanup_confirmed_at=CASE WHEN status<>'cancel_requested'
         AND coordinator_started=false AND transfer_id IS NULL THEN now() ELSE NULL END,
       lease_owner=NULL, lease_expires_at=CASE WHEN status='cancel_requested' THEN now()+interval '15 seconds' ELSE NULL END, updated_at=now()
       WHERE id=$1 AND lease_owner=$4 AND lease_expires_at>now()`,
      [job.id, code, safeErrorMessage(error), job.leaseOwner],
    );
    this.logger.warn(
      { jobId: job.id, publicationId: job.publicationId, code },
      "Room storage transfer failed",
    );
  }

  private async currentStatus(job: { id: string; leaseOwner: string }) {
    if (this.stopped) throw new Error("room_storage_job_lease_lost");
    const result = await this.pool.query<Row>(
      "SELECT status FROM studio.room_storage_transfer_jobs WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>now()",
      [job.id, job.leaseOwner],
    );
    if (!result.rows[0]) throw new Error("room_storage_job_lease_lost");
    return text(result.rows[0]?.status);
  }

  private async recordMultipartSession(
    job: ReturnType<typeof storageJob>,
    targets: PreparedTarget[],
    group: ProviderMultipartGroupIdentity,
  ) {
    await this.currentStatus(job);
    const target = targets.find(
      (candidate) => candidate.destinationId === group.destinationId,
    );
    if (!target) throw new Error("room_storage_multipart_target_unresolved");
    const id = `rsmp_${createHash("sha256")
      .update(
        `${job.organizationId}\n${job.publicationId}\n${group.multipartGroupId}`,
      )
      .digest("hex")
      .slice(0, 32)}`;
    const result = await this.pool.query(
      `INSERT INTO studio.room_storage_multipart_sessions (
         id, organization_id, binding_id, target_member_id, publication_id,
         child_execution_id, multipart_group_id, object_key, upload_id,
         parts_json, state, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'active',$11)
       ON CONFLICT (organization_id, child_execution_id) DO UPDATE
       SET updated_at=now(), expires_at=EXCLUDED.expires_at
       WHERE studio.room_storage_multipart_sessions.multipart_group_id=EXCLUDED.multipart_group_id
         AND studio.room_storage_multipart_sessions.object_key=EXCLUDED.object_key
         AND studio.room_storage_multipart_sessions.upload_id=EXCLUDED.upload_id
       RETURNING id`,
      [
        id,
        job.organizationId,
        target.bindingId ?? null,
        target.memberId,
        job.publicationId,
        target.childId,
        group.multipartGroupId,
        group.objectKey,
        group.uploadId,
        JSON.stringify(group),
        group.expiresAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error("room_storage_multipart_identity_conflict");
    }
  }

  private async abortUnfinishedStandard(job: ReturnType<typeof storageJob>) {
    const sessions = await this.pool.query<Row>(
      `SELECT * FROM studio.room_storage_multipart_sessions
      WHERE organization_id=$1 AND publication_id=$2 AND state='active'`,
      [job.organizationId, job.publicationId],
    );
    if (!sessions.rows.length) return [];
    const bindings = await listRoomStorageBindings(
      job.organizationId,
      job.environmentTemplateKey,
      job.roomId,
    );
    const failures: string[] = [];
    for (let index = 0; index < sessions.rows.length; index += 8) {
      await this.currentStatus(job);
      await Promise.all(
        sessions.rows.slice(index, index + 8).map(async (session) => {
          try {
            const binding = bindings.find(
              (binding) => binding.id === session.binding_id,
            );
            if (!binding) throw new Error("room_storage_binding_unavailable");
            await abortRoomMultipartUpload({
              destination: await providerConfig(
                this.pool,
                job.organizationId,
                binding,
                text(session.object_key),
              ),
              objectKey: text(session.object_key),
              uploadId: text(session.upload_id),
              metadata: { "beam-transfer-id": job.transferId! },
              signal: AbortSignal.timeout(15_000),
            });
            await this.markTargetMultipartSessions(
              text(session.child_execution_id),
              "aborted",
            );
          } catch {
            failures.push(text(session.target_member_id));
          }
        }),
      );
    }
    return failures;
  }

  private async standardMultipartIdentities(
    job: ReturnType<typeof storageJob>,
  ): Promise<ProviderMultipartGroupIdentity[]> {
    const sessions = await this.pool.query<Row>(
      `SELECT multipart_group_id,object_key,upload_id,parts_json,state
      FROM studio.room_storage_multipart_sessions WHERE organization_id=$1 AND publication_id=$2`,
      [job.organizationId, job.publicationId],
    );
    return sessions.rows.map((session) => {
      const value = object(session.parts_json);
      if (
        session.state === "aborted" ||
        value.transferId !== job.transferId ||
        value.multipartGroupId !== session.multipart_group_id ||
        value.objectKey !== session.object_key ||
        value.uploadId !== session.upload_id ||
        !text(value.sourceId) ||
        !text(value.destinationId)
      ) {
        throw new Error("room_storage_multipart_recovery_incomplete");
      }
      return value as ProviderMultipartGroupIdentity;
    });
  }

  private async markTargetMultipartSessions(
    childExecutionId: string,
    state: "completed" | "aborted",
  ) {
    await this.pool.query(
      `UPDATE studio.room_storage_multipart_sessions
       SET state=$2, updated_at=now()
       WHERE child_execution_id=$1 AND state='active'`,
      [childExecutionId, state],
    );
  }
}

function roomStorageRequestHash(input: {
  environmentTemplateKey: string;
  roomId: string;
  channelId: string;
  sourceMemberId: string;
  sourceLocator: Record<string, unknown>;
  targetMemberIds: string[];
  ttlSeconds: number;
  allowPartial: boolean;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        environmentTemplateKey: input.environmentTemplateKey,
        roomId: input.roomId,
        channelId: input.channelId,
        sourceMemberId: input.sourceMemberId,
        sourceLocator: input.sourceLocator,
        targetMemberIds: input.targetMemberIds,
        ttlSeconds: input.ttlSeconds,
        allowPartial: input.allowPartial,
      }),
    )
    .digest("hex");
}

export async function providerConfig(
  pool: PgPool,
  organizationId: string,
  binding: StorageBinding,
  key: string,
) {
  const raw = await new CredentialRepository(pool, vaultSecretFromEnv).payload(
    organizationScope(organizationId),
    binding.credentialId,
  );
  if (!raw) throw new Error("room_storage_credential_unavailable");
  const payload = normalizeCredentialPayloadAliases(raw);
  const config = {
    provider: binding.providerProfileId,
    bucket: binding.bucket,
    key,
    endpoint_url: resolveProviderProfileEndpointUrl(
      binding.providerProfileId,
      payload,
    ),
    region: resolveProviderProfileRegion(binding.providerProfileId, payload),
    force_path_style: resolveProviderProfileForcePathStyle(
      binding.providerProfileId,
      payload,
    ),
    access_key_id: text(payload.access_key_id ?? payload.api_key),
    secret_access_key: text(payload.secret_access_key ?? payload.api_secret),
    session_token: text(payload.session_token) || undefined,
    ...(binding.providerProfileId === "hippius"
      ? {
          capabilities: {
            multipart_part_last_modified: false,
            assignment_timeout_ms: 60_000,
          },
        }
      : {}),
  };
  return S3CompatibleProviderConfig.create(
    config as Parameters<typeof S3CompatibleProviderConfig.create>[0],
  );
}

function destinationObjectKey(
  binding: StorageBinding,
  roomId: string,
  publicationId: string,
  relativePath: string,
) {
  const prefix = sanitizePath(binding.destinationPrefix);
  const relative = sanitizePath(relativePath);
  const base = relative.split("/").pop() || "object";
  const parts =
    binding.destinationLayout === "isolated"
      ? [prefix, roomId, publicationId, relative]
      : binding.destinationLayout === "preserve_path"
        ? [prefix, relative]
        : [prefix, base];
  return parts.filter(Boolean).join("/");
}

function sourceRelativePath(locator: Row, fallback: string) {
  if (text(locator.type) === "bucket_object") {
    return text(locator.objectKey) || fallback;
  }
  const path = text(locator.path).replaceAll("\\", "/");
  return path.split("/").pop() || fallback;
}

function sanitizePath(value: string) {
  return value
    .replaceAll("\\", "/")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

async function assertProviderSourceIdentity(
  source: ProviderSourceConfig,
  expected: FrozenSourceIdentity,
  expiresIn: number,
) {
  const currentHead = await prepareProviderSource(source, { expiresIn });
  if (frozenIdentity(currentHead).identity !== expected.identity) {
    throw new Error("room_storage_source_mutated");
  }
  return currentHead;
}

function frozenIdentity(source: {
  size: number;
  metadata?: Record<string, unknown>;
}) {
  const object = {
    size_bytes: source.size,
    etag: text(source.metadata?.etag) || undefined,
    version_id: text(source.metadata?.version_id) || undefined,
    last_modified: text(source.metadata?.last_modified) || undefined,
  };
  return {
    object,
    identity: createHash("sha256").update(JSON.stringify(object)).digest("hex"),
  };
}

function storageJob(row: Row) {
  return {
    id: text(row.id),
    organizationId: text(row.organization_id),
    leaseOwner: text(row.lease_owner),
    environmentTemplateKey: text(row.environment_template_key),
    roomId: text(row.room_id),
    channelId: text(row.channel_id),
    publicationId: text(row.publication_id),
    originKind: text(row.origin_kind),
    originKey: text(row.origin_key),
    workflowRunId: text(row.workflow_run_id),
    workflowStepRunId: text(row.workflow_step_run_id),
    initiatorAgentId: text(row.initiator_agent_id) || null,
    initiatorMemberId: text(row.initiator_member_id) || null,
    apiKeyId: text(row.api_key_id),
    sourceMemberId: text(row.source_member_id),
    sourceLocator: object(row.source_locator_json),
    targetMemberIds: strings(row.target_member_ids_json),
    ttlSeconds: Number(row.ttl_seconds),
    allowPartial: row.allow_partial === true,
    status: text(row.status),
    transferId: text(row.transfer_id) || null,
    coordinatorStarted: row.coordinator_started === true,
    preparation: nullableObject(
      row.preparation_json,
    ) as HybridPreparation | null,
    execution: nullableObject(row.execution_json),
    file: nullableObject(row.file_json),
    errorCode: text(row.error_code) || null,
    errorMessage: text(row.error_message) || null,
    updatedAt: text(row.updated_at),
  };
}

export function roomStoragePendingStatus(
  job: Pick<
    ReturnType<typeof storageJob>,
    | "publicationId"
    | "status"
    | "file"
    | "transferId"
    | "errorCode"
    | "sourceMemberId"
    | "sourceLocator"
    | "targetMemberIds"
  > & { errorMessage?: string | null },
) {
  const sourceKind =
    text(job.sourceLocator.type) === "bucket_object"
      ? "object_storage"
      : "agent";
  const completed = false;
  const targetState = completed
    ? "delivered"
    : ["failed", "cancelled"].includes(job.status)
      ? job.status
      : "pending";
  const failureCode = ["failed", "cancelled"].includes(job.status)
    ? job.errorCode
    : null;
  const failureMessage = ["failed", "cancelled"].includes(job.status)
    ? job.errorMessage
    : null;
  const completedChunks = completed
    ? Number(object(job.file).chunk_count ?? 0) || 0
    : 0;
  return {
    publisher: {
      publication_id: job.publicationId,
      state: ["completed", "partial"].includes(job.status)
        ? "active"
        : ["failed", "cancelled"].includes(job.status)
          ? job.status
          : "active",
      source: {
        member_id: job.sourceMemberId,
        kind: sourceKind,
        locator: job.sourceLocator,
      },
      deliveries: job.targetMemberIds.map((memberId) => ({
        member_id: memberId,
        state: targetState,
        completed_chunks: completedChunks,
        protection: completed ? "provider_tls" : "unknown",
        unavailable_reason:
          targetState === "failed" || targetState === "cancelled"
            ? (job.errorCode ?? targetState)
            : undefined,
      })),
      room_transfer: {
        schema_version: "room-storage-transfer/v2",
        status: ["failed", "cancelled"].includes(job.status)
          ? job.status
          : "pending",
        file: job.file ?? undefined,
        transfer_id: job.transferId ?? undefined,
        error_code: failureCode ?? undefined,
        error_message: failureMessage || undefined,
      },
    },
  };
}

function storageJobStatus(job: ReturnType<typeof storageJob>) {
  return roomStoragePendingStatus(job);
}

/**
 * What a terminal Beam transfer leaves on its room storage job. Beam's
 * `error_message` (for example `destination_access_denied: ...`) is stored
 * verbatim so room clients can show it. A failed job also takes the message's
 * leading code as its error code; a partial job keeps none, so it still reads
 * as partial delivery rather than as a failure. Null keeps the job's fields.
 */
export function roomStorageTerminalFailure(
  terminal: "completed" | "partial" | "failed" | "cancelled",
  errorMessage: string | null | undefined,
): { errorCode: string | null; errorMessage: string } | null {
  if (terminal !== "failed" && terminal !== "partial") return null;
  if (typeof errorMessage !== "string" || !errorMessage.trim()) return null;
  return {
    errorCode:
      terminal === "failed"
        ? (/^([a-z][a-z0-9_]{0,63}): /.exec(errorMessage)?.[1] ??
          "room_storage_transfer_failed")
        : null,
    errorMessage,
  };
}

// Runtime owns delivery coverage; successful action completion also requires
// verified adapter finalization. Adapter failure is not user cancellation.
export function roomStorageExecutionStatus(
  status: Row,
  job:
    | {
        status: string;
        errorCode: string | null;
        errorMessage?: string | null;
      }
    | null
    | undefined,
): Row {
  status = verifiedRoomDeliveryStatus(status);
  if (!job) return status;
  const publisher = object(status.publisher);
  const runtime = object(publisher.room_transfer);
  if (
    ["completed", "partial"].includes(text(runtime.status)) &&
    (!["completed", "partial"].includes(job.status) ||
      job.errorCode === "room_storage_cleanup_incomplete") &&
    (!job.errorCode || job.errorCode === "room_storage_cleanup_incomplete")
  ) {
    // Coverage can settle before the adapter's durable terminal write. Keep
    // the action polling until its independent resource fence can settle.
    return {
      ...status,
      publisher: {
        ...publisher,
        state: "active",
        room_transfer: { ...runtime, status: "in_progress" },
      },
    };
  }
  if (!job.errorCode) {
    // A partial job carries Beam's reason without an error code.
    if (!job.errorMessage || !["partial", "failed"].includes(job.status))
      return status;
    return {
      ...status,
      publisher: {
        ...publisher,
        room_transfer: { ...runtime, error_message: job.errorMessage },
      },
    };
  }
  const failure = job.errorCode !== "room_storage_cleanup_incomplete";
  return {
    ...status,
    publisher: {
      ...publisher,
      room_transfer: {
        ...runtime,
        ...(failure
          ? { status: job.status === "failed" ? "failed" : "in_progress" }
          : {}),
        error_code: job.errorCode,
        error_message: job.errorMessage || undefined,
      },
    },
  };
}

function authorizeAgentStoragePublication(input: {
  agentId: string;
  roomId: string;
  channelId: string;
  sourceMemberId: string;
  snapshot: Row;
  bindings: StorageBinding[];
}) {
  const memberships = records(input.snapshot.memberships);
  const channel = records(input.snapshot.channels).find(
    (candidate) =>
      text(candidate.channel_id) === input.channelId &&
      text(candidate.kind) === "object" &&
      text(candidate.state) === "active",
  );
  const initiator = memberships.find(
    (candidate) =>
      text(candidate.agent_id) === input.agentId &&
      text(candidate.state) === "active",
  );
  const source = memberships.find(
    (candidate) =>
      text(candidate.member_id) === input.sourceMemberId &&
      text(candidate.state) === "active",
  );
  if (!channel || !initiator || !source) {
    throw requestError(
      "room_storage_authorization_failed",
      "The initiating agent, source member, or object channel is unavailable.",
      403,
    );
  }
  const memberRoles = records(input.snapshot.member_roles);
  const grants = records(input.snapshot.grants);
  if (
    !memberHasAction(initiator, input.channelId, "publish", memberRoles, grants)
  ) {
    throw requestError(
      "room_storage_publish_denied",
      "The initiating room member does not have publish access.",
      403,
    );
  }
  if (
    !memberHasAction(source, input.channelId, "publish", memberRoles, grants)
  ) {
    throw requestError(
      "room_storage_source_publish_denied",
      "The source member does not have publish access.",
      403,
    );
  }
  if (text(source.kind) === "object_storage") {
    const binding = input.bindings.find(
      (candidate) =>
        candidate.coordinatorMemberId === input.sourceMemberId &&
        candidate.objectChannelIds.includes(input.channelId) &&
        candidate.availability === "available",
    );
    const initiatorRoles = new Set(
      memberRoles
        .filter(
          (assignment) =>
            text(assignment.member_id) === text(initiator.member_id) &&
            text(assignment.state) === "active",
        )
        .map((assignment) => text(assignment.role_id)),
    );
    if (
      !binding ||
      (!binding.sourceDelegateMemberIds.includes(text(initiator.member_id)) &&
        !binding.sourceDelegateRoleIds.some((roleId) =>
          initiatorRoles.has(roleId),
        ))
    ) {
      throw requestError(
        "room_storage_source_delegate_denied",
        "The initiating room member is not a source delegate for this bucket.",
        403,
      );
    }
  } else if (text(source.agent_id) !== input.agentId) {
    throw requestError(
      "room_storage_source_identity_mismatch",
      "An agent can publish a local path only as its own room member.",
      403,
    );
  }
  return { initiatorMemberId: text(initiator.member_id) };
}

function memberHasAction(
  member: Row,
  channelId: string,
  action: string,
  memberRoles: Row[],
  grants: Row[],
) {
  const roles = new Set(
    memberRoles
      .filter(
        (assignment) =>
          text(assignment.member_id) === text(member.member_id) &&
          text(assignment.state) === "active",
      )
      .map((assignment) => text(assignment.role_id)),
  );
  return grants.some(
    (grant) =>
      text(grant.channel_id) === channelId &&
      text(grant.state) === "active" &&
      strings(grant.actions).includes(action) &&
      ((text(grant.subject_type) === "member" &&
        text(grant.subject_id) === text(member.member_id)) ||
        (text(grant.subject_type) === "role" &&
          roles.has(text(grant.subject_id)))),
  );
}

function requestError(code: string, message: string, statusCode: number) {
  return Object.assign(new Error(message), { code, statusCode });
}

function roomPublicationId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let value = 0;
  let bits = 0;
  let suffix = "";
  for (const byte of randomBytes(16)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      suffix += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) suffix += alphabet[(value << (5 - bits)) & 31];
  return `btr_pub_${suffix}`;
}

function records(value: unknown): Row[] {
  const parsed = json(value);
  return Array.isArray(parsed)
    ? parsed.filter(
        (item): item is Row =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}
function strings(value: unknown): string[] {
  return json(value) instanceof Array
    ? (json(value) as unknown[]).map(text).filter(Boolean)
    : [];
}
function nullableObject(value: unknown): Row | null {
  const parsed = json(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Row)
    : null;
}
function object(value: unknown): Row {
  return nullableObject(value) ?? {};
}
function json(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function text(value: unknown) {
  return String(value ?? "").trim();
}
export function roomStorageSafeErrorCode(error: unknown) {
  const direct = object(error);
  const directCode = normalizedErrorCode(direct.code);
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const directMessage = text(direct.message);
  const nestedCode = nestedSafeErrorCode(directMessage || raw);
  if (directCode && !genericRoomStorageErrorCode(directCode)) {
    return directCode;
  }
  if (nestedCode) return nestedCode;
  if (directCode) return directCode;
  const rawCode = normalizedErrorCode(raw);
  if (rawCode) return rawCode;
  return "room_storage_transfer_failed";
}

function safeErrorCode(error: unknown) {
  return roomStorageSafeErrorCode(error);
}

function normalizedErrorCode(value: unknown) {
  const candidate = text(value);
  return /^[a-z0-9_-]{1,64}$/.test(candidate) ? candidate : "";
}
function genericRoomStorageErrorCode(value: string) {
  return [
    "command_failed",
    "request_error",
    "room_storage_agent_command_failed",
    "room_storage_command_failed",
    "room_storage_transfer_failed",
  ].includes(value);
}
function nestedSafeErrorCode(raw: string) {
  const jsonStart = raw.indexOf("{");
  if (jsonStart < 0) return "";
  const parsed = object(json(raw.slice(jsonStart)));
  const code = normalizedErrorCode(parsed.code);
  const error = normalizedErrorCode(parsed.error);
  if (error && genericRoomStorageErrorCode(code)) return error;
  return code || error || "";
}
export function roomStorageSafeErrorMessage(error: unknown) {
  const code = safeErrorCode(error);
  const direct = object(error);
  const directMessage = text(direct.message);
  const raw =
    directMessage ||
    (error instanceof Error ? error.message : String(error ?? ""));
  const jsonStart = raw.indexOf("{");
  if (jsonStart >= 0) {
    const parsed = object(json(raw.slice(jsonStart)));
    const parsedMessage = text(parsed.message);
    if (parsedMessage) {
      return redactRoomStorageErrorMessage(`${code}: ${parsedMessage}`);
    }
  }
  if (raw && raw !== code) return redactRoomStorageErrorMessage(raw);
  return code.replaceAll("_", " ").slice(0, 240);
}

function safeErrorMessage(error: unknown) {
  const message = roomStorageSafeErrorMessage(error);
  return object(error).cleanupIncomplete === true
    ? `${message}; provider cleanup could not be verified.`
    : message;
}

function redactRoomStorageErrorMessage(value: string) {
  const redacted = value
    .replace(/https?:\/\/[^\s"'<>)]*/gi, "[redacted-url]")
    .replace(
      /\b(authorization|bearer|access_key_id|secret_access_key|session_token|api_key|route_token|token|password|secret|x-amz-signature|x-amz-credential|x-amz-security-token)\b\s*[:=]\s*["']?[^"',\s<>&]*/gi,
      "$1=[redacted]",
    )
    .replace(/[A-Za-z0-9_-]{96,}/g, "[redacted-token]")
    .replace(/\s+/g, " ")
    .trim();
  return (redacted || "Room storage transfer failed.").slice(0, 500);
}
function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function roomStorageWorkerRouteBaseUrl(input?: {
  env?: NodeJS.ProcessEnv;
  transferStudioUrl?: string;
}) {
  const env = input?.env ?? process.env;
  const transferStudioUrl =
    input?.transferStudioUrl ?? webEnv.transferStudioUrl;
  const candidates = [
    env.BEAM_STUDIO_PUBLIC_API_URL,
    env.NEXT_PUBLIC_STUDIO_API_URL,
    env.VITE_STUDIO_API_URL,
    transferStudioUrl,
    env.BEAM_STUDIO_API_URL,
  ];
  for (const candidate of candidates) {
    const normalized = normalizePublicStudioApiBaseUrl(candidate);
    if (normalized) return normalized;
  }
  throw new Error("room_storage_public_api_url_unavailable");
}

function normalizePublicStudioApiBaseUrl(value: unknown) {
  const raw = text(value);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.hostname.startsWith("studio.")) {
      parsed.hostname = `api.${parsed.hostname}`;
    }
    if (parsed.protocol !== "https:" || !parsed.host) return "";
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "";
  }
}

function bearerToken(value: unknown) {
  const raw = text(value);
  const [scheme, token] = raw.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" ? token : "";
}
