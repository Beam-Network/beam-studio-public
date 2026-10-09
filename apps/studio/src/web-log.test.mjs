import assert from "node:assert/strict";
import test from "node:test";
import {
  createWebLogger,
  loggedWebPath,
  logWebRequest,
  webRequestLogLevel,
} from "../web-log.mjs";

function capture(env = {}) {
  const raw = [];
  const logger = createWebLogger({ env, write: (line) => raw.push(line) });
  return { logger, raw, lines: () => raw.map((line) => JSON.parse(line)) };
}

test("web log lines are pino-shaped JSON with one level key", () => {
  const { logger, raw, lines } = capture();
  logger.info(
    { port: 3004, level: "spoofed", msg: "spoofed" },
    "Studio web server started",
  );
  assert.equal(raw.length, 1);
  assert.ok(raw[0].endsWith("\n"));
  assert.equal(raw[0].match(/"level":/g)?.length, 1);
  const [line] = lines();
  assert.equal(line.level, 30);
  assert.equal(typeof line.time, "number");
  assert.equal(line.pid, process.pid);
  assert.equal(line.name, "beam-studio-web");
  assert.equal(line.port, 3004);
  assert.equal(line.msg, "Studio web server started");
});

test("LOG_LEVEL filters lines, and an unknown value falls back with a warning", () => {
  const quiet = capture({ LOG_LEVEL: "warn" });
  quiet.logger.info({}, "hidden");
  quiet.logger.warn({}, "shown");
  assert.deepEqual(
    quiet.lines().map((line) => line.msg),
    ["shown"],
  );

  const typo = capture({ LOG_LEVEL: "loud" });
  assert.equal(typo.logger.level, "info");
  const [warning] = typo.lines();
  assert.equal(warning.level, 40);
  assert.equal(warning.msg, "Ignoring unknown LOG_LEVEL");
  assert.equal(warning.fallbackLevel, "info");
});

test("errors are serialized with type, message and stack", () => {
  const { logger, lines } = capture();
  logger.error({ err: new TypeError("boom") }, "Studio web request failed");
  const [line] = lines();
  assert.equal(line.level, 50);
  assert.equal(line.err.type, "TypeError");
  assert.equal(line.err.message, "boom");
  assert.match(line.err.stack, /TypeError: boom/);
});

test("requests follow the API levels, health checks are skipped", () => {
  assert.equal(webRequestLogLevel("GET", "/health", 200), null);
  assert.equal(webRequestLogLevel("HEAD", "/health", 200), null);
  assert.equal(webRequestLogLevel("GET", "/health", 500), "error");
  assert.equal(webRequestLogLevel("GET", "/runs", 200), "debug");
  assert.equal(
    webRequestLogLevel("GET", "/assets/app-abc12345.js", 304),
    "debug",
  );
  assert.equal(webRequestLogLevel("POST", "/__studio_api/*", 201), "info");
  assert.equal(webRequestLogLevel("POST", "/__studio_api/*", 403), "warn");
  assert.equal(webRequestLogLevel("GET", "/runs", 502), "error");

  const { logger, lines } = capture({ LOG_LEVEL: "debug" });
  logWebRequest(logger, {
    method: "GET",
    url: "/health",
    statusCode: 200,
    durationMs: 1,
  });
  logWebRequest(logger, {
    method: "GET",
    url: "/runs/run_1?token=secret",
    statusCode: 200,
    durationMs: 4.4,
  });
  assert.deepEqual(
    lines().map(({ level, method, path, statusCode, durationMs, msg }) => ({
      level,
      method,
      path,
      statusCode,
      durationMs,
      msg,
    })),
    [
      {
        level: 20,
        method: "GET",
        path: "/runs/run_1",
        statusCode: 200,
        durationMs: 4,
        msg: "request completed",
      },
    ],
  );
});

test("the logged path drops the query and the API proxy suffix", () => {
  assert.equal(loggedWebPath("/runs?token=secret"), "/runs");
  assert.equal(loggedWebPath(undefined), "/");
  assert.equal(
    loggedWebPath("/__studio_api/hooks/workflows/wf/trg/whk_secret"),
    "/__studio_api/*",
  );
  assert.equal(loggedWebPath("/__studio_api"), "/__studio_api/*");
  assert.equal(loggedWebPath("/__studio_apix"), "/__studio_apix");
});
