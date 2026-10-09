import { settleRouteAuth } from "../auth/kernel.js";
import { auth } from "../auth/policy.js";
import {
  cancelWorkflowRoomPublication,
  recordWorkflowResourceActive,
  recordWorkflowResourceState,
  recordVerifiedRoomIdleLease,
  terminalRoomResourceState,
  verifiedRoomIdleDeadline,
} from "./workflow-resource-cleanup.js";
import { CoordinatorRoomError } from "./coordinator-client.js";
import { roomServiceForOrganization } from "./room-service.js";
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PgPool } from "@beam-studio/db";
import {
  roomWorkflowConfigSchema,
  resolveActionRoomContext,
} from "@beam-studio/shared";
import type { AgentControlRepository } from "./repository.js";
import type { AgentGateway } from "./gateway.js";
import { resolveBeamEnvironmentTemplate } from "../studio/store.js";
import { webEnv } from "../env.js";
import { assertWorkflowExecutionAuthorized } from "../studio/execution-authorization.js";
import {
  roomStoragePendingStatus,
  roomStorageExecutionStatus,
  type RoomStorageTransferManager,
} from "./room-storage-transfer-manager.js";

type Row = Record<string, any>;

// A claim is an execution capability: no browser bearer or vault secret is
// forwarded to an action. Payloads are constructed from the locked snapshot.
export function registerRoomWorkflowRoutes(
  server: FastifyInstance,
  pool: PgPool,
  repository: AgentControlRepository,
  gateway: AgentGateway,
  storageTransfers?: RoomStorageTransferManager,
  resolveTemplate: typeof resolveBeamEnvironmentTemplate = resolveBeamEnvironmentTemplate,
  resolveRoomService: typeof roomServiceForOrganization = roomServiceForOrganization,
  authorizeExecution: (
    ...args: Parameters<typeof assertWorkflowExecutionAuthorized>
  ) => Promise<unknown> = assertWorkflowExecutionAuthorized,
) {
  server.post<{
    Params: { taskId: string };
    Body: {
      operation: "publish" | "status" | "cancel";
      requestId: string;
      publicationId?: string;
    };
  }>(
    "/internal/workflow-tasks/:taskId/room-command",
    {
      config: {
        auth: auth.capability("/internal/workflow-tasks/:taskId/room-command"),
      },
    },
    async (request, reply) => {
      const rows = await pool.query<Row>(
        `SELECT t.*, r.organization_id, r.project_id, r.workflow_template_id, r.resolved_steps_json, r.execution_context_json, r.status AS run_status, s.state_json,
                r.execution_context_json->'billing'->>'apiKeyId' AS api_key_id
        FROM execution.workflow_tasks t JOIN execution.workflow_runs r ON r.id=t.workflow_run_id
        JOIN execution.workflow_step_runs s ON s.id=t.workflow_step_run_id
        WHERE t.id=$1`,
        [request.params.taskId],
      );
      const task = rows.rows[0];
      const presented = Buffer.from(
        String(request.headers.authorization ?? "").replace(/^Bearer /, ""),
      );
      const expected = Buffer.from(String(task?.claim_token ?? ""));
      const cleanup = request.body?.operation === "cancel";
      if (
        !task ||
        !expected.length ||
        expected.length !== presented.length ||
        !timingSafeEqual(expected, presented) ||
        (!cleanup &&
          (task.status !== "running" ||
            !task.lease_expires_at ||
            Date.parse(String(task.lease_expires_at)) <= Date.now()))
      ) {
        return reply.code(403).send({
          error: "Workflow claim is no longer valid.",
          retryable: false,
        });
      }
      settleRouteAuth(request);
      const steps: Row[] =
        typeof task.resolved_steps_json === "string"
          ? JSON.parse(task.resolved_steps_json)
          : task.resolved_steps_json;
      const step = steps.find((value) => value.id === task.workflow_step_id);
      if (
        !step ||
        (step.actionPackage ?? step.action_package) !== "@beam/room-transfer"
      )
        return reply
          .code(403)
          .send({ error: "Room action required.", retryable: false });
      const parsed = roomWorkflowConfigSchema.safeParse(
        resolveActionRoomContext({
          workflowRoom: task.execution_context_json?.room,
          actionPackage: "@beam/room-transfer",
          config: step.config,
        }).config,
      );
      if (!parsed.success)
        return reply.code(400).send({
          error: "Invalid room workflow configuration.",
          retryable: false,
        });
      const config = parsed.data;
      const body = request.body;
      if (
        !["publish", "status", "cancel"].includes(body.operation) ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(body.requestId ?? "")
      )
        return reply
          .code(400)
          .send({ error: "Invalid room command.", retryable: false });
      if (
        body.operation === "publish" &&
        ["cancel_requested", "cancelled"].includes(task.run_status)
      )
        return reply.code(409).send({
          error: "Workflow cancellation requested.",
          retryable: false,
        });
      // Cleanup follows the durable publication identity, even after membership
      // or grants are revoked. It cannot authorize another publication.
      if (body.operation === "cancel") {
        return {
          command: await cancelWorkflowRoomPublication(
            pool,
            repository,
            gateway,
            storageTransfers,
            {
              organizationId: task.organization_id,
              projectId: task.project_id,
              stepRunId: task.workflow_step_run_id,
              roomId: config.roomId,
              channelId: config.channelId,
              requestId: body.requestId,
            },
          ),
        };
      }
      let service;
      let template;
      try {
        template = await workflowRoomTemplate(
          task.organization_id,
          config.environmentTemplateKey,
          resolveTemplate,
        );
        service = await resolveRoomService(
          task.organization_id,
          template,
          text(task.api_key_id),
        );
      } catch (error) {
        return reply.code(503).send({
          code:
            (error as { code?: string }).code ??
            "room_authority_key_unavailable",
          error:
            (error as { message?: string }).message ??
            "Room control needs an organization Beam API key.",
          retryable: false,
        });
      }
      await authorizeExecution(pool, task, String(task.workflow_step_id), task);
      if (body.operation === "status") {
        const publicationId = String(task.state_json?.publicationId ?? "");
        if (!publicationId)
          return reply.code(409).send({
            error: "Publication identity is not recorded yet.",
            retryable: true,
          });
        const storageJob = await storageTransfers?.workflowStatus(
          task.workflow_step_run_id,
        );
        if (storageJob && shouldUsePendingStorageStatus(storageJob)) {
          if (
            ["completed", "cancelled"].includes(storageJob.status) &&
            storageJob.errorCode !== "room_storage_cleanup_incomplete"
          )
            await recordWorkflowResourceState(
              pool,
              task.workflow_step_run_id,
              storageJob.status,
            );
          return storageStatusCommand(publicationId, storageJob);
        }
        const result = await service!.client.organizationObjectStatus(
          task.organization_id,
          config.roomId,
          config.channelId,
          publicationId,
          service!.token,
        );
        const leaseScope = {
          taskId: String(task.id),
          claimToken: String(task.claim_token),
          attempt: Number(task.attempt_count),
          stepRunId: String(task.workflow_step_run_id),
          publicationId,
          roomId: config.roomId,
          channelId: config.channelId,
          sourceMemberId: config.source.memberId,
        };
        const verifiedDeadline = verifiedRoomIdleDeadline(
          result.status,
          leaseScope,
        );
        // Refresh after the coordinator response to cover failure/revocation races.
        const currentStorageJob = storageJob
          ? await storageTransfers!.workflowStatus(task.workflow_step_run_id)
          : null;
        result.status = roomStorageExecutionStatus(
          result.status as Row,
          currentStorageJob,
        );
        const state = String(
          (result.status as Row)?.publisher?.room_transfer?.status ?? "",
        );
        const trustedIdleExpiresAt =
          ["pending", "in_progress"].includes(state) &&
          verifiedDeadline &&
          (await recordVerifiedRoomIdleLease(
            pool,
            leaseScope,
            verifiedDeadline,
          ))
            ? verifiedDeadline
            : null;
        if (
          ["completed", "partial", "failed", "cancelled", "expired"].includes(
            state,
          ) &&
          (!storageJob ||
            (currentStorageJob &&
              ["completed", "partial", "failed", "cancelled"].includes(
                currentStorageJob.status,
              ) &&
              currentStorageJob.errorCode !==
                "room_storage_cleanup_incomplete"))
        )
          await recordWorkflowResourceState(
            pool,
            task.workflow_step_run_id,
            state,
          );
        // Full per-range evidence is read on completion, not on every progress poll.
        let execution: unknown;
        if (["completed", "partial", "failed", "cancelled"].includes(state)) {
          try {
            execution = (
              await service!.client.organizationObjectExecution(
                task.organization_id,
                config.roomId,
                config.channelId,
                publicationId,
                service!.token,
              )
            ).execution;
          } catch (error) {
            // Detailed execution inspection is observability, not settlement.
            // Authoritative publication status above must always succeed; an
            // unavailable diagnostic must not fail an already settled transfer.
            if (
              !(error instanceof CoordinatorRoomError) ||
              ![404, 408, 429, 502, 503, 504].includes(error.statusCode)
            )
              throw error;
          }
        }
        const coordinatorResult: Row = { ...result };
        delete coordinatorResult.trustedIdleExpiresAt;
        return {
          command: {
            id: publicationId,
            state: "completed",
            result: {
              ...coordinatorResult,
              ...(trustedIdleExpiresAt ? { trustedIdleExpiresAt } : {}),
              ...(execution ? { execution } : {}),
            },
          },
        };
      }
      const snapshot = await service!.client.organizationRoomSnapshot(
        task.organization_id,
        config.roomId,
        service!.token,
      );
      const memberships = array(snapshot.memberships);
      const sourceMember = memberships.find(
        (member) => text(member.member_id) === config.source.memberId,
      );
      if (!sourceMember || text(sourceMember.state) !== "active") {
        return reply.code(409).send({
          error: "The selected source member is no longer active.",
          retryable: false,
        });
      }
      const selectedTargets = config.targetMemberIds.length
        ? memberships.filter((member) =>
            config.targetMemberIds.includes(text(member.member_id)),
          )
        : memberships.filter(
            (member) =>
              text(member.member_id) !== config.source.memberId &&
              text(member.state) === "active",
          );
      const hasStorageLeg =
        text(sourceMember.kind) === "object_storage" ||
        selectedTargets.some(
          (member) => text(member.kind) === "object_storage",
        );
      if (body.operation === "publish")
        await recordWorkflowResourceActive(pool, task.workflow_step_run_id);
      if (hasStorageLeg) {
        const publicationId = String(task.state_json?.publicationId ?? "");
        const requestKey = `${task.workflow_step_run_id}:${body.operation}:${body.requestId}`;
        if (!storageTransfers) {
          return reply.code(503).send({
            error: "Room storage transfer adapter is unavailable.",
            retryable: true,
          });
        }
        const result = await storageTransfers.enqueue({
          organizationId: task.organization_id,
          environmentTemplateKey: config.environmentTemplateKey,
          roomId: config.roomId,
          channelId: config.channelId,
          workflowRunId: task.workflow_run_id,
          workflowStepRunId: task.workflow_step_run_id,
          apiKeyId: text(task.api_key_id),
          sourceMemberId: config.source.memberId,
          sourceLocator:
            config.source.locator.type === "agent_path"
              ? { type: "agent_path", path: config.source.locator.path }
              : {
                  type: "bucket_object",
                  objectKey: config.source.locator.objectKey,
                },
          targetMemberIds: config.targetMemberIds,
          ttlSeconds: config.ttlSeconds,
          allowPartial: config.allowPartial,
        });
        const resultPublicationId =
          text((result as Row).publication_id) ||
          text((result as Row).publicationId);
        const id = resultPublicationId || publicationId || requestKey;
        return {
          command: {
            id,
            state: "completed",
            result: { transfer: { publication_id: resultPublicationId } },
          },
        };
      }
      if (config.source.locator.type !== "agent_path") {
        return reply.code(409).send({
          error: "Agent sources require an agent_path locator.",
          retryable: false,
        });
      }
      const sourceAgentId = text(sourceMember.agent_id);
      if (!sourceAgentId) {
        return reply.code(409).send({
          error: "The selected source member has no active agent.",
          retryable: false,
        });
      }
      const agent = await repository.getAgent(
        task.organization_id,
        sourceAgentId,
      );
      if (!agent.capabilities.includes("room-workflows/v1"))
        return reply.code(409).send({
          error: "Source agent requires room-workflows/v1 support.",
          retryable: false,
        });
      const publicationKey = `workflow-step:${task.workflow_step_run_id}`;
      const command = await repository.createCommand({
        organizationId: task.organization_id,
        projectId: task.project_id,
        agentId: sourceAgentId,
        operation: `room.channel.object.${body.operation}`,
        idempotencyKey: `${task.workflow_step_run_id}:${body.operation}:${body.requestId}`,
        ttlSeconds: 60,
        payload: {
          room_id: config.roomId,
          channel_id: config.channelId,
          coordinator_url: template.coordinatorUrl,
          publication_key: publicationKey,
          ...(body.operation === "publish"
            ? {
                file: config.source.locator.path,
                target_member_ids: config.targetMemberIds,
                ttl_seconds: config.ttlSeconds,
              }
            : {}),
        },
      });
      await gateway.dispatchAgent(sourceAgentId);
      return { command };
    },
  );
  server.get<{ Params: { taskId: string; commandId: string } }>(
    "/internal/workflow-tasks/:taskId/room-command/:commandId",
    {
      config: {
        auth: auth.capability(
          "/internal/workflow-tasks/:taskId/room-command/:commandId",
        ),
      },
    },
    async (request, reply) => {
      const rows = await pool.query<Row>(
        `SELECT c.*,t.workflow_step_run_id FROM execution.workflow_tasks t
      JOIN execution.workflow_runs r ON r.id=t.workflow_run_id
      JOIN agent_control.commands c ON c.organization_id=r.organization_id
      WHERE t.id=$1 AND t.claim_token=$2 AND ((t.status='running' AND t.lease_expires_at > now()) OR (c.operation='room.channel.object.cancel'))
        AND c.id=$3 AND left(c.idempotency_key,length(t.workflow_step_run_id)+1)=t.workflow_step_run_id || ':'`,
        [
          request.params.taskId,
          String(request.headers.authorization ?? "").replace(/^Bearer /, ""),
          request.params.commandId,
        ],
      );
      const row = rows.rows[0];
      if (!row)
        return reply.code(403).send({
          error: "Command is outside this workflow claim.",
          retryable: false,
        });
      settleRouteAuth(request);
      const terminal =
        row.operation === "room.channel.object.cancel" &&
        row.state === "completed"
          ? terminalRoomResourceState(row.result_json)
          : null;
      if (terminal)
        await recordWorkflowResourceState(
          pool,
          row.workflow_step_run_id,
          terminal,
        );
      return {
        command: {
          id: row.id,
          state: row.state,
          result: row.result_json,
          error: row.error_json,
        },
      };
    },
  );
}

function storageStatusCommand(
  publicationId: string,
  storageJob: NonNullable<
    Awaited<ReturnType<RoomStorageTransferManager["workflowStatus"]>>
  >,
) {
  return {
    command: {
      id: publicationId,
      state: "completed",
      result: { status: roomStoragePendingStatus(storageJob) },
    },
  };
}

function shouldUsePendingStorageStatus(
  storageJob: NonNullable<
    Awaited<ReturnType<RoomStorageTransferManager["workflowStatus"]>>
  >,
) {
  return (
    !storageJob.coordinatorStarted &&
    // Preparation records a running transfer before coordinator binding returns.
    // Polling its object before that durable binding exists can return 404.
    [
      "queued",
      "preparing",
      "running",
      "cancel_requested",
      "failed",
      "cancelled",
    ].includes(storageJob.status)
  );
}

function array(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Row =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

async function workflowRoomTemplate(
  organizationId: string,
  templateKey: string,
  resolveTemplate: typeof resolveBeamEnvironmentTemplate,
) {
  const template = await resolveTemplate({ organizationId, templateKey });
  if (webEnv.devSettingsEnabled && template.key !== templateKey) {
    throw new Error("Beam environment template not found.");
  }
  return template;
}
