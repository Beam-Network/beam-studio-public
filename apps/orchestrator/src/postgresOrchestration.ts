import {
  planActionTasks,
  planFrozenRoomStepTasks,
  frozenV3RetentionObligationId,
  partitionedRoomTaskMetadata,
  v3AggregationTaskMetadata,
  nextReduceTasks,
  type FrozenRoomStepPlanning,
} from "./distributedExecution.js";
import {
  authorizeV3ArtifactReadPg,
  dispatchRoomMemberTaskPg,
  resolveFrozenV3RoomPg,
} from "./roomMemberExecution.js";
import {
  admitFrozenAggregationInvocationPg,
  persistFrozenAggregationPlanPg,
  planAggregationForFrozenPartitions,
  type FrozenAggregationArtifactInput,
  type FrozenLogicalPartitionPlan,
} from "./frozenAggregationPlan.js";
import { dispatchBatch } from "./dispatchBatch.js";
import {
  createWorkflowCallPg,
  reconcileWorkflowCallsPg,
  requestChildCancellationsPg,
  resolveRunOutputPg,
} from "./workflowCalls.js";
import {
  captureWorkflowTreePg,
  reconcileExecutorAssignmentsPg,
  acquireWorkflowRunAuthorityPg,
  renewWorkflowRunAuthoritiesPg,
  createExecutorBackend,
  enqueueFrozenWorkflowRunPg,
  authorizeWorkflowExecutionPg,
  WorkflowAuthorizationError,
  WorkflowAuthorityUnavailableError,
  requestWorkflowCancellationPg,
  workflowHasBillingKeySql,
} from "@beam-studio/db";
import crypto from "node:crypto";
import { deferredScheduleReason } from "@beam-studio/db";

const orchestrationOwnerId = `orchestrator_${crypto.randomUUID()}`;
// Keep the hard bound compatible with workflow-graph/v3's declared 100k tasks.
const maxTasksPerPlan = 100_000;
const maxOpenTasksPerOrganization = 200_000;

class WorkflowTaskAdmissionDeferred extends Error {}

/** Logical partitions are frozen in the plan. This only slows producers when
 * the organization's outstanding task backlog is full. */
async function assertWorkflowTaskAdmissionPg(
  client: PgClient,
  organizationId: string,
  requested: number,
) {
  if (requested > maxTasksPerPlan)
    throw new WorkflowContractError(
      `Action plan exceeds the ${maxTasksPerPlan} task admission limit.`,
    );
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `workflow-task:${organizationId}`,
  ]);
  const row = await pgOne<{ count: number }>(
    client,
    `SELECT COUNT(*)::int AS count FROM execution.workflow_tasks
     WHERE organization_id=$1 AND status IN ('queued','leased','running','retry_scheduled')`,
    [organizationId],
  );
  if (Number(row?.count ?? 0) + requested > maxOpenTasksPerOrganization)
    throw new WorkflowTaskAdmissionDeferred(
      "Organization workflow task admission is full.",
    );
}
import {
  assertActionConfig,
  createBuiltinActionRegistry,
  evaluateEdgeCondition,
  resolveInputBindings,
  resolveDynamicGraphValue,
  resolveWorkflowCallBindings,
  WorkflowContractError,
  retryPolicyForTask,
  taskSubjectFor,
  type WorkflowGraphV2Control,
  conditionTraceForEvaluation,
  type ActionJson,
  type ActionResult,
  type WorkflowStepMetadata,
  type ActionManifest,
  resolveWorkflowGraphV3,
  resolveWorkflowGraphV3CarryRoutes,
  resolveWorkflowGraphV3InitialRoutes,
  type WorkflowGraphV3Definition,
  type WorkflowGraphV3LoopControl,
  type WorkflowGraphValidationStep,
  type DistributedMember,
  type DistributedTask as GraphV3DistributedTask,
  type ResolvedDistributedRoute,
  type ActionManifestV2,
  planAggregationInvocations,
  WorkflowGraphV3ValidationError,
} from "@beam-studio/core";
import {
  pgMany,
  pgOne,
  withPostgresTransaction,
  type PgClient,
  type PgPool,
  freezeWorkflowArtifactInputPg,
  ArtifactAcceptanceError,
} from "@beam-studio/db";
import {
  actionSourceLabel,
  formatTraceparent,
  parseTraceparent,
  placementLabel,
  type TraceContext,
} from "@beam-studio/telemetry";
import { resolveActionPackageVersionPg } from "@beam-studio/db";
import {
  evaluateScheduleOccurrence,
  normalizeScheduleRuntimeConfig,
  normalizeScheduleRuntimeState,
  scheduleTriggerStatus,
  type ScheduleRuntimeConfig,
  type ScheduleRuntimeState,
} from "./scheduleRuntime.js";
import type {
  ApiLogger,
  ApiWorkflowStep,
  OrchestratorOptions,
  Row,
  TaskPublishRequest,
} from "./types.js";
import {
  orchestrateDynamicGraphPg,
  persistConditionTrace,
} from "./dynamicGraphOrchestration.js";
import {
  handledFailureStepIds,
  workflowDecisionEdgesFromSnapshot,
  workflowDecisionsFromSnapshot,
} from "./decisions.js";

export function pgId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function now() {
  return new Date().toISOString();
}

export function workflowGraphVersionFromSnapshot(value: unknown) {
  const snapshot = objectValue(value);
  const template = objectValue(snapshot.workflowTemplate);
  const version =
    snapshot.graphVersion ?? template.graphVersion ?? template.graph_version;
  return version === "workflow-graph/v3"
    ? "workflow-graph/v3"
    : version === "workflow-graph/v2"
      ? "workflow-graph/v2"
      : "workflow-graph/v1";
}

export async function registerBuiltinActionPackagesPg(pool: PgPool) {
  const timestamp = now();
  await registerBuiltinActionRegistryPg(pool, timestamp);
}

export async function registerBuiltinActionRegistryPg(
  pool: PgPool,
  timestamp: string,
) {
  const scopeResult = await pool.query<{ id: string }>(
    `
    INSERT INTO actions.scopes (
      id, name, status, metadata_json, created_at, updated_at
    )
    VALUES ('act_scope_beam', '@beam', 'active', '{"source":"builtin"}'::jsonb, $1, $1)
    ON CONFLICT (name) DO UPDATE SET
      status = EXCLUDED.status,
      metadata_json = actions.scopes.metadata_json || EXCLUDED.metadata_json,
      updated_at = EXCLUDED.updated_at
    RETURNING id
    `,
    [timestamp],
  );
  const scopeId = scopeResult.rows[0]?.id ?? "act_scope_beam";

  const actions = createBuiltinActionRegistry().listPackages();
  const categorySlugs = new Set(
    actions.map((action) => categorySlug(action.manifest)),
  );
  const categoryIdsBySlug = new Map<string, string>();

  for (const slug of categorySlugs) {
    const result = await pool.query<{ id: string }>(
      `
      INSERT INTO actions.categories (
        id, slug, name, description, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $5)
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        updated_at = EXCLUDED.updated_at
      RETURNING id
      `,
      [
        registryId("act_cat", slug),
        slug,
        titleFromSlug(slug),
        `Beam ${titleFromSlug(slug).toLowerCase()} actions.`,
        timestamp,
      ],
    );
    categoryIdsBySlug.set(
      slug,
      result.rows[0]?.id ?? registryId("act_cat", slug),
    );
  }

  for (const action of actions) {
    const packageName = action.manifest.name;
    const packageShortName = packageNameParts(packageName).name;
    const pkgId = registryId("act_pkg", packageName);
    const versionId = registryId(
      "act_ver",
      `${packageName}_${action.manifest.version}`,
    );
    const latestTagId = registryId("act_tag", `${packageName}_latest`);
    const catalog = action.manifest.catalog;
    const slug = categorySlug(action.manifest);
    const categoryId =
      categoryIdsBySlug.get(slug) ?? registryId("act_cat", slug);

    const packageResult = await pool.query<{ id: string }>(
      `
      INSERT INTO actions.packages (
        id, scope_id, category_id, name, package_name, display_name,
        description, visibility, status, trust_level, latest_version,
        metadata_json, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, 'public', 'active', 'builtin', $8,
        $9::jsonb, $10, $10
      )
      ON CONFLICT (package_name) DO UPDATE SET
        category_id = EXCLUDED.category_id,
        display_name = EXCLUDED.display_name,
        description = EXCLUDED.description,
        visibility = EXCLUDED.visibility,
        status = EXCLUDED.status,
        trust_level = EXCLUDED.trust_level,
        latest_version = EXCLUDED.latest_version,
        metadata_json = EXCLUDED.metadata_json,
        updated_at = EXCLUDED.updated_at
      RETURNING id
      `,
      [
        pkgId,
        scopeId,
        categoryId,
        packageShortName,
        packageName,
        String(action.manifest.displayName ?? packageShortName),
        action.manifest.description
          ? String(action.manifest.description)
          : null,
        action.manifest.version,
        JSON.stringify({
          source: "builtin",
          owner: catalog?.owner ?? "Beam",
          maturity: catalog?.maturity ?? "stable",
          tags: Array.isArray(catalog?.tags) ? catalog.tags : [],
        }),
        timestamp,
      ],
    );
    const packageId = packageResult.rows[0]?.id ?? pkgId;

    const versionResult = await pool.query<{ id: string }>(
      `
      INSERT INTO actions.package_versions (
        id, package_id, version, manifest_json, manifest_checksum,
        artifact_checksum, artifact_size_bytes, hippius_bucket, hippius_key,
        hippius_endpoint, media_type, provenance_json, validation_status,
        status, published_by, published_at, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4::jsonb, $5,
        $6, 0, NULL, NULL,
        NULL, 'application/vnd.beam.builtin-action+json',
        $7::jsonb, 'verified',
        'active', 'beam', $8, $8, $8
      )
      ON CONFLICT (package_id, version) DO UPDATE SET
        manifest_json = EXCLUDED.manifest_json,
        manifest_checksum = EXCLUDED.manifest_checksum,
        artifact_checksum = EXCLUDED.artifact_checksum,
        media_type = EXCLUDED.media_type,
        provenance_json = EXCLUDED.provenance_json,
        validation_status = EXCLUDED.validation_status,
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at
      RETURNING id
      `,
      [
        versionId,
        packageId,
        action.manifest.version,
        JSON.stringify(action.manifest),
        action.checksum,
        `sha256:${action.checksum}`,
        JSON.stringify({
          source: "builtin",
          note: "First-party action bundled with the Studio runtime.",
        }),
        timestamp,
      ],
    );
    const packageVersionId = versionResult.rows[0]?.id ?? versionId;

    await pool.query(
      `
      INSERT INTO actions.dist_tags (
        id, package_id, tag, version_id, updated_by, created_at, updated_at
      )
      VALUES ($1, $2, 'latest', $3, 'beam', $4, $4)
      ON CONFLICT (package_id, tag) DO UPDATE SET
        version_id = EXCLUDED.version_id,
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at
      `,
      [latestTagId, packageId, packageVersionId, timestamp],
    );
  }
}

export async function estimateGlobalLoadPg(pool: PgPool) {
  const row = await pgOne<Row>(
    pool,
    `
    SELECT
      COUNT(*) FILTER (
        WHERE status = 'active'
          AND heartbeat_at >= now() - interval '30 seconds'
      ) AS active_worker_count,
      COALESCE(SUM(active_task_count) FILTER (
        WHERE status = 'active'
          AND heartbeat_at >= now() - interval '30 seconds'
      ), 0) AS active_task_count,
      COALESCE(AVG(load_score) FILTER (
        WHERE status = 'active'
          AND heartbeat_at >= now() - interval '30 seconds'
      ), 0) AS average_load_score
    FROM runtime.worker_runtime_state
    `,
  );
  return {
    activeWorkerCount: Number(row?.active_worker_count ?? 0),
    activeTaskCount: Number(row?.active_task_count ?? 0),
    averageLoadScore: Number(row?.average_load_score ?? 0),
  };
}

export async function commandPublicationStatePg(pool: PgPool) {
  const row = await pgOne<Row>(
    pool,
    `
    SELECT
      COUNT(*) FILTER (WHERE state = 'pending') AS pending_count,
      COUNT(*) FILTER (WHERE state = 'publishing') AS publishing_count,
      COUNT(*) FILTER (
        WHERE state = 'pending' AND last_error IS NOT NULL
      ) AS pending_with_error_count,
      COALESCE(
        EXTRACT(EPOCH FROM (now() - MIN(created_at) FILTER (
          WHERE state IN ('pending', 'publishing')
        ))),
        0
      ) AS oldest_unpublished_seconds
    FROM execution.command_outbox
    `,
  );
  return {
    pendingCount: Number(row?.pending_count ?? 0),
    publishingCount: Number(row?.publishing_count ?? 0),
    pendingWithErrorCount: Number(row?.pending_with_error_count ?? 0),
    oldestUnpublishedSeconds: Number(row?.oldest_unpublished_seconds ?? 0),
  };
}

export async function observabilitySnapshotPg(pool: PgPool) {
  const [queue, workers] = await Promise.all([
    pgOne<Row>(
      pool,
      `
      SELECT
        COUNT(*) FILTER (WHERE status = 'queued') AS queued_count,
        COUNT(*) FILTER (WHERE status = 'retry_scheduled') AS retry_count,
        COUNT(*) FILTER (WHERE status = 'running') AS running_count,
        COUNT(*) FILTER (WHERE status = 'dead_letter') AS dead_letter_count,
        GREATEST(0, COALESCE(EXTRACT(EPOCH FROM (now() - MIN(scheduled_at) FILTER (
          WHERE status IN ('queued', 'retry_scheduled')
        ))), 0)) AS oldest_queue_age_seconds
      FROM execution.workflow_tasks
    `,
    ),
    pgOne<Row>(
      pool,
      `
      SELECT
        COUNT(*) FILTER (WHERE status = 'active' AND heartbeat_at >= now() - interval '30 seconds') AS healthy_count,
        COUNT(*) FILTER (WHERE status = 'active' AND heartbeat_at < now() - interval '30 seconds') AS stale_count,
        COUNT(*) FILTER (WHERE status = 'draining') AS draining_count,
        COUNT(*) FILTER (WHERE status = 'stopped') AS stopped_count,
        COALESCE(EXTRACT(EPOCH FROM (now() - MIN(heartbeat_at) FILTER (
          WHERE status = 'active'
        ))), 0) AS stalest_heartbeat_seconds
      FROM runtime.worker_runtime_state
    `,
    ),
  ]);
  return {
    queueDepth: {
      queued: Number(queue?.queued_count ?? 0),
      retry_scheduled: Number(queue?.retry_count ?? 0),
      running: Number(queue?.running_count ?? 0),
      dead_letter: Number(queue?.dead_letter_count ?? 0),
    },
    oldestQueueAgeSeconds: Number(queue?.oldest_queue_age_seconds ?? 0),
    workers: {
      healthy: Number(workers?.healthy_count ?? 0),
      stale: Number(workers?.stale_count ?? 0),
      draining: Number(workers?.draining_count ?? 0),
      stopped: Number(workers?.stopped_count ?? 0),
    },
    stalestWorkerHeartbeatSeconds: Number(
      workers?.stalest_heartbeat_seconds ?? 0,
    ),
  };
}

export async function startWorkflowRunPg(
  pool: PgPool,
  workflowTemplateId: string,
  runtimeInput: Record<string, unknown> = {},
) {
  return withPostgresTransaction(pool, async (client) => {
    const template = await pgOne<Row>(
      client,
      "SELECT organization_id FROM workflow.templates WHERE id=$1",
      [workflowTemplateId],
    );
    if (!template) throw new Error("Workflow template not found.");
    const tree = await captureWorkflowTreePg(client, {
      admission: true,
      organizationId: String(template.organization_id),
      workflowTemplateId,
    });
    return enqueueFrozenWorkflowRunPg(client, {
      definition: tree.root,
      definitions: tree.definitions,
      runtimeInput,
      trigger: "api",
      executionContext: {
        organizationId: tree.root.organizationId,
        projectId: tree.root.projectId,
        trigger: "api",
      },
    });
  });
}

async function enqueueRunCommandPg(
  client: PgClient,
  workflowRunId: string,
  timestamp: string,
) {
  await client.query(
    `
    INSERT INTO execution.command_outbox (
      id, command_type, aggregate_type, aggregate_id, transport,
      payload_json, state, available_at, created_at, updated_at
    )
    VALUES ($1, 'workflow_run.queued', 'workflow_run', $2, 'postgres',
      $3::jsonb, 'pending', $4, $4, $4)
    ON CONFLICT (command_type, aggregate_id) DO NOTHING
    `,
    [pgId("cmd"), workflowRunId, JSON.stringify({ workflowRunId }), timestamp],
  );
}

export async function orchestratePg(
  pool: PgPool,
  options: OrchestratorOptions,
) {
  await renewWorkflowRunAuthoritiesPg(pool, orchestrationOwnerId);
  await reconcileExecutorAssignmentsPg(pool);
  await recoverExpiredTaskLeasesPg(pool, options);
  await expirePendingTaskAdmissionsPg(pool, options.batchSize);
  await requestTimedOutScheduledRunCancellationsPg(pool, options);
  await enqueueDueDateTriggersPg(pool, options);
  await enqueueDueScheduleTriggersPg(pool, options);
  await activateQueuedRunsPg(pool, options);
  // Committed work must not wait behind another batch of workflow advancement.
  await publishPendingTaskCommandsPg(pool, options);
  const rows = await pgMany<Row>(
    pool,
    `
    SELECT *
    FROM execution.workflow_runs
    WHERE status IN ('running', 'cancel_requested')
    ORDER BY COALESCE(queued_at, created_at) ASC
    LIMIT $1
    `,
    [options.batchSize],
  );
  await dispatchBatch(rows, async (row) => {
    let requests: TaskPublishRequest[];
    try {
      if (row.status === "running")
        await (options.authorizeExecution ?? authorizeWorkflowExecutionPg)(
          pool,
          { workflowRunId: String(row.id), phase: "dispatch" },
        );
      requests = await withPostgresTransaction(pool, (client) =>
        orchestrateRunPg(client, row, options),
      );
    } catch (error) {
      if (error instanceof WorkflowTaskAdmissionDeferred) {
        options.logger.info(
          { workflowRunId: row.id },
          "Workflow task admission full; producer deferred",
        );
        return;
      }
      if (error instanceof WorkflowAuthorityUnavailableError) {
        options.logger.warn(
          {
            workflowRunId: row.id,
            code: error.code,
            transportCode: error.transportCode,
          },
          "Execution authority unavailable; dispatch deferred",
        );
        return;
      }
      if (
        workflowGraphVersionFromSnapshot(row.template_snapshot_json) ===
          "workflow-graph/v3" &&
        (error instanceof WorkflowContractError ||
          error instanceof WorkflowGraphV3ValidationError)
      ) {
        await withPostgresTransaction(pool, (client) =>
          requestWorkflowCancellationPg(
            client,
            String(row.id),
            String(row.organization_id),
            error.message,
          ),
        );
        options.logger.warn(
          { workflowRunId: row.id, error },
          "Invalid V3 plan; cancellation requested",
        );
        return;
      }
      if (!(error instanceof WorkflowAuthorizationError)) throw error;
      await withPostgresTransaction(pool, (client) =>
        requestWorkflowCancellationPg(
          client,
          String(row.id),
          String(row.organization_id),
          `${error.code}: ${error.message}`,
        ),
      );
      options.logger.warn(
        { workflowRunId: row.id, code: error.code },
        "Execution authorization denied; cancellation requested",
      );
      return;
    }
    for (const request of requests) {
      options.telemetry?.add("beam_workflow_tasks_queued_total", 1, {
        task_kind: request.taskKind ?? "unknown",
        action_source: actionSourceLabel(request.actionPackageName),
        placement: placementLabel(request.placement),
      });
      options.telemetry?.add("beam_workflow_placements_total", 1, {
        placement: placementLabel(request.placement),
        outcome: "selected",
      });
    }
  });
  await ensureTaskWakeupsPg(pool, options);
  await publishPendingTaskCommandsPg(pool, options);
}

