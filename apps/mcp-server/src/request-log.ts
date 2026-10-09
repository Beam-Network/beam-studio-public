
export type McpOperation = {
  kind: "tool" | "resource";
  name: string;
  write: boolean;
  scope: "granted" | "denied";
  outcome?: "ok" | "error";
};

/** Filled in while a request is handled, then written once it closes. */
export type McpRequestLog = {
  tokenId?: string;
  /** The stable code of a refusal, such as instance_organization_forbidden. */
  code?: string;
  operation?: McpOperation;
};

export type McpRequestLogLevel = "debug" | "info" | "warn" | "error";

type McpRequestLogger = Record<
  McpRequestLogLevel,
  (object: object, message: string) => unknown
>;

/**
 * An operation is a write when it needs any scope other than `read:*`
 * (`write:`, `run:` or `cancel:`).
 */
export function isWriteOperation(requiredScopes: readonly string[]) {
  return requiredScopes.some((scope) => !scope.startsWith("read"));
}

export function startMcpOperation(
  log: McpRequestLog | undefined,
  operation: Omit<McpOperation, "write" | "outcome"> & {
    requiredScopes: readonly string[];
  },
): McpOperation {
  const entry: McpOperation = {
    kind: operation.kind,
    name: operation.name,
    write: isWriteOperation(operation.requiredScopes),
    scope: operation.scope,
  };
  if (log) log.operation = entry;
  return entry;
}

export function mcpRequestLogLevel(
  path: string,
  statusCode: number,
  operation?: McpOperation,
): McpRequestLogLevel | null {
  if (statusCode >= 500) return "error";
  if (path === "/health") return null;
  if (statusCode >= 400) return "warn";
  if (operation?.scope === "denied" || operation?.outcome === "error") {
    return "warn";
  }
  return operation?.write ? "info" : "debug";
}

export function logMcpRequest(
  logger: McpRequestLogger,
  request: {
    method: string;
    path: string;
    statusCode: number;
    durationMs: number;
    aborted?: boolean;
    log: McpRequestLog;
  },
) {
  const { operation, tokenId, code } = request.log;
  const level = mcpRequestLogLevel(request.path, request.statusCode, operation);
  if (!level) return;
  logger[level](
    {
      method: request.method,
      path: request.path,
      statusCode: request.statusCode,
      ...(operation
        ? {
            [operation.kind]: operation.name,
            scope: operation.scope,
            outcome: operation.outcome ?? "error",
          }
        : {}),
      ...(tokenId ? { tokenId } : {}),
      ...(code ? { code } : {}),
      ...(request.aborted ? { aborted: true } : {}),
      durationMs: Math.round(request.durationMs),
    },
    "MCP request completed",
  );
}
