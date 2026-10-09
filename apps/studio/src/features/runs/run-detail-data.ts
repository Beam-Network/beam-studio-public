import { OBJECT_STORAGE_ENDPOINT_ACTION } from "../workflows/workflow-graph-constants";
import { roomTransferRetryUnavailableReason } from "@beam-studio/shared";

export type RunAction = {
  label: string;
  method: "POST" | "DELETE";
  path: () => string;
};

export type RunBundle = Record<string, unknown> & {
  run?: RunRecord;
  childRuns?: Array<{
    id: string;
    invokingStepRunId: string;
    invocationAttempt: number;
    status: string;
    error?: string | null;
  }>;
  template?: WorkflowTemplateRecord;
  triggers?: WorkflowTriggerRecord[];
  triggerEdges?: WorkflowTriggerEdgeRecord[];
  steps?: WorkflowStepRecord[];
  edges?: WorkflowEdgeRecord[];
  stepRuns?: StepRunRecord[];
  transfers?: TransferRunRecord[];
  artifacts?: ArtifactRecord[];
  logs?: RunLogRecord[];
  dynamicRegions?: DynamicRegionRecord[];
  conditionEvaluations?: ConditionEvaluationRecord[];
  decisionEvaluations?: DecisionEvaluationRecord[];
  resolvedMembersByPartition?: Record<
    string,
    Array<{ memberId: string; key?: string }>
  >;
  distributedTasks?: DistributedTaskRecord[];
};

export type DistributedTaskRecord = Record<string, unknown> & {
  id: string;
  workflowStepId: string;
  workflowStepRunId?: string | null;
  taskKind?: string;
  memberId: string | null;
  assignedMemberId?: string | null;
  sourceMemberId?: string | null;
  recipientMemberIds?: string[];
  status: string;
  attemptCount?: number;
  maxAttempts?: number;
  attempts?: Array<{
    id?: string;
    attemptNumber?: number;
    workerId?: string | null;
    status?: string;
    error?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
  }>;
  artifactIds?: string[];
  artifactManifests?: Array<{
    id?: string;
    attempt?: number;
    status?: string;
    publicationId?: string | null;
    artifacts?: Array<{
      artifactId?: string;
      port?: string;
      mediaType?: string;
      sha256?: string;
      sizeBytes?: number;
    }>;
    error?: string | null;
    acceptedAt?: string | null;
  }>;
  waitReason?: string | null;
  failureReason?: string | null;
  error?: string | null;
  shardIndex?: number | null;
  shardCount?: number | null;
  loopIteration?: number | null;
  aggregationLeafCount?: number | null;
  scheduledAt?: string | null;
  admissionDeadlineAt?: string | null;
  createdAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
};

