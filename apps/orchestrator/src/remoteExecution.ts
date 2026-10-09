import crypto from "node:crypto";
import { connect, StringCodec } from "nats";
import {
  pgOne,
  lockLogicalPartitionAdmissionPg,
  authorizeWorkflowExecutionPg,
  grantedArtifactUrl,
  settleExecutorResultPg,
  withPostgresTransaction,
  workflowRunAuthorityGenerationPg,
  type PgClient,
  type PgPool,
} from "@beam-studio/db";
import { stripUrlCredentials } from "@beam-studio/shared/logging";
import { workflowStepFromSnapshot } from "./postgresOrchestration.js";
import type {
  ApiLogger,
  RemoteExecutionConfig,
  PreparedTaskPublication,
  Row,
  TaskPublishRequest,
} from "./types.js";

type RemoteExecutionResult = {
  type: "workflow_task_result";
  event_id: string;
  task_id: string;
  attempt_id: string;
  worker_id: string;
  status: "completed" | "failed" | "cancelled";
  outputs?: Record<string, string>;
  error?: string;
  completed_at?: string;
};

type RemoteTaskContext = {
  task: Row;
  workflowRun: Row;
  stepRun: Row;
  step: ReturnType<typeof workflowStepFromSnapshot>;
  attemptId: string;
  leaseExpiresAt: string;
};

type PreparedRemoteTaskContext = RemoteTaskContext & { payload: unknown };

export function createRemoteTaskPreparer(
  pool: PgPool,
  config: RemoteExecutionConfig,
  logger: ApiLogger,
) {
  return async (
    request: TaskPublishRequest,
  ): Promise<PreparedTaskPublication | null> => {
    if (
      !["beamcore-public", "execution-location", "custom"].includes(
        String(request.placement),
      )
    ) {
      if (!request.subject)
        throw new Error("Studio task publication has no subject.");
      return {
        subject: request.subject,
        messageId: request.messageId ?? request.taskId,
        payload: {
          taskId: request.taskId,
          workflowRunId: request.workflowRunId,
          correlationId: request.correlationId,
          traceparent: request.traceparent,
        },
      };
    }
    const context = await claimRemoteTask(pool, request, config);
    if (!context) {
      logger.info(
        { taskId: request.taskId },
        "Orchestrator task publication skipped because the task is already terminal",
      );
      return null;
    }
    logger.info(
      {
        taskId: request.taskId,
        attemptId: context.attemptId,
        subject: config.taskSubject,
        actionPackageName: context.step.actionPackage,
        sandboxRuntime: config.sandboxRuntime,
      },
      "Prepared immutable Studio task snapshot for Orchestrator",
    );
    return {
      subject: config.taskSubject,
      messageId: request.messageId ?? context.attemptId,
      payload: context.payload,
    };
  };
}

export async function startRemoteResultResponder(
  servers: string,
  pool: PgPool,
  config: RemoteExecutionConfig,
  logger: ApiLogger,
) {
  const codec = StringCodec();
  const loggedServers = stripUrlCredentials(servers);
  let stopped = false;
  let ready = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopReconnectWait: (() => void) | null = null;
  let connection: Awaited<ReturnType<typeof connect>> | null = null;
  let subscription: ReturnType<
    Awaited<ReturnType<typeof connect>>["subscribe"]
  > | null = null;
  const consuming = (async () => {
    while (!stopped) {
      try {
        connection = await connect({
          servers,
          name: "beam-studio-orchestrator-results",
          maxReconnectAttempts: -1,
        });
        if (stopped) {
          await connection.close();
          break;
        }
        subscription = connection.subscribe(config.resultSubject);
        ready = true;
        logger.info(
          { servers: loggedServers, subject: config.resultSubject },
          "Orchestrator Studio result responder connected",
        );
        for await (const message of subscription) {
          try {
            const result = decodeRemoteExecutionResult(
              codec.decode(message.data),
            );
            const outcome = await applyRemoteExecutionResult(pool, result);
            logger.info(
              {
                taskId: result.task_id,
                attemptId: result.attempt_id,
                workerId: result.worker_id,
                status: result.status,
                outcome,
              },
              "Committed Orchestrator Studio result",
            );
            message.respond(
              codec.encode(JSON.stringify({ acknowledged: true, outcome })),
            );
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            logger.error({ error }, "Orchestrator Studio result commit failed");
            message.respond(
              codec.encode(JSON.stringify({ acknowledged: false, reason })),
            );
          }
        }
      } catch (error) {
        if (!stopped) {
          logger.warn(
            { servers: loggedServers, error },
            "Orchestrator Studio result responder unavailable; reconnecting",
          );
        }
      } finally {
        ready = false;
        subscription?.unsubscribe();
        subscription = null;
        await connection?.close().catch((error) => {
          if (!stopped) {
            logger.warn(
              { servers: loggedServers, error },
              "Orchestrator Studio result responder connection close failed",
            );
          }
        });
        connection = null;
      }
      if (!stopped) {
        await new Promise<void>((resolve) => {
          stopReconnectWait = resolve;
          reconnectTimer = setTimeout(resolve, 1_000);
        });
        stopReconnectWait = null;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    }
  })();
  return {
    ready() {
      return ready;
    },
    async close() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopReconnectWait?.();
      subscription?.unsubscribe();
      await connection?.close();
      await consuming;
    },
  };
}

