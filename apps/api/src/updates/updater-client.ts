import { request as httpRequest } from "node:http";

export const DEFAULT_UPDATER_SOCKET_PATH = "/run/beam-studio/updater.sock";

/** The subset of the updater's persisted state that Studio may show. */
export type UpdaterStatus = {
  operationId: string | null;
  operation: string | null;
  phase: string;
  currentVersion: string | null;
  targetVersion: string | null;
  previousVersion: string | null;
  message: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
};

export type UpdaterCheck = {
  channel: string;
  currentVersion: string | null;
  latestVersion: string;
  updateAvailable: boolean;
  publishedAt: string | null;
  releaseNotesUrl: string | null;
  requiresBackup: boolean;
};

export type UpdaterApplyResult = { operationId: string };

export interface UpdaterClient {
  status(): Promise<UpdaterStatus>;
  check(): Promise<UpdaterCheck>;
  apply(): Promise<UpdaterApplyResult>;
}

/**
 * An updater failure, translated into something the Studio API can answer
 * with. The updater's own message is kept because it is written for operators
 * ("an update is already running", "signature rejected") and contains no
 * secrets; transport errors are replaced by a generic explanation.
 */
export class UpdaterError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly expose = true;
  readonly retryable: boolean;

  constructor(input: {
    message: string;
    code: string;
    statusCode: number;
    retryable?: boolean;
  }) {
    super(input.message);
    this.name = "UpdaterError";
    this.code = input.code;
    this.statusCode = input.statusCode;
    this.retryable = input.retryable ?? false;
  }
}

type RawResponse = { statusCode: number; body: unknown };
type Transport = (
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) => Promise<RawResponse>;

/**
 * Talks to the host updater over its private Unix socket. The browser never
 * reaches this socket; only the authenticated Studio API does.
 */
export function createUpdaterClient(
  options: {
    socketPath?: string;
    timeoutMs?: number;
    transport?: Transport;
  } = {},
): UpdaterClient {
  const transport =
    options.transport ??
    unixSocketTransport(
      options.socketPath ??
        (process.env.BEAM_UPDATER_SOCKET_PATH?.trim() ||
          DEFAULT_UPDATER_SOCKET_PATH),
      options.timeoutMs ?? 30_000,
    );

  async function call(
    method: "GET" | "POST",
    path: string,
    failureCode: string,
    body?: unknown,
  ) {
    let response: RawResponse;
    try {
      response = await transport(method, path, body);
    } catch {
      throw new UpdaterError({
        code: "updater_unavailable",
        statusCode: 503,
        message:
          "The Beam Studio updater is not reachable on this host. Check that beam-updater.service is running.",
        retryable: true,
      });
    }
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return record(response.body);
    }
    const detail = text(record(response.body).error);
    if (response.statusCode === 409) {
      throw new UpdaterError({
        code: "updater_conflict",
        statusCode: 409,
        message: detail ?? "The updater refused to start this operation.",
      });
    }
    throw new UpdaterError({
      code: failureCode,
      statusCode: 502,
      message:
        detail ?? `The updater answered with HTTP ${response.statusCode}.`,
      retryable: true,
    });
  }

  return {
    async status() {
      const state = await call("GET", "/v1/status", "updater_status_failed");
      return {
        operationId: text(state.operationId),
        operation: text(state.operation),
        phase: text(state.phase) ?? "idle",
        currentVersion: text(state.currentVersion),
        targetVersion: text(state.targetVersion),
        previousVersion: text(state.previousVersion),
        message: text(state.message),
        error: text(state.error),
        startedAt: text(state.startedAt),
        completedAt: text(state.completedAt),
        updatedAt: text(state.updatedAt),
      };
    },
    async check() {
      const result = await call("GET", "/v1/check", "updater_check_failed");
      const latestVersion = text(result.latestVersion);
      const channel = text(result.channel);
      if (!latestVersion || !channel) {
        throw new UpdaterError({
          code: "updater_check_failed",
          statusCode: 502,
          message: "The updater returned an incomplete release check.",
          retryable: true,
        });
      }
      return {
        channel,
        currentVersion: text(result.currentVersion),
        latestVersion,
        updateAvailable: result.updateAvailable === true,
        publishedAt: text(result.publishedAt),
        releaseNotesUrl: text(result.releaseNotesUrl),
        requiresBackup: result.requiresBackup === true,
      };
    },
    async apply() {
      // Never forwards `force`: Studio installs only what the signed channel
      // offers as newer, under the updater's own sequence rules.
      const result = await call(
        "POST",
        "/v1/apply",
        "updater_apply_failed",
        {},
      );
      const operationId = text(result.operationId);
      if (!operationId) {
        throw new UpdaterError({
          code: "updater_apply_failed",
          statusCode: 502,
          message: "The updater accepted the update without an operation ID.",
        });
      }
      return { operationId };
    },
  };
}

function unixSocketTransport(socketPath: string, timeoutMs: number): Transport {
  return (method, path, body) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = httpRequest(
        {
          socketPath,
          method,
          path,
          headers: payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : undefined,
          timeout: timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown = null;
            try {
              parsed = raw ? JSON.parse(raw) : null;
            } catch {
              parsed = null;
            }
            resolve({ statusCode: response.statusCode ?? 502, body: parsed });
          });
        },
      );
      request.on("timeout", () =>
        request.destroy(new Error("updater request timed out")),
      );
      request.on("error", reject);
      request.end(payload);
    });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}
