import assert from "node:assert/strict";
import test from "node:test";
import type { Node } from "@xyflow/react";
import {
  boundEndpointIds,
  creditShortfall,
  creditShortfallMessage,
  projectTransfers,
  type ObjectLister,
  type WorkflowCreditEstimate,
} from "./workflow-credit-estimate";
import type { WorkflowNodeData } from "./workflow-graph-types";

const GIB = 1_073_741_824;

function node(
  id: string,
  actionPackageName: string,
  overrides: Partial<WorkflowNodeData> = {},
) {
  return {
    id,
    position: { x: 0, y: 0 },
    data: {
      id,
      nodeKind: "step",
      actionPackageName,
      enabled: true,
      config: {},
      inputBindings: {},
      ...overrides,
    },
  } as Node<WorkflowNodeData>;
}

function endpoint(id: string, config: Record<string, unknown>) {
  return node(id, "@beam/object-storage-endpoint", {
    config: { credentialId: "cred_1", bucket: "models", ...config },
  } as Partial<WorkflowNodeData>);
}

function transfer(
  id: string,
  sourceIds: string[],
  destinationIds: string[],
  overrides: Partial<WorkflowNodeData> = {},
) {
  return node(id, "@beam/transfer", {
    inputBindings: {
      sourceEndpoints: sourceIds.map((source) => `\${steps.${source}.outputs.endpoint}`),
      destinationEndpoints: destinationIds.map(
        (destination) => `\${steps.${destination}.outputs.endpoint}`,
      ),
    },
    ...overrides,
  } as Partial<WorkflowNodeData>);
}

function lister(
  objects: Record<string, Array<{ key: string; size: number | null }>>,
  truncated = false,
): ObjectLister {
  return async ({ prefix }) => ({
    prefixes: [],
    objects: (objects[prefix] ?? []).map((object) => ({ ...object, updatedAt: null })),
    prefix,
    truncated,
  });
}

test("endpoint bindings are read back from their step expressions", () => {
  const step = transfer("t1", ["src_a", "src_b"], ["dst_a"]);

  assert.deepEqual(boundEndpointIds(step, "sourceEndpoints"), ["src_a", "src_b"]);
  assert.deepEqual(boundEndpointIds(step, "destinationEndpoints"), ["dst_a"]);
});

test("a file source is sized by its exact key, not by its prefix", async () => {
  // A prefix listing also returns siblings that share it; billing the backup
  // alongside the model would inflate every estimate for that source.
  const nodes = [
    endpoint("src_a", { objectKey: "model.safetensors", sourceType: "file" }),
    transfer("t1", ["src_a"], ["dst_a"]),
    endpoint("dst_a", { objectKey: "out/", sourceType: "directory" }),
  ];

  const [projection] = await projectTransfers(
    nodes,
    lister({
      "model.safetensors": [
        { key: "model.safetensors", size: GIB },
        { key: "model.safetensors.bak", size: 5 * GIB },
      ],
    }),
  );
  assert.ok(projection);

  assert.equal(projection.sourceBytes, String(GIB));
  assert.equal(projection.partial, false);
  assert.equal(projection.destinationCount, 1);
});

test("a directory source sums the listing", async () => {
  const nodes = [
    endpoint("src_a", { objectKey: "shards/", sourceType: "directory" }),
    transfer("t1", ["src_a"], ["dst_a", "dst_b"]),
  ];

  const [projection] = await projectTransfers(
    nodes,
    lister({
      "shards/": [
        { key: "shards/00", size: GIB },
        { key: "shards/01", size: GIB },
      ],
    }),
  );
  assert.ok(projection);

  assert.equal(projection.sourceBytes, String(2 * GIB));
  assert.equal(projection.destinationCount, 2);
});

test("a truncated listing is reported as a floor", async () => {
  const nodes = [
    endpoint("src_a", { objectKey: "shards/", sourceType: "directory" }),
    transfer("t1", ["src_a"], ["dst_a"]),
  ];

  const [projection] = await projectTransfers(
    nodes,
    lister({ "shards/": [{ key: "shards/00", size: GIB }] }, true),
  );
  assert.ok(projection);

  assert.equal(projection.sourceBytes, String(GIB));
  assert.equal(projection.partial, true);
});

test("a source with no credential leaves the transfer unsized", async () => {
  // Reporting zero bytes here would read as "this transfer is nearly free".
  const nodes = [
    endpoint("src_a", { credentialId: "", objectKey: "model", sourceType: "file" }),
    transfer("t1", ["src_a"], ["dst_a"]),
  ];

  const [projection] = await projectTransfers(nodes, lister({}));
  assert.ok(projection);

  assert.equal(projection.sourceBytes, null);
  assert.equal(projection.partial, false);
});

test("one unsized source among several makes the sum a floor", async () => {
  const nodes = [
    endpoint("src_a", { objectKey: "a", sourceType: "file" }),
    endpoint("src_b", { credentialId: "", objectKey: "b", sourceType: "file" }),
    transfer("t1", ["src_a", "src_b"], ["dst_a"]),
  ];

  const [projection] = await projectTransfers(
    nodes,
    lister({ a: [{ key: "a", size: GIB }] }),
  );
  assert.ok(projection);

  assert.equal(projection.sourceBytes, String(GIB));
  assert.equal(projection.partial, true);
});

test("an unreachable bucket is unsized rather than empty", async () => {
  const nodes = [
    endpoint("src_a", { objectKey: "model", sourceType: "file" }),
    transfer("t1", ["src_a"], ["dst_a"]),
  ];

  const failing: ObjectLister = async () => {
    throw new Error("403 from the provider");
  };

  const [projection] = await projectTransfers(nodes, failing);
  assert.ok(projection);

  assert.equal(projection.sourceBytes, null);
});

