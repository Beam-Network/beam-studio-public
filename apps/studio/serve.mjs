import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostAllowed, listenHost } from "@beam-studio/shared";
import { createWebLogger, loggedWebPath, logWebRequest } from "./web-log.mjs";

const logger = createWebLogger();

const clientRoot = resolve(
  fileURLToPath(new URL("dist/client", import.meta.url)),
);
const serverEntryPath = resolve(
  fileURLToPath(new URL("dist/server/server.js", import.meta.url)),
);
const port = positiveInt(process.env.PORT, 3004);
const host = listenHost("HOST", "0.0.0.0");
// No default: the proxy forwards into the API, so a guessed target is a
// forwarding path nobody configured. Unset disables it entirely.
const rawProxyTarget = process.env.STUDIO_API_PROXY_TARGET?.trim();
const studioApiProxyTarget = rawProxyTarget
  ? apiProxyTarget(rawProxyTarget)
  : null;

if (!existsSync(serverEntryPath)) {
  logger.error({ serverEntryPath }, "Studio server build output is missing");
  process.exit(1);
}

const { default: studioServer } = await import(
  pathToFileURL(serverEntryPath).href
);

const server = createServer(async (request, response) => {
  const startedAt = performance.now();
  response.once("close", () =>
    logWebRequest(logger, {
      method: request.method,
      url: request.url,
      statusCode: response.statusCode,
      durationMs: performance.now() - startedAt,
    }),
  );
  try {
    if (!request.url) {
      response.writeHead(400).end("Bad Request");
      return;
    }

    const url = new URL(
      request.url,
      `http://${request.headers.host ?? "localhost"}`,
    );
    if (!hostAllowed(request.headers.host)) {
      response.writeHead(421).end("Misdirected Request");
      return;
    }
    if (
      url.pathname === "/health" &&
      ["GET", "HEAD"].includes(request.method)
    ) {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      });
      response.end(request.method === "HEAD" ? undefined : '{"ok":true}\n');
      return;
    }
    if (studioApiProxyTarget && isStudioApiProxyPath(url.pathname)) {
      if (!sameOriginRequest(request)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const controller = new AbortController();
      const abort = () => {
        if (!response.writableEnded) controller.abort();
      };
      response.on("close", abort);
      try {
        const apiResponse = await fetch(
          toProxyRequest(request, studioApiUrl(url)),
          { signal: controller.signal },
        );
        await sendWebResponse(response, apiResponse, request.method === "HEAD");
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        response.off("close", abort);
      }
      return;
    }
    const assetPath = await clientAssetPath(url.pathname);
    if (assetPath) {
      sendFile(response, assetPath, request.method === "HEAD");
      return;
    }

    const webResponse = await studioServer.fetch(toWebRequest(request, url));
    await sendWebResponse(response, webResponse, request.method === "HEAD");
  } catch (error) {
    logger.error(
      { err: error, method: request.method, path: loggedWebPath(request.url) },
      "Studio web request failed",
    );
    response.writeHead(500).end("Internal Server Error");
  }
});

server.on("upgrade", (request, socket, head) => {
  if (!request.url) {
    rejectUpgrade(socket, 400, "Bad Request");
    return;
  }

  const url = new URL(
    request.url,
    `http://${request.headers.host ?? "localhost"}`,
  );
  if (!hostAllowed(request.headers.host)) {
    rejectUpgrade(socket, 421, "Misdirected Request");
    return;
  }
  if (!studioApiProxyTarget || !isStudioApiProxyPath(url.pathname)) {
    rejectUpgrade(socket, 404, "Not Found");
    return;
  }
  // Browsers always send Origin on a WebSocket handshake and CORS does not
  // apply to one, so requiring it to match is the check that stops another
  // origin driving the API through this proxy.
  if (!sameOriginUpgrade(request)) {
    rejectUpgrade(socket, 403, "Forbidden");
    return;
  }

  proxyStudioApiWebSocket(request, socket, head, studioApiUrl(url));
});

server.listen(port, host, () => {
  logger.info(
    {
      host,
      port,
      apiProxy: studioApiProxyTarget ? studioApiProxyTarget.origin : null,
    },
    "Studio web server started",
  );
});

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function decodePathname(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return "/";
  }
}

function isInsideRoot(filePath) {
  return filePath === clientRoot || filePath.startsWith(`${clientRoot}${sep}`);
}

async function existingFile(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile() ? filePath : null;
  } catch {
    return null;
  }
}

async function clientAssetPath(pathname) {
  const decodedPathname = decodePathname(pathname);
  const filePath = resolve(clientRoot, `.${normalize(decodedPathname)}`);
  if (!isInsideRoot(filePath)) {
    return null;
  }
  return existingFile(filePath);
}

/**
 * Vite fingerprints what it bundles into /assets, so those names change whenever their
 * content does and may be cached forever. Everything else here comes from public/, which
 * Vite copies verbatim under a stable name: caching those immutably pins a stale copy in
 * every browser that saw the old one, for as long as the max-age lasts.
 */
const fingerprintedAsset = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

function cacheControl(filePath) {
  return fingerprintedAsset.test(filePath)
    ? "public, max-age=31536000, immutable"
    : "public, no-cache";
}

