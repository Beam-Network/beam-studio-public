import { settleRouteAuth } from "../auth/kernel.js";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  multipartPartNumber,
  completeMultipartUpload,
  createMultipartUpload,
  inspectDestinationObject,
  prepareProviderSource,
  signDestinationUrl,
  signSourceReadRange,
  type ProviderSourceConfig,
  type ProviderDestinationConfig,
} from "@beam-network/sdk";
import {
  WorkflowAuthorityUnavailableError,
  type PgPool,
} from "@beam-studio/db";
import { providerReturnsObjectMetadata } from "@beam-studio/shared";
import type { FastifyInstance } from "fastify";
import type { roomServiceForOrganization } from "./room-service.js";
import { abortRoomMultipartUpload } from "./room-multipart-cleanup.js";
import { CoordinatorRoomError } from "./coordinator-client.js";
import { verifiedRoomDeliveryStatus } from "./room-delivery-evidence.js";
import {
  artifactCopyCommandSource,
  assertArtifactCopyInspection,
  parseArtifactCopySourceLocator,
} from "./room-artifact-copy-source.js";
import { retainArtifactObjectVersion } from "./room-artifact-object-retention.js";
import { listRoomProviderParts, type VerifiedProviderPart } from "./room-provider-parts.js";
import { auth } from "../auth/policy.js";

type Row = Record<string, any>;
type Coordinator = Awaited<ReturnType<typeof roomServiceForOrganization>>;
export const HYBRID_SCHEMA = "room-storage-transfer/v2";
type FileLayout = {
  size_bytes: number;
  chunk_size_bytes: number;
  chunk_count: number;
  identity: string;
};
type Operation = {
  memberId: string;
  bindingId: string;
  objectKey: string;
  resource_id: string;
  operation_id: string;
  size_bytes: number;
  upload_id?: string;
  upload_creation_started?: boolean;
  etag?: string;
  version_id?: string;
};
export type HybridPreparation = {
  schema: typeof HYBRID_SCHEMA;
  expiresAt: string;
  filename: string;
  file: FileLayout;
  sourceKind: "agent" | "object_storage";
  sourceAgentId?: string;
  source?: Operation;
  sourceObject?: {
    size_bytes: number;
    etag?: string;
    version_id?: string;
    last_modified?: string;
  };
  targets: Operation[];
};
export type HybridJob = {
  id: string;
  organizationId: string;
  leaseOwner: string;
  environmentTemplateKey: string;
  roomId: string;
  channelId: string;
  publicationId: string;
  sourceMemberId: string;
  sourceLocator: Row;
  targetMemberIds: string[];
  ttlSeconds: number;
  allowPartial: boolean;
  coordinatorStarted: boolean;
  preparation: HybridPreparation | null;
  workflowRunId: string;
  workflowStepRunId: string;
};
type Context = {
  job: HybridJob;
  plan: HybridPreparation;
  coordinator: Coordinator;
  providers: Map<string, ProviderDestinationConfig>;
  pendingFinalization: Map<string, Promise<void>>;
  control: AbortController;
  fatalError?: unknown;
};
type Dependencies = {
  load(publicationId: string): Promise<{
    job: HybridJob;
    coordinator: Coordinator;
    bindings: Row[];
  } | null>;
  provider(
    organizationId: string,
    binding: any,
    key: string,
  ): Promise<ProviderDestinationConfig>;
  destination(
    job: HybridJob,
    binding: any,
    filename: string,
  ): Promise<{ objectKey: string; config: ProviderDestinationConfig }>;
  command(
    job: HybridJob,
    agentId: string,
    operation: "room.storage.source.inspect" | "room.storage.source.register",
    payload: Row,
    idempotencyKey: string,
  ): Promise<Row>;
  currentStatus(job: HybridJob): Promise<string>;
  authorize?(job: HybridJob): Promise<void>;
  recordFailure(job: HybridJob, error: unknown): Promise<void>;
  publicUrl(): string;
};

// This adapter only handles control metadata. Workers receive provider routes;
// agents receive coordinator assignments. No object bytes cross this service.
export class RoomStorageHybridAdapter {
  private readonly contexts = new Map<string, Promise<Context>>();
  constructor(
    private readonly pool: PgPool,
    private readonly deps: Dependencies,
  ) {}

