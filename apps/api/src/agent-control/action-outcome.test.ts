import assert from "node:assert/strict";
import test from "node:test";
import { assignmentOutcome } from "./action-outcome.js";

const assignment = { id: "assignment", attempt: 2, authority_generation: 7 };
const command = {
  operation: "action.reconcile",
  state: "completed",
  payload_json: { authorityGeneration: 7 },
  result_json: {
    assignmentId: "assignment",
    attempt: 2,
    state: "failed",
    cancellationRequested: true,
    cleanupConfirmed: true,
    artifactStorageCleanupConfirmed: true,
    transfers: [
      {
        artifactId: "artifact",
        recoveryGeneration: 1,
        transport: "room",
        publicationId: "publication",
        transferId: "transfer",
        state: "cancelled",
      },
    ],
  },
};

test("reconciliation requires process and transfer cleanup evidence", () => {
  assert.equal(assignmentOutcome(command, assignment)?.state, "failed");
  assert.equal(
    assignmentOutcome(
      {
        ...command,
        result_json: { ...command.result_json, cleanupConfirmed: false },
      },
      assignment,
    ),
    null,
  );
  assert.equal(
    assignmentOutcome(
      {
        ...command,
        result_json: {
          ...command.result_json,
          artifactStorageCleanupConfirmed: false,
        },
      },
      assignment,
    ),
    null,
  );
  assert.equal(
    assignmentOutcome(
      {
        ...command,
        result_json: {
          ...command.result_json,
          transfers: [
            { ...command.result_json.transfers[0], state: "running" },
          ],
        },
      },
      assignment,
    ),
    null,
  );
  assert.equal(
    assignmentOutcome(
      { ...command, payload_json: { authorityGeneration: 6 } },
      assignment,
    ),
    null,
  );
  const hybrid = {
    ...command.result_json.transfers[0],
    transport: "hybrid",
    state: "completed",
    cleanupConfirmed: false,
  };
  assert.equal(
    assignmentOutcome(
      {
        ...command,
        result_json: { ...command.result_json, transfers: [hybrid] },
      },
      assignment,
    ),
    null,
  );
  assert.equal(
    assignmentOutcome(
      {
        ...command,
        result_json: {
          ...command.result_json,
          transfers: [{ ...hybrid, cleanupConfirmed: true }],
        },
      },
      assignment,
    )?.state,
    "failed",
  );
});