export type DynamicRegionRecord = Record<string, unknown> & {
  id?: string;
  workflowRunId?: string;
  controlId?: string;
  controlPath?: string;
  kind?: string;
  status?: string;
  instanceCount?: number;
  completedCount?: number;
  pendingCount?: number;
  runningCount?: number;
  failedCount?: number;
  cancelledCount?: number;
  concurrencyLimit?: number | null;
  output?: unknown;
  error?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type DynamicInstanceRecord = Record<string, unknown> & {
  id?: string;
  dynamicRegionId?: string;
  workflowStepId?: string;
  controlPath?: string;
  instanceIndex?: number;
  status?: string;
  currentAttempt?: number;
  context?: unknown;
  input?: unknown;
  output?: unknown;
  error?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
};

export type DynamicInstancesPage = {
  region: DynamicRegionRecord;
  instances: DynamicInstanceRecord[];
  offset: number;
  limit: number;
  total: number;
};

export type DecisionEvaluationRecord = {
  id?: string;
  decisionId?: string;
  joinMode?: string;
  decisionKind?: "if" | "switch";
  evaluated?: boolean;
  result?: boolean | null;
  takenBranch?: string | null;
  handledFailures?: string[];
  reason?: string;
};

export function decisionReasonLabel(reason: string | undefined) {
  if (reason === "join_unsatisfied") return "an input did not succeed";
  if (reason === "predicate_true") return "the condition was true";
  if (reason === "predicate_false") return "the condition was false";
  if (reason === "predicate_absent") return "no condition, the join decided";
  if (reason === "predicate_invalid") return "the condition could not be read";
  if (reason === "case_matched") return "the first matching case was selected";
  if (reason === "switch_default")
    return "no case matched; Default was selected";
  if (reason === "inputs_pending") return "inputs had not settled";
  if (reason === "inputs_not_reached") return "the decision was not reached";
  return reason ?? "unknown";
}

export type ConditionEvaluationRecord = Record<string, unknown> & {
  id?: string;
  dynamicRegionId?: string | null;
  dynamicInstanceId?: string | null;
  scopeKey?: string;
  edgeId?: string;
  fromNodeId?: string;
  toNodeId?: string;
  outcome?: string;
  result?: boolean | null;
  reason?: string;
  summary?: unknown;
  createdAt?: string | null;
};

export type RunRecord = Record<string, unknown> & {
  id?: string;
  parentRunId?: string | null;
  rootRunId?: string | null;
  historical?: boolean;
  historicalSnapshot?: unknown;
  outputValidation?: string;
  room?: import("@beam-studio/shared").WorkflowRoomContext | null;
  output?: unknown;
  workflowTemplateId?: string;
  transferTemplateId?: string;
  workflowName?: string | null;
  transferName?: string | null;
  status?: string;
  trigger?: string;
  error?: string | null;
  queuedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type StepRunRecord = Record<string, unknown> & {
  id?: string;
  kind?: "action" | "workflow";
  childRunId?: string | null;
  workflowStepId?: string;
  actionPackageName?: string;
  status?: string;
  attempt?: number;
  input?: unknown;
  output?: unknown;
  metadata?: unknown;
  state?: unknown;
  externalRef?: string | null;
  shardErrors?: string[];
  progress?: {
    total?: number;
    completed?: number;
    running?: number;
    failed?: number;
    percent?: number;
  } | null;
  error?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string | null;
};

export type WorkflowTemplateRecord = Record<string, unknown> & {
  id?: string;
  name?: string;
  graphVersion?: string;
  legacyTransferTemplateId?: string | null;
  legacyTransferName?: string | null;
};

export type WorkflowStepRecord = Record<string, unknown> & {
  id?: string;
  actionPackageName?: string;
  position?: number;
  enabled?: boolean;
  canvasX?: number | null;
  canvasY?: number | null;
  placement?: string;
  config?: unknown;
  inputBindings?: unknown;
  manifest?: unknown;
};

export type WorkflowEdgeRecord = Record<string, unknown> & {
  id?: string;
  fromStepId?: string;
  toStepId?: string;
};

export type WorkflowTriggerRecord = Record<string, unknown> & {
  id?: string;
  name?: string;
  type?: string;
  enabled?: boolean;
  config?: unknown;
  state?: unknown;
  canvasX?: number | null;
  canvasY?: number | null;
};

export type WorkflowTriggerEdgeRecord = Record<string, unknown> & {
  id?: string;
  triggerId?: string;
  toStepId?: string;
};

export type ExecutionStep = {
  id: string;
  workflowStepId: string;
  actionPackageName: string;
  name: string;
  order: number;
  status: string;
  attempt?: number;
  error?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string | null;
  run?: StepRunRecord;
  step?: WorkflowStepRecord;
};

export type TransferRunRecord = Record<string, unknown> & {
  id?: string;
  sourceName?: string | null;
  destinationName?: string | null;
  destinationObjectKey?: string | null;
  status?: string;
  error?: string | null;
  createdAt?: string | null;
};

export type ArtifactRecord = Record<string, unknown> & {
  id?: string;
  workflowStepRunId?: string | null;
  type?: string;
  name?: string;
  uri?: string;
  mediaType?: string | null;
  createdAt?: string | null;
};

export type RunLogRecord = Record<string, unknown> & {
  id?: string;
  event?: string;
  level?: string;
  payload?: unknown;
  workerId?: string | null;
  createdAt?: string | null;
};

export type TimelineEvent = {
  at?: string | null;
  title: string;
  detail?: string;
  payload?: unknown;
  tone: StatusTone;
};

export type Failure = {
  action?: { label: string; href: string };
  message: string;
  /** Status that ended the run or the offending step — cancelled reads differently to failed. */
  status: string;
  stepId?: string;
  stepRunId?: string;
  stepName?: string;
  timestamp?: string | null;
};

/** Visual grouping every run/step/transfer status collapses into. */
export type StatusTone =
  | "success"
  | "danger"
  | "active"
  | "pending"
  | "neutral";

export const activeStatuses = new Set([
  "queued",
  "running",
  "cancelling",
  "cancel_requested",
]);
export const cancellableStatuses = new Set(["queued", "running"]);
export const terminalStatuses = new Set([
  "completed",
  "failed",
  "cancelled",
  "dead_letter",
  "skipped",
  "not_reached",
]);
export const failedStatuses = new Set(["failed", "dead_letter"]);
export const unreachedStatuses = new Set(["skipped", "not_reached"]);

export function statusTone(status: unknown): StatusTone {
  const normalized = normalizeStatus(status);
  if (normalized === "completed" || normalized === "ready") {
    return "success";
  }
  if (failedStatuses.has(normalized)) {
    return "danger";
  }
  if (["running", "cancelling", "cancel_requested"].includes(normalized)) {
    return "active";
  }
  if (normalized === "queued") {
    return "pending";
  }
  return "neutral";
}

export function statusLabel(status: unknown) {
  const value = stringValue(status);
  if (!value) {
    return "Unknown";
  }
  return value
    .split(/[-_\s]/)
    .filter(Boolean)
    .map((part, index) =>
      index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part,
    )
    .join(" ");
}

/** Node fill/stroke for the read-only React Flow graph. */
export function graphTone(status: unknown) {
  switch (statusTone(status)) {
    case "success":
      return {
        background: "hsl(var(--success) / 0.10)",
        border: "hsl(var(--success))",
      };
    case "danger":
      return {
        background: "hsl(var(--destructive) / 0.10)",
        border: "hsl(var(--destructive))",
      };
    case "active":
      return {
        background: "hsl(var(--warning) / 0.10)",
        border: "hsl(var(--warning))",
      };
    case "pending":
      return {
        background: "hsl(var(--secondary))",
        border: "hsl(var(--ring))",
      };
    default:
      return {
        background: "hsl(var(--muted) / 0.65)",
        border: "hsl(var(--muted-foreground))",
      };
  }
}

export function buildTimeline(
  run: RunRecord,
  steps: ExecutionStep[],
  transfers: TransferRunRecord[],
  logs: RunLogRecord[],
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  if (run.queuedAt) {
    events.push({
      at: run.queuedAt,
      title: "Run queued",
      detail: `Triggered by ${run.trigger ?? "manual"}`,
      tone: "neutral",
    });
  }
  if (run.startedAt) {
    events.push({ at: run.startedAt, title: "Run started", tone: "active" });
  }
  for (const step of steps) {
    if (unreachedStatuses.has(normalizeStatus(step.status))) {
      continue;
    }
    events.push({
      at: step.startedAt ?? step.createdAt,
      title: `${step.name} ${statusLabel(step.status).toLowerCase()}`,
      detail: step.error ?? undefined,
      payload: compactPayload({
        stepRunId: step.run?.id,
        workflowStepId: step.workflowStepId,
        attempt: step.attempt,
        progress: step.run?.progress,
      }),
      tone: statusTone(step.status),
    });
  }
  for (const transfer of transfers) {
    events.push({
      at: transfer.createdAt,
      title: `Transfer ${statusLabel(transfer.status).toLowerCase()}`,
      detail: transfer.error ?? transfer.destinationObjectKey ?? undefined,
      payload: compactPayload({
        transferId: transfer.id,
        source: transfer.sourceName,
        destination: transfer.destinationName,
      }),
      tone: statusTone(transfer.status),
    });
  }
  for (const log of logs) {
    events.push({
      at: log.createdAt,
      title: log.event ?? "Log event",
      detail: log.workerId ? `Worker: ${log.workerId}` : undefined,
      payload: log.payload,
      tone: normalizeStatus(log.level) === "error" ? "danger" : "neutral",
    });
  }
  if (run.completedAt) {
    events.push({
      at: run.completedAt,
      title: `Run ${statusLabel(run.status).toLowerCase()}`,
      detail: run.error ?? undefined,
      tone: statusTone(run.status),
    });
  }
  return events
    .filter((event) => event.at || event.title)
    .sort((left, right) => timeValue(left.at) - timeValue(right.at));
}

export function buildExecutionSteps(
  workflowSteps: WorkflowStepRecord[],
  stepRuns: StepRunRecord[],
): ExecutionStep[] {
  const runsByStepId = new Map(
    stepRuns.map((stepRun) => [stringValue(stepRun.workflowStepId), stepRun]),
  );
  if (!workflowSteps.length) {
    return stepRuns.map((stepRun, index) => ({
      id:
        stringValue(stepRun.id) ||
        stringValue(stepRun.workflowStepId) ||
        `step-${index}`,
      workflowStepId: stringValue(stepRun.workflowStepId),
      actionPackageName: stringValue(stepRun.actionPackageName) || "Step",
      name: stringValue(stepRun.actionPackageName) || "Step",
      order: index,
      status: stringValue(stepRun.status) || "unknown",
      attempt: stepRun.attempt,
      error: stepRun.error,
      startedAt: stepRun.startedAt,
      completedAt: stepRun.completedAt,
      createdAt: stepRun.createdAt,
      run: stepRun,
    }));
  }
  return [...workflowSteps]
    .sort(
      (left, right) => Number(left.position ?? 0) - Number(right.position ?? 0),
    )
    .map((step, index) => {
      const workflowStepId = stringValue(step.id);
      const run = runsByStepId.get(workflowStepId);
      return {
        id: stringValue(run?.id) || workflowStepId || `workflow-step-${index}`,
        workflowStepId,
        actionPackageName:
          stringValue(run?.actionPackageName) ||
          stringValue(step.actionPackageName) ||
          "Step",
        name: displayStepName(step),
        order: index,
        status: stringValue(run?.status) || "not_reached",
        attempt: run?.attempt,
        error: run?.error,
        startedAt: run?.startedAt,
        completedAt: run?.completedAt,
        createdAt: run?.createdAt,
        run,
        step,
      };
    });
}

export function buildBranchSummary(
  edges: WorkflowEdgeRecord[],
  stepRuns: StepRunRecord[],
  steps: WorkflowStepRecord[],
  triggerEdges: WorkflowTriggerEdgeRecord[],
  triggers: WorkflowTriggerRecord[],
) {
  const stepsById = new Map(steps.map((step) => [stringValue(step.id), step]));
  const triggersById = new Map(
    triggers.map((trigger) => [stringValue(trigger.id), trigger]),
  );
  const runsByStepId = new Map(
    stepRuns.map((stepRun) => [stringValue(stepRun.workflowStepId), stepRun]),
  );
  const stepName = (stepId: string) =>
    displayStepName(stepsById.get(stepId) ?? { id: stepId });
  const targetTaken = (stepId: string) => {
    const status = normalizeStatus(runsByStepId.get(stepId)?.status);
    return Boolean(status && !unreachedStatuses.has(status));
  };

  return [
    ...triggerEdges.map((edge) => {
      const trigger = triggersById.get(stringValue(edge.triggerId));
      const target = stringValue(edge.toStepId);
      return {
        id: stringValue(edge.id) || `${edge.triggerId}:${edge.toStepId}`,
        from: stringValue(trigger?.name) || stringValue(edge.triggerId),
        to: stepName(target),
        condition: edge.condition ?? null,
        taken: targetTaken(target),
      };
    }),
    ...edges.map((edge) => {
      const target = stringValue(edge.toStepId);
      return {
        id: stringValue(edge.id) || `${edge.fromStepId}:${edge.toStepId}`,
        from: stepName(stringValue(edge.fromStepId)),
        to: stepName(target),
        condition: edge.condition ?? null,
        taken: targetTaken(target),
      };
    }),
  ];
}

export function failureDetails(
  run: RunRecord,
  steps: ExecutionStep[],
  transfers: TransferRunRecord[],
  logs: RunLogRecord[],
): Failure | null {
  const failedStep = steps.find((step) =>
    ["failed", "dead_letter", "cancelled"].includes(
      normalizeStatus(step.status),
    ),
  );
  const failedTransfer = transfers.find((transfer) =>
    ["failed", "dead_letter", "cancelled"].includes(
      normalizeStatus(transfer.status),
    ),
  );
  const errorLog = logs.find((log) => normalizeStatus(log.level) === "error");
  const message =
    stringValue(run.error) ||
    stringValue(failedStep?.error) ||
    stringValue(failedTransfer?.error) ||
    (errorLog ? JSON.stringify(errorLog.payload ?? {}) : "");
  if (
    !message &&
    !["failed", "cancelled", "dead_letter"].includes(
      normalizeStatus(run.status),
    )
  ) {
    return null;
  }
  return {
    message: workflowExecutionKeyRepair(run)
      ? "No Beam key was available for this run. Choose a Beam credential in the Beam Transfer step or a billing API key in Workflow Settings, then start a new run."
      : customerFailureMessage(message) ||
        `Run ended with status ${run.status ?? "unknown"}.`,
    ...(workflowExecutionKeyRepair(run)
      ? {
          action: {
            label: "Workflow settings",
            href: `/workflows/${run.workflowTemplateId}/settings`,
          },
        }
      : {}),
    status: normalizeStatus(failedStep?.status ?? run.status),
    stepId: failedStep?.workflowStepId,
    stepRunId: failedStep?.id,
    stepName: failedStep?.name,
    timestamp:
      failedStep?.completedAt ??
      failedTransfer?.createdAt ??
      errorLog?.createdAt ??
      run.completedAt ??
      run.updatedAt,
  };
}

/**
 * Run events carry no step column, so a step's logs are the ones whose payload
 * mentions the step run or workflow step id anywhere.
 */
export function logsForStep(logs: RunLogRecord[], step: ExecutionStep) {
  const ids = [step.run?.id, step.workflowStepId]
    .map((value) => stringValue(value))
    .filter(Boolean);
  if (!ids.length) {
    return [];
  }
  return logs.filter((log) => {
    const payload = JSON.stringify(log.payload ?? {});
    return ids.some((id) => payload.includes(id));
  });
}

export function compactPayload(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, entry]) => entry !== null && entry !== undefined && entry !== "",
    ),
  );
}

