import assert from "node:assert/strict";
import test from "node:test";
import {
  resolvedWorkflowMembers,
  workflowTaskInspectionRecord,
} from "./workflow-run-task-inspection.js";

test("task inspection identifies the logical member, actual executor, attempts and accepted artifacts", () => {
  const task = workflowTaskInspectionRecord(
    {
      id: "task-a",
      workflow_step_id: "transfer",
      workflow_step_run_id: "step-run",
      task_kind: "step-member",
      status: "completed",
      attempt_count: 2,
      max_attempts: 3,
      metadata_json: {
        logicalPartition: { memberId: "member-a" },
        v3Route: { memberId: "member-a", assignedMemberId: "member-a" },
        claimToken: "secret-task-token",
      },
      latest_assignment: {
        member_id: "member-b",
        authorization_token: "secret-assignment-token",
      },
      input_json: { source: "member-a", recipients: ["member-b", "member-c"] },
      task_attempts: [
        {
          id: "attempt-1",
          attempt_number: 1,
          status: "failed",
          error: "retry",
          metadata_json: { claimToken: "secret-attempt-token" },
        },
        { id: "attempt-2", attempt_number: 2, status: "completed" },
      ],
      artifact_manifests: [
        {
          id: "manifest-a",
          attempt: 2,
          status: "accepted",
          publication_id: "publication-a",
          artifacts_json: [
            {
              artifactId: "artifact-a",
              port: "payload",
              mediaType: "application/octet-stream",
              sha256: "hash",
              sizeBytes: 42,
              secretLocator: "private",
            },
          ],
        },
      ],
    },
    { sourceInput: "source", recipientsInput: "recipients" },
  );
  assert.equal(task.memberId, "member-a");
  assert.equal(task.assignedMemberId, "member-b");
  assert.deepEqual(task.recipientMemberIds, ["member-b", "member-c"]);
  assert.equal(task.attempts.length, 2);
  assert.deepEqual(task.artifactIds, ["artifact-a"]);
  assert.equal(task.artifactManifests[0]?.artifacts[0]?.port, "payload");
  assert.ok(!JSON.stringify(task).includes("secret"));
});

test("task inspection preserves waiting and dead letter causes", () => {
  const queued = workflowTaskInspectionRecord({
    id: "q",
    workflow_step_id: "s",
    task_kind: "step-member",
    status: "retry_scheduled",
  });
  assert.equal(queued.waitReason, "retry_backoff");
  const failed = workflowTaskInspectionRecord({
    id: "f",
    workflow_step_id: "s",
    task_kind: "step-member",
    status: "dead_letter",
    error: "Timed out",
    dead_letter: { reason: "admission_deadline" },
  });
  assert.equal(failed.failureReason, "admission_deadline");
  assert.deepEqual(
    resolvedWorkflowMembers({
      v3RoomResolution: {
        membersByPartition: {
          cohort: [{ memberId: "a" }, { memberId: "b", key: "B" }],
        },
      },
    }),
    { cohort: [{ memberId: "a" }, { memberId: "b", key: "B" }] },
  );
});

test("task inspection exposes only bounded selectors for final loop and reduction outputs", () => {
  const loop = workflowTaskInspectionRecord({
    id: "loop-task",
    workflow_step_id: "transform",
    task_kind: "step-member",
    status: "completed",
    metadata_json: { v3Loop: { iteration: 5, sourceMemberId: "private" } },
  });
  assert.equal(loop.loopIteration, 5);
  assert.equal(loop.aggregationLeafCount, null);
  const reducer = workflowTaskInspectionRecord({
    id: "reduce-task",
    workflow_step_id: "reduce",
    task_kind: "step-aggregation",
    status: "completed",
    metadata_json: {
      aggregation: {
        collectionId: "private",
        expectedContributionIds: Array.from(
          { length: 100 },
          (_, i) => `doc_${i}`,
        ),
      },
    },
  });
  assert.equal(reducer.aggregationLeafCount, 100);
  assert.equal(reducer.loopIteration, null);
  assert.ok(!JSON.stringify(reducer).includes("private"));
});
