import assert from "node:assert/strict";
import test from "node:test";
import type { TransferPrepareResponse } from "@beam-network/sdk";
import { standardRoomBindingInput } from "./room-standard-binding.js";

function prepared() {
  return {
    transfer_id: "runtime",
    transfer_key: "transient-proof",
    plan_fingerprint: "frozen-plan",
    plan_descriptor: {
      sources: [
        {
          source_id: "source",
          url: "https://provider.invalid/object?signature=private",
          headers: { Authorization: "secret" },
        },
      ],
      destinations: [
        {
          destination_id: "r2",
          destination_index: 0,
          final_object_keys: { source: "prefix/result" },
        },
        {
          destination_id: "hf",
          destination_index: 1,
          final_object_keys: { source: "namespace/result" },
        },
      ],
    },
  } as unknown as TransferPrepareResponse;
}

test("standard room binding keeps Runtime destination order and only safe plan identity", () => {
  const value = standardRoomBindingInput(prepared(), [
    { memberId: "b", resourceId: "bucket-b", destinationId: "hf" },
    { memberId: "a", resourceId: "bucket-a", destinationId: "r2" },
  ]);
  assert.deepEqual(
    value.standard_transfer.destinations.map(
      (target) => target.destination_index,
    ),
    [1, 0],
  );
  assert.equal(value.transfer_key, "transient-proof");
  assert.equal(value.standard_transfer.transfer_id, "runtime");
  assert.equal(
    JSON.stringify(value.standard_transfer).includes("signature"),
    false,
  );
  assert.equal(
    JSON.stringify(value.standard_transfer).includes("secret"),
    false,
  );
  assert.equal(
    JSON.stringify(value.standard_transfer).includes("transient-proof"),
    false,
  );
});

test("standard binding fails closed for missing ownership, targets or immutable object identity", () => {
  const targets = [
    { memberId: "a", resourceId: "bucket-a", destinationId: "r2" },
    { memberId: "b", resourceId: "bucket-b", destinationId: "hf" },
  ];
  assert.throws(() =>
    standardRoomBindingInput(
      { ...prepared(), transfer_key: undefined },
      targets,
    ),
  );
  assert.throws(() =>
    standardRoomBindingInput(prepared(), targets.slice(0, 1)),
  );
  assert.throws(() =>
    standardRoomBindingInput(prepared(), [targets[0]!, targets[0]!]),
  );
  const missing = prepared();
  delete missing.plan_descriptor.destinations[0]!.final_object_keys.source;
  assert.throws(() => standardRoomBindingInput(missing, targets));
});
