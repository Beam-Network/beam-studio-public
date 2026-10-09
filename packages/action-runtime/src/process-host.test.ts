import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type {
  ActionContext,
  ActionJson,
  ActionManifest,
} from "@beam-studio/core";
import { resolveActionPackage } from "./actionLoader.js";
import { executeWithArtifactPorts } from "./artifactPorts.js";
import {
  isRuntimeArtifactMethod,
  sandboxRpcMethodsForAction,
} from "./actionPermissions.js";
import {
  executeRuntimeInvocation,
  type RuntimeInvocation,
} from "./process-host.js";
import { probeActionResourceBudgets } from "./resource-budgets.js";
import {
  prepareProcessOwnership,
  recordSandboxStopped,
  registerProcessController,
} from "./process-ownership.js";

const fixture = JSON.parse(
  await readFile(
    new URL("../fixtures/artifact-ports-v1.json", import.meta.url),
    "utf8",
  ),
);
const source = await readFile(
  new URL("../fixtures/artifact-ports-action.mjs", import.meta.url),
  "utf8",
);

test("member runtime executes the locked package and bounded artifact ports", async (t) => {
  let downloads = 0;
  const server = http.createServer((_request, response) => {
    downloads++;
    response.end(source);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const cache = await mkdtemp(path.join(os.tmpdir(), "beam-artifact-member-"));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cache, { recursive: true, force: true });
  });
  const address = server.address() as { port: number };
  const manifest = fixture.manifest as ActionManifest;
  const invocation: RuntimeInvocation = {
    artifactPortsProtocol: "action-artifact-ports/v1",
    assignmentId: "assignment-1",
    taskId: fixture.identity.taskId,
    workflowRunId: fixture.identity.workflowRunId,
    stepRunId: fixture.identity.stepRunId,
    stepId: "step",
    attempt: fixture.identity.attempt,
    room: { environmentTemplateKey: "dev", roomId: "room" },
    step: {
      actionPackage: manifest.name,
      versionRange: manifest.version,
      resolvedVersion: manifest.version,
      manifestSnapshot: manifest,
      artifactChecksum: `sha256:${createHash("sha256").update(source).digest("hex")}`,
      registryArtifactUrl: `http://127.0.0.1:${address.port}/action.mjs`,
    },
    config: {},
    inputs: fixture.cases[0].inputs,
    state: {},
  };
  const options = {
    actionCacheDir: cache,
    allowedActionPermissions: [],
    allowedHostOperations: sandboxRpcMethodsForAction(manifest).filter(
      (method) => !isRuntimeArtifactMethod(method),
    ),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
  const calls: string[] = [];
  const host = {
    async call(method: string, args: unknown[]) {
      calls.push(method);
      if (method === "artifacts.publish") return args[0];
      throw new Error(`Unexpected host operation: ${method}`);
    },
  };
  const result = await executeRuntimeInvocation(
    invocation,
    options,
    host,
    new AbortController().signal,
  );
  assert.equal(result.artifacts?.[0]?.uri, "data:text/plain;base64,aGVsbG8=");
  assert.deepEqual(result.outputs?.result, result.artifacts?.[0]);
  assert.deepEqual(calls, ["artifacts.publish"]);

  const runnerPackage = await resolveActionPackage(
    invocation.step,
    { ...options, placement: "local-workers" },
    new AbortController().signal,
  );
  const runnerContext: ActionContext = {
    taskId: invocation.taskId,
    workflowRunId: invocation.workflowRunId,
    stepRunId: invocation.stepRunId,
    stepId: invocation.stepId,
    attempt: invocation.attempt,
    room: invocation.room,
    logger: options.logger,
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
    signal: new AbortController().signal,
  };
  const runnerResult = await executeWithArtifactPorts(
    runnerPackage,
    { config: {}, inputs: invocation.inputs as Record<string, ActionJson> },
    runnerContext,
  );
  assert.equal(runnerPackage.manifest.version, manifest.version);
  assert.equal(`sha256:${runnerPackage.checksum}`, invocation.step.artifactChecksum);
  assert.deepEqual(runnerResult.outputs?.result, runnerResult.artifacts?.[0]);
  assert.equal(runnerResult.artifacts?.[0]?.uri, result.artifacts?.[0]?.uri);
  assert.equal(
    runnerResult.artifacts?.[0]?.metadata?.sha256,
    result.artifacts?.[0]?.metadata?.sha256,
  );
  assert.equal(
    runnerResult.artifacts?.[0]?.metadata?.taskId,
    result.artifacts?.[0]?.metadata?.taskId,
  );
  assert.equal(runnerResult.artifacts?.[0]?.metadata?.assignmentId, undefined);

  await assert.rejects(
    executeRuntimeInvocation(
      { ...invocation, artifactPortsProtocol: undefined },
      options,
      host,
      new AbortController().signal,
    ),
    /Artifact port protocol is unavailable/,
  );
  await assert.rejects(
    executeRuntimeInvocation(
      invocation,
      { ...options, allowedHostOperations: [] },
      host,
      new AbortController().signal,
    ),
    /Required host operation is unavailable/,
  );
  await assert.rejects(
    executeRuntimeInvocation(
      {
        ...invocation,
        step: {
          ...invocation.step,
          artifactChecksum: `sha256:${"0".repeat(64)}`,
        },
      },
      options,
      host,
      new AbortController().signal,
    ),
    /checksum/i,
  );

  const v2 = JSON.parse(
    await readFile(
      new URL(
        "../../core/src/workflows/fixtures/registry-v2/v2-single.valid.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as ActionManifest;
  const v2Step = {
    ...invocation.step,
    actionPackage: v2.name,
    versionRange: v2.version,
    resolvedVersion: v2.version,
    manifestSnapshot: v2,
  };
  const before = downloads;
  if (await probeActionResourceBudgets()) {
    await assert.rejects(
      resolveActionPackage(
        v2Step,
        { ...options, allowedActionPermissions: v2.permissions, placement: "local-workers" },
        new AbortController().signal,
      ),
      /durable process ownership/,
    );
    const ownership = await prepareProcessOwnership(path.join(cache, "v2-ownership"), "v2-test");
    await registerProcessController(ownership);
    const loaded = await resolveActionPackage(
      v2Step,
      { ...options, processOwnership: ownership, allowedActionPermissions: v2.permissions, placement: "local-workers" },
      new AbortController().signal,
    );
    assert.equal(loaded.manifest.apiVersion, "workflow-actions/v2");
    await recordSandboxStopped(ownership);
    return;
  }
  await assert.rejects(
    resolveActionPackage(
      v2Step,
      {
        ...options,
        allowedActionPermissions: v2.permissions,
        placement: "local-workers",
      },
      new AbortController().signal,
    ),
    /durable process ownership/,
  );
  await assert.rejects(
    executeRuntimeInvocation(
      { ...invocation, step: v2Step },
      {
        ...options,
        allowedActionPermissions: v2.permissions,
      },
      host,
      new AbortController().signal,
    ),
    /durable process ownership/,
  );
  assert.equal(downloads, before, "v2 is refused before loading an artifact");
});

test("pinned Registry v2 action executes artifact ports under native budgets", async (t) => {
  if (!(await probeActionResourceBudgets())) {
    t.skip("Native Linux cgroup v2 delegation is unavailable");
    return;
  }
  const manifest = JSON.parse(
    await readFile(
      new URL("../../core/src/workflows/fixtures/registry-v2/v2-single.valid.json", import.meta.url),
      "utf8",
    ),
  ) as ActionManifest;
  const actionSource = `export async function execute(_input, context) {
    const content = await context.artifacts.readInput("source");
    await context.artifacts.publishOutput("result", content, {mediaType:"application/json"});
    return {outputs:{}};
  }`;
  const server = http.createServer((_request, response) => response.end(actionSource));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const cache = await mkdtemp(path.join(os.tmpdir(), "beam-v2-member-"));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cache, { recursive: true, force: true });
  });
  const ownership = await prepareProcessOwnership(path.join(cache, "ownership"), "v2-pinned");
  await registerProcessController(ownership);
  const content = Buffer.from('{"n":1}');
  const inputUri = `data:application/json;base64,${content.toString("base64")}`;
  const invocation: RuntimeInvocation = {
    artifactPortsProtocol: "action-artifact-ports/v1",
    assignmentId: "v2-assignment",
    taskId: "v2-task",
    workflowRunId: "v2-run",
    stepRunId: "v2-step-run",
    stepId: "v2-step",
    attempt: 1,
    room: { environmentTemplateKey: "dev", roomId: "room" },
    step: {
      actionPackage: manifest.name,
      versionRange: manifest.version,
      resolvedVersion: manifest.version,
      manifestSnapshot: manifest,
      artifactChecksum: `sha256:${createHash("sha256").update(actionSource).digest("hex")}`,
      registryArtifactUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/action.mjs`,
    },
    config: {},
    inputs: {
      source: {
        type: "file",
        name: "source.json",
        uri: inputUri,
        metadata: {
          bytes: content.length,
          sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`,
        },
      },
    },
    state: {},
  };
  const result = await executeRuntimeInvocation(
    invocation,
    {
      actionCacheDir: cache,
      processOwnership: ownership,
      allowedActionPermissions: manifest.permissions,
      allowedHostOperations: sandboxRpcMethodsForAction(manifest).filter(
        (method) => !isRuntimeArtifactMethod(method),
      ),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    },
    {
      async call(method, args) {
        if (method === "artifacts.publish") return args[0];
        throw new Error(`Unexpected host operation: ${method}`);
      },
    },
    new AbortController().signal,
  );
  assert.deepEqual(result.outputs?.result, result.artifacts?.[0]);
  assert.equal(result.artifacts?.[0]?.uri, inputUri);
  assert.equal(result.artifacts?.[0]?.metadata?.assignmentId, invocation.assignmentId);
});
