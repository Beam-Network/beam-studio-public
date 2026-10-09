import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EncryptedFileRefreshTokenStore } from "./secure-token-store.js";

test("persists a refresh token encrypted, owner-only, and replaces rotations atomically", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "beam-studio-oauth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "session.json");
  const store = new EncryptedFileRefreshTokenStore(path, "test-vault-secret");

  await store.save("refresh-generation-1");
  assert.equal(await store.load(), "refresh-generation-1");
  assert.equal(
    (await readFile(path, "utf8")).includes("refresh-generation-1"),
    false,
  );
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  await store.save("refresh-generation-2");
  assert.equal(await store.load(), "refresh-generation-2");
  assert.deepEqual(await readdir(directory), ["session.json"]);
  await store.clear();
  assert.equal(await store.load(), null);
});
