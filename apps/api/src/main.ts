import { encryptPlaintextWebhookTokens } from "./studio/webhook-token-migration.js";
import {
  persistRegistryBuiltinActionsPg,
  pruneRemovedBuiltinActionsPg,
} from "./studio/store.js";
import { ensurePreinstalledRegistryActions } from "./studio/preinstalled-actions.js";
import { pathToFileURL } from "node:url";
import {
  recordRoomTransferActionState,
  withContractCheck,
} from "./studio/room-transfer-action-state.js";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  readOrchestrationDatabaseConfig,
  startLiveServiceConfig,
  type PgPool,
} from "@beam-studio/db";
import { createApiLogger } from "./logging.js";
import {
  LoggerLogExporter,
  LoggerTraceExporter,
  Telemetry,
} from "@beam-studio/telemetry";
import { applyInstanceOwnerLever } from "./auth/instance-bootstrap.js";
import { createInstanceKeyService } from "./studio/instance-key.js";
import { readConfig } from "./config.js";
import { startServer, stopServer } from "./server.js";
import { startCreditSettlementLoop } from "./billing/credit-settlement.js";
import {
  ensureRoomTransferActionV2Installed,
  migrateRoomTransferWorkflowsV2,
} from "./agent-control/room-workflow-v2-migration.js";

const config = readConfig();
const logger = createApiLogger();
const telemetry = new Telemetry("api", {
  traceExporter: new LoggerTraceExporter(logger),
  logExporter: new LoggerLogExporter(logger),
});

async function main() {
  const orchestrationConfig = readOrchestrationDatabaseConfig();
  // The factory also registers the idle-connection error handler, so a
  // PostgreSQL restart is logged and recovered from instead of ending the API.
  const pgPool: PgPool = createPostgresPool(
    orchestrationConfig.postgresUrl ?? undefined,
    { logger, name: "api" },
  );
  await ensurePostgresMigrations(pgPool);
  // Never fatal: a bad value is logged and ownership is left as it was.
  await applyInstanceOwnerLever(
    pgPool,
    process.env.BEAM_STUDIO_OWNER_ORGANIZATION_ID,
    logger,
    (organizationId) => createInstanceKeyService().revoke(organizationId),
  );
  // Converts webhook tokens left in plaintext, without changing their values.
  const webhookTokens = await encryptPlaintextWebhookTokens(pgPool);
  if (webhookTokens.converted) {
    logger.info(webhookTokens, "Encrypted plaintext webhook trigger tokens");
  }
  await persistRegistryBuiltinActionsPg(pgPool, new Date().toISOString());
  // Builtins are only upserted above; drop the ones this release no longer ships.
  const prunedBuiltins = await pruneRemovedBuiltinActionsPg(pgPool);
  if (prunedBuiltins.length) {
    logger.info(
      { packages: prunedBuiltins },
      "Removed builtin actions this Studio no longer ships",
    );
  }
  const installed = await ensureRoomTransferActionV2Installed(pgPool);
  const roomAction = installed.available
    ? await withContractCheck(pgPool, installed)
    : installed;
  recordRoomTransferActionState(roomAction);
  if (roomAction.installed) {
    logger.info("Installed @beam/room-transfer@2.1.2 from the public Registry");
  }
  if (!roomAction.available) {
    // Deliberately not fatal. The Registry is an external service, and Studio
    // serving credentials, workflows and runs does not depend on it. Room
    // transfers report their own unavailability instead.
    logger.error(
      { reason: roomAction.reason },
      "@beam/room-transfer@2.1.2 is unavailable; room transfers are disabled until it is installed",
    );
  }
  // The migration updates room-transfer steps to the 2.1.2 action release, so it
  // needs that action present. Without it there is nothing to migrate onto.
  if (roomAction.available) {
    const roomWorkflowMigration = await migrateRoomTransferWorkflowsV2(pgPool);
    if (roomWorkflowMigration.migrated > 0) {
      logger.info(
        {
          migrated: roomWorkflowMigration.migrated,
          workflowIds: roomWorkflowMigration.workflowIds,
        },
        "Migrated room-transfer workflows to the member-neutral action contract",
      );
    }
    if (roomWorkflowMigration.deferredWorkflowIds.length > 0) {
      logger.warn(
        { workflowIds: roomWorkflowMigration.deferredWorkflowIds },
        "Deferred room-transfer action migration until active runs finish",
      );
    }
  }
  const liveConfig = await startLiveServiceConfig({
    service: "studio-api",
    pool: pgPool,
    logger,
  });
  const server = await startServer(config.port, {
    pgPool,
    logger,
    telemetry,
    liveConfig,
  });

  // Not awaited: the Registry is an external service, and Studio serves
  // everything else without it. A failed install stays installable by hand.
  void ensurePreinstalledRegistryActions(pgPool).then((outcomes) => {
    for (const { packageName, outcome, reason } of outcomes) {
      if (outcome === "installed") {
        logger.info(
          { packageName },
          "Installed a preinstalled action from the Registry",
        );
      } else if (outcome === "failed") {
        logger.warn(
          { packageName, reason },
          "Could not install a preinstalled action; install it from the Registry page",
        );
      }
    }
  });

  // Settle credit holds for runs that have finished. Deliberately a background
  // pass rather than a step in the run lifecycle: billing must never sit between
  // a run and its next state.
  const creditSettlement = startCreditSettlementLoop(pgPool, logger);

  const stop = async (signal: string) => {
    logger.info({ signal }, "API shutdown requested");
    creditSettlement.stop();
    liveConfig.stop();
    await stopServer(server);
    await pgPool.end();
    logger.info("API stopped");
  };

  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));

  logger.info(
    {
      port: config.port,
    },
    "API started",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    logger.error({ err: error }, "API crashed");
    process.exit(1);
  });
}
