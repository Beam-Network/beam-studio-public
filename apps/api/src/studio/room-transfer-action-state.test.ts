import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  recordRoomTransferActionState,
  requireRoomTransferAction,
  resetRoomTransferActionState,
  roomTransferActionAvailable,
} from "./room-transfer-action-state.js";

beforeEach(() => resetRoomTransferActionState());

test("an available action permits room transfers", async () => {
  recordRoomTransferActionState({ installed: false, available: true });
  assert.equal(roomTransferActionAvailable(), true);
  await requireRoomTransferAction();
});

test("an unavailable action is refused with a coded, exposed error", async () => {
  // Previously this reached resolveActionPackageVersionPg, which throws a bare
  // Error that the server flattens to 500 "Internal server error" — discarding
  // the one detail that explains the problem.
  recordRoomTransferActionState({
    installed: false,
    available: false,
    reason: "Registry request failed with 404",
  });

  await assert.rejects(
    () => requireRoomTransferAction(),
    (
      error: Error & { code?: string; statusCode?: number; expose?: boolean },
    ) => {
      assert.equal(error.code, "room_transfer_action_unavailable");
      assert.equal(error.statusCode, 503);
      assert.equal(error.expose, true, "the message must reach the caller");
      assert.match(error.message, /@beam\/room-transfer@/);
      assert.match(error.message, /Registry/);
      return true;
    },
  );
});

test("the recorded reason is carried for diagnosis", async () => {
  recordRoomTransferActionState({
    installed: false,
    available: false,
    reason: "room_transfer_action_manifest_has_retired_coordinatorUrl",
  });
  await assert.rejects(
    () => requireRoomTransferAction(),
    (error: Error & { details?: { reason?: string | null } }) => {
      assert.match(String(error.details?.reason), /retired_coordinatorUrl/);
      return true;
    },
  );
});