async function requestTimedOutScheduledRunCancellationsPg(
  pool: PgPool,
  options: OrchestratorOptions,
) {
  const timestamp = now();
  const workflowResult = await pool.query(
    `
    UPDATE execution.workflow_runs
    SET status = 'cancel_requested',
        error = COALESCE(error, 'schedule max run duration exceeded'),
        updated_at = $1
    WHERE status = 'running'
      AND trigger = 'schedule'
      AND started_at IS NOT NULL
      AND jsonb_typeof(trigger_event_json->'maxRunDurationSeconds') = 'number'
      AND started_at
        + make_interval(
            secs => (trigger_event_json->>'maxRunDurationSeconds')::integer
          ) <= $1::timestamptz
    `,
    [timestamp],
  );
  const cancelledCount = Number(workflowResult.rowCount ?? 0);
  if (cancelledCount) {
    options.logger.warn(
      { count: cancelledCount },
      "Requested cancellation for timed-out scheduled runs",
    );
  }
}

export function completionTriggerMatches(
  config: Record<string, unknown>,
  input: {
    sourceId: string;
    sourceKind: "workflow";
    status: "completed" | "failed";
  },
) {
  return (
    String(config.sourceKind) === input.sourceKind &&
    String(config.sourceId) === input.sourceId &&
    arrayValue(config.statuses).map(String).includes(input.status)
  );
}

export function extendCompletionLineage(
  lineage: string[],
  workflowTemplateId: string,
) {
  const target = `workflow:${workflowTemplateId}`;
  return lineage.includes(target) ? null : [...new Set([...lineage, target])];
}

export function isSerializedScheduleRun(row: {
  trigger?: unknown;
  trigger_event_json?: unknown;
  triggerEvent?: unknown;
}) {
  const event = objectValue(row.trigger_event_json ?? row.triggerEvent);
  return (
    String(row.trigger ?? "") === "schedule" &&
    event.overlapPolicy === "queue_new"
  );
}

async function enqueueDueScheduleTriggersPg(
  pool: PgPool,
  options: OrchestratorOptions,
) {
  const timestamp = now();
  await withPostgresTransaction(pool, async (client) => {
    const triggers = await pgMany<Row>(
      client,
      `
      SELECT t.*, w.organization_id, w.enabled AS workflow_enabled
      FROM workflow.triggers t
      INNER JOIN workflow.templates w ON w.id = t.workflow_template_id
      WHERE t.type = 'schedule'
        AND t.enabled = true
        AND w.enabled = true
        AND ${workflowHasBillingKeySql("w")}
        AND t.config_json->>'nextRunAt' IS NOT NULL
        AND t.config_json->>'nextRunAt' <> ''
        AND (t.config_json->>'nextRunAt')::timestamptz <= $1::timestamptz
      ORDER BY (t.config_json->>'nextRunAt')::timestamptz ASC, t.created_at ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED
      `,
      [timestamp, options.batchSize],
    );

    for (const trigger of triggers) {
      await enqueueDueScheduleTriggerPg(client, trigger, timestamp);
    }
  });
}

async function enqueueDueDateTriggersPg(
  pool: PgPool,
  options: OrchestratorOptions,
) {
  const timestamp = now();
  await withPostgresTransaction(pool, async (client) => {
    const triggers = await pgMany<Row>(
      client,
      `
      SELECT t.*, w.organization_id
      FROM workflow.triggers t
      INNER JOIN workflow.templates w ON w.id = t.workflow_template_id
      WHERE t.type = 'date'
        AND t.enabled = true
        AND w.enabled = true
        AND ${workflowHasBillingKeySql("w")}
        AND t.config_json->>'runAt' IS NOT NULL
        AND t.config_json->>'runAt' <> ''
        AND (t.config_json->>'runAt')::timestamptz <= $1::timestamptz
      ORDER BY (t.config_json->>'runAt')::timestamptz ASC, t.created_at ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED
      `,
      [timestamp, options.batchSize],
    );

    for (const trigger of triggers) {
      const workflowTemplateId = String(trigger.workflow_template_id);
      const triggerId = String(trigger.id);
      const config = objectValue(trigger.config_json);
      const state = objectValue(trigger.state_json);
      const runAt = String(config.runAt ?? timestamp);
      const triggerEvent = {
        runAt,
        triggeredAt: timestamp,
        triggerId,
        type: "date",
      };
      const workflowRunId = await queueTriggeredWorkflowRunPg(client, {
        workflowTemplateId,
        organizationId: String(trigger.organization_id),
        triggerId,
        triggerType: "date",
        triggerEvent,
        runtimeInput: { _trigger: triggerEvent },
        timestamp,
      });
      await client.query(
        `
        UPDATE workflow.triggers
        SET enabled = false,
            state_json = $2::jsonb,
            updated_at = $3
        WHERE id = $1
        `,
        [
          triggerId,
          JSON.stringify({
            ...state,
            firedAt: timestamp,
            status: "completed",
            workflowRunId,
          }),
          timestamp,
        ],
      );
      await appendWorkflowEventPg(client, {
        organizationId: String(trigger.organization_id),
        workflowTemplateId,
        workflowRunId,
        eventType: "WorkflowDateTriggerFired",
        payload: triggerEvent,
      });
    }
  });
}

async function enqueueDueScheduleTriggerPg(
  client: PgClient,
  trigger: Row,
  timestamp: string,
) {
  const workflowTemplateId = String(trigger.workflow_template_id);
  const triggerId = String(trigger.id);
  const config = normalizeScheduleRuntimeConfig(trigger.config_json);
  const rawState = objectValue(trigger.state_json);
  const state = normalizeScheduleRuntimeState(rawState);

  const activeRuns = await pgMany<Row>(
    client,
    `
    SELECT id, status
    FROM execution.workflow_runs
    WHERE workflow_template_id = $1
      AND trigger_id = $2
      AND status IN ('queued', 'running', 'cancel_requested')
    ORDER BY created_at ASC
    `,
    [workflowTemplateId, triggerId],
  );
  const decision = evaluateScheduleOccurrence({
    activeRunCount: activeRuns.length,
    config,
    state,
    timestamp,
  });

  if (decision.kind === "disable") {
    await disableScheduleTriggerPg(
      client,
      trigger,
      config,
      rawState,
      decision.reason,
      timestamp,
    );
    return;
  }

  const scheduledAt = config.nextRunAt;
  if (!scheduledAt) {
    return;
  }

  if (decision.kind === "skip") {
    await updateWorkflowTriggerSchedulePg(client, trigger, {
      config: { ...config, nextRunAt: decision.nextRunAt },
      state: {
        ...rawState,
        ...decision.state,
        lastEvent: {
          skipped: true,
          reason: decision.reason,
          scheduledAt,
        },
        lastEvaluatedAt: timestamp,
        status: scheduleTriggerStatus(
          decision.nextRunAt,
          decision.terminalReason,
        ),
      },
      enabled: Boolean(decision.nextRunAt),
      timestamp,
    });
    await appendWorkflowEventPg(client, {
      organizationId: String(trigger.organization_id),
      workflowTemplateId,
      eventType: "WorkflowTriggerSkipped",
      payload: {
        triggerId,
        triggerType: "schedule",
        scheduledAt,
        reason: decision.reason,
      },
    });
    return;
  }

  if (decision.cancelActive) {
    await client.query(
      `
      UPDATE execution.workflow_runs
      SET status = 'cancel_requested',
          error = COALESCE(error, 'cancelled by schedule overlap'),
          updated_at = $3
      WHERE workflow_template_id = $1
        AND trigger_id = $2
        AND status IN ('queued', 'running')
      `,
      [workflowTemplateId, triggerId, timestamp],
    );
  }

  const triggerEvent = scheduleRunEvent(
    config,
    scheduledAt,
    timestamp,
    decision.nextRunAt,
  );
  let workflowRunId:string;
  try {
  workflowRunId = await queueTriggeredWorkflowRunPg(client, {
    workflowTemplateId,
    organizationId: String(trigger.organization_id),
    triggerId,
    triggerType: "schedule",
    triggerEvent,
    runtimeInput: {
      trigger: {
        type: "schedule",
        triggerId,
        scheduledAt,
      },
    },
    timestamp,
  });

  } catch (error) {
    const deferral = deferredScheduleReason(error);
    if (!deferral) throw error;
    await appendWorkflowEventPg(client,{organizationId:String(trigger.organization_id),workflowTemplateId,
      eventType:'WorkflowTriggerDeferred',payload:{triggerId,triggerType:'schedule',scheduledAt,reason:deferral}});
    return;
  }
  await updateScheduleTriggerAfterRunPg(client, trigger, config, rawState, {
    decisionState: decision.state,
    terminalReason: decision.terminalReason,
    workflowRunId,
    nextRunAt: decision.nextRunAt,
    timestamp,
  });
  if (scheduleBudgetAlertRaised(rawState, decision.state)) {
    await appendWorkflowEventPg(client, {
      organizationId: String(trigger.organization_id),
      workflowTemplateId,
      workflowRunId,
      eventType: "WorkflowScheduleBudgetAlert",
      payload: {
        budgetAlertThreshold: config.budgetAlertThreshold,
        creditBudgetLimit: config.creditBudgetLimit,
        creditsConsumed: decision.state.creditsConsumed,
        triggerId,
      },
    });
  }
}

async function queueTriggeredWorkflowRunPg(
  client: PgClient,
  input: {
    workflowTemplateId: string;
    organizationId: string;
    triggerId: string;
    triggerType: string;
    triggerEvent: Record<string, unknown>;
    runtimeInput: Record<string, unknown>;
    timestamp: string;
  },
) {
  const tree = await captureWorkflowTreePg(client, {
    admission: true,
    organizationId: input.organizationId,
    workflowTemplateId: input.workflowTemplateId,
  });
  return enqueueFrozenWorkflowRunPg(client, {
    definition: tree.root,
    definitions: tree.definitions,
    runtimeInput: input.runtimeInput,
    trigger: input.triggerType,
    triggerId: input.triggerId,
    triggerEvent: input.triggerEvent,
    executionContext: {
      organizationId: input.organizationId,
      projectId: tree.root.projectId,
      trigger: input.triggerType,
      triggerId: input.triggerId,
      initiatingPrincipalId:
        objectValue(tree.root.snapshot.workflowTemplate).createdByUserId ??
        null,
    },
  });
}

async function enqueueCompletionTriggersPg(
  client: PgClient,
  input: {
    error?: string | null;
    lineage: string[];
    organizationId: string;
    output?: unknown;
    sourceId: string;
    sourceKind: "workflow";
    sourceRunId: string;
    status: "completed" | "failed";
    timestamp: string;
  },
) {
  const triggers = await pgMany<Row>(
    client,
    `
    SELECT t.*, w.organization_id
    FROM workflow.triggers t
    INNER JOIN workflow.templates w ON w.id = t.workflow_template_id
    WHERE t.type = 'completion'
      AND t.enabled = true
      AND w.enabled = true
      AND ${workflowHasBillingKeySql("w")}
      AND w.organization_id = $1
      AND t.config_json->>'sourceKind' = $2
      AND t.config_json->>'sourceId' = $3
    ORDER BY t.created_at ASC
    FOR UPDATE
    `,
    [input.organizationId, input.sourceKind, input.sourceId],
  );

  for (const trigger of triggers) {
    const config = objectValue(trigger.config_json);
    if (
      !completionTriggerMatches(config, {
        sourceId: input.sourceId,
        sourceKind: input.sourceKind,
        status: input.status,
      })
    ) {
      continue;
    }
    const workflowTemplateId = String(trigger.workflow_template_id);
    const lineage = extendCompletionLineage(input.lineage, workflowTemplateId);
    if (!lineage) {
      await appendWorkflowEventPg(client, {
        organizationId: input.organizationId,
        workflowTemplateId,
        eventType: "WorkflowCompletionTriggerSkipped",
        payload: {
          reason: "cycle_detected",
          sourceRunId: input.sourceRunId,
          triggerId: String(trigger.id),
        },
      });
      continue;
    }
    const existing = await pgOne<Row>(
      client,
      `
      SELECT id
      FROM execution.workflow_runs
      WHERE trigger_id = $1
        AND trigger_event_json->>'sourceRunId' = $2
      LIMIT 1
      `,
      [String(trigger.id), input.sourceRunId],
    );
    if (existing) {
      continue;
    }

    const source = {
      error: input.error ?? null,
      id: input.sourceId,
      kind: input.sourceKind,
      output: objectValue(input.output),
      runId: input.sourceRunId,
      status: input.status,
    };
    const triggerEvent = {
      lineage,
      sourceId: input.sourceId,
      sourceKind: input.sourceKind,
      sourceRunId: input.sourceRunId,
      status: input.status,
      triggerId: String(trigger.id),
      type: "completion",
    };
    await queueTriggeredWorkflowRunPg(client, {
      workflowTemplateId,
      organizationId: input.organizationId,
      triggerId: String(trigger.id),
      triggerType: "completion",
      triggerEvent,
      runtimeInput: {
        _trigger: triggerEvent,
        source,
      },
      timestamp: input.timestamp,
    });
  }
}

async function updateScheduleTriggerAfterRunPg(
  client: PgClient,
  trigger: Row,
  config: ScheduleRuntimeConfig,
  state: Row,
  input: {
    decisionState: ScheduleRuntimeState;
    terminalReason: string | null;
    workflowRunId: string;
    nextRunAt: string | null;
    timestamp: string;
  },
) {
  await updateWorkflowTriggerSchedulePg(client, trigger, {
    config: { ...config, nextRunAt: input.nextRunAt },
    state: {
      ...state,
      ...input.decisionState,
      ...scheduleBudgetAlertPatch(state, input.decisionState, input.timestamp),
      lastEvaluatedAt: input.timestamp,
      lastRunAt: input.timestamp,
      lastWorkflowRunId: input.workflowRunId,
      status: scheduleTriggerStatus(input.nextRunAt, input.terminalReason),
    },
    enabled: Boolean(input.nextRunAt),
    timestamp: input.timestamp,
  });
}

async function disableScheduleTriggerPg(
  client: PgClient,
  trigger: Row,
  config: ScheduleRuntimeConfig,
  state: Row,
  status: string,
  timestamp: string,
) {
  await updateWorkflowTriggerSchedulePg(client, trigger, {
    config: { ...config, nextRunAt: null },
    state: { ...state, lastEvaluatedAt: timestamp, status },
    enabled: false,
    timestamp,
  });
}

async function updateWorkflowTriggerSchedulePg(
  client: PgClient,
  trigger: Row,
  input: {
    config: Record<string, unknown>;
    state: Record<string, unknown>;
    enabled: boolean;
    timestamp: string;
  },
) {
  await client.query(
    `
    UPDATE workflow.triggers
    SET config_json = $2::jsonb,
        state_json = $3::jsonb,
        enabled = $4,
        updated_at = $5
    WHERE id = $1
    `,
    [
      String(trigger.id),
      JSON.stringify(input.config),
      JSON.stringify(input.state),
      input.enabled,
      input.timestamp,
    ],
  );
}

function scheduleRunEvent(
  config: ScheduleRuntimeConfig,
  scheduledAt: string,
  firedAt: string,
  nextRunAt: string | null,
) {
  return {
    scheduledAt,
    firedAt,
    nextRunAt,
    overlapPolicy: config.overlapPolicy,
    maxRunDurationSeconds: config.maxRunDurationSeconds,
    estimatedCreditCost: config.estimatedCreditCost,
  };
}

function scheduleBudgetAlertPatch(
  previousState: Row,
  nextState: ScheduleRuntimeState,
  timestamp: string,
) {
  return scheduleBudgetAlertRaised(previousState, nextState)
    ? { budgetAlertedAt: timestamp }
    : {};
}

function scheduleBudgetAlertRaised(
  previousState: Row,
  nextState: ScheduleRuntimeState,
) {
  return (
    previousState.alertState !== "budget_threshold_reached" &&
    nextState.alertState === "budget_threshold_reached"
  );
}