  registerRoutes(server: FastifyInstance) {
    server.post(
      "/agent-control/v1/room-storage-routes",
      {
        config: { auth: auth.serviceSecret("BEAM_STUDIO_ROOM_STORAGE_TOKEN") },
        bodyLimit: 16_384,
      },
      async (request, reply) => {
        try {
          const body = validateStorageRouteRequest(request.body);
          const token = request.headers["x-beam-path-token"];
          if (typeof token !== "string" || !token)
            return reply
              .code(401)
              .send({ error: "room_storage_route_unauthorized" });
          // Presence-only locally: the coordinator makes the real decision when
          // the token is forwarded to it. Tracked separately.
          settleRouteAuth(request);
          const context = await this.context(body.transfer_id);
          if (!context)
            return reply
              .code(404)
              .send({ error: "room_storage_route_not_found" });
          const { job, coordinator, plan } = context;
          await this.deps.authorize?.(job);
          const authorized = await coordinator.client.storageControl(
            job.organizationId,
            job.roomId,
            job.channelId,
            job.publicationId,
            "authorize-route",
            {
              schema_version: HYBRID_SCHEMA,
              lease_id: body.lease_id,
              transfer_id: body.transfer_id,
              lane_id: body.lane_id,
              attempt: body.attempt,
              worker_id: body.worker_id,
              chunk_index: body.chunk_index,
              path_token: token,
            },
            coordinator.token,
          );
          const operation = authorized.operation as Row;
          const sourceRead = authorized.role === "source_read";
          const frozen = sourceRead
            ? plan.source
            : plan.targets.find(
                (target) => target.memberId === authorized.member_id,
              );
          if (!frozen || !sameOperation(frozen, operation))
            throw new Error("room_storage_operation_mismatch");
          const provider = context.providers.get(frozen.operation_id);
          if (!provider) throw new Error("room_storage_credential_unavailable");
          const expiresIn = storageRouteLifetime(
            String(authorized.expires_at),
            plan.expiresAt,
          );
          const offset = Number(authorized.offset),
            length = Number(authorized.length);
          if (
            offset !== body.chunk_index * plan.file.chunk_size_bytes ||
            length !==
              Math.min(
                plan.file.chunk_size_bytes,
                plan.file.size_bytes - offset,
              )
          ) {
            throw new Error("room_storage_range_mismatch");
          }
          const expiresAt = new Date(
            Date.now() + expiresIn * 1000,
          ).toISOString();
          if (sourceRead) {
            const signed = await signSourceReadRange({
              source: provider as ProviderSourceConfig,
              offset,
              length,
              expiresIn,
              ifMatch: frozen.etag,
              versionId: frozen.version_id,
            });
            requireTlsUrl(signed.url);
            return {
              chunk_index: body.chunk_index,
              offset,
              length,
              expires_at: expiresAt,
              endpoint: {
                method: "GET",
                url: signed.url,
                headers: signed.headers,
              },
            };
          }
          if (!body.content_md5)
            throw new Error("room_storage_checksum_required");
          const partNumber = multipartPartNumber(body.chunk_index, 0);
          const url = await signDestinationUrl({
            destination: provider,
            objectKey: frozen.objectKey,
            uploadId: frozen.upload_id,
            partNumber,
            expiresIn,
            contentMd5: body.content_md5,
          });
          requireTlsUrl(url);
          return {
            chunk_index: body.chunk_index,
            offset,
            length,
            expires_at: expiresAt,
            part_number: partNumber,
            upload_id: frozen.upload_id,
            endpoint: {
              method: "PUT",
              url,
              headers: { "Content-MD5": body.content_md5 },
            },
          };
        } catch (error) {
          // Provider errors may carry signed request URLs. Never serialize them.
          return reply.code(409).send({ error: safeHybridCode(error) });
        }
      },
    );
  }

  private async context(publicationId: string): Promise<Context | null> {
    const existing = this.contexts.get(publicationId);
    if (existing) return existing;
    const loaded = await this.deps.load(publicationId);
    if (!loaded || !loaded.job.preparation) return null;
    const pending = this.hydrate(
      loaded.job,
      loaded.coordinator,
      loaded.bindings,
    );
    this.contexts.set(publicationId, pending);
    try {
      return await pending;
    } catch (error) {
      this.contexts.delete(publicationId);
      throw error;
    }
  }

  private async hydrate(
    job: HybridJob,
    coordinator: Coordinator,
    bindings: Row[],
  ): Promise<Context> {
    const plan = job.preparation;
    if (!plan || plan.schema !== HYBRID_SCHEMA)
      throw new Error("room_storage_preparation_invalid");
    const providers = new Map<string, ProviderDestinationConfig>();
    await Promise.all(
      [...(plan.source ? [plan.source] : []), ...plan.targets].map(
        async (operation) => {
          const binding = bindings.find(
            (candidate) =>
              candidate.id === operation.bindingId &&
              candidate.resourceId === operation.resource_id,
          );
          if (!binding) throw new Error("room_storage_binding_unavailable");
          providers.set(
            operation.operation_id,
            await this.deps.provider(
              job.organizationId,
              binding,
              operation.objectKey,
            ),
          );
        },
      ),
    );
    return {
      job,
      plan,
      coordinator,
      providers,
      pendingFinalization: new Map(),
      control: new AbortController(),
    };
  }

