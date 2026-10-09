import { settleRouteAuth } from "../auth/kernel.js";
import { timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { FastifyInstance } from "fastify";
import {
  pgOne,
  freezeWorkflowArtifactInputPg,
  withPostgresTransaction,
  WorkflowAuthorizationError,
  type FrozenWorkflowDefinition,
  type PgClient,
  type PgPool,
  type V3LaunchGate,
} from "@beam-studio/db";
import {
  actionExecutionTargetSchema,
  assertActionExecutionTarget,
  assertGraphV3RegistryPort,
  resolveWorkflowGraphV3,
  resolveWorkflowGraphV3CarryRoutes,
  resolveWorkflowGraphV3InitialRoutes,
  resolveLoopIterations,
  validateActionManifest,
  validateWorkflowGraphV3,
  type ActionManifest,
  type ActionManifestV2,
  type WorkflowGraphV3Definition,
  type WorkflowGraphV3LoopControl,
} from "@beam-studio/core";
import {
  isRuntimeArtifactMethod,
  sandboxRpcMethodsForAction,
} from "@beam-studio/action-runtime";
import {
  resolveWorkflowRoomContext,
  roomActionContentType,
  roomActionMinimumChannelPayloadBytes,
} from "@beam-studio/shared";
import { roomServiceForOrganization } from "./room-service.js";
import {
  roomControlChannelIsPairwise,
  roomMemberCan,
} from "./room-workflow-options.js";
import { resolveBeamEnvironmentTemplate } from "../studio/store.js";
import { assertWorkflowExecutionAuthorized } from "../studio/execution-authorization.js";
import {
  assertRoomArtifactOperationAuthorized,
  frozenArtifactInput,
} from "./room-artifact-authorization.js";
import type { RoomActionController } from "./room-action-controller.js";
import {
  parseWebAgentControllerBindings,
  requireWebAgentControllerBinding,
} from "./web-agent-controller-config.js";
import { WebAgentControllerSession } from "./web-agent-controller-session.js";
import { eligibleRoomMemberExecutors } from "./action-executors.js";
import { auth } from "../auth/policy.js";

type Row = Record<string, any>;
const deny = (code: string): never => {
  throw new WorkflowAuthorizationError(code);
};
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value : []);
const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};

async function snapshotForRoom(
  organizationId: string,
  room: {
    environmentTemplateKey: string;
    roomId: string;
  },
) {
  const template = await resolveBeamEnvironmentTemplate({
    organizationId,
    templateKey: room.environmentTemplateKey,
  });
  if (template.key !== room.environmentTemplateKey)
    deny("v3_room_environment_unavailable");
  const service = await roomServiceForOrganization(organizationId, template);
  const snapshot = await service.client.organizationRoomSnapshot(
    organizationId,
    room.roomId,
    service.token,
    true,
  );
  if (object(snapshot.room).state !== "active") deny("v3_room_inactive");
  return snapshot;
}

/** The grant channel and pairwise MLS channel are separate. The agent performs
 * the final two-member MLS roster check under its encryption lock. */
export function assertProtectedRoomChannel(
  snapshot: Row,
  organizationId: string,
  roomId: string,
  requesterMemberId: string,
  recipientMemberId: string,
  requestReplyChannelId: string,
  controller: Pick<RoomActionController, "configured">,
) {
  const { binding, controlChannelId } = controller.configured(
    organizationId,
    roomId,
    recipientMemberId,
  );
  if (binding.memberId !== requesterMemberId)
    deny("v3_controller_requester_mismatch");
  const controllerMember = rows(snapshot.memberships).find(
    (member) =>
      member.member_id === binding.memberId &&
      member.agent_id === binding.agentId &&
      member.state === "active",
  );
  const executorMember = rows(snapshot.memberships).find(
    (member) =>
      member.member_id === recipientMemberId && member.state === "active",
  );
  const control = rows(snapshot.channels).find(
    (channel) => channel.channel_id === controlChannelId,
  );
  const request = rows(snapshot.channels).find(
    (channel) => channel.channel_id === requestReplyChannelId,
  );
  const maxCiphertextBytes = Number(object(control?.limits).max_payload_bytes);
  if (
    !controllerMember ||
    !executorMember ||
    control?.kind !== "message" ||
    control.state !== "active" ||
    control.rotation_required === true ||
    !roomControlChannelIsPairwise(
      snapshot,
      roomId,
      controlChannelId,
      binding.memberId,
      recipientMemberId,
    ) ||
    control.content_type !== roomActionContentType ||
    !Number.isSafeInteger(maxCiphertextBytes) ||
    maxCiphertextBytes < roomActionMinimumChannelPayloadBytes ||
    request?.kind !== "request-reply" ||
    request.state !== "active" ||
    !roomMemberCan(
      snapshot,
      roomId,
      requestReplyChannelId,
      binding.memberId,
      "request",
    ) ||
    !roomMemberCan(
      snapshot,
      roomId,
      requestReplyChannelId,
      recipientMemberId,
      "respond",
    ) ||
    ![binding.memberId, recipientMemberId].every(
      (memberId) =>
        roomMemberCan(
          snapshot,
          roomId,
          controlChannelId,
          memberId,
          "publish",
        ) &&
        roomMemberCan(
          snapshot,
          roomId,
          controlChannelId,
          memberId,
          "subscribe",
        ),
    )
  )
    deny("v3_private_channel_unauthorized");
  return { binding, controlChannelId };
}