async function claimRemoteTask(
  pool: PgPool,
  request: TaskPublishRequest,
  config: RemoteExecutionConfig,
): Promise<PreparedRemoteTaskContext | null> {
  return withPostgresTransaction(pool, async (client) => {
    const run = await pgOne<Row>(
      client,
      `SELECT r.id FROM execution.workflow_runs r
       JOIN execution.workflow_tasks t ON t.workflow_run_id=r.id
       WHERE t.id=$1 FOR UPDATE OF r`,
      [request.taskId],
    );
    if (!run)
      throw new Error(`Studio workflow task ${request.taskId} does not exist.`);
    const joined = await pgOne<Row>(
      client,
      `
      SELECT task.*, run.resolved_steps_json,
             step_run.state_json AS step_state_json,
             step_run.status AS step_status, step_run.resolved_placement,
             run.status AS run_status
      FROM execution.workflow_tasks task
      JOIN execution.workflow_runs run ON run.id = task.workflow_run_id
      JOIN execution.workflow_step_runs step_run ON step_run.id = task.workflow_step_run_id
      WHERE task.id = $1
      FOR UPDATE OF task
      `,
      [request.taskId],
    );
    if (!joined) {
      throw new Error(`Studio workflow task ${request.taskId} does not exist.`);
    }
    const status = String(joined.status);
    if (["completed", "failed", "cancelled", "dead_letter"].includes(status)) {
      return null;
    }
    if (!["queued", "running"].includes(String(joined.run_status))) return null;
    const authorityGeneration = await workflowRunAuthorityGenerationPg(
      client,
      String(run.id),
    );
    if (authorityGeneration === null)
      throw new Error("Workflow authority is unavailable for remote dispatch.");
    const frozenStep = arrayValue(joined.resolved_steps_json)
      .map(objectValue)
      .find((step) => step.id === joined.workflow_step_id);
    if (objectValue(frozenStep?.executionTarget).kind !== "remote-transport")
      throw new Error("Action does not declare the remote transport target.");
    if (
      !["beamcore-public", "custom", "execution-location"].includes(
        String(joined.resolved_placement),
      )
    )
      throw new Error("Action placement conflicts with remote transport.");
    // Studio signs a Registry URL for this publication only (the orchestrator
    // holds no organization key); the run keeps its durable URL.
    const grant = await authorizeWorkflowExecutionPg(client, {
      workflowRunId: String(joined.workflow_run_id),
      stepId: String(joined.workflow_step_id),
      phase: "dispatch",
      inputs: objectValue(joined.input_json) as any,
      artifactUrl: frozenStep?.sourceRegistry === "public-registry",
    });
    const signedArtifactUrl = grant
      ? grantedArtifactUrl(grant.artifactUrl)
      : null;
    const timestamp = new Date().toISOString();
    let leaseExpiresAt = new Date(Date.now() + config.leaseMs).toISOString();
    let task = joined;
    let attempt = Number(joined.attempts ?? 0);
    let attemptId = String(joined.claim_token ?? "");
    if (["queued", "retry_scheduled"].includes(status)) {
      if (!(await lockLogicalPartitionAdmissionPg(client, request.taskId)))
        throw new Error("Logical partition admission is full.");
      attempt += 1;
      attemptId = `${request.taskId}:${attempt}`;
      const claimed = await pgOne<Row>(
        client,
        `
        UPDATE execution.workflow_tasks
        SET status = 'running', attempts = $2, attempt_count = $2,
            locked_by = $3, leased_by = $3,
            lock_expires_at = $4, lease_expires_at = $4,
            claim_token = $5, started_at = COALESCE(started_at, $6),
            error = NULL, updated_at = $6
        WHERE id = $1 AND status IN ('queued', 'retry_scheduled')
          AND NOT EXISTS(SELECT 1 FROM execution.executor_assignments previous
            WHERE previous.task_id=execution.workflow_tasks.id
              AND previous.cleanup_confirmed_at IS NULL)
        RETURNING *
        `,
        [
          request.taskId,
          attempt,
          config.ownerId,
          leaseExpiresAt,
          attemptId,
          timestamp,
        ],
      );
      if (!claimed) {
        throw new Error(
          `Studio workflow task ${request.taskId} could not be claimed for the Orchestrator.`,
        );
      }
      task = { ...joined, ...claimed };
      await client.query(
        `INSERT INTO execution.executor_assignments(id,organization_id,workflow_run_id,workflow_step_run_id,task_id,attempt,backend,executor_id,declared_target_json,state,lease_expires_at,authority_generation)
        VALUES($1,$2,$3,$4,$5,$6,'remote-transport',$7,$8::jsonb,'dispatching',$9,$10)`,
        [
          id("assignment"),
          task.organization_id,
          task.workflow_run_id,
          task.workflow_step_run_id,
          task.id,
          attempt,
          config.ownerId,
          JSON.stringify(frozenStep!.executionTarget),
          leaseExpiresAt,
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
          request.taskId,
          attempt,
          config.ownerId,
          timestamp,
          JSON.stringify({
            claimToken: attemptId,
            executor: "beam-orchestrator",
          }),
        ],
      );
      await client.query(
        `
        UPDATE execution.workflow_step_runs
        SET status = 'running', started_at = COALESCE(started_at, $2), updated_at = $2
        WHERE id = $1 AND status = 'queued'
        `,
        [String(task.workflow_step_run_id), timestamp],
      );
      await appendEvent(client, task, "TaskClaimedByOrchestrator", {
        ownerId: config.ownerId,
        attemptId,
      });
    } else if (
      status === "running" &&
      String(joined.locked_by ?? "") === config.ownerId &&
      attemptId
    ) {
      // Uncertain publication reuses the existing attempt and original lease.
      // The current remote protocol has no authenticated renewal handshake.
      const assignment = await pgOne<Row>(
        client,
        `SELECT authority_generation,cancel_requested_at,cleanup_confirmed_at
         FROM execution.executor_assignments
         WHERE task_id=$1 AND attempt=$2 AND backend='remote-transport'`,
        [request.taskId, attempt],
      );
      if (
        !assignment ||
        Number(assignment.authority_generation) !== authorityGeneration ||
        assignment.cancel_requested_at ||
        assignment.cleanup_confirmed_at
      )
        throw new Error(
          "Remote assignment requires reconciliation before redispatch.",
        );
      leaseExpiresAt = new Date(String(joined.lease_expires_at)).toISOString();
      if (Date.parse(leaseExpiresAt) <= Date.now())
        throw new Error(
          "Remote lease expired; executor reconciliation is required before redispatch.",
        );
    } else {
      throw new Error(
        `Studio workflow task ${request.taskId} is owned by another executor.`,
      );
    }

    const workflowRun = await pgOne<Row>(
      client,
      "SELECT * FROM execution.workflow_runs WHERE id = $1",
      [String(task.workflow_run_id)],
    );
    const stepRun = await pgOne<Row>(
      client,
      "SELECT * FROM execution.workflow_step_runs WHERE id = $1",
      [String(task.workflow_step_run_id)],
    );
    if (!workflowRun || !stepRun) {
      throw new Error(
        `Studio workflow task ${request.taskId} references a missing run or step.`,
      );
    }
    const frozen = arrayValue(workflowRun.resolved_steps_json)
      .filter((value): value is Row =>
        Boolean(value && typeof value === "object"),
      )
      .map((value, index) => workflowStepFromSnapshot(value, index))
      .find((value) => value.id === String(task.workflow_step_id));
    const step =
      frozen && signedArtifactUrl
        ? { ...frozen, registryArtifactUrl: signedArtifactUrl }
        : frozen;
    if (!step) {
      throw new Error(
        `Studio workflow task ${request.taskId} references an unknown step snapshot.`,
      );
    }
    const context = {
      task,
      workflowRun,
      stepRun,
      step,
      attemptId,
      leaseExpiresAt,
    };
    return {
      ...context,
      // Materialize inside the same transaction as the claim. If a pinned
      // artifact or sandbox requirement is missing, the claim rolls back and
      // the durable outbox can retry safely after configuration is fixed.
      payload: buildRemoteTaskMessage(context, request, config),
    };
  });
}

