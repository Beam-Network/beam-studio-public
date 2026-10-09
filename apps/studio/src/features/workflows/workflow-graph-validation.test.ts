import assert from "node:assert/strict";
import test from "node:test";
import type { Edge } from "@xyflow/react";
import { createNode, createSwitchNode } from "./workflow-graph-model";
import { BEAM_TRANSFER_FOLDER_SOURCE_ISSUE } from "@beam-studio/core/workflows/graph-semantics";
import {
  bindingReferences,
  isBeamTransferSourceEndpoint,
  resolveWorkflowStepAction,
  validateActionVersions,
  validateGraph,
} from "./workflow-graph-validation";
import type { RegistryPackage } from "../registry/registry-data";
import type { ActionPackage } from "./workflow-graph-types";

const waitAction: ActionPackage = {
  id: "wait",
  name: "@beam/wait",
  version: "1.0.0",
  checksum: "wait",
  manifest: { inputs: {}, outputs: {} },
};

const installedVersions = ["1.2.19", "1.2.21"].map((version) => ({
  ...waitAction,
  id: `wait-${version}`,
  version,
  manifest: {
    ...waitAction.manifest,
    version,
    configSchema: { title: version },
  },
}));
function versionNode(range = "1.2.19") {
  const node = createNode(installedVersions[0]!, 0, "action");
  node.data.actionVersionRange = range;
  node.data.manifest = installedVersions[0]!.manifest;
  return node;
}
const installedRegistry: RegistryPackage = {
  id: "wait",
  packageName: waitAction.name,
  scope: "@beam",
  name: "wait",
  displayName: "Wait",
  visibility: "public",
  status: "active",
  trustLevel: "verified",
  latestVersion: "1.2.21",
  latestVersionStatus: "active",
  versionCount: 2,
  updatedAt: "2026-09-17T00:00:00Z",
};

test("a saved action stays valid alongside a newer installed version, even when the catalog opens", () => {
  const node = versionNode();
  for (const registry of [[], [installedRegistry]]) {
    assert.deepEqual(
      validateActionVersions([node], installedVersions, registry, []).errors,
      [],
    );
  }
  assert.equal(
    resolveWorkflowStepAction(node.data, installedVersions)?.manifest
      .configSchema,
    installedVersions[0]!.manifest.configSchema,
  );
});

test("each step resolves independently and a saved compatible range retains its version", () => {
  const old = versionNode("^1.2.0");
  const newer = versionNode("1.2.21");
  assert.equal(
    resolveWorkflowStepAction(old.data, installedVersions)?.version,
    "1.2.19",
  );
  assert.equal(
    resolveWorkflowStepAction(newer.data, installedVersions)?.version,
    "1.2.21",
  );
  assert.deepEqual(
    validateActionVersions([old, newer], installedVersions, [], []).errors,
    [],
  );
});

test("missing or incompatible installed versions cannot be satisfied by a saved manifest or catalog summary", () => {
  const node = versionNode();
  assert.match(
    validateActionVersions([node], [], [installedRegistry], []).errors[0]!,
    /not installed/,
  );
  assert.match(
    validateActionVersions([node], [installedVersions[1]!], [], []).errors[0]!,
    /No installed version satisfies 1.2.19/,
  );
});

test("Registry blocking applies to the selected version and package, not an unrelated latest release", () => {
  const node = versionNode();
  const blocked = {
    ...installedRegistry,
    versions: [{ version: "1.2.19", manifest: {}, status: "yanked" }],
  };
  assert.match(
    validateActionVersions([node], installedVersions, [blocked], []).errors[0]!,
    /blocked by Registry/,
  );
  assert.match(
    validateActionVersions(
      [node],
      installedVersions,
      [{ ...installedRegistry, status: "blocked" }],
      [],
    ).errors[0]!,
    /blocked by Registry/,
  );
  assert.deepEqual(
    validateActionVersions(
      [node],
      installedVersions,
      [{ ...installedRegistry, latestVersionStatus: "yanked" }],
      [],
    ).errors,
    [],
  );
});

