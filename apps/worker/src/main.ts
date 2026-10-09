import crypto from "node:crypto";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  createPostgresPool,
  readOrchestrationDatabaseConfig,
  startLiveServiceConfig,
} from "@beam-studio/db";
import pino from "pino";
import {
  createServiceLogger,
  stripUrlCredentials,
} from "@beam-studio/shared/logging";
import {
  LoggerLogExporter,
  LoggerTraceExporter,
  Telemetry,
  redactingLogger,
} from "@beam-studio/telemetry";
import { readConfig } from "./services/config.js";
import { connectNats, subscribeToTasks } from "./services/nats.js";
import {
  deleteWorkflowObject,
  downloadWorkflowObject,
  uploadWorkflowObject,
} from "./services/objectStorage.js";
import {
  isPostgresWorkerMarkedDraining,
  markPostgresWorkerStopped,
  registerPostgresWorkerInstance,
  startPostgresWorkerHeartbeat,
  updatePostgresWorkerHeartbeat,
} from "./services/postgresLifecycle.js";
import { createPostgresTaskWorker } from "./services/postgresTaskWorker.js";
import { reconcileWorkerProcesses } from "./services/processRecovery.js";
import { probeProcessOwnership } from "@beam-studio/action-runtime";
import { startWorkerFileServer } from "./services/workerFileServer.js";
import type { WorkerRuntimeDeclaration } from "./services/workerRuntime.js";
import { startWorkerServer, stopWorkerServer } from "./services/server.js";

