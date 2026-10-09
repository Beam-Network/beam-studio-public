import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { createMcpLogger, mcpStartupLogFields } from "./logging.js";

function capture() {
  const raw: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      raw.push(...String(chunk).split("\n").filter(Boolean));
      done();
    },
  });
  return { stream, raw };
}

const databaseUrl =
  "postgres://beam:pg-secret-password@postgres:5432/beam_studio";

test("the MCP startup line logs the database without its password", () => {
  const { stream, raw } = capture();
  const logger = createMcpLogger({}, stream);
  logger.info(
    mcpStartupLogFields({ host: "0.0.0.0", port: 8766, databaseUrl }),
    "MCP server started",
  );
  assert.equal(raw.length, 1);
  assert.ok(!raw[0]?.includes("pg-secret-password"), raw[0]);
  const line = JSON.parse(raw[0] ?? "{}");
  assert.equal(line.database, "postgres://postgres:5432/beam_studio");
  assert.equal(line.endpoint, "http://0.0.0.0:8766/mcp");
  assert.equal(line.databasePath, undefined);
});

test("the MCP logger masks a connection string logged by mistake", () => {
  const { stream, raw } = capture();
  const logger = createMcpLogger({}, stream).child({ component: "test" });
  logger.info({ databasePath: databaseUrl }, `connecting to ${databaseUrl}`);
  logger.error(
    { err: new Error(`connect ECONNREFUSED ${databaseUrl}`) },
    "Database unavailable",
  );
  assert.equal(raw.length, 2);
  for (const line of raw) {
    assert.ok(!line.includes("pg-secret-password"), line);
  }
  assert.equal(
    JSON.parse(raw[0] ?? "{}").databasePath,
    "postgres://beam:[REDACTED]@postgres:5432/beam_studio",
  );
});
