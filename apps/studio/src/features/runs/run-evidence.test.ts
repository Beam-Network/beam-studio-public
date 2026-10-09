import assert from "node:assert/strict";
import test from "node:test";
import { withRunEvidence, type RunEvidence } from "./run-evidence";
import type { RunBundle } from "./run-detail-data";

test("fresh diagnostics cannot overwrite output or cross an invocation attempt/publication", () => {
  const source: RunBundle = {
    run: { status: "completed", output: { value: 42 } },
    stepRuns: [
      {
        id: "step",
        attempt: 2,
        actionPackageName: "@beam/room-transfer",
        output: { delivered: true },
        state: { publicationId: "publication", execution: { stale: true } },
      },
    ],
  };
  const original = JSON.stringify(source);
  const current: RunEvidence = {
    steps: [
      {
        id: "step",
        attempt: 2,
        publicationId: "publication",
        execution: { fresh: true },
        executionInspection: { status: "current" },
      },
    ],
  };
  const result = withRunEvidence(source, current);
  assert.deepEqual(result.run, source.run);
  assert.deepEqual(result.stepRuns![0]!.output, { delivered: true });
  assert.deepEqual((result.stepRuns![0]!.state as any).execution, {
    fresh: true,
  });
  for (const change of [
    { attempt: 1 },
    { publicationId: "other" },
    { id: "other" },
  ]) {
    const stale = withRunEvidence(source, {
      steps: [{ ...current.steps[0]!, ...change }],
    });
    assert.equal((stale.stepRuns![0]!.state as any).execution, null);
  }
  assert.equal(
    (withRunEvidence(source, current, true).stepRuns![0]!.state as any)
      .execution,
    null,
  );
  const denied = withRunEvidence(source, {
    steps: [
      {
        ...current.steps[0]!,
        execution: null,
        executionInspection: { status: "access_denied" },
      },
    ],
  });
  assert.equal(
    (denied.stepRuns![0]!.state as any).executionInspection.status,
    "access_denied",
  );
  assert.equal(JSON.stringify(source), original);
});
