import { settleRouteAuth } from "../auth/kernel.js";
import {
  studioRequestOrganizationId,
  studioRequestProjectId,
} from "../auth/request-context.js";
import { resolveBeamEnvironmentTemplate } from "../studio/store.js";
import { roomServiceForRequest } from "./room-service.js";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  credentialSecretReaderPg,
  pgOne,
  recordWorkflowArtifactLocationLostPg,
  withPostgresTransaction,
  type PgPool,
  WorkflowAuthorizationError,
} from "@beam-studio/db";
import {
  assertArtifactPortPublication,
  actionArtifactPortsRequired,
  artifactPortLimits,
  ActionArtifactDownloadError,
  readVerifiedActionArtifact,
  sandboxRpcMethodsForAction,
  type ActionStepSnapshot,
} from "@beam-studio/action-runtime";
import type { RoomMemberActionAssignments } from "./action-assignments.js";
import {
  assertRoomArtifactOperationAuthorized,
  frozenArtifactInput,
  frozenArtifactPublications,
} from "./room-artifact-authorization.js";
import type { RoomStorageTransferManager } from "./room-storage-transfer-manager.js";
import { expectedActionArtifactId } from "./room-artifact-copy-source.js";
import { auth } from "../auth/policy.js";
import { freezeRegistryArtifactUrl } from "../studio/registry-artifact-url.js";

export const roomMemberHostOperations = new Set([
  "logger.debug",
  "logger.info",
  "logger.warn",
  "logger.error",
  "state.get",
  "state.set",
  "state.patch",
  "artifacts.publish",
  "secrets.get",
  "beam.rooms.publish",
  "beam.rooms.status",
  "beam.rooms.cancel",
]);
type Row = Record<string, any>;

/**
 * The step a Studio artifact read uses: the run's frozen step, with the
 * download URL frozen into this assignment's invocation when it names the
 * same artifact. The run's checksum stays authoritative for verification.
 */
export function assignmentArtifactStep(step: Row, invocationStep: unknown) {
  const frozen =
    invocationStep && typeof invocationStep === "object"
      ? (invocationStep as Row)
      : {};
  return typeof frozen.registryArtifactUrl === "string" &&
    frozen.registryArtifactUrl &&
    frozen.artifactChecksum === step.artifactChecksum
    ? { ...step, registryArtifactUrl: frozen.registryArtifactUrl }
    : step;
}

const object = (value: unknown): Row => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("A JSON object is required.");
  return value as Row;
};
const denied = (code: string): never => {
  throw new WorkflowAuthorizationError(code, code);
};

