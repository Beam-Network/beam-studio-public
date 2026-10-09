import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import type { FastifyRequest } from "fastify";
import type { PgPool } from "@beam-studio/db";
import {
  createApiLogger,
  redactedRequestPath,
  requestLogLevel,
} from "./logging.js";
import { auth } from "./auth/policy.js";
import { buildServer } from "./server.js";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        raw.push(line);
        lines.push(JSON.parse(line));
      }
      done();
    },
  });
  return { stream, lines, raw };
}

const stubPool = () =>
  ({ query: async () => ({ rows: [], rowCount: 0 }) }) as unknown as PgPool;

test("the API logger takes its level from LOG_LEVEL", () => {
  assert.equal(createApiLogger("t", {}).level, "info");
  assert.equal(createApiLogger("t", { LOG_LEVEL: "warn" }).level, "warn");
  const { stream, lines, raw } = capture();
  assert.equal(
    createApiLogger("t", { LOG_LEVEL: "noisy" }, stream).level,
    "info",
  );
  assert.equal(lines[0]?.msg, "Ignoring unknown LOG_LEVEL");
  assert.equal(lines[0]?.level, 40);
  assert.equal(lines[0]?.fallbackLevel, "info");
  assert.equal(
    raw[0]?.match(/"level":/g)?.length,
    1,
    `one level key: ${raw[0]}`,
  );
});

test("secrets never reach the API log output", () => {
  const { stream, raw } = capture();
  const logger = createApiLogger("t", {}, stream);
  logger.info(
    {
      authorization: "Bearer top-level-secret",
      req: {
        method: "POST",
        headers: {
          authorization: "Bearer header-secret",
          cookie: "beam-studio.session=cookie-secret",
          "x-api-key": "header-api-key-secret",
        },
      },
      credential: { access_key_id: "AKIA", secret_access_key: "s3-secret" },
      input: { apiKey: "input-api-key-secret", token: "input-token-secret" },
      body: { payload: { api_key: "body-secret" } },
      object: {
        url: "https://bucket.example/o?X-Amz-Signature=presigned-secret",
      },
      organizationId: "org_visible",
    },
    "probe",
  );
  const output = raw.join("\n");
  for (const secret of [
    "top-level-secret",
    "header-secret",
    "cookie-secret",
    "header-api-key-secret",
    "s3-secret",
    "input-api-key-secret",
    "input-token-secret",
    "body-secret",
    "presigned-secret",
  ]) {
    assert.ok(!output.includes(secret), `${secret} leaked: ${output}`);
  }
  assert.ok(output.includes("org_visible"), "non-secret fields stay");
  assert.ok(output.includes('"method":"POST"'));
});

test("URL credentials never reach the API log output, wherever they appear", () => {
  const { stream, raw } = capture();
  const logger = createApiLogger("t", {}, stream).child({
    upstream: "nats://binding-token@nats:4222",
  });
  logger.warn(
    {
      config: {
        databaseUrl: "postgres://beam:nested-pg-secret@postgres:5432/db",
        servers: ["tls://user:array-nats-secret@gateway:4222"],
      },
      err: new Error(
        "connect ECONNREFUSED postgres://beam:error-pg-secret@postgres:5432/db",
      ),
    },
    "retrying postgres://beam:message-pg-secret@postgres:5432/db",
  );
  const output = raw.join("\n");
  for (const secret of [
    "binding-token",
    "nested-pg-secret",
    "array-nats-secret",
    "error-pg-secret",
    "message-pg-secret",
  ]) {
    assert.ok(!output.includes(secret), `${secret} leaked: ${output}`);
  }
  const line = JSON.parse(raw[0] ?? "{}");
  assert.equal(
    line.config.databaseUrl,
    "postgres://beam:[REDACTED]@postgres:5432/db",
  );
  assert.equal(
    line.msg,
    "retrying postgres://beam:[REDACTED]@postgres:5432/db",
  );
});

test("probes are skipped, reads are debug, writes info, refusals warn and failures error", () => {
  assert.equal(requestLogLevel("GET", "/health", 200), null);
  assert.equal(requestLogLevel("GET", "/studio/health", 200), null);
  assert.equal(requestLogLevel("GET", "/metrics", 401), null);
  assert.equal(requestLogLevel("GET", "/health", 503), "error");
  assert.equal(requestLogLevel("GET", "/studio/state", 200), "debug");
  assert.equal(requestLogLevel("POST", "/studio/rooms", 201), "info");
  assert.equal(requestLogLevel("POST", "/studio/rooms", 409), "warn");
  assert.equal(requestLogLevel("DELETE", "/studio/x/:id", 500), "error");
});

test("secret path parameters and query values are redacted from the logged path", () => {
  const request = (url: string, params: Record<string, string>) =>
    ({ url, params }) as unknown as FastifyRequest;
  assert.equal(
    redactedRequestPath(
      request("/hooks/workflows/wf_1/trg_1/whk_secret?source=crm", {
        workflowId: "wf_1",
        triggerId: "trg_1",
        token: "whk_secret",
      }),
    ),
    "/hooks/workflows/wf_1/trg_1/[REDACTED]?source=crm",
  );
  assert.equal(
    redactedRequestPath(
      request("/studio/runs/run_1?token=abc&view=queue", { id: "run_1" }),
    ),
    "/studio/runs/run_1?token=[REDACTED]&view=queue",
  );
});

