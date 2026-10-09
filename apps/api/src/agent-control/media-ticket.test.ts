import assert from "node:assert/strict";
import test from "node:test";
import { issueMediaTicket, verifyMediaTicket } from "./media-ticket.js";

test("media tickets are organization-scoped and expire after one minute", () => {
  const now = Date.parse("2026-08-25T12:00:00Z");
  const raw = issueMediaTicket(
    "test-secret",
    {
      agentId: "agent-a",
      organizationId: "org-a",
      roomId: "room-a",
      channelId: "channel-a",
    },
    now,
  );
  assert.deepEqual(verifyMediaTicket("test-secret", raw, now + 30_000), {
    agentId: "agent-a",
    organizationId: "org-a",
    roomId: "room-a",
    channelId: "channel-a",
    expiresAt: now + 60_000,
    nonce: verifyMediaTicket("test-secret", raw, now + 30_000)?.nonce,
  });
  assert.equal(verifyMediaTicket("other-secret", raw, now), null);
  assert.equal(verifyMediaTicket("test-secret", raw, now + 60_001), null);
});