test("disabled transfers are not priced", async () => {
  const nodes = [
    endpoint("src_a", { objectKey: "model", sourceType: "file" }),
    transfer("t1", ["src_a"], ["dst_a"], { enabled: false }),
  ];

  assert.deepEqual(
    await projectTransfers(nodes, lister({ model: [{ key: "model", size: GIB }] })),
    [],
  );
});

test("an endpoint shared by several transfers is listed once", async () => {
  let listings = 0;
  const counting: ObjectLister = async ({ prefix }) => {
    listings += 1;
    return {
      prefixes: [],
      objects: [{ key: prefix, size: GIB, updatedAt: null }],
      prefix,
      truncated: false,
    };
  };

  const nodes = [
    endpoint("src_a", { objectKey: "model", sourceType: "file" }),
    transfer("t1", ["src_a"], ["dst_a"]),
    transfer("t2", ["src_a"], ["dst_b"]),
  ];

  await projectTransfers(nodes, counting);

  assert.equal(listings, 1);
});

test("a file source picked in the bucket explorer is priced from its recorded size", async () => {
  // The onboarding test's 19 GB source read "volume measured after the run"
  // although the endpoint had recorded the object's size.
  const refusing: ObjectLister = async () => {
    throw new Error("listing refused");
  };
  const nodes = [
    endpoint("src_a", {
      objectKey: "test/rnd_20_gb.bin",
      sourceType: "file",
      objectSize: 20_000_000_000,
    }),
    transfer("t1", ["src_a"], ["dst_a"], {
      config: { credentialId: "beam_key" },
    }),
  ];

  const [projection] = await projectTransfers(nodes, refusing);
  assert.ok(projection);

  assert.equal(projection.sourceBytes, "20000000000");
  assert.equal(projection.partial, false);
  assert.equal(projection.credentialId, "beam_key");
});

test("a directory source is listed even when a size was recorded", async () => {
  const nodes = [
    endpoint("src_a", {
      objectKey: "shards/",
      sourceType: "directory",
      objectSize: 1,
    }),
    transfer("t1", ["src_a"], ["dst_a"]),
  ];

  const [projection] = await projectTransfers(
    nodes,
    lister({ "shards/": [{ key: "shards/00", size: GIB }] }),
  );
  assert.ok(projection);

  assert.equal(projection.sourceBytes, String(GIB));
  assert.equal(projection.credentialId, "");
});

function estimate(
  total: number,
  availableCredits: number | null | undefined,
  atLeast = false,
): WorkflowCreditEstimate {
  return {
    total,
    atLeast,
    lines: [],
    ...(availableCredits === undefined ? {} : { availableCredits }),
  };
}

test("an estimate above the key's balance is a shortfall", () => {
  assert.deepEqual(creditShortfall(estimate(3, 2)), {
    needed: 3,
    available: 2,
    atLeast: false,
  });
  // A floor above the balance is short too: the run cannot cost less.
  assert.deepEqual(creditShortfall(estimate(3, 2, true)), {
    needed: 3,
    available: 2,
    atLeast: true,
  });
  // An overdrawn pool has nothing to spend, not a negative amount.
  assert.equal(creditShortfall(estimate(1, -4))?.available, 0);
});

test("a covered, unbounded or unknown balance is not a shortfall", () => {
  assert.equal(creditShortfall(estimate(2, 2)), null);
  assert.equal(creditShortfall(estimate(2, 5)), null);
  assert.equal(creditShortfall(estimate(3, null)), null);
  assert.equal(creditShortfall(estimate(3, undefined)), null);
});

test("the shortfall says what the run needs and where credits are added", () => {
  assert.equal(
    creditShortfallMessage({ needed: 3, available: 2, atLeast: false }),
    "This run needs about 3 credits, but only 2 are available. Add credits in the Console.",
  );
  assert.equal(
    creditShortfallMessage({ needed: 1, available: 0, atLeast: true }),
    "This run needs at least 1 credit, but no credits are available. Add credits in the Console.",
  );
  assert.equal(
    creditShortfallMessage({ needed: 4, available: 1, atLeast: false }),
    "This run needs about 4 credits, but only 1 is available. Add credits in the Console.",
  );
});

test("a fractional estimate is compared with a fractional balance exactly", () => {
  assert.deepEqual(creditShortfall(estimate(0.2, 0.05)), {
    needed: 0.2,
    available: 0.05,
    atLeast: false,
  });
  // 0.1 + 0.2 in floating point is 0.30000000000000004: still covered by 0.3.
  assert.equal(creditShortfall(estimate(0.1 + 0.2, 0.3)), null);
  assert.equal(creditShortfall(estimate(0.02, 0.01))?.needed, 0.02);
  assert.equal(creditShortfall(estimate(0.07, 0.07)), null);
  assert.equal(creditShortfall(estimate(0.25, -0.5))?.available, 0);
});

test("the shortfall shows fractional amounts with trailing zeros trimmed", () => {
  assert.equal(
    creditShortfallMessage({ needed: 0.2, available: 0.05, atLeast: false }),
    "This run needs about 0.2 credits, but only 0.05 are available. Add credits in the Console.",
  );
  assert.equal(
    creditShortfallMessage({ needed: 1.01, available: 1, atLeast: true }),
    "This run needs at least 1.01 credits, but only 1 is available. Add credits in the Console.",
  );
});