function buildRemoteTaskMessage(
  context: RemoteTaskContext,
  request: TaskPublishRequest,
  config: RemoteExecutionConfig,
) {
  const { task, step, attemptId, leaseExpiresAt } = context;
  const manifest = (step.manifestSnapshot ?? {}) as Record<string, unknown>;
  if (step.mediaType === "application/vnd.beam.builtin-action+json") {
    throw new Error(
      `Studio action ${step.actionPackage} is embedded in the Studio Action Runner and must be published as an executable Registry artifact before Orchestrator execution.`,
    );
  }
  const artifactChecksum = String(step.artifactChecksum ?? "");
  if (!artifactChecksum) {
    throw new Error(
      `Studio action ${step.actionPackage} has no executable artifact checksum.`,
    );
  }
  const artifactURL =
    step.registryArtifactUrl ??
    artifactURLFromBase(config.artifactUrlBase, artifactChecksum);
  if (config.sandboxRuntime !== "node-legacy" && !artifactURL) {
    throw new Error(
      `Studio action ${step.actionPackage} requires a downloadable artifact for ${config.sandboxRuntime}.`,
    );
  }
  const entrypoint =
    typeof manifest.entrypoint === "string"
      ? manifest.entrypoint
      : "dist/index.mjs";
  return {
    event_id: request.messageId ?? attemptId,
    type: "workflow_task",
    task: {
      task_id: String(task.id),
      attempt_id: attemptId,
      action_package_name: step.actionPackage,
      action_version: step.resolvedVersion ?? "latest",
      entrypoint,
      artifact_sha256: artifactChecksum,
      timeout_seconds: step.timeoutSeconds ?? 300,
      // Studio action entrypoints receive the same first argument as they do
      // in the Studio Action Runner: { config, inputs }.
      input: {
        config: step.config,
        inputs: objectValue(task.input_json),
      },
      config: step.config,
      required_permissions: Array.isArray(manifest.permissions)
        ? manifest.permissions.map(String)
        : [],
      ...(artifactURL
        ? {
            registry_artifact: {
              url: artifactURL,
              media_type: step.mediaType ?? "application/gzip",
              size_bytes: step.artifactSizeBytes ?? 0,
            },
          }
        : {}),
      sandbox: {
        runtime: config.sandboxRuntime,
        legacy_node: config.sandboxRuntime === "node-legacy",
      },
      host_rpc_methods: [],
      lease_expires_at: leaseExpiresAt,
    },
  };
}

