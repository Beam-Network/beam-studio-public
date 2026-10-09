import assert from "node:assert/strict";
import test from "node:test";
import type { PgPool } from "@beam-studio/db";
import { ensurePreinstalledRegistryActions } from "./preinstalled-actions.js";

function poolWith(present: () => boolean) {
  const packages: unknown[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      assert.match(sql, /FROM actions\.package_versions/);
      packages.push(params[0]);
      return { rows: present() ? [{ "?column?": 1 }] : [] };
    },
  } as unknown as PgPool;
  return { pool, packages };
}

test("a fresh Studio installs Beam Transfer from the Registry", async () => {
  let installed = false;
  const installs: string[] = [];
  const { pool, packages } = poolWith(() => installed);

  const outcomes = await ensurePreinstalledRegistryActions(
    pool,
    async (packageName) => {
      installs.push(packageName);
      installed = true;
    },
  );

  assert.deepEqual(installs, ["@beam/transfer"]);
  assert.deepEqual(outcomes, [
    { packageName: "@beam/transfer", outcome: "installed" },
  ]);
  assert.deepEqual(packages, ["@beam/transfer", "@beam/transfer"]);
});

test("an installed release is left alone", async () => {
  const { pool } = poolWith(() => true);
  const outcomes = await ensurePreinstalledRegistryActions(pool, async () => {
    throw new Error("must not install");
  });
  assert.deepEqual(outcomes, [
    { packageName: "@beam/transfer", outcome: "present" },
  ]);
});

test("an unreachable Registry is reported, never raised", async () => {
  const { pool } = poolWith(() => false);
  const outcomes = await ensurePreinstalledRegistryActions(pool, async () => {
    throw new Error(
      "Unable to reach the Actions Registry: connect ECONNREFUSED",
    );
  });
  assert.equal(outcomes[0]?.outcome, "failed");
  assert.match(String(outcomes[0]?.reason), /ECONNREFUSED/);
});

test("an install that leaves no active release is a failure", async () => {
  const { pool } = poolWith(() => false);
  const outcomes = await ensurePreinstalledRegistryActions(
    pool,
    async () => {},
  );
  assert.deepEqual(outcomes, [
    {
      packageName: "@beam/transfer",
      outcome: "failed",
      reason: "the install left no active release",
    },
  ]);
});
