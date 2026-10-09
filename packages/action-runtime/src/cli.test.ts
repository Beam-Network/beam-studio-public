import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { sandboxRpcMethodsForAction } from "./actionPermissions.js";
import { prepareProcessOwnership } from "./process-ownership.js";
import type { ActionManifest } from "@beam-studio/core";

async function runtime(
  t: TestContext,
  source: string,
  options: { allowed?: boolean; abort?: boolean; ports?: boolean } = {},
) {
  const cache = await mkdtemp(path.join(os.tmpdir(), "beam-runtime-cli-"));
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request.headers.authorization ?? "");
    response.end(source);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
      fileURLToPath(new URL("./cli.ts", import.meta.url)),
    ],
    {
      env: { ...process.env, NODE_OPTIONS: "--conditions=development" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  t.after(async () => {
    child.kill();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cache, { recursive: true, force: true });
  });
  const manifest: ActionManifest = {
    inputs: options.ports
      ? { source: { type: "artifact", required: true } }
      : {},
    outputs: options.ports
      ? { result: { type: "artifact", required: true } }
      : {},
    name: "@test/member",
    version: "1.0.0",
    apiVersion: "workflow-actions/v1" as const,
    runtime: { placements: ["room-members" as const] },
    execution: {
      runtime: "node" as const,
      isolation: "sandboxed-esm" as const,
    },
    permissions: [],
  };
  const messages: Record<string, any>[] = [];
  let stderr = "";
  child.stderr.on("data", (data) => (stderr += String(data)));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    messages.push(message);
    if (message.type === "rpc") {
      child.stdin.write(
        JSON.stringify({
          type: "rpcResult",
          id: message.id,
          ok: true,
          value:
            message.method === "artifacts.publish" ? message.args[0] : null,
        }) + "\n",
      );
      if (options.abort)
        child.stdin.write(
          JSON.stringify({ type: "abort", reason: "cancelled by test" }) + "\n",
        );
    }
  });
  child.stdin.write(
    JSON.stringify({
      type: "invoke",
      protocol: "action-execution/v1",
      invocation: {
        ...(options.ports
          ? { artifactPortsProtocol: "action-artifact-ports/v1" }
          : {}),
        assignmentId: "assignment1",
        taskId: "task1",
        workflowRunId: "run1",
        stepRunId: "step1",
        stepId: "step1",
        attempt: 1,
        room: { environmentTemplateKey: "dev", roomId: "room1" },
        step: {
          actionPackage: manifest.name,
          versionRange: "1.0.0",
          resolvedVersion: "1.0.0",
          manifestSnapshot: manifest,
          artifactChecksum:
            "sha256:" + createHash("sha256").update(source).digest("hex"),
          registryArtifactUrl: `http://127.0.0.1:${address.port}/artifact`,
        },
        config: {},
        inputs: options.ports
          ? {
              source: {
                type: "file",
                name: "input.txt",
                uri: "data:text/plain;base64,aGVsbG8=",
                metadata: {
                  bytes: 5,
                  sha256:
                    "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
                },
              },
            }
          : { name: "Ada" },
        state: {},
      },
      policy: {
        processOwnership: await prepareProcessOwnership(
          path.join(cache, "ownership"),
          "assignment1",
        ),
        actionCacheDir: cache,
        actionArtifactAuthorization: "Bearer scoped-test-capability",
        allowedActions: options.allowed === false ? [] : [manifest.name],
        isolations: ["sandboxed-esm"],
        allowedActionPermissions: [],
        allowedHostOperations: sandboxRpcMethodsForAction(manifest),
      },
    }) + "\n",
  );
  const exit = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Runtime did not exit: " + stderr));
    }, 10_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once("error", reject);
  });
  assert.equal(exit, 0, stderr);
  return { messages, requests };
}

test("standalone runtime verifies an artifact and commits scoped state before returning output", async (t) => {
  const { messages, requests } = await runtime(
    t,
    `export async function execute({inputs},ctx){await ctx.state.patch({name:inputs.name});return {outputs:{greeting:'Hi '+ctx.state.get().name}}}`,
  );
  assert.deepEqual(
    requests,
    ["Bearer scoped-test-capability"],
    JSON.stringify(messages),
  );
  assert.equal(
    messages.find((message) => message.type === "rpc")?.method,
    "state.patch",
  );
  assert.deepEqual(
    messages.find((message) => message.type === "result")?.result.outputs,
    { greeting: "Hi Ada" },
  );
});
test("member runtime executes verified artifact ports with scoped publication", async (t) => {
  const { messages } = await runtime(
    t,
    `export async function execute(_input,ctx){const content=await ctx.artifacts.readInput('source');await ctx.artifacts.publishOutput('result',content,{mediaType:'text/plain'});return {outputs:{}}}`,
    { ports: true },
  );
  const result = messages.find((message) => message.type === "result")?.result;
  assert.equal(result.artifacts[0].uri, "data:text/plain;base64,aGVsbG8=");
  assert.deepEqual(result.outputs.result, result.artifacts[0]);
  assert.ok(messages.some((message) => message.method === "artifacts.publish"));
});
test("standalone runtime rejects an action outside the local allowlist before loading it", async (t) => {
  const { messages, requests } = await runtime(
    t,
    "export function execute(){return {outputs:{}}}",
    { allowed: false },
  );
  assert.deepEqual(requests, []);
  assert.match(messages.at(-1)?.error.message, /not locally allowlisted/);
});
test("standalone runtime forwards cancellation into action cleanup and exits", async (t) => {
  const { messages } = await runtime(
    t,
    `export async function execute(_,ctx){await ctx.state.patch({started:true});await new Promise(resolve=>{if(ctx.signal.aborted)resolve();else ctx.signal.addEventListener('abort',resolve,{once:true})});throw new Error('cleanup finished')}`,
    { abort: true },
  );
  assert.ok(
    messages.some((message) => message.type === "rpc"),
    JSON.stringify(messages),
  );
  assert.equal(messages.at(-1)?.type, "error");
  assert.equal(
    messages.some((message) => message.type === "result"),
    false,
  );
});