export function transferSummary(transfers: TransferRunRecord[]) {
  const complete = transfers.filter(
    (transfer) => normalizeStatus(transfer.status) === "completed",
  ).length;
  return `${complete}/${transfers.length}`;
}

/**
 * Authorization refusals are recorded as "<code>: <message>". The message is
 * written for the customer; the code is for logs and support.
 */
export function customerFailureMessage(message: string) {
  const match = /^execution_[a-z_]+: ([\s\S]+)$/.exec(message);
  return match?.[1] ?? message;
}

export function workflowExecutionKeyRepair(run: RunRecord): boolean {
  return Boolean(
    run.workflowTemplateId &&
    ["failed", "cancelled", "dead_letter"].includes(
      normalizeStatus(run.status),
    ) &&
    /^execution_credential_missing(?::|$)/.test(stringValue(run.error)),
  );
}

export function canRunAction(
  action: RunAction,
  status: string,
  steps: StepRunRecord[],
  run?: RunRecord,
) {
  const label = action.label.toLowerCase();
  if (label.includes("cancel")) {
    return cancellableStatuses.has(status);
  }
  if (label.includes("retry")) {
    return (
      ["failed", "cancelled", "dead_letter"].includes(status) &&
      !(run && workflowExecutionKeyRepair(run)) &&
      !roomTransferRetryUnavailableReason(steps)
    );
  }
  return true;
}

