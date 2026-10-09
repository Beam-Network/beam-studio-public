import assert from "node:assert/strict";
import test from "node:test";
import {
  createServiceLogger,
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  LOG_REDACT_PATHS,
  LOG_REDACTED,
  logLevelFromEnv,
  maskUrlCredentials,
  stripUrlCredentials,
  type ServiceLoggerOptions,
} from "./logging.js";

test("LOG_LEVEL selects the level and falls back to info", () => {
  assert.deepEqual(logLevelFromEnv({}), { level: "info", invalid: null });
  assert.deepEqual(logLevelFromEnv({ LOG_LEVEL: " DEBUG " }), {
    level: "debug",
    invalid: null,
  });
  assert.deepEqual(logLevelFromEnv({ LOG_LEVEL: "silent" }), {
    level: "silent",
    invalid: null,
  });
  assert.deepEqual(logLevelFromEnv({ LOG_LEVEL: "loud" }), {
    level: DEFAULT_LOG_LEVEL,
    invalid: "loud",
  });
});

test("redaction covers credential headers, API keys, tokens and credential payloads", () => {
  const paths = new Set(LOG_REDACT_PATHS);
  for (const path of [
    "req.headers.authorization",
    "req.headers.cookie",
    'req.headers["x-api-key"]',
    'req.headers["x-beam-api-key"]',
    'req.headers["x-studio-shared-secret"]',
    'res.headers["set-cookie"]',
    "*.headers.authorization",
    "authorization",
    "*.authorization",
    "cookie",
    "*.cookie",
    "apiKey",
    "*.api_key",
    "token",
    "*.accessToken",
    "*.refresh_token",
    "*.secret_access_key",
    "*.client_secret",
    "*.password",
    "credential",
    "*.credentials",
    "*.encryptedPayload",
    "claimCode",
    "*.claimCode",
    "*.claim_code",
  ]) {
    assert.ok(paths.has(path), `missing redaction path ${path}`);
  }
});

test("createServiceLogger passes level and redaction and reports an unknown level", () => {
  const warnings: Array<{ object: object; message: string }> = [];
  let received: ServiceLoggerOptions | undefined;
  createServiceLogger(
    (options) => {
      received = options;
      return {
        warn: (object: object, message: string) =>
          warnings.push({ object, message }),
      };
    },
    "svc",
    { env: { LOG_LEVEL: "verbose" }, extraRedactPaths: ["*.url", "token"] },
  );
  assert.equal(received?.name, "svc");
  assert.equal(received?.level, "info");
  assert.equal(received?.redact.censor, LOG_REDACTED);
  assert.ok(received?.redact.paths.includes("*.url"));
  assert.equal(
    received?.redact.paths.filter((path) => path === "token").length,
    1,
    "paths are deduplicated",
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.message, "Ignoring unknown LOG_LEVEL");
  assert.deepEqual(warnings[0]?.object, {
    requested: "verbose",
    fallbackLevel: "info",
    accepted: [...LOG_LEVELS],
  });
  assert.ok(
    !("level" in (warnings[0]?.object ?? {})),
    "no second `level` key next to pino's",
  );
});

test("maskUrlCredentials masks the password or token in any URL in a string", () => {
  assert.equal(
    maskUrlCredentials(
      "connect failed: postgres://beam:pg-secret@postgres:5432/beam_studio",
    ),
    "connect failed: postgres://beam:[REDACTED]@postgres:5432/beam_studio",
  );
  assert.equal(
    maskUrlCredentials("nats://nats-token@nats:4222 and tls://u:p@h:4222"),
    "nats://[REDACTED]@nats:4222 and tls://u:[REDACTED]@h:4222",
  );
  assert.equal(
    maskUrlCredentials("redis://:only-password@cache:6379/0"),
    "redis://:[REDACTED]@cache:6379/0",
  );
  assert.equal(
    maskUrlCredentials("postgres://beam:p@ss:w0rd@db/x"),
    "postgres://beam:[REDACTED]@db/x",
    "a raw @ or : in the password is masked too",
  );
  for (const unchanged of [
    "no url here",
    "https://example.com/users/@me",
    "http://host:8080/path?email=a@b.c",
    "nats://nats:4222",
    "mailto:someone@example.com",
  ]) {
    assert.equal(maskUrlCredentials(unchanged), unchanged);
  }
});

test("maskUrlCredentials works on serialized log lines, nested fields included", () => {
  const line = JSON.stringify({
    msg: "retrying nats://user:msg-secret@nats:4222",
    config: {
      database: { url: "postgres://beam:nested-secret@postgres:5432/db" },
      servers: ["nats://array-token@nats:4222"],
    },
    err: {
      message: 'connect to "postgres://beam:quo\"te@pg/db" failed',
      stack: "Error: postgres://beam:stack-secret@pg/db\n    at x",
    },
    other: "a@b",
  });
  const masked = maskUrlCredentials(line);
  for (const secret of [
    "msg-secret",
    "nested-secret",
    "array-token",
    "quo",
    "stack-secret",
  ]) {
    assert.ok(!masked.includes(secret), `${secret} leaked: ${masked}`);
  }
  const parsed = JSON.parse(masked);
  assert.equal(
    parsed.config.database.url,
    "postgres://beam:[REDACTED]@postgres:5432/db",
  );
  assert.equal(parsed.other, "a@b");
});

test("stripUrlCredentials drops the userinfo and keeps the rest", () => {
  assert.equal(
    stripUrlCredentials("postgres://beam:pg-secret@postgres:5432/beam_studio"),
    "postgres://postgres:5432/beam_studio",
  );
  assert.equal(
    stripUrlCredentials("nats://nats-token@nats:4222"),
    "nats://nats:4222",
  );
  assert.equal(
    stripUrlCredentials("postgres://postgres:5432/db"),
    "postgres://postgres:5432/db",
  );
  assert.equal(
    stripUrlCredentials("postgres://beam:pg-secret@[not-a-host"),
    "postgres://beam:[REDACTED]@[not-a-host",
    "an unparsable URL falls back to masking",
  );
});

test("createServiceLogger masks URL credentials in every written line", () => {
  let received: ServiceLoggerOptions | undefined;
  createServiceLogger(
    (options) => {
      received = options;
      return { warn: () => undefined };
    },
    "svc",
    { env: {} },
  );
  assert.equal(
    received?.hooks.streamWrite(
      '{"databasePath":"postgres://beam:pg-secret@postgres:5432/beam_studio"}\n',
    ),
    '{"databasePath":"postgres://beam:[REDACTED]@postgres:5432/beam_studio"}\n',
  );
});
