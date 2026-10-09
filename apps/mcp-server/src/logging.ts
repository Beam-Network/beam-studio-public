import {
  createServiceLogger,
  stripUrlCredentials,
} from "@beam-studio/shared/logging";
import pino from "pino";

/** The MCP server logger: level from `LOG_LEVEL`, shared redaction. */
export function createMcpLogger(
  env: Record<string, string | undefined> = process.env,
  destination?: pino.DestinationStream,
) {
  return createServiceLogger(
    (options) => (destination ? pino(options, destination) : pino(options)),
    "beam-transfer-mcp",
    { env },
  );
}

/**
 * Fields of the "MCP server started" line. The database connection string
 * carries the Postgres password, so only its credential-free form is logged.
 */
export function mcpStartupLogFields(options: {
  host: string;
  port: number;
  databaseUrl: string;
}) {
  return {
    host: options.host,
    port: options.port,
    endpoint: `http://${options.host}:${options.port}/mcp`,
    database: stripUrlCredentials(options.databaseUrl),
  };
}