const config = readConfig();
const workerId = `${hostname()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
let runtimeDeclaration: WorkerRuntimeDeclaration = {
  concurrency: config.concurrency,
  capabilities: config.capabilities,
  reachability: config.reachability,
  accessibleEndpoints: config.accessibleEndpoints,
  bandwidthMbps: config.bandwidthMbps,
  networkIdentity: config.networkIdentity || hostname(),
};
const logger = redactingLogger(
  createServiceLogger((options) => pino(options), "beam-transfer-worker", {
    extraRedactPaths: ["api_token", "*.api_token", "sig", "*.sig"],
  }).child({ workerId }),
);
const telemetry = new Telemetry("worker", {
  traceExporter: new LoggerTraceExporter(logger),
  logExporter: new LoggerLogExporter(logger),
});

let stopping = false;
let draining = config.drainMode;
/** The live service configuration status, set once it has started. */
let reportConfigStatus: (() => unknown) | undefined;

async function main() {
  const orchestrationConfig = readOrchestrationDatabaseConfig();
  const pgPool = createPostgresPool(
    orchestrationConfig.postgresUrl ?? undefined,
    { logger, name: "worker" },
  );
  let reportConfigNow: (() => void) | null = null;
  const liveConfig = await startLiveServiceConfig({
    service: "studio-worker",
    pool: pgPool,
    instanceId: workerId,
    logger,
    onChange: () => reportConfigNow?.(),
  });
  const reportConfig = () => liveConfig.status();
  reportConfigStatus = reportConfig;
  const observabilityServer = await startWorkerServer(
    config.observabilityPort,
    { pgPool, telemetry },
  );
  const fileServer = config.fileServerEnabled
    ? await startWorkerFileServer({
        workerId,
        host: config.fileServerHost,
        port: config.fileServerPort,
        publicBaseUrl: config.fileServerPublicBaseUrl || undefined,
        signingSecret: config.fileServerSigningSecret,
        maxTtlSeconds: config.fileServerMaxTtlSeconds,
      })
    : null;
  runtimeDeclaration = runtimeDeclarationWithFileServer(
    runtimeDeclaration,
    fileServer?.metadata,
  );
  const nats = await connectNats(config.natsUrl, logger);
  await probeProcessOwnership();
  await registerPostgresWorkerInstance(
    pgPool,
    workerId,
    runtimeDeclaration,
    reportConfig,
  );
  const stopHeartbeat = startPostgresWorkerHeartbeat(
    pgPool,
    workerId,
    config.heartbeatIntervalMs,
    runtimeDeclaration,
    reportConfig,
  );
  reportConfigNow = () =>
    void updatePostgresWorkerHeartbeat(
      pgPool,
      workerId,
      runtimeDeclaration,
      reportConfig,
    ).catch(() => {
      // Best effort, like the periodic heartbeat.
    });
  let recovery: Promise<unknown> | null = null;
  const reconcile = () => {
    if (recovery) return recovery;
    recovery = reconcileWorkerProcesses(pgPool)
      .catch((error) =>
        logger.error({ error }, "Action process recovery remains pending"),
      )
      .finally(() => {
        recovery = null;
      });
    return recovery;
  };
  await reconcile();
  const recoveryTimer = setInterval(() => void reconcile(), 5_000);
  recoveryTimer.unref();
  const taskWorker = createPostgresTaskWorker(pgPool, {
    workerId,
    concurrency: config.concurrency,
    lockTtlMs: config.lockTtlMs,
    // Getters: each task reads the current value when it starts.
    get cancellationPollIntervalMs() {
      return liveConfig.int("WORKER_CANCELLATION_POLL_INTERVAL_MS");
    },
    maxAttempts: 3,
    actionCacheDir: config.actionCacheDir,
    processOwnershipDir: config.processOwnershipDir,
    actionArtifactStorage: config.actionArtifactStorage,
    allowedActionPermissions: config.allowedActionPermissions,
    trustedNodeActionPackages: config.trustedNodeActionPackages,
    trustedNodeAllowedNetwork: config.trustedNodeAllowedNetwork,
    get actionSandboxTimeoutMs() {
      return liveConfig.int("WORKER_ACTION_SANDBOX_TIMEOUT_MS");
    },
    get actionSandboxMemoryMb() {
      return liveConfig.int("WORKER_ACTION_SANDBOX_MEMORY_MB");
    },
    actionScratchDir: config.actionScratchDir,
    actionScratchMaxBytes: config.actionScratchMaxBytes,
    logger,
    telemetry,
    downloadObject: (endpoint) =>
      downloadWorkflowObject(pgPool, endpoint, {
        workerFileSigningSecret: config.fileServerSigningSecret,
      }),
    uploadObject: (endpoint, content, options) =>
      uploadWorkflowObject(pgPool, endpoint, content, options),
    deleteObject: (endpoint) => deleteWorkflowObject(pgPool, endpoint),
    fileServer: fileServer ?? undefined,
  });

  process.once("SIGINT", () => void requestStop(pgPool, "SIGINT"));
  process.once("SIGTERM", () => void requestStop(pgPool, "SIGTERM"));
  process.once("SIGUSR2", () => void requestDrain(pgPool, "SIGUSR2"));
  const subscription = await subscribeToTasks(
    nats,
    {
      subjectRoot: config.taskSubject,
      streamName: config.taskStream,
      queueGroup: config.queueGroup,
      workerId,
      concurrency: config.concurrency,
      fleetConcurrency: config.fleetConcurrency,
      ackWaitMs: config.jetStreamAckWaitMs,
      maxDeliver: config.jetStreamMaxDeliver,
      // Read per message.
      get redeliveryDelayMs() {
        return liveConfig.int("NATS_TASK_REDELIVERY_DELAY_MS");
      },
      deadLetterSubject: config.deadLetterSubject,
      logger,
      telemetry,
    },
    async (message) => {
      if (
        draining ||
        (await isPostgresWorkerMarkedDraining(pgPool, workerId))
      ) {
        return {
          status: "retry",
          retryDelayMs: liveConfig.int("NATS_TASK_REDELIVERY_DELAY_MS"),
        };
      }
      return taskWorker.processTaskId(message.taskId, message);
    },
  );

  logger.info(
    {
      database: "postgresql",
      concurrency: config.concurrency,
      fleetConcurrency: config.fleetConcurrency,
      natsUrl: stripUrlCredentials(config.natsUrl),
      taskSubject: config.taskSubject,
      taskStream: config.taskStream,
      queueGroup: config.queueGroup,
      drainMode: config.drainMode,
      capabilities: config.capabilities,
      reachability: config.reachability,
      observabilityPort: config.observabilityPort,
    },
    "Task worker started",
  );

  while (!stopping) {
    await sleep(250);
  }

  await subscription.close();
  await stopWorkerServer(observabilityServer);
  logger.info({}, "NATS connection drain requested");
  await nats.drain();
  logger.info({}, "NATS connection drained");
  stopHeartbeat();
  liveConfig.stop();
  clearInterval(recoveryTimer);
  await recovery;
  if (fileServer) {
    await fileServer.close();
  }
  await markPostgresWorkerStopped(pgPool, workerId);
  await pgPool.end();
  logger.info("Task worker stopped");
}

function runtimeDeclarationWithFileServer(
  declaration: WorkerRuntimeDeclaration,
  fileServer: WorkerRuntimeDeclaration["fileServer"] | undefined,
): WorkerRuntimeDeclaration {
  if (!fileServer) {
    return declaration;
  }
  return {
    ...declaration,
    capabilities: unique([...declaration.capabilities, "worker-file-export"]),
    accessibleEndpoints: unique([
      ...declaration.accessibleEndpoints,
      "beam-worker-http",
    ]),
    fileServer,
  };
}

function unique(values: string[]) {
  return [...new Set(values)];
}

async function requestStop(
  pgPool: Parameters<typeof markPostgresWorkerStopped>[0],
  signal: string,
) {
  stopping = true;
  draining = true;
  logger.info({ signal }, "Task worker shutdown requested");
  await updatePostgresWorkerHeartbeat(
    pgPool,
    workerId,
    runtimeDeclaration,
    reportConfigStatus,
  );
}

async function requestDrain(
  pgPool: Parameters<typeof markPostgresWorkerStopped>[0],
  reason: string,
) {
  draining = true;
  logger.info({ reason }, "Task worker drain requested");
  await updatePostgresWorkerHeartbeat(
    pgPool,
    workerId,
    runtimeDeclaration,
    reportConfigStatus,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    logger.error({ err: error }, "Task worker crashed");
    process.exit(1);
  });
}