/** Every artifact output needs an object channel, including terminal outputs
 * retained only by the source. Routed outputs also need recipient grants. */
export function assertV3ArtifactRouteChannels(input: {
  graph: WorkflowGraphV3Definition;
  steps: Row[];
  membersByPartition: Record<string, Array<{ memberId: string; key?: string }>>;
  snapshot: Row;
  roomId: string;
}) {
  const loop = input.graph.controls.find(
    (control) => control.kind === "loop",
  ) as WorkflowGraphV3LoopControl | undefined;
  const artifactSteps = input.graph.distribution.steps.filter((step) =>
    step.outputs.some((port) => port.kind === "artifact"),
  );
  if (!artifactSteps.length) return;
  const plan = resolveWorkflowGraphV3(
    input.graph,
    input.steps.map((step) => ({
      id: String(step.id),
      enabled: step.enabled !== false,
    })),
    input.membersByPartition,
    Object.fromEntries(
      input.steps.flatMap((step) =>
        object(step.manifestSnapshot).apiVersion === "workflow-actions/v2"
          ? [[String(step.id), step.manifestSnapshot as ActionManifestV2]]
          : [],
      ),
    ),
    "v3-artifact-channel-readiness",
  );
  const routes = [
    ...plan.routes,
    ...(loop ? resolveWorkflowGraphV3InitialRoutes(loop, plan.tasks) : []),
    ...(loop ? resolveWorkflowGraphV3CarryRoutes(loop, plan.tasks) : []),
  ];
  const channels = new Map<string, string>();
  for (const distributed of artifactSteps) {
    const step = input.steps.find(
      (candidate) => candidate.id === distributed.stepId,
    );
    const channelId = object(step?.executionTarget).artifactChannelId;
    if (typeof channelId !== "string" || !channelId)
      deny("v3_artifact_channel_required");
    const channel = rows(input.snapshot.channels).find(
      (candidate) => candidate.channel_id === channelId,
    );
    if (
      channel?.kind !== "object" ||
      channel.state !== "active" ||
      channel.rotation_required === true
    )
      deny("v3_artifact_channel_unavailable");
    channels.set(distributed.stepId, channelId);
    for (const source of plan.tasks.filter(
      (task) => task.stepId === distributed.stepId,
    ))
      if (
        !roomMemberCan(
          input.snapshot,
          input.roomId,
          channelId,
          source.assignedMemberId ?? source.memberId,
          "publish",
        )
      )
        deny("v3_artifact_channel_unauthorized");
  }
  for (const route of routes) {
    const distributed = input.graph.distribution.steps.find(
      (step) => step.stepId === route.from.stepId,
    );
    if (
      distributed?.outputs.find((port) => port.name === route.from.port)
        ?.kind !== "artifact"
    )
      continue;
    const channelId = channels.get(route.from.stepId)!;
    const source = plan.tasks.find(
      (task) =>
        task.stepId === route.from.stepId &&
        task.memberId === route.from.memberId,
    );
    const recipient = plan.tasks.find(
      (task) =>
        task.stepId === route.to.stepId && task.memberId === route.to.memberId,
    );
    if (!source || !recipient) return deny("v3_artifact_route_invalid");
    if (
      !roomMemberCan(
        input.snapshot,
        input.roomId,
        channelId,
        recipient.assignedMemberId ?? recipient.memberId,
        "subscribe",
      )
    )
      deny("v3_artifact_channel_unauthorized");
  }
}

