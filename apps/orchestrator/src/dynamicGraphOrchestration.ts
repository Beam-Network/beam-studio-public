import crypto from "node:crypto";
import {
  conditionTraceForEvaluation,
  evaluateEdgeCondition,
  resolveDynamicGraphValue,
  resolveFanOutItems,
  resolveInputBindings,
  resolveWorkflowCallBindings,
  WorkflowContractError,
  resolveLoopIterations,
  validateWorkflowGraphV2,
  workflowGraphV2Limits,
  type ActionJson,
  type ActionResult,
  type WorkflowGraphV2Control,
  type WorkflowGraphV2Edge,
  type WorkflowDecision,
  type WorkflowDecisionEdge,
  type WorkflowDynamicBindingContext,
  type WorkflowStepMetadata,
} from "@beam-studio/core";
import { pgMany, pgOne, type PgClient } from "@beam-studio/db";
import {
  decisionEdgeState,
  persistDecisionEvaluation,
  resolveDecisions,
  type DecisionResolution,
} from "./decisions.js";
import type {
  ApiWorkflowStep,
  OrchestratorOptions,
  Row,
  TaskPublishRequest,
} from "./types.js";

type DynamicCallbacks = {
  createStepTask(input: {
    dynamicInstanceId?: string | null;
    inputs: Record<string, ActionJson>;
    step: ApiWorkflowStep;
  }): Promise<TaskPublishRequest | null>;
  createTerminalStep(input: {
    dynamicInstanceId?: string | null;
    reason: string;
    status: "skipped" | "not_reached" | "failed";
    step: ApiWorkflowStep;
  }): Promise<void>;
  finishRun(
    status: "completed" | "failed",
    error: string | null,
  ): Promise<void>;
  hasActiveTasks(): Promise<boolean>;
  cancelActiveWork(preservedNodeIds: string[]): Promise<void>;
  appendEvent(input: {
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
};

type DynamicGraphInput = {
  client: PgClient;
  controls: WorkflowGraphV2Control[];
  decisions: WorkflowDecision[];
  decisionEdges: WorkflowDecisionEdge[];
  edges: WorkflowGraphV2Edge[];
  options: OrchestratorOptions;
  organizationId: string;
  runtimeInputs: Record<string, ActionJson>;
  steps: ApiWorkflowStep[];
  templateSnapshot: Record<string, ActionJson>;
  workflowRunId: string;
  callbacks: DynamicCallbacks;
};

const terminalStatuses = new Set([
  "completed",
  "failed",
  "cancelled",
  "skipped",
  "not_reached",
]);
const successfulStatuses = new Set(["completed"]);

type DecisionEdgeGateState = "taken" | "not_taken" | "waiting";

export function decisionPrerequisiteGate(
  states: DecisionEdgeGateState[],
  hasPrerequisites: boolean,
): "continue" | "ready" | "waiting" | "skipped" {
  if (!states.length) return "continue";
  if (states.includes("taken")) {
    return hasPrerequisites ? "continue" : "ready";
  }
  return states.includes("waiting") ? "waiting" : "skipped";
}

/**
 * Node metadata for bindings and predicates. Status, error, timings and config
 * exist whatever the step did, unlike outputs which exist only on success.
 */
function stepMetadata(
  rows: Iterable<Row>,
  steps: ApiWorkflowStep[],
): Map<string, WorkflowStepMetadata> {
  const stepById = new Map(steps.map((step) => [step.id, step]));
  const metadata = new Map<string, WorkflowStepMetadata>();
  for (const row of rows) {
    const stepId = String(row.workflow_step_id);
    const step = stepById.get(stepId);
    metadata.set(stepId, {
      id: stepId,
      runId: row.child_run_id == null ? null : String(row.child_run_id),
      status: String(row.status),
      error: row.error == null ? null : String(row.error),
      name: step?.name ?? null,
      action: step?.actionPackage ?? null,
      attempt: row.attempt == null ? null : Number(row.attempt),
      startedAt: row.started_at == null ? null : String(row.started_at),
      completedAt: row.completed_at == null ? null : String(row.completed_at),
      config: step?.config,
    });
  }
  // Steps that never produced a run still resolve, rather than reading as unknown.
  for (const step of steps) {
    if (metadata.has(step.id)) continue;
    metadata.set(step.id, {
      id: step.id,
      status: "not_reached",
      error: null,
      name: step.name ?? null,
      action: step.actionPackage,
      config: step.config,
    });
  }
  return metadata;
}

export async function orchestrateDynamicGraphPg(input: DynamicGraphInput) {
  validateWorkflowGraphV2(
    {
      version: "workflow-graph/v2",
      controls: input.controls,
      edges: input.edges,
    },
    input.steps,
  );
  await syncDynamicInstances(input.client, input.workflowRunId);

  const stepsById = new Map(input.steps.map((step) => [step.id, step]));
  const ownedStepIds = new Set(
    input.controls.flatMap((control) => control.body.stepIds),
  );
  const topLevelSteps = input.steps.filter(
    (step) => step.enabled && !ownedStepIds.has(step.id),
  );
  const staticRuns = await pgMany<Row>(
    input.client,
    `
    SELECT *
    FROM execution.workflow_step_runs
    WHERE workflow_run_id = $1 AND dynamic_instance_id IS NULL
    `,
    [input.workflowRunId],
  );
  const staticRunsByStepId = new Map(
    staticRuns.map((row) => [String(row.workflow_step_id), row]),
  );
  const regions = await pgMany<Row>(
    input.client,
    `
    SELECT *
    FROM execution.workflow_dynamic_regions
    WHERE workflow_run_id = $1
    ORDER BY created_at ASC
    `,
    [input.workflowRunId],
  );
  const regionsByControlId = new Map(
    regions.map((row) => [String(row.control_id), row]),
  );
  const outputsByNode = new Map<string, Record<string, ActionJson>>();
  for (const row of staticRuns) {
    if (String(row.status) === "completed") {
      outputsByNode.set(
        String(row.workflow_step_id),
        row.output_json as Record<string, ActionJson>,
      );
    }
  }
  for (const control of input.controls) {
    const region = regionsByControlId.get(control.id);
    if (region?.status === "completed") {
      outputsByNode.set(
        control.kind === "fan-out" ? control.fanInId : control.id,
        objectValue(region.output_json),
      );
    }
  }

  const artifactsByStep = new Map<string, ActionResult["artifacts"]>();
  const requests: TaskPublishRequest[] = [];

  // Decisions settle before anything is dispatched: a step downstream of one
  // cannot be judged ready until the branch it sits on is known.
  const templateMeta = objectValue(input.templateSnapshot.workflowTemplate);
  const runMetadata = {
    runId: input.workflowRunId,
    name: templateMeta.name == null ? null : String(templateMeta.name),
  };
  const statusByNode = new Map<string, string>();
  const stepMetadataById = stepMetadata(staticRuns, input.steps);
  for (const [stepId, row] of staticRunsByStepId) {
    statusByNode.set(stepId, String(row.status));
  }
  for (const control of input.controls) {
    const region = regionsByControlId.get(control.id);
    if (!region) continue;
    statusByNode.set(control.id, String(region.status));
    if (control.kind === "fan-out") {
      statusByNode.set(control.fanInId, String(region.status));
    }
  }
  const decisionResolution = resolveDecisions({
    decisions: input.decisions,
    decisionEdges: input.decisionEdges,
    outputsByStep: outputsByNode,
    runtimeInputs: input.runtimeInputs,
    templateSnapshot: input.templateSnapshot,
    terminalStatuses,
    statusByNode,
    metadata: { stepsById: stepMetadataById, run: runMetadata },
  });
  for (const [decisionId, outcome] of decisionResolution.outcomes) {
    const decisionNode = input.decisions.find(
      (candidate) => candidate.id === decisionId,
    );
    if (!decisionNode) continue;
    await persistDecisionEvaluation(input.client, {
      workflowRunId: input.workflowRunId,
      decision: decisionNode,
      outcome,
    });
  }

  for (const step of topLevelSteps) {
    if (staticRunsByStepId.has(step.id)) continue;
    const decision = await topLevelDecision(input, {
      nodeId: step.id,
      outputsByNode,
      regionsByControlId,
      staticRunsByStepId,
      decisionResolution,
    });
    if (decision.state === "waiting") continue;
    if (decision.state === "skipped" || decision.state === "not_reached") {
      await input.callbacks.createTerminalStep({
        status: decision.state,
        reason: decision.reason,
        step,
      });
      continue;
    }
    try {
      const request = await input.callbacks.createStepTask({
        step,
        inputs: (step.kind === "workflow"
          ? resolveWorkflowCallBindings
          : resolveInputBindings)(
          step.inputBindings,
          input.runtimeInputs,
          input.templateSnapshot,
          outputsByNode,
          artifactsByStep,
          { stepsById: stepMetadataById, run: runMetadata },
        ),
      });
      if (request) requests.push(request);
    } catch (error) {
      if (!(error instanceof WorkflowContractError)) throw error;
      await input.callbacks.createTerminalStep({
        step,
        status: "failed",
        reason: error.message,
      });
    }
  }

  for (const control of input.controls) {
    let region = regionsByControlId.get(control.id);
    if (!region) {
      const decision = await topLevelDecision(input, {
        nodeId: control.id,
        outputsByNode,
        regionsByControlId,
        staticRunsByStepId,
        decisionResolution,
      });
      if (decision.state === "waiting") continue;
      region = await createDynamicRegion(
        input,
        control,
        decision,
        outputsByNode,
      );
      regionsByControlId.set(control.id, region);
    }
    if (["pending", "expanding", "running"].includes(String(region.status))) {
      requests.push(
        ...(await orchestrateRegion(
          input,
          control,
          region,
          stepsById,
          outputsByNode,
        )),
      );
    }
  }

  await syncDynamicInstances(input.client, input.workflowRunId);
  await refreshAllRegionSummaries(input);

  const refreshedStaticRuns = await pgMany<Row>(
    input.client,
    `SELECT * FROM execution.workflow_step_runs
     WHERE workflow_run_id = $1 AND dynamic_instance_id IS NULL`,
    [input.workflowRunId],
  );
  const refreshedRegions = await pgMany<Row>(
    input.client,
    `SELECT * FROM execution.workflow_dynamic_regions WHERE workflow_run_id = $1`,
    [input.workflowRunId],
  );
  // A failure consumed by a decision that actually evaluated does not fail the
  // run. The step run itself stays failed with its error intact.
  const handledFailures = decisionResolution.handledFailures;
  const requiredFailure = topLevelSteps.find((step) => {
    const row = refreshedStaticRuns.find(
      (candidate) => String(candidate.workflow_step_id) === step.id,
    );
    return (
      row?.status === "failed" &&
      step.required !== false &&
      !handledFailures.has(step.id)
    );
  });
  const regionFailure = refreshedRegions.find((row) => row.status === "failed");
  const allStaticTerminal = topLevelSteps.every((step) =>
    refreshedStaticRuns.some(
      (row) =>
        String(row.workflow_step_id) === step.id &&
        terminalStatuses.has(String(row.status)),
    ),
  );
  const allRegionsTerminal = input.controls.every((control) =>
    refreshedRegions.some(
      (row) =>
        String(row.control_id) === control.id &&
        terminalStatuses.has(String(row.status)),
    ),
  );
  const continueOnFailure =
    objectValue(objectValue(input.templateSnapshot.workflowTemplate).config)
      .failurePolicy === "continue_on_failure";
  if ((requiredFailure || regionFailure) && !continueOnFailure) {
    // Failure notifications remain reachable even when they do not absorb the failure.
    // Preserve the dependency closure of decisions reached from failed nodes; stop independent siblings.
    const preserved = new Set<string>();
    const failed = new Set(
      refreshedStaticRuns
        .filter((row) => row.status === "failed")
        .map((row) => String(row.workflow_step_id)),
    );
    for (const row of refreshedRegions.filter((row) => row.status === "failed"))
      failed.add(String(row.control_id));
    const links = [
      ...input.edges.map((edge) => ({ from: edge.from, to: edge.to })),
      ...input.decisionEdges.map((edge) => ({
        from: edge.fromStepId ?? edge.fromDecisionId ?? "",
        to: edge.toStepId ?? edge.toDecisionId ?? "",
      })),
    ];
    const reachable = new Set(failed);
    for (let changed = true; changed; ) {
      changed = false;
      for (const edge of links)
        if (reachable.has(edge.from) && !reachable.has(edge.to)) {
          reachable.add(edge.to);
          changed = true;
        }
    }
    for (const decision of input.decisions)
      if (reachable.has(decision.id)) preserved.add(decision.id);
    for (let changed = true; changed; ) {
      changed = false;
      for (const edge of links)
        if (preserved.has(edge.from) && !preserved.has(edge.to)) {
          preserved.add(edge.to);
          changed = true;
        }
    }
    for (let changed = true; changed; ) {
      changed = false;
      for (const edge of links)
        if (preserved.has(edge.to) && !preserved.has(edge.from)) {
          preserved.add(edge.from);
          changed = true;
        }
    }
    for (const control of input.controls)
      if (
        preserved.has(control.id) ||
        (control.kind === "fan-out" && preserved.has(control.fanInId))
      ) {
        preserved.add(control.id);
        for (const step of control.body.stepIds) preserved.add(step);
      }
    await input.callbacks.cancelActiveWork([...preserved]);
  }
  if (
    (requiredFailure || regionFailure) &&
    (!continueOnFailure || (allStaticTerminal && allRegionsTerminal)) &&
    !(await input.callbacks.hasActiveTasks())
  ) {
    const error = requiredFailure
      ? refreshedStaticRuns.find(
          (candidate) =>
            String(candidate.workflow_step_id) === requiredFailure.id,
        )?.error
      : regionFailure?.error;
    await input.callbacks.finishRun(
      "failed",
      String(error ?? "dynamic workflow region failed"),
    );
    return requests;
  }

  if (
    allStaticTerminal &&
    allRegionsTerminal &&
    !refreshedStaticRuns.some(
      (row) =>
        row.status === "failed" &&
        topLevelSteps.find((step) => step.id === row.workflow_step_id)
          ?.required !== false &&
        !handledFailures.has(String(row.workflow_step_id)),
    ) &&
    !refreshedRegions.some((row) => row.status === "failed") &&
    !(await input.callbacks.hasActiveTasks())
  ) {
    await input.callbacks.finishRun("completed", null);
  }
  return requests;
}

async function topLevelDecision(
  input: DynamicGraphInput,
  state: {
    nodeId: string;
    outputsByNode: Map<string, Record<string, ActionJson>>;
    regionsByControlId: Map<string, Row>;
    staticRunsByStepId: Map<string, Row>;
    decisionResolution: DecisionResolution;
  },
): Promise<
  | { state: "ready" }
  | { state: "waiting" }
  | { state: "skipped" | "not_reached"; reason: string }
> {
  const incoming = input.edges.filter((edge) => edge.to === state.nodeId);
  const incomingDecisionEdges = input.decisionEdges.filter(
    (edge) => edge.toStepId === state.nodeId,
  );

  // Decision edges gate the node while ordinary incoming edges remain its
  // prerequisites. This matters for composite actions: a selected branch must
  // wait for its bound resources, and completed resources must never reactivate
  // an unselected branch.
  if (incomingDecisionEdges.length) {
    const states = incomingDecisionEdges.map((edge) =>
      decisionEdgeState(edge, state.decisionResolution.outcomes),
    );
    const gate = decisionPrerequisiteGate(states, incoming.length > 0);
    if (gate === "ready") return { state: "ready" };
    if (gate === "waiting") return { state: "waiting" };
    if (gate === "skipped") {
      return { state: "skipped", reason: "incoming_conditions_not_met" };
    }
  }

  if (!incoming.length) return { state: "ready" };
  const statuses = incoming.map((edge) =>
    nodeStatus(input.controls, edge.from, state),
  );
  if (statuses.some((status) => !status || !terminalStatuses.has(status))) {
    return { state: "waiting" };
  }
  let taken = false;
  let unreachable = false;
  for (const [index, edge] of incoming.entries()) {
    const upstreamStatus = statuses[index] ?? "not_reached";
    let result: boolean | undefined;
    if (
      successfulStatuses.has(upstreamStatus) ||
      (upstreamStatus === "failed" &&
        edge.condition == null &&
        objectValue(objectValue(input.templateSnapshot.workflowTemplate).config)
          .failurePolicy === "continue_on_failure")
    ) {
      result = evaluateEdgeCondition(
        edge.condition,
        input.runtimeInputs,
        input.templateSnapshot,
        state.outputsByNode,
        new Map(),
      );
      taken ||= result;
    } else {
      unreachable = true;
    }
    const trace = conditionTraceForEvaluation({
      conditionPresent: edge.condition !== undefined && edge.condition !== null,
      result,
      upstreamStatus: successfulStatuses.has(upstreamStatus)
        ? undefined
        : upstreamStatus,
    });
    await persistConditionTrace(input.client, {
      workflowRunId: input.workflowRunId,
      scopeKey: "root",
      edge,
      trace,
    });
  }
  if (taken) return { state: "ready" };
  return unreachable
    ? { state: "not_reached", reason: "upstream_not_reached" }
    : { state: "skipped", reason: "incoming_conditions_not_met" };
}

function nodeStatus(
  controls: WorkflowGraphV2Control[],
  nodeId: string,
  state: {
    regionsByControlId: Map<string, Row>;
    staticRunsByStepId: Map<string, Row>;
  },
) {
  const stepRun = state.staticRunsByStepId.get(nodeId);
  if (stepRun) return String(stepRun.status);
  const control = controls.find(
    (candidate) =>
      candidate.id === nodeId ||
      (candidate.kind === "fan-out" && candidate.fanInId === nodeId),
  );
  return control
    ? String(state.regionsByControlId.get(control.id)?.status ?? "") || null
    : null;
}

async function createDynamicRegion(
  input: DynamicGraphInput,
  control: WorkflowGraphV2Control,
  decision:
    | { state: "ready" }
    | { state: "skipped" | "not_reached"; reason: string },
  outputsByNode: Map<string, Record<string, ActionJson>>,
) {
  const timestamp = now();
  const regionId = stableId("wfreg", `${input.workflowRunId}:${control.id}`);
  const terminal = decision.state !== "ready";
  let resolved: ActionJson = null;
  let itemCount = 0;
  let concurrency: number | null = null;
  if (!terminal) {
    resolved =
      resolveInputBindings(
        { value: control.kind === "loop" ? control.iterations : control.items },
        input.runtimeInputs,
        input.templateSnapshot,
        outputsByNode,
        new Map(),
      ).value ?? null;
    itemCount =
      control.kind === "loop"
        ? resolveLoopIterations(resolved)
        : resolveFanOutItems(resolved).length;
    concurrency =
      control.kind === "fan-out"
        ? (control.concurrency ??
          workflowGraphV2Limits.defaultFanOutConcurrency)
        : 1;
  }
  const status = terminal
    ? decision.state
    : itemCount === 0
      ? "completed"
      : "running";
  const output = itemCount === 0 ? { values: [], value: null } : {};
  await input.client.query(
    `
    INSERT INTO execution.workflow_dynamic_regions (
      id, workflow_run_id, control_id, control_path, kind, status,
      definition_json, resolved_input_json, output_json, instance_count,
      concurrency_limit, error, started_at, completed_at, created_at, updated_at
    )
    VALUES ($1, $2, $3, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb,
      $9, $10, $11, $12, $13, $12, $12)
    ON CONFLICT (workflow_run_id, control_path) DO NOTHING
    `,
    [
      regionId,
      input.workflowRunId,
      control.id,
      control.kind,
      status,
      JSON.stringify(control),
      JSON.stringify(resolved),
      JSON.stringify(output),
      itemCount * control.body.stepIds.length,
      concurrency,
      terminal ? decision.reason : null,
      timestamp,
      terminal || itemCount === 0 ? timestamp : null,
    ],
  );
  if (!terminal) {
    const values =
      control.kind === "fan-out" ? resolveFanOutItems(resolved) : [];
    for (let instanceIndex = 0; instanceIndex < itemCount; instanceIndex += 1) {
      const context = {
        [control.id]: {
          index: instanceIndex,
          ...(control.kind === "loop"
            ? { iteration: instanceIndex + 1, previous: null }
            : { item: values[instanceIndex] ?? null }),
        },
      };
      for (const stepId of control.body.stepIds) {
        await input.client.query(
          `
          INSERT INTO execution.workflow_dynamic_instances (
            id, workflow_run_id, dynamic_region_id, workflow_step_id,
            control_path, instance_index, status, current_attempt, context_json,
            created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'pending', 1, $7::jsonb, $8, $8)
          ON CONFLICT (workflow_run_id, control_path, workflow_step_id, instance_index)
          DO NOTHING
          `,
          [
            stableId(
              "wfdyn",
              `${input.workflowRunId}:${control.id}:${stepId}:${instanceIndex}`,
            ),
            input.workflowRunId,
            regionId,
            stepId,
            control.id,
            instanceIndex,
            JSON.stringify(context),
            timestamp,
          ],
        );
      }
    }
  }
  await input.callbacks.appendEvent({
    eventType: "DynamicRegionCreated",
    payload: {
      controlId: control.id,
      kind: control.kind,
      itemCount,
      status,
    },
  });
  return (
    (await pgOne<Row>(
      input.client,
      `SELECT * FROM execution.workflow_dynamic_regions
       WHERE workflow_run_id = $1 AND control_path = $2`,
      [input.workflowRunId, control.id],
    )) ?? { id: regionId, control_id: control.id, status }
  );
}

async function orchestrateRegion(
  input: DynamicGraphInput,
  control: WorkflowGraphV2Control,
  region: Row,
  stepsById: Map<string, ApiWorkflowStep>,
  topLevelOutputs: Map<string, Record<string, ActionJson>>,
) {
  await settleBlockedBodyNodes(input, control, region);
  let instances = await regionInstances(input.client, String(region.id));
  if (!instances.length) return [];

  const indexes = [
    ...new Set(instances.map((row) => Number(row.instance_index))),
  ].sort((left, right) => left - right);
  let admittedIndexes: number[];
  if (control.kind === "loop") {
    const firstIncomplete = indexes.find((index) =>
      instances.some(
        (row) =>
          Number(row.instance_index) === index &&
          String(row.status) !== "completed" &&
          String(row.status) !== "skipped",
      ),
    );
    if (firstIncomplete === undefined) return [];
    const priorFailed = instances.some(
      (row) =>
        Number(row.instance_index) === firstIncomplete &&
        String(row.status) === "failed",
    );
    admittedIndexes = priorFailed ? [] : [firstIncomplete];
  } else {
    const active = indexes.filter((index) => shardIsActive(instances, index));
    const available = Math.max(
      0,
      (control.concurrency ?? workflowGraphV2Limits.defaultFanOutConcurrency) -
        active.length,
    );
    const fresh = indexes
      .filter((index) => shardIsFresh(instances, index))
      .slice(0, available);
    admittedIndexes = [...active, ...fresh];
  }

  const requests: TaskPublishRequest[] = [];
  for (const index of admittedIndexes) {
    const rows = instances.filter(
      (row) => Number(row.instance_index) === index,
    );
    const rowsByStepId = new Map(
      rows.map((row) => [String(row.workflow_step_id), row]),
    );
    const bodyOutputs = new Map(topLevelOutputs);
    for (const row of rows) {
      if (String(row.status) === "completed") {
        bodyOutputs.set(
          String(row.workflow_step_id),
          row.output_json as Record<string, ActionJson>,
        );
      }
    }
    for (const stepId of control.body.stepIds) {
      const instance = rowsByStepId.get(stepId);
      const step = stepsById.get(stepId);
      if (!instance || !step || String(instance.status) !== "pending") continue;
      const incoming = control.body.edges.filter((edge) => edge.to === stepId);
      if (
        incoming.some((edge) => {
          const status = String(rowsByStepId.get(edge.from)?.status ?? "");
          return !terminalStatuses.has(status);
        })
      ) {
        continue;
      }
      let shouldRun = incoming.length === 0;
      let unreachable = false;
      for (const edge of incoming) {
        const upstreamStatus = String(
          rowsByStepId.get(edge.from)?.status ?? "not_reached",
        );
        let result: boolean | undefined;
        if (upstreamStatus === "completed") {
          const context = objectValue(
            instance.context_json,
          ) as unknown as WorkflowDynamicBindingContext;
          const condition = resolveDynamicGraphValue(
            (edge.condition ?? true) as ActionJson,
            context,
          );
          result = evaluateEdgeCondition(
            condition,
            input.runtimeInputs,
            input.templateSnapshot,
            bodyOutputs,
            new Map(),
          );
          shouldRun ||= result;
        } else {
          unreachable = true;
        }
        await persistConditionTrace(input.client, {
          workflowRunId: input.workflowRunId,
          regionId: String(region.id),
          instanceId: String(instance.id),
          scopeKey: `${control.id}:${index}`,
          edge,
          trace: conditionTraceForEvaluation({
            conditionPresent:
              edge.condition !== undefined && edge.condition !== null,
            result,
            upstreamStatus:
              upstreamStatus === "completed" ? undefined : upstreamStatus,
          }),
        });
      }
      if (!shouldRun) {
        await input.callbacks.createTerminalStep({
          dynamicInstanceId: String(instance.id),
          status: unreachable ? "not_reached" : "skipped",
          reason: unreachable
            ? "upstream_not_reached"
            : "incoming_conditions_not_met",
          step,
        });
        continue;
      }
      const context = objectValue(
        instance.context_json,
      ) as unknown as WorkflowDynamicBindingContext;
      if (control.kind === "loop" && index > 0) {
        const previous = instances.find(
          (row) =>
            Number(row.instance_index) === index - 1 &&
            String(row.workflow_step_id) === control.body.outputStepId,
        );
        if (previous?.status === "completed") {
          const controlContext = context[control.id];
          if (controlContext) {
            context[control.id] = {
              ...controlContext,
              previous: previous.output_json as ActionJson,
            };
          }
          await input.client.query(
            `UPDATE execution.workflow_dynamic_instances
             SET context_json = $2::jsonb, updated_at = $3 WHERE id = $1`,
            [String(instance.id), JSON.stringify(context), now()],
          );
        }
      }
      const dynamicBindings = resolveDynamicGraphValue(
        step.inputBindings,
        context,
      ) as Record<string, ActionJson>;
      await input.client.query(
        `UPDATE execution.workflow_dynamic_instances
         SET status = 'queued', input_json = $2::jsonb,
             started_at = COALESCE(started_at, $3), updated_at = $3
         WHERE id = $1 AND status = 'pending'`,
        [String(instance.id), JSON.stringify(dynamicBindings), now()],
      );
      try {
        const request = await input.callbacks.createStepTask({
          dynamicInstanceId: String(instance.id),
          step,
          inputs: (step.kind === "workflow"
            ? resolveWorkflowCallBindings
            : resolveInputBindings)(
            dynamicBindings,
            input.runtimeInputs,
            input.templateSnapshot,
            bodyOutputs,
            new Map(),
            { stepsById: stepMetadata(rowsByStepId.values(), input.steps) },
          ),
        });
        if (request) requests.push(request);
      } catch (error) {
        if (!(error instanceof WorkflowContractError)) throw error;
        await input.callbacks.createTerminalStep({
          step,
          dynamicInstanceId: String(instance.id),
          status: "failed",
          reason: error.message,
        });
      }
    }
  }
  instances = await regionInstances(input.client, String(region.id));
  return requests;
}

async function settleBlockedBodyNodes(
  input: DynamicGraphInput,
  control: WorkflowGraphV2Control,
  region: Row,
) {
  const instances = await regionInstances(input.client, String(region.id));
  const indexes = [
    ...new Set(instances.map((row) => Number(row.instance_index))),
  ];
  for (const index of indexes) {
    const rows = instances.filter(
      (row) => Number(row.instance_index) === index,
    );
    const rowsByStepId = new Map(
      rows.map((row) => [String(row.workflow_step_id), row]),
    );
    for (const row of rows) {
      if (String(row.status) !== "pending") continue;
      const incoming = control.body.edges.filter(
        (edge) => edge.to === String(row.workflow_step_id),
      );
      if (
        incoming.length > 0 &&
        incoming.every((edge) =>
          terminalStatuses.has(
            String(rowsByStepId.get(edge.from)?.status ?? ""),
          ),
        ) &&
        incoming.every(
          (edge) => String(rowsByStepId.get(edge.from)?.status) !== "completed",
        )
      ) {
        await input.client.query(
          `UPDATE execution.workflow_dynamic_instances
           SET status = 'not_reached', error = 'upstream_not_reached',
               completed_at = $2, updated_at = $2
           WHERE id = $1 AND status = 'pending'`,
          [String(row.id), now()],
        );
      }
    }
  }
}

async function refreshAllRegionSummaries(input: DynamicGraphInput) {
  for (const control of input.controls) {
    const region = await pgOne<Row>(
      input.client,
      `SELECT * FROM execution.workflow_dynamic_regions
       WHERE workflow_run_id = $1 AND control_id = $2`,
      [input.workflowRunId, control.id],
    );
    if (
      !region ||
      ["skipped", "not_reached", "cancelled"].includes(String(region.status))
    ) {
      continue;
    }
    const instances = await regionInstances(input.client, String(region.id));
    if (!instances.length) continue;
    const completed = instances.filter(
      (row) => row.status === "completed",
    ).length;
    const failed = instances.filter((row) => row.status === "failed").length;
    const cancelled = instances.filter(
      (row) => row.status === "cancelled",
    ).length;
    const indexes = [
      ...new Set(instances.map((row) => Number(row.instance_index))),
    ].sort((left, right) => left - right);
    const allTerminal = instances.every((row) =>
      terminalStatuses.has(String(row.status)),
    );
    const loopFailed =
      control.kind === "loop" &&
      instances.some((row) => row.status === "failed");
    if (region.status === "cancel_requested") {
      await updateRegionCounts(
        input.client,
        region,
        completed,
        failed,
        cancelled,
        allTerminal ? "cancelled" : "cancel_requested",
      );
      if (allTerminal)
        await input.client.query(
          "UPDATE execution.workflow_dynamic_regions SET completed_at=COALESCE(completed_at,now()) WHERE id=$1",
          [String(region.id)],
        );
      continue;
    }
    if (!allTerminal && !loopFailed) {
      await updateRegionCounts(
        input.client,
        region,
        completed,
        failed,
        cancelled,
        "running",
      );
      continue;
    }
    const status =
      failed > 0 ? "failed" : cancelled > 0 ? "cancelled" : "completed";
    const outputs = indexes.map((index) => {
      const output = instances.find(
        (row) =>
          Number(row.instance_index) === index &&
          String(row.workflow_step_id) === control.body.outputStepId,
      );
      return output?.status === "completed"
        ? (output.output_json as Record<string, ActionJson>)
        : null;
    });
    const output = {
      values: outputs,
      value: outputs.at(-1) ?? null,
    };
    await input.client.query(
      `
      UPDATE execution.workflow_dynamic_regions
      SET status = $2, completed_count = $3, failed_count = $4,
          cancelled_count = $5, output_json = $6::jsonb,
          error = CASE WHEN $2 = 'failed' THEN COALESCE(error, 'dynamic action instance failed') ELSE error END,
          completed_at = COALESCE(completed_at, $7), updated_at = $7
      WHERE id = $1
      `,
      [
        String(region.id),
        status,
        completed,
        failed,
        cancelled,
        JSON.stringify(output),
        now(),
      ],
    );
    if (String(region.status) !== status) {
      await input.callbacks.appendEvent({
        eventType:
          status === "completed"
            ? "DynamicRegionCompleted"
            : status === "failed"
              ? "DynamicRegionFailed"
              : "DynamicRegionCancelled",
        payload: {
          controlId: control.id,
          status,
          completed,
          failed,
          cancelled,
        },
      });
    }
  }
}

async function updateRegionCounts(
  client: PgClient,
  region: Row,
  completed: number,
  failed: number,
  cancelled: number,
  status: string,
) {
  await client.query(
    `UPDATE execution.workflow_dynamic_regions
     SET status = $2, completed_count = $3, failed_count = $4,
         cancelled_count = $5, updated_at = $6 WHERE id = $1`,
    [String(region.id), status, completed, failed, cancelled, now()],
  );
}

async function syncDynamicInstances(client: PgClient, workflowRunId: string) {
  await client.query(
    `
    UPDATE execution.workflow_dynamic_instances instance
    SET status = step_run.status,
        input_json = step_run.input_json,
        output_json = step_run.output_json,
        metadata_json = step_run.metadata_json,
        error = step_run.error,
        current_attempt = step_run.attempt,
        started_at = COALESCE(instance.started_at, step_run.started_at),
        completed_at = step_run.completed_at,
        updated_at = GREATEST(instance.updated_at, step_run.updated_at)
    FROM execution.workflow_step_runs step_run
    WHERE instance.workflow_run_id = $1
      AND step_run.dynamic_instance_id = instance.id
      AND (
        instance.status IS DISTINCT FROM step_run.status
        OR instance.updated_at < step_run.updated_at
      )
    `,
    [workflowRunId],
  );
}

async function regionInstances(client: PgClient, regionId: string) {
  return pgMany<Row>(
    client,
    `SELECT * FROM execution.workflow_dynamic_instances
     WHERE dynamic_region_id = $1
     ORDER BY instance_index ASC, created_at ASC`,
    [regionId],
  );
}

function shardIsFresh(instances: Row[], index: number) {
  return instances
    .filter((row) => Number(row.instance_index) === index)
    .every((row) => row.status === "pending");
}

function shardIsActive(instances: Row[], index: number) {
  const rows = instances.filter((row) => Number(row.instance_index) === index);
  return (
    rows.some((row) => ["queued", "running"].includes(String(row.status))) ||
    (rows.some((row) => row.status === "completed") &&
      !rows.every((row) => terminalStatuses.has(String(row.status))))
  );
}

export async function persistConditionTrace(
  client: PgClient,
  input: {
    workflowRunId: string;
    regionId?: string;
    instanceId?: string;
    scopeKey: string;
    edge: WorkflowGraphV2Edge;
    trace: ReturnType<typeof conditionTraceForEvaluation>;
  },
) {
  const edgeId =
    input.edge.id ?? stableId("edge", `${input.edge.from}:${input.edge.to}`);
  await client.query(
    `
    INSERT INTO execution.workflow_condition_evaluations (
      id, workflow_run_id, dynamic_region_id, dynamic_instance_id, scope_key,
      edge_id, from_node_id, to_node_id, outcome, result, reason, summary_json,
      created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
      $12::jsonb, $13)
    ON CONFLICT (workflow_run_id, scope_key, edge_id) DO UPDATE SET
      outcome = EXCLUDED.outcome,
      result = EXCLUDED.result,
      reason = EXCLUDED.reason,
      summary_json = EXCLUDED.summary_json
    `,
    [
      stableId("wfcond", `${input.workflowRunId}:${input.scopeKey}:${edgeId}`),
      input.workflowRunId,
      input.regionId ?? null,
      input.instanceId ?? null,
      input.scopeKey,
      edgeId,
      input.edge.from,
      input.edge.to,
      input.trace.outcome,
      input.trace.result,
      input.trace.reason,
      JSON.stringify({
        conditionPresent:
          input.edge.condition !== undefined && input.edge.condition !== null,
        conditionType:
          input.edge.condition === null
            ? "null"
            : Array.isArray(input.edge.condition)
              ? "array"
              : typeof input.edge.condition,
      }),
      now(),
    ],
  );
}

function objectValue(value: unknown): Record<string, ActionJson> {
  const parsed = jsonValue(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, ActionJson>)
    : {};
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stableId(prefix: string, seed: string) {
  return `${prefix}_${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

function now() {
  return new Date().toISOString();
}