async function activateQueuedRunsPg(
  pool: PgPool,
  options: OrchestratorOptions,
) {
  const timestamp = now();
  const rows = await pgMany<Row>(
    pool,
    `
    UPDATE execution.workflow_runs
    SET status = 'running',
        started_at = COALESCE(started_at, $1),
        updated_at = $1,
        error = NULL
    WHERE id IN (
      SELECT candidate.id
      FROM execution.workflow_runs candidate
      WHERE candidate.status = 'queued'
        AND COALESCE(candidate.queued_at, candidate.created_at) <= $1
        AND (
          candidate.trigger <> 'schedule'
          OR COALESCE(
            candidate.trigger_event_json->>'overlapPolicy',
            'skip_new'
          ) <> 'queue_new'
          OR NOT EXISTS (
            SELECT 1
            FROM execution.workflow_runs predecessor
            WHERE predecessor.trigger_id = candidate.trigger_id
              AND predecessor.id <> candidate.id
              AND (
                predecessor.status IN ('running', 'cancel_requested')
                OR (
                  predecessor.status = 'queued'
                  AND (
                    COALESCE(predecessor.queued_at, predecessor.created_at),
                    predecessor.id
                  ) < (
                    COALESCE(candidate.queued_at, candidate.created_at),
                    candidate.id
                  )
                )
              )
          )
        )
      ORDER BY COALESCE(candidate.queued_at, candidate.created_at) ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, organization_id, workflow_template_id, trigger,
      metadata_json, queued_at, started_at
    `,
    [timestamp, options.batchSize],
  );
  for (const row of rows) {
    const context = traceContextFromMetadata(row.metadata_json, String(row.id));
    const span = options.telemetry?.startSpan("workflow.run.start", {
      parent: context,
      correlationId: String(row.id),
      attributes: {
        "workflow.run_id": String(row.id),
        "workflow.trigger": String(row.trigger ?? "unknown"),
      },
    });
    await appendWorkflowEventPg(pool, {
      organizationId: String(row.organization_id),
      workflowTemplateId: String(row.workflow_template_id),
      workflowRunId: String(row.id),
      eventType: "WorkflowRunStarted",
      payload: {},
    });
    options.telemetry?.add("beam_workflow_runs_total", 1, {
      service: "orchestrator",
      trigger: String(row.trigger ?? "unknown"),
      status: "running",
    });
    span?.end();
  }
  if (rows.length) {
    await pool.query(
      `
      UPDATE execution.command_outbox
      SET state = 'published', published_at = COALESCE(published_at, $2),
          last_error = NULL, claimed_by = NULL, claim_expires_at = NULL,
          updated_at = $2
      WHERE command_type = 'workflow_run.queued'
        AND aggregate_id = ANY($1::text[])
        AND state <> 'published'
      `,
      [rows.map((row) => String(row.id)), timestamp],
    );
  }

  await pool.query(
    `
    UPDATE execution.command_outbox outbox
    SET state = CASE
          WHEN run.status IN ('cancel_requested', 'cancelled') THEN 'cancelled'
          ELSE 'published'
        END,
        published_at = CASE
          WHEN run.status IN ('cancel_requested', 'cancelled')
            THEN outbox.published_at
          ELSE COALESCE(outbox.published_at, $1)
        END,
        last_error = CASE
          WHEN run.status IN ('cancel_requested', 'cancelled')
            THEN 'workflow cancellation requested'
          ELSE NULL
        END,
        claimed_by = NULL, claim_expires_at = NULL,
        updated_at = $1
    FROM execution.workflow_runs run
    WHERE outbox.command_type = 'workflow_run.queued'
      AND outbox.aggregate_id = run.id
      AND outbox.state <> 'published'
      AND run.status <> 'queued'
    `,
    [timestamp],
  );
}

async function orchestrateRunPg(
  client: PgClient,
  row: Row,
  options: OrchestratorOptions,
): Promise<TaskPublishRequest[]> {
  const lockedRow = await pgOne<Row>(
    client,
    `SELECT * FROM execution.workflow_runs WHERE id = $1 FOR UPDATE`,
    [String(row.id)],
  );
  if (!lockedRow) return [];
  row = lockedRow;
  const publishRequests: TaskPublishRequest[] = [];
  const workflowRunId = String(row.id);
  const templateSnapshot = objectValue(row.template_snapshot_json);
  if (!["running", "cancel_requested"].includes(String(row.status))) return [];
  const authority = await acquireWorkflowRunAuthorityPg(
    client,
    workflowRunId,
    orchestrationOwnerId,
  );
  if (!authority) return [];
  if (authority.takenOver)
    options.logger.info(
      { workflowRunId, generation: authority.generation },
      "Workflow authority recovered; prior attempts require reconciliation",
    );
  await reconcileWorkflowCallsPg(
    client,
    workflowRunId,
    arrayValue(row.resolved_steps_json).map((step, index) =>
      workflowStepFromSnapshot(objectValue(step), index),
    ),
    options.authorizeExecution,
  );
  if (String(row.status) === "cancel_requested") {
    const controls = workflowControlsFromSnapshot(templateSnapshot);
    const ownedStepIds = new Set(
      controls.flatMap((control) => control.body.stepIds),
    );
    const steps = arrayValue(row.resolved_steps_json)
      .filter((step): step is Row => Boolean(step && typeof step === "object"))
      .map((step, index) => workflowStepFromSnapshot(step, index))
      .filter((step) => step.enabled && !ownedStepIds.has(step.id));
    await cancelActiveTasksAndStepsPg(
      client,
      workflowRunId,
      String(row.organization_id),
      steps,
    );
    if (!(await hasActiveTasksPg(client, workflowRunId))) {
      await client.query(
        "UPDATE execution.workflow_dynamic_regions SET status='cancelled',completed_at=COALESCE(completed_at,now()),updated_at=now() WHERE workflow_run_id=$1 AND status='cancel_requested'",
        [workflowRunId],
      );
      await finishRunPg(
        client,
        workflowRunId,
        "cancelled",
        row.error == null ? "cancellation requested" : String(row.error),
        options.telemetry,
      );
    }
    return publishRequests;
  }

  const runtimeInputs = objectValue(row.input_json) as Record<
    string,
    ActionJson
  >;
  const steps = arrayValue(row.resolved_steps_json)
    .filter((step): step is Row => Boolean(step && typeof step === "object"))
    .map((step, index) => workflowStepFromSnapshot(step, index))
    .filter((step) => step.enabled);
  const graphVersion = workflowGraphVersionFromSnapshot(templateSnapshot);
  const controls = workflowControlsFromSnapshot(templateSnapshot);
  if (graphVersion === "workflow-graph/v3")
    return orchestrateV3RunPg(client, row, steps, options);
  await advanceDistributedStepsPg(client, row, steps, options);
  if (graphVersion === "workflow-graph/v2") {
    const organizationId = String(row.organization_id);
    const edges = workflowEdgesFromSnapshot(templateSnapshot);
    return orchestrateDynamicGraphPg({
      client,
      controls,
      decisions: workflowDecisionsFromSnapshot(templateSnapshot.decisions),
      decisionEdges: workflowDecisionEdgesFromSnapshot(
        templateSnapshot.decisionEdges,
      ),
      edges,
      options,
      organizationId,
      runtimeInputs,
      steps,
      templateSnapshot: templateSnapshot as Record<string, ActionJson>,
      workflowRunId,
      callbacks: {
        createStepTask: ({ dynamicInstanceId, inputs, step }) =>
          createStepRunAndTaskPg(
            client,
            workflowRunId,
            organizationId,
            step,
            inputs,
            options.maxAttempts,
            options,
            dynamicInstanceId ?? null,
          ),
        createTerminalStep: ({ dynamicInstanceId, reason, status, step }) =>
          createTerminalStepRunPg(
            client,
            workflowRunId,
            step,
            organizationId,
            status,
            reason,
            dynamicInstanceId ?? null,
          ),
        finishRun: (status, error) =>
          finishRunPg(client, workflowRunId, status, error, options.telemetry),
        hasActiveTasks: () => hasActiveTasksPg(client, workflowRunId),
        cancelActiveWork: (preserved) =>
          cancelActiveTasksAndStepsPg(
            client,
            workflowRunId,
            organizationId,
            steps.filter(
              (step) =>
                !controls.some((control) =>
                  control.body.stepIds.includes(step.id),
                ),
            ),
            preserved,
          ),
        appendEvent: ({ eventType, payload }) =>
          appendWorkflowEventPg(client, {
            organizationId,
            workflowRunId,
            eventType,
            payload,
          }),
      },
    });
  }
  const stepRuns = await pgMany<Row>(
    client,
    "SELECT * FROM execution.workflow_step_runs WHERE workflow_run_id = $1",
    [workflowRunId],
  );
  const stepRunsByStepId = new Map(
    stepRuns.map((stepRun) => [String(stepRun.workflow_step_id), stepRun]),
  );

  if (
    await finishIfTerminalPg(
      client,
      workflowRunId,
      steps,
      stepRunsByStepId,
      options,
    )
  ) {
    return publishRequests;
  }

  const edges = workflowEdgesFromSnapshot(templateSnapshot);
  const outputsByStep = workflowOutputsByStep(stepRuns);
  const artifactsByStep = new Map<string, ActionResult["artifacts"]>(
    steps.map((step) => [step.id, []]),
  );
  for (const step of steps) {
    if (stepRunsByStepId.has(step.id)) {
      continue;
    }
    const incoming = edges.filter((edge) => edge.to === step.id);
    if (!incoming.every((edge) => isSettled(stepRunsByStepId.get(edge.from)))) {
      continue;
    }
    // Evaluated per edge rather than with some(), so every branch decision is
    // recorded. The predicate is unchanged: on this path only a skipped
    // upstream blocks an edge, which is narrower than the dynamic path's rule
    // and must stay that way for graphs already running.
    let taken = false;
    for (const edge of incoming) {
      const upstreamStatus = String(
        stepRunsByStepId.get(edge.from)?.status ?? "not_reached",
      );
      const blocked = upstreamStatus === "skipped";
      const result = blocked
        ? undefined
        : evaluateEdgeCondition(
            edge.condition,
            runtimeInputs,
            templateSnapshot as Record<string, ActionJson>,
            outputsByStep,
            artifactsByStep,
          );
      taken ||= Boolean(result);
      await persistConditionTrace(client, {
        workflowRunId,
        scopeKey: "root",
        edge,
        trace: conditionTraceForEvaluation({
          conditionPresent:
            edge.condition !== undefined && edge.condition !== null,
          result,
          // Report what actually blocked here, not the dynamic path's rules.
          upstreamStatus: blocked ? "skipped" : undefined,
        }),
      });
    }
    const shouldRun = incoming.length === 0 || taken;
    if (!shouldRun) {
      await createSkippedStepRunPg(
        client,
        workflowRunId,
        step,
        String(row.organization_id),
      );
      continue;
    }
    const missingArtifact = failedRequiredArtifactSource(
      step,
      stepRunsByStepId,
    );
    if (missingArtifact) {
      await createTerminalStepRunPg(
        client,
        workflowRunId,
        step,
        String(row.organization_id),
        "not_reached",
        `required_artifact_source_unavailable:${missingArtifact}`,
      );
      continue;
    }
    try {
      const request = await createStepRunAndTaskPg(
        client,
        workflowRunId,
        String(row.organization_id),
        step,
        (step.kind === "workflow"
          ? resolveWorkflowCallBindings
          : resolveInputBindings)(
          step.inputBindings,
          runtimeInputs,
          templateSnapshot as Record<string, ActionJson>,
          outputsByStep,
          artifactsByStep,
          { stepsById: workflowStepMetadata(stepRuns, steps) },
        ),
        options.maxAttempts,
        options,
      );
      if (request) publishRequests.push(request);
    } catch (error) {
      if (!(error instanceof WorkflowContractError)) throw error;
      await createTerminalStepRunPg(
        client,
        workflowRunId,
        step,
        String(row.organization_id),
        "failed",
        error.message,
      );
    }
  }
  return publishRequests;
}

/** V3 freezes the private controller's authorized cohort exactly once. A
 * resumed run recomputes its routes from that cohort and its graph snapshot. */
async function frozenV3GraphPg(
  client: PgClient,
  row: Row,
  steps: ApiWorkflowStep[],
  options: OrchestratorOptions,
) {
  const snapshot = objectValue(row.template_snapshot_json);
  const graph: WorkflowGraphV3Definition = {
    version: "workflow-graph/v3",
    controls: workflowControlsFromSnapshot(snapshot),
    edges: workflowEdgesFromSnapshot(
      snapshot,
    ) as WorkflowGraphV3Definition["edges"],
    distribution:
      snapshot.distribution as WorkflowGraphV3Definition["distribution"],
  };
  const metadata = objectValue(row.metadata_json);
  let membersByPartition = objectValue(
    objectValue(metadata.v3RoomResolution).membersByPartition,
  ) as Record<string, DistributedMember[]>;
  if (!Object.keys(membersByPartition).length) {
    const request = {
      workflowRunId: String(row.id),
      organizationId: String(row.organization_id),
      graph,
      steps,
    };
    const resolved = options.resolveFrozenV3Room
      ? await options.resolveFrozenV3Room(request)
      : await resolveFrozenV3RoomPg(client, String(row.id));
    membersByPartition = resolved.membersByPartition;
  }
  const aggregationActions = Object.fromEntries(
    steps
      .filter(
        (step) => step.manifestSnapshot?.apiVersion === "workflow-actions/v2",
      )
      .map((step) => [step.id, step.manifestSnapshot as ActionManifestV2]),
  );
  const resolved = resolveWorkflowGraphV3(
    graph,
    steps.map((step) => ({ id: step.id, enabled: step.enabled })),
    membersByPartition,
    aggregationActions,
    String(row.id),
  );
  if (!Object.keys(objectValue(metadata.v3RoomResolution)).length)
    await client.query(
      `UPDATE execution.workflow_runs
       SET metadata_json=metadata_json||jsonb_build_object('v3RoomResolution',$2::jsonb),updated_at=now()
       WHERE id=$1`,
      [row.id, JSON.stringify({ membersByPartition })],
    );
  return { graph, resolved };
}

async function advanceV3StepRunsPg(client: PgClient, workflowRunId: string) {
  const plans = await pgMany<Row>(
    client,
    `SELECT p.id,p.mode,p.shard_count,p.workflow_step_run_id,s.status
     FROM execution.execution_plans p
     JOIN execution.workflow_step_runs s ON s.id=p.workflow_step_run_id
     WHERE p.workflow_run_id=$1 AND p.mode IN ('per-member','partition-map','v3-aggregation')
       AND s.status IN ('queued','running')`,
    [workflowRunId],
  );
  for (const plan of plans) {
    const tasks = await pgMany<Row>(
      client,
      `SELECT status,output_json,shard_index,error FROM execution.workflow_tasks
       WHERE workflow_step_run_id=$1 ORDER BY shard_index,id`,
      [plan.workflow_step_run_id],
    );
    // A failed partition cancels its queued siblings, so the failed task, not
    // a cancelled one, carries the action's failure text (such as a Beam
    // transfer's error message); the step and run report it verbatim.
    const failed =
      tasks.find((task) =>
        ["failed", "dead_letter"].includes(String(task.status)),
      ) ?? tasks.find((task) => String(task.status) === "cancelled");
    if (failed) {
      await client.query(
        `UPDATE execution.workflow_step_runs SET status='failed',error=$2,
           completed_at=now(),updated_at=now()
         WHERE id=$1 AND status IN ('queued','running')`,
        [
          plan.workflow_step_run_id,
          failed.error ? String(failed.error) : `V3 ${plan.mode} task failed.`,
        ],
      );
      continue;
    }
    if (
      tasks.length !== Number(plan.shard_count) ||
      tasks.some((task) => task.status !== "completed")
    )
      continue;
    const output =
      tasks.length === 1
        ? objectValue(tasks[0]!.output_json)
        : { members: tasks.map((task) => objectValue(task.output_json)) };
    await client.query(
      `UPDATE execution.workflow_step_runs
       SET status='completed',output_json=$2::jsonb,completed_at=now(),updated_at=now()
       WHERE id=$1 AND status IN ('queued','running')`,
      [plan.workflow_step_run_id, JSON.stringify(output)],
    );
  }
}

async function orchestrateV3RunPg(
  client: PgClient,
  row: Row,
  steps: ApiWorkflowStep[],
  options: OrchestratorOptions,
): Promise<TaskPublishRequest[]> {
  const runId = String(row.id);
  const organizationId = String(row.organization_id);
  const { graph, resolved } = await frozenV3GraphPg(
    client,
    row,
    steps,
    options,
  );
  const loop = graph.controls[0] as WorkflowGraphV3LoopControl | undefined;
  if (arrayValue(objectValue(row.template_snapshot_json).decisions).length)
    throw new WorkflowContractError(
      "Distributed V3 decisions are unsupported.",
    );
  await advanceV3StepRunsPg(client, runId);
  const stepRuns = await pgMany<Row>(
    client,
    "SELECT * FROM execution.workflow_step_runs WHERE workflow_run_id=$1",
    [runId],
  );
  const byStep = new Map(
    stepRuns
      .filter((item) => item.dynamic_instance_id == null)
      .map((item) => [String(item.workflow_step_id), item]),
  );
  if (
    !loop &&
    (await finishIfTerminalPg(client, runId, steps, byStep, options))
  )
    return [];
  const outputs = workflowOutputsByStep(stepRuns);
  const artifacts = new Map<string, ActionResult["artifacts"]>(
    steps.map((step) => [step.id, []]),
  );
  const runtimeInputs = objectValue(row.input_json) as Record<
    string,
    ActionJson
  >;
  const snapshot = objectValue(row.template_snapshot_json) as Record<
    string,
    ActionJson
  >;
  for (const distributed of graph.distribution.steps) {
    if (loop?.body.stepIds.includes(distributed.stepId)) continue;
    const step = steps.find((item) => item.id === distributed.stepId);
    if (!step)
      throw new WorkflowContractError(`Missing V3 step ${distributed.stepId}.`);
    const existing = byStep.get(step.id);
    if (existing) {
      if (
        distributed.aggregation &&
        ["queued", "running"].includes(String(existing.status))
      )
        await admitV3AggregationPg(client, row, step, distributed, existing, options);
      continue;
    }
    const predecessors = new Set([
      ...graph.edges
        .filter((edge) => edge.to === step.id)
        .map((edge) => edge.from),
      ...graph.distribution.routes
        .filter((route) => route.to.stepId === step.id)
        .map((route) => route.from.stepId),
    ]);
    if ([...predecessors].some((id) => !isSettled(byStep.get(id)))) continue;
    const failed = [...predecessors].find(
      (id) => byStep.get(id)?.status !== "completed",
    );
    if (failed) {
      await createNotReachedStepRunPg(client, runId, step, organizationId);
      continue;
    }
    if (distributed.aggregation) {
      await createV3AggregationStepPg(
        client,
        row,
        step,
        steps,
        distributed,
        resolved.tasks,
        graph,
        byStep,
        options,
      );
      continue;
    }
    const inputs = (
      step.kind === "workflow"
        ? resolveWorkflowCallBindings
        : resolveInputBindings
    )(step.inputBindings, runtimeInputs, snapshot, outputs, artifacts, {
      stepsById: workflowStepMetadata(stepRuns, steps),
    });
    const routed = await frozenV3RoutedInputsPg(
      client,
      row,
      step,
      distributed,
      resolved.tasks,
      resolved.routes,
      byStep,
      options,
      inputs,
      loop
        ? {
            incoming: resolved.routes,
            outgoing: resolveWorkflowGraphV3InitialRoutes(loop, resolved.tasks),
            scopeId: `${runId}:${loop.id}:seed`,
            seed: true,
          }
        : undefined,
    );
    if (!routed) continue;
    const distribution = step.manifestSnapshot?.execution?.distribution;
    const partitioned =
      distribution?.partitionPlanVersion === "logical/v1" &&
      distribution?.mode === "partitioned-reduce";
    if (
      partitioned &&
      graph.distribution.routes.some((route) => route.to.stepId === step.id)
    )
      throw new WorkflowContractError(
        "V3 input-partition steps cannot yet consume routed inputs.",
      );
    if (partitioned) {
      const values = inputs[distribution.inputKey];
      if (!Array.isArray(values))
        throw new WorkflowContractError(
          "V3 input partitions require a collection.",
        );
      const template =
        routed.metadata[
          `member:${resolved.tasks.find((task) => task.stepId === step.id)?.memberId}`
        ];
      for (let index = 0; index < values.length; index++) {
        const logicalId = `partition:${index}`;
        routed.metadata[logicalId] = partitionedRoomTaskMetadata(
          template,
          String(row.id),
          step.id,
          logicalId,
        );
      }
    }
    await createFrozenRoomStepRunPg(client, {
      workflowRunId: runId,
      organizationId,
      step,
      inputs,
      maxAttempts: options.maxAttempts,
      options,
      resolvedTasks: resolved.tasks,
      distribution: partitioned
        ? { kind: "input-partitions", inputKey: distribution.inputKey }
        : { kind: "per-member" },
      maxParallelism:
        distribution?.maxParallelism ??
        resolved.tasks.filter((task) => task.stepId === step.id).length,
      taskInputs: routed.inputs,
      taskMetadata: routed.metadata,
      routes: loop
        ? [
            ...resolved.routes,
            ...resolveWorkflowGraphV3InitialRoutes(loop, resolved.tasks),
          ]
        : resolved.routes,
    });
  }
  if (loop)
    await orchestrateV3LoopPg(
      client,
      row,
      steps,
      graph,
      loop,
      resolved,
      byStep,
      options,
    );
  return [];
}