export async function resolveV3Members(
  client: PgClient | PgPool,
  input: {
    organizationId: string;
    projectId?: string | null;
    roomId: string;
    graph: WorkflowGraphV3Definition;
    steps: Row[];
    snapshot: Row;
  },
  controller: Pick<RoomActionController, "configured">,
) {
  validateWorkflowGraphV3(
    input.graph,
    input.steps.map((step) => ({
      id: String(step.id),
      enabled: step.enabled !== false,
    })),
  );
  for (const distributed of input.graph.distribution.steps) {
    const step = input.steps.find((item) => item.id === distributed.stepId);
    if (object(step?.manifestSnapshot).apiVersion !== "workflow-actions/v2")
      continue;
    if (
      distributed.placement !== "room-member" ||
      object(step?.executionTarget).kind !== "room-member" ||
      (step?.resolvedPlacement !== undefined &&
        step.resolvedPlacement !== "room-members")
    )
      deny("v3_launch_shape_unsupported");
    try {
      const manifest = step!.manifestSnapshot as ActionManifestV2;
      validateActionManifest(manifest);
      assertActionExecutionTarget(
        manifest,
        actionExecutionTargetSchema.parse(step!.executionTarget),
      );
      const registryInputs = distributed.inputs.filter(
        (port) =>
          port.name !== distributed.transfer?.sourceInput &&
          port.name !== distributed.transfer?.recipientsInput,
      );
      if (
        registryInputs.length !== Object.keys(manifest.inputs).length ||
        distributed.outputs.length !== Object.keys(manifest.outputs).length
      )
        deny("v3_registry_contract_invalid");
      for (const direction of ["inputs", "outputs"] as const)
        for (const port of direction === "inputs"
          ? registryInputs
          : distributed.outputs)
          assertGraphV3RegistryPort(port, manifest[direction][port.name]!);
    } catch {
      deny("v3_registry_contract_invalid");
    }
  }
  const memberships = rows(input.snapshot.memberships).filter(
    (member) =>
      member.state === "active" &&
      member.kind === "agent" &&
      typeof member.member_id === "string" &&
      typeof member.agent_id === "string",
  );
  const agentIds = memberships.map((member) => String(member.agent_id));
  const agents = agentIds.length
    ? (
        await client.query<Row>(
          `SELECT a.*,s.heartbeat_at FROM agent_control.agents a
         LEFT JOIN agent_control.sessions s ON s.agent_id=a.id AND
           s.generation=a.session_generation AND s.status='online'
         WHERE a.id=ANY($1::text[]) AND a.organization_id=$2
           AND (a.project_id IS NULL OR a.project_id=$3)`,
          [agentIds, input.organizationId, input.projectId ?? null],
        )
      ).rows
    : [];
  const memberById = new Map(
    memberships.map((member) => [String(member.member_id), member]),
  );
  const agentById = new Map(agents.map((agent) => [String(agent.id), agent]));
  const membersByPartition: Record<
    string,
    Array<{ memberId: string; key?: string }>
  > = {};
  for (const partition of input.graph.distribution.partitions) {
    const partitionSteps = input.graph.distribution.steps.filter(
      (step) => step.partitionId === partition.id,
    );
    const roomTargets = partitionSteps
      .filter((step) => step.placement === "room-member")
      .map((distributed) =>
        object(
          input.steps.find((step) => step.id === distributed.stepId)
            ?.executionTarget,
        ),
      );
    const registrySteps = partitionSteps.flatMap((distributed) => {
      const step = input.steps.find((item) => item.id === distributed.stepId);
      return object(step?.manifestSnapshot).apiVersion === "workflow-actions/v2"
        ? [step!]
        : [];
    });
    const registryEligible = (memberId: string) =>
      registrySteps.every((step) => {
        const target = object(step.executionTarget);
        if (
          target.kind !== "room-member" ||
          (step.resolvedPlacement !== undefined &&
            step.resolvedPlacement !== "room-members") ||
          !Array.isArray(target.memberIds) ||
          !target.memberIds.includes(memberId)
        )
          return false;
        const agent = agentById.get(String(memberById.get(memberId)?.agent_id));
        if (!agent) return false;
        const manifest = step.manifestSnapshot as ActionManifest;
        return (
          eligibleRoomMemberExecutors({
            target: { ...target, memberIds: [memberId] } as Extract<
              import("@beam-studio/shared").ActionExecutionTarget,
              { kind: "room-member" }
            >,
            roomId: input.roomId,
            snapshot: input.snapshot,
            agents: [agent],
            manifest,
            sourceRegistry: step.sourceRegistry,
            requiredHostOperations: sandboxRpcMethodsForAction(manifest).filter(
              (method) => !isRuntimeArtifactMethod(method),
            ),
          }).eligible.length === 1
        );
      });
    const declared =
      partition.members.kind === "explicit"
        ? partition.members.memberIds
        : [...memberById.keys()].sort();
    const selected = declared.filter((memberId) => {
      const member = memberById.get(memberId);
      const agent = member && agentById.get(String(member.agent_id));
      if (!agent || agent.revoked_at) return false;
      const capabilities: string[] = Array.isArray(agent.capabilities_json)
        ? agent.capabilities_json.filter(
            (value: unknown): value is string => typeof value === "string",
          )
        : [];
      if (partition.members.kind === "explicit") return true;
      return (
        (!roomTargets.length || capabilities.includes("action-execution/v1")) &&
        (partition.members.requiredCapabilities ?? []).every((name) =>
          capabilities.includes(name),
        ) &&
        roomTargets.every(
          (target) =>
            target.kind === "room-member" &&
            Array.isArray(target.memberIds) &&
            target.memberIds.includes(memberId),
        ) &&
        registryEligible(memberId)
      );
    });
    if (
      !selected.length ||
      (partition.members.kind === "explicit" &&
        selected.length !== declared.length)
    )
      deny("v3_partition_member_unavailable");
    for (const distributed of partitionSteps) {
      const step = input.steps.find(
        (candidate) => candidate.id === distributed.stepId,
      );
      if (!step) return deny("v3_step_missing");
      if (distributed.placement !== "room-member") continue;
      const target = object(step.executionTarget);
      if (
        target.kind !== "room-member" ||
        !Array.isArray(target.memberIds) ||
        !selected.every((memberId) => target.memberIds.includes(memberId))
      )
        deny("v3_step_target_mismatch");
      for (const memberId of selected) {
        const agent = agentById.get(String(memberById.get(memberId)?.agent_id));
        if (
          !Array.isArray(agent?.capabilities_json) ||
          !agent.capabilities_json.includes("action-execution/v1")
        )
          deny("v3_executor_not_opted_in");
        if (!registryEligible(memberId))
          deny("v3_registry_executor_unavailable");
        assertProtectedRoomChannel(
          input.snapshot,
          input.organizationId,
          input.roomId,
          String(target.requesterMemberId),
          memberId,
          String(target.channelId),
          controller,
        );
      }
    }
    membersByPartition[partition.id] = selected.map((memberId) => {
      const key = memberById.get(memberId)?.association_key;
      return typeof key === "string" && key ? { memberId, key } : { memberId };
    });
  }
  assertV3ArtifactRouteChannels({
    graph: input.graph,
    steps: input.steps,
    membersByPartition,
    snapshot: input.snapshot,
    roomId: input.roomId,
  });
  return { membersByPartition };
}

