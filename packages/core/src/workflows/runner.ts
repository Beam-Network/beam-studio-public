import {
  ActionInputError,
  ActionPermissionError,
  ActionPlacementError,
  ActionTrustError,
  defaultPlacement,
  supportedPlacements,
  type ActionContext,
  type ActionJson,
  type ActionLogger,
  type ActionPermission,
  type ActionPlacement,
  type ActionResult,
  type ActionTrustLevel,
  type BeamRuntime,
  type RegisteredActionPackage,
} from "./actions.js";
import {
  resolveNodeMetadata,
  type WorkflowMetadataContext,
  type WorkflowStepMetadata,
} from "./node-metadata.js";
import { type LocalActionRegistry } from "./registry.js";
import {
  validateWorkflowGraphV2,
  type WorkflowGraphV2Control,
} from "./graph-v2.js";

export type WorkflowStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkflowStepStatus = WorkflowStatus | "skipped";

export type WorkflowTemplateStep = {
  executionTarget?: import("@beam-studio/shared").ActionExecutionTarget;
  id: string;
  kind?: "action" | "workflow";
  calledWorkflowId?: string | null;
  /** Operator-facing label for the node, independent of its action package. */
  name?: string | null;
  position: number;
  enabled: boolean;
  actionPackage: string;
  versionRange: string;
  config: Record<string, ActionJson>;
  inputBindings: Record<string, ActionJson>;
  placement?: ActionPlacement;
  executionLocationId?: string | null;
  timeoutSeconds?: number | null;
  required?: boolean;
};

export type WorkflowRunSnapshot = {
  workflowRunId: string;
  templateId: string;
  templateSnapshot: Record<string, ActionJson>;
  runtimeInputs: Record<string, ActionJson>;
  steps: WorkflowTemplateStep[];
};

export type WorkflowEdge = {
  id?: string;
  from: string;
  to: string;
  condition?: ActionJson;
};

export type WorkflowGraphRunSnapshot = WorkflowRunSnapshot & {
  graphVersion?: "workflow-graph/v1" | "workflow-graph/v2";
  edges: WorkflowEdge[];
  controls?: WorkflowGraphV2Control[];
};

export type ResolvedWorkflowStep = WorkflowTemplateStep & {
  resolvedVersion: string;
  checksum: string;
  sourceRegistry: "builtin";
  resolvedPlacement: ActionPlacement;
  executionLocationId: string | null;
  package: RegisteredActionPackage;
};

export type WorkflowStepRunRecord = {
  id: string;
  workflowRunId: string;
  stepId: string;
  status: WorkflowStepStatus;
  attempt: number;
  state: Record<string, ActionJson>;
  externalRef: string | null;
};

export type WorkflowRunStore = {
  createStepRun(input: {
    workflowRunId: string;
    step: ResolvedWorkflowStep;
    inputs: Record<string, ActionJson>;
    attempt: number;
  }): Promise<WorkflowStepRunRecord>;
  updateStepRun(
    stepRunId: string,
    patch: {
      status?: WorkflowStepStatus;
      output?: Record<string, ActionJson>;
      metadata?: Record<string, ActionJson>;
      state?: Record<string, ActionJson>;
      externalRef?: string | null;
      error?: string | null;
      artifacts?: ActionResult["artifacts"];
    },
  ): Promise<void>;
  updateWorkflowRun(
    workflowRunId: string,
    patch: { status: WorkflowStatus; error?: string | null },
  ): Promise<void>;
  log(input: {
    workflowRunId: string;
    stepRunId?: string | null;
    event: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
};

export type WorkflowRunnerOptions = {
  registry: LocalActionRegistry;
  store: WorkflowRunStore;
  logger?: ActionLogger;
  signal?: AbortSignal;
  stepTimeoutMs?: number;
  permissions?: {
    allowed?: ActionPermission[];
    denied?: ActionPermission[];
  };
  trustPolicy?: {
    allowedTrustLevels?: ActionTrustLevel[];
  };
  placementPolicy?: {
    allowedPlacements?: ActionPlacement[];
    enabledExecutionLocationIds?: string[];
    allowInsecureHttpExecutionLocations?: boolean;
  };
  secrets?: Record<string, string>;
  allowedSecrets?: string[];
  beam?: BeamRuntime;
  graphConcurrency?: number;
};

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowValidationError";
  }
}

