import assert from "node:assert/strict";
import test from "node:test";
import { roomActionUnavailableReason } from "./room-access.js";

const active = { state: "active", readOnly: false, canManage: true };

test("an available control has no reason to explain", () => {
  assert.equal(roomActionUnavailableReason(active), null);
});

test("an inactive room is distinguished from a room you cannot manage", () => {
  // The two causes need different answers, so they must not share wording.
  const closed = roomActionUnavailableReason({ ...active, state: "closed" });
  const unmanageable = roomActionUnavailableReason({
    ...active,
    readOnly: true,
    canManage: false,
  });
  assert.match(closed ?? "", /closed/);
  assert.match(unmanageable ?? "", /manage rights/);
  assert.notEqual(closed, unmanageable);
});

test("a room created outside Studio points at the owning identity", () => {
  const reason = roomActionUnavailableReason({
    ...active,
    readOnly: true,
    canManage: false,
  });
  assert.match(reason ?? "", /member-owned/);
  assert.match(reason ?? "", /beam room invite/);
});

test("an organization room awaiting an agent says so", () => {
  const reason = roomActionUnavailableReason({
    ...active,
    readOnly: true,
    canManage: true,
  });
  assert.match(reason ?? "", /read-only until a managed agent/);
});
