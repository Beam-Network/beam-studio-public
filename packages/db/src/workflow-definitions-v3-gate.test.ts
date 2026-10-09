import assert from "node:assert/strict";
import test from "node:test";
import {
  enqueueFrozenWorkflowRunPg,
  type FrozenWorkflowDefinition,
} from "./workflow-definitions.js";
import type { PgClient } from "./postgres.js";

const definition = {
  revisionId: "revision",
  workflowTemplateId: "template",
  organizationId: "org",
  projectId: null,
  snapshot: {
    graphVersion: "workflow-graph/v3",
    contract: { inputSchema: {}, output: {} },
  },
  resolvedSteps: [],
} as unknown as FrozenWorkflowDefinition;

test("V3 launch refuses an absent or denying private readiness gate before database mutation", async () => {
  let queries = 0;
  const client = {
    async query() {
      queries++;
      throw new Error("database mutation reached");
    },
  } as unknown as PgClient;
  const input = {
    definition,
    definitions: { template: definition },
    runtimeInput: {},
    trigger: "api",
  };
  await assert.rejects(
    enqueueFrozenWorkflowRunPg(client, input),
    /execution is pending distributed task orchestration/,
  );
  let checked = false;
  await assert.rejects(
    enqueueFrozenWorkflowRunPg(client, {
      ...input,
      v3Launch: {
        async assertReady(_client, candidate) {
          checked = true;
          assert.equal(candidate, definition);
          throw new Error("private controller missing");
        },
      },
    }),
    /private controller missing/,
  );
  assert.equal(checked, true);
  assert.equal(queries, 0);
});