/** Keep the launch subset explicit even when the graph validator grows more
 * expressive. A V3 loop has one finite, literal iteration count. Top-level
 * distributed seed steps may feed its first iteration. */
export function assertV3LaunchShape(definition: FrozenWorkflowDefinition) {
  const snapshot = definition.snapshot;
  const graph = object(snapshot.distribution);
  if (
    !Array.isArray(snapshot.controls) ||
    !Array.isArray(snapshot.decisions) ||
    !Array.isArray(snapshot.edges) ||
    !Array.isArray(graph.steps) ||
    !Array.isArray(graph.routes)
  )
    deny("v3_launch_shape_unsupported");
  const controls = rows(snapshot.controls);
  const distributedSteps = rows(graph.steps);
  const decisions = rows(snapshot.decisions);
  const distributedIds = new Set(distributedSteps.map((step) => step.stepId));
  const loop = controls[0];
  const loopBodyStepIds = new Set<string>();
  if (controls.length > 1 || (controls.length === 1 && loop?.kind !== "loop"))
    deny("v3_launch_shape_unsupported");
  if (loop) {
    try {
      resolveLoopIterations(loop.iterations);
    } catch {
      deny("v3_launch_shape_unsupported");
    }
    const bodyIds = object(loop.body).stepIds;
    if (
      !Array.isArray(bodyIds) ||
      !bodyIds.length ||
      bodyIds.some((id) => !distributedIds.has(id)) ||
      distributedIds.size - new Set(bodyIds).size !== 1 ||
      !rows(object(loop.initial).routes).length
    )
      deny("v3_launch_shape_unsupported");
    for (const id of bodyIds) loopBodyStepIds.add(String(id));
  }
  if (
    decisions.length ||
    definition.resolvedSteps.some(
      (step) =>
        step.enabled !== false &&
        (step.kind === "workflow" || !distributedIds.has(step.id)),
    ) ||
    distributedSteps.some((step) => {
      const resolved = definition.resolvedSteps.find(
        (item) => item.id === step.stepId,
      );
      const distribution = object(
        object(resolved?.manifestSnapshot).execution,
      ).distribution;
      // Local workers do not publish accepted room artifact manifests or final
      // recipient receipts. A Studio transfer cannot satisfy a carried route.
      // Partitioned actions cannot run inside the distributed loop, even when
      // their only inputs are seeded or carried rather than ordinary routes.
      return (
        step.placement === "studio" ||
        (object(distribution).mode === "partitioned-reduce" &&
          (loopBodyStepIds.has(String(step.stepId)) ||
            graph.routes.some(
              (route: Row) => object(route.to).stepId === step.stepId,
            )))
      );
    })
  )
    deny("v3_launch_shape_unsupported");
}