/** Scoped host operations use frozen bindings and current authority; no DB connection crosses this boundary. */
export function registerRoomMemberActionHost(
  server: FastifyInstance,
  pool: PgPool,
  assignments: RoomMemberActionAssignments,
  storageTransfers?: RoomStorageTransferManager,
  freezeArtifactUrl = freezeRegistryArtifactUrl,
) {
  server.get<{
    Querystring: { environmentTemplateKey: string; roomId: string };
  }>(
    "/studio/workflow-executor-options",
    { config: { auth: auth.read({ machine: ["read:workflows"] }) } },
    async (request) => {
      const organizationId = studioRequestOrganizationId(request),
        projectId = studioRequestProjectId(request);
      if (!organizationId) denied("organization_required");
      const template = await resolveBeamEnvironmentTemplate({
        organizationId,
        templateKey: request.query.environmentTemplateKey,
      });
      if (template.key !== request.query.environmentTemplateKey)
        denied("executor_room_environment_missing");
      const service = await roomServiceForRequest(request, template);
      const snapshot = await service.client.organizationRoomSnapshot(
        organizationId!,
        request.query.roomId,
        service.token,
        true,
      );
      const agents = await pool.query<Row>(
        "SELECT id,name,status,capabilities_json FROM agent_control.agents WHERE organization_id=$1 AND (project_id IS NULL OR project_id=$2) AND revoked_at IS NULL",
        [organizationId, projectId],
      );
      return {
        channels: ((snapshot.channels as Row[]) ?? [])
          .filter(
            (channel) =>
              channel.state === "active" && channel.kind === "request-reply",
          )
          .map((channel) => ({
            id: channel.channel_id,
            name: channel.name ?? channel.channel_id,
          })),
        artifactChannels: ((snapshot.channels as Row[]) ?? [])
          .filter(
            (channel) =>
              channel.state === "active" &&
              channel.rotation_required !== true &&
              channel.kind === "object",
          )
          .map((channel) => ({
            id: channel.channel_id,
            name: channel.name ?? channel.channel_id,
          })),
        members: ((snapshot.memberships as Row[]) ?? [])
          .filter((member) => member.state === "active")
          .map((member) => {
            const agent = agents.rows.find(
              (agent) => agent.id === member.agent_id,
            );
            return {
              id: member.member_id,
              name: member.display_name ?? agent?.name ?? member.member_id,
              capable:
                member.kind === "agent" &&
                agent?.capabilities_json?.includes("action-execution/v1") ===
                  true,
              status: agent?.status ?? "unmanaged",
            };
          }),
      };
    },
  );
  server.get<{ Params: { assignmentId: string } }>(
    "/api/internal/executor-assignments/:assignmentId/artifact",
    {
      config: {
        auth: auth.capability(
          "/api/internal/executor-assignments/:assignmentId/artifact",
        ),
      },
    },
    async (request, reply) => {
      const bearer = String(request.headers.authorization ?? "");
      const context = await assignments.authorizeAssignment(
        request.params.assignmentId,
        bearer,
      );
      settleRouteAuth(request);
      const options = {
        actionCacheDir: join(tmpdir(), "beam-studio-action-artifacts"),
        actionArtifactStorage: {
          endpoint: process.env.HIPPIUS_S3_ENDPOINT ?? "https://s3.hippius.com",
          region: process.env.HIPPIUS_S3_REGION ?? "decentralized",
          forcePathStyle: process.env.HIPPIUS_S3_FORCE_PATH_STYLE !== "false",
          accessKeyId: process.env.HIPPIUS_S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.HIPPIUS_S3_SECRET_ACCESS_KEY,
        },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      };
      const frozenStep = assignmentArtifactStep(
        context.step,
        context.invocationStep,
      ) as ActionStepSnapshot;
      let bytes: Buffer;
      try {
        bytes = await readVerifiedActionArtifact(
          frozenStep,
          options,
          AbortSignal.timeout(15_000),
        );
      } catch (error) {
        // A step may start long after dispatch. Re-sign an expired URL once
        // with the organization's key; the Registry must still report the
        // run's sha256, and the bytes are verified against it again.
        if (
          !(error instanceof ActionArtifactDownloadError) ||
          error.code !== "artifact_url_expired"
        )
          throw error;
        const renewed = await freezeArtifactUrl(context.run, context.step);
        if (!renewed) throw error;
        bytes = await readVerifiedActionArtifact(
          { ...frozenStep, registryArtifactUrl: renewed },
          options,
          AbortSignal.timeout(15_000),
        );
      }
      await assignments.authorizeAssignment(
        request.params.assignmentId,
        bearer,
      );
      settleRouteAuth(request);
      return reply
        .header("Cache-Control", "no-store")
        .type(context.step.mediaType ?? "application/octet-stream")
        .send(bytes);
    },
  );
  server.post<{
    Params: { assignmentId: string; port: string; index: string };
    Body: { operation?: "input.read" | "input.copy" | "input.recover" };
  }>(
    "/api/internal/executor-assignments/:assignmentId/inputs/:port/:index/authorize",
    {
      config: {
        auth: auth.capability(
          "/api/internal/executor-assignments/:assignmentId/inputs/:port/:index/authorize",
        ),
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const index = Number(request.params.index);
      if (!Number.isSafeInteger(index) || index < 0 || index >= 16)
        denied("executor_artifact_input_unavailable");
      const operation = request.body?.operation ?? "input.read";
      if (!["input.read", "input.copy", "input.recover"].includes(operation))
        denied("executor_artifact_operation_invalid");
      const context = await assignments.authorizeAssignment(
        request.params.assignmentId,
        String(request.headers.authorization ?? ""),
      );
      settleRouteAuth(request);
      if (!context.room || !context.roomSnapshot)
        throw new WorkflowAuthorizationError("executor_room_scope_invalid");
      const input = frozenArtifactInput(
        context.task.metadata_json,
        request.params.port,
        index,
      );
      if (
        input.location.kind !== "member" ||
        input.location.memberId !== context.assignment.member_id
      )
        denied("executor_artifact_input_unavailable");
      assertRoomArtifactOperationAuthorized(
        context.roomSnapshot,
        context.room.roomId,
        {
          kind: operation,
          readerMemberId: context.assignment.member_id,
          location: {
            roomId: input.location.roomId,
            channelId: input.location.channelId,
            sourceMemberId: input.location.sourceMemberId,
            recipientMemberIds: [context.assignment.member_id],
          },
        },
      );
      const accepted = await pgOne<Row>(
        pool,
        `SELECT m.status,i.sha256,i.size_bytes,i.media_type,l.state AS location_state,l.kind,l.room_id,l.channel_id,
          l.source_member_id,l.member_id,l.locator,l.verified_at,l.durable_until,
          t.status AS transfer_status,t.full_delivery_verified,
          t.room_id AS transfer_room_id,t.channel_id AS transfer_channel_id,t.source_member_id AS transfer_source_member_id
        FROM execution.workflow_artifact_manifests m
        JOIN execution.workflow_artifact_locations l ON l.manifest_id=m.id AND l.artifact_id=$3
        JOIN execution.workflow_artifact_identities i ON i.artifact_id=l.artifact_id AND i.task_id=m.task_id
        LEFT JOIN execution.workflow_artifact_transfers t ON t.manifest_id=m.id AND t.artifact_id=l.artifact_id
          AND t.destination_member_id=l.member_id AND t.transfer_id=$4
        WHERE m.id=$1 AND m.workflow_run_id=$2 AND l.member_id=$5
          AND ((l.member_id=l.source_member_id AND l.locator=$4)
            OR (l.member_id<>l.source_member_id AND t.transfer_id=$4))`,
        [
          input.manifestId,
          context.run.id,
          input.artifactId,
          input.location.transferId,
          context.assignment.member_id,
        ],
      );
      const localSource =
        input.location.memberId === input.location.sourceMemberId;
      if (
        accepted?.status !== "accepted" ||
        accepted.location_state !== "available" ||
        accepted.kind !== "member" ||
        accepted.room_id !== input.location.roomId ||
        accepted.channel_id !== input.location.channelId ||
        accepted.source_member_id !== input.location.sourceMemberId ||
        !accepted.verified_at ||
        (!localSource &&
          (accepted.transfer_room_id !== input.location.roomId ||
            accepted.transfer_channel_id !== input.location.channelId ||
            accepted.transfer_source_member_id !==
              input.location.sourceMemberId ||
            accepted.transfer_status !== "completed" ||
            accepted.full_delivery_verified !== true)) ||
        (accepted.durable_until &&
          Date.parse(accepted.durable_until) <= Date.now()) ||
        accepted.sha256 !== input.sha256 ||
        Number(accepted.size_bytes) !== input.sizeBytes ||
        accepted.media_type !== input.mediaType
      )
        denied("executor_artifact_input_unavailable");
      return {
        authorized: true,
        artifactId: input.artifactId,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
        mediaType: input.mediaType,
        location: {
          ...input.location,
          verificationBasis: localSource ? "local_hash" : "full_delivery",
        },
      };
    },
  );
  server.post<{
    Params: { assignmentId: string; port: string; index: string };
    Body: { reason: "missing" | "corrupt" };
  }>(
    "/api/internal/executor-assignments/:assignmentId/inputs/:port/:index/lost",
    {
      config: {
        auth: auth.capability(
          "/api/internal/executor-assignments/:assignmentId/inputs/:port/:index/lost",
        ),
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const index = Number(request.params.index);
      if (!Number.isSafeInteger(index) || index < 0 || index >= 16)
        denied("executor_artifact_input_unavailable");
      if (
        !request.body ||
        !["missing", "corrupt"].includes(request.body.reason) ||
        Object.keys(request.body).some((key) => key !== "reason")
      )
        denied("executor_artifact_loss_reason_invalid");
      const context = await assignments.authorizeAssignment(
        request.params.assignmentId,
        String(request.headers.authorization ?? ""),
      );
      settleRouteAuth(request);
      if (!context.room || !context.roomSnapshot)
        denied("executor_room_scope_invalid");
      const input = frozenArtifactInput(
        context.task.metadata_json,
        request.params.port,
        index,
      );
      if (
        input.location.kind !== "member" ||
        input.location.memberId !== context.assignment.member_id ||
        input.location.roomId !== context.room?.roomId
      )
        denied("executor_artifact_input_unavailable");
      const status = await withPostgresTransaction(pool, async (client) => {
        const locked = await assignments.context(context.task.id, client, true);
        const claim = await client.query(
          `SELECT a.id FROM execution.executor_assignments a
           JOIN agent_control.agents agent ON agent.id=a.executor_id
           WHERE a.id=$1 AND a.attempt=$2 AND a.executor_id=$3
             AND a.state IN ('assigned','dispatching','running')
             AND a.lease_expires_at>clock_timestamp() AND a.session_generation=agent.session_generation
             AND agent.revoked_at IS NULL FOR UPDATE OF a`,
          [
            context.assignment.id,
            locked.task.attempt_count,
            locked.task.leased_by,
          ],
        );
        if (
          !claim.rowCount ||
          locked.task.status !== "running" ||
          !["running", "queued"].includes(locked.run.status) ||
          locked.run.id !== context.run.id ||
          !isDeepStrictEqual(
            frozenArtifactInput(
              locked.task.metadata_json,
              request.params.port,
              index,
            ),
            input,
          )
        )
          denied("executor_attempt_fenced");
        const copy = await pgOne<Row>(
          client,
          `SELECT m.status,i.sha256,i.size_bytes,i.media_type,
             l.state,l.kind,l.locator,l.room_id,l.channel_id,l.source_member_id,
             l.member_id,l.verified_at,l.verification_basis,
             t.status AS transfer_status,t.full_delivery_verified,
             t.room_id AS transfer_room_id,t.channel_id AS transfer_channel_id,
             t.source_member_id AS transfer_source_member_id
           FROM execution.workflow_artifact_manifests m
           JOIN execution.workflow_artifact_locations l ON l.manifest_id=m.id
             AND l.artifact_id=$3 AND l.kind='member' AND l.locator=$4
           JOIN execution.workflow_artifact_identities i ON i.artifact_id=l.artifact_id
             AND i.task_id=m.task_id
           LEFT JOIN execution.workflow_artifact_transfers t ON t.manifest_id=m.id
             AND t.artifact_id=l.artifact_id AND t.destination_member_id=l.member_id
             AND t.transfer_id=$4
           WHERE m.id=$1 AND m.workflow_run_id=$2 AND l.member_id=$5
             AND m.artifacts_json @> jsonb_build_array(jsonb_build_object('artifactId',$3))`,
          [
            input.manifestId,
            context.run.id,
            input.artifactId,
            input.location.transferId,
            context.assignment.member_id,
          ],
        );
        const localSource =
          input.location.memberId === input.location.sourceMemberId;
        if (
          !copy ||
          !["accepted", "unavailable"].includes(copy.status) ||
          !["available", "lost"].includes(copy.state) ||
          copy.kind !== "member" ||
          copy.locator !== input.location.transferId ||
          copy.room_id !== input.location.roomId ||
          copy.channel_id !== input.location.channelId ||
          copy.source_member_id !== input.location.sourceMemberId ||
          copy.member_id !== input.location.memberId ||
          !copy.verified_at ||
          (localSource && copy.verification_basis !== "local_hash") ||
          (!localSource &&
            (!["recipient_final_receipt", "provider_finalization"].includes(
              copy.verification_basis,
            ) ||
              copy.transfer_status !== "completed" ||
              copy.full_delivery_verified !== true ||
              copy.transfer_room_id !== input.location.roomId ||
              copy.transfer_channel_id !== input.location.channelId ||
              copy.transfer_source_member_id !==
                input.location.sourceMemberId)) ||
          copy.sha256 !== input.sha256 ||
          Number(copy.size_bytes) !== input.sizeBytes ||
          copy.media_type !== input.mediaType
        )
          denied("executor_artifact_input_unavailable");
        return recordWorkflowArtifactLocationLostPg(client, {
          manifestId: input.manifestId,
          artifactId: input.artifactId,
          kind: "member",
          locator: input.location.transferId,
          memberId: input.location.memberId,
        });
      });
      return { recorded: true, status };
    },
  );
  server.post<{
    Params: { assignmentId: string };
    Body: {
      operation: "output.publish" | "output.copy" | "output.recover";
      port: string;
      artifactId: string;
      sha256: string;
      sizeBytes: number;
    };
  }>(
    "/api/internal/executor-assignments/:assignmentId/artifacts/authorize",
    {
      config: {
        auth: auth.capability(
          "/api/internal/executor-assignments/:assignmentId/artifacts/authorize",
        ),
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const { operation, port, artifactId, sha256, sizeBytes } =
        request.body ?? {};
      if (
        !["output.publish", "output.copy", "output.recover"].includes(
          operation,
        ) ||
        typeof port !== "string" ||
        !port ||
        typeof artifactId !== "string" ||
        !artifactId ||
        typeof sha256 !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(sha256) ||
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes < 0 ||
        sizeBytes > artifactPortLimits.maxArtifactBytes
      )
        denied("executor_artifact_operation_invalid");
      const context = await assignments.authorizeAssignment(
        request.params.assignmentId,
        String(request.headers.authorization ?? ""),
      );
      settleRouteAuth(request);
      if (!context.room || !context.roomSnapshot)
        throw new WorkflowAuthorizationError("executor_room_scope_invalid");
      const publication = frozenArtifactPublications(
        context.task.metadata_json,
      )[port];
      if (!publication)
        throw new WorkflowAuthorizationError(
          "executor_artifact_publication_unplanned",
        );
      const output = context.step.manifestSnapshot?.outputs?.[port];
      if (!output || !["artifact", "artifact[]"].includes(output.type))
        denied("executor_artifact_port_invalid");
      if (publication.sourceMemberId !== context.assignment.member_id)
        denied("executor_artifact_publication_unplanned");
      if (Date.parse(publication.requiredUntil) <= Date.now())
        denied("executor_artifact_publication_expired");
      assertRoomArtifactOperationAuthorized(
        context.roomSnapshot,
        context.room.roomId,
        {
          kind: operation,
          location: {
            roomId: publication.roomId,
            channelId: publication.channelId,
            sourceMemberId: publication.sourceMemberId,
            recipientMemberIds: publication.targetMemberIds,
          },
        },
      );
      return { authorized: true, publication };
    },
  );
  server.post<{
    Params: { assignmentId: string };
    Body: {
      port: string;
      index: number;
      artifactId: string;
      copyId: string;
      sha256: string;
      sizeBytes: number;
      recoveryGeneration?: number;
    };
  }>(
    "/api/internal/executor-assignments/:assignmentId/artifacts/storage-publish",
    {
      config: {
        auth: auth.capability(
          "/api/internal/executor-assignments/:assignmentId/artifacts/storage-publish",
        ),
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const body = request.body;
      if (
        !body ||
        !/^[a-z][a-zA-Z0-9_]*$/.test(body.port) ||
        !Number.isSafeInteger(body.index) ||
        body.index < 0 ||
        body.index >= 16 ||
        typeof body.artifactId !== "string" ||
        !body.artifactId ||
        body.artifactId.length > 160 ||
        typeof body.copyId !== "string" ||
        !body.copyId ||
        body.copyId.length > 160 ||
        typeof body.sha256 !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(body.sha256) ||
        !Number.isSafeInteger(body.sizeBytes) ||
        body.sizeBytes <= 0 ||
        body.sizeBytes > artifactPortLimits.maxArtifactBytes ||
        !Number.isSafeInteger(body.recoveryGeneration ?? 0) ||
        (body.recoveryGeneration ?? 0) < 0 ||
        (body.recoveryGeneration ?? 0) > 8 ||
        Object.keys(body).some(
          (key) =>
            ![
              "port",
              "index",
              "artifactId",
              "copyId",
              "sha256",
              "sizeBytes",
              "recoveryGeneration",
            ].includes(key),
        )
      )
        denied("executor_artifact_operation_invalid");
      const context = await assignments.authorizeAssignment(
        request.params.assignmentId,
        String(request.headers.authorization ?? ""),
      );
      settleRouteAuth(request);
      if (
        body.copyId !== body.artifactId ||
        body.artifactId !==
          expectedActionArtifactId({
            assignmentId: context.assignment.id,
            attempt: Number(context.assignment.attempt),
            port: body.port,
            index: body.index,
            sha256: body.sha256,
          })
      )
        denied("executor_artifact_identity_invalid");
      const plan = frozenArtifactPublications(context.task.metadata_json)[
        body.port
      ];
      const output = context.step.manifestSnapshot?.outputs?.[body.port];
      if (
        !context.room ||
        !context.roomSnapshot ||
        !plan ||
        plan.availability !== "durable" ||
        !output ||
        !["artifact", "artifact[]"].includes(output.type) ||
        (output.type === "artifact" && body.index !== 0) ||
        plan.sourceMemberId !== context.assignment.member_id ||
        plan.roomId !== context.room?.roomId ||
        Date.parse(plan.requiredUntil) <= Date.now()
      )
        denied("executor_artifact_publication_unplanned");
      const policy = plan!;
      assertRoomArtifactOperationAuthorized(
        context.roomSnapshot!,
        context.room!.roomId,
        {
          kind: "output.copy",
          location: {
            roomId: policy.roomId,
            channelId: policy.channelId,
            sourceMemberId: policy.sourceMemberId,
            recipientMemberIds: policy.targetMemberIds,
          },
        },
      );
      if (!storageTransfers) denied("executor_artifact_storage_unavailable");
      const roomApiKeyId = String(
        (context.roomSnapshot as Row).room?.api_key_id ?? "",
      );
      if (!roomApiKeyId) denied("executor_room_api_key_unavailable");
      const environmentTemplateKey = String(
        context.step.executionRoom?.environmentTemplateKey ?? "",
      );
      if (!environmentTemplateKey) denied("executor_room_environment_missing");
      return storageTransfers!.enqueueArtifactCopy({
        organizationId: context.run.organization_id,
        environmentTemplateKey,
        roomId: policy.roomId,
        channelId: policy.channelId,
        workflowRunId: context.run.id,
        workflowStepRunId: context.stepRun.id,
        roomApiKeyId,
        sourceMemberId: policy.sourceMemberId,
        sourceAgentId: context.assignment.executor_id,
        targetMemberIds: policy.targetMemberIds,
        assignmentId: context.assignment.id,
        attempt: Number(context.assignment.attempt),
        port: body.port,
        index: body.index,
        artifactId: body.artifactId,
        copyId: body.copyId,
        sha256: body.sha256,
        sizeBytes: body.sizeBytes,
        retentionObligationId: `${policy.retentionObligationId}:${body.index}`,
        requiredUntil: policy.requiredUntil,
        recoveryGeneration: body.recoveryGeneration ?? 0,
        roomSnapshot: context.roomSnapshot!,
      });
    },
  );
  server.post<{
    Params: { assignmentId: string };
    Body: { port: string; index: number; artifactId: string };
  }>(
    "/api/internal/executor-assignments/:assignmentId/artifacts/storage-cancel",
    {
      config: {
        auth: auth.capability(
          "/api/internal/executor-assignments/:assignmentId/artifacts/storage-cancel",
        ),
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const body = request.body;
      if (
        !body ||
        !/^[a-z][a-zA-Z0-9_]*$/.test(body.port) ||
        !Number.isSafeInteger(body.index) ||
        body.index < 0 ||
        body.index >= 16 ||
        typeof body.artifactId !== "string" ||
        !/^[a-f0-9]{64}$/.test(body.artifactId) ||
        Object.keys(body).some(
          (key) => !["port", "index", "artifactId"].includes(key),
        )
      )
        denied("executor_artifact_operation_invalid");
      const context = await assignments.authorizeAssignment(
        request.params.assignmentId,
        String(request.headers.authorization ?? ""),
        true,
      );
      settleRouteAuth(request);
      if (!storageTransfers) denied("executor_artifact_storage_unavailable");
      return storageTransfers!.cancelArtifactCopies({
        organizationId: context.run.organization_id,
        assignmentId: context.assignment.id,
        attempt: Number(context.assignment.attempt),
        port: body.port,
        index: body.index,
        artifactId: body.artifactId,
      });
    },
  );
  server.post<{
    Params: { assignmentId: string };
    Body: { method: string; args: unknown[] };
  }>(
    "/api/internal/executor-assignments/:assignmentId/host",
    {
      config: {
        auth: auth.capability(
          "/api/internal/executor-assignments/:assignmentId/host",
        ),
      },
      bodyLimit: 192 * 1024,
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const { method, args } = request.body;
      if (
        typeof method !== "string" ||
        !Array.isArray(args) ||
        !roomMemberHostOperations.has(method)
      )
        denied("executor_host_operation_unsupported");
      const cleanup =
        method === "beam.rooms.cancel" || method.startsWith("logger.");
      const context = await assignments.authorizeAssignment(
        request.params.assignmentId,
        String(request.headers.authorization ?? ""),
        cleanup,
      );
      settleRouteAuth(request);
      if (
        !sandboxRpcMethodsForAction(context.step.manifestSnapshot).includes(
          method,
        )
      )
        denied("executor_host_operation_undeclared");
      if (
        !context.assignment.agent.action_execution_json?.hostOperations?.includes(
          method,
        )
      )
        denied("executor_host_operation_denied");
      const policy = context.assignment.agent.policy_json?.action_execution;
      if (
        !cleanup &&
        policy?.host_operations &&
        !policy.host_operations.includes(method)
      )
        denied("executor_host_operation_denied");
      let value: unknown = null;
      if (method.startsWith("beam.rooms.")) {
        const operation = method.slice("beam.rooms.".length);
        const path = `/internal/workflow-tasks/${encodeURIComponent(context.task.id)}/room-command`;
        const headers = { authorization: `Bearer ${context.task.claim_token}` };
        let response = await server.inject({
          method: "POST",
          url: path,
          headers,
          payload: { operation, requestId: `${context.task.id}-${operation}` },
        });
        let current = response.json().command;
        const deadline = Date.now() + 15_000;
        while (
          response.statusCode === 200 &&
          current &&
          !["completed", "failed", "cancelled", "expired"].includes(
            current.state,
          ) &&
          Date.now() < deadline
        ) {
          await delay(250);
          response = await server.inject({
            method: "GET",
            url: `${path}/${encodeURIComponent(current.id)}`,
            headers,
          });
          current = response.json().command;
        }
        if (response.statusCode !== 200 || current?.state !== "completed")
          throw new Error(
            response.json().error ??
              current?.error?.message ??
              `Room ${operation} acknowledgement remains unresolved.`,
          );
        value = { commandId: current.id, ...current.result };
        if (operation === "cancel") {
          if (
            current.result?.object?.state !== "cancelled" &&
            current.result?.storage?.status !== "cancelled"
          )
            throw new Error(
              "Room cancellation is not confirmed by the resource owner.",
            );
          await pool.query(
            'UPDATE execution.workflow_step_runs SET state_json=state_json||\'{"cancellationStatus":"confirmed","beamStatus":"cancelled","cancellationError":null}\'::jsonb,updated_at=now() WHERE id=$1',
            [context.stepRun.id],
          );
        }
      } else if (method === "secrets.get") {
        if (typeof args[0] !== "string")
          denied("executor_credential_binding_required");
        value = await credentialSecretReaderPg(pool, {
          organizationId: context.run.organization_id,
          workflowRunId: context.run.id,
          workflowStepRunId: context.stepRun.id,
          packageName: context.step.actionPackage,
          packageVersion: context.step.resolvedVersion,
          manifest: context.step.manifestSnapshot,
          config: context.step.config,
          inputs: context.task.input_json,
        })(args[0] as string);
      } else {
        value = await withPostgresTransaction(pool, async (client) => {
          const locked = await assignments.context(
            context.task.id,
            client,
            true,
          );
          const claim = await client.query(
            `SELECT a.id FROM execution.executor_assignments a JOIN agent_control.agents agent ON agent.id=a.executor_id WHERE a.id=$1 AND a.attempt=$2 AND a.executor_id=$3
          AND a.state IN ('assigned','dispatching','running','cancel_requested','reconciliation_required') AND ($4 OR (a.state IN ('assigned','dispatching','running') AND a.lease_expires_at>now() AND a.session_generation=agent.session_generation AND agent.revoked_at IS NULL)) FOR UPDATE OF a`,
            [
              context.assignment.id,
              locked.task.attempt_count,
              locked.task.leased_by,
              cleanup,
            ],
          );
          if (
            !claim.rowCount ||
            (!cleanup &&
              (locked.task.status !== "running" ||
                !["running", "queued"].includes(locked.run.status)))
          )
            denied("executor_attempt_fenced");
          if (method === "state.get") return locked.stepRun.state_json;
          if (method === "state.set" || method === "state.patch") {
            const next = object(args[0]);
            // Resource cleanup evidence is written only by Studio, never by action state.
            if (
              Object.keys(next).some(
                (key) =>
                  key.startsWith("cancellationControl") ||
                  key === "cancellationReconciliationDone",
              )
            )
              denied("executor_state_key_reserved");
            await client.query(
              `UPDATE execution.workflow_step_runs SET state_json=${method === "state.patch" ? "state_json||" : ""}$2::jsonb,updated_at=now() WHERE id=$1`,
              [locked.stepRun.id, JSON.stringify(next)],
            );
            return null;
          }
          if (method === "artifacts.publish") {
            const artifact = object(args[0]);
            if (
              !["type", "name", "uri"].every(
                (key) => typeof artifact[key] === "string",
              )
            )
              denied("executor_artifact_invalid");
            if (actionArtifactPortsRequired(locked.step.manifestSnapshot)) {
              try {
                assertArtifactPortPublication(
                  locked.step.manifestSnapshot,
                  artifact as any,
                  {
                    workflowRunId: locked.run.id,
                    stepRunId: locked.stepRun.id,
                    attempt: Number(locked.task.attempt_count),
                    taskId: locked.task.id,
                    assignmentId: context.assignment.id,
                  },
                );
              } catch {
                denied("executor_artifact_port_invalid");
              }
            }
            // Publication records describe the result; Studio never opens a member-supplied URI.
            return artifact;
          }
          if (method.startsWith("logger.")) {
            const entry = {
              level: method.slice(7),
              message: String(args[0] ?? "").slice(0, 2000),
            };
            await client.query(
              "UPDATE execution.executor_assignments SET progress_json=$2::jsonb,updated_at=now() WHERE id=$1",
              [context.assignment.id, JSON.stringify(entry)],
            );
            return null;
          }
          denied("executor_host_operation_unsupported");
        });
      }
      return { value };
    },
  );
}
