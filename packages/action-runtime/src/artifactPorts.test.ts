import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type {
  ActionContext,
  ActionManifest,
  ActionJson,
} from "@beam-studio/core";
import {
  artifactPortLimits,
  assertArtifactPortPublication,
  assertArtifactPortResult,
  prepareArtifactPorts,
} from "./artifactPorts.js";

const fixture = JSON.parse(
  await readFile(
    new URL("../fixtures/artifact-ports-v1.json", import.meta.url),
    "utf8",
  ),
);
const manifest = fixture.manifest as ActionManifest;
const identity = fixture.identity as {
  workflowRunId: string;
  stepRunId: string;
  taskId: string;
  assignmentId: string;
  attempt: number;
};

function context(signal = new AbortController().signal): ActionContext {
  return {
    ...identity,
    stepId: "step",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    state: { get: () => ({}), set() {}, patch() {} },
    storage: {
      async getJson() {
        return undefined;
      },
      async putJson() {},
    },
    artifacts: {
      async publish(artifact) {
        return artifact;
      },
    },
    secrets: {
      async get() {
        return null;
      },
    },
    beam: {},
    signal,
  };
}

test("language-neutral conformity fixture exercises bounded artifact input preparation", async () => {
  assert.deepEqual(fixture.limits, artifactPortLimits);
  for (const entry of fixture.cases as Array<{
    name: string;
    valid: boolean;
    inputs: Record<string, ActionJson>;
  }>) {
    if (entry.valid) {
      const ports = prepareArtifactPorts(manifest, entry.inputs, context());
      assert.equal(
        await ports.context.artifacts.readInput!("source"),
        "aGVsbG8=",
        entry.name,
      );
    } else {
      assert.throws(
        () => prepareArtifactPorts(manifest, entry.inputs, context()),
        Error,
        entry.name,
      );
    }
  }
});

test("publication verifies port, digest, identity, and result evidence", async () => {
  const inputs = fixture.cases[0].inputs as Record<string, ActionJson>;
  const ports = prepareArtifactPorts(manifest, inputs, context());
  await ports.context.artifacts.publishOutput!("result", "b3V0cHV0", {
    name: "result.txt",
    mediaType: "text/plain",
  });
  const result = await ports.finish({ outputs: {} });
  assert.deepEqual(result.artifacts, [fixture.publication]);
  assertArtifactPortResult(manifest, result, identity);
  assertArtifactPortResult(manifest, result, identity, undefined, {
    count: 1,
    totalBytes: 5,
  });
  assert.throws(
    () =>
      assertArtifactPortResult(manifest, result, identity, undefined, {
        count: 1,
        totalBytes: artifactPortLimits.maxTotalBytes,
      }),
    /exceeds invocation limits/,
  );
  assert.throws(
    () =>
      assertArtifactPortPublication(
        manifest,
        {
          ...fixture.publication,
          metadata: { ...fixture.publication.metadata, attempt: 3 },
        },
        identity,
      ),
    /another task attempt/,
  );
  assert.throws(
    () =>
      assertArtifactPortResult(
        manifest,
        { ...result, outputs: { result: "unrelated" } },
        identity,
      ),
    /does not match/,
  );
  assert.throws(
    () => assertArtifactPortResult(manifest, { outputs: {} }, identity),
    /Required artifact output/,
  );
});

test("ports reject undeclared outputs, oversized bytes, and cancellation before publication", async () => {
  const inputs = fixture.cases[0].inputs as Record<string, ActionJson>;
  const controller = new AbortController();
  const ports = prepareArtifactPorts(
    manifest,
    inputs,
    context(controller.signal),
  );
  await assert.rejects(
    ports.context.artifacts.publish(fixture.publication),
    /declared output port/,
  );
  await assert.rejects(
    ports.context.artifacts.publishOutput!("other", "YQ=="),
    /undeclared/,
  );
  await assert.rejects(
    ports.context.artifacts.publishOutput!("result", "YQ==", {
      mediaType: "application/json",
    }),
    /incompatible media type/,
  );
  await assert.rejects(
    ports.context.artifacts.publishOutput!(
      "result",
      Buffer.alloc(artifactPortLimits.maxArtifactBytes + 1).toString("base64"),
    ),
    /byte limit/,
  );
  controller.abort(new Error("cancelled"));
  await assert.rejects(
    ports.context.artifacts.publishOutput!("result", "YQ=="),
    /cancelled/,
  );
  await assert.rejects(ports.finish({}), /cancelled/);
});