  async execute(
    job: HybridJob,
    coordinator: Coordinator,
    source: Row,
    targets: Row[],
    bindings: Row[],
    ownershipSignal: AbortSignal,
  ) {
    ownershipSignal.throwIfAborted();
    if (!job.preparation)
      await this.prepare(job, coordinator, source, targets, bindings);
    const contextPromise = this.hydrate(job, coordinator, bindings);
    this.contexts.set(job.publicationId, contextPromise);
    const context = await contextPromise;
    const lostOwnership = () => context.control.abort(ownershipSignal.reason);
    ownershipSignal.addEventListener("abort", lostOwnership, { once: true });
    if (ownershipSignal.aborted) lostOwnership();
    try {
      if ((await this.deps.currentStatus(job)) === "cancel_requested") {
        await this.cancel(context);
        return;
      }
      await this.deps.authorize?.(job);
      ownershipSignal.throwIfAborted();
      await this.ensureMultipart(context);
      const { plan } = context;
      if (!job.coordinatorStarted) {
        context.control.signal.throwIfAborted();
        await this.deps.authorize?.(job);
        if (plan.sourceKind === "agent") {
          const artifactCopy =
            job.sourceLocator.type === "artifact_copy"
              ? parseArtifactCopySourceLocator(job.sourceLocator)
              : null;
          await this.deps.command(
            job,
            plan.sourceAgentId!,
            "room.storage.source.register",
            {
              ...(artifactCopy
                ? { artifact_copy: artifactCopyCommandSource(artifactCopy) }
                : { path: job.sourceLocator.path }),
              publication_id: job.publicationId,
              file: plan.file,
              expires_at: plan.expiresAt,
            },
            `room-storage:${job.id}:source:register`,
          );
        }
        context.control.signal.throwIfAborted();
        await this.deps.authorize?.(job);
        await coordinator.client.startOrganizationStorageTransfer(
          job.organizationId,
          job.roomId,
          job.channelId,
          {
            schema_version: HYBRID_SCHEMA,
            publication_id: job.publicationId,
            source_member_id: job.sourceMemberId,
            target_member_ids: job.targetMemberIds,
            filename: plan.filename,
            file: plan.file,
            source_object: plan.sourceObject,
            source_storage: plan.source
              ? endpointIdentity(plan.source)
              : undefined,
            target_storage: Object.fromEntries(
              plan.targets.map((target) => [
                target.memberId,
                endpointIdentity(target),
              ]),
            ),
            storage_adapter_url: this.deps.publicUrl(),
            ttl_seconds: Math.max(
              1,
              Math.floor((Date.parse(plan.expiresAt) - Date.now()) / 1000),
            ),
            allow_partial: job.allowPartial,
            studio_workflow_run_id: job.workflowRunId || undefined,
            studio_workflow_step_run_id: job.workflowStepRunId || undefined,
          },
          `room-storage:${job.id}:start`,
          coordinator.token,
        );
        job.coordinatorStarted = true;
        const started = await this.pool.query(
          `UPDATE studio.room_storage_transfer_jobs SET coordinator_started=true, transfer_id=$2,
          status=CASE WHEN status='cancel_requested' THEN status ELSE 'running' END, updated_at=now() WHERE id=$1 AND lease_owner=$3 AND lease_expires_at>now() RETURNING id`,
          [job.id, job.publicationId, job.leaseOwner],
        );
        if (started.rowCount !== 1)
          throw new Error("room_storage_job_lease_lost");
      }
      for (;;) {
        ownershipSignal.throwIfAborted();
        if ((await this.deps.currentStatus(job)) === "cancel_requested") {
          await this.cancel(context);
          return;
        }
        await this.deps.authorize?.(job);
        if (context.fatalError) throw context.fatalError;
        let observations: [Row, Row];
        try {
          observations = await Promise.all([
            coordinator.client.organizationObjectStatus(
              job.organizationId,
              job.roomId,
              job.channelId,
              job.publicationId,
              coordinator.token,
            ),
            coordinator.client.organizationObjectExecution(
              job.organizationId,
              job.roomId,
              job.channelId,
              job.publicationId,
              coordinator.token,
            ),
          ]);
        } catch (error) {
          // A recovering coordinator must not turn durable worker coverage into
          // a failed publication or abort its existing multipart sessions.
          if (
            !retryableCoordinatorControlError(error) ||
            Date.now() >= Date.parse(plan.expiresAt) + 10_000
          )
            throw error;
          await delay(1000, undefined, { signal: context.control.signal });
          continue;
        }
        const [statusResponse, evidenceResponse] = observations;
        const status = verifiedRoomDeliveryStatus(statusResponse.status as Row);
        const evidence = evidenceResponse.execution as Row;
        if (!status || !evidence)
          throw new Error("room_storage_runtime_evidence_unavailable");
        const runtime = ((status.publisher as Row)?.room_transfer ??
          status.room_transfer) as Row;
        const state = String(runtime?.status ?? "pending");
        if (state === "in_progress" || state === "pending") {
          for (const target of plan.targets) {
            if (context.pendingFinalization.has(target.memberId)) continue;
            void this.verifyTarget(context, target, evidence).catch((error) => {
              if (
                !context.control.signal.aborted &&
                !retryableProviderControlError(error) &&
                !retryableCoordinatorControlError(error)
              )
                context.fatalError = error;
            });
          }
        }
        if (["completed", "partial", "failed", "cancelled"].includes(state)) {
          await this.stopFinalization(context);
          const cleanup = await this.abortUnfinished(context, evidence);
          await this.pool.query(
            `UPDATE studio.room_storage_transfer_jobs SET status=$2, execution_json=$3::jsonb,
            error_code=$4, lease_owner=NULL, lease_expires_at=NULL, updated_at=now() WHERE id=$1 AND lease_owner=$5 AND lease_expires_at>now()`,
            [
              job.id,
              state,
              JSON.stringify(evidence),
              cleanup.length ? "room_storage_cleanup_incomplete" : null,
              job.leaseOwner,
            ],
          );
          return;
        }
        if (Date.now() >= Date.parse(plan.expiresAt) + 10_000)
          throw new Error("room_storage_execution_expired");
        await delay(1000, undefined, { signal: context.control.signal });
      }
    } catch (error) {
      await this.stopFinalization(context);
      if (
        ownershipSignal.aborted ||
        (error as Error)?.message === "room_storage_job_lease_lost"
      )
        return;
      if (error instanceof WorkflowAuthorityUnavailableError) throw error;
      // Record the cause before revocation so status polling cannot mistake
      // this failure for a user cancellation while cleanup is in progress.
      await this.deps.recordFailure(job, error);
      let cleanupIncomplete = false;
      if (job.coordinatorStarted) {
        try {
          await coordinator.client.cancelOrganizationStorageTransfer(
            job.organizationId,
            job.roomId,
            job.channelId,
            job.publicationId,
            `room-storage:${job.id}:failed`,
            coordinator.token,
          );
        } catch {
          cleanupIncomplete = true;
        }
      }
      const cleanup = await this.abortUnfinished(context);
      if (cleanup.length || cleanupIncomplete) {
        throw Object.assign(
          error instanceof Error
            ? error
            : new Error("room_storage_transfer_failed"),
          {
            cleanupIncomplete: true,
          },
        );
      }
      throw error;
    } finally {
      ownershipSignal.removeEventListener("abort", lostOwnership);
      await this.stopFinalization(context);
      this.contexts.delete(job.publicationId);
    }
  }