function switchFixture() {
  const source = createNode(waitAction, 0, "action");
  const gateway = createSwitchNode(0);
  const target = createNode(waitAction, 1, "action");
  const caseId = gateway.data.cases[0]!.id;
  const edges: Edge[] = [
    { id: "in", source: source.id, target: gateway.id },
    {
      id: "case",
      source: gateway.id,
      target: target.id,
      sourceHandle: `case:${caseId}`,
    },
    {
      id: "default",
      source: gateway.id,
      target: target.id,
      sourceHandle: "default",
    },
  ].map((edge) => ({ ...edge, data: { edgeKind: "flow" } }));
  return { source, gateway, target, edges };
}

test("Switch validation requires Default and rejects dangling or duplicate outputs", () => {
  const fixture = switchFixture();
  const actions = new Map([[waitAction.name, waitAction]]);

  const missingDefault = validateGraph(
    [fixture.source, fixture.gateway, fixture.target],
    fixture.edges.filter((edge) => edge.id !== "default"),
    actions,
  );
  assert.ok(
    missingDefault.errors.some((entry) => entry.includes("mandatory Default")),
  );

  const dangling = validateGraph(
    [fixture.source, fixture.gateway, fixture.target],
    fixture.edges.map((edge) =>
      edge.id === "case" ? { ...edge, sourceHandle: "case:removed" } : edge,
    ),
    actions,
  );
  assert.ok(
    dangling.errors.some((entry) => entry.includes("missing Switch output")),
  );

  const duplicate = validateGraph(
    [fixture.source, fixture.gateway, fixture.target],
    [...fixture.edges, { ...fixture.edges[1]!, id: "case-copy" }],
    actions,
  );
  assert.ok(
    duplicate.errors.some((entry) => entry.includes("more than one edge")),
  );
});

test("Switch validation rejects duplicate case ids and malformed predicates", () => {
  const fixture = switchFixture();
  const first = fixture.gateway.data.cases[0]!;
  fixture.gateway.data.cases = [
    first,
    { ...first, name: "Duplicate", predicate: { all: [] } },
  ];
  const result = validateGraph(
    [fixture.source, fixture.gateway, fixture.target],
    fixture.edges,
    new Map([[waitAction.name, waitAction]]),
  );
  assert.ok(result.errors.some((entry) => entry.includes("duplicated")));
  assert.ok(
    result.errors.some((entry) => entry.includes("at least one predicate")),
  );
});

test("data references are distinguished from metadata references", () => {
  assert.deepEqual(bindingReferences({ a: "${steps.wfs_1.outputs.bytes}" }), [
    { kind: "step-data", nodeId: "wfs_1", root: "outputs", key: "bytes" },
  ]);
  assert.deepEqual(
    bindingReferences({ a: "${steps.wfs_1.artifacts.report}" }),
    [{ kind: "step-data", nodeId: "wfs_1", root: "artifacts", key: "report" }],
  );
  assert.deepEqual(bindingReferences({ a: "${steps.wfs_1.status}" }), [
    { kind: "step-meta", nodeId: "wfs_1", field: "status" },
  ]);
});

test("every metadata root the engine resolves is recognised", () => {
  for (const field of [
    "id",
    "name",
    "action",
    "status",
    "error",
    "attempt",
    "startedAt",
    "completedAt",
    "durationMs",
    "config",
  ]) {
    assert.deepEqual(
      bindingReferences({ a: `\${steps.wfs_1.${field}}` }),
      [{ kind: "step-meta", nodeId: "wfs_1", field }],
      field,
    );
  }
});

test("a nested config path still resolves to the step it names", () => {
  assert.deepEqual(
    bindingReferences({ a: "${steps.wfs_1.config.source.uri}" }),
    [{ kind: "step-meta", nodeId: "wfs_1", field: "config" }],
  );
});

test("several expressions inside one message are all found", () => {
  const references = bindingReferences({
    message: "${steps.wfs_1.name} ${steps.wfs_1.status}: ${steps.wfs_1.error}",
  });
  assert.deepEqual(
    references.map((reference) =>
      reference.kind === "step-meta" ? reference.field : reference.kind,
    ),
    ["name", "status", "error"],
  );
});

test("decision and workflow roots are recognised", () => {
  assert.deepEqual(bindingReferences({ a: "${decisions.dec_1.branch}" }), [
    { kind: "decision", nodeId: "dec_1", field: "branch" },
  ]);
  assert.deepEqual(bindingReferences({ a: "${workflow.runId}" }), [
    { kind: "workflow", field: "runId" },
  ]);
});

