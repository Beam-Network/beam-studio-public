import assert from "node:assert/strict";
import test from "node:test";
import {
  fullRoomDeliveryVerified,
  verifiedRoomDeliveryStatus,
} from "./room-delivery-evidence.js";

test("Core completed status needs explicit full-delivery proof", () => {
  const deliveries = [{ member_id: "recipient", state: "delivered" }];
  for (const proof of [false, undefined]) {
    const status = {
      publisher: {
        state: "completed",
        deliveries,
        room_transfer: { status: "completed", full_delivery_verified: proof },
      },
    };
    const projected = verifiedRoomDeliveryStatus(status);
    assert.equal(projected.publisher.state, "failed");
    assert.equal(projected.publisher.room_transfer.status, "failed");
    assert.equal(
      projected.publisher.room_transfer.error_code,
      "room_transfer_delivery_unverified",
    );
    assert.equal(projected.publisher.deliveries, deliveries);
    assert.equal(status.publisher.room_transfer.status, "completed");
    assert.equal(fullRoomDeliveryVerified(status.publisher), false);
  }
  const verified = {
    publisher: {
      room_transfer: { status: "completed", full_delivery_verified: true },
    },
  };
  assert.equal(verifiedRoomDeliveryStatus(verified), verified);
  assert.equal(fullRoomDeliveryVerified(verified), true);
  const partial = {
    publisher: {
      room_transfer: { status: "partial", full_delivery_verified: false },
    },
  };
  assert.equal(verifiedRoomDeliveryStatus(partial), partial);
});