  private async prepare(
    job: HybridJob,
    coordinator: Coordinator,
    source: Row,
    targets: Row[],
    bindings: Row[],
  ) {
    let size: number,
      identity: string,
      filename: string,
      sourceOperation: Operation | undefined;
    let sourceObject: HybridPreparation["sourceObject"];
    if (source.kind === "object_storage") {
      const binding = bindings.find(
        (candidate) => candidate.coordinatorMemberId === job.sourceMemberId,
      );
      if (!binding || job.sourceLocator.type !== "bucket_object")
        throw new Error("room_storage_source_binding_unavailable");
      const key = String(job.sourceLocator.objectKey);
      const config = await this.deps.provider(job.organizationId, binding, key);
      const head = await prepareProviderSource(config, { expiresIn: 60 });
      size = head.size;
      filename = head.filename || key.split("/").pop() || "object";
      sourceObject = {
        size_bytes: size,
        etag: String(head.metadata?.etag ?? "") || undefined,
        version_id: String(head.metadata?.version_id ?? "") || undefined,
        last_modified: String(head.metadata?.last_modified ?? "") || undefined,
      };
      if (!sourceObject.etag && !sourceObject.version_id)
        throw new Error("room_storage_source_identity_unavailable");
      identity = createHash("sha256")
        .update(JSON.stringify(sourceObject))
        .digest("hex");
      sourceOperation = {
        memberId: job.sourceMemberId,
        bindingId: binding.id,
        objectKey: key,
        resource_id: binding.resourceId,
        operation_id: randomUUID(),
        size_bytes: size,
        etag: sourceObject.etag,
        version_id: sourceObject.version_id,
      };
    } else {
      if (
        job.sourceLocator.type !== "agent_path" &&
        job.sourceLocator.type !== "artifact_copy"
      )
        throw new Error("room_storage_source_locator_invalid");
      const artifactCopy =
        job.sourceLocator.type === "artifact_copy"
          ? parseArtifactCopySourceLocator(job.sourceLocator)
          : null;
      const result = await this.deps.command(
        job,
        String(source.agent_id),
        "room.storage.source.inspect",
        artifactCopy
          ? { artifact_copy: artifactCopyCommandSource(artifactCopy) }
          : { path: job.sourceLocator.path },
        `room-storage:${job.id}:source:inspect`,
      );
      if (artifactCopy) assertArtifactCopyInspection(artifactCopy, result);
      size = Number(result.source?.file?.size_bytes);
      identity = String(result.source?.file?.identity ?? "");
      filename = String(result.source?.filename ?? "object");
    }
    if (!Number.isSafeInteger(size) || size <= 0 || !identity)
      throw new Error("room_storage_source_invalid");
    const chunking = await coordinator.client.storageControl(
      job.organizationId,
      job.roomId,
      job.channelId,
      null,
      "plan",
      {
        size_bytes: size,
        storage_destination_providers: targets
          .filter((target) => target.kind === "object_storage")
          .map(
            (target) =>
              bindings.find(
                (binding) => binding.coordinatorMemberId === target.member_id,
              )?.providerProfileId,
          ),
      },
      coordinator.token,
    );
    const file = {
      size_bytes: size,
      identity,
      chunk_size_bytes: Number(chunking.chunk_size_bytes),
      chunk_count: Number(chunking.chunk_count),
    };
    if (file.chunk_count !== Math.ceil(size / file.chunk_size_bytes))
      throw new Error("room_storage_chunk_policy_invalid");
    const operations = await Promise.all(
      targets
        .filter((target) => target.kind === "object_storage")
        .map(async (target) => {
          const binding = bindings.find(
            (candidate) => candidate.coordinatorMemberId === target.member_id,
          );
          if (!binding)
            throw new Error("room_storage_target_binding_unavailable");
          const { objectKey } = await this.deps.destination(
            job,
            binding,
            filename,
          );
          return {
            memberId: String(target.member_id),
            bindingId: binding.id,
            objectKey,
            resource_id: binding.resourceId,
            operation_id: randomUUID(),
            size_bytes: size,
          } as Operation;
        }),
    );
    const expiresAt = new Date(Date.now() + job.ttlSeconds * 1000);
    if (job.sourceLocator.type === "artifact_copy") {
      const locator = parseArtifactCopySourceLocator(job.sourceLocator);
      const retainedUntil = Date.parse(locator.requiredUntil);
      if (retainedUntil <= Date.now() + 15_000)
        throw new Error("room_storage_artifact_retention_expiring");
      if (expiresAt.getTime() > retainedUntil) expiresAt.setTime(retainedUntil);
    }
    job.preparation = {
      schema: HYBRID_SCHEMA,
      expiresAt: expiresAt.toISOString(),
      filename,
      file,
      sourceKind: source.kind === "object_storage" ? "object_storage" : "agent",
      sourceAgentId:
        source.kind === "agent" ? String(source.agent_id) : undefined,
      source: sourceOperation,
      sourceObject,
      targets: operations,
    };
    await this.savePreparation(job);
  }

