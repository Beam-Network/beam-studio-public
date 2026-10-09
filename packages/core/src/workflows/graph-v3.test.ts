import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  GRAPH_V3_ARTIFACT_CAPABILITY,
  WORKFLOW_GRAPH_V3,
  assertGraphV3RegistryPort,
  assertGraphV3RuntimeArtifactPort,
  resolveWorkflowGraphV3,
  validateWorkflowGraphV3,
  type RegistryV2PortContract,
  type RuntimeV1ArtifactPortSchema,
  type WorkflowGraphV3Definition,
} from "./graph-v3.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/distributed-graph-v3.json", import.meta.url),
    "utf8",
  ),
) as WorkflowGraphV3Definition;
const planFixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/distributed-graph-v3-plan.json", import.meta.url),
    "utf8",
  ),
) as {
  membersByPartition: { participants: { memberId: string }[] };
  expectedTasks: unknown[];
  expectedRoutes: unknown[];
};
const invalidFixtures = JSON.parse(
  readFileSync(
    new URL("./fixtures/distributed-graph-v3-invalid.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: {
    name: string;
    expectedError: string;
    definition: WorkflowGraphV3Definition;
  }[];
};
const portConformance = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/distributed-graph-v3-port-conformance.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  registry: {
    sourceCommit: string;
    apiVersion: string;
    requiredCapabilities: string[];
    outputPort: RegistryV2PortContract;
    inputPort: RegistryV2PortContract;
  };
  runtime: {
    sourceCommit: string;
    protocol: string;
    memberAdvertisement: { artifactPorts: string };
    outputSchema: RuntimeV1ArtifactPortSchema;
    inputSchema: RuntimeV1ArtifactPortSchema;
  };
};
const steps = [
  { id: "prepare", enabled: true },
  { id: "transfer", enabled: true },
];
const members = planFixture.membersByPartition;
const change = (mutate: (graph: WorkflowGraphV3Definition) => void) => {
  const graph = structuredClone(fixture);
  mutate(graph);
  return graph;
};

test("V3 fixture preserves ports, placement, routes and member distribution", () => {
  assert.equal(fixture.version, WORKFLOW_GRAPH_V3);
  assert.equal(validateWorkflowGraphV3(fixture, steps), fixture);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture)), fixture);
  const plan = resolveWorkflowGraphV3(fixture, steps, members);
  assert.deepEqual(plan, {
    tasks: planFixture.expectedTasks,
    routes: planFixture.expectedRoutes,
  });
  assert.equal(plan.tasks.length, 6);
  assert.deepEqual(
    plan.tasks
      .filter((task) => task.stepId === "transfer")
      .map((task) => task.recipientMemberIds),
    [["member_b"], ["member_c"], ["member_a"]],
  );
  assert.equal(plan.routes.length, 3);
  assert.deepEqual(plan.routes[0], {
    from: { stepId: "prepare", memberId: "member_a", port: "payload" },
    to: { stepId: "transfer", memberId: "member_a", port: "payload" },
  });
});

test("all-to-all gives every task all other explicit member IDs", () => {
  const graph = change((value) => {
    value.distribution.steps[1]!.transfer!.topology = "all-to-all";
  });
  const plan = resolveWorkflowGraphV3(graph, steps, members);
  assert.deepEqual(
    plan.tasks
      .filter((task) => task.stepId === "transfer")
      .map((task) => task.recipientMemberIds),
    [
      ["member_b", "member_c"],
      ["member_a", "member_c"],
      ["member_a", "member_b"],
    ],
  );
});

test("large all-to-all plans fail before allocating quadratic recipient lists", () => {
  const graph = change((value) => {
    value.distribution.partitions[0]!.members = { kind: "eligible" };
    value.distribution.partitions[0]!.order = "member-id";
    value.distribution.steps[1]!.transfer!.topology = "all-to-all";
  });
  const selected = Array.from({ length: 1001 }, (_, index) => ({
    memberId: `member_${String(index).padStart(4, "0")}`,
  }));
  assert.throws(
    () => resolveWorkflowGraphV3(graph, steps, { participants: selected }),
    /transfer recipient assignments/,
  );
});

