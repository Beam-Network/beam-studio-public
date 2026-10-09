import assert from "node:assert/strict";
import test from "node:test";
import { revokeInstanceKeyForUninstall } from "./instance-key-revoke.js";

test("uninstall revokes the owner organization's instance key", async () => {
  const revoked: string[] = [];
  const outcome = await revokeInstanceKeyForUninstall({
    readOwner: async () => "org_owner",
    revoke: async (organizationId) => {
      revoked.push(organizationId);
      return { revoked: true };
    },
  });
  assert.deepEqual(revoked, ["org_owner"]);
  assert.equal(outcome.exitCode, 0);
  assert.match(outcome.message, /Revoked/);
});

test("an unowned Studio has nothing to revoke", async () => {
  const outcome = await revokeInstanceKeyForUninstall({
    readOwner: async () => null,
    revoke: async () => {
      throw new Error("must not revoke");
    },
  });
  assert.equal(outcome.exitCode, 0);
});

test("a key that may still be live fails and points to the Console", async () => {
  const outcome = await revokeInstanceKeyForUninstall({
    readOwner: async () => "org_owner",
    revoke: async () => {
      throw new Error("Studio could not reach Beam at https://api.b1m.ai.");
    },
  });
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.message, /Beam Console/);
});
