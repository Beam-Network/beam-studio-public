import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, realpath, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { ActionContext, ActionJson } from "@beam-studio/core";
import {
  activeActionSandboxProcessCount,
  sandboxedActionExecute,
} from "./actionSandbox.js";
import { prepareArtifactPorts } from "./artifactPorts.js";
import type { ActionManifest } from "@beam-studio/core";
import { probeActionResourceBudgets } from "./resource-budgets.js";
import {
  prepareProcessOwnership,
  registerProcessController,
} from "./process-ownership.js";

const tempDirs: string[] = [];

test("a parent-owned renewable lease can replace only the sandbox's fixed v1 timer", async () => {
  const source = `export async function execute() {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {outputs:{ok:true}};
    }`;
  const fixed = await sandboxExecute(source, {
    timeoutMs: 50,
    isolation: "trusted-node",
  });
  await assert.rejects(
    async () => fixed({ config: {}, inputs: {} }, actionContext()),
    /sandbox timed out/,
  );
  const execute = await sandboxExecute(source, {
    timeoutMs: null,
    isolation: "trusted-node",
  });
  assert.deepEqual(
    (await execute({ config: {}, inputs: {} }, actionContext())).outputs,
    { ok: true },
  );
  assert.equal(activeActionSandboxProcessCount(), 0);
});