  private async ensureMultipart(context: Context) {
    for (const target of context.plan.targets) {
      context.control.signal.throwIfAborted();
      if (!target.upload_id) {
        // A provider create has no idempotency token. An interrupted response is
        // ambiguous: retain its durable intent and report cleanup, never create
        // a second untracked upload or claim the first one was aborted.
        if (target.upload_creation_started)
          throw new Error("room_storage_cleanup_incomplete");
        target.upload_creation_started = true;
        await this.savePreparation(context.job);
        target.upload_id = await createMultipartUpload({
          destination: context.providers.get(target.operation_id)!,
          objectKey: target.objectKey,
          metadata: {
            "beam-room-publication-id": context.job.publicationId,
            "beam-room-operation-id": target.operation_id,
          },
          signal: providerControlSignal(context),
        });
      }
      // Persist the known provider identity and session in one transaction. This
      // also repairs a missing session row without creating another upload.
      const result = await this.pool.query(
        `WITH owned AS (
          UPDATE studio.room_storage_transfer_jobs SET preparation_json=$2::jsonb, file_json=$3::jsonb, updated_at=now()
          WHERE id=$1 AND lease_owner=$4 AND lease_expires_at>now() RETURNING id
        ) INSERT INTO studio.room_storage_multipart_sessions
        (id, organization_id, binding_id, target_member_id, publication_id, child_execution_id, multipart_group_id,
         object_key, upload_id, parts_json, state, expires_at)
        SELECT $5,$6,$7,$8,$9,$10,$5,$11,$12,'{}'::jsonb,'active',$13 FROM owned
        ON CONFLICT (organization_id, child_execution_id) DO UPDATE SET updated_at=now()
        WHERE room_storage_multipart_sessions.upload_id=EXCLUDED.upload_id
          AND room_storage_multipart_sessions.multipart_group_id=EXCLUDED.multipart_group_id
        RETURNING id`,
        [
          context.job.id,
          JSON.stringify(context.plan),
          JSON.stringify(context.plan.file),
          context.job.leaseOwner,
          target.operation_id,
          context.job.organizationId,
          target.bindingId,
          target.memberId,
          context.job.publicationId,
          `${context.job.publicationId}:${target.memberId}`,
          target.objectKey,
          target.upload_id,
          context.plan.expiresAt,
        ],
      );
      if (result.rowCount !== 1) throw new Error("room_storage_job_lease_lost");
    }
  }

  private async savePreparation(job: HybridJob) {
    const saved = await this.pool.query(
      `UPDATE studio.room_storage_transfer_jobs SET preparation_json=$2::jsonb, file_json=$3::jsonb,
      updated_at=now() WHERE id=$1 AND lease_owner=$4 AND lease_expires_at>now() RETURNING id`,
      [
        job.id,
        JSON.stringify(job.preparation),
        JSON.stringify(job.preparation!.file),
        job.leaseOwner,
      ],
    );
    if (saved.rowCount !== 1) throw new Error("room_storage_job_lease_lost");
  }

  private async verifyTarget(
    context: Context,
    target: Operation,
    evidence: Row,
  ) {
    const existing = context.pendingFinalization.get(target.memberId);
    if (existing) return existing;
    const pending = this.auditAndFinalize(context, target, evidence);
    context.pendingFinalization.set(target.memberId, pending);
    try {
      await pending;
    } finally {
      context.pendingFinalization.delete(target.memberId);
    }
  }