test("existing workflow input and config bindings are not flagged", () => {
  for (const expression of [
    "${workflow.input.items}",
    "${workflow.config.tier}",
    "${graph.parallel.item}",
  ]) {
    const [reference] = bindingReferences({ a: expression });
    assert.notEqual(reference?.kind, "unknown", expression);
  }
});

test("a misspelled root is reported rather than silently ignored", () => {
  assert.deepEqual(bindingReferences({ a: "${steps.wfs_1.statuss}" }), [
    { kind: "unknown", expression: "steps.wfs_1.statuss" },
  ]);
  assert.deepEqual(bindingReferences({ a: "${transfer.id.source}" }), [
    { kind: "unknown", expression: "transfer.id.source" },
  ]);
  assert.deepEqual(bindingReferences({ a: "${workflow.nope}" }), [
    { kind: "unknown", expression: "workflow.nope" },
  ]);
});

test("literal text carries no references", () => {
  assert.deepEqual(bindingReferences({ a: "the transfer failed" }), []);
  assert.deepEqual(bindingReferences({}), []);
  assert.deepEqual(bindingReferences(undefined), []);
});

const endpointAction: ActionPackage = {
  id: "endpoint",
  name: "@beam/object-storage-endpoint",
  version: "1.1.0",
  checksum: "endpoint",
  manifest: { inputs: {}, outputs: { endpoint: { type: "object" } } },
};
const transferAction: ActionPackage = {
  id: "transfer",
  name: "@beam/transfer",
  version: "1.0.0",
  checksum: "transfer",
  manifest: { inputs: {}, outputs: {} },
};

function transferFixture(
  source: { objectKey: string; sourceType: string },
  destination = { objectKey: "out/", sourceType: "directory" },
) {
  const sourceNode = createNode(endpointAction, 0, "endpoint");
  const destinationNode = createNode(endpointAction, 1, "endpoint");
  const transfer = createNode(transferAction, 2, "action");
  sourceNode.data.config = { ...sourceNode.data.config, ...source };
  destinationNode.data.config = {
    ...destinationNode.data.config,
    ...destination,
  };
  transfer.data.inputBindings = {
    sourceEndpoints: [`\${steps.${sourceNode.id}.outputs.endpoint}`],
    destinationEndpoints: [
      `\${steps.${destinationNode.id}.outputs.endpoint}`,
    ],
  };
  return {
    nodes: [sourceNode, destinationNode, transfer],
    sourceNode,
    destinationNode,
  };
}

const transferActions = new Map([
  [endpointAction.name, endpointAction],
  [transferAction.name, transferAction],
]);

test("a folder chosen as a Beam Transfer source is marked on its endpoint", () => {
  for (const source of [
    { objectKey: "parallel-5x100gb/", sourceType: "directory" },
    { objectKey: "parallel-5x100gb/", sourceType: "file" },
  ]) {
    const fixture = transferFixture(source);
    const result = validateGraph(fixture.nodes, [], transferActions);
    assert.deepEqual(result.nodeIssues.get(fixture.sourceNode.id), [
      BEAM_TRANSFER_FOLDER_SOURCE_ISSUE,
    ]);
    assert.ok(
      result.errors.includes(
        `${fixture.sourceNode.id}: ${BEAM_TRANSFER_FOLDER_SOURCE_ISSUE}`,
      ),
    );
  }
});

test("a file source and a folder destination raise no folder issue", () => {
  const fixture = transferFixture({
    objectKey: "parallel-5x100gb/part-1.bin",
    sourceType: "file",
  });
  const result = validateGraph(fixture.nodes, [], transferActions);
  assert.ok(
    !result.errors.some((entry) =>
      entry.includes(BEAM_TRANSFER_FOLDER_SOURCE_ISSUE),
    ),
  );
  assert.equal(result.nodeIssues.get(fixture.destinationNode.id), undefined);
});

test("only an endpoint bound as a Beam Transfer source is limited to files", () => {
  const fixture = transferFixture({
    objectKey: "model.bin",
    sourceType: "file",
  });
  assert.equal(
    isBeamTransferSourceEndpoint(fixture.nodes, fixture.sourceNode.id),
    true,
  );
  assert.equal(
    isBeamTransferSourceEndpoint(fixture.nodes, fixture.destinationNode.id),
    false,
  );
});
