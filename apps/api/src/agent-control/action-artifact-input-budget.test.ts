import assert from "node:assert/strict";
import { test } from "node:test";
import { RoomMemberActionAssignments } from "./action-assignments.js";

test("settlement counts frozen room artifact bytes without re-materializing its URI", () => {
  const assignments = new RoomMemberActionAssignments(
    {} as any,
    {} as any,
    {} as any,
  );
  const manifest = {
    name: "@test/consumer",
    version: "1.0.0",
    apiVersion: "workflow-actions/v1",
    runtime: { placements: ["room-members"] },
    inputs: {
      source: { type: "artifact", format: "text/plain", required: true },
    },
    outputs: {
      result: { type: "artifact", format: "text/plain", required: true },
    },
  } as any;
  const task = {
    input_json: {},
    metadata_json: {
      artifactInputs: {
        source: [
          {
            manifestId: "manifest",
            artifactId: "artifact",
            sha256: `sha256:${"a".repeat(64)}`,
            sizeBytes: 6,
            mediaType: "text/plain",
            location: {
              kind: "member",
              roomId: "room",
              channelId: "objects",
              sourceMemberId: "source",
              memberId: "consumer",
              transferId: "transfer",
            },
          },
        ],
      },
    },
  };
  assert.deepEqual(assignments.artifactInputBudget(manifest, task), {
    count: 1,
    totalBytes: 6,
  });
  assert.throws(
    () =>
      assignments.artifactInputBudget(manifest, {
        ...task,
        metadata_json: {
          artifactInputs: {
            source: [
              { ...task.metadata_json.artifactInputs.source[0], sha256: "bad" },
            ],
          },
        },
      }),
    /executor_artifact_input_unavailable/,
  );
});
