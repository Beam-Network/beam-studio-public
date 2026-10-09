import { hostname } from "node:os";
import {
  LOG_LEVELS,
  logLevelFromEnv,
} from "@beam-studio/shared/logging";

/**
 * JSON lines for the Studio web server (serve.mjs), in the same shape and
 * with the same LOG_LEVEL handling as the pino loggers of the Node services:
 * numeric `level`, `time`, `pid`, `hostname`, `name` and `msg`. Written by
 * hand because the web image does not ship pino.
 */

const LEVEL_VALUES = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const RESERVED_KEYS = new Set([
  "level",
  "time",
  "pid",
  "hostname",
  "name",
  "msg",
]);

export function createWebLogger({
  name = "beam-studio-web",
  env = process.env,
  write = (line) => process.stdout.write(line),
} = {}) {
  const { level, invalid } = logLevelFromEnv(env);
  const threshold = level === "silent" ? Infinity : LEVEL_VALUES[level];
  const base = { pid: process.pid, hostname: hostname(), name };
  const at = (levelName) => (fields, msg) => {
    const value = LEVEL_VALUES[levelName];
    if (value < threshold) return;
    const line = { level: value, time: Date.now(), ...base };
    for (const [key, field] of Object.entries(fields ?? {})) {
      if (RESERVED_KEYS.has(key)) continue;
      line[key] = key === "err" ? serializeError(field) : field;
    }
    line.msg = msg;
    write(`${JSON.stringify(line)}\n`);
  };
  const logger = {
    level,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
  if (invalid) {
    logger.warn(
      { requested: invalid, fallbackLevel: level, accepted: LOG_LEVELS },
      "Ignoring unknown LOG_LEVEL",
    );
  }
  return logger;
}

export function webRequestLogLevel(method, path, statusCode) {
  if (statusCode >= 500) return "error";
  if (path === "/health") return null;
  if (statusCode >= 400) return "warn";
  return method === "GET" || method === "HEAD" || method === "OPTIONS"
    ? "debug"
    : "info";
}

/**
 * The path as logged: never the query string, and only the prefix of an API
 * proxy path, since the API logs the full, redacted request itself and a
 * proxied path can carry a secret (a webhook trigger token).
 */
export function loggedWebPath(rawUrl) {
  const path = (rawUrl ?? "/").split("?")[0] || "/";
  return path === "/__studio_api" || path.startsWith("/__studio_api/")
    ? "/__studio_api/*"
    : path;
}

export function logWebRequest(logger, { method, url, statusCode, durationMs }) {
  const path = loggedWebPath(url);
  const level = webRequestLogLevel(method, path, statusCode);
  if (!level) return;
  logger[level](
    { method, path, statusCode, durationMs: Math.round(durationMs) },
    "request completed",
  );
}

function serializeError(error) {
  if (!(error instanceof Error)) return error;
  return {
    type: error.name,
    message: error.message,
    stack: error.stack,
    ...(typeof error.code === "string" ? { code: error.code } : {}),
  };
}
