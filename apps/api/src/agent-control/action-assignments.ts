import { settleRouteAuth } from "../auth/kernel.js";
import { roomMemberHostOperations } from "./action-host.js";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { FastifyInstance } from "fastify";
import {
  pgOne,
  lockLogicalPartitionAdmissionPg,
  withPostgresTransaction,
  workflowRunAuthorityGenerationPg,
  WorkflowAuthorizationError,
  type PgPool,
  type PgClient,
} from "@beam-studio/db";
import {
  actionExecutionTargetSchema,
  type ActionManifest,
} from "@beam-studio/core";
import {
  roomActionContentType,
  roomActionMinimumChannelPayloadBytes,
} from "@beam-studio/shared";
import {
  actionArtifactPortsRequired,
  assertArtifactPortInputs,
  artifactPortLimits,
  isRuntimeArtifactMethod,
  sandboxRpcMethodsForAction,
} from "@beam-studio/action-runtime";
import { assertWorkflowExecutionAuthorized } from "../studio/execution-authorization.js";
import { freezeRegistryArtifactUrl } from "../studio/registry-artifact-url.js";
import {
  artifactStorageReservationBytes,
  eligibleRoomMemberExecutors,
} from "./action-executors.js";
import {
  assertFrozenRoomArtifactPlansAuthorized,
  frozenArtifactInput,
  frozenArtifactPublications,
} from "./room-artifact-authorization.js";
import { AgentControlRepository } from "./repository.js";
import { AgentGateway } from "./gateway.js";
import { frozenAggregationInvocationConfigPg } from "./aggregation-invocation.js";
import { frozenV3LoopInvocationConfigPg } from "./v3-loop-invocation.js";
import {
  roomControlChannelIsPairwise,
  roomMemberCan,
} from "./room-workflow-options.js";
import type { RoomActionController } from "./room-action-controller.js";
import { auth } from "../auth/policy.js";

type Row = Record<string, any>;
const activeStates = [
  "assigned",
  "dispatching",
  "running",
  "cancel_requested",
  "reconciliation_required",
];
const terminalStates = ["completed", "failed", "cancelled"];
const maxOrganizationReservedOutputBytes = 64 * 1024 * 1024;
const identifier = (prefix: string) =>
  `${prefix}_${randomUUID().replaceAll("-", "")}`;
function denied(code: string, message = code): never {
  throw new WorkflowAuthorizationError(code, message);
}

/** The assigned member keeps a verified local copy. Only other members need
 * a Core object transfer; the physical source is known at dispatch time for
 * logical partitions that can run on any member of their frozen cohort. */
export function freezeV3OutputPublications(
  outputRoutes: unknown,
  artifactChannelId: string | undefined,
  assignedMemberId: string,
) {
  if (!artifactChannelId) denied("executor_artifact_channel_unavailable");
  if (
    !outputRoutes ||
    typeof outputRoutes !== "object" ||
    Array.isArray(outputRoutes)
  )
    denied("executor_artifact_publication_invalid");
  const publications = Object.fromEntries(
    Object.entries(outputRoutes as Row).map(([port, route]) => {
      if (
        !route ||
        typeof route !== "object" ||
        Array.isArray(route) ||
        Object.hasOwn(route, "sourceMemberId") ||
        (route as Row).channelId !== artifactChannelId ||
        !Array.isArray((route as Row).targetMemberIds)
      )
        denied("executor_artifact_publication_invalid");
      return [
        port,
        {
          ...route,
          sourceMemberId: assignedMemberId,
          targetMemberIds: (route as Row).targetMemberIds.filter(
            (memberId: unknown) => memberId !== assignedMemberId,
          ),
        },
      ];
    }),
  );
  frozenArtifactPublications({ artifactPublications: publications });
  return publications;
}
function capabilityMatches(expected: unknown, presented: string) {
  const left = Buffer.from(String(expected ?? "")),
    right = Buffer.from(presented.replace(/^Bearer /, ""));
  return (
    left.length > 0 &&
    left.length === right.length &&
    timingSafeEqual(left, right)
  );
}

