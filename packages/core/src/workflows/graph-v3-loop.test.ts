import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveWorkflowGraphV3,
  resolveWorkflowGraphV3CarryRoutes,
  resolveWorkflowGraphV3InitialRoutes,
  validateWorkflowGraphV3,
  type WorkflowGraphV3Definition,
  type WorkflowGraphV3LoopControl,
} from "./graph-v3.js";

const batch = {
  name: "batch",
  kind: "artifact",
  cardinality: "one",
  format: "application/vnd.beam.ring-batch.v1+json",
} as const;
const graph: WorkflowGraphV3Definition = {
  version: "workflow-graph/v3",
  controls: [
    {
      id: "ring",
      kind: "loop",
      iterations: 5,
      body: {
        stepIds: ["transform"],
        entryStepId: "transform",
        outputStepId: "transform",
        edges: [],
      },
      initial: {
        routes: [
          {
            from: { stepId: "seed", port: "batch" },
            to: { stepId: "transform", port: "batch" },
            association: "identity",
          },
        ],
      },
      carry: {
        routes: [
          {
            from: { stepId: "transform", port: "batch" },
            to: { stepId: "transform", port: "batch" },
            association: "ring-successor",
          },
        ],
      },
    },
  ],
  edges: [],
  distribution: {
    partitions: [
      {
        id: "participants",
        members: {
          kind: "explicit",
          memberIds: ["member_a", "member_b", "member_c"],
        },
        order: "declared",
      },
    ],
    steps: [
      {
        stepId: "seed",
        partitionId: "participants",
        placement: "room-member",
        inputs: [],
        outputs: [batch],
      },
      {
        stepId: "transform",
        partitionId: "participants",
        placement: "room-member",
        inputs: [
          batch,
          { name: "source", kind: "member-id", cardinality: "one" },
          { name: "recipients", kind: "member-id-list", cardinality: "many" },
        ],
        outputs: [batch],
        transfer: {
          topology: "ring",
          sourceInput: "source",
          recipientsInput: "recipients",
        },
      },
    ],
    routes: [],
  },
};
const steps = [
  { id: "seed", enabled: true },
  { id: "transform", enabled: true },
];
const members = {
  participants: ["member_a", "member_b", "member_c"].map((memberId) => ({
    memberId,
  })),
};

test("five bounded iterations retain one three-member ring and 15 identified deliveries", () => {
  const roundTrip = JSON.parse(
    JSON.stringify(graph),
  ) as WorkflowGraphV3Definition;
  validateWorkflowGraphV3(roundTrip, steps);
  const plan = resolveWorkflowGraphV3(roundTrip, steps, members);
  const loop = roundTrip.controls[0] as WorkflowGraphV3LoopControl;
  assert.equal(
    plan.tasks.filter((task) => task.stepId === "transform").length,
    3,
  );
  assert.deepEqual(
    plan.tasks
      .filter((task) => task.stepId === "transform")
      .map((task) => task.recipientMemberIds),
    [["member_b"], ["member_c"], ["member_a"]],
  );
  const initial = resolveWorkflowGraphV3InitialRoutes(loop, plan.tasks);
  const carry = resolveWorkflowGraphV3CarryRoutes(loop, plan.tasks);
  assert.deepEqual(
    initial.map((route) => [route.from.memberId, route.to.memberId]),
    [
      ["member_a", "member_a"],
      ["member_b", "member_b"],
      ["member_c", "member_c"],
    ],
  );
  assert.deepEqual(
    carry.map((route) => [route.from.memberId, route.to.memberId]),
    [
      ["member_a", "member_b"],
      ["member_b", "member_c"],
      ["member_c", "member_a"],
    ],
  );
  assert.equal(carry.length * Number(loop.iterations), 15);
});

test("V3 rejects unbounded or unsupported loop shapes before launch", () => {
  const changed = (mutate: (value: WorkflowGraphV3Definition) => void) => {
    const value = structuredClone(graph);
    mutate(value);
    return value;
  };
  for (const iterations of [0, 129, "${workflow.input.count}"]) {
    assert.throws(
      () =>
        validateWorkflowGraphV3(
          changed((value) => {
            (value.controls[0] as WorkflowGraphV3LoopControl).iterations =
              iterations as number;
          }),
          steps,
        ),
      /iteration count|iterations|maximum iteration count/,
    );
  }
  assert.throws(
    () =>
      validateWorkflowGraphV3(
        changed((value) => {
          value.controls.push(structuredClone(value.controls[0]!));
        }),
        steps,
      ),
    /at most one bounded loop|duplicated or collides/,
  );
  assert.throws(
    () =>
      validateWorkflowGraphV3(
        changed((value) => {
          delete (value.controls[0] as Partial<WorkflowGraphV3LoopControl>)
            .initial;
        }),
        steps,
      ),
    /initial top-level distributed seed/,
  );
  assert.throws(
    () =>
      validateWorkflowGraphV3(
        changed((value) => {
          (
            value.controls[0] as WorkflowGraphV3LoopControl
          ).carry.routes[0]!.association = "identity" as "ring-successor";
        }),
        steps,
      ),
    /unsupported carry association/,
  );
});