  private async auditAndFinalize(
    context: Context,
    target: Operation,
    evidence: Row,
  ) {
    const result = (evidence.targets as Row[]).find(
      (candidate) => candidate.member_id === target.memberId,
    );
    if (
      !result ||
      result.state === "completed" ||
      result.state === "unavailable"
    )
      return;
    const receipts = (result.provider_results ?? []) as Row[];
    if (!receipts.length) return;
    const { job, plan, coordinator } = context,
      provider = context.providers.get(target.operation_id)!;
    context.control.signal.throwIfAborted();
    const control = (operation: "audit" | "finalize", input: Row) => {
      context.control.signal.throwIfAborted();
      return coordinator.client.storageControl(
        job.organizationId,
        job.roomId,
        job.channelId,
        job.publicationId,
        operation,
        {
          schema_version: HYBRID_SCHEMA,
          target_member_id: target.memberId,
          operation_id: target.operation_id,
          upload_id: target.upload_id,
          ...input,
        },
        coordinator.token,
      );
    };
    let finalHead:
      | Awaited<ReturnType<typeof inspectDestinationObject>>
      | undefined;
    let parts: VerifiedProviderPart[];
    try {
      parts = await listRoomProviderParts(
        provider,
        target.objectKey,
        target.upload_id!,
        providerControlSignal(context),
      );
    } catch (error) {
      if ((error as Row)?.name !== "NoSuchUpload") throw error;
      // Completion can succeed immediately before a process crash. Verify the
      // durable operation marker before accepting the already finalized object.
      finalHead = await inspectDestinationObject(
        provider,
        target.objectKey,
        providerControlSignal(context),
      );
      verifyFinalObject(
        provider,
        finalHead,
        target.operation_id,
        plan.file.size_bytes,
      );
      const stored = await this.pool.query<Row>(
        `SELECT parts_json FROM studio.room_storage_multipart_sessions
        WHERE organization_id=$1 AND multipart_group_id=$2`,
        [job.organizationId, target.operation_id],
      );
      const verified = stored.rows[0]?.parts_json;
      if (
        !verified ||
        verified.manifest !== storageManifest(plan.file, receipts) ||
        !Array.isArray(verified.parts)
      )
        throw new Error("room_storage_verified_manifest_unavailable");
      parts = verified.parts;
    }
    const audits = verifyProviderParts(plan.file, target, receipts, parts);
    await control("audit", { parts: audits });
    if (
      audits.length !== plan.file.chunk_count ||
      audits.some((part) => !part.verified)
    )
      return;
    if (!finalHead) {
      const saved = await this.pool.query(
        `UPDATE studio.room_storage_multipart_sessions SET parts_json=$3::jsonb, updated_at=now()
        WHERE organization_id=$1 AND multipart_group_id=$2
          AND EXISTS (SELECT 1 FROM studio.room_storage_transfer_jobs WHERE id=$4 AND lease_owner=$5 AND lease_expires_at>now())
        RETURNING id`,
        [
          job.organizationId,
          target.operation_id,
          JSON.stringify({
            manifest: storageManifest(plan.file, receipts),
            parts,
            receipts,
          }),
          job.id,
          job.leaseOwner,
        ],
      );
      if (saved.rowCount !== 1) throw new Error("room_storage_job_lease_lost");
      await completeMultipartUpload({
        destination: provider,
        objectKey: target.objectKey,
        uploadId: target.upload_id!,
        signal: providerControlSignal(context),
        parts: receipts.map((receipt) => ({
          partNumber: receipt.part_number,
          etag: receipt.etag,
        })),
      });
      finalHead = await inspectDestinationObject(
        provider,
        target.objectKey,
        providerControlSignal(context),
      );
    }
    verifyFinalObject(
      provider,
      finalHead,
      target.operation_id,
      plan.file.size_bytes,
    );
    if (job.sourceLocator.type === "artifact_copy") {
      const locator = parseArtifactCopySourceLocator(job.sourceLocator);
      await retainArtifactObjectVersion(
        provider,
        target.objectKey,
        finalHead.versionId,
        locator.requiredUntil,
        providerControlSignal(context),
      );
    }
    // Record provider completion before coordinator acknowledgement. Cancellation
    // may revoke publication work while this acknowledgement is in flight.
    const recorded = await this.pool.query(
      `UPDATE studio.room_storage_multipart_sessions SET state='completed',
       parts_json=parts_json || jsonb_build_object('finalObject',$3::jsonb), updated_at=now()
       WHERE organization_id=$1 AND multipart_group_id=$2
         AND EXISTS (SELECT 1 FROM studio.room_storage_transfer_jobs WHERE id=$4 AND lease_owner=$5 AND lease_expires_at>now())
       RETURNING id`,
      [
        job.organizationId,
        target.operation_id,
        JSON.stringify({
          size: finalHead.size,
          etag: finalHead.etag,
          versionId: finalHead.versionId,
        }),
        job.id,
        job.leaseOwner,
      ],
    );
    if (recorded.rowCount !== 1) throw new Error("room_storage_job_lease_lost");
    await control("finalize", {
      file_size_bytes: plan.file.size_bytes,
      manifest_sha256: storageManifest(plan.file, receipts),
      etag: finalHead.etag,
      version_id: finalHead.versionId,
    });
  }

  private async reconcileFinalizedTarget(
    context: Context,
    target: Operation,
    evidence?: Row,
  ) {
    const provider = context.providers.get(target.operation_id)!;
    const signal = AbortSignal.timeout(15_000);
    try {
      await listRoomProviderParts(
        provider,
        target.objectKey,
        target.upload_id!,
        signal,
      );
      return false;
    } catch (error) {
      if ((error as Error)?.name !== "NoSuchUpload") throw error;
    }
    let head: Awaited<ReturnType<typeof inspectDestinationObject>>;
    try {
      head = await inspectDestinationObject(provider, target.objectKey, signal);
    } catch (error) {
      if (["NotFound", "NoSuchKey"].includes((error as Error)?.name))
        return false;
      throw error;
    }
    const stored = await this.pool.query<Row>(
      `SELECT parts_json FROM studio.room_storage_multipart_sessions
       WHERE organization_id=$1 AND multipart_group_id=$2 AND upload_id=$3`,
      [context.job.organizationId, target.operation_id, target.upload_id],
    );
    const verified = stored.rows[0]?.parts_json;
    const result = ((evidence?.targets ?? []) as Row[]).find(
      (candidate) => candidate.member_id === target.memberId,
    );
    const receipts = verified?.receipts ?? result?.provider_results;
    if (
      !verified ||
      !Array.isArray(receipts) ||
      !Array.isArray(verified.parts) ||
      verified.manifest !== storageManifest(context.plan.file, receipts)
    ) {
      throw new Error("room_storage_cleanup_incomplete");
    }
    const audits = verifyProviderParts(
      context.plan.file,
      target,
      receipts,
      verified.parts,
    );
    if (
      audits.length !== context.plan.file.chunk_count ||
      audits.some((part) => !part.verified)
    ) {
      throw new Error("room_storage_cleanup_incomplete");
    }
    verifyFinalObject(
      provider,
      head,
      target.operation_id,
      context.plan.file.size_bytes,
    );
    if (context.job.sourceLocator.type === "artifact_copy") {
      const locator = parseArtifactCopySourceLocator(context.job.sourceLocator);
      await retainArtifactObjectVersion(
        provider,
        target.objectKey,
        head.versionId,
        locator.requiredUntil,
        signal,
      );
    }
    const saved = await this.pool.query(
      `UPDATE studio.room_storage_multipart_sessions SET state='completed',
       parts_json=parts_json || jsonb_build_object('finalObject',$3::jsonb), updated_at=now()
       WHERE organization_id=$1 AND multipart_group_id=$2 AND upload_id=$4
         AND EXISTS (SELECT 1 FROM studio.room_storage_transfer_jobs WHERE id=$5 AND lease_owner=$6 AND lease_expires_at>now())
       RETURNING id`,
      [
        context.job.organizationId,
        target.operation_id,
        JSON.stringify({
          size: head.size,
          etag: head.etag,
          versionId: head.versionId,
        }),
        target.upload_id,
        context.job.id,
        context.job.leaseOwner,
      ],
    );
    if (saved.rowCount !== 1) throw new Error("room_storage_job_lease_lost");
    return true;
  }

