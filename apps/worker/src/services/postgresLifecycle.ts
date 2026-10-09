import { cpus, freemem, hostname, loadavg, totalmem } from "node:os";
import {
  pgOne,
  withPostgresTransaction,
  type PgPool,
} from "@beam-studio/db";
import { beamRevision } from "@beam-studio/shared";
import type { WorkerRuntimeDeclaration } from "./workerRuntime.js";

type Row = Record<string, unknown>;
export type ReportConfig = () => unknown;

export async function registerPostgresWorkerInstance(
  pool: PgPool,
  workerId: string,
  declaration: WorkerRuntimeDeclaration,
  reportConfig?: ReportConfig,
) {
  await updatePostgresWorkerHeartbeat(
    pool,
    workerId,
    declaration,
    reportConfig,
  );
}

export function startPostgresWorkerHeartbeat(
  pool: PgPool,
  workerId: string,
  intervalMs: number,
  declaration: WorkerRuntimeDeclaration,
  reportConfig?: ReportConfig,
) {
  const timer = setInterval(() => {
    updatePostgresWorkerHeartbeat(
      pool,
      workerId,
      declaration,
      reportConfig,
    ).catch(() => {
      // The main task loop will surface connection failures; heartbeat is best effort.
    });
  }, intervalMs);
  timer.unref();
  void updatePostgresWorkerHeartbeat(pool, workerId, declaration, reportConfig);
  return () => clearInterval(timer);
}

export async function updatePostgresWorkerHeartbeat(
  pool: PgPool,
  workerId: string,
  declaration: WorkerRuntimeDeclaration,
  reportConfig?: ReportConfig,
) {
  const timestamp = now();
  const runtime = await runtimeMetrics(pool, workerId, declaration);
  await withPostgresTransaction(pool, async (client) => {
    await client.query(
      `
      INSERT INTO runtime.worker_runtime_state (
        worker_id, network_identity, status, capabilities_json, reachability,
        accessible_endpoints_json, cpu_load, memory_used_bytes,
        memory_total_bytes, bandwidth_mbps, active_task_count, load_score,
        heartbeat_at, metadata_json, updated_at, version
      )
      VALUES (
        $1, $2, 'active', $3::jsonb, $4, $5::jsonb, $6, $7,
        $8, $9, $10, $11, $12, $13::jsonb, $12, $14
      )
      ON CONFLICT(worker_id) DO UPDATE SET
        network_identity = EXCLUDED.network_identity,
        status = CASE
          WHEN runtime.worker_runtime_state.status = 'draining' THEN runtime.worker_runtime_state.status
          ELSE EXCLUDED.status
        END,
        capabilities_json = EXCLUDED.capabilities_json,
        reachability = EXCLUDED.reachability,
        accessible_endpoints_json = EXCLUDED.accessible_endpoints_json,
        cpu_load = EXCLUDED.cpu_load,
        memory_used_bytes = EXCLUDED.memory_used_bytes,
        memory_total_bytes = EXCLUDED.memory_total_bytes,
        bandwidth_mbps = EXCLUDED.bandwidth_mbps,
        active_task_count = EXCLUDED.active_task_count,
        load_score = EXCLUDED.load_score,
        heartbeat_at = EXCLUDED.heartbeat_at,
        metadata_json = EXCLUDED.metadata_json,
        updated_at = EXCLUDED.updated_at,
        version = EXCLUDED.version
      `,
      [
        workerId,
        declaration.networkIdentity || hostname(),
        JSON.stringify(declaration.capabilities),
        declaration.reachability,
        JSON.stringify(declaration.accessibleEndpoints),
        runtime.cpuLoad,
        runtime.memoryUsedBytes,
        runtime.memoryTotalBytes,
        declaration.bandwidthMbps,
        runtime.activeTaskCount,
        runtime.loadScore,
        timestamp,
        JSON.stringify(metadata(workerId, declaration, reportConfig)),
        beamRevision(),
      ],
    );

    await client.query(
      "DELETE FROM runtime.worker_capabilities WHERE worker_id = $1",
      [workerId],
    );
    for (const capability of declaration.capabilities) {
      await client.query(
        `
        INSERT INTO runtime.worker_capabilities (
          id, worker_id, capability, version_range, metadata_json, created_at, updated_at
        )
        VALUES ($1, $2, $3, '*', '{}'::jsonb, $4, $4)
        ON CONFLICT(worker_id, capability) DO UPDATE SET
          updated_at = EXCLUDED.updated_at
        `,
        [`wc_${workerId}_${capability}`, workerId, capability, timestamp],
      );
    }
  });
}

export async function markPostgresWorkerStopped(
  pool: PgPool,
  workerId: string,
) {
  const timestamp = now();
  await pool.query(
    `
    UPDATE runtime.worker_runtime_state
    SET status = 'stopped', heartbeat_at = $2, updated_at = $2
    WHERE worker_id = $1
    `,
    [workerId, timestamp],
  );
}

export async function isPostgresWorkerMarkedDraining(
  pool: PgPool,
  workerId: string,
) {
  const row = await pgOne<Row>(
    pool,
    "SELECT status FROM runtime.worker_runtime_state WHERE worker_id = $1",
    [workerId],
  );
  return row?.status === "draining";
}

async function runtimeMetrics(
  pool: PgPool,
  workerId: string,
  declaration: WorkerRuntimeDeclaration,
) {
  const memoryTotalBytes = totalmem();
  const memoryUsedBytes = memoryTotalBytes - freemem();
  const cpuLoad = (loadavg()[0] ?? 0) / Math.max(1, cpus().length);
  const activeTaskCount = await activeTasks(pool, workerId);
  const memoryPressure = memoryUsedBytes / Math.max(1, memoryTotalBytes);
  return {
    cpuLoad,
    memoryUsedBytes,
    memoryTotalBytes,
    activeTaskCount,
    loadScore:
      cpuLoad +
      memoryPressure +
      activeTaskCount / Math.max(1, declaration.concurrency),
  };
}

async function activeTasks(pool: PgPool, workerId: string) {
  const row = await pgOne<Row>(
    pool,
    `
    SELECT COUNT(*) AS count
    FROM execution.workflow_tasks
    WHERE status = 'running'
      AND (locked_by = $1 OR leased_by = $1)
    `,
    [workerId],
  );
  return Number(row?.count ?? 0);
}

function metadata(
  workerId: string,
  declaration: WorkerRuntimeDeclaration,
  reportConfig?: ReportConfig,
) {
  return {
    role: "task-worker",
    workerId,
    networkIdentity: declaration.networkIdentity || hostname(),
    capabilities: declaration.capabilities,
    reachability: declaration.reachability,
    accessibleEndpoints: declaration.accessibleEndpoints,
    ...(declaration.fileServer ? { fileServer: declaration.fileServer } : {}),
    ...(reportConfig ? { config: reportConfig() } : {}),
  };
}

function now() {
  return new Date().toISOString();
}
