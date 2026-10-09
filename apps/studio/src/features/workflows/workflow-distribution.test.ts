import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { WorkflowGraphV3Definition } from "@beam-studio/core/workflows/graph-v3";
import { distributionValidationError } from "./workflow-distribution";
import { buildNodes, toDraftPayload } from "./workflow-graph-model";
import type { WorkflowStep } from "./workflow-graph-types";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../packages/core/src/workflows/fixtures/distributed-graph-v3.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as WorkflowGraphV3Definition;

const steps = ["prepare", "transfer"].map(
  (id, position): WorkflowStep => ({
    id,
    actionPackageName: `@beam/${id}`,
    actionVersionRange: "1.0.0",
    position,
    enabled: true,
    config: {},
    inputBindings: {},
    placement: "local-workers",
    executionLocationId: null,
    canvasX: position * 240,
    canvasY: 0,
    timeoutSeconds: null,
    required: true,
    manifest: null,
  }),
);

test("V3 authoring preserves distribution while V1/V2 remain unchanged", () => {
  const nodes = buildNodes(steps, new Map());
  const distributed = toDraftPayload(
    nodes,
    [],
    "workflow-graph/v3",
    fixture.distribution,
  );
  assert.equal(distributed.graphVersion, "workflow-graph/v3");
  assert.deepEqual(distributed.distribution, fixture.distribution);
  const legacy = toDraftPayload(nodes, [], "workflow-graph/v1");
  assert.equal(legacy.graphVersion, "workflow-graph/v1");
  assert.equal("distribution" in legacy, false);
});

test("editor distribution validation uses the core V3 contract", () => {
  const input = {
    controls: fixture.controls,
    distribution: fixture.distribution,
    edges: fixture.edges.map((edge) => ({
      fromStepId: edge.from,
      toStepId: edge.to,
    })),
    steps: steps.map((step) => ({ id: step.id, enabled: step.enabled })),
  };
  assert.equal(distributionValidationError(input), null);
  assert.match(
    distributionValidationError({
      ...input,
      distribution: {
        ...fixture.distribution,
        routes: [
          {
            ...fixture.distribution.routes[0]!,
            to: { stepId: "transfer", port: "missing" },
          },
        ],
      },
    }) ?? "",
    /unknown port/,
  );
});
