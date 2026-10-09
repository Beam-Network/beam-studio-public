import assert from "node:assert/strict";
import test from "node:test";
import type { PgPool } from "@beam-studio/db";
import {
  ensureRoomTransferActionV2Installed,
  migrateRoomTransferWorkflowsV2,
  roomTransferActionContractMismatch,
} from "./room-workflow-v2-migration.js";

const memberId = "btr_member_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const roomId = `btr_room_${"a".repeat(26)}`;
const channelId = "btr_channel_aaaaaaaaaaaaaaaaaaaaaaaaaa";

test("installs the immutable v2 action through the existing Registry path when absent", async () => {
  let present = false;
  let installs = 0;
  const pool = {
    query: async (sql: string) => {
      assert.match(sql, /FROM actions\.package_versions/);
      return { rows: present ? [{ "?column?": 1 }] : [] };
    },
  } as unknown as PgPool;

  assert.deepEqual(
    await ensureRoomTransferActionV2Installed(pool, async () => {
      installs += 1;
      present = true;
    }),
    { installed: true, available: true },
  );
  assert.equal(installs, 1);
  assert.deepEqual(
    await ensureRoomTransferActionV2Installed(pool, async () => {
      installs += 1;
    }),
    { installed: false, available: true },
  );
  assert.equal(installs, 1);
});

test("upgrades the deployed 2.1.1 room transfer and its action lock without rewriting config", async () => {
  const config = {
    environmentTemplateKey: "prod",
    roomId,
    channelId,
    source: {
      memberId,
      locator: { type: "agent_path", path: "/fixtures/source.bin" },
    },
    targetMemberIds: [],
    ttlSeconds: 300,
    allowPartial: false,
  };
  const writes: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      writes.push({ sql, values });
      if (sql.includes("UPDATE workflow.steps")) return { rowCount: 1 };
      if (sql.includes("UPDATE workflow.action_locks")) return { rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM workflow.steps")) {
        return {
          rows: [
            {
              id: "step-one",
              workflow_template_id: "workflow-one",
              action_version_range: "2.1.1",
              config_json: config,
              organization_id: "org-one",
            },
          ],
        };
      }
      if (sql.includes("FROM execution.workflow_runs")) return { rows: [] };
      if (sql.includes("FROM actions.package_versions")) {
        return {
          rows: [
            {
              id: "version-two",
              manifest_checksum: "manifest",
              artifact_checksum: "artifact",
              provenance_json: { source: "registry" },
              metadata_json: {},
              package_trust_level: "verified",
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    connect: async () => client,
  } as unknown as PgPool;

  assert.deepEqual(await migrateRoomTransferWorkflowsV2(pool), {
    migrated: 1,
    workflowIds: ["workflow-one"],
    deferredWorkflowIds: [],
  });
  const stepWrite = writes.find((write) =>
    write.sql.includes("UPDATE workflow.steps"),
  );
  assert.ok(stepWrite);
  assert.equal(stepWrite.values?.[0], "step-one");
  assert.equal(stepWrite.values?.[1], "2.1.2");
  assert.deepEqual(JSON.parse(String(stepWrite.values?.[2])), config);
  assert.doesNotMatch(stepWrite.sql, /SET config_json=/);
  const lockWrite = writes.find((write) =>
    write.sql.includes("UPDATE workflow.action_locks"),
  );
  assert.equal(lockWrite?.values?.[1], "version-two");
  assert.equal(lockWrite?.values?.[7], "2.1.2");
  assert.ok(writes.some((write) => write.sql === "BEGIN"));
  assert.ok(writes.some((write) => write.sql === "COMMIT"));
});

test("defers an active workflow without blocking API startup", async () => {
  const config = {
    environmentTemplateKey: "prod",
    roomId,
    channelId,
    source: {
      memberId,
      locator: { type: "agent_path", path: "/fixtures/source.bin" },
    },
    targetMemberIds: [],
    ttlSeconds: 300,
    allowPartial: false,
  };
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM workflow.steps")) {
        return {
          rows: [
            {
              id: "step-active",
              workflow_template_id: "workflow-active",
              action_version_range: "2.1.0",
              config_json: config,
              organization_id: "org-one",
            },
          ],
        };
      }
      if (sql.includes("FROM execution.workflow_runs")) {
        return {
          rows: [
            {
              id: "run-active",
              workflow_template_id: "workflow-active",
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    connect: async () => {
      throw new Error("active workflow must not be migrated");
    },
  } as unknown as PgPool;

  assert.deepEqual(await migrateRoomTransferWorkflowsV2(pool), {
    migrated: 0,
    workflowIds: [],
    deferredWorkflowIds: ["workflow-active"],
  });
});

test("fails startup with the affected workflow id when a legacy source cannot resolve", async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM workflow.steps")) {
        return {
          rows: [
            {
              id: "step-broken",
              workflow_template_id: "workflow-broken",
              action_version_range: "1.0.3",
              config_json: {
                environmentTemplateKey: "prod",
                roomId,
                channelId,
                sourcePath: "/fixtures/source.bin",
              },
              organization_id: "org-one",
            },
          ],
        };
      }
      if (sql.includes("FROM execution.workflow_runs")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as PgPool;

  await assert.rejects(
    migrateRoomTransferWorkflowsV2(pool),
    /room_transfer_v2_source_unresolved:workflow-broken/,
  );
});

test("a Registry that cannot supply the action no longer ends the process", async () => {
  // This ran before startServer and raised, so a release missing from the
  // Registry took the whole of Studio down rather than just room transfers.
  const pool = {
    query: async () => ({ rows: [] }),
  } as unknown as PgPool;

  const state = await ensureRoomTransferActionV2Installed(pool, async () => {
    throw Object.assign(new Error("Registry request failed with 404: …"), {
      code: "registry_request_failed",
    });
  });

  assert.equal(state.available, false);
  assert.equal(state.installed, false);
  assert.match(String(state.reason), /404/);
});

test("an install that reports success but leaves nothing behind is unavailable", async () => {
  const pool = {
    query: async () => ({ rows: [] }),
  } as unknown as PgPool;

  const state = await ensureRoomTransferActionV2Installed(pool, async () => {});
  assert.deepEqual(state, {
    installed: false,
    available: false,
    reason: "room_transfer_v2_action_install_failed",
  });
});

test("a release carrying the retired fields is treated as unavailable", async () => {
  // It installs cleanly and then fails per step in assertActionConfig, after a
  // run has been created and billed. Catching it here reports it the same way
  // a missing release is reported.
  const manifestWith = (schema: unknown) =>
    ({
      query: async () => ({
        rows: [{ manifest_json: { configSchema: schema } }],
      }),
    }) as unknown as PgPool;

  assert.equal(
    await roomTransferActionContractMismatch(
      manifestWith({
        required: ["environmentTemplateKey"],
        properties: { environmentTemplateKey: {} },
      }),
    ),
    null,
  );

  assert.match(
    String(
      await roomTransferActionContractMismatch(
        manifestWith({
          required: ["environment"],
          properties: { environment: {}, coordinatorUrl: {} },
        }),
      ),
    ),
    /environment_template_key/,
  );

  assert.match(
    String(
      await roomTransferActionContractMismatch(
        manifestWith({
          required: ["environmentTemplateKey"],
          properties: { environmentTemplateKey: {}, coordinatorUrl: {} },
        }),
      ),
    ),
    /retired_coordinatorUrl/,
  );
});