export async function assertV3LaunchReady(
  client: PgClient,
  definition: FrozenWorkflowDefinition,
  controller: Pick<RoomActionController, "configured">,
) {
  if (definition.snapshot.graphVersion !== "workflow-graph/v3") return;
  assertV3LaunchShape(definition);
  const graph = object(definition.snapshot.distribution);
  validateWorkflowGraphV3(
    {
      version: "workflow-graph/v3",
      controls: definition.snapshot.controls,
      edges: rows(definition.snapshot.edges),
      distribution: graph,
    } as WorkflowGraphV3Definition,
    definition.resolvedSteps.map((step) => ({
      id: String(step.id),
      enabled: step.enabled !== false,
    })),
  );
  const room = resolveWorkflowRoomContext(
    null,
    object(definition.snapshot.workflowTemplate).room,
  );
  if (!room) return deny("v3_room_required");
  const snapshot = await snapshotForRoom(definition.organizationId, room);
  await resolveV3Members(
    client,
    {
      organizationId: definition.organizationId,
      projectId: definition.projectId,
      roomId: room.roomId,
      graph: {
        version: "workflow-graph/v3",
        controls: rows(definition.snapshot.controls),
        edges: rows(definition.snapshot.edges),
        distribution: graph,
      } as WorkflowGraphV3Definition,
      steps: definition.resolvedSteps,
      snapshot,
    },
    controller,
  );
}

/** Entry points without a configured private controller retain DB's V3 deny gate. */
export function configuredV3LaunchGate(): V3LaunchGate | undefined {
  const bindings = parseWebAgentControllerBindings();
  if (!bindings.length) return undefined;
  const controller = {
    configured(
      organizationId: string,
      roomId: string,
      recipientMemberId: string,
    ) {
      return requireWebAgentControllerBinding(
        bindings,
        organizationId,
        roomId,
        recipientMemberId,
      );
    },
  };
  return {
    async assertReady(client, definition) {
      await assertV3LaunchReady(client, definition, controller);
      const room = resolveWorkflowRoomContext(
        null,
        object(definition.snapshot.workflowTemplate).room,
      );
      const binding = bindings.find(
        (candidate) =>
          candidate.organizationId === definition.organizationId &&
          candidate.roomId === room?.roomId,
      );
      if (!binding)
        throw new WorkflowAuthorizationError("v3_controller_unavailable");
      const session = new WebAgentControllerSession(binding, async () => {});
      try {
        await session.connect();
      } finally {
        session.close();
      }
    },
  };
}

function assertRunCapability(presented: string | undefined, expected: string) {
  const left = Buffer.from(expected);
  const right = Buffer.from(String(presented ?? "").replace(/^Bearer /, ""));
  if (
    !left.length ||
    left.length !== right.length ||
    !timingSafeEqual(left, right)
  )
    deny("v3_run_capability_invalid");
}

