import type { SqlDatabase } from "@beam-studio/db";
import {
  taskCapabilityToken,
  type ActionJson,
} from "@beam-studio/core";
import { parseJsonArray } from "./utils.js";
import type { Row } from "./types.js";

export type PlacementDecision = {
  workerId: string | null;
  capability: string;
  sourceLocality: string | null;
  destinationLocality: string | null;
  estimatedBandwidthMbps: number | null;
  loadScore: number | null;
};

export type PlacementRequest = {
  actionPackageName: string;
  taskKind: string;
  inputs: Record<string, ActionJson>;
  targetWorkerId?: string | null;
};

export function selectWorker(
  db: SqlDatabase,
  request: PlacementRequest,
): PlacementDecision {
  const capability = taskCapabilityToken(
    request.actionPackageName,
    request.taskKind,
  );
  const locality = inferLocality(request.inputs);
  const candidates = activeWorkerRows(db)
    .map(workerCandidate)
    .filter((worker) =>
      request.targetWorkerId ? worker.id === request.targetWorkerId : true,
    )
    .filter((worker) => supportsCapability(worker, capability));

  const ranked = candidates
    .map((worker) => ({
      worker,
      score: placementScore(worker, locality),
    }))
    .sort((left, right) => left.score - right.score);
  const selected = ranked[0]?.worker ?? null;

  return {
    workerId: selected?.id ?? null,
    capability,
    sourceLocality: locality.source,
    destinationLocality: locality.destination,
    estimatedBandwidthMbps: selected?.bandwidthMbps ?? null,
    loadScore: selected?.loadScore ?? null,
  };
}

export function estimateGlobalLoad(db: SqlDatabase) {
  const row = db
    .prepare(
      `
      SELECT
        COUNT(*) AS worker_count,
        COALESCE(SUM(active_task_count), 0) AS active_tasks,
        COALESCE(AVG(load_score), 0) AS avg_load,
        COALESCE(SUM(bandwidth_mbps), 0) AS bandwidth_mbps
      FROM worker_runtime_state
      WHERE status = 'active'
        AND heartbeat_at >= :heartbeatAfter
    `,
    )
    .get({ heartbeatAfter: heartbeatAfter() }) as Row | undefined;
  const queued = db
    .prepare(
      "SELECT COUNT(*) AS count FROM workflow_tasks WHERE status = 'queued'",
    )
    .get() as Row | undefined;
  return {
    activeWorkerCount: Number(row?.worker_count ?? 0),
    activeTaskCount: Number(row?.active_tasks ?? 0),
    averageLoadScore: Number(row?.avg_load ?? 0),
    estimatedBandwidthMbps: Number(row?.bandwidth_mbps ?? 0),
    queuedTaskCount: Number(queued?.count ?? 0),
  };
}

function activeWorkerRows(db: SqlDatabase) {
  return db
    .prepare(
      `
      SELECT *
      FROM worker_runtime_state
      WHERE status = 'active'
        AND heartbeat_at >= :heartbeatAfter
    `,
    )
    .all({ heartbeatAfter: heartbeatAfter() }) as Row[];
}

type WorkerCandidate = {
  id: string;
  capabilities: string[];
  endpoints: string[];
  activeTasks: number;
  loadScore: number;
  bandwidthMbps: number;
};

function workerCandidate(row: Row): WorkerCandidate {
  return {
    id: String(row.worker_id),
    capabilities: parseJsonArray(row.capabilities_json).map(String),
    endpoints: parseJsonArray(row.accessible_endpoints_json).map((value) =>
      typeof value === "string"
        ? value
        : String((value as Record<string, unknown>)?.provider ?? ""),
    ),
    activeTasks: Number(row.active_task_count ?? 0),
    loadScore: Number(row.load_score ?? 1),
    bandwidthMbps: Number(row.bandwidth_mbps ?? 0),
  };
}

function supportsCapability(worker: WorkerCandidate, capability: string) {
  const capabilities = new Set(worker.capabilities);
  return (
    capabilities.has(capability) ||
    capabilities.has("general") ||
    capabilities.has("workflow_tasks")
  );
}

function placementScore(
  worker: WorkerCandidate,
  locality: { source: string | null; destination: string | null },
) {
  const endpointSet = new Set(worker.endpoints);
  const sourceBonus =
    locality.source && endpointSet.has(locality.source) ? -1 : 0;
  const destinationBonus =
    locality.destination && endpointSet.has(locality.destination) ? -1 : 0;
  const bandwidthBonus =
    worker.bandwidthMbps > 0 ? -worker.bandwidthMbps / 1_000 : 0;
  return (
    worker.loadScore +
    worker.activeTasks * 0.2 +
    sourceBonus +
    destinationBonus +
    bandwidthBonus
  );
}

function inferLocality(inputs: Record<string, ActionJson>) {
  const flat = flattenObjects(inputs);
  return {
    source: providerFrom(
      flat.find((value) => value.role === "source") ?? flat[0],
    ),
    destination: providerFrom(
      flat.find((value) => value.role === "destination") ?? flat[1],
    ),
  };
}

function flattenObjects(value: ActionJson): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(flattenObjects);
  }
  const object = value as Record<string, unknown>;
  return [
    object,
    ...Object.values(object).flatMap((child) =>
      flattenObjects(child as ActionJson),
    ),
  ];
}

function providerFrom(value: Record<string, unknown> | undefined) {
  const provider = String(value?.provider ?? "")
    .trim()
    .toLowerCase();
  return provider || null;
}

function heartbeatAfter() {
  return new Date(Date.now() - 45_000).toISOString();
}
