import { roomWorkflowHost } from "./roomWorkflow.js";
import { withControlRecovery } from "./controlRecovery.js";
import {
  acceptRoomTransferDeadline,
  initialRoomTransferDeadline,
} from "./roomTransferDeadline.js";
import { prepareWorkerProcessOwnership } from "./processRecovery.js";
import crypto from "node:crypto";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { setTimeout } from "node:timers";
import {
  parseRetryPolicy,
  retryDelayMs,
  resolveFrozenBeamTransferConfig,
  ActionRuntimeCompatibilityError,
  type ActionManifest,
  type ActionArtifact,
  type ActionJson,
  type ActionResult,
  type RegisteredActionPackage,
} from "@beam-studio/core";
import {
  pgOne,
  lockLogicalPartitionAdmissionPg,
  lockExecutorClaimPg,
  renewExecutorLeasePg,
  recordExecutorStoppedPg,
  settleExecutorResultPg,
  credentialSecretReaderPg,
  authorizeWorkflowExecutionPg,
  grantedArtifactUrl,
  WorkflowAuthorityUnavailableError,
  withPostgresTransaction,
  workflowRunAuthorityGenerationPg,
  type PgClient,
  type PgPool,
} from "@beam-studio/db";
import {
  actionSourceLabel,
  parseTraceparent,
} from "@beam-studio/telemetry";
import { resolveActionRoomContext } from "@beam-studio/shared";
import type {
  ClaimedWorkflowTask,
  TaskProcessResult,
  TaskWorkerOptions,
  WorkflowObjectStorageEndpoint,
} from "./taskTypes.js";
import {
  assertActionPermission,
  assertAnyActionPermission,
  executeWithArtifactPorts,
} from "@beam-studio/action-runtime";
import { assertActionConfig } from "./actionConfig.js";
import { actionLogger, memoryStorage } from "./taskUtils.js";
import {
  localizeResultArtifacts,
  publishWorkerArtifact,
} from "./workerFileArtifacts.js";
import { resolveActionPackage } from "@beam-studio/action-runtime";
import { trustedCredentialNetworkTargetsPg } from "./trustedNetwork.js";

type Row = Record<string, unknown>;
const defaultActionTimeoutMs = 5 * 60_000;
const actionCleanupGraceMs = 30_000;
const beamTransferActionPackage = "@beam/transfer";
const roomTransferActionPackage = "@beam/room-transfer";

/** Guard the Runner even when a test or embedding supplies a custom resolver. */
export function assertRunnerSupportsActionManifest(
  manifest: ActionManifest | null | undefined,
) {
  if (manifest?.apiVersion === "workflow-actions/v2")
    throw new ActionRuntimeCompatibilityError(
      "Registry v2 Runner execution requires enforced CPU and peak-memory limits.",
    );
}