test("rejects empty and changed member selections before task planning", () => {
  assert.throws(
    () =>
      validateWorkflowGraphV3(
        change((graph) => {
          graph.distribution.partitions[0]!.members = {
            kind: "explicit",
            memberIds: [],
          };
        }),
        steps,
      ),
    /explicitly selects no members/,
  );
  assert.throws(
    () => resolveWorkflowGraphV3(fixture, steps, { participants: [] }),
    /resolved to no members/,
  );
  assert.throws(
    () =>
      resolveWorkflowGraphV3(fixture, steps, {
        participants: [{ memberId: "member_a" }],
      }),
    /does not match its explicit member selection/,
  );
});

test("eligible selections accept versioned capability names and require a frozen nonempty set", () => {
  const graph = change((value) => {
    value.distribution.partitions[0]!.members = {
      kind: "eligible",
      requiredCapabilities: [
        "action-execution/v1",
        GRAPH_V3_ARTIFACT_CAPABILITY,
        "runtime:node",
        "permission:storage:read",
      ],
    };
    value.distribution.partitions[0]!.order = "member-id";
  });
  validateWorkflowGraphV3(graph, steps);
  assert.throws(
    () => resolveWorkflowGraphV3(graph, steps, { participants: [] }),
    /resolved to no members/,
  );
  graph.distribution.partitions[0]!.members = {
    kind: "eligible",
    requiredCapabilities: ["artifact-ports/v1"],
  };
  assert.throws(() => validateWorkflowGraphV3(graph, steps), /superseded/);
});

test("shared Registry v2 and runtime v1 port fixture agrees on cardinality and exact MIME type", () => {
  const output = fixture.distribution.steps[0]!.outputs[0]!;
  const input = fixture.distribution.steps[1]!.inputs[0]!;
  assert.equal(
    portConformance.registry.sourceCommit,
    "a33dab7e4bbdae27ce4ce4d3b62c5ee3cc5b1b69",
  );
  assert.equal(
    portConformance.runtime.sourceCommit,
    "75162d03aaaa434262177d087f6a0283f4394ed4",
  );
  assert.equal(portConformance.registry.apiVersion, "workflow-actions/v2");
  assert.ok(
    portConformance.registry.requiredCapabilities.includes(
      GRAPH_V3_ARTIFACT_CAPABILITY,
    ),
  );
  assert.equal(portConformance.runtime.protocol, GRAPH_V3_ARTIFACT_CAPABILITY);
  assert.equal(
    portConformance.runtime.memberAdvertisement.artifactPorts,
    GRAPH_V3_ARTIFACT_CAPABILITY,
  );
  assertGraphV3RegistryPort(output, portConformance.registry.outputPort);
  assertGraphV3RegistryPort(input, portConformance.registry.inputPort);
  assertGraphV3RuntimeArtifactPort(
    output,
    portConformance.runtime.outputSchema,
  );
  assertGraphV3RuntimeArtifactPort(input, portConformance.runtime.inputSchema);
  assert.throws(
    () =>
      assertGraphV3RegistryPort(input, {
        ...portConformance.registry.inputPort,
        format: "text/plain",
      }),
    /Registry v2 contract/,
  );
  assert.throws(
    () =>
      assertGraphV3RegistryPort(input, {
        ...portConformance.registry.inputPort,
        required: false,
      }),
    /Registry v2 contract/,
  );
  assert.throws(
    () =>
      assertGraphV3RegistryPort(input, {
        ...portConformance.registry.inputPort,
        cardinality: "many",
      }),
    /Registry v2 contract/,
  );
  assert.throws(
    () =>
      assertGraphV3RuntimeArtifactPort(input, {
        ...portConformance.runtime.inputSchema,
        required: false,
      }),
    /installed artifact runtime/,
  );
  for (const [cardinality, registry, runtime] of [
    [
      "one",
      { cardinality: "one", required: true },
      { type: "artifact", required: true },
    ],
    [
      "optional",
      { cardinality: "one", required: false },
      { type: "artifact", required: false },
    ],
    [
      "many",
      { cardinality: "many", required: false },
      { type: "artifact[]", required: false },
    ],
    [
      "non-empty-many",
      { cardinality: "many", required: true },
      { type: "artifact[]", required: true },
    ],
  ] as const) {
    assertGraphV3RuntimeArtifactPort(
      { ...input, cardinality },
      { ...runtime, format: input.format },
    );
    assertGraphV3RegistryPort(
      { ...input, cardinality },
      { type: "artifact", ...registry, format: input.format! },
    );
  }
  assert.throws(
    () =>
      assertGraphV3RegistryPort(
        { ...input, kind: "json" },
        portConformance.registry.inputPort,
      ),
    /no Registry v2 artifact contract/,
  );
});

