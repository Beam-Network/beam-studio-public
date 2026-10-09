import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import {
  hostAllowed,
  listenHost,
  MCP_RESOURCE_SCOPE_REQUIREMENTS,
  MCP_TOOL_SCOPE_REQUIREMENTS,
  // Stated on the tools that choose storage credentials.
  UNRESTRICTED_STORAGE_CREDENTIALS_RULE as UNRESTRICTED_STORAGE_RULE,
  type McpScope,
} from "@beam-studio/shared";
import { isPostgresUnavailableError } from "@beam-studio/db";
import { vaultSecretFromEnv } from "@beam-studio/vault";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  answerDatabaseOutageInstead,
  noteDatabaseOutage,
  writeMcpFailure,
  type DatabaseOutage,
} from "./database-outage.js";
import { createMcpLogger, mcpStartupLogFields } from "./logging.js";
import { mcpResourceNames } from "./resources/index.js";
import { mcpToolNames } from "./tools/index.js";
import {
  logMcpRequest,
  startMcpOperation,
  type McpRequestLog,
} from "./request-log.js";
import {
  authenticateMcpToken,
  cancelRun,
  checkStudioDatabase,
  createSchedule,
  createTransfer,
  getRun,
  getRunByBeamTransferId,
  getStudioDatabasePath,
  getTransfer,
  listApiKeys,
  listCredentials,
  listRuns,
  listSchedules,
  listTransfers,
  McpOrganizationNotAdmittedError,
  recordMcpAuditEvent,
  startRun,
  type McpTokenAuth,
} from "./studio-store.js";

loadLocalEnv();
vaultSecretFromEnv();

const port = Number(process.env.MCP_SERVER_PORT ?? 8766);
const host = listenHost("MCP_SERVER_HOST");
const serverVersion = "0.1.0";
const authRateLimitPerMinute = Number(
  process.env.MCP_AUTH_RATE_LIMIT_PER_MINUTE ?? 60,
);
const tokenRateLimitPerMinute = Number(
  process.env.MCP_TOKEN_RATE_LIMIT_PER_MINUTE ?? 120,
);
const logger = createMcpLogger();

type RequestMetadata = {
  ipAddress: string | null;
  userAgent: string | null;
  clientName: string | null;
  /** What the per-request log line reports; see request-log.ts. */
  log?: McpRequestLog;
  /** Set while an MCP request is served; see database-outage.ts. */
  databaseOutage?: DatabaseOutage;
};

