import assert from "node:assert/strict";
import test from "node:test";
import { trustedRoomAssignmentDeadline } from "./action-assignment-lifecycle.js";

const step = {
  actionPackage: "@beam/room-transfer",
  sourceRegistry: "public-registry",
  manifestSnapshot: {
    name: "@beam/room-transfer",
    apiVersion: "workflow-actions/v1",
    trustLevel: "verified",
    execution: { isolation: "trusted-node", defaultTimeoutSeconds: 86520 },
  },
};
const task = { id: "task", attempt_count: 2 };
const assignment = { created_at: "2026-09-23T00:00:00.000Z" };
const stepRun = {
  state_json: { publicationId: "publication" },
  resource_execution_json: {
    state: "active",
    trusted_idle_lease: {
      taskId: "task",
      attempt: 2,
      publicationId: "publication",
      idleExpiresAt: "2026-09-23T03:00:00.000Z",
    },
  },
};

test("only the current trusted room publication replaces the assignment's fixed timeout", () => {
  assert.equal(
    trustedRoomAssignmentDeadline(step, stepRun, task, assignment),
    Date.parse("2026-09-23T03:00:00.000Z"),
  );
  for (const lease of [
    { ...stepRun.resource_execution_json.trusted_idle_lease, taskId: "other" },
    { ...stepRun.resource_execution_json.trusted_idle_lease, attempt: 1 },
    {
      ...stepRun.resource_execution_json.trusted_idle_lease,
      publicationId: "other",
    },
  ]) {
    assert.equal(
      trustedRoomAssignmentDeadline(
        step,
        {
          ...stepRun,
          resource_execution_json: {
            state: "active",
            trusted_idle_lease: lease,
          },
        },
        task,
        assignment,
      ),
      Date.parse(assignment.created_at) + 300_000,
    );
  }
  assert.equal(
    trustedRoomAssignmentDeadline(
      { ...step, actionPackage: "@beam/transfer" },
      stepRun,
      task,
      assignment,
    ),
    null,
  );
});
