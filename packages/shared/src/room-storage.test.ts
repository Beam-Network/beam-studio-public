import assert from "node:assert/strict";
import test from "node:test";
import { roomStorageBindingInputSchema } from "./room-storage.js";

const id = (kind: "room" | "channel" | "member" | "role", value: string) =>
  `btr_${kind}_${value.repeat(26).slice(0, 26)}`;

test("room storage binding references the existing credential and room authorization", () => {
  const parsed = roomStorageBindingInputSchema.parse({
    environmentTemplateKey: "prod",
    roomId: id("room", "a"),
    credentialId: "cred_existing",
    bucket: "archive",
    displayName: "Archive bucket",
    objectChannelIds: [id("channel", "b")],
    roleIds: [id("role", "c")],
    sourceDelegateMemberIds: [id("member", "d")],
  });

  assert.equal(parsed.credentialId, "cred_existing");
  assert.equal(parsed.destinationLayout, "isolated");
  assert.equal(parsed.collisionPolicy, "fail_if_exists");
});

test("room storage binding rejects duplicate authorization references", () => {
  const channelId = id("channel", "b");
  assert.equal(
    roomStorageBindingInputSchema.safeParse({
      environmentTemplateKey: "prod",
      roomId: id("room", "a"),
      credentialId: "cred_existing",
      bucket: "archive",
      displayName: "Archive bucket",
      objectChannelIds: [channelId, channelId],
    }).success,
    false,
  );
});