export function registerV3RoomResolutionRoutes(
  server: FastifyInstance,
  pool: PgPool,
  controller: RoomActionController,
) {
  server.get<{ Params: { runId: string } }>(
    "/internal/workflow-runs/:runId/v3-room-resolution",
    {
      config: {
        auth: auth.capability(
          "/internal/workflow-runs/:runId/v3-room-resolution",
        ),
      },
    },
    async (request) => {
      const row = await pgOne<Row>(
        pool,
        `SELECT r.*,c.authorization_token FROM execution.workflow_runs r
         JOIN execution.workflow_run_capabilities c ON c.workflow_run_id=r.id
         WHERE r.id=$1`,
        [request.params.runId],
      );
      if (!row) return deny("v3_run_missing");
      assertRunCapability(
        request.headers.authorization,
        row.authorization_token,
      );
      settleRouteAuth(request);
      const snapshot = object(row.template_snapshot_json);
      if (snapshot.graphVersion !== "workflow-graph/v3")
        deny("v3_run_required");
      const steps = rows(row.resolved_steps_json);
      for (const distributed of rows(object(snapshot.distribution).steps))
        await assertWorkflowExecutionAuthorized(
          pool,
          row,
          String(distributed.stepId),
        );
      const room = resolveWorkflowRoomContext(
        null,
        object(snapshot.workflowTemplate).room,
      );
      if (!room) return deny("v3_room_required");
      const live = await snapshotForRoom(String(row.organization_id), room);
      return resolveV3Members(
        pool,
        {
          organizationId: String(row.organization_id),
          projectId: row.project_id ? String(row.project_id) : null,
          roomId: room.roomId,
          graph: {
            version: "workflow-graph/v3",
            controls: rows(snapshot.controls),
            edges: rows(snapshot.edges),
            distribution: object(snapshot.distribution),
          } as WorkflowGraphV3Definition,
          steps,
          snapshot: live,
        },
        controller,
      );
    },
  );
  server.post<{
    Params: { runId: string };
    Body: { consumerMemberId: string; artifact: unknown };
  }>(
    "/internal/workflow-runs/:runId/v3-artifact-read",
    {
      config: {
        auth: auth.capability(
          "/internal/workflow-runs/:runId/v3-artifact-read",
        ),
      },
    },
    async (request) => {
      const row = await pgOne<Row>(
        pool,
        `SELECT r.*,c.authorization_token FROM execution.workflow_runs r
       JOIN execution.workflow_run_capabilities c ON c.workflow_run_id=r.id
       WHERE r.id=$1`,
        [request.params.runId],
      );
      if (!row) return deny("v3_run_missing");
      assertRunCapability(
        request.headers.authorization,
        row.authorization_token,
      );
      settleRouteAuth(request);
      if (
        object(row.template_snapshot_json).graphVersion !== "workflow-graph/v3"
      )
        deny("v3_run_required");
      const consumerMemberId = request.body?.consumerMemberId;
      if (typeof consumerMemberId !== "string" || !consumerMemberId)
        deny("v3_artifact_reader_invalid");
      const artifact = frozenArtifactInput(
        { artifactInputs: { source: [request.body?.artifact] } },
        "source",
        0,
      );
      if (artifact.location.memberId !== consumerMemberId)
        deny("v3_artifact_reader_invalid");
      const authorization = await assertWorkflowExecutionAuthorized(pool, row);
      if (
        !authorization.room ||
        !authorization.roomSnapshot ||
        authorization.room.roomId !== artifact.location.roomId
      )
        return deny("v3_artifact_room_invalid");
      const owner = await pgOne<Row>(
        pool,
        `SELECT id FROM execution.workflow_artifact_manifests
       WHERE id=$1 AND workflow_run_id=$2 AND status='accepted'`,
        [artifact.manifestId, row.id],
      );
      if (!owner) deny("v3_artifact_manifest_unavailable");
      const current = await withPostgresTransaction(pool, (client) =>
        freezeWorkflowArtifactInputPg(client, {
          manifestId: artifact.manifestId,
          artifactId: artifact.artifactId,
          destinationMemberId: consumerMemberId,
        }),
      );
      if (!isDeepStrictEqual(current, artifact))
        deny("v3_artifact_identity_changed");
      assertRoomArtifactOperationAuthorized(
        authorization.roomSnapshot,
        authorization.room.roomId,
        {
          kind: "input.read",
          readerMemberId: consumerMemberId,
          location: {
            roomId: artifact.location.roomId,
            channelId: artifact.location.channelId,
            sourceMemberId: artifact.location.sourceMemberId,
            recipientMemberIds: [consumerMemberId],
          },
        },
      );
      return { authorized: true };
    },
  );
}
