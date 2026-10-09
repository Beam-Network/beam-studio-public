import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWorkflowValue,
  defaultWorkflowContract,
  materializeWorkflowOutput,
  resolveWorkflowBindings,
  validateWorkflowContract,
} from "./contracts.js";

test("workflow contracts validate without coercing or inserting defaults", () => {
  const schema = {
    type: "object",
    properties: { count: { type: "integer", default: 5 } },
    required: ["count"],
    additionalProperties: false,
  };
  const input = {};
  assert.throws(() => assertWorkflowValue(schema, input, "input"));
  assert.deepEqual(input, {});
  assert.throws(() => assertWorkflowValue(schema, { count: "5" }, "input"));
  assertWorkflowValue(schema, { count: 5 }, "input");
});

test("public output supports objects, scalars, arrays and explicit null", () => {
  const context = {
    input: {},
    steps: new Map([
      [
        "child",
        {
          status: "completed",
          output: { count: 4, maybe: null },
          runId: "child-run",
        },
      ],
    ]),
  };
  assert.equal(
    materializeWorkflowOutput(
      { schema: { type: "integer" }, bindings: "${steps.child.outputs.count}" },
      context,
    ),
    4,
  );
  assert.deepEqual(
    materializeWorkflowOutput(
      {
        schema: { type: "array", items: { type: "integer" } },
        bindings: ["${steps.child.outputs.count}"],
      },
      context,
    ),
    [4],
  );
  assert.equal(
    materializeWorkflowOutput(
      { schema: { type: "null" }, bindings: "${steps.child.outputs.maybe}" },
      context,
    ),
    null,
  );
  assert.equal(
    resolveWorkflowBindings("${steps.child.runId}", context),
    "child-run",
  );
  assert.throws(
    () =>
      materializeWorkflowOutput(
        {
          schema: { type: "null" },
          bindings: "${steps.child.outputs.missing}",
        },
        context,
      ),
    /Unresolved/,
  );
  assert.throws(
    () =>
      resolveWorkflowBindings("${steps.child.steps.internal.outputs}", context),
    /Unsupported/,
  );
});

test("failed and cancelled calls expose outcome without business output", () => {
  for (const status of ["failed", "cancelled"]) {
    const context = {
      input: {},
      steps: new Map([
        ["child", { status, error: "stopped", runId: "child-run" }],
      ]),
    };
    assert.equal(
      resolveWorkflowBindings("${steps.child.status}", context),
      status,
    );
    assert.throws(
      () => resolveWorkflowBindings("${steps.child.outputs}", context),
      /no successful/,
    );
  }
});

test("schema and mapping validation rejects remote refs and internal child access", () => {
  validateWorkflowContract(defaultWorkflowContract);
  assert.throws(
    () =>
      validateWorkflowContract({
        ...defaultWorkflowContract,
        inputSchema: { $ref: "https://example.com/schema" },
      }),
    /document-local/,
  );
  assert.throws(
    () =>
      validateWorkflowContract({
        ...defaultWorkflowContract,
        inputSchema: { type: "invalid" },
      }),
    /Invalid workflow schema/,
  );
  assert.throws(
    () =>
      validateWorkflowContract({
        ...defaultWorkflowContract,
        output: {
          schema: {},
          bindings: "${steps.child.steps.private.outputs}",
        },
      }),
    /Unsupported/,
  );
  assert.throws(
    () =>
      resolveWorkflowBindings("${workflow.input.constructor}", {
        input: {},
        steps: new Map(),
      }),
    /Unresolved/,
  );
});

test("draft-07 formats and union types validate without transforming values", () => {
  assertWorkflowValue(
    { type: ["string", "null"], format: "date-time" },
    null,
    "input",
  );
  assertWorkflowValue(
    { type: ["string", "null"], format: "date-time" },
    "2026-09-15T12:00:00Z",
    "input",
  );
  assert.throws(() =>
    assertWorkflowValue(
      { type: "string", format: "date-time" },
      "tomorrow",
      "input",
    ),
  );
});

test("explicit literal bindings preserve text that looks like an expression", () => {
  assert.deepEqual(
    materializeWorkflowOutput(
      {
        schema: { type: "object" },
        bindings: { $literal: { text: "${steps.private.outputs}" } },
      },
      { input: {}, steps: new Map() },
    ),
    { text: "${steps.private.outputs}" },
  );
});
