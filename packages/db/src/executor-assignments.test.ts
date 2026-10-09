import assert from "node:assert/strict";
import test from "node:test";
import { confirmedRoomCancellationError } from "./executor-assignments.js";

const cancelledRoom = { kind: "room-publication", state: "cancelled" };

test("confirmed room cancellation suppresses a stale worker claim error", () => {
  assert.equal(
    confirmedRoomCancellationError("cancelled", cancelledRoom, null),
    null,
  );
  assert.equal(
    confirmedRoomCancellationError("cancel_requested", cancelledRoom, {
      code: "executor_cancelled",
      message: "Execution cancelled.",
    }),
    null,
  );
  assert.equal(
    confirmedRoomCancellationError("cancelled", cancelledRoom, {
      code: "executor_cleanup_required",
      message: "Cleanup pending.",
    }),
    null,
  );
  assert.equal(
    confirmedRoomCancellationError("cancelled", cancelledRoom, {
      message:
        "Workflow state write rejected: execution claim expired or cancelled.",
    }),
    null,
  );
});

test("genuine failures and unconfirmed cancellation remain visible", () => {
  const failure = {
    code: "provider_cleanup_failed",
    message: "Cleanup failed.",
  };
  assert.deepEqual(
    confirmedRoomCancellationError("cancelled", cancelledRoom, failure),
    failure,
  );
  assert.equal(
    confirmedRoomCancellationError("running", cancelledRoom, null),
    undefined,
  );
  assert.equal(
    confirmedRoomCancellationError(
      "cancelled",
      { kind: "room-publication", state: "active" },
      null,
    ),
    undefined,
  );
});
