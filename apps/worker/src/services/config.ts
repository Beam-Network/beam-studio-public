import { listenHost } from "@beam-studio/shared";
import { defaultAllowedActionPermissions } from "@beam-studio/action-runtime";

export type WorkerConfig = {
  natsUrl: string;
  taskSubject: string;
  taskStream: string;
  deadLetterSubject: string;
  queueGroup: string;
  concurrency: number;
  fleetConcurrency: number;
  lockTtlMs: number;
  jetStreamAckWaitMs: number;
  jetStreamMaxDeliver: number;
  heartbeatIntervalMs: number;
  actionCacheDir: string;
  processOwnershipDir: string;
  actionArtifactStorage: {
    endpoint: string;
    region: string;
    forcePathStyle: boolean;
    accessKeyId?: string;
    secretAccessKey?: string;
  };
  allowedActionPermissions: string[];
  trustedNodeActionPackages: string[];
  trustedNodeAllowedNetwork: string[];
  actionScratchDir: string;
  actionScratchMaxBytes: number;
  actionArtifactMaxBytes: number;
  drainMode: boolean;
  capabilities: string[];
  reachability: "local" | "internet" | "private";
  accessibleEndpoints: string[];
  bandwidthMbps: number;
  networkIdentity: string;
  fileServerEnabled: boolean;
  fileServerHost: string;
  fileServerPort: number;
  fileServerPublicBaseUrl: string;
  fileServerSigningSecret: string;
  fileServerMaxTtlSeconds: number;
  observabilityPort: number;
};

export function readConfig(): WorkerConfig {
  return {
    natsUrl: process.env.NATS_URL ?? "nats://127.0.0.1:4222",
    taskSubject: process.env.NATS_TASK_SUBJECT ?? "beam.workflow.tasks",
    taskStream: process.env.NATS_TASK_STREAM ?? "BEAM_WORKFLOW_TASKS",
    deadLetterSubject:
      process.env.NATS_TASK_DLQ_SUBJECT ?? "beam.workflow.tasks.dlq.permanent",
    queueGroup: process.env.NATS_WORKER_QUEUE_GROUP ?? "beam-workers",
    concurrency: envInt("WORKER_CONCURRENCY", 3),
    fleetConcurrency: envInt(
      "WORKER_FLEET_CONCURRENCY",
      envInt("WORKER_CONCURRENCY", 3),
    ),
    lockTtlMs: envInt("WORKER_LOCK_TTL_MS", 15 * 60_000),
    // The cancellation poll, redelivery delay and action sandbox timeout and
    // memory are live service configuration, read per task (main.ts).
    jetStreamAckWaitMs: envInt("NATS_TASK_ACK_WAIT_MS", 15 * 60_000),
    jetStreamMaxDeliver: envInt("NATS_TASK_MAX_DELIVER", 5),
    heartbeatIntervalMs: envInt("WORKER_HEARTBEAT_INTERVAL_MS", 10_000),
    actionCacheDir:
      process.env.WORKER_ACTION_CACHE_DIR ?? "/tmp/beam-action-cache",
    processOwnershipDir:
      process.env.WORKER_PROCESS_OWNERSHIP_DIR ?? "/data/beam-action-ownership",
    actionArtifactStorage: actionArtifactStorageConfig(),
    allowedActionPermissions: envList(
      "WORKER_ACTION_ALLOWED_PERMISSIONS",
      defaultAllowedActionPermissions,
    ),
    trustedNodeActionPackages: envList(
      "WORKER_TRUSTED_NODE_ACTION_PACKAGES",
      [],
    ),
    trustedNodeAllowedNetwork: envList(
      "WORKER_TRUSTED_NODE_ALLOWED_NETWORK",
      [],
    ),
    actionScratchDir:
      process.env.WORKER_ACTION_SCRATCH_DIR ?? "/tmp/beam-action-scratch",
    actionScratchMaxBytes: envInt(
      "WORKER_ACTION_SCRATCH_MAX_BYTES",
      10 * 1024 * 1024 * 1024,
    ),
    actionArtifactMaxBytes: envInt(
      "WORKER_ACTION_ARTIFACT_MAX_BYTES",
      256 * 1024 * 1024,
    ),
    drainMode: envBool("WORKER_DRAIN_MODE", false),
    capabilities: envList("WORKER_CAPABILITIES", [
      "workflow_tasks",
      "general",
      "transfer",
      "download",
      "upload",
    ]),
    reachability: envReachability("WORKER_REACHABILITY", "local"),
    accessibleEndpoints: envList("WORKER_ACCESSIBLE_ENDPOINTS", [
      "s3",
      "r2",
      "local",
      "beam",
    ]),
    bandwidthMbps: envInt("WORKER_BANDWIDTH_MBPS", 100),
    networkIdentity: process.env.WORKER_NETWORK_ID ?? "",
    fileServerEnabled: envBool("WORKER_FILE_SERVER_ENABLED", false),
    fileServerHost: listenHost("WORKER_FILE_SERVER_HOST"),
    // 8787 is the API's port. On a bare-metal install where both run on the
    // same host that is a straight collision.
    fileServerPort: envInt("WORKER_FILE_SERVER_PORT", 8791),
    fileServerPublicBaseUrl: process.env.WORKER_FILE_SERVER_BASE_URL ?? "",
    fileServerSigningSecret: fileServerSigningSecret(
      envBool("WORKER_FILE_SERVER_ENABLED", false),
    ),
    fileServerMaxTtlSeconds: envInt("WORKER_FILE_SERVER_MAX_TTL_SECONDS", 3600),
    observabilityPort: envInt("WORKER_OBSERVABILITY_PORT", 8790),
  };
}

function envInt(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function envBool(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function envList(name: string, fallback: string[]) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function envReachability(name: string, fallback: WorkerConfig["reachability"]) {
  const value = process.env[name];
  return value === "internet" || value === "private"
    ? value
    : fallback;
}

function actionArtifactStorageConfig(): WorkerConfig["actionArtifactStorage"] {
  const accessKeyId =
    process.env.HIPPIUS_S3_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    process.env.HIPPIUS_S3_SECRET_ACCESS_KEY ??
    process.env.AWS_SECRET_ACCESS_KEY;
  return {
    endpoint: process.env.HIPPIUS_S3_ENDPOINT ?? "https://s3.hippius.com",
    region: process.env.HIPPIUS_S3_REGION ?? "decentralized",
    forcePathStyle: process.env.HIPPIUS_S3_FORCE_PATH_STYLE !== "false",
    ...(accessKeyId ? { accessKeyId } : {}),
    ...(secretAccessKey ? { secretAccessKey } : {}),
  };
}

/**
 * A per-process random secret was the previous fallback. It made signed file
 * URLs stop verifying after any restart and never verify across replicas, so it
 * was a correctness bug as much as a weak default. When the file server is on,
 * the secret has to be configured and shared.
 */
function fileServerSigningSecret(enabled: boolean) {
  const configured = process.env.WORKER_FILE_SERVER_SIGNING_SECRET?.trim();
  if (configured) return configured;
  if (enabled) {
    throw new Error(
      "WORKER_FILE_SERVER_SIGNING_SECRET is required when WORKER_FILE_SERVER_ENABLED " +
        "is true; signed URLs must stay valid across restarts and replicas.",
    );
  }
  return "";
}
