export function applyTargetSchema(
  client: { query(sql: string, values?: unknown[]): Promise<unknown> },
  sql: string,
  options?: {
    maxAttempts?: number;
    lockTimeoutMs?: number;
    statementTimeoutMs?: number;
    onRetry?: (info: { code: string; attempt: number }) => void | Promise<void>;
  },
): Promise<void>;