export function createPostgresTaskWorker(
  pool: PgPool,
  options: TaskWorkerOptions,
) {
  return {
    async processTaskId(
      taskId: string,
      message: {
        workflowRunId?: string;
        correlationId?: string;
        traceparent?: string;
      } = {},
    ) {
      const task = await claimTaskByIdPg(pool, taskId, options);
      if (!task) {
        return { status: "ignored" as const };
      }
      const parent =
        parseTraceparent(
          message.traceparent,
          message.correlationId ?? message.workflowRunId ?? task.workflowRunId,
        ) ?? task.traceContext;
      const span = options.telemetry?.startSpan("workflow.task.execute", {
        parent,
        correlationId: task.correlationId,
        attributes: {
          "workflow.run_id": task.workflowRunId,
          "workflow.task_id": task.id,
          "workflow.task_kind": task.taskKind,
          "action.package": task.actionPackageName,
          "workflow.attempt": task.attempt,
        },
      });
      options.telemetry?.add("beam_workflow_task_claims_total", 1, {
        task_kind: task.taskKind,
        action_source: actionSourceLabel(task.actionPackageName),
      });
      options.logger.info(
        {
          taskId,
          workflowRunId: task.workflowRunId,
          correlationId: task.correlationId,
          traceId: span?.context.traceId ?? parent?.traceId,
        },
        "Claimed PostgreSQL workflow task",
      );
      const startedAt = Date.now();
      try {
        const result = await executeTaskPg(pool, task, options);
        const status =
          result.status === "completed" ? "completed" : result.status;
        options.telemetry?.observe(
          "beam_workflow_task_duration_seconds",
          Math.max(0, Date.now() - startedAt) / 1_000,
          {
            task_kind: task.taskKind,
            action_source: actionSourceLabel(task.actionPackageName),
            status,
          },
        );
        options.telemetry?.add("beam_workflow_action_executions_total", 1, {
          action_source: actionSourceLabel(task.actionPackageName),
          status,
        });
        span?.end(result.status === "dead_letter" ? "error" : "ok", {
          "workflow.outcome": result.status,
        });
        return result;
      } catch (error) {
        span?.end("error", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}

async function claimTaskByIdPg(
  pool: PgPool,
  taskId: string,
  options: TaskWorkerOptions,
) {
  const timestamp = now();
  const lockExpiresAt = new Date(Date.now() + options.lockTtlMs).toISOString();
  const claimToken = crypto.randomUUID();
  return withPostgresTransaction(pool, async (client) => {
    const run = await pgOne<Row>(
      client,
      `SELECT r.id FROM execution.workflow_runs r
       JOIN execution.workflow_tasks t ON t.workflow_run_id=r.id
       WHERE t.id=$1 FOR UPDATE OF r`,
      [taskId],
    );
    if (!run) return null;
    const authorityGeneration = await workflowRunAuthorityGenerationPg(
      client,
      String(run.id),
    );
    if (authorityGeneration === null) return null;
    if (!(await lockLogicalPartitionAdmissionPg(client, taskId))) return null;
    const result = await client.query<Row>(
      `
      UPDATE execution.workflow_tasks
      SET status = 'running',
          attempts = attempts + 1,
          attempt_count = attempt_count + 1,
          locked_by = $2,
          leased_by = $2,
          lock_expires_at = $3,
          lease_expires_at = $3,
          claim_token = $5,
          started_at = COALESCE(started_at, $4),
          updated_at = $4,
          error = NULL
      WHERE id = $1
        AND EXISTS (SELECT 1 FROM execution.workflow_step_runs target_step WHERE target_step.id=execution.workflow_tasks.workflow_step_run_id AND target_step.resolved_placement='local-workers' AND target_step.execution_location_id IS NULL)
        AND EXISTS(SELECT 1 FROM execution.workflow_runs r,jsonb_array_elements(r.resolved_steps_json) step
          WHERE r.id=execution.workflow_tasks.workflow_run_id AND r.status IN ('queued','running') AND step->>'id'=execution.workflow_tasks.workflow_step_id
          AND COALESCE(step->'executionTarget'->>'kind','studio')='studio'
          AND EXISTS(SELECT 1 FROM runtime.worker_runtime_state runner WHERE runner.worker_id=$2
            AND runner.status='active' AND runner.heartbeat_at>=now()-interval '30 seconds'
            AND (runner.organization_id IS NULL OR runner.organization_id=r.organization_id)
            AND (runner.project_id IS NULL OR runner.project_id=r.project_id))
          AND (NOT(COALESCE(step->'executionTarget','{}'::jsonb)?'runnerIds') OR step->'executionTarget'->'runnerIds' ? $2))
        AND status IN ('queued', 'retry_scheduled')
        AND NOT EXISTS(SELECT 1 FROM execution.executor_assignments previous
          WHERE previous.task_id=execution.workflow_tasks.id AND previous.cleanup_confirmed_at IS NULL)
        AND scheduled_at <= now()
        AND (target_worker_id IS NULL OR target_worker_id = $2)
      RETURNING *
      `,
      [taskId, options.workerId, lockExpiresAt, timestamp, claimToken],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    await client.query(
      `INSERT INTO execution.executor_assignments(id,organization_id,workflow_run_id,workflow_step_run_id,task_id,attempt,backend,executor_id,declared_target_json,state,lease_expires_at,authority_generation)
      SELECT $1,$2,$3,$4,$5,$6,'studio',$7,COALESCE(step->'executionTarget','{"kind":"studio"}'::jsonb),'running',$8,$10
      FROM execution.workflow_runs r,jsonb_array_elements(r.resolved_steps_json) step WHERE r.id=$3 AND step->>'id'=$9`,
      [
        id("assignment"),
        row.organization_id,
        row.workflow_run_id,
        row.workflow_step_run_id,
        taskId,
        row.attempt_count,
        options.workerId,
        lockExpiresAt,
        row.workflow_step_id,
        authorityGeneration,
      ],
    );
    await client.query(
      `
      INSERT INTO execution.workflow_task_attempts (
        id, workflow_task_id, attempt_number, worker_id, status,
        started_at, metadata_json, created_at
      )
      VALUES ($1, $2, $3, $4, 'running', $5, $6::jsonb, $5)
      ON CONFLICT (workflow_task_id, attempt_number) DO NOTHING
      `,
      [
        id("wfta"),
        taskId,
        Number(row.attempts),
        options.workerId,
        timestamp,
        JSON.stringify({ claimToken }),
      ],
    );
    await client.query(
      `INSERT INTO execution.executor_process_ownership(assignment_id)
      SELECT id FROM execution.executor_assignments WHERE task_id=$1 AND attempt=$2 ON CONFLICT DO NOTHING`,
      [taskId, Number(row.attempt_count)],
    );
    await appendEventPg(client, {
      organizationId: String(row.organization_id),
      workflowRunId: String(row.workflow_run_id),
      workflowStepRunId: row.workflow_step_run_id
        ? String(row.workflow_step_run_id)
        : null,
      workflowTaskId: String(row.id),
      eventType: "TaskClaimed",
      payload: { workerId: options.workerId },
    });
    return taskFromRow(row);
  });
}

async function executeTaskPg(
  pool: PgPool,
  task: ClaimedWorkflowTask,
  options: TaskWorkerOptions,
): Promise<TaskProcessResult> {
  const controller = new AbortController();
  const heartbeat = startTaskLeaseHeartbeat(pool, task, options, controller);
  try {
    const processOwnership = await prepareWorkerProcessOwnership(
      pool,
      task,
      options,
    );
    return await executeClaimedTaskPg(
      pool,
      task,
      { ...options, processOwnership },
      controller,
    );
  } catch (error) {
    return failTaskPg(
      pool,
      task,
      error instanceof Error ? error.message : "Process ownership unavailable",
      options,
      false,
    );
  } finally {
    heartbeat.stop();
    await recordExecutorStoppedPg(pool, executorClaim(task));
  }
}

async function executeClaimedTaskPg(
  pool: PgPool,
  task: ClaimedWorkflowTask,
  options: TaskWorkerOptions,
  controller: AbortController,
): Promise<TaskProcessResult> {
  const stepRun = await pgOne<Row>(
    pool,
    "SELECT * FROM execution.workflow_step_runs WHERE id = $1",
    [task.workflowStepRunId],
  );
  const workflowRun = await pgOne<Row>(
    pool,
    "SELECT * FROM execution.workflow_runs WHERE id = $1",
    [task.workflowRunId],
  );
  if (!stepRun || !workflowRun) {
    return failTaskPg(
      pool,
      task,
      "Workflow task references a missing run.",
      options,
    );
  }
  if (["cancel_requested", "cancelled"].includes(String(workflowRun.status))) {
    return cancelTaskPg(pool, task, "workflow cancellation requested");
  }

  const matchedStep = arrayValue(workflowRun.resolved_steps_json)
    .filter((candidate): candidate is Row =>
      Boolean(candidate && typeof candidate === "object"),
    )
    .map(workflowStepFromSnapshot)
    .find((candidate) => candidate.id === task.workflowStepId);
  if (!matchedStep) {
    return failTaskPg(
      pool,
      task,
      "Workflow task references a missing step.",
      options,
    );
  }
  let step = matchedStep;

  let timeout: ReturnType<typeof setTimeout> | null = null;
  let renewRoomDeadline: ((deadline: string) => void) | undefined;
  try {
    assertRunnerSupportsActionManifest(step.manifestSnapshot);
    let authorityOutageLogged = false;
    const grant = await withControlRecovery(
      () =>
        authorizeTask(pool, task, options, "dispatch", {
          artifactUrl: step.sourceRegistry === "public-registry",
        }),
      controller.signal,
      (error) => {
        if (!(error instanceof WorkflowAuthorityUnavailableError)) return false;
        if (!authorityOutageLogged) {
          options.logger.warn(
            {
              taskId: task.id,
              phase: "dispatch",
              code: error.code,
              transportCode: error.transportCode,
            },
            "Execution authority unavailable; Runner launch deferred",
          );
          authorityOutageLogged = true;
        }
        return true;
      },
    );
    // A signed URL belongs to this launch only; the run keeps its own URL.
    const signedArtifactUrl = grant
      ? grantedArtifactUrl(grant.artifactUrl)
      : null;
    if (signedArtifactUrl)
      step = { ...step, registryArtifactUrl: signedArtifactUrl };
    if (step.actionPackage === beamTransferActionPackage) {
      step = {
        ...step,
        config: resolveFrozenBeamTransferConfig(
          step.config,
          task.input,
          workflowRun.execution_context_json,
        ),
      };
    }
    const networkAwareOptions = options.resolveActionPackage
      ? options
      : await optionsWithCredentialNetworkTargets(
          pool,
          String(workflowRun.organization_id ?? ""),
          step,
          task,
          options,
        );
    const workerDefaultTimeoutMs =
      options.actionSandboxTimeoutMs ?? defaultActionTimeoutMs;
    const snapshotTimeoutMs = actionTimeoutMs(
      step,
      step.manifestSnapshot ?? null,
      networkAwareOptions,
      workerDefaultTimeoutMs,
    );
    const renewableRoomSnapshot =
      step.actionPackage === roomTransferActionPackage &&
      step.manifestSnapshot?.apiVersion === "workflow-actions/v1" &&
      extendedRuntimeAllowed(step, step.manifestSnapshot, networkAwareOptions);
    const actionOptions = {
      ...networkAwareOptions,
      actionSandboxTimeoutMs: renewableRoomSnapshot
        ? null
        : snapshotTimeoutMs + actionCleanupGraceMs,
      allowScratchWrites: Boolean(options.fileServer),
    };
    // Resolution downloads and extracts the artifact, and until now ran with no
    // deadline at all: the step timeout below is armed only once the manifest
    // is known. Bound it with the task's own signal plus the timeout the
    // snapshot already implies, so a stalled download cannot hold the task
    // open behind a lease heartbeat that keeps reporting progress.
    const resolutionSignal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(snapshotTimeoutMs),
    ]);
    const resolvedPackage = options.resolveActionPackage
      ? await options.resolveActionPackage(step)
      : await resolveActionPackage(step, actionOptions, resolutionSignal);
    assertRunnerSupportsActionManifest(resolvedPackage.manifest);
    const stateValue = objectValue(stepRun.state_json) as Record<
      string,
      ActionJson
    >;
    const effectiveTimeoutMs = actionTimeoutMs(
      step,
      resolvedPackage.manifest,
      networkAwareOptions,
      workerDefaultTimeoutMs,
    );
    const renewableRoomTransfer =
      renewableRoomSnapshot &&
      resolvedPackage.manifest.name === roomTransferActionPackage &&
      resolvedPackage.manifest.apiVersion === "workflow-actions/v1" &&
      extendedRuntimeAllowed(
        step,
        resolvedPackage.manifest,
        networkAwareOptions,
      );
    if (renewableRoomTransfer) {
      const prior = objectValue(
        objectValue(stepRun.resource_execution_json).trusted_idle_lease,
      );
      let idleDeadline = initialRoomTransferDeadline(
        Date.now(),
        stateValue.publicationId,
        prior,
      );
      renewRoomDeadline = (deadline) => {
        idleDeadline = acceptRoomTransferDeadline(
          idleDeadline,
          deadline,
          Date.now(),
        );
      };
      timeout = setInterval(() => {
        if (Date.now() >= idleDeadline && !controller.signal.aborted)
          controller.abort(
            new Error(
              "Room transfer made no verified recipient progress for 300 seconds.",
            ),
          );
      }, 250);
    } else {
      timeout = setTimeout(
        () => controller.abort(new Error("Step timed out.")),
        effectiveTimeoutMs,
      );
    }
    const credentialSecret = credentialSecretReaderPg(pool, {
      organizationId: String(workflowRun.organization_id ?? ""),
      workflowRunId: task.workflowRunId,
      workflowStepRunId: task.workflowStepRunId,
      packageName: resolvedPackage.manifest.name,
      packageVersion: resolvedPackage.manifest.version,
      manifest: resolvedPackage.manifest,
      config: step.config,
      inputs: task.input,
    });
    assertActionConfig(resolvedPackage.manifest, step.config);
    await markStepRunRunningPg(pool, task.workflowStepRunId);
    const result = await executeWithArtifactPorts(
      resolvedPackage,
      { config: step.config, inputs: task.input },
      {
        taskId: task.id,
        workflowRunId: task.workflowRunId,
        stepRunId: task.workflowStepRunId,
        room: resolveActionRoomContext({
          workflowRoom: objectValue(workflowRun.execution_context_json).room,
          actionPackage: step.actionPackage,
          config: step.config,
        }).room,
        stepId: task.workflowStepId,
        attempt: task.attempt,
        logger: actionLogger(options),
        state: {
          get: () => ({ ...stateValue }),
          set: async (nextState) => {
            await updateStepRunStatePg(pool, task, nextState);
            Object.keys(stateValue).forEach((key) => delete stateValue[key]);
            Object.assign(stateValue, nextState);
          },
          patch: async (partialState) => {
            await updateStepRunStatePg(pool, task, {
              ...stateValue,
              ...partialState,
            });
            Object.assign(stateValue, partialState);
          },
        },
        storage: memoryStorage(),
        artifacts: {
          publish: async (artifact) => {
            await authorizeTask(pool, task, options, "resource");
            return publishWorkerArtifact(artifact, {
              config: step.config,
              inputs: task.input,
              fileServer: options.fileServer,
            });
          },
        },
        secrets: {
          get: async (name) => {
            await authorizeTask(pool, task, options, "resource");
            assertAnyActionPermission(resolvedPackage.manifest, [
              "secrets:read",
              `secrets:${name}`,
            ]);
            return credentialSecret(name);
          },
        },
        beam: {
          rooms: roomWorkflowHost(
            task,
            resolvedPackage.manifest,
            controller.signal,
            renewRoomDeadline,
          ),
          objectStorage: {
            download: async (endpoint: WorkflowObjectStorageEndpoint) => {
              await authorizeTask(pool, task, options, "resource");
              assertActionPermission(resolvedPackage.manifest, "storage:read");
              return options.downloadObject(endpoint);
            },
            upload: async (
              endpoint: WorkflowObjectStorageEndpoint,
              content: string,
              uploadOptions?: { mediaType?: string },
            ) => {
              await authorizeTask(pool, task, options, "resource");
              assertActionPermission(resolvedPackage.manifest, "storage:write");
              return options.uploadObject(endpoint, content, uploadOptions);
            },
            delete: async (endpoint: WorkflowObjectStorageEndpoint) => {
              await authorizeTask(pool, task, options, "resource");
              assertActionPermission(
                resolvedPackage.manifest,
                "storage:delete",
              );
              return options.deleteObject(endpoint);
            },
          },
          ...(options.fileServer
            ? {
                fileExports: {
                  publishLocalFile: async (
                    input: Parameters<
                      NonNullable<typeof options.fileServer>["publishLocalFile"]
                    >[0],
                  ) => {
                    await authorizeTask(pool, task, options, "resource");
                    const fileServer = options.fileServer;
                    if (!fileServer) {
                      throw new Error("Worker file server is not available.");
                    }
                    assertActionPermission(
                      resolvedPackage.manifest,
                      "filesystem:read",
                    );
                    return fileServer.publishLocalFile(input);
                  },
                },
                files: {
                  publishTempFile: async (input: {
                    tempFilePath?: unknown;
                    name?: unknown;
                    mediaType?: unknown;
                    ttlSeconds?: unknown;
                  }) => {
                    await authorizeTask(pool, task, options, "resource");
                    const fileServer = options.fileServer;
                    if (!fileServer) {
                      throw new Error("Worker file server is not available.");
                    }
                    assertActionPermission(
                      resolvedPackage.manifest,
                      "filesystem:write",
                    );
                    const tempFilePath = await verifiedScratchFilePath(
                      String(input.tempFilePath ?? ""),
                      options.actionScratchDir ?? "/tmp/beam-action-scratch",
                    );
                    return fileServer.publishLocalFile({
                      source: { tempFilePath, deleteOnCleanup: true },
                      name:
                        typeof input.name === "string" ? input.name : undefined,
                      mediaType:
                        typeof input.mediaType === "string"
                          ? input.mediaType
                          : undefined,
                      ttlSeconds:
                        typeof input.ttlSeconds === "number"
                          ? input.ttlSeconds
                          : undefined,
                    });
                  },
                },
              }
            : {}),
        },
        signal: controller.signal,
      },
    );
    // A delivered room result still requires fresh authority before committing.
    // Temporary unavailability waits within the existing lease; denial never retries.
    if (renewableRoomTransfer)
      await withControlRecovery(
        () => authorizeTask(pool, task, options, "resource"),
        controller.signal,
        (error) => error instanceof WorkflowAuthorityUnavailableError,
      );
    else await authorizeTask(pool, task, options, "resource");
    const localizedResult = await localizeResultArtifacts(result, {
      config: step.config,
      inputs: task.input,
      fileServer: options.fileServer,
    });
    const committed = await completeTaskPg(
      pool,
      task,
      localizedResult,
      resolvedPackage,
      stateValue,
    );
    return { status: committed ? "completed" : "terminal" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = actionErrorRetryable(error);
    const blockedReason = blockedActionReason(message);
    if (blockedReason) {
      options.telemetry?.add("beam_workflow_action_blocked_total", 1, {
        reason: blockedReason,
        action_source: actionSourceLabel(task.actionPackageName),
      });
    }
    return step.required === false
      ? completeOptionalFailurePg(pool, task, message)
      : failTaskPg(pool, task, message, options, retryable);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function actionTimeoutMs(
  step: {
    timeoutSeconds?: number | null;
    sourceRegistry?: string | null;
  },
  manifest: ActionManifest | null,
  options: Pick<TaskWorkerOptions, "trustedNodeActionPackages">,
  workerDefaultTimeoutMs = defaultActionTimeoutMs,
) {
  const explicitSeconds = positiveFiniteNumber(step.timeoutSeconds);
  const manifestSeconds = positiveFiniteNumber(
    manifest?.execution?.defaultTimeoutSeconds,
  );
  const requestedSeconds = explicitSeconds ?? manifestSeconds;
  const requestedMs =
    requestedSeconds === null
      ? workerDefaultTimeoutMs
      : requestedSeconds * 1000;
  if (requestedMs <= workerDefaultTimeoutMs) {
    return requestedMs;
  }
  return manifest && extendedRuntimeAllowed(step, manifest, options)
    ? requestedMs
    : workerDefaultTimeoutMs;
}

function extendedRuntimeAllowed(
  step: { sourceRegistry?: string | null },
  manifest: ActionManifest,
  options: Pick<TaskWorkerOptions, "trustedNodeActionPackages">,
) {
  return (
    manifest.execution?.isolation === "trusted-node" &&
    manifest.name.startsWith("@beam/") &&
    (manifest.trustLevel === "builtin" || manifest.trustLevel === "verified") &&
    step.sourceRegistry === "public-registry" &&
    Boolean(options.trustedNodeActionPackages?.includes(manifest.name))
  );
}

function positiveFiniteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

async function optionsWithCredentialNetworkTargets(
  pool: PgPool,
  organizationId: string,
  step: ReturnType<typeof workflowStepFromSnapshot>,
  task: ClaimedWorkflowTask,
  options: TaskWorkerOptions,
) {
  if (!trustedNodeStepUsesNetwork(step) || !organizationId) {
    return options;
  }
  const credentialTargets = await trustedCredentialNetworkTargetsPg(
    pool,
    organizationId,
    step.config,
    task.input,
  );
  if (!credentialTargets.length) {
    return options;
  }
  const trustedNodeAllowedNetwork = [
    ...new Set([
      ...(options.trustedNodeAllowedNetwork ?? []),
      ...credentialTargets,
    ]),
  ];
  options.logger.debug(
    {
      taskId: task.id,
      credentialNetworkTargets: credentialTargets,
    },
    "Extended trusted action network allowlist from task credentials",
  );
  return { ...options, trustedNodeAllowedNetwork };
}

function trustedNodeStepUsesNetwork(
  step: ReturnType<typeof workflowStepFromSnapshot>,
) {
  return (
    step.manifestSnapshot?.execution?.isolation === "trusted-node" &&
    (step.manifestSnapshot.permissions ?? []).some((permission) =>
      permission.startsWith("network:"),
    )
  );
}

function authorizeTask(
  pool: PgPool,
  task: ClaimedWorkflowTask,
  options: Pick<TaskWorkerOptions, "authorizeExecution">,
  phase: "dispatch" | "lease_renewal" | "resource",
  extra: { artifactUrl?: boolean } = {},
) {
  return (options.authorizeExecution ?? authorizeWorkflowExecutionPg)(pool, {
    workflowRunId: task.workflowRunId,
    stepId: task.workflowStepId,
    taskId: task.id,
    claimToken: task.claimToken,
    phase,
    ...extra,
  });
}

export function startTaskLeaseHeartbeat(
  pool: PgPool,
  task: ClaimedWorkflowTask,
  options: Pick<
    TaskWorkerOptions,
    "authorizeExecution" | "lockTtlMs" | "logger" | "cancellationPollIntervalMs"
  >,
  controller: AbortController,
) {
  let stopped = false;
  let renewing = false;
  let checkingCancellation = false;
  let leaseDeadline =
    performance.now() +
    (task.leaseExpiresAt
      ? Math.max(0, Date.parse(task.leaseExpiresAt) - Date.now())
      : options.lockTtlMs);
  const deadlineTimer = setInterval(
    () => {
      if (
        !stopped &&
        performance.now() >= leaseDeadline &&
        !controller.signal.aborted
      )
        controller.abort(new Error("Workflow task lease expired."));
    },
    Math.max(10, Math.min(250, Math.floor(options.lockTtlMs / 4))),
  );
  deadlineTimer.unref();
  const heartbeatTimer = setInterval(async () => {
    if (stopped || renewing) {
      return;
    }
    renewing = true;
    try {
      await authorizeTask(pool, task, options, "lease_renewal");
      const expiresAt = new Date(Date.now() + options.lockTtlMs).toISOString();
      if (stopped || controller.signal.aborted) return;
      const renewed = await withPostgresTransaction(pool, (client) =>
        renewExecutorLeasePg(client, executorClaim(task), expiresAt),
      );
      if (renewed && !controller.signal.aborted)
        leaseDeadline =
          performance.now() + Math.max(0, Date.parse(expiresAt) - Date.now());
      else if (!controller.signal.aborted)
        controller.abort(
          new Error("Workflow task lease was lost or cancelled."),
        );
    } catch (error) {
      // Only a successful fresh check can renew the lease. The original
      // deadline timer and cancellation poll remain authoritative during outage.
      if (
        !(error instanceof WorkflowAuthorityUnavailableError) &&
        !controller.signal.aborted
      )
        controller.abort(error);
      options.logger.warn(
        { taskId: task.id, error },
        "PostgreSQL task lease heartbeat failed",
      );
    } finally {
      renewing = false;
    }
  }, taskLeaseHeartbeatIntervalMs(options.lockTtlMs));
  heartbeatTimer.unref();
  const cancellationTimer = setInterval(async () => {
    if (stopped || checkingCancellation || controller.signal.aborted) {
      return;
    }
    checkingCancellation = true;
    try {
      const result = await pool.query(
        `
        SELECT id
        FROM execution.workflow_tasks
        WHERE id = $1 AND status = 'running' AND claim_token = $2 AND lease_expires_at>now()
          AND EXISTS(SELECT 1 FROM execution.workflow_runs r WHERE r.id=execution.workflow_tasks.workflow_run_id AND r.status IN ('queued','running'))
          AND NOT EXISTS(SELECT 1 FROM execution.executor_assignments a WHERE a.task_id=$1 AND a.attempt=execution.workflow_tasks.attempt_count AND a.cancel_requested_at IS NOT NULL)
        `,
        [task.id, task.claimToken],
      );
      if (!result.rowCount && !controller.signal.aborted) {
        controller.abort(
          new Error("Workflow task lease was lost or cancelled."),
        );
      }
    } catch (error) {
      options.logger.warn(
        { taskId: task.id, error },
        "PostgreSQL task cancellation check failed",
      );
    } finally {
      checkingCancellation = false;
    }
  }, taskCancellationPollIntervalMs(options.cancellationPollIntervalMs));
  cancellationTimer.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(heartbeatTimer);
      clearInterval(deadlineTimer);
      clearInterval(cancellationTimer);
    },
  };
}

export function taskLeaseHeartbeatIntervalMs(lockTtlMs: number) {
  return Math.max(25, Math.floor(lockTtlMs / 3));
}

export function taskCancellationPollIntervalMs(intervalMs?: number) {
  return Math.max(25, Math.floor(intervalMs ?? 1_000));
}

async function completeTaskPg(
  pool: PgPool,
  task: ClaimedWorkflowTask,
  result: ActionResult,
  _package: RegisteredActionPackage,
  state: Record<string, ActionJson>,
) {
  const status = await withPostgresTransaction(pool, (client) =>
    settleExecutorResultPg(client, executorClaim(task), {
      status: "completed",
      result: { ...result, state: result.state ?? state },
      executorStopped: true,
    }),
  );
  return status === "completed";
}

async function failTaskPg(
  pool: PgPool,
  task: ClaimedWorkflowTask,
  error: string,
  options: TaskWorkerOptions,
  retryable = true,
): Promise<TaskProcessResult> {
  const status = await withPostgresTransaction(pool, (client) =>
    settleExecutorResultPg(client, executorClaim(task), {
      status: "failed",
      error: { message: error, retryable },
      executorStopped: true,
    }),
  );
  if (status === "retry_scheduled") {
    options.telemetry?.add("beam_workflow_task_retries_total", 1, {
      reason: "action_failure",
      task_kind: task.taskKind,
    });
    return {
      status: "retry",
      retryDelayMs: retryDelayMs(task.retryPolicy, task.attempt),
    };
  }
  if (status === "dead_letter") {
    options.telemetry?.add("beam_workflow_task_dead_letters_total", 1, {
      reason: retryable ? "max_attempts" : "non_retryable",
      task_kind: task.taskKind,
    });
    return { status: "dead_letter" };
  }
  return { status: "terminal" };
}

export function actionErrorRetryable(error: unknown) {
  return !(
    error !== null &&
    typeof error === "object" &&
    "retryable" in error &&
    error.retryable === false
  );
}

async function completeOptionalFailurePg(
  pool: PgPool,
  task: ClaimedWorkflowTask,
  error: string,
): Promise<TaskProcessResult> {
  await withPostgresTransaction(pool, (client) =>
    settleExecutorResultPg(client, executorClaim(task), {
      status: "failed",
      error: { message: error, retryable: false },
      executorStopped: true,
    }),
  );
  return { status: "terminal" };
}

async function cancelTaskPg(
  pool: PgPool,
  task: ClaimedWorkflowTask,
  error: string,
): Promise<TaskProcessResult> {
  await withPostgresTransaction(pool, (client) =>
    settleExecutorResultPg(client, executorClaim(task), {
      status: "cancelled",
      error: { message: error },
      executorStopped: true,
    }),
  );
  return { status: "terminal" };
}

async function markStepRunRunningPg(pool: PgPool, stepRunId: string) {
  const timestamp = now();
  await pool.query(
    `
    UPDATE execution.workflow_step_runs
    SET status = 'running', started_at = COALESCE(started_at, $2), updated_at = $2
    WHERE id = $1 AND status = 'queued'
    `,
    [stepRunId, timestamp],
  );
}

function executorClaim(task: ClaimedWorkflowTask) {
  return {
    taskId: task.id,
    attempt: task.attempt,
    claimToken: task.claimToken,
  };
}

async function updateStepRunStatePg(
  pool: PgPool,
  task: ClaimedWorkflowTask,
  state: Record<string, ActionJson>,
) {
  await withPostgresTransaction(pool, async (client) => {
    const current = await lockExecutorClaimPg(client, executorClaim(task));
    if (!current)
      throw new Error(
        "Workflow state write rejected: execution claim expired or cancelled.",
      );
    await client.query(
      `UPDATE execution.workflow_step_runs SET state_json = $2::jsonb ||
      (state_json - ARRAY(SELECT jsonb_object_keys(state_json) EXCEPT SELECT unnest(ARRAY['cancellationControlCommandId','cancellationControlAttempt','cancellationReconciliationDone']))),updated_at=now() WHERE id=$1`,
      [task.workflowStepRunId, JSON.stringify(state)],
    );
  });
}

async function appendEventPg(
  client: PgPool | PgClient,
  input: {
    organizationId?: string | null;
    workflowRunId?: string | null;
    workflowStepRunId?: string | null;
    workflowTaskId?: string | null;
    eventType: string;
    payload: Record<string, unknown>;
  },
) {
  const subject = workflowEventSubject(input);
  await client.query(
    `
    INSERT INTO execution.workflow_events (
      id, organization_id, workflow_run_id, workflow_step_run_id,
      workflow_task_id, event_type, event_version, subject_type, subject_id,
      correlation_id, payload_json, created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10::jsonb, $11)
    `,
    [
      id("wfev"),
      input.organizationId ?? null,
      input.workflowRunId ?? null,
      input.workflowStepRunId ?? null,
      input.workflowTaskId ?? null,
      input.eventType,
      subject.type,
      subject.id,
      input.workflowRunId ?? null,
      JSON.stringify(input.payload),
      now(),
    ],
  );
}

function workflowEventSubject(input: {
  workflowRunId?: string | null;
  workflowStepRunId?: string | null;
  workflowTaskId?: string | null;
  eventType: string;
}) {
  if (input.workflowTaskId) {
    return { type: "workflow_task", id: input.workflowTaskId };
  }
  if (input.workflowStepRunId) {
    return { type: "workflow_step_run", id: input.workflowStepRunId };
  }
  if (input.workflowRunId) {
    return { type: "workflow_run", id: input.workflowRunId };
  }
  return { type: "event", id: input.eventType };
}

function taskFromRow(row: Row): ClaimedWorkflowTask {
  const observability = objectValue(
    objectValue(row.metadata_json).observability,
  );
  const correlationId =
    typeof observability.correlationId === "string"
      ? observability.correlationId
      : String(row.workflow_run_id);
  return {
    id: String(row.id),
    workflowRunId: String(row.workflow_run_id),
    workflowStepRunId: String(row.workflow_step_run_id),
    workflowStepId: String(row.workflow_step_id),
    actionPackageName: String(row.action_package_name),
    taskKind: String(row.task_kind) as ClaimedWorkflowTask["taskKind"],
    shardIndex: numberOrNull(row.shard_index),
    shardCount: numberOrNull(row.shard_count),
    input: objectValue(row.input_json) as Record<string, ActionJson>,
    attempt: Number(row.attempts ?? row.attempt_count ?? 0),
    maxAttempts: Number(row.max_attempts ?? 1),
    retryPolicy: parseRetryPolicy(objectValue(row.retry_policy_json)),
    claimToken: String(row.claim_token),
    leaseExpiresAt: row.lease_expires_at
      ? new Date(String(row.lease_expires_at)).toISOString()
      : undefined,
    correlationId,
    traceContext: parseTraceparent(
      typeof observability.traceparent === "string"
        ? observability.traceparent
        : undefined,
      correlationId,
    ),
  };
}

function workflowStepFromSnapshot(row: Row) {
  const manifestSnapshot = objectValue(
    row.manifestSnapshot ?? row.manifest_snapshot,
  );
  return {
    id: String(row.id),
    actionPackage: String(row.actionPackage ?? row.action_package ?? ""),
    versionRange: String(row.versionRange ?? row.version_range ?? "*"),
    resolvedVersion: text(row.resolvedVersion ?? row.resolved_version),
    manifestSnapshot: Object.keys(manifestSnapshot).length
      ? (manifestSnapshot as ActionManifest)
      : null,
    artifactChecksum: text(row.artifactChecksum ?? row.artifact_checksum),
    mediaType: text(row.mediaType ?? row.media_type),
    sourceRegistry: text(row.sourceRegistry ?? row.source_registry),
    registryArtifactUrl: text(
      row.registryArtifactUrl ?? row.registry_artifact_url,
    ),
    hippiusBucket: text(row.hippiusBucket ?? row.hippius_bucket),
    hippiusKey: text(row.hippiusKey ?? row.hippius_key),
    hippiusEndpoint: text(row.hippiusEndpoint ?? row.hippius_endpoint),
    config: objectValue(row.config) as Record<string, ActionJson>,
    timeoutSeconds: Number.isFinite(Number(row.timeoutSeconds))
      ? Number(row.timeoutSeconds)
      : null,
    required: row.required === undefined ? true : Boolean(row.required),
  };
}

function objectValue(value: unknown): Row {
  const parsed = jsonValue(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Row)
    : {};
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function blockedActionReason(message: string) {
  const normalized = message.toLowerCase();
  if (/permission|not allowed|denied/.test(normalized)) return "permission";
  if (/config|schema|invalid input/.test(normalized)) return "configuration";
  if (/trust|checksum|provenance/.test(normalized)) return "trust";
  if (/sandbox|isolation|memory limit/.test(normalized)) return "sandbox";
  return null;
}

async function verifiedScratchFilePath(filePath: string, scratchDir: string) {
  if (!filePath) {
    throw new Error("Worker temp file path is required.");
  }
  const [resolvedFilePath, resolvedScratchDir] = await Promise.all([
    realpath(filePath),
    realpath(scratchDir),
  ]);
  const relative = path.relative(resolvedScratchDir, resolvedFilePath);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative === ""
  ) {
    throw new Error(
      "Worker temp file path is outside the action scratch directory.",
    );
  }
  return resolvedFilePath;
}

function arrayValue(value: unknown) {
  const parsed = jsonValue(value);
  return Array.isArray(parsed) ? parsed : [];
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function numberOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function checksumJson(value: unknown) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function now() {
  return new Date().toISOString();
}