test("rejects incompatible ports, ambiguous routes and invalid associations", () => {
  assert.throws(
    () =>
      validateWorkflowGraphV3(
        change((graph) => {
          graph.distribution.steps[0]!.outputs[0]!.cardinality = "optional";
        }),
        steps,
      ),
    /incompatible ports/,
  );
  assert.throws(
    () =>
      validateWorkflowGraphV3(
        change((graph) => {
          graph.distribution.steps[0]!.outputs[0]!.format =
            "application/json; charset=utf-8";
        }),
        steps,
      ),
    /exact MIME format/,
  );
  assert.throws(
    () =>
      validateWorkflowGraphV3(
        change((graph) => {
          graph.distribution.steps[0]!.outputs[0]!.name = "Payload";
        }),
        steps,
      ),
    /Registry-compatible name/,
  );
  assert.throws(
    () =>
      validateWorkflowGraphV3(
        change((graph) => {
          graph.distribution.steps[1]!.inputs[0]!.format = "text/plain";
        }),
        steps,
      ),
    /incompatible ports/,
  );
  assert.throws(
    () =>
      validateWorkflowGraphV3(
        change((graph) => {
          graph.distribution.routes.push(
            structuredClone(graph.distribution.routes[0]!),
          );
        }),
        steps,
      ),
    /ambiguous routes/,
  );
  assert.throws(
    () =>
      resolveWorkflowGraphV3(
        change((graph) => {
          graph.distribution.routes[0]!.association = { kind: "key" };
        }),
        steps,
        members,
      ),
    /missing or ambiguous source keys/,
  );
  assert.throws(
    () =>
      validateWorkflowGraphV3(
        change((graph) => {
          graph.distribution.routes[0]!.association = { kind: "position" };
          graph.distribution.steps[1]!.partitionId = "missing";
        }),
        steps,
      ),
    /unknown partition/,
  );
  assert.throws(
    () =>
      validateWorkflowGraphV3(
        change((graph) => {
          graph.edges[0]!.condition = false;
        }),
        steps,
      ),
    /unconditional graph dependency/,
  );
});

test("shared invalid fixtures fail with their declared errors", () => {
  for (const fixtureCase of invalidFixtures.cases) {
    assert.throws(
      () => validateWorkflowGraphV3(fixtureCase.definition, steps),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(fixtureCase.expectedError),
      fixtureCase.name,
    );
  }
});

test("key and position associations resolve only unambiguous matches", () => {
  const graph = change((value) => {
    value.distribution.partitions.push({
      id: "destinations",
      members: { kind: "eligible" },
      order: "member-id",
    });
    value.distribution.steps[1]!.partitionId = "destinations";
    value.distribution.routes[0]!.association = { kind: "key" };
    delete value.distribution.steps[1]!.transfer;
  });
  const plan = resolveWorkflowGraphV3(graph, steps, {
    participants: members.participants.map((member, index) => ({
      ...member,
      key: String(index),
    })),
    destinations: [
      { memberId: "member_x", key: "2" },
      { memberId: "member_y", key: "0" },
    ],
  });
  assert.deepEqual(
    plan.routes.map((route) => route.from.memberId),
    ["member_c", "member_a"],
  );
  assert.throws(
    () =>
      resolveWorkflowGraphV3(graph, steps, {
        participants: members.participants.map((member) => ({
          ...member,
          key: "duplicate",
        })),
        destinations: [{ memberId: "member_x", key: "duplicate" }],
      }),
    /ambiguous source keys/,
  );
  graph.distribution.routes[0]!.association = { kind: "position" };
  const positioned = resolveWorkflowGraphV3(graph, steps, {
    participants: members.participants,
    destinations: [
      { memberId: "member_z" },
      { memberId: "member_x" },
      { memberId: "member_y" },
    ],
  });
  assert.deepEqual(
    positioned.routes.map((route) => route.to.memberId),
    ["member_x", "member_y", "member_z"],
  );
  assert.throws(
    () =>
      resolveWorkflowGraphV3(graph, steps, {
        participants: members.participants,
        destinations: [{ memberId: "member_x" }],
      }),
    /equal partition sizes/,
  );
});