export function actionDisabledReason(
  action: RunAction,
  status: string,
  steps: StepRunRecord[],
  run?: RunRecord,
) {
  if (canRunAction(action, status, steps, run)) {
    return undefined;
  }
  const label = action.label.toLowerCase();
  if (label.includes("cancel")) {
    return "Cancel is only available while the run is queued or running.";
  }
  if (label.includes("retry")) {
    if (run && workflowExecutionKeyRepair(run))
      return "Choose a Beam credential in the Beam Transfer step or a billing API key in Workflow Settings, then start a new run. Retry keeps this run's missing key.";
    return (
      roomTransferRetryUnavailableReason(steps) ??
      "Retry is only available for failed or cancelled runs."
    );
  }
  return undefined;
}

export type BeamTransferLink = {
  stepRunId: string;
  stepName: string;
  status: string;
  transferId: string;
  /** The transfer's page in the Beam Console, when the Console URL is known. */
  consoleHref: string | null;
};

/**
 * The Beam transfer each Beam Transfer step started, for the run summary.
 *
 * Only the action's own record of the transfer counts: its external reference
 * or its `beamTransferId` output. Nothing else in a step's payload names the
 * Console transfer, so a guess could link to someone else's transfer.
 */
export function beamTransferLinks(
  steps: ExecutionStep[],
  consoleUrl: string | null | undefined,
): BeamTransferLink[] {
  return steps.flatMap((step) => {
    if (step.actionPackageName !== "@beam/transfer" || !step.run) return [];
    const transferId =
      stringValue(step.run.externalRef) ||
      stringValue(jsonRecord(step.run.output).beamTransferId);
    if (!transferId) return [];
    return [
      {
        stepRunId: step.id,
        stepName: step.name,
        status: step.status,
        transferId,
        consoleHref: consoleTransferUrl(consoleUrl, transferId),
      },
    ];
  });
}

