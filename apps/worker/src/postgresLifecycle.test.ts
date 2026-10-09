import assert from "node:assert/strict";
import test from "node:test";
import type { PgClient, PgPool } from "@beam-studio/db";
import {
  isPostgresWorkerMarkedDraining,
  markPostgresWorkerStopped,
  updatePostgresWorkerHeartbeat,
} from "./services/postgresLifecycle.js";
import type { WorkerRuntimeDeclaration } from "./services/workerRuntime.js";

const runtimeDeclaration: WorkerRuntimeDeclaration = {
  concurrency: 4,
  capabilities: ["workflow_tasks", "transfer"],
  reachability: "local",
  accessibleEndpoints: ["s3", "beam"],
  bandwidthMbps: 250,
  networkIdentity: "worker-test",
};

test("PostgreSQL worker heartbeat upserts runtime state and capabilities", async () => {
  const pool = new MockPgPool();

  await updatePostgresWorkerHeartbeat(
    pool as unknown as PgPool,
    "worker-one",
    runtimeDeclaration,
  );

  assert.equal(pool.directQueries.length, 1);
  assert.match(
    pool.directQueries[0]?.sql ?? "",
    /FROM execution\.workflow_tasks/,
  );
  assert.deepEqual(pool.directQueries[0]?.values, ["worker-one"]);

  const transactional = pool.clients[0]?.queries ?? [];
  assert.equal(transactional[0]?.sql, "BEGIN");
  assert.match(
    transactional[1]?.sql ?? "",
    /INSERT INTO runtime\.worker_runtime_state/,
  );
  assert.deepEqual(transactional[1]?.values?.slice(0, 5), [
    "worker-one",
    "worker-test",
    JSON.stringify(["workflow_tasks", "transfer"]),
    "local",
    JSON.stringify(["s3", "beam"]),
  ]);
  // No baked-in revision outside an image build.
  assert.equal(transactional[1]?.values?.[13], null);
  assert.match(
    transactional[2]?.sql ?? "",
    /DELETE FROM runtime\.worker_capabilities/,
  );
  assert.match(
    transactional[3]?.sql ?? "",
    /INSERT INTO runtime\.worker_capabilities/,
  );
  assert.match(
    transactional[4]?.sql ?? "",
    /INSERT INTO runtime\.worker_capabilities/,
  );
  assert.equal(transactional.at(-1)?.sql, "COMMIT");
  assert.equal(pool.clients[0]?.released, true);
});

test("the heartbeat reports the image's git revision", async () => {
  const previous = process.env.BEAM_REVISION;
  process.env.BEAM_REVISION = "0123456789ABCDEF0123456789abcdef01234567";
  try {
    const pool = new MockPgPool();
    await updatePostgresWorkerHeartbeat(
      pool as unknown as PgPool,
      "worker-one",
      runtimeDeclaration,
    );
    const upsert = pool.clients[0]?.queries[1];
    assert.match(upsert?.sql ?? "", /version = EXCLUDED\.version/);
    assert.equal(
      upsert?.values?.[13],
      "0123456789abcdef0123456789abcdef01234567",
    );
  } finally {
    if (previous === undefined) delete process.env.BEAM_REVISION;
    else process.env.BEAM_REVISION = previous;
  }
});

test("the heartbeat carries the live service configuration status when given one", async () => {
  const status = {
    version: 2,
    applied: { NATS_TASK_REDELIVERY_DELAY_MS: 5000 },
    deployed: { NATS_TASK_REDELIVERY_DELAY_MS: "2000" },
    pendingRestart: [],
    rejected: [],
  };
  const reporting = new MockPgPool();
  await updatePostgresWorkerHeartbeat(
    reporting as unknown as PgPool,
    "worker-one",
    runtimeDeclaration,
    () => status,
  );
  const metadata = JSON.parse(String(reporting.clients[0]?.queries[1]?.values?.[12]));
  assert.equal(metadata.role, "task-worker");
  assert.deepEqual(metadata.config, status);

  const bare = new MockPgPool();
  await updatePostgresWorkerHeartbeat(
    bare as unknown as PgPool,
    "worker-one",
    runtimeDeclaration,
  );
  assert.ok(
    !("config" in JSON.parse(String(bare.clients[0]?.queries[1]?.values?.[12]))),
  );
});

test("PostgreSQL worker lifecycle can detect draining and mark stopped", async () => {
  const pool = new MockPgPool({
    directResponses: [{ rows: [{ status: "draining" }] }],
  });

  assert.equal(
    await isPostgresWorkerMarkedDraining(
      pool as unknown as PgPool,
      "worker-one",
    ),
    true,
  );

  await markPostgresWorkerStopped(pool as unknown as PgPool, "worker-one");

  assert.match(pool.directQueries[0]?.sql ?? "", /SELECT status/);
  assert.deepEqual(pool.directQueries[0]?.values, ["worker-one"]);
  assert.match(pool.directQueries[1]?.sql ?? "", /SET status = 'stopped'/);
  assert.equal(pool.directQueries[1]?.values?.[0], "worker-one");
});

class MockPgPool {
  readonly clients: MockPgClient[] = [];
  readonly directQueries: Array<{ sql: string; values?: unknown[] }> = [];
  private directResponses: Array<{ rows: Array<Record<string, unknown>> }>;

  constructor(
    options: {
      directResponses?: Array<{ rows: Array<Record<string, unknown>> }>;
    } = {},
  ) {
    this.directResponses = options.directResponses ?? [];
  }

  async connect() {
    const client = new MockPgClient();
    this.clients.push(client);
    return client as unknown as PgClient;
  }

  async query(sql: string, values?: unknown[]) {
    this.directQueries.push({ sql: compact(sql), values });
    return this.directResponses.shift() ?? { rows: [{ count: "2" }] };
  }
}

class MockPgClient {
  readonly queries: Array<{ sql: string; values?: unknown[] }> = [];
  released = false;

  async query(sql: string, values?: unknown[]) {
    this.queries.push({ sql: compact(sql), values });
    return { rows: [], rowCount: 0 };
  }

  release() {
    this.released = true;
  }
}

function compact(sql: string) {
  return sql.trim().replace(/\s+/g, " ");
}
