import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { rm, stat } from "node:fs/promises";

export type WorkerFileSource =
  | Buffer
  | Uint8Array
  | Blob
  | { tempFilePath: string; deleteOnCleanup?: boolean };

export type PublishLocalFileInput = {
  source: WorkerFileSource;
  mediaType?: string;
  ttlSeconds?: number;
  name?: string;
};

export type PublishedWorkerFile = {
  uri: `beam-worker://${string}/${string}`;
  exportId: string;
  workerId: string;
  size: number;
  etag: string;
  mediaType?: string;
  expiresAt: string;
  supportsRange: true;
};

export type WorkerFileServerMetadata = {
  baseUrl: string;
  supportsRange: true;
  supportsHead: true;
  maxTtlSeconds: number;
};

export type WorkerFileServer = {
  metadata: WorkerFileServerMetadata;
  publishLocalFile(input: PublishLocalFileInput): Promise<PublishedWorkerFile>;
  signedUrl(
    exportId: string,
    options?: { method?: "GET" | "HEAD"; ttlSeconds?: number },
  ): string;
  close(): Promise<void>;
};

type TempFileSource = { tempFilePath: string; deleteOnCleanup?: boolean };

type WorkerFileExport = {
  id: string;
  workerId: string;
  size: number;
  mediaType?: string;
  etag: string;
  createdAt: Date;
  expiresAt: Date;
  source: Buffer | TempFileSource;
};

type WorkerFileServerOptions = {
  workerId: string;
  host: string;
  port: number;
  publicBaseUrl?: string;
  signingSecret: string;
  maxTtlSeconds: number;
  cleanupIntervalMs?: number;
  /**
   * Observes a temporary file that could not be removed. The error is reported
   * on its own so a failed unlink never surfaces as an unhandled rejection, and
   * never carries request details into the caller's logs.
   */
  onCleanupError?: (error: unknown) => void;
};

export function signedWorkerFileUrl(input: {
  baseUrl: string;
  workerId: string;
  exportId: string;
  signingSecret: string;
  method?: "GET" | "HEAD";
  ttlSeconds: number;
}) {
  const method = input.method ?? "GET";
  const expires = String(Math.floor(Date.now() / 1000) + input.ttlSeconds);
  const path = `/files/${encodeURIComponent(input.exportId)}`;
  const sig = sign({
    method,
    workerId: input.workerId,
    exportId: input.exportId,
    expires,
    path,
    secret: input.signingSecret,
  });
  return `${input.baseUrl.replace(/\/+$/, "")}${path}?expires=${expires}&sig=${sig}`;
}

