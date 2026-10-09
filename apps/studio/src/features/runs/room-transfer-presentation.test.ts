import assert from "node:assert/strict";
import test from "node:test";
import { roomMemberKindLabel, roomRecipientPresentation, roomSourcePresentation } from "./room-transfer-presentation.js";

const state = {
  publicationId: "publication",
  execution: { publication_id: "publication", schema_version: "room-transfer/v1", protection: "btr.object.chunk.aead.v1", targets: [{ member_id: "recipient" }] },
};
test("displays the authored agent source and the coordinator endpoint source", () => {
  assert.deepEqual(roomSourcePresentation({ memberId: "source", locator: { type: "agent_path" } }), { memberId: "source", kind: "agent" });
  assert.deepEqual(roomSourcePresentation({ member_id: "bucket", kind: "object_storage" }), { memberId: "bucket", kind: "object_storage" });
  assert.equal(roomMemberKindLabel(undefined), "Unknown");
});
test("historical recipient display uses bound encrypted target evidence without changing results", () => {
  const recipient = { member_id: "recipient", state: "delivered" };
  const before = JSON.stringify({ state, recipient });
  assert.deepEqual(roomRecipientPresentation(state, recipient, {}), { destination: {}, kind: "agent", protection: "room_mls_e2ee" });
  assert.equal(JSON.stringify({ state, recipient }), before);
});
test("unbound, missing and mixed-publication evidence cannot imply room E2EE", () => {
  for (const execution of [undefined, { ...state.execution, publication_id: "other" }, { ...state.execution, schema_version: "room-storage-transfer/v2" }, { ...state.execution, targets: [] }, { ...state.execution, protection: "provider_tls" }]) {
    assert.equal(roomRecipientPresentation({ ...state, execution }, { member_id: "recipient" }, {}).protection, undefined);
  }
  assert.equal(roomRecipientPresentation(state, { member_id: "recipient", recipient_kind: "object_storage" }, {}).protection, undefined);
});
test("explicit mixed recipient protection remains provider TLS", () => {
  assert.deepEqual(roomRecipientPresentation(state, { member_id: "recipient", recipient_kind: "agent", protection: "provider_tls" }, {}), { destination: {}, kind: "agent", protection: "provider_tls" });
});