test("v3 many cardinality uses ordered artifact collections", async () => {
  const many = {
    ...manifest,
    inputs: {
      source: {
        type: "artifact",
        cardinality: "many",
        format: "text/plain",
        required: true,
      },
    },
    outputs: {
      result: {
        type: "artifact",
        cardinality: "many",
        format: "text/plain",
        required: true,
      },
    },
  } as ActionManifest;
  const source = fixture.cases[0].inputs.source as ActionJson;
  const ports = prepareArtifactPorts(
    many,
    { source: [source, source] },
    context(),
  );
  assert.equal(
    await ports.context.artifacts.readInput!("source", 1),
    "aGVsbG8=",
  );
  await ports.context.artifacts.publishOutput!("result", "YQ==", {
    mediaType: "text/plain",
  });
  await ports.context.artifacts.publishOutput!("result", "Yg==", {
    mediaType: "text/plain",
  });
  const result = await ports.finish({});
  assert.deepEqual(result.outputs?.result, result.artifacts);
  assertArtifactPortResult(many, result, identity, {
    source: [source, source],
  });
});

test("legacy manifests keep their existing artifact result contract", async () => {
  const legacy = { ...manifest, inputs: {}, outputs: {} };
  const ports = prepareArtifactPorts(legacy, {}, context());
  const result = { artifacts: [fixture.publication] };
  assert.equal(await ports.finish(result), result);
});

test("pinned Registry v2 ports drive cardinality, exact format and publication evidence", async () => {
  const v2 = JSON.parse(
    await readFile(
      new URL(
        "../../core/src/workflows/fixtures/registry-v2/v2-single.valid.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as ActionManifest;
  const data = Buffer.from('{"ok":true}');
  const source: ActionJson = {
    type: "file",
    name: "source.json",
    mediaType: "application/json",
    uri: `data:application/json;base64,${data.toString("base64")}`,
    metadata: {
      bytes: data.byteLength,
      sha256: `sha256:${createHash("sha256").update(data).digest("hex")}`,
    },
  };
  const inputs = { source };
  const ports = prepareArtifactPorts(v2, inputs, context());
  assert.equal(
    await ports.context.artifacts.readInput!("source"),
    data.toString("base64"),
  );
  await assert.rejects(
    ports.context.artifacts.publishOutput!("result", data.toString("base64"), {
      mediaType: "text/plain",
    }),
    /incompatible media type/,
  );
  await ports.context.artifacts.publishOutput!(
    "result",
    data.toString("base64"),
    { mediaType: "application/json" },
  );
  const result = await ports.finish({});
  assert.deepEqual(result.outputs?.result, result.artifacts?.[0]);
  assertArtifactPortResult(v2, result, identity, inputs);
  assert.throws(
    () => prepareArtifactPorts(v2, { source: [source] }, context()),
    /wrong cardinality/,
  );
  assert.throws(
    () => prepareArtifactPorts(v2, {}, context()),
    /Required artifact input/,
  );
  assert.throws(
    () =>
      prepareArtifactPorts(
        {
          ...v2,
          contracts: {
            ...v2.contracts!,
            resources: { ...v2.contracts!.resources, maxArtifactBytes: 1 },
          },
        },
        inputs,
        context(),
      ),
    /byte limit/,
  );
  await assert.rejects(
    prepareArtifactPorts(v2, inputs, context()).finish({
      outputs: { stray: true },
    }),
    /undeclared Registry v2/,
  );
});