function sendFile(response, filePath, headOnly) {
  response.setHeader("Content-Type", contentType(filePath));
  response.setHeader("Cache-Control", cacheControl(filePath));
  if (headOnly) {
    response.end();
    return;
  }
  createReadStream(filePath)
    .on("error", () => response.writeHead(500).end("Internal Server Error"))
    .pipe(response);
}

function toWebRequest(request, url) {
  return new Request(url, {
    method: request.method,
    headers: webHeaders(request.headers),
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : Readable.toWeb(request),
    duplex: "half",
  });
}

async function sendWebResponse(response, webResponse, headOnly) {
  const headers = Object.fromEntries(webResponse.headers.entries());
  const setCookies = webResponse.headers.getSetCookie?.() ?? [];
  if (setCookies.length) {
    headers["set-cookie"] = setCookies;
  }
  response.writeHead(webResponse.status, headers);
  if (headOnly || !webResponse.body) {
    response.end();
    return;
  }
  Readable.fromWeb(webResponse.body).pipe(response);
}

function webHeaders(headers) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    result.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return result;
}

function apiProxyTarget(value) {
  const target = new URL(value);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("STUDIO_API_PROXY_TARGET must use HTTP or HTTPS");
  }
  return target;
}

/** The origin this request was addressed to, as the browser would compute it. */
function selfOrigin(request) {
  const proto = request.socket.encrypted ? "https" : "http";
  const forwarded = request.headers["x-forwarded-proto"];
  const scheme =
    typeof forwarded === "string" ? forwarded.split(",")[0].trim() : proto;
  return `${scheme}://${request.headers.host ?? ""}`;
}

/**
 * The Studio SPA is the only intended caller of the proxy, so it is asked for
 * positive evidence rather than the absence of a disqualifying header. That
 * also turns away a plain request from elsewhere on the network, which sends
 * neither Sec-Fetch-Site nor Origin.
 */
function sameOriginRequest(request) {
  const origin = request.headers.origin;
  if (origin && origin !== selfOrigin(request)) return false;
  const site = request.headers["sec-fetch-site"];
  if (typeof site === "string") return site === "same-origin";
  // A browser too old for Sec-Fetch-Site still sends Origin on anything that
  // can change state; a same-origin GET legitimately sends neither.
  return (
    Boolean(origin) || request.method === "GET" || request.method === "HEAD"
  );
}

function sameOriginUpgrade(request) {
  return request.headers.origin === selfOrigin(request);
}

function isStudioApiProxyPath(pathname) {
  return pathname === "/__studio_api" || pathname.startsWith("/__studio_api/");
}

function studioApiUrl(requestUrl) {
  const pathname = requestUrl.pathname.replace(/^\/__studio_api/, "") || "/";
  const target = new URL(pathname, studioApiProxyTarget);
  target.search = requestUrl.search;
  return target;
}

function toProxyRequest(request, url) {
  const headers = webHeaders(request.headers);
  headers.delete("host");
  // Whatever the client sent is discarded: these reach the API's rate limits
  // and audit records, so a caller must not be able to choose them.
  for (const name of ["x-forwarded-for", "x-forwarded-proto", "forwarded"]) {
    headers.delete(name);
  }
  headers.set("x-forwarded-host", request.headers.host ?? "");
  headers.set("x-forwarded-proto", request.socket.encrypted ? "https" : "http");
  headers.set("x-forwarded-for", request.socket.remoteAddress ?? "");
  return new Request(url, {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : Readable.toWeb(request),
    duplex: "half",
    redirect: "manual",
  });
}

function proxyStudioApiWebSocket(request, socket, head, target) {
  const headers = { ...request.headers };
  delete headers["x-forwarded-for"];
  delete headers["x-forwarded-proto"];
  delete headers.forwarded;
  headers.host = target.host;
  headers["x-forwarded-host"] = request.headers.host ?? "";
  headers["x-forwarded-proto"] = request.socket.encrypted ? "https" : "http";
  headers["x-forwarded-for"] = request.socket.remoteAddress ?? "";
  const requestUpgrade =
    target.protocol === "https:" ? httpsRequest : httpRequest;
  const proxyRequest = requestUpgrade(target, {
    method: request.method,
    headers,
  });

  proxyRequest.on("upgrade", (proxyResponse, proxySocket, proxyHead) => {
    writeProxyResponseHead(socket, proxyResponse);
    if (head.length) proxySocket.write(head);
    if (proxyHead.length) socket.write(proxyHead);
    proxySocket.on("error", () => socket.destroy());
    socket.on("error", () => proxySocket.destroy());
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxyRequest.on("response", (proxyResponse) => {
    writeProxyResponseHead(socket, proxyResponse);
    proxyResponse.pipe(socket);
  });

  proxyRequest.on("error", (error) => {
    logger.error({ err: error }, "Studio API WebSocket proxy failed");
    if (!socket.destroyed) rejectUpgrade(socket, 502, "Bad Gateway");
  });

  proxyRequest.end();
}

function writeProxyResponseHead(socket, response) {
  const lines = [
    `HTTP/${response.httpVersion} ${response.statusCode ?? 502} ${response.statusMessage ?? "Bad Gateway"}`,
  ];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    lines.push(
      `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`,
    );
  }
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
}

function rejectUpgrade(socket, statusCode, statusMessage) {
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusMessage}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function contentType(filePath) {
  switch (extname(filePath)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".ico":
      return "image/x-icon";
    case ".svg":
      return "image/svg+xml";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}