export async function startWorkerFileServer(
  options: WorkerFileServerOptions,
): Promise<WorkerFileServer> {
  const registry = new Map<string, WorkerFileExport>();
  const server = http.createServer((request, response) => {
    void handleRequest(request, response, registry, options).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : options.port;
  const baseUrl =
    options.publicBaseUrl ??
    `http://${options.host === "0.0.0.0" ? "127.0.0.1" : options.host}:${actualPort}`;
  const cleanupTimer = setInterval(
    () => cleanupExpired(registry, options),
    options.cleanupIntervalMs ?? 60_000,
  );
  cleanupTimer.unref();

  return {
    metadata: {
      baseUrl,
      supportsRange: true,
      supportsHead: true,
      maxTtlSeconds: options.maxTtlSeconds,
    },
    async publishLocalFile(input) {
      const source = await seekableSource(input.source);
      const size = Buffer.isBuffer(source)
        ? source.byteLength
        : (await stat(source.tempFilePath)).size;
      const exportId = `exp_${crypto.randomUUID().replace(/-/g, "")}`;
      const ttlSeconds = Math.min(
        Math.max(1, input.ttlSeconds ?? options.maxTtlSeconds),
        options.maxTtlSeconds,
      );
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
      const record: WorkerFileExport = {
        id: exportId,
        workerId: options.workerId,
        size,
        mediaType: input.mediaType,
        etag: await etag(source),
        createdAt: new Date(),
        expiresAt,
        source,
      };
      registry.set(exportId, record);
      return {
        uri: `beam-worker://${options.workerId}/${exportId}`,
        exportId,
        workerId: options.workerId,
        size,
        etag: record.etag,
        mediaType: input.mediaType,
        expiresAt: expiresAt.toISOString(),
        supportsRange: true,
      };
    },
    signedUrl(exportId, signedOptions = {}) {
      const ttlSeconds = Math.min(
        Math.max(1, signedOptions.ttlSeconds ?? options.maxTtlSeconds),
        options.maxTtlSeconds,
      );
      return signedWorkerFileUrl({
        baseUrl,
        workerId: options.workerId,
        exportId,
        signingSecret: options.signingSecret,
        method: signedOptions.method,
        ttlSeconds,
      });
    },
    async close() {
      cleanupTimer.close();
      // Await the removals: the process may exit as soon as close() resolves,
      // and a pending unlink would leave the file behind.
      await Promise.all(
        [...registry.entries()].map(([id, record]) =>
          discardExport(registry, id, record, options),
        ),
      );
      registry.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  registry: Map<string, WorkerFileExport>,
  options: WorkerFileServerOptions,
) {
  const method =
    request.method === "HEAD"
      ? "HEAD"
      : request.method === "GET"
        ? "GET"
        : null;
  if (!method || !request.url) {
    response.writeHead(405).end();
    return;
  }
  const baseUrl = `http://${request.headers.host ?? "localhost"}`;
  const url = new URL(request.url, baseUrl);
  const match = /^\/files\/([^/]+)$/.exec(url.pathname);
  if (!match) {
    response.writeHead(404).end();
    return;
  }
  const exportId = decodeURIComponent(match[1] ?? "");
  if (!verifyRequest(method, url, exportId, options)) {
    response.writeHead(403).end();
    return;
  }
  const record = registry.get(exportId);
  if (!record || record.expiresAt.getTime() <= Date.now()) {
    if (record) {
      await discardExport(registry, exportId, record, options);
    }
    response.writeHead(404).end();
    return;
  }
  if (method === "HEAD") {
    writeBaseHeaders(response, record, 200, record.size);
    response.end();
    return;
  }

  const range = parseRange(request.headers.range, record.size);
  if (range === "invalid") {
    response.writeHead(416, {
      "Content-Range": `bytes */${record.size}`,
      "Accept-Ranges": "bytes",
      ETag: quotedEtag(record.etag),
    });
    response.end();
    return;
  }
  if (!range) {
    writeBaseHeaders(response, record, 200, record.size);
    await writeSource(response, record.source, 0, record.size - 1);
    return;
  }
  const contentLength = range.end - range.start + 1;
  writeBaseHeaders(response, record, 206, contentLength, {
    "Content-Range": `bytes ${range.start}-${range.end}/${record.size}`,
  });
  await writeSource(response, record.source, range.start, range.end);
}

function verifyRequest(
  method: "GET" | "HEAD",
  url: URL,
  exportId: string,
  options: WorkerFileServerOptions,
) {
  const expires = url.searchParams.get("expires") ?? "";
  const sig = url.searchParams.get("sig") ?? "";
  if (!expires || !sig || Number(expires) <= Math.floor(Date.now() / 1000)) {
    return false;
  }
  const expected = sign({
    method,
    workerId: options.workerId,
    exportId,
    expires,
    path: url.pathname,
    secret: options.signingSecret,
  });
  return timingSafeEqual(sig, expected);
}

function sign(input: {
  method: "GET" | "HEAD";
  workerId: string;
  exportId: string;
  expires: string;
  path: string;
  secret: string;
}) {
  return crypto
    .createHmac("sha256", input.secret)
    .update(
      [
        input.method,
        input.workerId,
        input.exportId,
        input.expires,
        input.path,
      ].join("\n"),
    )
    .digest("base64url");
}

function timingSafeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.byteLength === rightBuffer.byteLength &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

async function seekableSource(source: WorkerFileSource) {
  if (Buffer.isBuffer(source)) {
    return source;
  }
  if (source instanceof Uint8Array) {
    return Buffer.from(source);
  }
  if (source instanceof Blob) {
    return Buffer.from(await source.arrayBuffer());
  }
  return source;
}

async function etag(source: Buffer | TempFileSource) {
  const hash = crypto.createHash("sha256");
  if (Buffer.isBuffer(source)) {
    hash.update(source);
  } else {
    await new Promise<void>((resolve, reject) => {
      fs.createReadStream(source.tempFilePath)
        .on("data", (chunk) => hash.update(chunk))
        .on("error", reject)
        .on("end", resolve);
    });
  }
  return `sha256:${hash.digest("hex")}`;
}

function parseRange(rangeHeader: string | undefined, size: number) {
  if (!rangeHeader) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || size <= 0) {
    return "invalid" as const;
  }
  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) {
    return "invalid" as const;
  }
  if (!startRaw) {
    const suffixLength = Number(endRaw);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      return "invalid" as const;
    }
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }
  const start = Number(startRaw);
  const end = endRaw ? Number(endRaw) : size - 1;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  ) {
    return "invalid" as const;
  }
  return {
    start,
    end: Math.min(end, size - 1),
  };
}

function writeBaseHeaders(
  response: http.ServerResponse,
  record: WorkerFileExport,
  status: number,
  contentLength: number,
  extraHeaders: Record<string, string> = {},
) {
  response.writeHead(status, {
    "Accept-Ranges": "bytes",
    "Content-Length": String(contentLength),
    "Content-Type": record.mediaType ?? "application/octet-stream",
    ETag: quotedEtag(record.etag),
    ...extraHeaders,
  });
}

async function writeSource(
  response: http.ServerResponse,
  source: WorkerFileExport["source"],
  start: number,
  end: number,
) {
  if (end < start) {
    response.end();
    return;
  }
  if (Buffer.isBuffer(source)) {
    response.end(source.subarray(start, end + 1));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(source.tempFilePath, { start, end })
      .on("error", (error) => {
        if (!response.headersSent) {
          response.writeHead(500);
        }
        response.end();
        reject(error);
      })
      .on("end", resolve)
      .pipe(response);
  });
}

function quotedEtag(value: string) {
  return `"${value.replace(/"/g, "")}"`;
}

function cleanupExpired(
  registry: Map<string, WorkerFileExport>,
  options: WorkerFileServerOptions,
) {
  const now = Date.now();
  for (const [id, record] of registry) {
    if (record.expiresAt.getTime() <= now) {
      void discardExport(registry, id, record, options);
    }
  }
}

/**
 * The only way an export leaves the registry. Dropping the entry without
 * removing the temporary file it owns strands that file for good: the periodic
 * sweep and shutdown both iterate the registry, so nothing can find it again.
 */
async function discardExport(
  registry: Map<string, WorkerFileExport>,
  id: string,
  record: WorkerFileExport,
  options: WorkerFileServerOptions,
) {
  registry.delete(id);
  await cleanupTempSource(record.source, options);
}

async function cleanupTempSource(
  source: WorkerFileExport["source"],
  options: WorkerFileServerOptions,
) {
  if (Buffer.isBuffer(source) || !source.deleteOnCleanup) {
    return;
  }
  try {
    await rm(source.tempFilePath, { force: true });
  } catch (error) {
    options.onCleanupError?.(error);
  }
}
