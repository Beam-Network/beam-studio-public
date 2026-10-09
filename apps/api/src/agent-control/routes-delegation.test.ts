import assert from "node:assert/strict";
import test from "node:test";
import { delegatedCommandHistoryResult, listedRoomIsClosed } from "./routes.js";

test("closed coordinator rooms are omitted before Studio requests snapshots", () => {
  assert.equal(
    listedRoomIsClosed({ room: { room_id: "room-closed", state: "closed" } }),
    true,
  );
  assert.equal(
    listedRoomIsClosed({ room_id: "room-flat", state: "CLOSED" }),
    true,
  );
  assert.equal(
    listedRoomIsClosed({ room: { room_id: "room-active", state: "active" } }),
    false,
  );
});

test("delegated invitation tokens are returned transiently but redacted from command history", () => {
  const result = {
    invitation: {
      invitation: { invitation_id: "invite_test", max_uses: 32 },
      invitation_token: "secret-bearer",
    },
  };

  assert.deepEqual(
    delegatedCommandHistoryResult("room.invitation.create", result),
    {
      invitation: {
        invitation: { invitation_id: "invite_test", max_uses: 32 },
        invitation_token: "[REDACTED]",
      },
    },
  );
  assert.equal(result.invitation.invitation_token, "secret-bearer");
});