export function decodeRemoteExecutionResult(
  encoded: string,
): RemoteExecutionResult {
  const value = JSON.parse(encoded) as Partial<RemoteExecutionResult>;
  if (
    value.type !== "workflow_task_result" ||
    !value.task_id ||
    !value.attempt_id ||
    !value.event_id ||
    !value.worker_id ||
    !["completed", "failed", "cancelled"].includes(String(value.status))
  ) {
    throw new Error("Invalid Orchestrator Studio result envelope.");
  }
  return value as RemoteExecutionResult;
}

export async function applyRemoteExecutionResult(
  pool: PgPool,
  result: RemoteExecutionResult,
) {
  const current = await pgOne<Row>(
    pool,
    "SELECT * FROM execution.workflow_tasks WHERE id=$1",
    [result.task_id],
  );
  if (!current) throw new Error("Remote workflow task does not exist.");
  if (
    ["completed", "failed", "cancelled", "dead_letter"].includes(
      String(current.status),
    )
  )
    return "already_terminal";
  if (current.claim_token !== result.attempt_id) return "stale_attempt_ignored";
  if (
    result.status === "completed" &&
    new Date(String(current.lease_expires_at)).getTime() > Date.now()
  )
    await authorizeWorkflowExecutionPg(pool, {
      workflowRunId: String(current.workflow_run_id),
      stepId: String(current.workflow_step_id),
      taskId: result.task_id,
      claimToken: result.attempt_id,
      phase: "resource",
    });
  return withPostgresTransaction(pool, async (client) => {
    // Cancellation disposition in the existing connector does not prove that a
    // remote process stopped. Keep the assignment visible and unreassignable.
    if (result.status === "cancelled") {
      await client.query(
        `UPDATE execution.executor_assignments SET state='reconciliation_required',cancel_requested_at=COALESCE(cancel_requested_at,now()),
        error_json='{"code":"remote_cleanup_unconfirmed","message":"Remote cancellation lacks executor termination confirmation."}',updated_at=now()
        WHERE task_id=$1 AND attempt=$2 AND cleanup_confirmed_at IS NULL`,
        [result.task_id, current.attempt_count],
      );
      return "cleanup_unconfirmed";
    }
    const assignment = await pgOne<Row>(
      client,
      "SELECT * FROM execution.executor_assignments WHERE task_id=$1 AND attempt=$2 AND backend='remote-transport' FOR UPDATE",
      [result.task_id, current.attempt_count],
    );
    if (!assignment) return "stale_attempt_ignored";
    await client.query(
      "UPDATE execution.executor_assignments SET executor_id=$2 WHERE id=$1",
      [assignment.id, result.worker_id],
    );
    return settleExecutorResultPg(
      client,
      {
        taskId: result.task_id,
        attempt: Number(current.attempt_count),
        claimToken: result.attempt_id,
      },
      {
        status: result.status,
        result:
          result.status === "completed"
            ? (parseObject(
                result.outputs?.result,
              ) as import("@beam-studio/core").ActionResult)
            : undefined,
        error:
          result.status === "failed"
            ? {
                message: result.error ?? "Remote action failed.",
                retryable: true,
              }
            : undefined,
        executorStopped: true,
      },
    );
  });
}

async function appendEvent(
  client: PgClient,
  task: Row,
  eventType: string,
  payload: Record<string, unknown>,
) {
  await client.query(
    `
    INSERT INTO execution.workflow_events (
      id, organization_id, workflow_run_id, workflow_step_run_id,
      workflow_task_id, event_type, event_version, subject_type, subject_id,
      correlation_id, payload_json, created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, 1, 'workflow_task', $5, $3, $7::jsonb, $8)
    `,
    [
      id("wfev"),
      task.organization_id ? String(task.organization_id) : null,
      String(task.workflow_run_id),
      task.workflow_step_run_id ? String(task.workflow_step_run_id) : null,
      String(task.id),
      eventType,
      JSON.stringify(payload),
      new Date().toISOString(),
    ],
  );
}

function artifactURLFromBase(base: string | undefined, checksumValue: string) {
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}/${encodeURIComponent(checksumValue.replace(/^sha256:/, ""))}`;
}

function parseObject(value: string | undefined) {
  return objectValue(parseValue(value));
}

function parseValue(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export type RemoteResultResponder = Awaited<
  ReturnType<typeof startRemoteResultResponder>
>;