  private async abortUnfinished(context: Context, evidence?: Row) {
    if (!evidence && context.job.coordinatorStarted) {
      try {
        evidence = (
          await context.coordinator.client.organizationObjectExecution(
            context.job.organizationId,
            context.job.roomId,
            context.job.channelId,
            context.job.publicationId,
            context.coordinator.token,
          )
        ).execution as Row;
      } catch {
        /* Durable completed sessions below still prevent destructive cleanup. */
      }
    }
    const completed = new Set(
      ((evidence?.targets ?? []) as Row[])
        .filter((target) => target.state === "completed")
        .map((target) => target.member_id),
    );
    const sessions = await this.pool.query<Row>(
      `SELECT multipart_group_id FROM studio.room_storage_multipart_sessions
       WHERE organization_id=$1 AND publication_id=$2 AND state='completed'`,
      [context.job.organizationId, context.job.publicationId],
    );
    const finalized = new Set(
      sessions.rows.map((row) => row.multipart_group_id),
    );
    const failures: string[] = [];
    await Promise.all(
      context.plan.targets.map(async (target) => {
        if (
          completed.has(target.memberId) ||
          finalized.has(target.operation_id)
        )
          return;
        if (!target.upload_id) {
          if (target.upload_creation_started) failures.push(target.memberId);
          return;
        }
        try {
          await abortRoomMultipartUpload({
            destination: context.providers.get(target.operation_id)!,
            objectKey: target.objectKey,
            uploadId: target.upload_id,
            metadata: { "beam-room-operation-id": target.operation_id },
            signal: AbortSignal.timeout(15_000),
          });
          await this.pool.query(
            `UPDATE studio.room_storage_multipart_sessions SET state='aborted', updated_at=now()
          WHERE organization_id=$1 AND multipart_group_id=$2 AND state='active'`,
            [context.job.organizationId, target.operation_id],
          );
        } catch {
          // Complete can win after the first ListParts probe or Abort response.
          // Reconcile that race with durable provider evidence, never delete it.
          try {
            if (await this.reconcileFinalizedTarget(context, target, evidence))
              return;
          } catch {
            /* Keep uncertain cleanup explicit and retryable. */
          }
          failures.push(target.memberId);
        }
      }),
    );
    return failures;
  }

  private async stopFinalization(context: Context) {
    context.control.abort();
    await Promise.allSettled(context.pendingFinalization.values());
  }

  private async cancel(context: Context) {
    context.control.abort();
    const { job, coordinator } = context;
    let revoked = !job.coordinatorStarted;
    if (job.coordinatorStarted) {
      try {
        await coordinator.client.cancelOrganizationStorageTransfer(
          job.organizationId,
          job.roomId,
          job.channelId,
          job.publicationId,
          `room-storage:${job.id}:cancel`,
          coordinator.token,
        );
        revoked = true;
      } catch {
        // A lost acknowledgement may follow successful cancellation or delivery.
        // Read the durable publication before deciding whether cleanup is safe.
        try {
          const response = await coordinator.client.organizationObjectStatus(
            job.organizationId,
            job.roomId,
            job.channelId,
            job.publicationId,
            coordinator.token,
          );
          const status = response.status as Row;
          revoked = [
            "completed",
            "partial",
            "failed",
            "cancelled",
            "expired",
          ].includes(
            String(
              status?.publisher?.room_transfer?.status ??
                status?.room_transfer?.status,
            ),
          );
        } catch {
          /* Uncertain revocation cannot be reported as confirmed. */
        }
      }
    }
    await this.stopFinalization(context);
    // Do not abort provider uploads while Runtime may still be assigning work.
    const failures = revoked
      ? await this.abortUnfinished(context)
      : ["revocation_pending"];
    const pending = failures.length > 0;
    await this.pool.query(
      `UPDATE studio.room_storage_transfer_jobs SET status=CASE WHEN $4 THEN 'cancel_requested' ELSE 'cancelled' END, error_code=$2,
      error_message=CASE WHEN $4 THEN 'Cancellation cleanup is awaiting reconciliation.' ELSE NULL END,
      lease_owner=NULL, lease_expires_at=CASE WHEN $4 THEN now()+interval '5 seconds' ELSE NULL END,
      updated_at=now() WHERE id=$1 AND lease_owner=$3 AND lease_expires_at>now()`,
      [
        job.id,
        pending ? "room_storage_cleanup_incomplete" : null,
        job.leaseOwner,
        pending,
      ],
    );
  }
}

export function verifyFinalObject(
  provider: ProviderDestinationConfig,
  head: Awaited<ReturnType<typeof inspectDestinationObject>>,
  operationId: string,
  size: number,
) {
  if (
    head.size !== size ||
    !head.etag ||
    (providerReturnsObjectMetadata(
      provider.provider,
      (provider as Row).endpoint_url,
    ) &&
      head.metadata["beam-room-operation-id"] !== operationId)
  ) {
    throw new Error("room_storage_final_identity_mismatch");
  }
}