test("the instance claim code is redacted from a logged query string", () => {
  const request = (url: string) =>
    ({ url, params: {} }) as unknown as FastifyRequest;
  for (const key of ["claimCode", "claim_code", "claim-code", "CLAIM_CODE"]) {
    const path = redactedRequestPath(
      request(`/studio/instance/access?${key}=BSC-7F3K-92QX&view=owner`),
    );
    assert.equal(
      path,
      `/studio/instance/access?${key}=[REDACTED]&view=owner`,
      key,
    );
    assert.doesNotMatch(path, /BSC-7F3K-92QX/);
  }
});

test("Fastify request logging goes through the service logger", async () => {
  const { stream, lines, raw } = capture();
  const server = await buildServer({
    pgPool: stubPool(),
    logger: createApiLogger("t", { LOG_LEVEL: "info" }, stream),
  });
  try {
    server.log.info("server log reaches the output");
    await server.inject({ method: "GET", url: "/health" });
    await server.inject({
      method: "POST",
      url: "/studio/credentials",
      headers: {
        authorization: "Bearer request-header-secret",
        cookie: "beam-studio.session=request-cookie-secret",
      },
      payload: { payload: { api_key: "request-body-secret" } },
    });
    await server.inject({ method: "GET", url: "/nowhere?token=query-secret" });
  } finally {
    await server.close();
  }

  assert.ok(lines.some((line) => line.msg === "server log reaches the output"));
  const completed = lines.filter((line) => line.msg === "request completed");
  assert.ok(
    !completed.some((line) => line.route === "/health"),
    "health probes are not logged",
  );
  const refused = completed.find(
    (line) => line.route === "/studio/credentials",
  );
  assert.ok(refused, `the refused write is logged: ${raw.join("\n")}`);
  assert.equal(refused.level, 40, "a 4xx is a warning");
  assert.equal(refused.method, "POST");
  assert.equal(typeof refused.code, "string");
  assert.equal(typeof refused.correlationId, "string");
  assert.ok(refused.reqId, "request.log carries the request id");
  const refusalLines = lines.filter(
    (line) => line.reqId === refused.reqId && Number(line.level) >= 40,
  );
  assert.deepEqual(
    refusalLines.map((line) => line.msg),
    ["request completed"],
    "a 401 from the auth kernel is one warning, not an error too",
  );
  const missing = completed.find((line) => line.route === "unmatched");
  assert.equal(missing?.code, "not_found");
  assert.equal(missing?.path, "/nowhere?token=[REDACTED]");

  const output = raw.join("\n");
  for (const secret of [
    "request-header-secret",
    "request-cookie-secret",
    "request-body-secret",
    "query-secret",
  ]) {
    assert.ok(!output.includes(secret), `${secret} leaked`);
  }
});

test("a 4xx is one warning line and a 5xx also logs the failure at error", async () => {
  const { stream, lines } = capture();
  const server = await buildServer({
    pgPool: stubPool(),
    logger: createApiLogger("t", { LOG_LEVEL: "info" }, stream),
  });
  const policy = { config: { auth: auth.public("logging test route") } };
  server.post("/test/refused", policy, async () => {
    throw Object.assign(new Error("Workflow name is required."), {
      statusCode: 400,
      code: "workflow_name_required",
    });
  });
  server.post("/test/conflict", policy, async () => {
    throw Object.assign(new Error("Already running."), {
      statusCode: 409,
      code: "already_running",
    });
  });
  server.post("/test/broken", policy, async () => {
    throw new Error("database exploded");
  });
  try {
    for (const url of ["/test/refused", "/test/conflict", "/test/broken"]) {
      await server.inject({ method: "POST", url, payload: {} });
    }
  } finally {
    await server.close();
  }

  const forRoute = (route: string) =>
    lines.filter(
      (line) =>
        line.route === route ||
        (line.reqId &&
          lines.some(
            (other) => other.route === route && other.reqId === line.reqId,
          )),
    );
  for (const [route, code] of [
    ["/test/refused", "workflow_name_required"],
    ["/test/conflict", "already_running"],
  ] as const) {
    const routeLines = forRoute(route);
    assert.equal(routeLines.length, 1, JSON.stringify(routeLines));
    assert.equal(routeLines[0]?.msg, "request completed");
    assert.equal(routeLines[0]?.level, 40);
    assert.equal(routeLines[0]?.code, code);
    assert.ok(
      !lines.some(
        (line) => line.msg === "API request failed" && line.route === route,
      ),
    );
  }

  const broken = forRoute("/test/broken");
  assert.deepEqual(broken.map((line) => [line.msg, line.level]).sort(), [
    ["API request failed", 50],
    ["request completed", 50],
  ]);
  const failure = broken.find((line) => line.msg === "API request failed");
  assert.equal(failure?.error, "database exploded");
  assert.equal(failure?.statusCode, 500);
});
