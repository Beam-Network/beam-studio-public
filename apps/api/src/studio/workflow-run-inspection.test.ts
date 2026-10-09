import assert from "node:assert/strict";
import test from "node:test";
import { builtinBeamEnvironmentTemplates } from "@beam-studio/shared";
import { inspectWorkflowRun } from "./workflow-run-inspection.js";

function fixture() {
  const config = {
    environmentTemplateKey: "prod",
    roomId: `btr_room_${"a".repeat(26)}`,
    channelId: "btr_channel_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    source: {
      memberId: "btr_member_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      locator: { type: "agent_path", path: "/data/source" },
    },
  };
  const bundle = {
    run: {
      organizationId: "org",
      status: "completed",
      output: { delivered: true },
      room: null,
    },
    steps: [{ id: "step", config }],
    stepRuns: [
      {
        id: "instance",
        workflowStepId: "step",
        actionPackageName: "@beam/room-transfer",
        output: { delivered: true },
        state: {
          ...config,
          publicationId: "publication",
          execution: { attempts: [] },
        },
      },
    ],
  };
  let calls = 0;
  let execution: unknown = { publication_id: "publication", attempts: [] };
  let failure: unknown;
  const deps = {
    getWorkflowRun: async (id: string, organization: string) => {
      assert.equal(id, "run");
      assert.equal(organization, "org");
      return bundle;
    },
    resolveBeamEnvironmentTemplate: async () =>
      builtinBeamEnvironmentTemplates.prod,
    roomService: (organization: string, template: { key: string }) => {
      assert.equal(organization, "org");
      assert.equal(template.key, "prod");
      return {
        token: "service",
        client: {
          organizationObjectExecution: async (...args: unknown[]) => {
            calls++;
            assert.deepEqual(args, [
              "org",
              config.roomId,
              config.channelId,
              "publication",
              "service",
            ]);
            if (failure) throw failure;
            return { execution };
          },
        },
      };
    },
  };
  return {
    bundle,
    deps: deps as any,
    calls: () => calls,
    setExecution: (value: unknown) => {
      execution = value;
    },
    fail: (value: unknown) => {
      failure = value;
    },
  };
}

test("terminal inspection refreshes delayed evidence without rewriting committed results", async () => {
  const f = fixture();
  const original = JSON.stringify(f.bundle);
  const pending = await inspectWorkflowRun("run", "org", f.deps);
  assert.equal(
    (pending!.stepRuns[0]!.state as any).executionInspection.status,
    "pending",
  );
  f.setExecution({
    publication_id: "publication",
    attempts: [{ lane_id: "lane" }],
    finalization: { verified: true },
  });
  const refreshed = await inspectWorkflowRun("run", "org", f.deps);
  assert.equal(
    (refreshed!.stepRuns[0]!.state as any).execution.attempts.length,
    1,
  );
  assert.equal(
    (refreshed!.stepRuns[0]!.state as any).executionInspection.status,
    "current",
  );
  assert.equal(JSON.stringify(f.bundle), original);
  assert.deepEqual(refreshed!.run.output, { delivered: true });
  assert.equal(f.calls(), 2);
});

test("inspection scopes reads and rejects conflicting publication bindings", async () => {
  const f = fixture();
  await assert.rejects(
    inspectWorkflowRun("run", "", f.deps),
    /organization is required/,
  );
  f.bundle.stepRuns[0]!.state.roomId = "another-room";
  const result = await inspectWorkflowRun("run", "org", f.deps);
  assert.equal(
    (result!.stepRuns[0]!.state as any).executionInspection.status,
    "binding_mismatch",
  );
  assert.equal(f.calls(), 0);
  f.bundle.run.organizationId = "other";
  assert.equal(await inspectWorkflowRun("run", "org", f.deps), null);
});

test("revoked or unavailable diagnostics cannot fail completed delivery or expose error details", async () => {
  const f = fixture();
  f.fail(
    Object.assign(new Error("secret provider route"), { statusCode: 403 }),
  );
  const result = await inspectWorkflowRun("run", "org", f.deps);
  assert.equal(result!.run.status, "completed");
  assert.equal(
    (result!.stepRuns[0]!.state as any).executionInspection.status,
    "access_denied",
  );
  assert.equal((result!.stepRuns[0]!.state as any).execution, null);
  assert.ok(!JSON.stringify(result).includes("secret provider"));
});