function endpointIdentity(operation: Operation) {
  const { resource_id, operation_id, size_bytes, upload_id, etag, version_id } =
    operation;
  return { resource_id, operation_id, size_bytes, upload_id, etag, version_id };
}
function sameOperation(frozen: Operation, received: Row) {
  return [
    "resource_id",
    "operation_id",
    "size_bytes",
    "upload_id",
    "etag",
    "version_id",
  ].every(
    (key) =>
      ((frozen as unknown as Row)[key] ?? undefined) ===
      (received[key] ?? undefined),
  );
}
export function storageRouteLifetime(
  leaseExpiry: string,
  publicationExpiry: string,
) {
  const ttl = Math.min(
    60,
    Math.floor(
      (Math.min(Date.parse(leaseExpiry), Date.parse(publicationExpiry)) -
        Date.now()) /
        1000,
    ),
  );
  if (!Number.isFinite(ttl) || ttl < 1)
    throw new Error("room_storage_route_expired");
  return ttl;
}
export function validateStorageRouteRequest(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("room_storage_route_invalid");
  const body = value as Row;
  const keys = [
    "schema_version",
    "lease_id",
    "transfer_id",
    "lane_id",
    "attempt",
    "worker_id",
    "chunk_index",
    "content_md5",
  ];
  if (
    Object.keys(body).some((key) => !keys.includes(key)) ||
    body.schema_version !== HYBRID_SCHEMA ||
    ["lease_id", "transfer_id", "lane_id", "worker_id"].some(
      (key) => typeof body[key] !== "string" || !body[key],
    ) ||
    !Number.isSafeInteger(body.attempt) ||
    body.attempt < 1 ||
    !Number.isSafeInteger(body.chunk_index) ||
    body.chunk_index < 0 ||
    (body.content_md5 !== undefined &&
      (typeof body.content_md5 !== "string" ||
        !/^[A-Za-z0-9+/]{22}==$/.test(body.content_md5)))
  )
    throw new Error("room_storage_route_invalid");
  return body;
}
export function verifyProviderParts(
  file: FileLayout,
  operation: Pick<Operation, "upload_id">,
  receipts: Row[],
  parts: VerifiedProviderPart[],
): {chunk_index: number; lease_id: string; etag: string; range_sha256: string;
    verified: boolean; uploaded_at?: string; reason?: string}[] {
  const byNumber = new Map(parts.map((part) => [part.partNumber, part]));
  const seen = new Set<number>();
  return receipts.map((receipt) => {
    const index = Number(receipt.chunk_index),
      part = byNumber.get(receipt.part_number);
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= file.chunk_count ||
      seen.has(index) ||
      receipt.upload_id !== operation.upload_id ||
      !Number.isSafeInteger(receipt.part_number) ||
      receipt.part_number !== index + 1
    )
      throw new Error("room_storage_receipt_invalid");
    seen.add(index);
    const verified = Boolean(
      part &&
      stripQuotes(part.etag) === stripQuotes(receipt.etag) &&
      part.size ===
        Math.min(
          file.chunk_size_bytes,
          file.size_bytes - index * file.chunk_size_bytes,
        ),
    );
    return {
      chunk_index: index,
      lease_id: receipt.lease_id,
      etag: receipt.etag,
      range_sha256: receipt.range_sha256,
      verified,
      ...(verified
        ? (part?.uploadedAt && Number.isFinite(Date.parse(part.uploadedAt))
          ? { uploaded_at: new Date(part.uploadedAt).toISOString() } : {})
        : { reason: !part ? "part_not_listed"
          : stripQuotes(part.etag) !== stripQuotes(receipt.etag) ? "etag_mismatch" : "size_mismatch" }),
    };
  });
}
export function storageManifest(file: FileLayout, receipts: Row[]) {
  const hash = createHash("sha256").update(
    `beam:room-file-manifest\0${file.size_bytes}\n`,
  );
  const sorted = [...receipts].sort((a, b) => a.chunk_index - b.chunk_index);
  sorted.forEach((receipt, index) => {
    if (
      receipt.chunk_index !== index ||
      !/^[a-f0-9]{64}$/.test(receipt.range_sha256)
    )
      throw new Error("room_storage_manifest_invalid");
    hash.update(
      `${index}\n${index * file.chunk_size_bytes}\n${Math.min(file.chunk_size_bytes, file.size_bytes - index * file.chunk_size_bytes)}\n${receipt.range_sha256}\n`,
    );
  });
  if (sorted.length !== file.chunk_count)
    throw new Error("room_storage_manifest_incomplete");
  return hash.digest("hex");
}
function stripQuotes(value: string) {
  return String(value).replace(/^"|"$/g, "");
}
function requireTlsUrl(raw: string) {
  if (new URL(raw).protocol !== "https:")
    throw new Error("room_storage_provider_tls_required");
}
function safeHybridCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /^room_[a-z_]+$/.test(message)
    ? message
    : "room_storage_route_unavailable";
}

function providerControlSignal(context: Context) {
  return AbortSignal.any([context.control.signal, AbortSignal.timeout(15_000)]);
}
export function retryableProviderControlError(error: unknown) {
  const value = error as Row;
  const status = value?.$metadata?.httpStatusCode;
  return (
    value?.name === "AbortError" ||
    value?.name === "TimeoutError" ||
    value?.code === "ECONNRESET" ||
    value?.code === "ETIMEDOUT" ||
    value?.code === "ECONNREFUSED" ||
    status === 408 ||
    status === 429 ||
    (typeof status === "number" && status >= 500)
  );
}
export function retryableCoordinatorControlError(error: unknown) {
  return (
    error instanceof CoordinatorRoomError &&
    error.code !== "coordinator_response_too_large" &&
    (error.statusCode === 408 ||
      error.statusCode === 429 ||
      error.statusCode >= 500)
  );
}
function providerObjectMissing(error: unknown) {
  const value = error as Row;
  return (
    value?.name === "NotFound" ||
    value?.name === "NoSuchKey" ||
    value?.$metadata?.httpStatusCode === 404
  );
}
