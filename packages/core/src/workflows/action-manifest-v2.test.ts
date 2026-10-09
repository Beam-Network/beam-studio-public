import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { validateActionManifest, type ActionManifest } from "./actions.js";
import { assertWorkflowActionConfig } from "./action-config.js";
import { checksumManifest } from "./registry.js";

const folder = new URL("./fixtures/registry-v2/", import.meta.url);
const index = JSON.parse(
  await readFile(new URL("cases.json", folder), "utf8"),
) as Array<{
  file: string;
  valid: boolean;
  checksum?: string;
  error?: string;
}>;

for (const entry of index) {
  test(`Registry manifest contract: ${entry.file}`, async () => {
    const manifest = JSON.parse(
      await readFile(new URL(entry.file, folder), "utf8"),
    ) as ActionManifest;
    if (entry.valid) {
      assert.doesNotThrow(() => validateActionManifest(manifest));
      if (entry.checksum)
        assert.equal(checksumManifest(manifest), entry.checksum);
    } else {
      assert.throws(
        () => validateActionManifest(manifest),
        new RegExp(entry.error!, "i"),
      );
    }
  });
}

test("Registry v2 requires an explicitly admitted V3 room target for execution", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("v2-single.valid.json", folder), "utf8"),
  ) as ActionManifest;
  assert.doesNotThrow(() =>
    assertWorkflowActionConfig(manifest, {}, null, false),
  );
  assert.throws(
    () => assertWorkflowActionConfig(manifest, {}, null, true),
    /V3 room-member target/,
  );
  assert.throws(
    () => assertWorkflowActionConfig(manifest, {}, null, true,
      { kind: "studio" }, true),
    /V3 room-member target/,
  );
  assert.doesNotThrow(() => assertWorkflowActionConfig(
    manifest, {}, { roomId: `btr_room_${"a".repeat(26)}`,
      environmentTemplateKey: "env" }, true,
    { kind: "room-member", memberIds: ["member"], channelId: "request",
      requesterMemberId: "controller" }, true,
  ));
});

test("V3 ring actions accept only empty authored config before a frozen task supplies required fields", async () => {
  const base = JSON.parse(
    await readFile(new URL("v2-single.valid.json", folder), "utf8"),
  ) as ActionManifest;
  const target = { kind: "room-member" as const, memberIds: ["member"],
    channelId: "request", requesterMemberId: "controller" };
  for (const [name, required] of [
    ["@beam/ring-batch-seed", ["memberId", "batchId", "lotId"]],
    ["@beam/ring-batch-transform", ["sourceMemberId", "targetMemberId", "iteration"]],
  ] as const) {
    const manifest = {
      ...base, name,
      configSchema: { type: "object", additionalProperties: false,
        required: [...required], properties: Object.fromEntries(required.map((key) => [
          key, { type: key === "iteration" ? "integer" : "string" },
        ])) },
    } as ActionManifest;
    assert.throws(() => assertWorkflowActionConfig(manifest, {}, null,
      false, target), /is required/);
    assert.doesNotThrow(() => assertWorkflowActionConfig(manifest, {}, null,
      false, target, false, true));
    assert.throws(() => assertWorkflowActionConfig(manifest,
      { [required[0]]: "authored" }, null, false, target, false, true),
    /generated from its frozen V3 member task/);
  }
});