function invocationInputs(manifest: ActionManifest, task: Row) {
  const inputs = { ...(task.input_json ?? {}) } as Row;
  const plans = task.metadata_json?.artifactInputs as Row | undefined;
  if (plans && typeof plans === "object" && !Array.isArray(plans)) {
    const remaining = { ...(manifest.inputs ?? {}) } as Row;
    let totalBytes = 0;
    let count = 0;
    for (const [port, values] of Object.entries(plans)) {
      const spec = (manifest.inputs as Row | undefined)?.[port] as
        | Row
        | undefined;
      if (
        !spec ||
        !["artifact", "artifact[]"].includes(spec.type) ||
        !Array.isArray(values) ||
        !values.length ||
        (spec.type === "artifact" &&
          spec.cardinality !== "many" &&
          values.length !== 1)
      )
        denied("executor_artifact_input_invalid");
      const descriptors = values.map((_, index) => {
        const input = frozenArtifactInput(task.metadata_json, port, index);
        if (spec.format && spec.format !== input.mediaType)
          denied("executor_artifact_input_invalid");
        if (input.sizeBytes > artifactPortLimits.maxArtifactBytes)
          denied("executor_artifact_input_invalid");
        count++;
        totalBytes += input.sizeBytes;
        return {
          type: "file",
          name: port,
          uri: `room-artifact:${input.artifactId}`,
          mediaType: input.mediaType,
          metadata: {
            artifactId: input.artifactId,
            bytes: input.sizeBytes,
            sha256: input.sha256,
          },
        };
      });
      inputs[port] =
        spec.type === "artifact[]" || spec.cardinality === "many"
          ? descriptors
          : descriptors[0];
      delete remaining[port];
    }
    if (
      count > artifactPortLimits.maxArtifacts ||
      totalBytes > artifactPortLimits.maxTotalBytes
    )
      denied("executor_artifact_input_invalid");
    assertArtifactPortInputs({ ...manifest, inputs: remaining }, inputs);
  } else if (actionArtifactPortsRequired(manifest)) {
    assertArtifactPortInputs(manifest, inputs);
  }
  return inputs;
}

/** Studio owns assignments and scheduling; the managed agent owns computation. */
export class RoomMemberActionAssignments {
  constructor(
    private readonly pool: PgPool,
    private readonly repository: AgentControlRepository,
    private readonly gateway: AgentGateway,
    private readonly authorize = assertWorkflowExecutionAuthorized,
    private readonly roomActionController?: RoomActionController,
    private readonly freezeArtifactUrl = freezeRegistryArtifactUrl,
  ) {}

  /** Rebuild the exact frozen invocation descriptors before result settlement.
   * The agent materializes room-artifact handles; Studio still accounts for
   * their pinned size without treating those handles as unverified data URIs. */
  artifactInputBudget(manifest: ActionManifest, task: Row) {
    const inputs = invocationInputs(manifest, task);
    let count = 0;
    let totalBytes = 0;
    for (const [port, spec] of Object.entries(manifest.inputs ?? {})) {
      if (!spec || (spec.type !== "artifact" && spec.type !== "artifact[]"))
        continue;
      const value = inputs[port];
      for (const artifact of (Array.isArray(value)
        ? value
        : value
          ? [value]
          : []) as Row[]) {
        count++;
        totalBytes += Number(artifact.metadata?.bytes ?? 0);
      }
    }
    return { count, totalBytes };
  }

  async context(
    taskId: string,
    client: PgPool | PgClient = this.pool,
    lock = false,
  ) {
    const task = await pgOne<Row>(
      client,
      `SELECT t.*,to_jsonb(r) AS run,to_jsonb(s) AS step_run
      FROM execution.workflow_tasks t JOIN execution.workflow_runs r ON r.id=t.workflow_run_id
      JOIN execution.workflow_step_runs s ON s.id=t.workflow_step_run_id WHERE t.id=$1 ${lock ? "FOR UPDATE OF t,r,s" : ""}`,
      [taskId],
    );
    if (!task) denied("executor_task_missing");
    const step = (task.run.resolved_steps_json as Row[]).find(
      (value) => value.id === task.workflow_step_id,
    );
    if (!step || step.kind === "workflow") denied("executor_action_missing");
    return {
      task,
      run: task.run as Row,
      stepRun: task.step_run as Row,
      step: step!,
    };
  }