/** V3 loop checkpoints use the existing dynamic region/instance identity, but
 * only the accepted V3 task and artifact plans may advance an iteration. */
async function orchestrateV3LoopPg(
  client: PgClient,
  row: Row,
  steps: ApiWorkflowStep[],
  graph: WorkflowGraphV3Definition,
  loop: WorkflowGraphV3LoopControl,
  resolved: ReturnType<typeof resolveWorkflowGraphV3>,
  staticRuns: Map<string, Row>,
  options: OrchestratorOptions,
) {
  const runId = String(row.id);
  const organizationId = String(row.organization_id);
  const seedStepId = loop.initial.routes[0]!.from.stepId;
  const seedRun = staticRuns.get(seedStepId);
  if (!seedRun || seedRun.status !== "completed") {
    if (
      seedRun &&
      ["failed", "cancelled", "not_reached", "skipped"].includes(
        String(seedRun.status),
      )
    ) {
      await cancelActiveTasksAndStepsPg(client, runId, organizationId, steps);
      if (!(await hasActiveTasksPg(client, runId)))
        await finishRunPg(
          client,
          runId,
          "failed",
          "V3 loop seed failed.",
          options.telemetry,
        );
    }
    return;
  }
  const regionId = pgId("wfreg");
  const created = await client.query(
    `INSERT INTO execution.workflow_dynamic_regions (
       id,workflow_run_id,control_id,control_path,kind,status,definition_json,
       resolved_input_json,output_json,instance_count,concurrency_limit,started_at)
     VALUES($1,$2,$3,$3,'loop','running',$4::jsonb,$5::jsonb,
       '{"decisions":{},"values":[],"value":null}'::jsonb,$6,1,now())
     ON CONFLICT (workflow_run_id,control_path) DO NOTHING RETURNING id`,
    [
      regionId,
      runId,
      loop.id,
      JSON.stringify(loop),
      JSON.stringify(loop.iterations),
      Number(loop.iterations) * loop.body.stepIds.length,
    ],
  );
  const region = await pgOne<Row>(
    client,
    `SELECT * FROM execution.workflow_dynamic_regions
     WHERE workflow_run_id=$1 AND control_path=$2 FOR UPDATE`,
    [runId, loop.id],
  );
  if (!region)
    throw new WorkflowContractError("V3 loop checkpoint is missing.");
  if (region.status === "completed") {
    if (!(await hasActiveTasksPg(client, runId)))
      await finishRunPg(client, runId, "completed", null, options.telemetry);
    return;
  }
  if (region.status === "failed") {
    if (!(await hasActiveTasksPg(client, runId)))
      await finishRunPg(
        client,
        runId,
        "failed",
        String(region.error ?? "V3 loop failed."),
        options.telemetry,
      );
    return;
  }
  if (created.rows.length) {
    for (let index = 0; index < Number(loop.iterations); index++) {
      for (const stepId of loop.body.stepIds) {
        await client.query(
          `INSERT INTO execution.workflow_dynamic_instances (
           id,workflow_run_id,dynamic_region_id,workflow_step_id,control_path,instance_index)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (workflow_run_id,control_path,workflow_step_id,instance_index) DO NOTHING`,
          [pgId("wfdyn"), runId, region.id, stepId, loop.id, index],
        );
      }
    }
  }
  await client.query(
    `UPDATE execution.workflow_dynamic_instances instance
     SET status=step_run.status,input_json=step_run.input_json,
         output_json=step_run.output_json,error=step_run.error,
         completed_at=step_run.completed_at,updated_at=now()
     FROM execution.workflow_step_runs step_run
     WHERE instance.dynamic_region_id=$1 AND step_run.dynamic_instance_id=instance.id
       AND (instance.status IS DISTINCT FROM step_run.status OR
            instance.updated_at < step_run.updated_at)`,
    [region.id],
  );
  const instances = await pgMany<Row>(
    client,
    `SELECT * FROM execution.workflow_dynamic_instances
     WHERE dynamic_region_id=$1 ORDER BY instance_index,workflow_step_id`,
    [region.id],
  );
  const stepRuns = await pgMany<Row>(
    client,
    `SELECT s.*,i.instance_index FROM execution.workflow_step_runs s
     JOIN execution.workflow_dynamic_instances i ON i.id=s.dynamic_instance_id
     WHERE i.dynamic_region_id=$1`,
    [region.id],
  );
  const carryRoutes = resolveWorkflowGraphV3CarryRoutes(loop, resolved.tasks);
  const initialRoutes = resolveWorkflowGraphV3InitialRoutes(
    loop,
    resolved.tasks,
  );
  const outputStep = steps.find((step) => step.id === loop.body.outputStepId)!;
  const entryStep = steps.find((step) => step.id === loop.body.entryStepId)!;
  const runtimeInputs = objectValue(row.input_json) as Record<
    string,
    ActionJson
  >;
  const snapshot = objectValue(row.template_snapshot_json) as Record<
    string,
    ActionJson
  >;
  let regionOutput = objectValue(region.output_json);
  const decisions = objectValue(regionOutput.decisions);
  for (let index = 0; index < Number(loop.iterations); index++) {
    const current = stepRuns.filter(
      (stepRun) => Number(stepRun.instance_index) === index,
    );
    const byStep = new Map(
      current.map((stepRun) => [String(stepRun.workflow_step_id), stepRun]),
    );
    const currentInstances = instances.filter(
      (instance) => Number(instance.instance_index) === index,
    );
    const failure = current.find(
      (stepRun) =>
        stepRun.status === "failed" || stepRun.status === "cancelled",
    );
    if (failure) {
      await client.query(
        `UPDATE execution.workflow_dynamic_regions
         SET status='failed',error=$2,failed_count=failed_count+1,completed_at=now(),updated_at=now()
         WHERE id=$1 AND status='running'`,
        [region.id, String(failure.error ?? "V3 loop action failed.")],
      );
      await cancelActiveTasksAndStepsPg(client, runId, organizationId, steps);
      if (!(await hasActiveTasksPg(client, runId)))
        await finishRunPg(
          client,
          runId,
          "failed",
          String(failure.error ?? "V3 loop action failed."),
          options.telemetry,
        );
      return;
    }
    const allCompleted = loop.body.stepIds.every(
      (stepId) => byStep.get(stepId)?.status === "completed",
    );
    if (allCompleted) {
      const outputRun = byStep.get(outputStep.id)!;
      let decision = objectValue(decisions[String(index)]);
      if (!Object.keys(decision).length) {
        // Verify each frozen successor can read the accepted output copy
        // before making the stop/advance decision durable, including the
        // final round. A persisted decision is never recomputed on restart.
        const reception = await frozenV3RoutedInputsPg(
          client,
          row,
          entryStep,
          graph.distribution.steps.find(
            (step) => step.stepId === entryStep.id,
          )!,
          resolved.tasks,
          carryRoutes,
          new Map([[outputStep.id, outputRun]]),
          options,
          {},
          {
            incoming: carryRoutes,
            outgoing: [],
            scopeId: `${runId}:${loop.id}:${index + 1}:receipt`,
          },
        );
        if (!reception) return;
        let stop = index === Number(loop.iterations) - 1;
        if (loop.stop && !stop) {
          const tasks = await pgMany<Row>(
            client,
            `SELECT output_json FROM execution.workflow_tasks
             WHERE workflow_step_run_id=$1 ORDER BY shard_index,id`,
            [outputRun.id],
          );
          const expected = resolved.tasks.filter(
            (task) => task.stepId === outputStep.id,
          ).length;
          if (tasks.length !== expected)
            throw new WorkflowContractError(
              "V3 loop stop decision lacks accepted member outputs.",
            );
          if (
            tasks.some(
              (task) =>
                typeof objectValue(task.output_json)[loop.stop!.port] !==
                "boolean",
            )
          )
            throw new WorkflowContractError(
              "V3 loop stop output must be boolean for every member.",
            );
          stop = tasks.every(
            (task) => objectValue(task.output_json)[loop.stop!.port] === true,
          );
        }
        decision = { stop, outputStepRunId: String(outputRun.id) };
        decisions[String(index)] = decision;
        const values = arrayValue(regionOutput.values);
        values[index] = objectValue(outputRun.output_json);
        regionOutput = {
          ...regionOutput,
          decisions,
          values,
          value: values[index],
        };
        await client.query(
          `UPDATE execution.workflow_dynamic_regions
           SET output_json=$2::jsonb,completed_count=$3,updated_at=now() WHERE id=$1`,
          [
            region.id,
            JSON.stringify(regionOutput),
            (index + 1) * loop.body.stepIds.length,
          ],
        );
      }
      if (decision.stop === true) {
        await client.query(
          `UPDATE execution.workflow_dynamic_instances
           SET status='skipped',completed_at=now(),updated_at=now()
           WHERE dynamic_region_id=$1 AND instance_index>$2 AND status='pending'`,
          [region.id, index],
        );
        await client.query(
          `UPDATE execution.workflow_dynamic_regions
           SET status='completed',completed_at=now(),updated_at=now() WHERE id=$1`,
          [region.id],
        );
        if (!(await hasActiveTasksPg(client, runId)))
          await finishRunPg(
            client,
            runId,
            "completed",
            null,
            options.telemetry,
          );
        return;
      }
      continue;
    }
    // Only the first unfinished iteration is admitted. Accepted earlier work
    // is never recreated after authority takeover or a process restart.
    for (const stepId of loop.body.stepIds) {
      const instance = currentInstances.find(
        (item) => item.workflow_step_id === stepId,
      )!;
      if (byStep.has(stepId) || instance.status !== "pending") continue;
      const predecessors = loop.body.edges
        .filter((edge) => edge.to === stepId)
        .map((edge) => edge.from);
      if (
        predecessors.some(
          (source) => byStep.get(source)?.status !== "completed",
        )
      )
        continue;
      const step = steps.find((item) => item.id === stepId)!;
      const distributed = graph.distribution.steps.find(
        (item) => item.stepId === stepId,
      )!;
      if (
        distributed.aggregation ||
        step.manifestSnapshot?.execution?.distribution?.mode ===
          "partitioned-reduce"
      )
        throw new WorkflowContractError(
          "V3 loop aggregation and input partitioning are unsupported.",
        );
      const previous =
        index > 0
          ? stepRuns.find(
              (item) =>
                Number(item.instance_index) === index - 1 &&
                item.workflow_step_id === outputStep.id,
            )
          : undefined;
      const bindings = resolveDynamicGraphValue(step.inputBindings, {
        [loop.id]: {
          index,
          iteration: index + 1,
          previous: previous
            ? (objectValue(previous.output_json) as ActionJson)
            : null,
        },
      }) as Record<string, ActionJson>;
      const outputs = workflowOutputsByStep([
        ...staticRuns.values(),
        ...current,
      ]);
      const inputs = resolveInputBindings(
        bindings,
        runtimeInputs,
        snapshot,
        outputs,
        new Map(steps.map((item) => [item.id, []])),
        {
          stepsById: workflowStepMetadata(
            [...staticRuns.values(), ...current],
            steps,
          ),
        },
      );
      const incoming = [
        ...resolved.routes,
        ...(stepId === entryStep.id
          ? index === 0
            ? initialRoutes
            : carryRoutes
          : []),
      ];
      const outgoing = [
        ...resolved.routes,
        ...(stepId === outputStep.id ? carryRoutes : []),
      ];
      const sourceRuns = new Map([...staticRuns, ...byStep]);
      if (previous && stepId === entryStep.id)
        sourceRuns.set(outputStep.id, previous);
      const scopeId = `${runId}:${loop.id}:${index + 1}`;
      const routed = await frozenV3RoutedInputsPg(
        client,
        row,
        step,
        distributed,
        resolved.tasks,
        resolved.routes,
        sourceRuns,
        options,
        inputs,
        {
          incoming,
          outgoing,
          scopeId,
          iteration: index + 1,
        },
      );
      if (!routed) return;
      await createFrozenRoomStepRunPg(client, {
        workflowRunId: runId,
        organizationId,
        step,
        inputs,
        maxAttempts: options.maxAttempts,
        options,
        resolvedTasks: resolved.tasks,
        distribution: { kind: "per-member" },
        maxParallelism: resolved.tasks.filter((task) => task.stepId === stepId)
          .length,
        taskInputs: routed.inputs,
        taskMetadata: routed.metadata,
        routes: [...incoming, ...outgoing],
        dynamicInstanceId: String(instance.id),
        scopeId,
        iteration: index + 1,
      });
      await client.query(
        `UPDATE execution.workflow_dynamic_instances
         SET status='queued',input_json=$2::jsonb,started_at=now(),updated_at=now()
         WHERE id=$1 AND status='pending'`,
        [instance.id, JSON.stringify(inputs)],
      );
    }
    return;
  }
}

export async function frozenV3RoutedInputsPg(
  client: PgClient,
  row: Row,
  step: ApiWorkflowStep,
  distributed: WorkflowGraphV3Definition["distribution"]["steps"][number],
  tasks: readonly GraphV3DistributedTask[],
  routes: readonly ResolvedDistributedRoute[],
  stepRuns: Map<string, Row>,
  options: OrchestratorOptions,
  baseInput: Record<string, ActionJson>,
  routeSelection?: {
    incoming: readonly ResolvedDistributedRoute[];
    outgoing: readonly ResolvedDistributedRoute[];
    scopeId: string;
    iteration?: number;
    seed?: boolean;
  },
): Promise<{
  inputs: Record<string, Record<string, ActionJson>>;
  metadata: Record<string, Row>;
} | null> {
  const inputs: Record<string, Record<string, ActionJson>> = {};
  const metadata: Record<string, Row> = {};
  const runId = String(row.id);
  const targets = tasks.filter((task) => task.stepId === step.id);
  const incoming = (routeSelection?.incoming ?? routes).filter(
    (route) => route.to.stepId === step.id,
  );
  const outgoing = (routeSelection?.outgoing ?? routes).filter(
    (route) => route.from.stepId === step.id,
  );
  const room = objectValue(objectValue(row.execution_context_json).room);
  const target = objectValue(step.executionTarget);
  const artifactOutputPorts = distributed.outputs
    .filter((port) => port.kind === "artifact")
    .map((port) => port.name);
  if (artifactOutputPorts.length &&
      (typeof target.artifactChannelId !== "string" || !target.artifactChannelId))
    throw new WorkflowContractError(
      "V3 artifact outputs require an object channel.",
    );
  for (const task of targets) {
    const logicalId = `member:${task.memberId}`;
    const consumerMemberId = task.assignedMemberId ?? task.memberId;
    const routedInput: Record<string, ActionJson> = { ...baseInput };
    // Terminal outputs still need a frozen destination for their verified
    // temporary source copy, even when no remote member consumes the port.
    const publicationIntents = Object.fromEntries(
      artifactOutputPorts.map((port) => [
        port,
        {
          roomId: room.roomId,
          channelId: target.artifactChannelId,
          targetMemberIds: [
            ...new Set(
              outgoing
                .filter(
                  (route) =>
                    route.from.memberId === task.memberId &&
                    route.from.port === port,
                )
                .map((route) =>
                  tasks.find(
                    (candidate) =>
                      candidate.stepId === route.to.stepId &&
                      candidate.memberId === route.to.memberId,
                  ),
                )
                .filter((candidate): candidate is GraphV3DistributedTask =>
                  Boolean(candidate),
                )
                .map(
                  (candidate) =>
                    candidate.assignedMemberId ?? candidate.memberId,
                )
                .filter(
                  (memberId) =>
                    !routeSelection?.seed || memberId !== task.memberId,
                ),
            ),
          ],
          retentionObligationId: frozenV3RetentionObligationId(
            routeSelection?.scopeId ?? runId,
            step.id,
            task.memberId,
            port,
          ),
          requiredUntil: new Date(Date.now() + 86_400_000).toISOString(),
          // Routed V3 outputs are run intermediates. A verified held source
          // copy covers the bounded retention window, including local routes.
          availability: "temporary",
        },
      ]),
    );
    const artifactInputs: Record<string, FrozenAggregationArtifactInput[]> = {};
    for (const route of incoming.filter(
      (item) => item.to.memberId === task.memberId,
    )) {
      const sourceRun = stepRuns.get(route.from.stepId);
      if (!sourceRun || sourceRun.status !== "completed") return null;
      const source = await pgMany<Row>(
        client,
        `SELECT t.id,t.status,t.output_json,m.id AS manifest_id,m.artifacts_json
         FROM execution.workflow_tasks t
         LEFT JOIN LATERAL (
           SELECT id,artifacts_json FROM execution.workflow_artifact_manifests
           WHERE task_id=t.id AND status='accepted' ORDER BY attempt DESC LIMIT 1
         ) m ON true
         WHERE t.workflow_step_run_id=$1 AND
           (t.metadata_json->'logicalPartition'->>'id'=$2 OR
            t.metadata_json->'aggregation'->>'id'=$3)`,
        [sourceRun.id, `member:${route.from.memberId}`, route.from.memberId],
      );
      if (source.length !== 1 || source[0]!.status !== "completed")
        throw new WorkflowContractError(
          "V3 route source lacks one completed logical task.",
        );
      const sourceTask = source[0]!;
      const spec = distributed.inputs.find(
        (port) => port.name === route.to.port,
      );
      if (spec?.kind !== "artifact") {
        const output = objectValue(sourceTask.output_json)[route.from.port];
        if (output === undefined)
          throw new WorkflowContractError("V3 route source output is missing.");
        routedInput[route.to.port] = output as ActionJson;
        continue;
      }
      const artifacts = arrayValue(sourceTask.artifacts_json)
        .map(objectValue)
        .filter((artifact) => artifact.port === route.from.port);
      if (
        !sourceTask.manifest_id ||
        artifacts.length !== 1 ||
        typeof artifacts[0]!.artifactId !== "string"
      )
        throw new WorkflowContractError(
          "V3 route source lacks one accepted artifact.",
        );
      let frozen: FrozenAggregationArtifactInput;
      try {
        frozen = await freezeWorkflowArtifactInputPg(client, {
          manifestId: String(sourceTask.manifest_id),
          artifactId: String(artifacts[0]!.artifactId),
          destinationMemberId: consumerMemberId,
        });
      } catch (error) {
        if (
          error instanceof ArtifactAcceptanceError &&
          error.message ===
            "Routed artifact lacks verified recipient availability."
        ) {
          // A completed source cannot wait forever for its frozen recipient.
          // Use its durable completion time so a restarted controller observes
          // the same admission deadline instead of starting a new wait.
          if (!sourceRun.completed_at)
            throw new WorkflowContractError(
              "V3 route source lacks a completion checkpoint.",
            );
          const deadline = await pgOne<{ expired: boolean }>(
            client,
            `SELECT clock_timestamp() >= $1::timestamptz + interval '1 day' AS expired`,
            [sourceRun.completed_at],
          );
          if (deadline?.expired)
            throw new WorkflowContractError(
              "V3 routed artifact reception deadline exceeded.",
            );
          return null;
        }
        throw error;
      }
      if (options.authorizeV3ArtifactRead)
        await options.authorizeV3ArtifactRead({
          workflowRunId: runId,
          consumerMemberId,
          artifact: frozen,
        });
      else
        await authorizeV3ArtifactReadPg(
          client,
          runId,
          consumerMemberId,
          frozen,
        );
      (artifactInputs[route.to.port] ??= []).push(frozen);
    }
    if (distributed.transfer) {
      routedInput[distributed.transfer.sourceInput] =
        task.sourceMemberId ?? task.memberId;
      routedInput[distributed.transfer.recipientsInput] =
        task.recipientMemberIds ?? [];
    }
    inputs[logicalId] = routedInput;
    metadata[logicalId] = {
      ...(Object.keys(artifactInputs).length ? { artifactInputs } : {}),
      ...(Object.keys(publicationIntents).length
        ? { v3OutputRoutes: publicationIntents }
        : {}),
      v3Route: { memberId: task.memberId, assignedMemberId: consumerMemberId },
      ...(routeSelection?.iteration !== undefined && distributed.transfer
        ? {
            v3Loop: {
              scopeId: routeSelection.scopeId,
              iteration: routeSelection.iteration,
              sourceMemberId: task.sourceMemberId ?? task.memberId,
              targetMemberId: task.recipientMemberIds?.[0],
            },
          }
        : {}),
      ...(routeSelection?.seed
        ? {
            v3Seed: {
              scopeId: routeSelection.scopeId,
              memberId: task.memberId,
              batchId: `batch-${crypto.createHash("sha256").update(`${runId}:${task.memberId}`).digest("hex")}`,
              lotId: `lot-${crypto.createHash("sha256").update(`${runId}:${task.memberId}`).digest("hex")}`,
            },
          }
        : {}),
    };
  }
  return { inputs, metadata };
}