test("native v2 budgets enforce CPU, peak memory, and cancellation", async (t) => {
  if (!(await probeActionResourceBudgets())) {
    t.skip("Native Linux cgroup v2 delegation is unavailable");
    return;
  }
  const budget = { cpuMillis: 1_000, memoryMiB: 256, timeoutSeconds: 8 };
  await t.test("within budget", async () => {
    const execute = await sandboxExecute(
      `export function execute() { return {outputs:{ok:true}} }`,
      { resourceBudget: budget },
    );
    assert.deepEqual(
      (await execute({ config: {}, inputs: {} }, actionContext())).outputs,
      { ok: true },
    );
    assert.equal(activeActionSandboxProcessCount(), 0);
  });
  await t.test("v2 artifact input and output", async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL(
          "../../core/src/workflows/fixtures/registry-v2/v2-single.valid.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as ActionManifest;
    const content = Buffer.from('{"n":1}');
    const inputs = {
      source: {
        type: "file",
        name: "source.json",
        uri: `data:application/json;base64,${content.toString("base64")}`,
        metadata: {
          bytes: content.length,
          sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`,
        },
      },
    };
    const ports = prepareArtifactPorts(manifest, inputs, actionContext());
    const execute = await sandboxExecute(
      `export async function execute(_input, context) {
        const content = await context.artifacts.readInput("source");
        await context.artifacts.publishOutput("result", content, {mediaType:"application/json"});
        return {outputs:{}};
      }`,
      {
        resourceBudget: budget,
        allowedRpcMethods: ["artifacts.readInput", "artifacts.publishOutput"],
      },
    );
    const result = await ports.finish(
      await execute({ config: {}, inputs }, ports.context),
    );
    assert.equal(result.outputs?.result, result.artifacts?.[0]);
    assert.equal(activeActionSandboxProcessCount(), 0);
  });
  await t.test("CPU exhaustion", async () => {
    const execute = await sandboxExecute(
      `export function execute() { while (true) {} }`,
      { resourceBudget: budget },
    );
    await assert.rejects(
      async () => execute({ config: {}, inputs: {} }, actionContext()),
      /cumulative CPU budget exceeded/,
    );
    assert.equal(activeActionSandboxProcessCount(), 0);
  });
  await t.test("peak memory exhaustion", async () => {
    const execute = await sandboxExecute(
      `export function execute() { const chunks=[]; while(true) chunks.push(Buffer.alloc(8*1024*1024,1)); }`,
      // A one-core Linux host may spend tens of seconds in memory reclaim
      // before its cgroup reports the peak-memory kill. Keep this below the
      // action's declared timeout while allowing the kernel to settle.
      { resourceBudget: { ...budget, cpuMillis: 10_000, timeoutSeconds: 35 } },
    );
    await assert.rejects(
      async () => execute({ config: {}, inputs: {} }, actionContext()),
      /peak process-memory budget exceeded/,
    );
    assert.equal(activeActionSandboxProcessCount(), 0);
  });
  await t.test("cancellation", async () => {
    const controller = new AbortController();
    const execute = await sandboxExecute(
      `export async function execute() { await new Promise(() => {}); }`,
      { resourceBudget: budget, abortGraceMs: 50 },
    );
    const result = Promise.resolve(
      execute(
        { config: {}, inputs: {} },
        actionContext({ signal: controller.signal }),
      ),
    );
    await waitFor(() => activeActionSandboxProcessCount() === 1);
    controller.abort("test abort");
    await assert.rejects(result, /sandbox was aborted/);
    assert.equal(activeActionSandboxProcessCount(), 0);
  });
});

test("Runner sandbox reads and publishes through the same artifact ports", async () => {
  const execute = await sandboxExecute(
    `export async function execute(_input, context) {
      const content = await context.artifacts.readInput("source");
      await context.artifacts.publishOutput("result", content, {mediaType:"text/plain"});
      return {outputs:{}};
    }`,
    { allowedRpcMethods: ["artifacts.readInput", "artifacts.publishOutput"] },
  );
  const manifest = {
    name: "@test/ports",
    version: "1.0.0",
    apiVersion: "workflow-actions/v1",
    runtime: { placements: ["local-workers"] },
    inputs: { source: { type: "artifact", required: true } },
    outputs: { result: { type: "artifact", required: true } },
  } satisfies ActionManifest;
  const inputs = {
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
  };
  const ports = prepareArtifactPorts(manifest, inputs, actionContext());
  const result = await ports.finish(
    await execute({ config: {}, inputs }, ports.context),
  );
  assert.equal(result.artifacts?.[0]?.uri, "data:text/plain;base64,aGVsbG8=");
  assert.deepEqual(result.outputs?.result, result.artifacts?.[0]);
});

test("room methods cross the trusted action sandbox through permission-gated host RPCs", async () => {
  const calls: string[] = [];
  const execute = await sandboxExecute(
    `export async function execute(_input, context) {
    const publication = await context.beam.rooms.publish();
    const status = await context.beam.rooms.status();
    const cancelled = await context.beam.rooms.cancel();
    return {outputs:{publication,status,cancelled}};
  }`,
    {
      isolation: "trusted-node",
      allowedRpcMethods: [
        "beam.rooms.publish",
        "beam.rooms.status",
        "beam.rooms.cancel",
      ],
    },
  );
  const context = actionContext();
  context.beam.rooms = Object.fromEntries(
    ["publish", "status", "cancel"].map((operation) => [
      operation,
      async () => {
        calls.push(operation);
        return operation;
      },
    ]),
  );
  const result = await execute({ config: {}, inputs: {} }, context);
  assert.deepEqual(calls, ["publish", "status", "cancel"]);
  assert.deepEqual(result.outputs, {
    publication: "publish",
    status: "status",
    cancelled: "cancel",
  });
});

afterEach(async () => {
  await waitFor(() => activeActionSandboxProcessCount() === 0);
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

test("redacts secrets and signed URLs from action logs and errors", async () => {
  const secret = "worker-secret-value-123";
  const signedUrl =
    "https://files.test/object?expires=123&sig=do-not-log-this-signature";
  const workerLogs: unknown[] = [];
  const actionLogs: unknown[] = [];
  const execute = await sandboxExecute(
    `
      export async function execute(_input, context) {
        const secret = await context.secrets.get("credential");
        console.log("stdout " + secret);
        process.stderr.write("stderr ${signedUrl}\\n");
        await context.logger.info("action " + secret, { url: "${signedUrl}" });
        throw new Error("failure " + secret + " ${signedUrl}");
      }
    `,
    {
      isolation: "trusted-node",
      allowedRpcMethods: ["logger.info", "secrets.get"],
      logger: capturingWorkerLogger(workerLogs),
    },
  );

  const context = actionContext({
    actionLogs,
    secret,
  });
  await assert.rejects(
    async () => execute({ config: {}, inputs: {} }, context),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /worker-secret-value|do-not-log/);
      assert.match(error.message, /\[REDACTED\]/);
      assert.match(error.message, /\[REDACTED_SIGNED_URL\]/);
      return true;
    },
  );

  const serializedLogs = JSON.stringify([...workerLogs, ...actionLogs]);
  assert.doesNotMatch(serializedLogs, /worker-secret-value|do-not-log/);
  assert.match(serializedLogs, /REDACTED/);
});

test("preserves non-retryable action errors across sandbox boundaries", async (t) => {
  for (const isolation of ["sandboxed-esm", "trusted-node"] as const) {
    await t.test(isolation, async () => {
      const execute = await sandboxExecute(
        `
          export function execute() {
            const error = new Error("terminal action failure");
            error.retryable = false;
            throw error;
          }
        `,
        { isolation },
      );

      await assert.rejects(
        async () => execute({ config: {}, inputs: {} }, actionContext()),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(
            (error as Error & { retryable?: boolean }).retryable,
            false,
          );
          return true;
        },
      );
    });
  }
});

test("caps the action child V8 heap", async () => {
  const execute = await sandboxExecute(
    `
      import v8 from "node:v8";
      export function execute() {
        return { outputs: { heapLimit: v8.getHeapStatistics().heap_size_limit } };
      }
    `,
    { isolation: "trusted-node", memoryLimitMb: 32 },
  );
  const result = await execute({ config: {}, inputs: {} }, actionContext());
  // V8 reserves additional non-old-space heap regions; the configured old
  // space is 32 MiB while the reported total heap limit remains below 256 MiB.
  assert.ok(Number(result.outputs?.heapLimit) < 256 * 1024 * 1024);
});

test("cleans up the child after success, action error, abort, and timeout", async (t) => {
  await t.test("success", async () => {
    const execute = await sandboxExecute(
      `export function execute() { return { outputs: { ok: true } }; }`,
    );
    await execute({ config: {}, inputs: {} }, actionContext());
    assert.equal(activeActionSandboxProcessCount(), 0);
  });

  await t.test("error", async () => {
    const execute = await sandboxExecute(
      `export function execute() { throw new Error("expected"); }`,
    );
    await assert.rejects(
      async () => execute({ config: {}, inputs: {} }, actionContext()),
      /expected/,
    );
    assert.equal(activeActionSandboxProcessCount(), 0);
  });

  await t.test("abort", async () => {
    const controller = new AbortController();
    const execute = await sandboxExecute(
      `export async function execute() { await new Promise(() => {}); }`,
    );
    const pending = execute(
      { config: {}, inputs: {} },
      actionContext({ signal: controller.signal }),
    );
    await waitFor(() => activeActionSandboxProcessCount() === 1);
    controller.abort("test abort");
    await assert.rejects(async () => pending, /sandbox was aborted/);
    assert.equal(activeActionSandboxProcessCount(), 0);
  });

  await t.test("timeout", async () => {
    const execute = await sandboxExecute(
      `export function execute() { while (true) {} }`,
      { timeoutMs: 50 },
    );
    await assert.rejects(
      async () => execute({ config: {}, inputs: {} }, actionContext()),
      /sandbox timed out/,
    );
    assert.equal(activeActionSandboxProcessCount(), 0);
  });
});

test("cancellation before readiness stops the sandbox without executing the action", async () => {
  const controller = new AbortController();
  const execute = await sandboxExecute(
    `export async function execute(_, context) { await context.state.patch({unexpected:true}); return {outputs:{}}; }`,
    { timeoutMs: 5_000, allowedRpcMethods: ["state.patch"] },
  );
  const context = actionContext({ signal: controller.signal });
  controller.abort("cancelled before launch");
  await assert.rejects(
    () => Promise.resolve(execute({ config: {}, inputs: {} }, context)),
    /sandbox was aborted/,
  );
  assert.equal(context.state.get().unexpected, undefined);
  assert.equal(activeActionSandboxProcessCount(), 0);
});

test("retains execution ownership until delayed exit evidence arrives", async (t) => {
  const originalEmit = ChildProcess.prototype.emit;
  let deliverExit: (() => void) | undefined;
  t.mock.method(
    ChildProcess.prototype,
    "emit",
    function (this: ChildProcess, event: string | symbol, ...args: unknown[]) {
      if (event === "exit") {
        deliverExit = () => Reflect.apply(originalEmit, this, [event, ...args]);
        return true;
      }
      return Reflect.apply(originalEmit, this, [event, ...args]);
    },
  );
  const execute = await sandboxExecute(
    `export function execute() { return { outputs: { ok: true } }; }`,
  );
  let settled = false;
  const execution = Promise.resolve(
    execute({ config: {}, inputs: {} }, actionContext()),
  ).finally(() => {
    settled = true;
  });
  try {
    await waitFor(() => deliverExit !== undefined);
    // The previous cleanup timeout released ownership after two seconds even
    // though the process-exit event had not reached the executor.
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    assert.equal(settled, false);
    assert.equal(activeActionSandboxProcessCount(), 1);
  } finally {
    deliverExit?.();
    await execution;
  }
  assert.equal(activeActionSandboxProcessCount(), 0);
});

test("denies host process escapes and filesystem writes outside scratch", async () => {
  const outsidePath = path.join(
    os.tmpdir(),
    `beam-sandbox-escape-${Date.now()}`,
  );
  const execute = await sandboxExecute(
    `
      import fs from "node:fs";
      export function execute() {
        let denied = false;
        try {
          fs.writeFileSync(${JSON.stringify(outsidePath)}, "escape");
        } catch (error) {
          denied = error?.code === "ERR_ACCESS_DENIED";
        }
        return { outputs: { denied } };
      }
    `,
    { isolation: "trusted-node" },
  );
  const result = await execute({ config: {}, inputs: {} }, actionContext());
  assert.deepEqual(result.outputs, { denied: true });
});

test("enforces an aggregate quota across sandbox scratch files", async () => {
  const scratchDir = await tempDir();
  const execute = await sandboxExecute(
    `
      export async function execute(_input, context) {
        const first = await context.beam.files.createTempFile({ name: "first" });
        const second = await context.beam.files.createTempFile({ name: "second" });
        await first.write("123");
        await second.write("456");
        return { outputs: { ok: true } };
      }
    `,
    {
      allowedRpcMethods: ["beam.files.publishTempFile"],
      diskWrite: { scratchDir, maxBytes: 5 },
    },
  );
  await assert.rejects(
    async () => execute({ config: {}, inputs: {} }, actionContext()),
    /quota exceeded/,
  );
});

test("gives concurrent actions distinct private scratch directories", async () => {
  const scratchDir = await tempDir();
  const publishedPaths: string[] = [];
  const execute = await sandboxExecute(
    `
      export async function execute(_input, context) {
        const file = await context.beam.files.createTempFile({ name: "result.bin" });
        await file.write("ok");
        await file.publish();
        return { outputs: { ok: true } };
      }
    `,
    {
      allowedRpcMethods: ["beam.files.publishTempFile"],
      diskWrite: { scratchDir, maxBytes: 10 },
    },
  );
  const context = () =>
    actionContext({
      publishTempFile: async (input: Record<string, unknown>) => {
        publishedPaths.push(String(input.tempFilePath));
        return { uri: "memory://wait-result" };
      },
    });
  await Promise.all([
    execute({ config: {}, inputs: {} }, context()),
    execute({ config: {}, inputs: {} }, context()),
  ]);
  assert.equal(publishedPaths.length, 2);
  assert.notEqual(
    path.dirname(publishedPaths[0]!),
    path.dirname(publishedPaths[1]!),
  );
  const resolvedScratchDir = await realpath(scratchDir);
  assert.equal(
    path.dirname(path.dirname(publishedPaths[0]!)),
    resolvedScratchDir,
  );
  assert.equal(
    path.dirname(path.dirname(publishedPaths[1]!)),
    resolvedScratchDir,
  );
});

test("denies trusted Node network by default and allows only an explicit destination", async () => {
  const deniedExecute = await sandboxExecute(
    `
      import http from "node:http";
      export function execute() {
        let denied = false;
        try {
          http.get("http://127.0.0.1:9/");
        } catch (error) {
          denied = error?.code === "ERR_ACCESS_DENIED";
        }
        return { outputs: { denied } };
      }
    `,
    { isolation: "trusted-node" },
  );
  const denied = await deniedExecute(
    { config: {}, inputs: {} },
    actionContext(),
  );
  assert.deepEqual(denied.outputs, { denied: true });

  const server = http.createServer((_request, response) => response.end("ok"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const address = server.address() as AddressInfo;
    const execute = await sandboxExecute(
      `
        import http from "node:http";
        export async function execute() {
          const body = await new Promise((resolve, reject) => {
            http.get("http://127.0.0.1:${address.port}/", (response) => {
              let body = "";
              response.on("data", (chunk) => body += chunk);
              response.on("end", () => resolve(body));
            }).on("error", reject);
          });
          return { outputs: { body } };
        }
      `,
      {
        isolation: "trusted-node",
        allowedNetwork: [`127.0.0.1:${address.port}`],
      },
    );
    const result = await execute({ config: {}, inputs: {} }, actionContext());
    assert.deepEqual(result.outputs, { body: "ok" });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("allows TLS-first connections resolved to an IP when their verified SNI is allowed", async () => {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const address = server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    const execute = await sandboxExecute(
      `
        import tls from "node:tls";
        export async function execute() {
          const code = await new Promise((resolve) => {
            const socket = tls.connect(
              ${address.port},
              "127.0.0.1",
              { servername: "orch-gateway.b1m.ai" },
            );
            socket.once("error", (error) => resolve(error?.code));
          });
          return { outputs: { code } };
        }
      `,
      {
        isolation: "trusted-node",
        allowedNetwork: [`orch-gateway.b1m.ai:${address.port}`],
      },
    );
    const result = await execute({ config: {}, inputs: {} }, actionContext());
    assert.equal(result.outputs?.code, "ECONNREFUSED");
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
});

test("does not trust TLS SNI when certificate verification is disabled", async () => {
  const execute = await sandboxExecute(
    `
      import tls from "node:tls";
      export function execute() {
        let code = null;
        try {
          tls.connect(9, "127.0.0.1", {
            servername: "orch-gateway.b1m.ai",
            rejectUnauthorized: false,
          });
        } catch (error) {
          code = error?.code;
        }
        return { outputs: { code } };
      }
    `,
    {
      isolation: "trusted-node",
      allowedNetwork: ["orch-gateway.b1m.ai:9"],
    },
  );
  const result = await execute({ config: {}, inputs: {} }, actionContext());
  assert.equal(result.outputs?.code, "ERR_ACCESS_DENIED");
});

test("denies undeclared host RPC capabilities before invoking the host", async () => {
  let secretRead = false;
  const execute = await sandboxExecute(
    `
      export async function execute(_input, context) {
        await context.secrets.get("credential");
        return { outputs: { ok: true } };
      }
    `,
  );
  await assert.rejects(
    async () =>
      execute(
        { config: {}, inputs: {} },
        actionContext({
          secretGetter: async () => {
            secretRead = true;
            return "must-not-be-read";
          },
        }),
      ),
    /unavailable method "secrets.get"/,
  );
  assert.equal(secretRead, false);
});

test("bounds raw child output retained by worker logs", async () => {
  const workerLogs: unknown[] = [];
  const execute = await sandboxExecute(
    `
      export function execute() {
        process.stdout.write("x".repeat(100000));
        return { outputs: { ok: true } };
      }
    `,
    {
      isolation: "trusted-node",
      logger: capturingWorkerLogger(workerLogs),
    },
  );
  await execute({ config: {}, inputs: {} }, actionContext());
  const serialized = JSON.stringify(workerLogs);
  assert.ok(serialized.length < 70_000);
  assert.match(serialized, /TRUNCATED/);
});

async function sandboxExecute(
  source: string,
  options: Partial<Parameters<typeof sandboxedActionExecute>[0]> = {},
) {
  const cacheDir = await tempDir();
  const entrypointPath = path.join(cacheDir, "wait-action.mjs");
  await writeFile(entrypointPath, source);
  const ownership =
    options.resourceBudget && !options.processOwnership
      ? await prepareProcessOwnership(
          path.join(cacheDir, "ownership"),
          "test-action",
        )
      : options.processOwnership;
  if (options.resourceBudget && !options.processOwnership && ownership)
    await registerProcessController(ownership);
  return sandboxedActionExecute({
    entrypointPath,
    actionCacheDir: cacheDir,
    logger: capturingWorkerLogger([]),
    ...options,
    processOwnership: ownership,
  });
}

function capturingWorkerLogger(logs: unknown[]) {
  return {
    debug(payload: unknown, message: string) {
      logs.push({ level: "debug", message, payload });
    },
    error(payload: unknown, message: string) {
      logs.push({ level: "error", message, payload });
    },
    info(payload: unknown, message: string) {
      logs.push({ level: "info", message, payload });
    },
    warn(payload: unknown, message: string) {
      logs.push({ level: "warn", message, payload });
    },
  };
}

function actionContext(
  options: {
    actionLogs?: unknown[];
    publishTempFile?: (input: Record<string, unknown>) => Promise<unknown>;
    secret?: string;
    secretGetter?: () => Promise<string>;
    signal?: AbortSignal;
  } = {},
) {
  const storage = new Map<string, ActionJson>();
  let state: Record<string, ActionJson> = {};
  const actionLogs = options.actionLogs ?? [];
  const context = {
    artifacts: { publish: async (artifact: unknown) => artifact },
    taskId: "task_wait",
    attempt: 1,
    beam: {
      files: {
        publishTempFile:
          options.publishTempFile ??
          (async () => ({ uri: "memory://wait-result" })),
      },
    },
    logger: {
      debug(message: string, payload?: Record<string, unknown>) {
        actionLogs.push({ level: "debug", message, payload });
      },
      error(message: string, payload?: Record<string, unknown>) {
        actionLogs.push({ level: "error", message, payload });
      },
      info(message: string, payload?: Record<string, unknown>) {
        actionLogs.push({ level: "info", message, payload });
      },
      warn(message: string, payload?: Record<string, unknown>) {
        actionLogs.push({ level: "warn", message, payload });
      },
    },
    secrets: {
      get: options.secretGetter ?? (async () => options.secret ?? null),
    },
    state: {
      get: () => ({ ...state }),
      patch: async (partial: Record<string, ActionJson>) => {
        state = { ...state, ...partial };
      },
      set: async (next: Record<string, ActionJson>) => {
        state = { ...next };
      },
    },
    stepId: "step_wait",
    stepRunId: "wsr_wait",
    signal: options.signal ?? new AbortController().signal,
    storage: {
      getJson: async (key: string) => storage.get(key),
      putJson: async (key: string, value: ActionJson) => {
        storage.set(key, value);
      },
    },
    workflowRunId: "wfr_wait",
  };
  return context as unknown as ActionContext;
}

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "beam-action-sandbox-"));
  tempDirs.push(dir);
  return dir;
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for sandbox state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
