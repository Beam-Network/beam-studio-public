import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseWorkflowReferences,
  resolveWorkflowReferences,
} from "./references.js";
import { resolveInputBindings } from "./runner.js";
import { resolveWorkflowCallBindings } from "./contracts.js";
import { resolveDynamicGraphValue } from "./graph-v2.js";

test("named resource and managed-agent values preserve type and never evaluate embedded expressions", () => {
  const references = parseWorkflowReferences(
    { source: { agentId: "agent-1" } },
    {
      key: { kind: "credential", credentialId: "credential-1" },
      fixture: {
        kind: "data",
        value: {
          message: "${steps.private.outputs.secret}",
          dynamic: "${graph.loop.index}",
          count: 7,
        },
      },
    },
  );
  assert.deepEqual(
    resolveWorkflowReferences(
      {
        agentId: "${workflow.agents.source.agentId}",
        apiKeyId: "${workflow.resources.key.credentialId}",
      },
      references,
      "config",
    ),
    { agentId: "agent-1", apiKeyId: "credential-1" },
  );
  const compiled = resolveWorkflowReferences(
    { payload: "${workflow.resources.fixture.value}" },
    references,
    "binding",
  );
  const dynamic = resolveDynamicGraphValue(compiled, { loop: { index: 99 } });
  const expected = {
    payload: {
      message: "${steps.private.outputs.secret}",
      dynamic: "${graph.loop.index}",
      count: 7,
    },
  };
  assert.deepEqual(
    resolveInputBindings(
      dynamic as Record<string, any>,
      {},
      {},
      new Map(),
      new Map(),
    ),
    expected,
  );
  assert.deepEqual(
    resolveWorkflowCallBindings(
      dynamic as Record<string, any>,
      {},
      {},
      new Map(),
      new Map(),
    ),
    expected,
  );
  assert.deepEqual(
    resolveWorkflowReferences(
      { $literal: "${workflow.resources.missing.value}" },
      references,
      "binding",
    ),
    { $literal: "${workflow.resources.missing.value}" },
  );
});

test("missing, reserved and interpolated named references fail clearly", () => {
  const references = parseWorkflowReferences(
    {},
    { fixture: { kind: "data", value: 7 } },
  );
  for (const expression of [
    "${workflow.agents.missing.agentId}",
    "${workflow.resources.fixture.value.missing}",
    "${workflow.resources.constructor}",
    "prefix ${workflow.resources.fixture.value}",
  ])
    assert.throws(
      () => resolveWorkflowReferences(expression, references, "binding"),
      /workflow reference|whole value/,
    );
  for (const agents of [
    { "with.dot": { agentId: "a" } },
    { constructor: { agentId: "a" } },
    { source: { agentId: "a", execution: true } },
  ])
    assert.throws(
      () => parseWorkflowReferences(agents, {}),
      /Invalid workflow references/,
    );
});

test("resource descriptors keep credentials as references and reject credential-bearing endpoints", () => {
  for (const url of [
    "not-a-url",
    "https://user:secret@example.com",
    "https://example.com/path?token=secret",
    "file:///secret",
  ])
    assert.throws(
      () =>
        parseWorkflowReferences({}, { endpoint: { kind: "endpoint", url } }),
      /Invalid workflow references/,
    );
  assert.throws(
    () =>
      parseWorkflowReferences(
        {},
        { key: { kind: "credential", credentialId: "key", value: "secret" } },
      ),
    /Invalid workflow references/,
  );
  const references = parseWorkflowReferences(
    {},
    {
      storage: {
        kind: "storage",
        endpoint: {
          provider: "s3",
          bucket: "bucket",
          objectKey: "key",
          credentialId: "credential",
          endpointUrl: "https://example.com",
        },
      },
    },
  );
  assert.deepEqual(
    resolveWorkflowReferences(
      "${workflow.resources.storage.endpoint}",
      references,
      "config",
    ),
    {
      provider: "s3",
      bucket: "bucket",
      objectKey: "key",
      credentialId: "credential",
      sourceType: "file",
      endpointUrl: "https://example.com",
    },
  );
});