export async function runLinearWorkflow(
  snapshot: WorkflowRunSnapshot,
  options: WorkflowRunnerOptions,
) {
  validateLinearWorkflow(snapshot);
  const logger = options.logger ?? noopLogger;
  const outputsByStep = new Map<string, Record<string, ActionJson>>();
  const stepMetadataById = new Map<string, WorkflowStepMetadata>();
  const artifactsByStep = new Map<string, ActionResult["artifacts"]>();
  await options.store.updateWorkflowRun(snapshot.workflowRunId, {
    status: "running",
  });

  const activeSteps = snapshot.steps
    .filter((step) => step.enabled)
    .sort((left, right) => left.position - right.position)
    .map((step) => resolveStep(step, options.registry));

  try {
    for (const step of activeSteps) {
      throwIfAborted(options.signal);
      const inputs = resolveInputBindings(
        step.inputBindings,
        snapshot.runtimeInputs,
        snapshot.templateSnapshot,
        outputsByStep,
        artifactsByStep,
        { stepsById: stepMetadataById },
      );
      enforceActionPolicy(step, options);
      const result = await executeResolvedStep(snapshot, step, inputs, options, logger);
      outputsByStep.set(step.id, result.outputs);
      artifactsByStep.set(step.id, result.artifacts);
      stepMetadataById.set(step.id, {
        id: step.id,
        status: "completed",
        error: null,
        name: step.name ?? null,
        action: step.actionPackage,
        config: step.config,
      });
    }

    await options.store.updateWorkflowRun(snapshot.workflowRunId, {
      status: "completed",
    });
  } catch (error) {
    const aborted = options.signal?.aborted;
    await options.store.updateWorkflowRun(snapshot.workflowRunId, {
      status: aborted ? "cancelled" : "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function runGraphWorkflow(
  snapshot: WorkflowGraphRunSnapshot,
  options: WorkflowRunnerOptions,
) {
  validateGraphWorkflow(snapshot);
  const logger = options.logger ?? noopLogger;
  const outputsByStep = new Map<string, Record<string, ActionJson>>();
  const artifactsByStep = new Map<string, ActionResult["artifacts"]>();
  const stepMetadataById = new Map<string, WorkflowStepMetadata>();
  const settledStepIds = new Set<string>();
  const skippedStepIds = new Set<string>();
  const pendingStepIds = new Set(
    snapshot.steps.filter((step) => step.enabled).map((step) => step.id),
  );
  const stepsById = new Map(
    snapshot.steps
      .filter((step) => step.enabled)
      .map((step) => [step.id, resolveStep(step, options.registry)]),
  );
  const incomingByStep = groupIncomingEdges(snapshot.edges);
  const concurrency = Math.max(1, options.graphConcurrency ?? 4);

  await options.store.updateWorkflowRun(snapshot.workflowRunId, {
    status: "running",
  });

  try {
    while (pendingStepIds.size) {
      throwIfAborted(options.signal);
      const ready = [...pendingStepIds].filter((stepId) =>
        (incomingByStep.get(stepId) ?? []).every((edge) =>
          settledStepIds.has(edge.from),
        ),
      );

      if (!ready.length) {
        throw new WorkflowValidationError(
          "Workflow graph has no executable steps; check for cycles or unsatisfied dependencies.",
        );
      }

      const batch = ready.slice(0, concurrency);
      await Promise.all(
        batch.map(async (stepId) => {
          const step = stepsById.get(stepId);
          if (!step) {
            return;
          }
          const incoming = incomingByStep.get(stepId) ?? [];
          const shouldRun = incoming.length === 0 ||
            incoming.some(
              (edge) =>
                !skippedStepIds.has(edge.from) &&
                evaluateEdgeCondition(
                  edge.condition,
                  snapshot.runtimeInputs,
                  snapshot.templateSnapshot,
                  outputsByStep,
                  artifactsByStep,
                ),
            );

          if (!shouldRun) {
            await skipResolvedStep(snapshot, step, options);
            stepMetadataById.set(step.id, {
              id: step.id,
              status: "skipped",
              error: null,
              name: step.name ?? null,
              action: step.actionPackage,
              config: step.config,
            });
            skippedStepIds.add(step.id);
            settledStepIds.add(step.id);
            pendingStepIds.delete(step.id);
            return;
          }

          const inputs = resolveInputBindings(
            step.inputBindings,
            snapshot.runtimeInputs,
            snapshot.templateSnapshot,
            outputsByStep,
            artifactsByStep,
            { stepsById: stepMetadataById },
          );
          enforceActionPolicy(step, options);
          const result = await executeResolvedStep(
            snapshot,
            step,
            inputs,
            options,
            logger,
          );
          outputsByStep.set(step.id, result.outputs);
          artifactsByStep.set(step.id, result.artifacts);
          stepMetadataById.set(step.id, {
            id: step.id,
            status: "completed",
            error: null,
            name: step.name ?? null,
            action: step.actionPackage,
            config: step.config,
          });
          settledStepIds.add(step.id);
          pendingStepIds.delete(step.id);
        }),
      );
    }

    await options.store.updateWorkflowRun(snapshot.workflowRunId, {
      status: "completed",
    });
  } catch (error) {
    const aborted = options.signal?.aborted;
    await options.store.updateWorkflowRun(snapshot.workflowRunId, {
      status: aborted ? "cancelled" : "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function validateLinearWorkflow(snapshot: WorkflowRunSnapshot) {
  const activeSteps = snapshot.steps.filter((step) => step.enabled);
  const positions = new Set<number>();
  const seenStepIds = new Set<string>();

  for (const step of activeSteps) {
    if (!Number.isInteger(step.position) || step.position < 0) {
      throw new WorkflowValidationError(
        `Workflow step "${step.id}" has an invalid position.`,
      );
    }
    if (positions.has(step.position)) {
      throw new WorkflowValidationError(
        `Workflow step position "${step.position}" is duplicated.`,
      );
    }
    positions.add(step.position);
    if (seenStepIds.has(step.id)) {
      throw new WorkflowValidationError(
        `Workflow step id "${step.id}" is duplicated.`,
      );
    }
    seenStepIds.add(step.id);
  }

  seenStepIds.clear();
  for (const step of activeSteps.sort((left, right) => left.position - right.position)) {
    rejectGraphFeatureBindings(step.inputBindings);
    assertNoFutureReferences(step, seenStepIds);
    seenStepIds.add(step.id);
  }
}

export function validateGraphWorkflow(snapshot: WorkflowGraphRunSnapshot) {
  if (
    snapshot.graphVersion &&
    snapshot.graphVersion !== "workflow-graph/v1" &&
    snapshot.graphVersion !== "workflow-graph/v2"
  ) {
    throw new WorkflowValidationError(
      `Unsupported workflow graph version "${snapshot.graphVersion}".`,
    );
  }
  validateGraphSteps(snapshot);
  if (snapshot.graphVersion === "workflow-graph/v2") {
    try {
      validateWorkflowGraphV2(
        {
          version: "workflow-graph/v2",
          controls: snapshot.controls ?? [],
          edges: snapshot.edges,
        },
        snapshot.steps,
      );
    } catch (error) {
      throw new WorkflowValidationError(
        error instanceof Error ? error.message : String(error),
      );
    }
    for (const step of snapshot.steps.filter((candidate) => candidate.enabled)) {
      assertStepReferencesKnown(
        step,
        new Set(
          snapshot.steps
            .filter((candidate) => candidate.enabled)
            .map((candidate) => candidate.id),
        ),
      );
    }
    return;
  }
  const activeStepIds = new Set(
    snapshot.steps.filter((step) => step.enabled).map((step) => step.id),
  );
  const edgeKeys = new Set<string>();
  const outgoing = new Map<string, string[]>();
  const incomingCount = new Map<string, number>();

  for (const stepId of activeStepIds) {
    outgoing.set(stepId, []);
    incomingCount.set(stepId, 0);
  }

  for (const edge of snapshot.edges) {
    if (!activeStepIds.has(edge.from) || !activeStepIds.has(edge.to)) {
      throw new WorkflowValidationError(
        `Workflow edge "${edge.from} -> ${edge.to}" references an unknown or disabled step.`,
      );
    }
    if (edge.from === edge.to) {
      throw new WorkflowValidationError(
        `Workflow edge "${edge.from} -> ${edge.to}" cannot target the same step.`,
      );
    }
    const edgeKey = `${edge.from}\u0000${edge.to}`;
    if (edgeKeys.has(edgeKey)) {
      throw new WorkflowValidationError(
        `Workflow edge "${edge.from} -> ${edge.to}" is duplicated.`,
      );
    }
    edgeKeys.add(edgeKey);
    outgoing.get(edge.from)?.push(edge.to);
    incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
  }

  const ready = [...incomingCount.entries()]
    .filter(([, count]) => count === 0)
    .map(([stepId]) => stepId);
  const visited = new Set<string>();
  while (ready.length) {
    const stepId = ready.shift();
    if (!stepId) {
      continue;
    }
    visited.add(stepId);
    for (const next of outgoing.get(stepId) ?? []) {
      const count = (incomingCount.get(next) ?? 0) - 1;
      incomingCount.set(next, count);
      if (count === 0) {
        ready.push(next);
      }
    }
  }

  if (visited.size !== activeStepIds.size) {
    throw new WorkflowValidationError("Workflow graph contains a cycle.");
  }

  for (const step of snapshot.steps.filter((candidate) => candidate.enabled)) {
    assertStepReferencesKnown(step, activeStepIds);
  }
}

function resolveStep(
  step: WorkflowTemplateStep,
  registry: LocalActionRegistry,
): ResolvedWorkflowStep {
  const resolvedPackage = registry.resolvePackage(
    step.actionPackage,
    step.versionRange,
  );
  const placement = step.placement ?? defaultPlacement(resolvedPackage.manifest);
  if (!supportedPlacements(resolvedPackage.manifest).includes(placement)) {
    throw new ActionPlacementError(
      `Action package "${step.actionPackage}" does not support placement "${placement}".`,
    );
  }
  return {
    ...step,
    resolvedVersion: resolvedPackage.manifest.version,
    checksum: resolvedPackage.checksum,
    sourceRegistry: "builtin",
    resolvedPlacement: placement,
    executionLocationId: step.executionLocationId ?? null,
    package: resolvedPackage,
  };
}

function enforceActionPolicy(
  step: ResolvedWorkflowStep,
  options: WorkflowRunnerOptions,
) {
  const manifest = step.package.manifest;
  const trustLevel = manifest.trustLevel ?? "builtin";
  if (trustLevel === "blocked") {
    throw new ActionTrustError(
      `Action package "${manifest.name}" is blocked and cannot execute.`,
    );
  }
  const allowedTrustLevels = options.trustPolicy?.allowedTrustLevels ?? [
    "builtin",
  ];
  if (!allowedTrustLevels.includes(trustLevel)) {
    throw new ActionTrustError(
      `Action package "${manifest.name}" trust level "${trustLevel}" is not allowed.`,
    );
  }

  const allowedPlacements = options.placementPolicy?.allowedPlacements ?? [
    "local-workers",
  ];
  if (!allowedPlacements.includes(step.resolvedPlacement)) {
    throw new ActionPlacementError(
      `Placement "${step.resolvedPlacement}" is not allowed by studio policy.`,
    );
  }
  if (
    step.executionLocationId &&
    options.placementPolicy?.enabledExecutionLocationIds &&
    !options.placementPolicy.enabledExecutionLocationIds.includes(
      step.executionLocationId,
    )
  ) {
    throw new ActionPlacementError(
      `Execution location "${step.executionLocationId}" is not enabled.`,
    );
  }

  const permissions = manifest.permissions ?? [];
  const denied = new Set(options.permissions?.denied ?? []);
  for (const permission of permissions) {
    if (denied.has(permission)) {
      throw new ActionPermissionError(
        `Action package "${manifest.name}" requests denied permission "${permission}".`,
      );
    }
  }
  const allowed = options.permissions?.allowed;
  if (allowed) {
    const allowedSet = new Set(allowed);
    for (const permission of permissions) {
      if (!allowedSet.has(permission)) {
        throw new ActionPermissionError(
          `Action package "${manifest.name}" requires ungranted permission "${permission}".`,
        );
      }
    }
  }
}

async function executeResolvedStep(
  snapshot: WorkflowRunSnapshot,
  step: ResolvedWorkflowStep,
  inputs: Record<string, ActionJson>,
  options: WorkflowRunnerOptions,
  logger: ActionLogger,
) {
  const stepRun = await options.store.createStepRun({
    workflowRunId: snapshot.workflowRunId,
    step,
    inputs,
    attempt: 1,
  });
  await options.store.updateStepRun(stepRun.id, { status: "running" });
  await options.store.log({
    workflowRunId: snapshot.workflowRunId,
    stepRunId: stepRun.id,
    event: "workflow_step_started",
    payload: {
      actionPackage: step.actionPackage,
      resolvedVersion: step.resolvedVersion,
      resolvedPlacement: step.resolvedPlacement,
      permissions: step.package.manifest.permissions ?? [],
      trustLevel: step.package.manifest.trustLevel ?? "builtin",
    },
  });

  const stateValue = { ...stepRun.state };
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const timeoutMs =
    (step.timeoutSeconds ? step.timeoutSeconds * 1000 : null) ??
    (step.package.manifest.execution?.defaultTimeoutSeconds
      ? step.package.manifest.execution.defaultTimeoutSeconds * 1000
      : null) ??
    options.stepTimeoutMs ??
    null;
  const timeout = timeoutMs
    ? setTimeout(() => controller.abort(new Error("Step timed out.")), timeoutMs)
    : null;

  try {
    const result = await step.package.execute(
      { config: step.config, inputs },
      {
        workflowRunId: snapshot.workflowRunId,
        stepRunId: stepRun.id,
        stepId: step.id,
        attempt: stepRun.attempt,
        logger,
        state: {
          get: () => ({ ...stateValue }),
          set: async (nextState) => {
            Object.keys(stateValue).forEach((key) => delete stateValue[key]);
            Object.assign(stateValue, nextState);
            await options.store.updateStepRun(stepRun.id, {
              state: stateValue,
            });
          },
          patch: async (partialState) => {
            Object.assign(stateValue, partialState);
            await options.store.updateStepRun(stepRun.id, {
              state: stateValue,
            });
          },
        },
        storage: memoryStorage(),
        artifacts: {
          publish: async (artifact) => artifact,
        },
        secrets: {
          get: async (name) => {
            if (
              options.allowedSecrets &&
              !options.allowedSecrets.includes(name)
            ) {
              throw new ActionPermissionError(
                `Secret "${name}" is not granted to this action.`,
              );
            }
            return options.secrets?.[name] ?? null;
          },
        },
        beam: options.beam ?? {},
        signal: controller.signal,
      } satisfies ActionContext,
    );
    const outputs = result.outputs ?? {};
    const artifacts = result.artifacts ?? [];
    await options.store.updateStepRun(stepRun.id, {
      status: "completed",
      output: outputs,
      metadata: result.metadata,
      state: result.state ?? stateValue,
      externalRef: result.externalRef,
      artifacts: result.artifacts,
    });
    await options.store.log({
      workflowRunId: snapshot.workflowRunId,
      stepRunId: stepRun.id,
      event: "workflow_step_completed",
      payload: {
        actionPackage: step.actionPackage,
        resolvedVersion: step.resolvedVersion,
      },
    });
    return { outputs, artifacts };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await options.store.updateStepRun(stepRun.id, {
      status: "failed",
      state: stateValue,
      error: message,
    });
    if (step.required !== false) {
      throw error;
    }
    return { outputs: {}, artifacts: [] };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

async function skipResolvedStep(
  snapshot: WorkflowRunSnapshot,
  step: ResolvedWorkflowStep,
  options: WorkflowRunnerOptions,
) {
  const stepRun = await options.store.createStepRun({
    workflowRunId: snapshot.workflowRunId,
    step,
    inputs: {},
    attempt: 1,
  });
  await options.store.updateStepRun(stepRun.id, {
    status: "skipped",
    output: {},
    metadata: { reason: "incoming_conditions_not_met" },
  });
  await options.store.log({
    workflowRunId: snapshot.workflowRunId,
    stepRunId: stepRun.id,
    event: "workflow_step_skipped",
    payload: {
      actionPackage: step.actionPackage,
      resolvedVersion: step.resolvedVersion,
    },
  });
}

const emptyMetadataContext: WorkflowMetadataContext = {
  stepsById: new Map(),
};

export function resolveInputBindings(
  bindings: Record<string, ActionJson>,
  workflowInputs: Record<string, ActionJson>,
  workflowConfig: Record<string, ActionJson>,
  outputsByStep: Map<string, Record<string, ActionJson>>,
  artifactsByStep: Map<string, ActionResult["artifacts"]>,
  metadata: WorkflowMetadataContext = emptyMetadataContext,
) {
  const resolved: Record<string, ActionJson> = {};
  for (const [key, value] of Object.entries(bindings)) {
    resolved[key] = resolveBindingValue(
      value,
      workflowInputs,
      workflowConfig,
      outputsByStep,
      artifactsByStep,
      metadata,
    );
  }
  return resolved;
}

function resolveBindingValue(
  value: ActionJson,
  workflowInputs: Record<string, ActionJson>,
  workflowConfig: Record<string, ActionJson>,
  outputsByStep: Map<string, Record<string, ActionJson>>,
  artifactsByStep: Map<string, ActionResult["artifacts"]>,
  metadata: WorkflowMetadataContext = emptyMetadataContext,
): ActionJson {
  if (typeof value === "string") {
    const matches = [...value.matchAll(bindingExpressionPattern)];
    if (!matches.length) {
      return value;
    }
    const single = matches[0]!;
    // A value that is nothing but one expression keeps that expression's type,
    // so an endpoint object or a number survives the binding intact.
    if (matches.length === 1 && single[0]!.length === value.length) {
      return resolveBindingExpression(
        single[1]!.trim(),
        single[0]!,
        workflowInputs,
        workflowConfig,
        outputsByStep,
        artifactsByStep,
        metadata,
      );
    }
    // Anything else is a sentence with expressions in it — a Slack message
    // naming the step that failed, say — so each one becomes text in place.
    return value.replace(bindingExpressionPattern, (raw, expression: string) =>
      bindingText(
        resolveBindingExpression(
          expression.trim(),
          raw,
          workflowInputs,
          workflowConfig,
          outputsByStep,
          artifactsByStep,
          metadata,
        ),
      ),
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      resolveBindingValue(
        entry,
        workflowInputs,
        workflowConfig,
        outputsByStep,
        artifactsByStep,
        metadata,
      ),
    );
  }
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && Object.hasOwn(value, "$literal"))
      return structuredClone(value.$literal!);
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        resolveBindingValue(
          entryValue,
          workflowInputs,
          workflowConfig,
          outputsByStep,
          artifactsByStep,
          metadata,
        ),
      ]),
    ) as ActionJson;
  }
  return value;
}

/**
 * Expressions never nest, so a brace-free body keeps `${a} ${b}` from reading as
 * one expression whose body spans the gap between them.
 */
const bindingExpressionPattern = /\$\{([^{}]*)\}/g;

/** How a resolved value reads once it is spliced into a sentence. */
function bindingText(value: ActionJson): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function resolveBindingExpression(
  expression: string,
  raw: string,
  workflowInputs: Record<string, ActionJson>,
  workflowConfig: Record<string, ActionJson>,
  outputsByStep: Map<string, Record<string, ActionJson>>,
  artifactsByStep: Map<string, ActionResult["artifacts"]>,
  metadata: WorkflowMetadataContext = emptyMetadataContext,
): ActionJson {
  // Node metadata resolves whatever the node did, including failure, and
  // never throws: a notification or decision that reads it exists precisely
  // for the cases where something did not run.
  const meta = resolveNodeMetadata(expression, metadata);
  if (meta.matched) {
    return meta.value;
  }
  if (expression.startsWith("workflow.input.")) {
    return getPath(workflowInputs, expression.slice("workflow.input.".length));
  }
  if (expression.startsWith("workflow.config.")) {
    return getPath(workflowConfig, expression.slice("workflow.config.".length));
  }
  if (expression.startsWith("steps.")) {
    const [, stepId, output, ...path] = expression.split(".");
    if (!stepId) {
      throw new ActionInputError(`Unsupported binding expression "${raw}".`);
    }
    if (output === "artifacts") {
      const artifacts = artifactsByStep.get(stepId);
      if (!artifacts) {
        throw new ActionInputError(
          `Binding expression "${raw}" references unavailable step artifacts.`,
        );
      }
      return getPath({ artifacts: artifacts as ActionJson }, ["artifacts", ...path].join("."));
    }
    if (output !== "outputs") {
      throw new ActionInputError(`Unsupported binding expression "${raw}".`);
    }
    const stepOutputs = outputsByStep.get(stepId);
    if (!stepOutputs) {
      throw new ActionInputError(
        `Binding expression "${raw}" references an unavailable step output.`,
      );
    }
    return getPath(stepOutputs, path.join("."));
  }
  throw new ActionInputError(`Unsupported binding expression "${raw}".`);
}

function rejectGraphFeatureBindings(bindings: Record<string, ActionJson>) {
  const json = JSON.stringify(bindings);
  for (const token of ["branch", "branches", "join", "loop", "parallel"]) {
    if (json.includes(`workflow.${token}`)) {
      throw new WorkflowValidationError(
        `Workflow V1 does not support ${token} bindings.`,
      );
    }
  }
}

function validateGraphSteps(snapshot: WorkflowRunSnapshot) {
  const activeSteps = snapshot.steps.filter((step) => step.enabled);
  const seenStepIds = new Set<string>();

  for (const step of activeSteps) {
    if (seenStepIds.has(step.id)) {
      throw new WorkflowValidationError(
        `Workflow step id "${step.id}" is duplicated.`,
      );
    }
    seenStepIds.add(step.id);
    if (!Number.isInteger(step.position) || step.position < 0) {
      throw new WorkflowValidationError(
        `Workflow step "${step.id}" has an invalid position.`,
      );
    }
  }
}

function assertStepReferencesKnown(
  step: WorkflowTemplateStep,
  stepIds: Set<string>,
) {
  const references = JSON.stringify(step.inputBindings).matchAll(
    /\$\{steps\.([^.}]+)\.(?:outputs|artifacts)[.}]/g,
  );
  for (const reference of references) {
    const stepId = reference[1];
    if (stepId && !stepIds.has(stepId)) {
      throw new WorkflowValidationError(
        `Step "${step.id}" references unknown step "${stepId}".`,
      );
    }
  }
}

function groupIncomingEdges(edges: WorkflowEdge[]) {
  const incoming = new Map<string, WorkflowEdge[]>();
  for (const edge of edges) {
    const values = incoming.get(edge.to) ?? [];
    values.push(edge);
    incoming.set(edge.to, values);
  }
  return incoming;
}

export function evaluateEdgeCondition(
  condition: ActionJson | undefined,
  workflowInputs: Record<string, ActionJson>,
  workflowConfig: Record<string, ActionJson>,
  outputsByStep: Map<string, Record<string, ActionJson>>,
  artifactsByStep: Map<string, ActionResult["artifacts"]>,
) {
  if (condition === undefined || condition === null) {
    return true;
  }
  if (typeof condition === "boolean") {
    return condition;
  }
  if (typeof condition !== "string") {
    return Boolean(condition);
  }

  const comparison = condition.match(/^(.*)\s+(==|!=)\s+(.*)$/);
  if (comparison) {
    const left = resolveConditionOperand(
      comparison[1]?.trim() ?? "",
      workflowInputs,
      workflowConfig,
      outputsByStep,
      artifactsByStep,
    );
    const right = resolveConditionOperand(
      comparison[3]?.trim() ?? "",
      workflowInputs,
      workflowConfig,
      outputsByStep,
      artifactsByStep,
    );
    const equal = JSON.stringify(left) === JSON.stringify(right);
    return comparison[2] === "==" ? equal : !equal;
  }

  return truthy(
    resolveConditionOperand(
      condition,
      workflowInputs,
      workflowConfig,
      outputsByStep,
      artifactsByStep,
    ),
  );
}

function resolveConditionOperand(
  value: string,
  workflowInputs: Record<string, ActionJson>,
  workflowConfig: Record<string, ActionJson>,
  outputsByStep: Map<string, Record<string, ActionJson>>,
  artifactsByStep: Map<string, ActionResult["artifacts"]>,
) {
  const trimmed = value.trim();
  if (trimmed.startsWith("${") && trimmed.endsWith("}")) {
    return resolveBindingValue(
      trimmed,
      workflowInputs,
      workflowConfig,
      outputsByStep,
      artifactsByStep,
    );
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed === "null") {
    return null;
  }
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  const numberValue = Number(trimmed);
  return Number.isFinite(numberValue) && trimmed !== "" ? numberValue : trimmed;
}

function truthy(value: ActionJson) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return Boolean(value);
}

function assertNoFutureReferences(
  step: WorkflowTemplateStep,
  seenStepIds: Set<string>,
) {
  const references = JSON.stringify(step.inputBindings).matchAll(
    /\$\{steps\.([^.}]+)\.outputs[.}]/g,
  );
  for (const reference of references) {
    const stepId = reference[1];
    if (!stepId) {
      continue;
    }
    if (!seenStepIds.has(stepId)) {
      throw new WorkflowValidationError(
        `Step "${step.id}" references future or unknown step "${stepId}".`,
      );
    }
  }
}

function getPath(root: Record<string, ActionJson>, path: string) {
  const parts = path.split(".").filter(Boolean);
  let value: unknown = root;
  for (const part of parts) {
    if (!value || typeof value !== "object" || !(part in value)) {
      return null;
    }
    value = (value as Record<string, unknown>)[part];
  }
  return value as ActionJson;
}

function memoryStorage() {
  const values = new Map<string, ActionJson>();
  return {
    getJson: async (key: string) => values.get(key),
    putJson: async (key: string, value: ActionJson) => {
      values.set(key, value);
    },
  };
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Workflow run was cancelled.");
  }
}

const noopLogger: ActionLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
