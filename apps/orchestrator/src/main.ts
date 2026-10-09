import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  readOrchestrationDatabaseConfig,
  startLiveServiceConfig,
  type PgPool,
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
import { readConfig } from "./config.js";
import {
  createRemoteTaskPreparer,
  startRemoteResultResponder,
  type RemoteResultResponder,
} from "./remoteExecution.js";
import { resilientTaskBroker } from "./nats.js";
import {
  orchestratePg,
  registerBuiltinActionPackagesPg,
} from "./postgresOrchestration.js";
import { startServer, stopServer } from "./server.js";

const config = readConfig();
const baseLogger = createServiceLogger(
  (options) => pino(options),
  "beam-transfer-orchestrator",
);
const logger = redactingLogger(baseLogger);
const telemetry = new Telemetry("orchestrator", {
  traceExporter: new LoggerTraceExporter(logger),
  logExporter: new LoggerLogExporter(logger),
});
let stopping = false;

async function main() {
  const orchestrationConfig = readOrchestrationDatabaseConfig();
  const pgPool: PgPool = createPostgresPool(
    orchestrationConfig.postgresUrl ?? undefined,
    { logger, name: "orchestrator" },
  );
  await ensurePostgresMigrations(pgPool);
  // Admin Ops tuning: the tick settings below are read from it every tick, and
  // the Core admission preflight flags through process.env per run.
  const liveConfig = await startLiveServiceConfig({
    service: "studio-orchestrator",
    pool: pgPool,
    logger,
  });
  await registerBuiltinActionPackagesPg(pgPool);
  const prepareRemoteTask = config.remoteExecution.enabled
    ? createRemoteTaskPreparer(pgPool, config.remoteExecution, logger)
    : undefined;
  const broker = resilientTaskBroker(config.natsUrl, {
    subjectRoot: config.taskSubject,
    streamName: config.taskStream,
    deadLetterSubject: config.deadLetterSubject,
    logger,
    telemetry,
    additionalStreamSubjects: config.remoteExecution.enabled
      ? [config.remoteExecution.taskSubject]
      : undefined,
    preparePublication: prepareRemoteTask,
  });
  let remoteResults: RemoteResultResponder | null = null;
  if (config.remoteExecution.enabled) {
    remoteResults = await startRemoteResultResponder(
      config.natsUrl,
      pgPool,
      config.remoteExecution,
      logger,
    );
  }
  const server = await startServer(config.port, {
    pgPool,
    taskPublisherReady: async () =>
      (await broker.ready()) && (remoteResults?.ready() ?? true),
    telemetry,
    logger: baseLogger,
    liveConfig,
  });

  process.once("SIGINT", () => {
    stopping = true;
  });
  process.once("SIGTERM", () => {
    stopping = true;
  });

  logger.info(
    {
      port: config.port,
      pollIntervalMs: liveConfig.int("ORCHESTRATOR_POLL_INTERVAL_MS"),
      batchSize: liveConfig.int("ORCHESTRATOR_BATCH_SIZE"),
      natsUrl: stripUrlCredentials(config.natsUrl),
      taskSubject: config.taskSubject,
      taskStream: config.taskStream,
      remoteExecutionEnabled: config.remoteExecution.enabled,
      remoteTaskSubject: config.remoteExecution.enabled
        ? config.remoteExecution.taskSubject
        : null,
      remoteResultSubject: config.remoteExecution.enabled
        ? config.remoteExecution.resultSubject
        : null,
    },
    "Orchestrator started",
  );

  while (!stopping) {
    const startedAt = Date.now();
    try {
      await orchestratePg(pgPool, {
        remoteExecutionEnabled: config.remoteExecution.enabled,
        batchSize: liveConfig.int("ORCHESTRATOR_BATCH_SIZE"),
        maxAttempts: liveConfig.int("ORCHESTRATOR_TASK_MAX_ATTEMPTS"),
        taskSubjectRoot: config.taskSubject,
        logger,
        broker,
        telemetry,
      });
    } catch (error) {
      logger.error({ err: error }, "Orchestration tick failed");
    }
    await sleep(
      Math.max(
        250,
        liveConfig.int("ORCHESTRATOR_POLL_INTERVAL_MS") -
          (Date.now() - startedAt),
      ),
    );
  }

  liveConfig.stop();
  await stopServer(server);
  await broker.close();
  await remoteResults?.close();
  await pgPool.end();
  logger.info("Orchestrator stopped");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    logger.error({ error }, "Orchestrator crashed");
    process.exit(1);
  });
}