export function consoleTransferUrl(
  consoleUrl: string | null | undefined,
  transferId: string,
) {
  if (!consoleUrl) return null;
  try {
    return new URL(
      `transfers/${encodeURIComponent(transferId)}`,
      consoleUrl.endsWith("/") ? consoleUrl : `${consoleUrl}/`,
    ).toString();
  } catch {
    return null;
  }
}

export function beamDetails(step: StepRunRecord) {
  const searchRoot = {
    input: step.input,
    output: step.output,
    metadata: step.metadata,
    state: step.state,
  };
  const sdkErrors = [
    ...((Array.isArray(step.shardErrors) ? step.shardErrors : []) as string[]),
    findString(searchRoot, [
      "sdkError",
      "sdk_error",
      "beamError",
      "beam_error",
      "error",
    ]),
  ].filter(Boolean);
  return {
    source: findString(searchRoot, [
      "sourceName",
      "source",
      "sourcePath",
      "sourceBucket",
      "sourceEndpoint",
    ]),
    destination: findString(searchRoot, [
      "destinationName",
      "destination",
      "destinationPath",
      "destinationBucket",
      "destinationEndpoint",
      "destinationObjectKey",
    ]),
    transferId:
      stringValue(step.externalRef) ||
      findString(searchRoot, [
        "beamTransferId",
        "transferId",
        "transfer_id",
        "id",
      ]),
    beamStatus: findString(searchRoot, [
      "beamStatus",
      "transferStatus",
      "status",
    ]),
    integrityCheckWarning: findString(searchRoot, [
      "integrityCheckWarning",
      "integrity_check_warning",
    ]),
    sdkErrors: [...new Set(sdkErrors.map(String).filter(Boolean))],
  };
}