  async authorizeDispatcher(taskId: string, bearer: string) {
    const context = await this.context(taskId);
    const capability = await pgOne<Row>(
      this.pool,
      "SELECT authorization_token FROM execution.workflow_run_capabilities WHERE workflow_run_id=$1",
      [context.run.id],
    );
    if (!capabilityMatches(capability?.authorization_token, bearer))
      denied("executor_dispatch_capability_invalid");
    return context;
  }

  async dispatch(taskId: string) {
    const context = await this.context(taskId);
    const protectedRun =
      context.run.template_snapshot_json?.graphVersion === "workflow-graph/v3";
    if (
      context.step.manifestSnapshot?.apiVersion === "workflow-actions/v2" &&
      !protectedRun
    )
      denied("executor_registry_v2_requires_protected_run");
    const existing = await pgOne<Row>(
      this.pool,
      "SELECT id,executor_id,state,cleanup_confirmed_at FROM execution.executor_assignments WHERE task_id=$1 ORDER BY attempt DESC LIMIT 1",
      [taskId],
    );
    if (
      existing &&
      (!terminalStates.includes(existing.state) ||
        !["queued", "retry_scheduled"].includes(context.task.status))
    ) {
      if (protectedRun) {
        if (!(await this.roomActionController?.protectsAssignment(existing.id)))
          denied("room_action_controller_unavailable");
        this.roomActionController!.wake();
      } else await this.gateway.dispatchAgent(existing.executor_id);
      return { assignmentId: existing.id, state: existing.state };
    }
    if (
      !["queued", "retry_scheduled"].includes(context.task.status) ||
      !["queued", "running"].includes(context.run.status)
    )
      denied("executor_task_not_runnable");
    if (
      sandboxRpcMethodsForAction(context.step.manifestSnapshot).some(
        (method) =>
          !isRuntimeArtifactMethod(method) &&
          !roomMemberHostOperations.has(method),
      )
    )
      denied(
        "executor_host_operation_unavailable",
        "The room-member backend does not implement a required host operation.",
      );
    if (
      !context.step.artifactChecksum ||
      (!context.step.registryArtifactUrl && !context.step.hippiusKey)
    )
      denied(
        "executor_artifact_unavailable",
        "Room-member actions require a frozen executable artifact.",
      );
    if (actionArtifactPortsRequired(context.step.manifestSnapshot)) {
      try {
        invocationInputs(context.step.manifestSnapshot, context.task);
      } catch (error) {
        denied(
          "executor_artifact_input_invalid",
          error instanceof Error ? error.message : "Invalid artifact input.",
        );
      }
    }
    const target = actionExecutionTargetSchema.parse(
      context.step.executionTarget,
    );
    if (target.kind !== "room-member") denied("executor_target_mismatch");
    if (context.stepRun.resolved_placement !== "room-members")
      denied("executor_target_mismatch");
    const logicalPartition = context.task.metadata_json?.logicalPartition;
    const aggregationTargetMemberId =
      context.task.metadata_json?.aggregation?.targetMemberId;
    if (
      aggregationTargetMemberId &&
      !target.memberIds.includes(aggregationTargetMemberId)
    )
      denied("executor_aggregation_target_invalid");
    const frozenMemberIds = logicalPartition?.eligibleMemberIds;
    if (logicalPartition?.version === "logical/v1") {
      if (
        !Array.isArray(frozenMemberIds) ||
        !frozenMemberIds.length ||
        frozenMemberIds.some(
          (memberId: unknown) =>
            typeof memberId !== "string" ||
            !target.memberIds.includes(memberId),
        ) ||
        (logicalPartition.memberId &&
          !frozenMemberIds.includes(logicalPartition.memberId))
      )
        denied("executor_partition_cohort_invalid");
    }
    // A member-specific contribution stays on its participant; an ordinary
    // partition may retry on any member in its frozen cohort.
    const eligibleMemberIds: string[] = aggregationTargetMemberId
      ? [aggregationTargetMemberId]
      : logicalPartition?.version === "logical/v1"
        ? logicalPartition.memberId
          ? [logicalPartition.memberId]
          : frozenMemberIds
        : target.memberIds;
    const partitionTarget = { ...target, memberIds: eligibleMemberIds };
    const room = context.step.executionRoom;
    if (!room)
      denied(
        "executor_room_required",
        "A room-member action requires an effective room.",
      );
    const authorization = await this.authorize(
      this.pool,
      context.run,
      context.step.id,
      context.task,
    );
    const snapshot = authorization.roomSnapshot;
    if (!snapshot) denied("executor_room_unavailable");
    // Issued before the transaction: it is a Registry round trip.
    const signedArtifactUrl = await this.freezeArtifactUrl(
      context.run,
      context.step,
    );
    if (protectedRun && !this.roomActionController)
      denied("room_action_controller_unavailable");
    if (
      protectedRun &&
      existing &&
      terminalStates.includes(existing.state) &&
      !existing.cleanup_confirmed_at
    )
      denied("executor_prior_cleanup_unconfirmed");
    const agents = await this.pool.query<Row>(
      `SELECT a.*,s.heartbeat_at FROM agent_control.agents a
      LEFT JOIN agent_control.sessions s ON s.agent_id=a.id AND s.generation=a.session_generation AND s.status='online'
      WHERE a.organization_id=$1 AND (a.project_id IS NULL OR a.project_id=$2)`,
      [context.run.organization_id, context.run.project_id],
    );
    const placement = eligibleRoomMemberExecutors({
      target: partitionTarget,
      roomId: room.roomId,
      snapshot,
      agents: agents.rows,
      manifest: context.step.manifestSnapshot as ActionManifest,
      sourceRegistry: context.step.sourceRegistry,
      requiredHostOperations: sandboxRpcMethodsForAction(
        context.step.manifestSnapshot,
      ).filter((method) => !isRuntimeArtifactMethod(method)),
      artifactMetadata: context.task.metadata_json,
    });
    if (!placement.eligible.length) {
      await this.pool.query(
        `UPDATE execution.workflow_step_runs SET metadata_json=metadata_json||jsonb_build_object('executorRejections',$2::jsonb),updated_at=now() WHERE id=$1`,
        [context.stepRun.id, JSON.stringify(placement.rejected)],
      );
      denied(
        placement.rejected[0]?.code ?? "executor_unavailable",
        placement.rejected[0]?.message ??
          "No compatible room member is available.",
      );
    }
    const assignment = await withPostgresTransaction(
      this.pool,
      async (client) => {
        const current = await this.context(taskId, client, true);
        const active = await pgOne<Row>(
          client,
          "SELECT id,executor_id,state FROM execution.executor_assignments WHERE task_id=$1 AND state=ANY($2::text[]) ORDER BY attempt DESC LIMIT 1",
          [taskId, activeStates],
        );
        if (active) return active;
        if (
          !["queued", "retry_scheduled"].includes(current.task.status) ||
          !["queued", "running"].includes(current.run.status) ||
          new Date(current.task.scheduled_at).getTime() > Date.now()
        )
          denied("executor_task_not_runnable");
        if (!(await lockLogicalPartitionAdmissionPg(client, taskId)))
          denied("executor_partition_admission_full");
        const authorityGeneration = await workflowRunAuthorityGenerationPg(
          client,
          String(current.run.id),
        );
        if (authorityGeneration === null)
          denied("executor_authority_unavailable");
        const outputReservation = actionArtifactPortsRequired(
          current.step.manifestSnapshot,
        )
          ? artifactStorageReservationBytes
          : 0;
        if (outputReservation) {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [`workflow-output:${current.run.organization_id}`],
          );
          const capacity = await pgOne<Row>(
            client,
            `SELECT
              (SELECT COALESCE(SUM(a.reserved_output_bytes),0)
               FROM execution.executor_assignments a
               WHERE a.organization_id=$1 AND a.cleanup_confirmed_at IS NULL)
              + (SELECT COALESCE(SUM(i.size_bytes),0)
                 FROM execution.workflow_artifact_identities i
                 JOIN execution.workflow_runs r ON r.id=i.workflow_run_id
                 WHERE r.organization_id=$1 AND EXISTS (
                   SELECT 1 FROM execution.workflow_artifact_obligations o
                   JOIN execution.workflow_artifact_manifests m ON m.id=o.manifest_id
                   WHERE m.task_id=i.task_id AND o.artifact_id=i.artifact_id
                     AND o.status IN ('pending','active','releasing')
                 )) AS reserved_bytes`,
            [current.run.organization_id],
          );
          if (
            Number(capacity?.reserved_bytes ?? 0) + outputReservation >
            maxOrganizationReservedOutputBytes
          )
            denied(
              "executor_output_capacity_unavailable",
              "Organization output reservations are full; dispatch will resume after capacity is released.",
            );
        }
        const baseInvocationConfig = await frozenAggregationInvocationConfigPg(
          client,
          current.task,
          current.step,
          current.stepRun.id,
          eligibleMemberIds[0]!,
        );
        const invocationConfig = await frozenV3LoopInvocationConfigPg(
          client,
          current.task,
          current.step,
          current.stepRun.id,
          eligibleMemberIds[0]!,
          baseInvocationConfig,
        );
        for (const candidate of placement.eligible) {
          if (protectedRun) {
            const { binding, controlChannelId } =
              this.roomActionController!.configured(
                current.run.organization_id,
                room.roomId,
                candidate.memberId,
              );
            const channel = (snapshot.channels as Row[]).find(
              (value) => value.channel_id === controlChannelId,
            );
            const requestChannel = (snapshot.channels as Row[]).find(
              (value) => value.channel_id === target.channelId,
            );
            const maxCiphertextBytes = Number(
              channel?.limits?.max_payload_bytes,
            );
            const controllerMember = (snapshot.memberships as Row[]).find(
              (value) =>
                value.member_id === binding.memberId &&
                value.agent_id === binding.agentId &&
                value.state === "active",
            );
            if (
              binding.memberId !== target.requesterMemberId ||
              !controllerMember ||
              channel?.kind !== "message" ||
              channel.state !== "active" ||
              channel.rotation_required === true ||
              channel.content_type !== roomActionContentType ||
              !roomControlChannelIsPairwise(
                snapshot,
                room.roomId,
                controlChannelId,
                binding.memberId,
                candidate.memberId,
              ) ||
              !Number.isSafeInteger(maxCiphertextBytes) ||
              maxCiphertextBytes < roomActionMinimumChannelPayloadBytes ||
              requestChannel?.kind !== "request-reply" ||
              requestChannel.state !== "active" ||
              !roomMemberCan(
                snapshot,
                room.roomId,
                target.channelId,
                binding.memberId,
                "request",
              ) ||
              !roomMemberCan(
                snapshot,
                room.roomId,
                target.channelId,
                candidate.memberId,
                "respond",
              ) ||
              ![binding.memberId, candidate.memberId].every(
                (memberId) =>
                  roomMemberCan(
                    snapshot,
                    room.roomId,
                    controlChannelId,
                    memberId,
                    "publish",
                  ) &&
                  roomMemberCan(
                    snapshot,
                    room.roomId,
                    controlChannelId,
                    memberId,
                    "subscribe",
                  ),
              )
            )
              denied("room_action_channel_unauthorized");
          }
          const locked = await pgOne<Row>(
            client,
            `SELECT a.*,s.heartbeat_at FROM agent_control.agents a
          JOIN agent_control.sessions s ON s.agent_id=a.id AND s.generation=a.session_generation AND s.status='online'
          WHERE a.id=$1 AND a.revoked_at IS NULL AND a.organization_id=$2 FOR UPDATE OF a SKIP LOCKED`,
            [candidate.agent.id, current.run.organization_id],
          );
          if (!locked) continue;
          const checked = eligibleRoomMemberExecutors({
            target: { ...partitionTarget, memberIds: [candidate.memberId] },
            roomId: room.roomId,
            snapshot,
            agents: [locked],
            manifest: current.step.manifestSnapshot,
            sourceRegistry: current.step.sourceRegistry,
            requiredHostOperations: sandboxRpcMethodsForAction(
              current.step.manifestSnapshot,
            ).filter((method) => !isRuntimeArtifactMethod(method)),
            artifactMetadata: current.task.metadata_json,
          }).eligible[0];
          if (!checked) continue;
          const load = await pgOne<Row>(
            client,
            "SELECT count(*)::int AS count FROM execution.executor_assignments WHERE executor_id=$1 AND state=ANY($2::text[])",
            [locked.id, activeStates],
          );
          if (Number(load?.count ?? 0) >= checked.capabilities.capacity)
            continue;
          const outputRoutes = current.task.metadata_json?.v3OutputRoutes;
          if (protectedRun && outputRoutes) {
            const publications = freezeV3OutputPublications(
              outputRoutes,
              target.artifactChannelId,
              candidate.memberId,
            );
            assertFrozenRoomArtifactPlansAuthorized(
              snapshot,
              room.roomId,
              candidate.memberId,
              {
                ...current.task.metadata_json,
                artifactPublications: publications,
              },
            );
            await client.query(
              `UPDATE execution.workflow_tasks
               SET metadata_json=metadata_json||jsonb_build_object('artifactPublications',$2::jsonb),updated_at=now()
               WHERE id=$1`,
              [taskId, JSON.stringify(publications)],
            );
            current.task.metadata_json = {
              ...current.task.metadata_json,
              artifactPublications: publications,
            };
          }
          const assignmentId = identifier("assignment"),
            attempt = Number(current.task.attempt_count) + 1;
          const leaseSeconds = Math.min(
              60,
              checked.capabilities.maxLeaseSeconds,
            ),
            lease = new Date(Date.now() + leaseSeconds * 1000).toISOString();
          const capability = randomBytes(32).toString("base64url"),
            claimToken = randomUUID();
          await client.query(
            `INSERT INTO execution.executor_assignments(id,organization_id,workflow_run_id,workflow_step_run_id,task_id,attempt,backend,executor_id,member_id,session_generation,declared_target_json,state,lease_expires_at,authority_generation,reserved_output_bytes)
          VALUES($1,$2,$3,$4,$5,$6,'room-member',$7,$8,$9,$10::jsonb,'assigned',$11,$12,$13)`,
            [
              assignmentId,
              current.run.organization_id,
              current.run.id,
              current.stepRun.id,
              taskId,
              attempt,
              locked.id,
              candidate.memberId,
              locked.session_generation,
              JSON.stringify(partitionTarget),
              lease,
              authorityGeneration,
              outputReservation,
            ],
          );
          await client.query(
            "INSERT INTO execution.executor_assignment_capabilities(assignment_id,authorization_token) VALUES($1,$2)",
            [assignmentId, capability],
          );
          const command = await this.repository.createCommand(
            {
              organizationId: current.run.organization_id,
              projectId: current.run.project_id,
              agentId: locked.id,
              operation: "action.invoke",
              transport: protectedRun ? "room-mls/v1" : "agent-control",
              idempotencyKey: assignmentId,
              ttlSeconds: leaseSeconds,
              payload: {
                assignmentId,
                taskId,
                attempt,
                authorityGeneration,
                leaseExpiresAt: lease,
                capability,
                memberId: candidate.memberId,
                requesterMemberId: target.requesterMemberId,
                channelId: target.channelId,
                invocation: {
                  ...(actionArtifactPortsRequired(current.step.manifestSnapshot)
                    ? {
                        artifactPortsProtocol: "action-artifact-ports/v1",
                        storageReservationBytes:
                          artifactStorageReservationBytes,
                      }
                    : {}),
                  assignmentId,
                  taskId,
                  workflowRunId: current.run.id,
                  stepRunId: current.stepRun.id,
                  stepId: current.step.id,
                  attempt,
                  authorityGeneration,
                  room,
                  step: signedArtifactUrl
                    ? {
                        ...current.step,
                        registryArtifactUrl: signedArtifactUrl,
                      }
                    : current.step,
                  config: invocationConfig,
                  inputs: invocationInputs(
                    current.step.manifestSnapshot,
                    current.task,
                  ),
                  artifactPublications: {
                    ...frozenArtifactPublications(current.task.metadata_json),
                  },
                  artifactInputs:
                    current.task.metadata_json?.artifactInputs ?? {},
                  state: current.stepRun.state_json,
                },
              },
            },
            client,
          );
          if (protectedRun)
            await this.roomActionController!.record(client, {
              commandId: command.id,
              assignmentId,
              organizationId: current.run.organization_id,
              roomId: room.roomId,
              recipientMemberId: candidate.memberId,
              requestReplyChannelId: target.channelId,
              authorityGeneration,
              deadline: lease,
            });
          await client.query(
            "UPDATE execution.executor_assignments SET command_id=$2,state='dispatching' WHERE id=$1",
            [assignmentId, command.id],
          );
          await client.query(
            `UPDATE execution.workflow_tasks SET status='running',attempt_count=$2,attempts=$2,leased_by=$3,locked_by=$3,lease_expires_at=$4,lock_expires_at=$4,claim_token=$5,started_at=COALESCE(started_at,now()),updated_at=now(),
          placement_explanation_json=$6::jsonb WHERE id=$1`,
            [
              taskId,
              attempt,
              locked.id,
              lease,
              claimToken,
              JSON.stringify({
                backend: "room-member",
                assignmentId,
                executorId: locked.id,
                memberId: candidate.memberId,
                declaredTarget: partitionTarget,
              }),
            ],
          );
          await client.query(
            `INSERT INTO execution.workflow_task_attempts(id,workflow_task_id,attempt_number,worker_id,status,started_at,metadata_json) VALUES($1,$2,$3,NULL,'running',now(),$4::jsonb)`,
            [
              identifier("wfta"),
              taskId,
              attempt,
              JSON.stringify({
                backend: "room-member",
                assignmentId,
                executorId: locked.id,
                memberId: candidate.memberId,
              }),
            ],
          );
          await client.query(
            `UPDATE execution.workflow_step_runs SET status='running',started_at=COALESCE(started_at,now()),metadata_json=metadata_json||$2::jsonb,updated_at=now() WHERE id=$1 AND status='queued'`,
            [
              current.stepRun.id,
              JSON.stringify({
                declaredTarget: target,
                actualExecutor: {
                  backend: "room-member",
                  id: locked.id,
                  memberId: candidate.memberId,
                },
                assignmentId,
              }),
            ],
          );
          return {
            id: assignmentId,
            executor_id: locked.id,
            state: "dispatching",
          };
        }
        denied(
          "executor_capacity_unavailable",
          "Compatible room members have no available execution capacity.",
        );
      },
    );
    // Dispatch follows commit; an uncertain socket delivery retains the same command.
    if (protectedRun) {
      if (!(await this.roomActionController?.protectsAssignment(assignment.id)))
        denied("room_action_controller_unavailable");
      this.roomActionController!.wake();
    } else await this.gateway.dispatchAgent(assignment.executor_id);
    return { assignmentId: assignment.id, state: assignment.state };
  }

  async authorizeAssignment(
    assignmentId: string,
    bearer: string,
    cleanup = false,
  ) {
    const assignment = await pgOne<Row>(
      this.pool,
      `SELECT a.*,c.authorization_token,agent.revoked_at,agent.session_generation AS current_generation,to_jsonb(agent) AS agent,
      authority.generation AS current_authority_generation,authority.lease_expires_at AS authority_lease_expires_at,
      (SELECT heartbeat_at FROM agent_control.sessions s WHERE s.agent_id=agent.id AND s.generation=agent.session_generation AND s.status='online' LIMIT 1) AS heartbeat_at
      FROM execution.executor_assignments a JOIN execution.executor_assignment_capabilities c ON c.assignment_id=a.id
      JOIN execution.workflow_run_authority authority ON authority.workflow_run_id=a.workflow_run_id
      JOIN agent_control.agents agent ON agent.id=a.executor_id WHERE a.id=$1`,
      [assignmentId],
    );
    if (
      !assignment ||
      !capabilityMatches(assignment.authorization_token, bearer)
    )
      denied("executor_capability_invalid");
    const context = await this.context(assignment.task_id);
    if (
      context.step.manifestSnapshot?.apiVersion === "workflow-actions/v2" &&
      context.run.template_snapshot_json?.graphVersion !== "workflow-graph/v3"
    )
      denied("executor_registry_v2_requires_protected_run");
    if (
      context.task.attempt_count !== assignment.attempt ||
      context.task.leased_by !== assignment.executor_id
    )
      denied("executor_attempt_fenced");
    if (cleanup) {
      if (!activeStates.includes(assignment.state))
        denied("executor_cleanup_already_settled");
      return {
        assignment,
        ...context,
        invocationStep: null as unknown,
        room: null,
        roomSnapshot: null,
      };
    }
    if (
      assignment.revoked_at ||
      assignment.session_generation !== assignment.current_generation
    )
      denied("executor_session_fenced");
    if (
      String(assignment.authority_generation) !==
        String(assignment.current_authority_generation) ||
      new Date(assignment.authority_lease_expires_at).getTime() <= Date.now()
    )
      denied("executor_authority_fenced");
    if (
      !["assigned", "dispatching", "running"].includes(assignment.state) ||
      !["queued", "running"].includes(context.run.status) ||
      context.task.status !== "running" ||
      new Date(assignment.lease_expires_at).getTime() <= Date.now()
    )
      denied("executor_lease_expired_or_cancelled");
    const command = await pgOne<Row>(
      this.pool,
      "SELECT transport,payload_json->'invocation' AS invocation FROM agent_control.commands WHERE id=$1",
      [assignment.command_id],
    );
    if (
      !command?.invocation ||
      (context.run.template_snapshot_json?.graphVersion ===
        "workflow-graph/v3" &&
        command.transport !== "room-mls/v1") ||
      Number(command.invocation.authorityGeneration ?? 1) !==
        Number(assignment.authority_generation) ||
      !isDeepStrictEqual(
        command.invocation.artifactInputs ?? {},
        context.task.metadata_json?.artifactInputs ?? {},
      ) ||
      !isDeepStrictEqual(command.invocation.artifactPublications ?? {}, {
        ...frozenArtifactPublications(context.task.metadata_json),
      })
    )
      denied("executor_artifact_plan_changed");
    const authorization = await this.authorize(
      this.pool,
      context.run,
      context.step.id,
      context.task,
    );
    const target = actionExecutionTargetSchema.parse(
      context.step.executionTarget,
    );
    const assignedTarget = actionExecutionTargetSchema.parse(
      assignment.declared_target_json,
    );
    if (
      target.kind !== "room-member" ||
      assignedTarget.kind !== "room-member" ||
      context.stepRun.resolved_placement !== "room-members" ||
      !authorization.room ||
      !authorization.roomSnapshot ||
      !target.memberIds.includes(assignment.member_id) ||
      !assignedTarget.memberIds.includes(assignment.member_id) ||
      (context.task.metadata_json?.logicalPartition?.version === "logical/v1" &&
        (!context.task.metadata_json.logicalPartition.eligibleMemberIds?.includes(
          assignment.member_id,
        ) ||
          (context.task.metadata_json.logicalPartition.memberId &&
            context.task.metadata_json.logicalPartition.memberId !==
              assignment.member_id)))
    )
      denied("executor_room_scope_invalid");
    const placement = eligibleRoomMemberExecutors({
      target: { ...target, memberIds: [assignment.member_id] },
      roomId: authorization.room.roomId,
      snapshot: authorization.roomSnapshot,
      agents: [{ ...assignment.agent, heartbeat_at: assignment.heartbeat_at }],
      manifest: context.step.manifestSnapshot,
      sourceRegistry: context.step.sourceRegistry,
      requiredHostOperations: sandboxRpcMethodsForAction(
        context.step.manifestSnapshot,
      ).filter((method) => !isRuntimeArtifactMethod(method)),
      artifactMetadata: context.task.metadata_json,
    });
    if (!placement.eligible.length)
      denied(
        placement.rejected[0]?.code ?? "executor_permission_revoked",
        placement.rejected[0]?.message,
      );
    return {
      assignment,
      ...context,
      invocationStep: command.invocation.step as unknown,
      room: authorization.room,
      roomSnapshot: authorization.roomSnapshot,
    };
  }

  registerRoutes(server: FastifyInstance) {
    server.post<{ Params: { taskId: string } }>(
      "/internal/workflow-tasks/:taskId/room-member/dispatch",
      {
        config: {
          auth: auth.capability(
            "/internal/workflow-tasks/:taskId/room-member/dispatch",
          ),
        },
      },
      async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        await this.authorizeDispatcher(
          request.params.taskId,
          String(request.headers.authorization ?? ""),
        );
        settleRouteAuth(request);
        return this.dispatch(request.params.taskId);
      },
    );
    server.post<{ Params: { assignmentId: string } }>(
      "/api/internal/executor-assignments/:assignmentId/authorize",
      {
        config: {
          auth: auth.capability(
            "/api/internal/executor-assignments/:assignmentId/authorize",
          ),
        },
      },
      async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        await this.authorizeAssignment(
          request.params.assignmentId,
          String(request.headers.authorization ?? ""),
        );
        settleRouteAuth(request);
        return { authorized: true };
      },
    );
  }
}