async function createV3AggregationStepPg(
  client: PgClient,
  row: Row,
  step: ApiWorkflowStep,
  steps: ApiWorkflowStep[],
  distributed: WorkflowGraphV3Definition["distribution"]["steps"][number],
  resolvedTasks: readonly GraphV3DistributedTask[],
  graph: WorkflowGraphV3Definition,
  stepRuns: Map<string, Row>,
  options: OrchestratorOptions,
) {
  const route = graph.distribution.routes.find(
    (item) => item.to.stepId === step.id && item.association.kind === "collect",
  );
  const sourceStep = steps.find((item) => item.id === route?.from.stepId);
  const sourceRun = route && stepRuns.get(route.from.stepId);
  if (!route || !sourceStep || !sourceRun || sourceRun.status !== "completed")
    throw new WorkflowContractError("V3 aggregation source is not complete.");
  const sourcePlan = await pgOne<Row>(
    client,
    `SELECT mode,metadata_json,plan_json FROM execution.execution_plans
     WHERE workflow_step_run_id=$1`,
    [sourceRun.id],
  );
  const sourceTasks = arrayValue(
    objectValue(sourcePlan?.plan_json).logicalTasks,
  ).map(objectValue);
  if (!sourcePlan || !sourceTasks.length)
    throw new WorkflowContractError(
      "V3 aggregation requires a persisted source plan.",
    );
  const manifest = step.manifestSnapshot;
  if (
    manifest?.apiVersion !== "workflow-actions/v2" ||
    !manifest.contracts?.computation.aggregation
  )
    throw new WorkflowContractError(
      "V3 aggregation requires a locked V2 action contract.",
    );
  const aggregator = resolvedTasks.find((task) => task.stepId === step.id);
  const aggregatorMemberId = aggregator?.assignedMemberId;
  if (!aggregatorMemberId)
    throw new WorkflowContractError(
      "V3 aggregation has no frozen reader member.",
    );
  const mapPlan: FrozenLogicalPartitionPlan = {
    mode: String(sourcePlan.mode),
    partitionPlanVersion: String(
      objectValue(sourcePlan.metadata_json).partitionPlanVersion,
    ),
    maxParallelism: Number(
      objectValue(sourcePlan.metadata_json).maxParallelism,
    ),
    tasks: sourceTasks.map((task) => ({
      kind: String(task.kind),
      logicalId: String(task.logicalId),
      index: Number(task.index),
      count: Number(task.count),
      input: {},
      eligibleMemberIds: arrayValue(task.eligibleMemberIds).map(String),
    })),
  };
  const scopeId = `${row.id}:${step.id}`;
  const action = manifest as ActionManifestV2;
  const documentMap =
    sourceStep.manifestSnapshot?.apiVersion === "workflow-actions/v2" &&
    sourceStep.manifestSnapshot.contracts?.computation.semanticId ===
      "beam.document-term-map/v2";
  const contributionIdsByLogicalId: Record<string, string> = documentMap
    ? await frozenV3DocumentContributionIdsPg(
        client,
        String(sourceRun.id),
        sourceTasks.map((task) => String(task.logicalId)),
        String(
          sourceStep.manifestSnapshot?.execution?.distribution?.inputKey ?? "",
        ),
      )
    : Object.fromEntries(
        sourceTasks.map((task) => [
          String(task.logicalId),
          String(task.logicalId),
        ]),
      );
  const plan =
    mapPlan.mode === "partition-map"
      ? planAggregationForFrozenPartitions({
          scopeId,
          sourceStepId: route.from.stepId,
          sourcePort: route.from.port,
          stepId: step.id,
          aggregatorMemberId,
          strategy: distributed.aggregation!.strategy,
          mapPlan,
          contributionIdsByLogicalId,
          action,
        })
      : {
          version: "workflow-aggregation/v1" as const,
          sourcePlanVersion: "logical/v1" as const,
          scopeId,
          sourceStepId: route.from.stepId,
          stepId: step.id,
          placement: "room-member" as const,
          aggregatorMemberId,
          invocations: planAggregationInvocations({
            scopeId,
            stepId: step.id,
            inputPort: action.contracts.computation.aggregation!.inputPort,
            outputPort: action.contracts.computation.aggregation!.outputPort,
            contributionFormat:
              action.contracts.computation.aggregation!.contributionFormat,
            maxArtifacts: action.contracts.resources.maxArtifacts,
            strategy: distributed.aggregation!.strategy,
            associative: action.contracts.computation.aggregation!.associative,
            closedUnderCombination:
              action.contracts.computation.aggregation!.closedUnderCombination,
            sources: mapPlan.tasks.map((task) => ({
              stepId: route.from.stepId,
              taskId: task.logicalId!,
              port: route.from.port,
              index: task.index!,
              contributionId: contributionIdsByLogicalId[task.logicalId!]!,
            })),
          }),
        };
  await (options.authorizeExecution ?? authorizeWorkflowExecutionPg)(client, {
    workflowRunId: String(row.id),
    stepId: step.id,
    phase: "dispatch",
    inputs: {},
  });
  const timestamp = now();
  const stepRunId = pgId("wsr");
  const identity = resolvedStepIdentity(step);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO execution.workflow_step_runs (
       id,workflow_run_id,workflow_step_id,action_package_name,resolved_version,
       checksum,source_registry,resolved_placement,status,attempt,input_json,
       output_json,metadata_json,state_json,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,'room-members','queued',1,'{}'::jsonb,
       '{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$8,$8)
     ON CONFLICT DO NOTHING RETURNING id`,
    [
      stepRunId,
      row.id,
      step.id,
      step.actionPackage,
      identity.version,
      identity.checksum,
      identity.sourceRegistry,
      timestamp,
    ],
  );
  if (!inserted.rows.length) return;
  const planId = pgId("wfp");
  await client.query(
    `INSERT INTO execution.execution_plans (
       id,organization_id,workflow_run_id,workflow_step_run_id,workflow_step_id,
       status,mode,shard_count,metadata_json,plan_json,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,'planned','v3-aggregation',$6,'{}'::jsonb,
       '{}'::jsonb,$7,$7)`,
    [
      planId,
      row.organization_id,
      row.id,
      stepRunId,
      step.id,
      plan.invocations.length,
      timestamp,
    ],
  );
  await persistFrozenAggregationPlanPg(client, planId, stepRunId, plan);
  await appendWorkflowEventPg(client, {
    organizationId: String(row.organization_id),
    workflowRunId: String(row.id),
    workflowStepRunId: stepRunId,
    eventType: "StepRunCreated",
    payload: { workflowStepId: step.id, actionPackageName: step.actionPackage },
  });
}

/** The document-map action writes descriptor.name into its counter. Read the
 * exact input frozen for each logical task, rather than using partition:idx as
 * the reducer's expected document ID. */
async function frozenV3DocumentContributionIdsPg(
  client: PgClient,
  sourceStepRunId: string,
  logicalIds: readonly string[],
  inputKey: string,
): Promise<Record<string, string>> {
  if (
    !inputKey ||
    !logicalIds.length ||
    new Set(logicalIds).size !== logicalIds.length
  )
    throw new WorkflowContractError(
      "V3 document map has no complete logical partition plan.",
    );
  const tasks = await pgMany<Row>(
    client,
    `SELECT metadata_json->'logicalPartition'->>'id' AS logical_id,input_json
     FROM execution.workflow_tasks
     WHERE workflow_step_run_id=$1 AND task_kind='step-partition'`,
    [sourceStepRunId],
  );
  if (tasks.length !== logicalIds.length)
    throw new WorkflowContractError(
      "V3 document map task count differs from its frozen plan.",
    );
  const expected = new Set(logicalIds);
  const contributionIds: Record<string, string> = {};
  const documentIds = new Set<string>();
  for (const task of tasks) {
    const logicalId = task.logical_id;
    if (
      typeof logicalId !== "string" ||
      !expected.has(logicalId) ||
      Object.hasOwn(contributionIds, logicalId)
    )
      throw new WorkflowContractError(
        "V3 document map task identity differs from its frozen plan.",
      );
    const documents = objectValue(task.input_json)[inputKey];
    const document =
      Array.isArray(documents) && documents.length === 1
        ? objectValue(documents[0])
        : {};
    const documentId = document.name;
    if (
      typeof documentId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(documentId) ||
      documentIds.has(documentId)
    )
      throw new WorkflowContractError(
        "V3 document map requires one uniquely named frozen document per logical task.",
      );
    contributionIds[logicalId] = documentId;
    documentIds.add(documentId);
  }
  return contributionIds;
}

async function admitV3AggregationPg(
  client: PgClient,
  row: Row,
  step: ApiWorkflowStep,
  distributed: WorkflowGraphV3Definition["distribution"]["steps"][number],
  stepRun: Row,
  options: OrchestratorOptions,
) {
  const plan = await pgOne<Row>(
    client,
    `SELECT id,plan_json FROM execution.execution_plans
     WHERE workflow_step_run_id=$1 AND mode='v3-aggregation'`,
    [stepRun.id],
  );
  if (!plan) throw new WorkflowContractError("V3 aggregation plan is missing.");
  const frozen = objectValue(plan.plan_json);
  const sourceRun = await pgOne<Row>(
    client,
    `SELECT id FROM execution.workflow_step_runs
     WHERE workflow_run_id=$1 AND workflow_step_id=$2 AND dynamic_instance_id IS NULL`,
    [row.id, frozen.sourceStepId],
  );
  if (!sourceRun) return;
  const invocations = arrayValue(frozen.invocations).map(objectValue);
  const outputPorts = distributed.outputs
    .filter((port) => port.kind === "artifact")
    .map((port) => port.name);
  const roomId = objectValue(objectValue(row.execution_context_json).room).roomId;
  const channelId = objectValue(step.executionTarget).artifactChannelId;
  if (outputPorts.length &&
      (typeof roomId !== "string" || !roomId ||
        typeof channelId !== "string" || !channelId))
    throw new WorkflowContractError(
      "V3 aggregation artifact outputs require an object channel.",
    );
  for (let index = 0; index < invocations.length; index++) {
    const invocationId = String(invocations[index]!.taskId);
    const result = await admitFrozenAggregationInvocationPg(client, {
      executionPlanId: String(plan.id),
      workflowRunId: String(row.id),
      workflowStepRunId: String(stepRun.id),
      sourceStepRunId: String(sourceRun.id),
      taskId: invocationId,
      consumerMemberId: String(frozen.aggregatorMemberId),
      authorizeRead: async (artifact) => {
        if (options.authorizeV3ArtifactRead)
          await options.authorizeV3ArtifactRead({
            workflowRunId: String(row.id),
            consumerMemberId: String(frozen.aggregatorMemberId),
            artifact,
          });
        else
          await authorizeV3ArtifactReadPg(
            client,
            String(row.id),
            String(frozen.aggregatorMemberId),
            artifact,
          );
      },
      block: async ({ sourceTaskId, reason }) => {
        await client.query(
          `UPDATE execution.workflow_step_runs SET status='failed',error=$2,
           completed_at=now(),updated_at=now()
           WHERE id=$1 AND status IN ('queued','running')`,
          [stepRun.id, `Required contribution ${sourceTaskId}: ${reason}`],
        );
      },
      enqueue: async (ready) => {
        await assertWorkflowTaskAdmissionPg(
          client,
          String(row.organization_id),
          1,
        );
        await enqueueWorkflowTaskPg(client, {
          organizationId: String(row.organization_id),
          workflowRunId: String(row.id),
          workflowStepRunId: String(stepRun.id),
          workflowStepId: step.id,
          actionPackageName: step.actionPackage,
          taskKind: "step-aggregation",
          shardIndex: index,
          shardCount: invocations.length,
          placement: "room-members",
          input: ready.input,
          createdAt: now(),
          maxAttempts: options.maxAttempts,
          planId: String(plan.id),
          extraMetadata: {
            ...ready.metadata,
            ...(outputPorts.length
              ? v3AggregationTaskMetadata({
                  scopeId: String(frozen.scopeId),
                  stepId: step.id,
                  taskId: ready.taskId,
                  roomId: String(roomId),
                  channelId: String(channelId),
                  outputPorts,
                })
              : {}),
          },
          options,
        });
      },
    });
    if (result === "blocked") break;
  }
}

/** A legacy continue-on-failure edge can still schedule an independent
 * branch. A required artifact input cannot consume a failed producer. */
export function failedRequiredArtifactSource(
  step: ApiWorkflowStep,
  stepRunsByStepId: Map<string, Row>,
): string | null {
  const ports = step.manifestSnapshot?.inputs ?? {};
  for (const [port, schema] of Object.entries(ports)) {
    if (
      (schema.type !== "artifact" && schema.type !== "artifact[]") ||
      schema.required !== true
    )
      continue;
    const binding = step.inputBindings[port];
    if (binding === undefined) continue;
    for (const match of JSON.stringify(binding).matchAll(
      /\$\{steps\.([^.}]+)\.(?:outputs|artifacts)(?:[.}]|$)/g,
    )) {
      const source = match[1];
      if (
        source &&
        ["failed", "cancelled", "not_reached", "skipped"].includes(
          String(stepRunsByStepId.get(source)?.status ?? ""),
        )
      )
        return source;
    }
  }
  return null;
}

async function createStepRunAndTaskPg(
  client: PgClient,
  workflowRunId: string,
  organizationId: string,
  step: ApiWorkflowStep,
  inputs: Record<string, ActionJson>,
  maxAttempts: number,
  options: OrchestratorOptions,
  dynamicInstanceId: string | null = null,
  frozenRoomPlanning?: Omit<FrozenRoomStepPlanning, "stepId" | "input"> & {
    taskInputs?: Record<string, Record<string, ActionJson>>;
    taskMetadata?: Record<string, Row>;
    routes?: readonly ResolvedDistributedRoute[];
    scopeId?: string;
    iteration?: number;
  },
): Promise<TaskPublishRequest | null> {
  if (step.kind === "workflow") {
    await createWorkflowCallPg(client, {
      workflowRunId,
      organizationId,
      step,
      inputs,
      dynamicInstanceId,
      authorizeExecution: options.authorizeExecution,
    });
    return null;
  }
  await (options.authorizeExecution ?? authorizeWorkflowExecutionPg)(client, {
    workflowRunId,
    stepId: step.id,
    phase: "dispatch",
    inputs,
  });
  const identity = resolvedStepIdentity(step);
  const timestamp = now();
  const stepRunId = pgId("wsr");
  const inserted = await client.query<Row>(
    `
    INSERT INTO execution.workflow_step_runs (
      id, workflow_run_id, workflow_step_id, dynamic_instance_id,
      action_package_name, resolved_version,
      checksum, source_registry, resolved_placement, execution_location_id, status,
      attempt, input_json, output_json, metadata_json, state_json, created_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'queued', 1,
      $11::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $12, $12)
    ON CONFLICT DO NOTHING
    RETURNING id
    `,
    [
      stepRunId,
      workflowRunId,
      step.id,
      dynamicInstanceId,
      step.actionPackage,
      identity.version,
      identity.checksum,
      identity.sourceRegistry,
      step.resolvedPlacement ?? step.placement ?? "local-workers",
      step.executionLocationId ?? null,
      JSON.stringify(inputs),
      timestamp,
    ],
  );
  if (!inserted.rows[0]) {
    const existing = await pgOne<Row>(
      client,
      dynamicInstanceId
        ? `SELECT task.* FROM execution.workflow_tasks task
           JOIN execution.workflow_step_runs step_run ON step_run.id = task.workflow_step_run_id
           WHERE step_run.dynamic_instance_id = $1
           ORDER BY task.created_at DESC LIMIT 1`
        : `SELECT task.* FROM execution.workflow_tasks task
           JOIN execution.workflow_step_runs step_run ON step_run.id = task.workflow_step_run_id
           WHERE step_run.workflow_run_id = $1 AND step_run.workflow_step_id = $2
             AND step_run.dynamic_instance_id IS NULL
           ORDER BY task.created_at DESC LIMIT 1`,
      dynamicInstanceId ? [dynamicInstanceId] : [workflowRunId, step.id],
    );
    if (!existing) {
      throw new Error(
        `Workflow step instance "${step.id}" already exists without a task.`,
      );
    }
    return taskPublishRequestFromRow(existing, workflowRunId);
  }

  const plan = frozenRoomPlanning
    ? planFrozenRoomStepTasks({
        ...frozenRoomPlanning,
        stepId: step.id,
        input: inputs,
      })
    : planActionTasks(step.manifestSnapshot ?? undefined, inputs);
  const frozenMembers = frozenRoomPlanning?.resolvedTasks
    .filter((task) => task.stepId === step.id)
    .sort((left, right) => left.index - right.index)
    .map((task) => task.memberId);
  await assertWorkflowTaskAdmissionPg(
    client,
    organizationId,
    plan.tasks.length,
  );
  const planId = pgId("wfp");
  await client.query(
    `
    INSERT INTO execution.execution_plans (
      id, organization_id, workflow_run_id, workflow_step_run_id, workflow_step_id,
      status, mode, shard_count, metadata_json, plan_json, created_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, 'planned', $7, $8, $9::jsonb, $10::jsonb, $6, $6)
    `,
    [
      planId,
      organizationId,
      workflowRunId,
      stepRunId,
      step.id,
      timestamp,
      plan.mode,
      plan.tasks.length,
      JSON.stringify({
        intermediateGroupSize: plan.groupSize,
        ...(plan.partitionPlanVersion
          ? {
              partitionPlanVersion: plan.partitionPlanVersion,
              maxParallelism: plan.maxParallelism,
            }
          : {}),
      }),
      JSON.stringify(
        frozenRoomPlanning
          ? {
              graphVersion: "workflow-graph/v3",
              distribution: frozenRoomPlanning.distribution,
              selectedMemberIds: frozenMembers,
              logicalPartitionIds: plan.tasks.map((task) => task.logicalId),
              routes:
                frozenRoomPlanning.routes?.filter(
                  (route) =>
                    route.from.stepId === step.id ||
                    route.to.stepId === step.id,
                ) ?? [],
              ...(frozenRoomPlanning.iteration !== undefined
                ? {
                    loop: {
                      scopeId: frozenRoomPlanning.scopeId,
                      iteration: frozenRoomPlanning.iteration,
                      targets: Object.fromEntries(
                        plan.tasks.map((task) => {
                          const ring = objectValue(
                            frozenRoomPlanning.taskMetadata?.[
                              task.logicalId ?? ""
                            ]?.v3Loop,
                          );
                          return [
                            task.logicalId,
                            {
                              sourceMemberId: ring.sourceMemberId,
                              targetMemberId: ring.targetMemberId,
                            },
                          ];
                        }),
                      ),
                    },
                  }
                : {}),
              ...(Object.values(frozenRoomPlanning.taskMetadata ?? {}).some(
                (metadata) => Boolean(metadata.v3Seed),
              )
                ? {
                    seed: {
                      targets: Object.fromEntries(
                        plan.tasks.map((task) => [
                          task.logicalId,
                          objectValue(
                            frozenRoomPlanning.taskMetadata?.[
                              task.logicalId ?? ""
                            ]?.v3Seed,
                          ),
                        ]),
                      ),
                    },
                  }
                : {}),
              logicalTasks: plan.tasks.map((task) => ({
                kind: task.kind,
                logicalId: task.logicalId,
                index: task.index,
                count: task.count,
                eligibleMemberIds:
                  task.eligibleMemberIds ??
                  (task.memberId ? [task.memberId] : undefined),
              })),
            }
          : {},
      ),
    ],
  );
  let publishRequest: TaskPublishRequest | null = null;
  for (const task of plan.tasks) {
    publishRequest = await enqueueWorkflowTaskPg(client, {
      organizationId,
      workflowRunId,
      workflowStepRunId: stepRunId,
      workflowStepId: step.id,
      actionPackageName: step.actionPackage,
      taskKind: task.kind,
      shardIndex: task.index,
      shardCount: task.count,
      placement: step.executionLocationId
        ? "execution-location"
        : (step.resolvedPlacement ?? step.placement ?? "local-workers"),
      input:
        frozenRoomPlanning?.taskInputs?.[task.logicalId ?? ""] ?? task.input,
      createdAt: timestamp,
      maxAttempts,
      planId,
      partitionPlanVersion: plan.partitionPlanVersion,
      logicalId: task.logicalId,
      memberId: task.memberId,
      eligibleMemberIds:
        task.eligibleMemberIds ??
        (task.memberId && step.executionTarget?.kind === "room-member"
          ? [task.memberId]
          : plan.partitionPlanVersion &&
              step.executionTarget?.kind === "room-member"
            ? step.executionTarget.memberIds
            : undefined),
      extraMetadata: frozenRoomPlanning?.taskMetadata?.[task.logicalId ?? ""],
      options,
    });
  }
  await appendWorkflowEventPg(client, {
    organizationId,
    workflowRunId,
    workflowStepRunId: stepRunId,
    eventType: "StepRunCreated",
    payload: { workflowStepId: step.id, actionPackageName: step.actionPackage },
  });
  return publishRequest;
}

/** Internal V3 freeze/plan/persist boundary. The caller must supply a cohort
 * authorized against the room snapshot; public V3 launch remains gated until
 * routing and collection can call this boundary with those frozen inputs. */
export async function createFrozenRoomStepRunPg(
  client: PgClient,
  input: {
    workflowRunId: string;
    organizationId: string;
    step: ApiWorkflowStep;
    inputs: Record<string, ActionJson>;
    maxAttempts: number;
    options: OrchestratorOptions;
    /** Use a previously validated resolution for graphs with aggregation. */
    resolvedTasks?: readonly GraphV3DistributedTask[];
    graph?: WorkflowGraphV3Definition;
    graphSteps?: WorkflowGraphValidationStep[];
    membersByPartition?: Record<string, DistributedMember[]>;
    distribution: FrozenRoomStepPlanning["distribution"];
    maxParallelism: number;
    taskInputs?: Record<string, Record<string, ActionJson>>;
    taskMetadata?: Record<string, Row>;
    routes?: readonly ResolvedDistributedRoute[];
    dynamicInstanceId?: string;
    scopeId?: string;
    iteration?: number;
  },
) {
  if (
    input.resolvedTasks &&
    (input.graph || input.graphSteps || input.membersByPartition)
  )
    throw new Error("Supply either a resolved V3 plan or a graph and cohort.");
  const resolvedTasks =
    input.resolvedTasks ??
    (input.graph && input.graphSteps && input.membersByPartition
      ? resolveWorkflowGraphV3(
          input.graph,
          input.graphSteps,
          input.membersByPartition,
        ).tasks
      : null);
  if (!resolvedTasks)
    throw new Error("Frozen V3 planning requires a resolved cohort.");
  return createStepRunAndTaskPg(
    client,
    input.workflowRunId,
    input.organizationId,
    input.step,
    input.inputs,
    input.maxAttempts,
    input.options,
    input.dynamicInstanceId ?? null,
    {
      resolvedTasks,
      distribution: input.distribution,
      maxParallelism: input.maxParallelism,
      taskInputs: input.taskInputs,
      taskMetadata: input.taskMetadata,
      routes: input.routes,
      scopeId: input.scopeId,
      iteration: input.iteration,
    },
  );
}

async function advanceDistributedStepsPg(
  client: PgClient,
  run: Row,
  steps: ApiWorkflowStep[],
  options: OrchestratorOptions,
) {
  const plans = await client.query<Row>(
    `SELECT p.*, s.input_json, s.status AS step_status
    FROM execution.execution_plans p JOIN execution.workflow_step_runs s ON s.id=p.workflow_step_run_id
    WHERE p.workflow_run_id=$1 AND p.mode<>'single' AND s.status IN ('queued','running')`,
    [run.id],
  );
  for (const plan of plans.rows) {
    const step = steps.find(
      (candidate) => candidate.id === plan.workflow_step_id,
    );
    if (!step?.manifestSnapshot)
      throw new Error("Distributed execution requires a frozen manifest.");
    const tasks = (
      await client.query<Row>(
        "SELECT * FROM execution.workflow_tasks WHERE workflow_step_run_id=$1 ORDER BY shard_index",
        [plan.workflow_step_run_id],
      )
    ).rows;
    const failure = tasks.find((task) =>
      ["failed", "dead_letter", "cancelled"].includes(String(task.status)),
    );
    if (failure) {
      await client.query(
        "UPDATE execution.workflow_step_runs SET status='failed',error=$2,completed_at=now(),updated_at=now() WHERE id=$1 AND status IN ('queued','running')",
        [
          plan.workflow_step_run_id,
          failure.error ?? "Distributed action partition failed.",
        ],
      );
      continue;
    }
    const next = nextReduceTasks(
      step.manifestSnapshot,
      objectValue(plan.input_json) as Record<string, ActionJson>,
      String(plan.mode),
      Number(objectValue(plan.metadata_json).intermediateGroupSize ?? 4),
      tasks as Parameters<typeof nextReduceTasks>[4],
      Number(plan.shard_count),
    );
    if (next.length)
      await assertWorkflowTaskAdmissionPg(
        client,
        String(run.organization_id),
        next.length,
      );
    for (const task of next)
      await enqueueWorkflowTaskPg(client, {
        organizationId: String(run.organization_id),
        workflowRunId: String(run.id),
        workflowStepRunId: String(plan.workflow_step_run_id),
        workflowStepId: step.id,
        actionPackageName: step.actionPackage,
        taskKind: task.kind,
        shardIndex: task.index,
        shardCount: task.count,
        placement: step.executionLocationId
          ? "execution-location"
          : (step.resolvedPlacement ?? "local-workers"),
        input: task.input,
        createdAt: now(),
        maxAttempts: Number(tasks[0]?.max_attempts ?? options.maxAttempts),
        planId: String(plan.id),
        options,
      });
  }
}

async function enqueueWorkflowTaskPg(
  client: PgClient,
  input: {
    organizationId: string;
    workflowRunId: string;
    workflowStepRunId: string;
    workflowStepId: string;
    actionPackageName: string;
    taskKind: string;
    shardIndex?: number;
    shardCount?: number;
    placement: string;
    input: Record<string, ActionJson>;
    createdAt: string;
    maxAttempts: number;
    planId: string;
    partitionPlanVersion?: "logical/v1";
    logicalId?: string;
    memberId?: string;
    eligibleMemberIds?: string[];
    extraMetadata?: Row;
    options: OrchestratorOptions;
  },
): Promise<TaskPublishRequest> {
  const run = await pgOne<Row>(
    client,
    "SELECT metadata_json FROM execution.workflow_runs WHERE id = $1",
    [input.workflowRunId],
  );
  const parentContext = traceContextFromMetadata(
    run?.metadata_json,
    input.workflowRunId,
  );
  const span = input.options.telemetry?.startSpan("workflow.task.enqueue", {
    parent: parentContext,
    correlationId: input.workflowRunId,
    attributes: {
      "workflow.run_id": input.workflowRunId,
      "workflow.task_kind": input.taskKind,
      "action.package": input.actionPackageName,
    },
  });
  const taskTraceContext = span?.context ?? parentContext;
  const capability = `${input.actionPackageName}.${input.taskKind}`;
  const policy = retryPolicyForTask(capability, input.maxAttempts);
  const taskId = pgId("wftask");
  const natsSubject = taskSubjectFor({
    root: input.options.taskSubjectRoot,
    actionPackageName: input.actionPackageName,
    taskKind: input.taskKind,
    targetWorkerId: null,
  });
  const inputChecksum = checksumJson(input.input);
  await client.query(
    `
    INSERT INTO execution.workflow_tasks (
      id, organization_id, workflow_run_id, workflow_step_run_id, workflow_step_id,
      action_package_name, task_kind, status, priority, scheduled_at, attempt_count,
      attempts, max_attempts, input_checksum, idempotency_key,
      input_json, output_json, metadata_json,
      retry_policy_json, placement_explanation_json, nats_subject, created_at, updated_at, shard_index, shard_count,
      admission_deadline_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', 0, $8, 0, 0, $9, $10, $15,
      $11::jsonb, '{}'::jsonb, $14::jsonb, $12::jsonb, '{}'::jsonb, $13, $8, $8, $16, $17,
      $8::timestamptz + interval '1 day')
    ON CONFLICT DO NOTHING
    `,
    [
      taskId,
      input.organizationId,
      input.workflowRunId,
      input.workflowStepRunId,
      input.workflowStepId,
      input.actionPackageName,
      input.taskKind,
      input.createdAt,
      policy.maxAttempts,
      inputChecksum,
      JSON.stringify(input.input),
      JSON.stringify(policy),
      natsSubject,
      JSON.stringify({
        ...observabilityMetadata(input.workflowRunId, taskTraceContext),
        ...(input.partitionPlanVersion &&
        ["step-shard", "step-member", "step-partition"].includes(input.taskKind)
          ? {
              logicalPartition: {
                version: input.partitionPlanVersion,
                id: input.logicalId,
                index: input.shardIndex,
                count: input.shardCount,
                ...(input.memberId ? { memberId: input.memberId } : {}),
                ...(input.eligibleMemberIds
                  ? { eligibleMemberIds: input.eligibleMemberIds }
                  : {}),
              },
            }
          : {}),
        ...input.extraMetadata,
      }),
      `${input.workflowStepRunId}:${input.taskKind}:${input.shardIndex ?? -1}`,
      input.shardIndex ?? null,
      input.shardCount ?? null,
    ],
  );
  await client.query(
    `
    INSERT INTO execution.execution_plan_shards (
      id, execution_plan_id, workflow_task_id, shard_kind, nats_subject, status,
      input_weight, metadata_json, created_at, updated_at, shard_index
    )
    VALUES ($1, $2, $3, $4, $5, 'planned', $6, $7::jsonb, $8, $8, $9)
    ON CONFLICT DO NOTHING
    `,
    [
      pgId("wfps"),
      input.planId,
      taskId,
      input.taskKind,
      natsSubject,
      Buffer.byteLength(JSON.stringify(input.input)),
      JSON.stringify({ capability }),
      input.createdAt,
      input.shardIndex ?? null,
    ],
  );
  await appendWorkflowEventPg(client, {
    organizationId: input.organizationId,
    workflowRunId: input.workflowRunId,
    workflowStepRunId: input.workflowStepRunId,
    workflowTaskId: taskId,
    eventType: "TaskScheduled",
    payload: {
      taskKind: input.taskKind,
      actionPackageName: input.actionPackageName,
    },
  });
  await enqueueTaskWakeupPg(client, {
    taskId,
    attemptNumber: 1,
    taskKind: input.taskKind,
    actionPackageName: input.actionPackageName,
    targetWorkerId: null,
    subject: natsSubject,
    placement: input.placement,
    workflowRunId: input.workflowRunId,
    correlationId: input.workflowRunId,
    traceparent: taskTraceContext
      ? formatTraceparent(taskTraceContext)
      : undefined,
    createdAt: input.createdAt,
  });
  span?.end();
  return {
    taskId,
    taskKind: input.taskKind,
    actionPackageName: input.actionPackageName,
    targetWorkerId: null,
    subject: natsSubject,
    placement: input.placement,
    workflowRunId: input.workflowRunId,
    correlationId: input.workflowRunId,
    traceparent: taskTraceContext
      ? formatTraceparent(taskTraceContext)
      : undefined,
  };
}

async function finishIfTerminalPg(
  client: PgClient,
  workflowRunId: string,
  steps: ApiWorkflowStep[],
  stepRunsByStepId: Map<string, Row>,
  options: OrchestratorOptions,
) {
  // A failure a decision consumed does not fail the run. Handling is resolved
  // from what actually evaluated, never from graph configuration alone, so a
  // decision that never ran suppresses nothing.
  const handledFailures = steps.some(
    (step) => stepRunsByStepId.get(step.id)?.status === "failed",
  )
    ? await handledFailureStepIds(client, workflowRunId)
    : new Set<string>();
  const failedRequired = steps.find((step) => {
    const stepRun = stepRunsByStepId.get(step.id);
    return (
      stepRun?.status === "failed" &&
      step.required !== false &&
      !handledFailures.has(step.id)
    );
  });
  if (failedRequired) {
    const owner = await pgOne<Row>(
      client,
      "SELECT organization_id,template_snapshot_json FROM execution.workflow_runs WHERE id=$1",
      [workflowRunId],
    );
    const definition = objectValue(
      objectValue(owner?.template_snapshot_json).workflowTemplate,
    );
    const continueOnFailure =
      objectValue(definition.config).failurePolicy === "continue_on_failure";
    if (
      continueOnFailure &&
      !steps.every((step) => isSettled(stepRunsByStepId.get(step.id)))
    )
      return false;
    if (!continueOnFailure) {
      await cancelActiveTasksAndStepsPg(
        client,
        workflowRunId,
        String(owner?.organization_id),
        steps,
      );
    }
    if (await hasActiveTasksPg(client, workflowRunId)) return true;
    await finishRunPg(
      client,
      workflowRunId,
      "failed",
      String(
        stepRunsByStepId.get(failedRequired.id)?.error ??
          "workflow step failed",
      ),
      options.telemetry,
    );
    return true;
  }
  if (
    steps.every((step) => isSettled(stepRunsByStepId.get(step.id))) &&
    !(await hasActiveTasksPg(client, workflowRunId))
  ) {
    await finishRunPg(
      client,
      workflowRunId,
      "completed",
      null,
      options.telemetry,
    );
    return true;
  }
  return false;
}

export async function expirePendingTaskAdmissionsPg(
  pool: PgPool,
  batchSize: number,
) {
  await withPostgresTransaction(pool, async (client) => {
    const expired = await client.query<Row>(
      `WITH candidates AS (
        SELECT t.id FROM execution.workflow_tasks t
        JOIN execution.workflow_runs r ON r.id=t.workflow_run_id
        WHERE t.status IN ('queued','retry_scheduled')
          AND t.admission_deadline_at<=clock_timestamp()
          AND r.status IN ('queued','running')
        ORDER BY t.admission_deadline_at LIMIT $1
        FOR UPDATE OF t SKIP LOCKED
      )
      UPDATE execution.workflow_tasks t
      SET status='dead_letter',error='Task admission deadline exceeded.',
        completed_at=now(),updated_at=now()
      FROM candidates WHERE t.id=candidates.id RETURNING t.*`,
      [batchSize],
    );
    for (const task of expired.rows) {
      await client.query(
        `INSERT INTO execution.workflow_task_dead_letters
          (id,workflow_task_id,workflow_run_id,workflow_step_run_id,reason,error,attempts,max_attempts,payload_json)
         VALUES($1,$2,$3,$4,'admission_deadline',$5,$6,$7,'{}'::jsonb)
         ON CONFLICT(workflow_task_id) DO NOTHING`,
        [
          pgId("wfdl"),
          task.id,
          task.workflow_run_id,
          task.workflow_step_run_id,
          "Task admission deadline exceeded.",
          Number(task.attempt_count ?? 0),
          Number(task.max_attempts ?? 1),
        ],
      );
      await client.query(
        `UPDATE execution.workflow_step_runs
         SET status='failed',error='Task admission deadline exceeded.',
           completed_at=now(),updated_at=now()
         WHERE id=$1 AND status IN ('queued','running')`,
        [task.workflow_step_run_id],
      );
      await client.query(
        `UPDATE execution.execution_plan_shards
         SET status='dead_letter',updated_at=now() WHERE workflow_task_id=$1`,
        [task.id],
      );
    }
  });
}

export async function recoverExpiredTaskLeasesPg(
  pool: PgPool,
  options: OrchestratorOptions,
) {
  const rows = await withPostgresTransaction(pool, async (client) => {
    const result = await client.query<Row>(
      `
      WITH recoverable AS (
        SELECT task.id,
               CASE
                 WHEN task.lease_expires_at <= now() THEN 'expired_lease'
                 ELSE 'stale_worker_heartbeat'
               END AS recovery_reason,
               CASE
                 WHEN task.lease_expires_at <= now() THEN 'worker lease expired'
                 ELSE 'worker heartbeat stale'
               END AS recovery_error
        FROM execution.workflow_tasks task
        JOIN execution.workflow_runs run ON run.id = task.workflow_run_id
        LEFT JOIN runtime.worker_runtime_state worker
          ON worker.worker_id = task.leased_by
        WHERE task.status IN ('leased', 'running')
          AND task.lease_expires_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM execution.executor_assignments assignment WHERE assignment.task_id=task.id AND assignment.state IN ('assigned','dispatching','running','cancel_requested','reconciliation_required'))
          AND run.status = 'running'
          AND (
            task.lease_expires_at <= now()
            OR (
              task.leased_by IS NOT NULL
              AND (
                worker.worker_id IS NULL
                OR worker.status != 'active'
                OR worker.heartbeat_at IS NULL
                OR worker.heartbeat_at < now() - interval '45 seconds'
              )
            )
          )
        ORDER BY
          CASE
            WHEN task.lease_expires_at <= now() THEN task.lease_expires_at
            ELSE worker.heartbeat_at
          END ASC NULLS FIRST
        LIMIT $1
        FOR UPDATE OF task SKIP LOCKED
      )
      UPDATE execution.workflow_tasks task
      SET status = CASE
            WHEN task.attempts >= task.max_attempts THEN 'dead_letter'
            ELSE 'retry_scheduled'
          END,
          scheduled_at = CASE
            WHEN task.attempts < task.max_attempts THEN now()
            ELSE task.scheduled_at
          END,
          error = recoverable.recovery_error,
          locked_by = NULL,
          leased_by = NULL,
          lock_expires_at = NULL,
          lease_expires_at = NULL,
          claim_token = NULL,
          completed_at = CASE
            WHEN task.attempts >= task.max_attempts THEN now()
            ELSE task.completed_at
          END,
          updated_at = now()
      FROM recoverable
      WHERE task.id = recoverable.id
      RETURNING task.*, recoverable.recovery_reason, recoverable.recovery_error
      `,
      [options.batchSize],
    );
    for (const row of result.rows) {
      const taskId = String(row.id);
      const attemptNumber = Number(row.attempts ?? 0);
      const recoveryReason = String(row.recovery_reason ?? "expired_lease");
      const recoveryError = String(
        row.recovery_error ?? "worker lease expired",
      );
      await client.query(
        `
        UPDATE execution.workflow_task_attempts
        SET status = 'lease_expired', error = $3,
            completed_at = COALESCE(completed_at, now())
        WHERE workflow_task_id = $1 AND attempt_number = $2 AND status = 'running'
        `,
        [taskId, attemptNumber, recoveryError],
      );
      if (String(row.status) === "dead_letter") {
        await client.query(
          `
          INSERT INTO execution.workflow_task_dead_letters (
            id, workflow_task_id, workflow_run_id, workflow_step_run_id,
            reason, error, attempts, max_attempts, payload_json, created_at
          )
          VALUES ($1, $2, $3, $4, 'max_attempts', $5, $6, $7, $8::jsonb, now())
          ON CONFLICT (workflow_task_id) DO NOTHING
          `,
          [
            pgId("wfdl"),
            taskId,
            String(row.workflow_run_id),
            row.workflow_step_run_id ? String(row.workflow_step_run_id) : null,
            recoveryError,
            attemptNumber,
            Number(row.max_attempts ?? 1),
            JSON.stringify({ recovery: recoveryReason }),
          ],
        );
        if (row.workflow_step_run_id) {
          await client.query(
            `
            UPDATE execution.workflow_step_runs
            SET status = 'failed', error = $2,
                completed_at = COALESCE(completed_at, now()), updated_at = now()
            WHERE id = $1 AND status IN ('queued', 'running')
            `,
            [String(row.workflow_step_run_id), recoveryError],
          );
        }
        const failedStepRun = row.workflow_step_run_id
          ? await pgOne<Row>(
              client,
              `SELECT dynamic_instance_id FROM execution.workflow_step_runs WHERE id = $1`,
              [String(row.workflow_step_run_id)],
            )
          : null;
        if (!failedStepRun?.dynamic_instance_id) {
          await finishRunPg(
            client,
            String(row.workflow_run_id),
            "failed",
            recoveryError,
            options.telemetry,
          );
        }
      }
      await appendWorkflowEventPg(client, {
        organizationId: String(row.organization_id),
        workflowRunId: String(row.workflow_run_id),
        workflowStepRunId: row.workflow_step_run_id
          ? String(row.workflow_step_run_id)
          : null,
        workflowTaskId: taskId,
        eventType:
          String(row.status) === "dead_letter"
            ? "TaskDeadLettered"
            : "TaskLeaseExpired",
        payload: { attempt: attemptNumber, reason: recoveryReason },
      });
    }
    return result.rows;
  });
  for (const row of rows) {
    const context = traceContextFromMetadata(
      row.metadata_json,
      String(row.workflow_run_id),
    );
    const span = options.telemetry?.startSpan("workflow.task.lease_recovery", {
      parent: context,
      correlationId: String(row.workflow_run_id),
      attributes: {
        "workflow.run_id": String(row.workflow_run_id),
        "workflow.task_id": String(row.id),
        "workflow.task_kind": String(row.task_kind ?? "unknown"),
      },
    });
    if (String(row.status) === "dead_letter") {
      options.telemetry?.add("beam_workflow_task_dead_letters_total", 1, {
        reason: String(row.recovery_reason ?? "expired_lease"),
        task_kind: String(row.task_kind ?? "unknown"),
      });
    } else {
      options.telemetry?.add("beam_workflow_task_retries_total", 1, {
        reason: String(row.recovery_reason ?? "expired_lease"),
        task_kind: String(row.task_kind ?? "unknown"),
      });
    }
    span?.end(String(row.status) === "dead_letter" ? "error" : "ok", {
      "workflow.transition": String(row.status),
    });
  }
  if (rows.length) {
    options.logger.warn(
      { count: rows.length },
      "Recovered stale PostgreSQL workflow task leases",
    );
  }
}

export async function ensureTaskWakeupsPg(
  pool: PgPool,
  options: OrchestratorOptions,
) {
  await pool.query(
    `
    UPDATE execution.command_outbox outbox
    SET state = 'pending', available_at = now(), claimed_by = NULL,
        claim_expires_at = NULL, updated_at = now()
    FROM execution.workflow_tasks task
    JOIN execution.workflow_runs run ON run.id = task.workflow_run_id
    WHERE outbox.command_type = 'workflow_task.wakeup'
      AND outbox.aggregate_type = 'workflow_task'
      AND outbox.payload_json->>'taskId' = task.id
      AND outbox.state = 'published'
      AND outbox.published_at <= now() - interval '5 seconds'
      AND task.status IN ('queued', 'retry_scheduled')
      AND task.scheduled_at <= now()
      AND run.status = 'running'
    `,
  );
  const result = await pool.query(
    `
    INSERT INTO execution.command_outbox (
      id, command_type, aggregate_type, aggregate_id, transport, subject,
      payload_json, state, available_at, created_at, updated_at
    )
    SELECT
      'cmd_' || substr(md5(t.id || ':' || (t.attempts + 1)::text), 1, 16),
      'workflow_task.wakeup',
      'workflow_task',
      t.id || ':' || (t.attempts + 1)::text,
      'nats',
      t.nats_subject,
      jsonb_build_object(
        'taskId', t.id,
        'workflowRunId', t.workflow_run_id,
        'correlationId', COALESCE(t.metadata_json->'observability'->>'correlationId', t.workflow_run_id),
        'traceparent', t.metadata_json->'observability'->>'traceparent',
        'messageId', t.id || ':' || (t.attempts + 1)::text,
        'taskKind', t.task_kind,
        'actionPackageName', t.action_package_name,
        'targetWorkerId', t.target_worker_id,
        'subject', t.nats_subject
      ),
      'pending',
      GREATEST(t.scheduled_at, now()),
      now(),
      now()
    FROM execution.workflow_tasks t
    JOIN execution.workflow_runs r ON r.id = t.workflow_run_id
    WHERE t.status IN ('queued', 'retry_scheduled')
      AND r.status = 'running'
      AND t.scheduled_at <= now()
    ON CONFLICT (command_type, aggregate_id) DO NOTHING
    `,
  );
  if (result.rowCount) {
    options.logger.info(
      { count: result.rowCount },
      "Recovered task wake-ups from PostgreSQL polling",
    );
  }
}

export async function publishPendingTaskCommandsPg(
  pool: PgPool,
  options: OrchestratorOptions,
) {
  const publisherId = pgId("publisher");
  const rows = await withPostgresTransaction(pool, async (client) => {
    const result = await client.query<Row>(
      `
      WITH candidates AS (
        SELECT id
        FROM execution.command_outbox
        WHERE command_type = 'workflow_task.wakeup'
          AND transport = 'nats'
          AND (
            (state = 'pending' AND available_at <= now())
            OR (state = 'publishing' AND claim_expires_at <= now())
          )
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE execution.command_outbox outbox
      SET state = 'publishing',
          claimed_by = $2,
          claim_expires_at = now() + interval '30 seconds',
          publish_attempts = publish_attempts + 1,
          updated_at = now()
      FROM candidates, execution.workflow_tasks task,
        execution.workflow_step_runs step
      WHERE outbox.id = candidates.id
        AND task.id = outbox.payload_json->>'taskId'
        AND step.id = task.workflow_step_run_id
      RETURNING outbox.*, step.resolved_placement AS placement
      `,
      [options.batchSize, publisherId],
    );
    return result.rows;
  });

  await dispatchBatch(rows, async (row) => {
    const request = objectValue(row.payload_json) as TaskPublishRequest;
    try {
      const kind =
        row.placement === "room-members"
          ? "room-member"
          : ["beamcore-public", "custom", "execution-location"].includes(
                String(row.placement),
              )
            ? "remote-transport"
            : "studio";
      if (kind === "remote-transport" && !options.remoteExecutionEnabled)
        throw new Error(
          "Remote action transport is disabled; enable its explicit integration gate before dispatch.",
        );
      const backend = createExecutorBackend(pool, kind, {
        authorize: options.authorizeExecution,
        dispatch: async (taskId) => {
          if (kind === "room-member") {
            if (!(await dispatchRoomMemberTaskPg(pool, taskId)))
              throw new Error("Room-member dispatch target changed.");
          } else await options.broker.publishTask(request);
        },
      });
      await backend.dispatch(request.taskId);
      await pool.query(
        `
        UPDATE execution.command_outbox
        SET state = 'published', published_at = now(), last_error = NULL,
            claimed_by = NULL, claim_expires_at = NULL, updated_at = now()
        WHERE id = $1 AND state = 'publishing' AND claimed_by = $2
        `,
        [String(row.id), publisherId],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await pool.query(
        `
        UPDATE execution.command_outbox
        SET state = 'pending', last_error = $3,
            available_at = now() + make_interval(secs => LEAST(30, publish_attempts)),
            claimed_by = NULL, claim_expires_at = NULL, updated_at = now()
        WHERE id = $1 AND state = 'publishing' AND claimed_by = $2
        `,
        [String(row.id), publisherId, message],
      );
      options.logger.warn(
        { commandId: row.id, taskId: request.taskId, error },
        "Task wake-up publication deferred",
      );
    }
  });
}

async function enqueueTaskWakeupPg(
  client: PgClient,
  input: TaskPublishRequest & { attemptNumber: number; createdAt: string },
) {
  const aggregateId = `${input.taskId}:${input.attemptNumber}`;
  const payload: TaskPublishRequest = {
    taskId: input.taskId,
    workflowRunId: input.workflowRunId,
    correlationId: input.correlationId,
    traceparent: input.traceparent,
    messageId: aggregateId,
    taskKind: input.taskKind,
    actionPackageName: input.actionPackageName,
    targetWorkerId: input.targetWorkerId,
    subject: input.subject,
  };
  await client.query(
    `
    INSERT INTO execution.command_outbox (
      id, command_type, aggregate_type, aggregate_id, transport, subject,
      payload_json, state, available_at, created_at, updated_at
    )
    VALUES ($1, 'workflow_task.wakeup', 'workflow_task', $2, 'nats', $3,
      $4::jsonb, 'pending', $5, $5, $5)
    ON CONFLICT (command_type, aggregate_id) DO NOTHING
    `,
    [
      pgId("cmd"),
      aggregateId,
      input.subject,
      JSON.stringify(payload),
      input.createdAt,
    ],
  );
}

async function createSkippedStepRunPg(
  client: PgClient,
  workflowRunId: string,
  step: ApiWorkflowStep,
  organizationId: string,
) {
  await createTerminalStepRunPg(
    client,
    workflowRunId,
    step,
    organizationId,
    "skipped",
    "incoming_conditions_not_met",
  );
}

async function createNotReachedStepRunPg(
  client: PgClient,
  workflowRunId: string,
  step: ApiWorkflowStep,
  organizationId: string,
) {
  await createTerminalStepRunPg(
    client,
    workflowRunId,
    step,
    organizationId,
    "not_reached",
    "upstream_not_reached",
  );
}

async function createTerminalStepRunPg(
  client: PgClient,
  workflowRunId: string,
  step: ApiWorkflowStep,
  organizationId: string,
  status: "skipped" | "not_reached" | "failed",
  reason: string,
  dynamicInstanceId: string | null = null,
) {
  const timestamp = now();
  const stepRunId = pgId("wsr");
  const result = await client.query<Row>(
    `
    INSERT INTO execution.workflow_step_runs (
      id, workflow_run_id, workflow_step_id, dynamic_instance_id,
      action_package_name, resolved_version,
      checksum, source_registry, resolved_placement, status, attempt, input_json,
      output_json, metadata_json, state_json, completed_at, created_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1,
      '{}'::jsonb, '{}'::jsonb, $11::jsonb, '{}'::jsonb, $12, $12, $12)
    ON CONFLICT DO NOTHING
    RETURNING id
    `,
    [
      stepRunId,
      workflowRunId,
      step.id,
      dynamicInstanceId,
      step.actionPackage,
      step.resolvedVersion ?? "1.0.0",
      step.checksum ?? "",
      step.sourceRegistry ?? "builtin",
      step.resolvedPlacement ?? step.placement ?? "local-workers",
      status,
      JSON.stringify({ reason }),
      timestamp,
    ],
  );
  await client.query(
    "UPDATE execution.workflow_step_runs SET kind=$2 WHERE id=$1",
    [stepRunId, step.kind ?? "action"],
  );
  if (status === "failed")
    await client.query(
      "UPDATE execution.workflow_step_runs SET error=$2 WHERE id=$1",
      [stepRunId, reason],
    );
  if (dynamicInstanceId) {
    await client.query(
      `UPDATE execution.workflow_dynamic_instances
       SET status = $2, metadata_json = metadata_json || $3::jsonb,
           completed_at = COALESCE(completed_at, $4), updated_at = $4
       WHERE id = $1 AND status IN ('pending','queued')`,
      [dynamicInstanceId, status, JSON.stringify({ reason }), timestamp],
    );
  }
  const actualStepRunId = result.rows[0]?.id ? String(result.rows[0].id) : null;
  await appendWorkflowEventPg(client, {
    organizationId,
    workflowRunId,
    workflowStepRunId: actualStepRunId,
    eventType:
      status === "failed"
        ? "StepFailed"
        : status === "skipped"
          ? "StepSkipped"
          : "StepNotReached",
    payload: { workflowStepId: step.id, dynamicInstanceId, reason },
  });
}

async function finishRunPg(
  client: PgClient,
  workflowRunId: string,
  status: "failed" | "cancelled" | "completed",
  error: string | null,
  telemetry?: OrchestratorOptions["telemetry"],
) {
  const timestamp = now();
  let output: ActionJson = null;
  let outputValidation = "unvalidated";
  if (status === "completed") {
    try {
      output = await resolveRunOutputPg(client, workflowRunId);
      outputValidation = "valid";
    } catch (failure) {
      status = "failed";
      error = failure instanceof Error ? failure.message : String(failure);
      outputValidation = "invalid";
    }
  }
  if (status !== "completed")
    await requestChildCancellationsPg(
      client,
      workflowRunId,
      error ?? "parent workflow ended",
    );
  if (status !== "completed") {
    const pending = await client.query(
      `UPDATE execution.executor_assignments SET state='cancel_requested',cancel_requested_at=COALESCE(cancel_requested_at,now()),updated_at=now()
      WHERE workflow_run_id=$1 AND state IN ('assigned','dispatching','running','cancel_requested','reconciliation_required') RETURNING id`,
      [workflowRunId],
    );
    if (pending.rowCount) return;
  }
  const result = await client.query<Row>(
    `
    UPDATE execution.workflow_runs
    SET status = $2, error = $3, output_json=$5::jsonb, output_validation=$6, completed_at = COALESCE(completed_at, $4), updated_at = $4
    WHERE id = $1 AND status IN ('queued', 'running', 'cancel_requested')
    RETURNING organization_id, workflow_template_id, output_json,
      trigger, trigger_event_json, started_at, completed_at, parent_run_id
    `,
    [
      workflowRunId,
      status,
      error,
      timestamp,
      JSON.stringify(output),
      outputValidation,
    ],
  );
  const row = result.rows[0];
  if (row) {
    telemetry?.add("beam_workflow_runs_total", 1, {
      service: "orchestrator",
      trigger: String(row.trigger ?? "unknown"),
      status,
    });
    const startedAt = Date.parse(String(row.started_at ?? ""));
    const completedAt = Date.parse(String(row.completed_at ?? timestamp));
    if (Number.isFinite(startedAt) && Number.isFinite(completedAt)) {
      telemetry?.observe(
        "beam_workflow_run_duration_seconds",
        Math.max(0, completedAt - startedAt) / 1_000,
        { service: "orchestrator", status },
      );
    }
    await appendWorkflowEventPg(client, {
      organizationId: String(row.organization_id),
      workflowTemplateId: String(row.workflow_template_id),
      workflowRunId,
      eventType:
        status === "completed"
          ? "WorkflowCompleted"
          : status === "cancelled"
            ? "WorkflowCancelled"
            : "WorkflowFailed",
      payload: { error },
    });
    if (!row.parent_run_id && (status === "completed" || status === "failed")) {
      const priorEvent = objectValue(row.trigger_event_json);
      const lineage = [
        ...new Set([
          ...arrayValue(priorEvent.lineage).map(String),
          `workflow:${String(row.workflow_template_id)}`,
        ]),
      ];
      await enqueueCompletionTriggersPg(client, {
        error,
        lineage,
        organizationId: String(row.organization_id),
        output: row.output_json,
        sourceId: String(row.workflow_template_id),
        sourceKind: "workflow",
        sourceRunId: workflowRunId,
        status,
        timestamp,
      });
    }
  }
}

async function cancelActiveTasksAndStepsPg(
  client: PgClient,
  workflowRunId: string,
  organizationId: string,
  steps: ApiWorkflowStep[],
  preservedNodeIds: string[] = [],
) {
  await requestChildCancellationsPg(
    client,
    workflowRunId,
    "parent workflow cancelled",
    preservedNodeIds,
  );
  const timestamp = now();
  await client.query(
    `UPDATE execution.executor_assignments SET state='cancel_requested',cancel_requested_at=COALESCE(cancel_requested_at,now()),updated_at=now()
    WHERE workflow_run_id=$1 AND state IN ('assigned','dispatching','running','reconciliation_required')
    AND task_id IN (SELECT id FROM execution.workflow_tasks WHERE workflow_run_id=$1 AND NOT(workflow_step_id=ANY($2::text[])))`,
    [workflowRunId, preservedNodeIds],
  );

  await client.query(
    `
    UPDATE execution.workflow_tasks
    SET status = 'cancelled',
        error = COALESCE(error, 'cancellation requested'),
        locked_by = NULL,
        leased_by = NULL,
        lock_expires_at = NULL,
        lease_expires_at = NULL,
        claim_token = NULL,
        completed_at = COALESCE(completed_at, $2),
        updated_at = $2
    WHERE workflow_run_id = $1
      AND status IN ('queued', 'retry_scheduled', 'leased', 'running')
      AND NOT EXISTS(SELECT 1 FROM execution.executor_assignments a WHERE a.task_id=execution.workflow_tasks.id AND a.cleanup_confirmed_at IS NULL)
      AND NOT (workflow_step_id=ANY($3::text[]))
    `,
    [workflowRunId, timestamp, preservedNodeIds],
  );
  await client.query(
    `
    UPDATE execution.workflow_task_attempts attempt
    SET status = 'cancelled', error = COALESCE(attempt.error, 'cancellation requested'),
        completed_at = COALESCE(attempt.completed_at, $2)
    FROM execution.workflow_tasks task
    WHERE task.workflow_run_id = $1
      AND NOT (task.workflow_step_id=ANY($3::text[]))
      AND attempt.workflow_task_id = task.id
      AND attempt.status = 'running'
      AND NOT EXISTS(SELECT 1 FROM execution.executor_assignments a WHERE a.task_id=task.id AND a.cleanup_confirmed_at IS NULL)
    `,
    [workflowRunId, timestamp, preservedNodeIds],
  );
  await client.query(
    `
    UPDATE execution.command_outbox outbox
    SET state = 'cancelled', last_error = 'workflow cancellation requested',
        claimed_by = NULL, claim_expires_at = NULL, updated_at = $2
    FROM execution.workflow_tasks task
    WHERE task.workflow_run_id = $1
      AND NOT (task.workflow_step_id=ANY($3::text[]))
      AND outbox.command_type = 'workflow_task.wakeup'
      AND outbox.aggregate_type = 'workflow_task'
      AND outbox.payload_json->>'taskId' = task.id
      AND outbox.state IN ('pending', 'publishing')
    `,
    [workflowRunId, timestamp, preservedNodeIds],
  );
  await client.query(
    `
    UPDATE execution.workflow_step_runs
    SET status = 'cancelled',
        error = COALESCE(error, 'cancellation requested'),
        completed_at = COALESCE(completed_at, $2),
        updated_at = $2
    WHERE workflow_run_id = $1
      AND status IN ('queued', 'running')
      AND NOT (workflow_step_id=ANY($3::text[]))
      AND child_run_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM execution.executor_assignments a WHERE a.workflow_step_run_id=execution.workflow_step_runs.id AND a.cleanup_confirmed_at IS NULL)
    `,
    [workflowRunId, timestamp, preservedNodeIds],
  );
  await client.query(
    `UPDATE execution.workflow_dynamic_instances
     SET status = 'cancelled', error = COALESCE(error, 'workflow cancellation requested'),
         completed_at = COALESCE(completed_at, $2), updated_at = $2
     WHERE workflow_run_id = $1
       AND status IN ('pending', 'queued', 'running')
       AND NOT (workflow_step_id=ANY($3::text[]))
       AND NOT EXISTS (SELECT 1 FROM execution.workflow_step_runs s WHERE s.dynamic_instance_id=execution.workflow_dynamic_instances.id AND s.status IN ('queued','running'))`,
    [workflowRunId, timestamp, preservedNodeIds],
  );
  await client.query(
    `UPDATE execution.workflow_dynamic_regions
     SET status = 'cancel_requested', error = COALESCE(error, 'workflow cancellation requested'),
         cancellation_requested_at = COALESCE(cancellation_requested_at, $2),
         completed_at = COALESCE(completed_at, $2), updated_at = $2
     WHERE workflow_run_id = $1
       AND status IN ('pending', 'expanding', 'running', 'cancel_requested')
       AND NOT (control_id=ANY($3::text[]))`,
    [workflowRunId, timestamp, preservedNodeIds],
  );

  const existingRows = await pgMany<Row>(
    client,
    "SELECT workflow_step_id FROM execution.workflow_step_runs WHERE workflow_run_id = $1",
    [workflowRunId],
  );
  const existingStepIds = new Set(
    existingRows.map((row) => String(row.workflow_step_id)),
  );
  for (const step of steps) {
    if (!existingStepIds.has(step.id) && !preservedNodeIds.includes(step.id)) {
      await createNotReachedStepRunPg(
        client,
        workflowRunId,
        step,
        organizationId,
      );
    }
  }
}

async function hasActiveTasksPg(client: PgClient, workflowRunId: string) {
  const row = await pgOne<Row>(
    client,
    `
    SELECT ((SELECT COUNT(*) FROM execution.workflow_tasks WHERE workflow_run_id=$1 AND status IN ('queued','leased','running','retry_scheduled')) + (SELECT COUNT(*) FROM execution.workflow_runs WHERE parent_run_id=$1 AND status IN ('queued','running','cancel_requested')) + (SELECT COUNT(*) FROM execution.workflow_step_runs WHERE workflow_run_id=$1 AND kind='workflow' AND status IN ('queued','running','cancel_requested')))::int AS count
    `,
    [workflowRunId],
  );
  return Number(row?.count ?? 0) > 0;
}

async function appendWorkflowEventPg(
  client: PgPool | PgClient,
  input: {
    organizationId?: string | null;
    workflowTemplateId?: string | null;
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
      id, organization_id, workflow_template_id, workflow_run_id,
      workflow_step_run_id, workflow_task_id, event_type, event_version,
      subject_type, subject_id, correlation_id, payload_json, created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10, $11::jsonb, $12)
    `,
    [
      pgId("wfev"),
      input.organizationId ?? null,
      input.workflowTemplateId ?? null,
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

function traceContextFromMetadata(
  metadata: unknown,
  correlationId: string,
): TraceContext | null {
  const observability = objectValue(objectValue(metadata).observability);
  return parseTraceparent(
    typeof observability.traceparent === "string"
      ? observability.traceparent
      : undefined,
    typeof observability.correlationId === "string"
      ? observability.correlationId
      : correlationId,
  );
}

function observabilityMetadata(
  correlationId: string,
  context: TraceContext | null | undefined,
) {
  return {
    observability: {
      correlationId,
      ...(context ? { traceparent: formatTraceparent(context) } : {}),
    },
  };
}

function workflowEventSubject(input: {
  workflowTemplateId?: string | null;
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
  if (input.workflowTemplateId) {
    return { type: "workflow_template", id: input.workflowTemplateId };
  }
  return { type: "event", id: input.eventType };
}

async function resolveSteps(client: PgClient, rows: Row[]) {
  return Promise.all(
    rows.map(async (row) => {
      const resolved = await resolveActionPackageVersionPg(
        client,
        String(row.action_package_name),
        String(row.action_version_range ?? "*"),
      );
      const config = objectValue(row.config_json);
      assertActionConfig(
        resolved.manifest,
        config as Record<string, ActionJson>,
      );
      return {
        id: String(row.id),
        name: row.name == null ? null : String(row.name),
        position: Number(row.position ?? 0),
        enabled: booleanValue(row.enabled, true),
        actionPackage: String(row.action_package_name),
        versionRange: String(row.action_version_range ?? "*"),
        config,
        inputBindings: objectValue(row.input_bindings_json),
        resolvedVersion: resolved.version,
        checksum: resolved.manifestChecksum,
        manifestChecksum: resolved.manifestChecksum,
        artifactChecksum: resolved.artifactChecksum,
        artifactSizeBytes: resolved.artifactSizeBytes,
        mediaType: resolved.mediaType,
        sourceRegistry: resolved.sourceRegistry,
        manifestSnapshot: resolved.manifest,
        hippiusBucket: resolved.hippiusBucket,
        hippiusKey: resolved.hippiusKey,
        hippiusEndpoint: resolved.hippiusEndpoint,
        registryArtifactUrl: resolved.registryArtifactUrl,
        resolvedPlacement: String(row.placement ?? "local-workers"),
        executionLocationId: row.execution_location_id
          ? String(row.execution_location_id)
          : null,
        timeoutSeconds: row.timeout_seconds
          ? Number(row.timeout_seconds)
          : null,
        required: booleanValue(row.required, true),
      };
    }),
  );
}

export function workflowStepFromSnapshot(
  row: Row,
  index: number,
): ApiWorkflowStep {
  const manifestSnapshot = objectValue(
    row.manifestSnapshot ?? row.manifest_snapshot,
  );
  return {
    id: String(row.id),
    kind: row.kind === "workflow" ? "workflow" : "action",
    calledWorkflowId: row.calledWorkflowId
      ? String(row.calledWorkflowId)
      : null,
    name: row.name == null ? null : String(row.name),
    position: Number.isInteger(Number(row.position))
      ? Number(row.position)
      : index,
    enabled: booleanValue(row.enabled, true),
    actionPackage: String(row.actionPackage ?? row.action_package ?? ""),
    versionRange: String(row.versionRange ?? row.version_range ?? "*"),
    config: objectValue(row.config) as Record<string, ActionJson>,
    inputBindings: objectValue(row.inputBindings) as Record<string, ActionJson>,
    placement: String(
      row.resolvedPlacement ?? row.placement ?? "local-workers",
    ) as ApiWorkflowStep["placement"],
    executionTarget: row.executionTarget as ApiWorkflowStep["executionTarget"],
    executionLocationId: row.executionLocationId
      ? String(row.executionLocationId)
      : null,
    timeoutSeconds: row.timeoutSeconds ? Number(row.timeoutSeconds) : null,
    required: booleanValue(row.required, true),
    resolvedVersion: row.resolvedVersion
      ? String(row.resolvedVersion)
      : undefined,
    checksum: row.checksum ? String(row.checksum) : undefined,
    manifestChecksum: row.manifestChecksum
      ? String(row.manifestChecksum)
      : undefined,
    artifactChecksum: row.artifactChecksum
      ? String(row.artifactChecksum)
      : undefined,
    artifactSizeBytes: Number.isFinite(Number(row.artifactSizeBytes))
      ? Number(row.artifactSizeBytes)
      : undefined,
    mediaType: row.mediaType ? String(row.mediaType) : undefined,
    sourceRegistry: row.sourceRegistry ? String(row.sourceRegistry) : "builtin",
    manifestSnapshot: Object.keys(manifestSnapshot).length
      ? (manifestSnapshot as ActionManifest)
      : null,
    registryArtifactUrl: row.registryArtifactUrl
      ? String(row.registryArtifactUrl)
      : null,
    hippiusBucket: row.hippiusBucket ? String(row.hippiusBucket) : null,
    hippiusKey: row.hippiusKey ? String(row.hippiusKey) : null,
    hippiusEndpoint: row.hippiusEndpoint ? String(row.hippiusEndpoint) : null,
    resolvedPlacement: String(
      row.resolvedPlacement ?? row.placement ?? "local-workers",
    ) as ApiWorkflowStep["resolvedPlacement"],
  };
}

export function resolvedStepIdentity(step: ApiWorkflowStep) {
  if (step.kind === "workflow")
    return {
      version: "workflow",
      checksum: step.calledWorkflowId ?? "",
      sourceRegistry: "workflow",
    };
  if (step.resolvedVersion && step.checksum) {
    return {
      version: step.resolvedVersion,
      checksum: step.checksum,
      sourceRegistry: step.sourceRegistry ?? "builtin",
    };
  }
  const resolvedPackage = createBuiltinActionRegistry().resolvePackage(
    step.actionPackage,
    step.versionRange,
  );
  return {
    version: resolvedPackage.manifest.version,
    checksum: resolvedPackage.checksum,
    sourceRegistry: "builtin",
  };
}

/**
 * Decisions and their edges, frozen into a run's template snapshot alongside
 * steps, edges and triggers so a run keeps resolving against the graph it
 * started with.
 */
async function decisionSnapshot(client: PgClient, workflowTemplateId: string) {
  const [decisions, decisionEdges] = await Promise.all([
    pgMany<Row>(
      client,
      `SELECT * FROM workflow.decisions WHERE workflow_template_id=$1`,
      [workflowTemplateId],
    ),
    pgMany<Row>(
      client,
      `SELECT * FROM workflow.decision_edges WHERE workflow_template_id=$1`,
      [workflowTemplateId],
    ),
  ]);
  return { decisions, decisionEdges };
}

function edgeSnapshot(row: Row) {
  return {
    id: String(row.id),
    fromStepId: String(row.from_step_id),
    toStepId: String(row.to_step_id),
    // Compare against null explicitly: a stored `false` is falsy, and treating
    // it as absent turns an always-false edge into an unconditional one.
    condition:
      row.condition_json == null ? null : jsonValue(row.condition_json),
  };
}

function triggerEdgeSnapshot(row: Row) {
  return {
    id: String(row.id),
    triggerId: String(row.trigger_id),
    toStepId: String(row.to_step_id),
    condition: row.condition_json ? jsonValue(row.condition_json) : null,
  };
}

function workflowEdgesFromSnapshot(templateSnapshot: Row) {
  const rawEdges = Array.isArray(templateSnapshot.edges)
    ? templateSnapshot.edges
    : [];
  return rawEdges
    .filter((edge): edge is Row => Boolean(edge && typeof edge === "object"))
    .map((edge) => ({
      id: edge.id ? String(edge.id) : undefined,
      from: String(edge.from ?? edge.fromStepId ?? edge.from_step_id ?? ""),
      to: String(edge.to ?? edge.toStepId ?? edge.to_step_id ?? ""),
      condition: (edge.condition ?? null) as ActionJson,
    }));
}

function workflowControlsFromSnapshot(
  templateSnapshot: Row,
): WorkflowGraphV2Control[] {
  const rawControls = Array.isArray(templateSnapshot.controls)
    ? templateSnapshot.controls
    : [];
  return rawControls.filter((control): control is WorkflowGraphV2Control =>
    Boolean(
      control &&
      typeof control === "object" &&
      (String((control as Row).kind) === "loop" ||
        String((control as Row).kind) === "fan-out"),
    ),
  );
}

function taskPublishRequestFromRow(
  row: Row,
  workflowRunId: string,
): TaskPublishRequest {
  return {
    taskId: String(row.id),
    taskKind: String(row.task_kind ?? "step"),
    actionPackageName: String(row.action_package_name ?? ""),
    targetWorkerId: row.target_worker_id ? String(row.target_worker_id) : null,
    subject: row.nats_subject ? String(row.nats_subject) : null,
    placement: String(
      objectValue(row.placement_explanation_json).placement ?? "local-workers",
    ),
    workflowRunId,
    correlationId: workflowRunId,
  };
}

/**
 * Node metadata for bindings and predicates. Status, error, timings and config
 * exist whatever the step did, unlike outputs which exist only on success.
 */
function workflowStepMetadata(stepRuns: Row[], steps: ApiWorkflowStep[]) {
  const stepById = new Map(steps.map((step) => [step.id, step]));
  const metadata = new Map<string, WorkflowStepMetadata>();
  for (const stepRun of stepRuns) {
    const stepId = String(stepRun.workflow_step_id);
    const step = stepById.get(stepId);
    metadata.set(stepId, {
      id: stepId,
      runId: stepRun.child_run_id == null ? null : String(stepRun.child_run_id),
      status: String(stepRun.status),
      error: stepRun.error == null ? null : String(stepRun.error),
      name: step?.name ?? null,
      action: step?.actionPackage ?? null,
      attempt: stepRun.attempt == null ? null : Number(stepRun.attempt),
      startedAt: stepRun.started_at == null ? null : String(stepRun.started_at),
      completedAt:
        stepRun.completed_at == null ? null : String(stepRun.completed_at),
      config: step?.config,
    });
  }
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

function workflowOutputsByStep(stepRuns: Row[]) {
  const outputs = new Map<string, Record<string, ActionJson>>();
  for (const stepRun of stepRuns) {
    if (stepRun.status === "completed") {
      outputs.set(
        String(stepRun.workflow_step_id),
        stepRun.output_json as Record<string, ActionJson>,
      );
    }
  }
  return outputs;
}

function isSettled(row: Row | undefined) {
  return [
    "completed",
    "failed",
    "cancelled",
    "skipped",
    "not_reached",
  ].includes(String(row?.status ?? ""));
}

function packageNameParts(packageName: string) {
  const match = /^(@[^/]+)\/(.+)$/.exec(packageName);
  return {
    scope: match?.[1] ?? "@unknown",
    name: match?.[2] ?? packageName,
  };
}

function categorySlug(manifest: ActionManifest) {
  return slugify(String(manifest.catalog?.category ?? "workflow"));
}

function titleFromSlug(slug: string) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function registryId(prefix: string, value: string) {
  return `${prefix}_${slugify(value).replaceAll("-", "_")}`;
}

function slugify(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replaceAll("/", "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return normalized || "unknown";
}

function objectValue(value: unknown): Row {
  const parsed = jsonValue(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Row)
    : {};
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

function booleanValue(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === undefined || value === null) {
    return fallback;
  }
  return Number(value) === 1 || value === "true";
}

function checksumJson(value: unknown) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}
