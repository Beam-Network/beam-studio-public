import assert from "node:assert/strict";
import { test } from "node:test";
import { artifactReleaseReceiptMatches } from "./action-assignment-lifecycle.js";

const obligation = {
  assignment_id: "assignment",
  attempt: 2,
  obligation_id: "hold:0",
  current_generation: 4,
};
const receipt = {
  state: "completed",
  session_generation: 4,
  operation: "action.artifact.release",
  payload_json: {
    assignmentId: "assignment",
    attempt: 2,
    retentionObligationId: "hold:0",
  },
  result_json: {
    assignmentId: "assignment",
    retentionObligationId: "hold:0",
    released: true,
    cleanupConfirmed: false,
  },
};

test("durable release acknowledgement survives incomplete cleanup", () => {
  assert.equal(artifactReleaseReceiptMatches(receipt, obligation), true);
  assert.equal(
    artifactReleaseReceiptMatches({ ...receipt, state: "failed" }, obligation),
    false,
  );
  assert.equal(
    artifactReleaseReceiptMatches(
      { ...receipt, session_generation: 3 },
      obligation,
    ),
    false,
  );
  assert.equal(
    artifactReleaseReceiptMatches(
      { ...receipt, transport: "room-mls/v1", session_generation: 3 },
      obligation,
    ),
    true,
  );
  assert.equal(
    artifactReleaseReceiptMatches(
      {
        ...receipt,
        payload_json: { ...receipt.payload_json, attempt: 1 },
      },
      obligation,
    ),
    false,
  );
  assert.equal(
    artifactReleaseReceiptMatches(
      {
        ...receipt,
        result_json: { ...receipt.result_json, released: false },
      },
      obligation,
    ),
    false,
  );
});