const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function getBearerToken(req: IncomingMessage) {
  const authorization = headerValue(req.headers.authorization);
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function requestMetadata(
  req: IncomingMessage,
  log?: McpRequestLog,
): RequestMetadata {
  const forwardedFor = headerValue(req.headers["x-forwarded-for"]);
  const ipAddress =
    forwardedFor?.split(",")[0]?.trim() || req.socket.remoteAddress || null;
  const userAgent = headerValue(req.headers["user-agent"]) ?? null;
  const clientName =
    headerValue(req.headers["mcp-client-name"]) ??
    headerValue(req.headers["x-mcp-client"]) ??
    null;

  return { ipAddress, userAgent, clientName, log };
}

function hashRateLimitToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function consumeRateLimit(key: string, limit: number) {
  if (!Number.isFinite(limit) || limit <= 0) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  const nowMs = Date.now();
  const existing = rateLimitBuckets.get(key);
  if (!existing || existing.resetAt <= nowMs) {
    rateLimitBuckets.set(key, { count: 1, resetAt: nowMs + 60_000 });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  if (existing.count <= limit) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  return {
    allowed: false,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((existing.resetAt - nowMs) / 1000),
    ),
  };
}

async function authenticateRequest(
  req: IncomingMessage,
  metadata: RequestMetadata,
) {
  const token = getBearerToken(req);
  if (!token) {
    recordMcpAuditEvent({
      action: "auth",
      target: "bearer",
      status: "failure",
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
      clientName: metadata.clientName,
      error: "Missing bearer token",
    });
    return null;
  }

  let auth: McpTokenAuth | null;
  try {
    auth = await authenticateMcpToken(token);
  } catch (error) {
    if (!(error instanceof McpOrganizationNotAdmittedError)) throw error;
    // Logged once, as the "MCP request completed" warning carrying the code.
    if (metadata.log) {
      metadata.log.tokenId = error.tokenId;
      metadata.log.code = error.code;
    }
    recordMcpAuditEvent({
      organizationId: error.organizationId,
      tokenId: error.tokenId,
      action: "auth",
      target: "bearer",
      status: "failure",
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
      clientName: metadata.clientName,
      error: "Organization not admitted by this Studio",
    });
    return error;
  }
  if (auth && metadata.log) metadata.log.tokenId = auth.id;
  recordMcpAuditEvent({
    organizationId: auth?.organizationId ?? null,
    tokenId: auth?.id ?? null,
    action: "auth",
    target: "bearer",
    status: auth ? "success" : "failure",
    ipAddress: metadata.ipAddress,
    userAgent: metadata.userAgent,
    clientName: metadata.clientName,
    error: auth ? null : "Invalid, revoked, or expired token",
  });

  return auth;
}

function sendUnauthorized(
  res: ServerResponse,
  refusal: McpOrganizationNotAdmittedError | null = null,
) {
  if (refusal) {
    sendJson(res, refusal.statusCode, {
      error: refusal.message,
      code: refusal.code,
    });
    return;
  }
  res.setHeader("www-authenticate", 'Bearer realm="beam-studio-mcp"');
  sendJson(res, 401, { error: "Unauthorized" });
}

function sendRateLimited(res: ServerResponse, retryAfterSeconds: number) {
  res.setHeader("retry-after", String(retryAfterSeconds));
  sendJson(res, 429, { error: "Rate limited", retryAfterSeconds });
}

function loadLocalEnv() {
  let currentDir = process.cwd();

  while (true) {
    const envPath = join(currentDir, ".env.local");
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          continue;
        }

        const separatorIndex = trimmed.indexOf("=");
        if (separatorIndex === -1) {
          continue;
        }

        const key = trimmed.slice(0, separatorIndex).trim();
        const rawValue = trimmed.slice(separatorIndex + 1).trim();
        const value = rawValue.replace(/^(['"])(.*)\1$/, "$2");
        process.env[key] ??= value;
      }
      return;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return;
    }
    currentDir = parentDir;
  }
}

function jsonContent(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function requireScopes(auth: McpTokenAuth, requiredScopes: McpScope[]) {
  const missing = requiredScopes.filter(
    (scope) => !auth.scopes.includes(scope),
  );
  if (missing.length) {
    throw new Error(
      `MCP token is missing required scope: ${missing.join(", ")}`,
    );
  }
}

function requiredToolScopes(name: string) {
  return MCP_TOOL_SCOPE_REQUIREMENTS[name] ?? [];
}

function requiredResourceScopes(name: string) {
  return MCP_RESOURCE_SCOPE_REQUIREMENTS[name] ?? [];
}

async function auditMcpOperation<T>(
  auth: McpTokenAuth,
  metadata: RequestMetadata,
  action: "tool" | "resource",
  target: string,
  requiredScopes: McpScope[],
  handler: () => T | Promise<T>,
): Promise<T> {
  const operation = startMcpOperation(metadata.log, {
    kind: action,
    name: target,
    requiredScopes,
    scope: requiredScopes.every((scope) => auth.scopes.includes(scope))
      ? "granted"
      : "denied",
  });
  try {
    requireScopes(auth, requiredScopes);
    const result = await handler();
    operation.outcome = "ok";
    recordMcpAuditEvent({
      organizationId: auth.organizationId,
      tokenId: auth.id,
      action,
      target,
      status: "success",
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
      clientName: metadata.clientName,
    });
    return result;
  } catch (error) {
    operation.outcome = "error";
    // Noted before the audit write, which fails the same way during an outage.
    noteDatabaseOutage(metadata.databaseOutage, error);
    recordMcpAuditEvent({
      organizationId: auth.organizationId,
      tokenId: auth.id,
      action,
      target,
      status: "failure",
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
      clientName: metadata.clientName,
      error: error instanceof Error ? error.message : "Unknown MCP error",
    });
    throw error;
  }
}

function createBeamMcpServer(
  auth: McpTokenAuth,
  metadata: RequestMetadata,
  bearer: string,
) {
  const server = new McpServer({
    name: "beam-studio",
    version: serverVersion,
  });

  const workflowTools: Array<{
    name: string;
    description: string;
    schema: z.ZodRawShape;
  }> = [
    {
      name: "beam.list_rooms",
      description:
        "Discover rooms, object channels, memberships and local agents in one Beam environment template.",
      schema: { environmentTemplateKey: z.string().optional() },
    },
    {
      name: "beam.list_room_storage_members",
      description:
        "List object-storage bucket memberships attached to one room.",
      schema: {
        environmentTemplateKey: z.string(),
        roomId: z.string(),
      },
    },
    {
      name: "beam.attach_room_storage_member",
      description: `Attach a bucket from an existing Studio credential to a room object channel. ${UNRESTRICTED_STORAGE_RULE}`,
      schema: {
        environmentTemplateKey: z.string(),
        roomId: z.string(),
        credentialId: z.string(),
        bucket: z.string(),
        displayName: z.string(),
        objectChannelIds: z.array(z.string()),
        destinationPrefix: z.string().optional(),
        destinationLayout: z
          .enum(["isolated", "preserve_path", "flat_name"])
          .optional(),
        collisionPolicy: z.enum(["fail_if_exists", "overwrite"]).optional(),
        sourceDelegateMemberIds: z.array(z.string()).optional(),
        sourceDelegateRoleIds: z.array(z.string()).optional(),
        roleIds: z.array(z.string()).optional(),
      },
    },
    {
      name: "beam.update_room_storage_member",
      description:
        "Update a bucket member's source delegates and destination behavior.",
      schema: {
        environmentTemplateKey: z.string(),
        roomId: z.string(),
        bindingId: z.string(),
        displayName: z.string(),
        destinationPrefix: z.string().optional(),
        destinationLayout: z
          .enum(["isolated", "preserve_path", "flat_name"])
          .optional(),
        collisionPolicy: z.enum(["fail_if_exists", "overwrite"]).optional(),
        sourceDelegateMemberIds: z.array(z.string()).optional(),
        sourceDelegateRoleIds: z.array(z.string()).optional(),
      },
    },
    {
      name: "beam.remove_room_storage_member",
      description: "Remove an object-storage bucket membership from a room.",
      schema: {
        environmentTemplateKey: z.string(),
        roomId: z.string(),
        bindingId: z.string(),
      },
    },
    {
      name: "beam.create_room_workflow",
      description:
        "Create a canonical room workflow from an enrolled agent local file. requestId makes creation repeatable.",
      schema: {
        name: z.string(),
        apiKeyId: z.string(),
        requestId: z.string(),
        config: z.record(z.string(), z.unknown()),
      },
    },
    {
      name: "beam.create_workflow",
      description:
        "Create a Studio workflow template. Use beam.update_workflow_graph to author its V3 distribution and bounded loop.",
      schema: {
        name: z.string().min(1),
        description: z.string().optional(),
        apiKeyId: z.string().min(1).optional(),
        room: z.record(z.string(), z.unknown()).nullable().optional(),
      },
    },
    {
      name: "beam.get_workflow",
      description: "Read a Studio workflow graph and its frozen action locks.",
      schema: { workflowId: z.string() },
    },
    {
      name: "beam.update_workflow_graph",
      description: `Replace a Studio workflow graph. V3 supports distributed partitions, ring or all-to-all transfer, aggregation, and bounded loop seed/carry routes. Uses the same validation as Studio. ${UNRESTRICTED_STORAGE_RULE}`,
      schema: {
        workflowId: z.string(),
        graphVersion: z.string().optional(),
        room: z.record(z.string(), z.unknown()).nullable().optional(),
        distribution: z.record(z.string(), z.unknown()).optional(),
        inputSchema: z.record(z.string(), z.unknown()).optional(),
        output: z.record(z.string(), z.unknown()).optional(),
        failurePolicy: z
          .enum(["stop_on_failure", "continue_on_failure"])
          .optional(),
        agentBindings: z.record(z.string(), z.unknown()).optional(),
        resourceBindings: z.record(z.string(), z.unknown()).optional(),
        controls: z.array(z.unknown()).optional(),
        steps: z.array(z.record(z.string(), z.unknown())),
        edges: z.array(z.record(z.string(), z.unknown())),
        triggers: z.array(z.record(z.string(), z.unknown())).optional(),
        triggerEdges: z.array(z.record(z.string(), z.unknown())).optional(),
        decisions: z.array(z.record(z.string(), z.unknown())).optional(),
        decisionEdges: z.array(z.record(z.string(), z.unknown())).optional(),
        confirmActionLockChanges: z.boolean().optional(),
      },
    },
    {
      name: "beam.run_workflow",
      description:
        "Run a canonical Studio workflow with the normal credit and execution gates.",
      schema: {
        workflowId: z.string(),
        input: z.record(z.string(), z.unknown()).optional(),
      },
    },
    {
      name: "beam.retry_workflow_run",
      description:
        "Retry a failed or cancelled workflow through the normal credit and execution gates.",
      schema: { runId: z.string() },
    },
    {
      name: "beam.get_workflow_run",
      description:
        "Read workflow steps, frozen members, distributed tasks, attempts, artifact manifests, waiting and failure causes.",
      schema: { runId: z.string() },
    },
    {
      name: "beam.cancel_workflow_run",
      description:
        "Request workflow cancellation, including the original room publication.",
      schema: { runId: z.string() },
    },
  ];
  for (const tool of workflowTools)
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      (input) =>
        auditMcpOperation(
          auth,
          metadata,
          "tool",
          tool.name,
          requiredToolScopes(tool.name),
          async () => {
            const base = process.env.BEAM_STUDIO_API_URL;
            if (!base)
              throw new Error(
                "BEAM_STUDIO_API_URL is required for workflow tools.",
              );
            const response = await fetch(
              new URL("/mcp/workflows/" + tool.name, base),
              {
                method: "POST",
                headers: {
                  Authorization: "Bearer " + bearer,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(input),
                signal: AbortSignal.timeout(30_000),
              },
            );
            const result = await response.json();
            if (!response.ok)
              throw new Error(
                JSON.stringify({
                  code: result.code ?? "workflow_api_error",
                  error: result.error ?? "Workflow API request failed.",
                  ...(result.details ? { details: result.details } : {}),
                  ...(result.action ? { action: result.action } : {}),
                }),
              );
            return jsonContent(result);
          },
        ),
    );

  server.registerResource(
    "recent-runs",
    "beam://recent-runs",
    {
      title: "Recent Beam Transfer Studio runs",
      description:
        "The most recent transfer runs queued or executed by this studio.",
      mimeType: "application/json",
    },
    () =>
      auditMcpOperation(
        auth,
        metadata,
        "resource",
        "beam://recent-runs",
        requiredResourceScopes("beam://recent-runs"),
        () => ({
          contents: [
            {
              uri: "beam://recent-runs",
              mimeType: "application/json",
              text: JSON.stringify(
                listRuns({ organizationId: auth.organizationId, limit: 20 }),
                null,
                2,
              ),
            },
          ],
        }),
      ),
  );

  server.registerResource(
    "transfer-templates",
    "beam://transfer-templates",
    {
      title: "Beam Transfer Studio templates",
      description: "Transfer templates configured in this studio.",
      mimeType: "application/json",
    },
    () =>
      auditMcpOperation(
        auth,
        metadata,
        "resource",
        "beam://transfer-templates",
        requiredResourceScopes("beam://transfer-templates"),
        () => ({
          contents: [
            {
              uri: "beam://transfer-templates",
              mimeType: "application/json",
              text: JSON.stringify(
                listTransfers({
                  organizationId: auth.organizationId,
                  limit: 50,
                }),
                null,
                2,
              ),
            },
          ],
        }),
      ),
  );

  server.registerTool(
    "beam.list_api_keys",
    {
      title: "List Beam API keys",
      description:
        "List local and cached organization Beam API keys. Secrets are never returned.",
      inputSchema: {
        organizationId: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    () =>
      auditMcpOperation(
        auth,
        metadata,
        "tool",
        "beam.list_api_keys",
        requiredToolScopes("beam.list_api_keys"),
        () =>
          jsonContent({
            apiKeys: listApiKeys({ organizationId: auth.organizationId }),
          }),
      ),
  );

  server.registerTool(
    "beam.list_credentials",
    {
      title: "List provider credentials",
      description:
        "List stored provider credentials with a safe payload preview.",
      inputSchema: {
        organizationId: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    () =>
      auditMcpOperation(
        auth,
        metadata,
        "tool",
        "beam.list_credentials",
        requiredToolScopes("beam.list_credentials"),
        () =>
          jsonContent({
            credentials: listCredentials({
              organizationId: auth.organizationId,
            }),
          }),
      ),
  );

  server.registerTool(
    "beam.create_transfer",
    {
      title: "Create transfer template",
      description:
        "Create a Beam Transfer Studio transfer template. Endpoints can be added from the studio UI.",
      inputSchema: {
        name: z.string().min(1),
        apiKeyId: z.string().min(1).optional().default("__custom_api_key__"),
        customApiKey: z.string().optional(),
        organizationId: z.string().optional(),
        description: z.string().optional(),
        beamServerUrl: z.string().optional(),
        notificationWebhookUrl: z.string().optional(),
        slackWebhookUrl: z.string().optional(),
        notifyOnStart: z.boolean().default(false),
        notifyOnSuccess: z.boolean().default(true),
        notifyOnFailure: z.boolean().default(true),
        notifyOnCancel: z.boolean().default(true),
        enabled: z.boolean().default(false),
        frequency: z.string().optional(),
      },
    },
    (input) =>
      auditMcpOperation(
        auth,
        metadata,
        "tool",
        "beam.create_transfer",
        requiredToolScopes("beam.create_transfer"),
        () => {
          const transferId = createTransfer({
            ...input,
            organizationId: auth.organizationId,
          });
          return jsonContent({
            transferId,
            transfer: getTransfer(transferId, auth.organizationId),
          });
        },
      ),
  );

  server.registerTool(
    "beam.run_transfer_now",
    {
      title: "Run transfer now",
      description:
        "Queue an existing transfer template for immediate worker execution.",
      inputSchema: {
        transferId: z.string().min(1),
        organizationId: z.string().optional(),
      },
    },
    ({ transferId }) =>
      auditMcpOperation(
        auth,
        metadata,
        "tool",
        "beam.run_transfer_now",
        requiredToolScopes("beam.run_transfer_now"),
        () => {
          const runId = startRun(transferId, auth.organizationId);
          return jsonContent({
            runId,
            run: getRun(runId, auth.organizationId),
          });
        },
      ),
  );

  server.registerTool(
    "beam.schedule_transfer",
    {
      title: "Schedule transfer",
      description: "Create a recurring schedule for a transfer template.",
      inputSchema: {
        transferId: z.string().min(1),
        frequency: z.string().min(1),
        enabled: z.boolean().default(true),
        nextRunAt: z.string().optional(),
        organizationId: z.string().optional(),
      },
    },
    ({ transferId, frequency, enabled, nextRunAt }) =>
      auditMcpOperation(
        auth,
        metadata,
        "tool",
        "beam.schedule_transfer",
        requiredToolScopes("beam.schedule_transfer"),
        () => {
          const scheduleId = createSchedule({
            transferTemplateId: transferId,
            frequency,
            enabled,
            nextRunAt,
            organizationId: auth.organizationId,
          });
          return jsonContent({
            scheduleId,
            schedules: listSchedules({
              organizationId: auth.organizationId,
            }).filter((schedule) => schedule.transferTemplateId === transferId),
          });
        },
      ),
  );

  server.registerTool(
    "beam.cancel_run",
    {
      title: "Cancel run",
      description:
        "Cancel a queued run or request cancellation for a running run.",
      inputSchema: {
        runId: z.string().min(1),
        organizationId: z.string().optional(),
      },
    },
    ({ runId }) =>
      auditMcpOperation(
        auth,
        metadata,
        "tool",
        "beam.cancel_run",
        requiredToolScopes("beam.cancel_run"),
        () =>
          jsonContent({
            cancelRequested: true,
            run: cancelRun(runId, auth.organizationId),
          }),
      ),
  );

  server.registerTool(
    "beam.get_run_status",
    {
      title: "Get run status",
      description:
        "Read local status, transfer rows, and recent logs for a studio run.",
      inputSchema: {
        runId: z.string().min(1),
        organizationId: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ runId }) =>
      auditMcpOperation(
        auth,
        metadata,
        "tool",
        "beam.get_run_status",
        requiredToolScopes("beam.get_run_status"),
        () => {
          const run = getRun(runId, auth.organizationId);
          if (!run) {
            throw new Error("Run not found.");
          }
          return jsonContent(run);
        },
      ),
  );

  server.registerTool(
    "beam.get_transfer_status",
    {
      title: "Get Beam transfer status",
      description:
        "Read the latest transfer status recorded by Studio for a Beam transfer ID or run.",
      inputSchema: {
        beamTransferId: z.string().optional(),
        runId: z.string().optional(),
        organizationId: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ beamTransferId, runId }) =>
      auditMcpOperation(
        auth,
        metadata,
        "tool",
        "beam.get_transfer_status",
        requiredToolScopes("beam.get_transfer_status"),
        () => {
          const runBundle = runId
            ? getRun(runId, auth.organizationId)
            : beamTransferId
              ? getRunByBeamTransferId(beamTransferId, auth.organizationId)
              : null;
          if (!runBundle) {
            throw new Error(
              "A Studio run matching the run ID or Beam transfer ID was not found.",
            );
          }
          const resolvedBeamTransferId =
            beamTransferId ??
            runBundle.run.beamTransferId ??
            runBundle.transfers.find((transfer) => transfer.beamTransferId)
              ?.beamTransferId;
          if (!resolvedBeamTransferId) {
            throw new Error(
              "The Studio run does not have a recorded Beam transfer ID.",
            );
          }
          return jsonContent({
            beamTransferId: resolvedBeamTransferId,
            status: {
              source: "studio",
              value: runBundle.run.status,
              startedAt: runBundle.run.startedAt,
              completedAt: runBundle.run.completedAt,
              updatedAt: runBundle.run.updatedAt,
              error: runBundle.run.error,
            },
            run: runBundle.run,
            transfers: runBundle.transfers,
          });
        },
      ),
  );

  server.registerTool(
    "beam.list_recent_runs",
    {
      title: "List recent runs",
      description:
        "List recent studio runs, optionally filtered by transfer or status.",
      inputSchema: {
        transferId: z.string().optional(),
        status: z.string().optional(),
        organizationId: z.string().optional(),
        limit: z.number().int().min(1).max(120).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    (input) =>
      auditMcpOperation(
        auth,
        metadata,
        "tool",
        "beam.list_recent_runs",
        requiredToolScopes("beam.list_recent_runs"),
        () =>
          jsonContent({
            runs: listRuns({ ...input, organizationId: auth.organizationId }),
          }),
      ),
  );

  return server;
}

function sendJson(res: ServerResponse, statusCode: number, value: unknown) {
  const payload = JSON.stringify(value, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function allowedCorsOrigin(req: IncomingMessage) {
  const origin = headerValue(req.headers.origin);
  // Unset allows nothing cross-origin. It used to mean "*", which on a server
  // that binds loopback by default is the configuration a rebinding attack
  // wants. A wildcard is still possible, but only by asking for it.
  const configuredOrigins = (process.env.MCP_CORS_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  // An MCP client is not a browser and sends no Origin; it is not subject to
  // the same-origin policy and has nothing to be granted here.
  if (!origin) {
    return null;
  }
  if (configuredOrigins.includes("*")) {
    return "*";
  }
  if (configuredOrigins.includes(origin)) {
    return origin;
  }

  return null;
}

function setCorsHeaders(req: IncomingMessage, res: ServerResponse) {
  const origin = allowedCorsOrigin(req);
  if (origin) {
    res.setHeader("access-control-allow-origin", origin);
  }
  res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    "content-type,mcp-session-id,mcp-protocol-version,authorization",
  );
  res.setHeader(
    "access-control-expose-headers",
    "mcp-session-id,mcp-protocol-version",
  );
  return Boolean(origin);
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  auth: McpTokenAuth,
  metadata: RequestMetadata,
) {
  const mcpServer = createBeamMcpServer(
    auth,
    metadata,
    getBearerToken(req) ?? "",
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  // A tool or resource that hit a database outage answers the whole request
  // with the retryable 503, not a tool error quoting the driver.
  const outage: DatabaseOutage = {};
  metadata.databaseOutage = outage;
  const restoreResponse = answerDatabaseOutageInstead(res, outage, (error) =>
    sendRequestFailure(req, res, error),
  );

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  } finally {
    restoreResponse();
    await transport.close();
    await mcpServer.close();
  }
}

const httpServer = createServer(async (req, res) => {
  const startedAt = performance.now();
  const requestLog: McpRequestLog = {};
  res.once("close", () =>
    logMcpRequest(logger, {
      method: req.method ?? "GET",
      path: (req.url ?? "/").split("?")[0] || "/",
      statusCode: res.statusCode,
      durationMs: performance.now() - startedAt,
      aborted: !res.writableFinished,
      log: requestLog,
    }),
  );
  // Authentication, audit events and tools all read PostgreSQL. Any failure
  // is answered here: a rejection escaping this async handler used to end the
  // process, and the client saw a connection reset instead of an error.
  try {
    await routeHttpRequest(req, res, requestLog);
  } catch (error) {
    sendRequestFailure(req, res, error);
  }
});

function sendRequestFailure(
  req: IncomingMessage,
  res: ServerResponse,
  error: unknown,
) {
  const databaseUnavailable = isPostgresUnavailableError(error);
  logger.error(
    {
      err: error,
      code: databaseUnavailable ? "database_unavailable" : "internal_error",
      req: { method: req.method, url: (req.url ?? "/").split("?")[0] },
    },
    "Error handling MCP request",
  );
  if (res.headersSent) {
    res.end();
    return;
  }
  writeMcpFailure(res, error);
}

async function routeHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestLog: McpRequestLog,
) {
  // DNS rebinding needs a name whose answer can be flipped to a private
  // address; the browser then sends that name as Host. This server binds
  // loopback by default, which is exactly the target. The SDK exposes
  // allowedHosts and enableDnsRebindingProtection for this, but they are
  // @deprecated in the pinned version in favour of external middleware, and
  // they would not cover /health or GET / because the transport never sees
  // those requests.
  if (!hostAllowed(req.headers.host)) {
    sendJson(res, 421, { error: "Host is not allowed" });
    return;
  }

  const corsAllowed = setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    if (corsAllowed) {
      res.writeHead(204);
      res.end();
    } else {
      sendJson(res, 403, { error: "CORS origin is not allowed" });
    }
    return;
  }

  // A disallowed origin used to block only the preflight, so a cross-origin
  // POST /mcp still ran the tool call.
  if (req.headers.origin && !corsAllowed) {
    sendJson(res, 403, { error: "CORS origin is not allowed" });
    return;
  }

  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? `localhost:${port}`}`,
  );

  if (url.pathname === "/health") {
    // Same contract as the API's /health: 503 while PostgreSQL is
    // unreachable, 200 again once it is back. The compose healthcheck marks
    // the container unhealthy but does not restart it.
    const database = checkStudioDatabase();
    sendJson(res, database.ok ? 200 : 503, {
      status: database.ok ? "ok" : "unavailable",
      name: "beam-studio",
      version: serverVersion,
      endpoint: "/mcp",
      checks: { database: database.ok ? "ok" : "unavailable" },
    });
    return;
  }

  if (url.pathname === "/" && req.method === "GET") {
    const metadata = requestMetadata(req, requestLog);
    const auth = await authenticateRequest(req, metadata);
    if (!auth || auth instanceof McpOrganizationNotAdmittedError) {
      sendUnauthorized(res, auth);
      return;
    }

    sendJson(res, 200, {
      name: "beam-studio",
      endpoint: "/mcp",
      version: serverVersion,
      resources: mcpResourceNames,
      tools: mcpToolNames,
      auth: {
        required: true,
        tokenId: auth.id,
        organizationId: auth.organizationId,
        scopes: auth.scopes,
      },
    });
    return;
  }

  if (url.pathname !== "/mcp") {
    sendJson(res, 404, { error: "Not found", endpoint: "/mcp" });
    return;
  }

  const metadata = requestMetadata(req, requestLog);
  const token = getBearerToken(req);
  const authLimit = consumeRateLimit(
    `auth:${metadata.ipAddress ?? "unknown"}`,
    authRateLimitPerMinute,
  );
  if (!authLimit.allowed) {
    recordMcpAuditEvent({
      action: "auth",
      target: "rate-limit",
      status: "failure",
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
      clientName: metadata.clientName,
      error: "Authentication rate limit exceeded",
    });
    sendRateLimited(res, authLimit.retryAfterSeconds);
    return;
  }

  if (token) {
    const tokenLimit = consumeRateLimit(
      `token:${hashRateLimitToken(token)}`,
      tokenRateLimitPerMinute,
    );
    if (!tokenLimit.allowed) {
      recordMcpAuditEvent({
        action: "auth",
        target: "token-rate-limit",
        status: "failure",
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        clientName: metadata.clientName,
        error: "Token rate limit exceeded",
      });
      sendRateLimited(res, tokenLimit.retryAfterSeconds);
      return;
    }
  }

  const auth = await authenticateRequest(req, metadata);
  if (!auth || auth instanceof McpOrganizationNotAdmittedError) {
    sendUnauthorized(res, auth);
    return;
  }

  await handleMcpRequest(req, res, auth, metadata);
}

httpServer.listen(port, host, () => {
  logger.info(
    mcpStartupLogFields({
      host,
      port,
      databaseUrl: getStudioDatabasePath(),
    }),
    "MCP server started",
  );
});

process.on("SIGINT", () => {
  logger.info({ signal: "SIGINT" }, "MCP server shutdown requested");
  httpServer.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  logger.info({ signal: "SIGTERM" }, "MCP server shutdown requested");
  httpServer.close(() => process.exit(0));
});