export function displayStepName(step: WorkflowStepRecord) {
  if (stringValue(step.name)) return stringValue(step.name);
  if (step.kind === "workflow") return "Workflow call";
  const config = jsonRecord(step.config);
  const configuredName = stringValue(config.name);
  if (configuredName) {
    return configuredName;
  }
  const manifest = jsonRecord(step.manifest);
  return (
    stringValue(manifest.displayName) ||
    stringValue(step.actionPackageName) ||
    stringValue(step.id)
  );
}

export function objectStorageObjectKey(step: WorkflowStepRecord) {
  if (step.actionPackageName !== OBJECT_STORAGE_ENDPOINT_ACTION) {
    return "";
  }
  const config = jsonRecord(step.config);
  const objectKey = stringValue(config.objectKey);
  if (!objectKey) {
    return "No object key";
  }
  const bucket = stringValue(config.bucket);
  return bucket ? `${bucket}/${objectKey}` : objectKey;
}

function findString(value: unknown, keys: string[], depth = 0): string {
  if (depth > 5 || value === null || value === undefined) {
    return "";
  }
  if (typeof value !== "object") {
    return "";
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findString(entry, keys, depth + 1);
      if (found) {
        return found;
      }
    }
    return "";
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (
      record[key] !== undefined &&
      record[key] !== null &&
      record[key] !== ""
    ) {
      return stringValue(record[key]);
    }
  }
  for (const entry of Object.values(record)) {
    const found = findString(entry, keys, depth + 1);
    if (found) {
      return found;
    }
  }
  return "";
}

export function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function numberValue(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function shortText(value: string, maxLength = 180) {
  return value.length > maxLength
    ? `${value.slice(0, maxLength - 1)}...`
    : value;
}

export function durationLabel(start?: string | null, end?: string | null) {
  if (!start) {
    return "-";
  }
  const startTime = new Date(start).getTime();
  const endTime = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    return "-";
  }
  const seconds = Math.max(0, Math.round((endTime - startTime) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${remainder}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** "3 minutes ago" style label for the run header. */
export function relativeTimeLabel(value?: string | null) {
  if (!value) {
    return "";
  }
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) {
    return "";
  }
  const seconds = Math.round((Date.now() - time) / 1000);
  if (seconds < 60) {
    return "just now";
  }
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, unitSeconds] of units) {
    if (Math.abs(seconds) >= unitSeconds) {
      return formatter.format(-Math.round(seconds / unitSeconds), unit);
    }
  }
  return "just now";
}

export function normalizeStatus(value: unknown) {
  return stringValue(value).toLowerCase();
}

export function stringValue(value: unknown) {
  return typeof value === "string"
    ? value
    : value === null || value === undefined
      ? ""
      : String(value);
}

export function timeValue(value?: string | null) {
  if (!value) {
    return 0;
  }
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}
