import { pgOne, type PgPool } from "@beam-studio/db";
import { signedWorkerFileUrl } from "./workerFileServer.js";

type Row = Record<string, unknown>;

export type WorkerFileReference = {
  workerId: string;
  exportId: string;
};

export type WorkerFileResolution = WorkerFileReference & {
  url: string;
  baseUrl: string;
  reachability: string;
};

export type WorkerFileResolverOptions = {
  signingSecret: string;
  ttlSeconds?: number;
  staleAfterMs?: number;
  method?: "GET" | "HEAD";
};

export function parseWorkerFileUri(uri: string): WorkerFileReference | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== "beam-worker:") {
    return null;
  }
  const workerId = decodeURIComponent(parsed.hostname);
  const exportId = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!workerId || !exportId || exportId.includes("/")) {
    return null;
  }
  return { workerId, exportId };
}

export async function resolveWorkerFileUrl(
  pool: PgPool,
  uri: string,
  options: WorkerFileResolverOptions,
): Promise<WorkerFileResolution> {
  const reference = parseWorkerFileUri(uri);
  if (!reference) {
    throw new Error(`Invalid worker file URI "${uri}".`);
  }

  const row = await pgOne<Row>(
    pool,
    `
    SELECT status, reachability, heartbeat_at, metadata_json
    FROM runtime.worker_runtime_state
    WHERE worker_id = $1
    `,
    [reference.workerId],
  );
  if (!row) {
    throw new Error(
      `Worker file source "${reference.workerId}" is not registered.`,
    );
  }
  const status = String(row.status ?? "");
  if (status !== "active") {
    throw new Error(
      `Worker file source "${reference.workerId}" is not active: ${status || "unknown"}.`,
    );
  }
  const heartbeatAt = new Date(String(row.heartbeat_at ?? ""));
  const staleAfterMs = options.staleAfterMs ?? 45_000;
  if (
    Number.isNaN(heartbeatAt.getTime()) ||
    heartbeatAt.getTime() < Date.now() - staleAfterMs
  ) {
    throw new Error(`Worker file source "${reference.workerId}" is stale.`);
  }

  const metadata = objectValue(row.metadata_json);
  const fileServer = objectValue(metadata.fileServer);
  const baseUrl = text(fileServer.baseUrl);
  if (!baseUrl) {
    throw new Error(
      `Worker file source "${reference.workerId}" does not publish a file server.`,
    );
  }

  const ttlSeconds = Math.max(1, Math.floor(options.ttlSeconds ?? 300));
  return {
    ...reference,
    baseUrl,
    reachability: String(row.reachability ?? "local"),
    url: signedWorkerFileUrl({
      baseUrl,
      workerId: reference.workerId,
      exportId: reference.exportId,
      signingSecret: options.signingSecret,
      method: options.method,
      ttlSeconds,
    }),
  };
}

export async function downloadWorkerFile(
  pool: PgPool,
  uri: string,
  options: WorkerFileResolverOptions,
) {
  const resolution = await resolveWorkerFileUrl(pool, uri, {
    ...options,
    method: "GET",
  });
  const response = await fetch(resolution.url);
  if (!response.ok) {
    throw new Error(
      `Worker file download failed with HTTP ${response.status} for "${uri}".`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    content: bytes.toString("utf8"),
    bytes: bytes.byteLength,
    uri,
    mediaType: response.headers.get("content-type") ?? undefined,
    metadata: {
      sourceWorkerId: resolution.workerId,
      exportId: resolution.exportId,
      etag: response.headers.get("etag"),
      reachability: resolution.reachability,
    },
  };
}

function objectValue(value: unknown): Row {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Row;
  }
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Row)
      : {};
  } catch {
    return {};
  }
}

function text(value: unknown) {
  const result = String(value ?? "").trim();
  return result || null;
}
