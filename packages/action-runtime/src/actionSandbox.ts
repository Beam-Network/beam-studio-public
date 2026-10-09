import { fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ActionContext,
  ActionExecute,
  ActionJson,
  ActionResult,
} from "@beam-studio/core";
import type { ActionRuntimeOptions } from "./types.js";
import {
  bindActionResourceBudget,
  grantSandboxExecution,
  recordSandboxStopped,
} from "./process-ownership.js";
import {
  cleanupActionResourceBudget,
  launchBudgetedSandbox,
  newActionResourceBudgetToken,
  sealActionResourceBudget,
  type ActionResourceBudget,
} from "./resource-budgets.js";

type SandboxMessage =
  | { type: "ready" }
  | { type: "started" }
  | { type: "result"; result: ActionResult }
  | { type: "error"; error: SerializedError }
  | {
      type: "rpc";
      id: number;
      method: string;
      args: unknown[];
    };

type SerializedError = {
  name?: string;
  message: string;
  stack?: string;
  retryable?: boolean;
};

type SandboxExecuteOptions = {
  processOwnership?: ActionRuntimeOptions["processOwnership"];
  entrypointPath: string;
  actionCacheDir?: string;
  timeoutMs?: number | null;
  abortGraceMs?: number;
  memoryLimitMb?: number;
  resourceBudget?: ActionResourceBudget & { timeoutSeconds: number };
  isolation?: "sandboxed-esm" | "trusted-node";
  allowedNetwork?: string[];
  allowedRpcMethods?: string[];
  diskWrite?: {
    scratchDir: string;
    maxBytes: number;
  };
  logger: ActionRuntimeOptions["logger"];
};

const activeSandboxProcesses = new Set<ChildProcess>();
const defaultSandboxMemoryMb = 128;
const maxCapturedOutputBytes = 64 * 1024;
const redactedValue = "[REDACTED]";
const redactedSignedUrl = "[REDACTED_SIGNED_URL]";

export function activeActionSandboxProcessCount() {
  return activeSandboxProcesses.size;
}

export function redactSignedUrls(value: string | null | undefined) {
  if (value == null) {
    return value;
  }
  return value.replace(/https?:\/\/[^\s"'<>]+/giu, (candidate) => {
    try {
      const parsed = new URL(candidate);
      const signed = [...parsed.searchParams.keys()].some((key) =>
        /^(?:x-amz-(?:signature|credential|security-token)|signature|sig|token|access_token)$/iu.test(
          key,
        ),
      );
      return signed ? redactedSignedUrl : candidate;
    } catch {
      return candidate;
    }
  });
}

export function sandboxedActionExecute(
  input: SandboxExecuteOptions,
): ActionExecute {
  return (actionInput, context) =>
    executeInSandbox({
      ...input,
      actionInput,
      context,
    });
}

async function executeInSandbox(
  input: SandboxExecuteOptions & {
    actionInput: Parameters<ActionExecute>[0];
    context: ActionContext;
  },
): Promise<ActionResult> {
  if (input.resourceBudget && !input.processOwnership) {
    throw new Error(
      "Registry v2 action budgets require durable process ownership.",
    );
  }
  const isolation = input.isolation ?? "sandboxed-esm";
  const runnerPath = await ensureSandboxRunner(input.actionCacheDir, isolation);
  const sandboxPaths = await sandboxRuntimePaths(
    runnerPath,
    input.entrypointPath,
    input.diskWrite?.scratchDir,
  );
  const budgetToken = input.resourceBudget
    ? newActionResourceBudgetToken()
    : null;
  if (budgetToken && input.processOwnership) {
    try {
      await bindActionResourceBudget(input.processOwnership, budgetToken);
    } catch (error) {
      if (sandboxPaths.scratchDir)
        await rm(sandboxPaths.scratchDir, { force: true, recursive: true });
      throw error;
    }
  }
  return new Promise<ActionResult>((resolve, reject) => {
    const actionArgs = [
      sandboxPaths.entrypointPath,
      sandboxPaths.scratchDir ?? "",
      String(input.diskWrite?.maxBytes ?? 0),
      JSON.stringify(input.allowedNetwork ?? []),
    ];
    const nodeArgs = actionRuntimeExecArgv(
      isolation,
      sandboxPaths,
      input.memoryLimitMb ?? defaultSandboxMemoryMb,
    );
    const budgeted = input.resourceBudget
      ? launchBudgetedSandbox(
          input.resourceBudget,
          [...nodeArgs, sandboxPaths.runnerPath, ...actionArgs],
          ["ignore", "pipe", "pipe", "ipc"],
          budgetToken!,
        )
      : null;
    const child =
      budgeted?.child ??
      fork(sandboxPaths.runnerPath, actionArgs, {
        env: {},
        execArgv: nodeArgs,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
    activeSandboxProcesses.add(child);
    const redactor = new SandboxRedactor();
    const stdout = new RedactingOutputLogger(redactor, (output) =>
      input.logger.info({ output }, "Remote action sandbox stdout"),
    );
    const stderr = new RedactingOutputLogger(redactor, (output) =>
      input.logger.warn({ output }, "Remote action sandbox stderr"),
    );
    const runtimeState = {
      allowedRpcMethods: new Set(input.allowedRpcMethods ?? []),
      preserveScratch: false,
      redactor,
    };
    let finishing = false;
    let exited = false;
    let exitSignal: NodeJS.Signals | null = null;
    let killedByParent = false;
    let markExited!: () => void;
    const exitedPromise = new Promise<void>((resolveExit) => {
      markExited = resolveExit;
    });
    child.once("exit", (_code, signal) => {
      exited = true;
      exitSignal = signal;
      activeSandboxProcesses.delete(child);
      markExited();
    });
    child.once("error", () => {
      if (child.pid === undefined) {
        exited = true;
        activeSandboxProcesses.delete(child);
        markExited();
      }
    });
    let abortCleanupTimeout: ReturnType<typeof setTimeout> | null = null;
    let actionStarted = false;
    let executionSent = false;
    let sandboxReady = false;
    let pendingAbortReason: string | null = null;
    const timeoutMs = input.resourceBudget
      ? Math.min(
          input.timeoutMs ?? 5 * 60_000,
          input.resourceBudget.timeoutSeconds * 1000,
          2_147_483_647,
        )
      : input.timeoutMs === null
        ? null
        : (input.timeoutMs ?? 5 * 60_000);
    const timeout =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            void finish(
              reject,
              new Error(
                `Remote action sandbox timed out after ${timeoutMs}ms.`,
              ),
            );
          }, timeoutMs);
    timeout?.unref();
    const abort = () => {
      if (abortCleanupTimeout) {
        return;
      }
      const reason = String(input.context.signal.reason ?? "aborted");
      pendingAbortReason = reason;
      if (!executionSent) {
        void finish(
          reject,
          new Error(`Remote action sandbox was aborted: ${reason}`),
        );
        return;
      }
      if (actionStarted && child.connected) {
        child.send({ type: "abort", reason });
      }
      abortCleanupTimeout = setTimeout(() => {
        void finish(
          reject,
          new Error(`Remote action sandbox was aborted: ${reason}`),
        );
      }, input.abortGraceMs ?? 30_000);
      abortCleanupTimeout.unref();
    };
    input.context.signal.addEventListener("abort", abort, { once: true });
    if (input.context.signal.aborted) {
      abort();
    }
    child.stdout?.on("data", (chunk) => stdout.write(chunk));
    child.stderr?.on("data", (chunk) => stderr.write(chunk));
    child.on("error", (error) => void finish(reject, error));
    child.on("exit", (code, signal) => {
      if (!finishing) {
        void finish(
          reject,
          new Error(
            `Remote action sandbox exited before completing: code=${code ?? "null"} signal=${signal ?? "null"}.`,
          ),
        );
      }
    });
    child.on("message", (message: SandboxMessage) => {
      if (message.type === "started") {
        actionStarted = true;
        if (pendingAbortReason && child.connected) {
          child.send({ type: "abort", reason: pendingAbortReason });
        }
      }
      const handleMessage = async () => {
        if (message.type === "ready") {
          if (sandboxReady) throw new Error("Duplicate sandbox readiness");
          sandboxReady = true;
          if (budgeted) await sealActionResourceBudget(budgeted.token);
          if (input.processOwnership) {
            if (!child.pid)
              throw new Error("Sandbox process identity is missing");
            await grantSandboxExecution(
              input.processOwnership,
              child.pid,
              budgeted?.token,
            );
          }
          if (finishing || input.context.signal.aborted) return null;
          executionSent = true;
        }
        return handleSandboxMessage(child, message, input, runtimeState);
      };
      void handleMessage()
        .then((result) => {
          if (result?.type === "resolve") {
            if (input.context.signal.aborted) {
              void finish(
                reject,
                new Error(
                  `Remote action sandbox was aborted: ${String(input.context.signal.reason ?? "aborted")}`,
                ),
              );
            } else {
              void finish(resolve, result.value);
            }
          }
          if (result?.type === "reject") {
            void finish(reject, result.error);
          }
        })
        .catch((error) => void finish(reject, error));
    });

    async function finish<T>(callback: (value: T) => void, value: T) {
      if (finishing) {
        return;
      }
      finishing = true;
      if (timeout) clearTimeout(timeout);
      if (abortCleanupTimeout) {
        clearTimeout(abortCleanupTimeout);
      }
      input.context.signal.removeEventListener("abort", abort);
      if (child.connected) {
        child.disconnect();
      }
      if (!exited) {
        killedByParent = true;
        child.kill("SIGKILL");
      }
      // Sending a signal (including child.killed) is not termination evidence.
      // Retain ownership until the OS reports exit or spawning failed. The
      // executor's lease/reconciliation path handles an unconfirmed stop.
      await exitedPromise;
      let budgetResult: Awaited<
        ReturnType<typeof cleanupActionResourceBudget>
      > | null = null;
      if (budgeted) {
        try {
          budgetResult = await cleanupActionResourceBudget(budgeted.token);
        } catch (error) {
          reject(error);
          return;
        }
      }
      if (input.processOwnership) {
        try {
          await recordSandboxStopped(input.processOwnership);
        } catch (error) {
          reject(error);
          return;
        }
      }
      stdout.flush();
      stderr.flush();
      if (sandboxPaths.scratchDir && !runtimeState.preserveScratch) {
        await rm(sandboxPaths.scratchDir, {
          force: true,
          recursive: true,
        }).catch(() => undefined);
      }
      if (budgetResult?.oomKilled) {
        reject(new Error("Registry v2 peak process-memory budget exceeded."));
        return;
      }
      if (
        !killedByParent &&
        budgeted &&
        (exitSignal === "SIGXCPU" ||
          (exitSignal === "SIGKILL" &&
            (budgetResult?.cpuUsedMicros ?? 0) >=
              Math.floor(input.resourceBudget!.cpuMillis / 1000) * 1_000_000 -
                100_000))
      ) {
        reject(new Error("Registry v2 cumulative CPU budget exceeded."));
        return;
      }
      callback(
        value instanceof Error
          ? (runtimeState.redactor.redactError(value) as T)
          : value,
      );
    }
  });
}

async function handleSandboxMessage(
  child: ChildProcess,
  message: SandboxMessage,
  input: {
    actionInput: Parameters<ActionExecute>[0];
    context: ActionContext;
    logger: ActionRuntimeOptions["logger"];
  },
  runtimeState: {
    allowedRpcMethods: Set<string>;
    preserveScratch: boolean;
    redactor: SandboxRedactor;
  },
): Promise<
  | { type: "resolve"; value: ActionResult }
  | { type: "reject"; error: Error }
  | null
> {
  if (message.type === "ready") {
    child.send({
      type: "execute",
      input: input.actionInput,
      context: contextSnapshot(input.context),
    });
    return null;
  }
  if (message.type === "started") {
    return null;
  }
  if (message.type === "result") {
    return { type: "resolve", value: message.result };
  }
  if (message.type === "error") {
    return {
      type: "reject",
      error: deserializeError(message.error, runtimeState.redactor),
    };
  }
  if (message.type === "rpc") {
    try {
      if (!runtimeState.allowedRpcMethods.has(message.method)) {
        throw new Error(
          `Remote action requested unavailable method "${message.method}".`,
        );
      }
      const value = await callContextMethod(
        input.context,
        input.logger,
        message.method,
        message.args,
        runtimeState.redactor,
      );
      if (message.method === "secrets.get") {
        runtimeState.redactor.addSecret(value);
      }
      if (message.method === "beam.files.publishTempFile") {
        runtimeState.preserveScratch = true;
      }
      child.send({ type: "rpcResult", id: message.id, ok: true, value });
    } catch (error) {
      child.send({
        type: "rpcResult",
        id: message.id,
        ok: false,
        error: serializeError(error, runtimeState.redactor),
      });
    }
  }
  return null;
}

function contextSnapshot(context: ActionContext) {
  return {
    taskId: context.taskId,
    assignmentId: context.assignmentId,
    workflowRunId: context.workflowRunId,
    stepRunId: context.stepRunId,
    stepId: context.stepId,
    attempt: context.attempt,
    room: context.room ?? null,
    state: context.state.get(),
  };
}

async function callContextMethod(
  context: ActionContext,
  logger: ActionRuntimeOptions["logger"],
  method: string,
  args: unknown[],
  redactor: SandboxRedactor,
) {
  switch (method) {
    case "logger.debug":
      context.logger.debug(
        redactor.redactString(String(args[0] ?? "")),
        redactor.redactObject(objectArg(args[1])),
      );
      return null;
    case "logger.info":
      context.logger.info(
        redactor.redactString(String(args[0] ?? "")),
        redactor.redactObject(objectArg(args[1])),
      );
      return null;
    case "logger.warn":
      context.logger.warn(
        redactor.redactString(String(args[0] ?? "")),
        redactor.redactObject(objectArg(args[1])),
      );
      return null;
    case "logger.error":
      context.logger.error(
        redactor.redactString(String(args[0] ?? "")),
        redactor.redactObject(objectArg(args[1])),
      );
      return null;
    case "state.get":
      return context.state.get();
    case "state.set":
      return context.state.set(
        objectArg(args[0]) as Record<string, ActionJson>,
      );
    case "state.patch":
      return context.state.patch(
        objectArg(args[0]) as Record<string, ActionJson>,
      );
    case "storage.getJson":
      return context.storage.getJson(String(args[0] ?? ""));
    case "storage.putJson":
      return context.storage.putJson(
        String(args[0] ?? ""),
        args[1] as ActionJson,
      );
    case "artifacts.publish":
      return context.artifacts.publish(
        objectArg(args[0]) as Parameters<
          ActionContext["artifacts"]["publish"]
        >[0],
      );
    case "artifacts.readInput":
      if (!context.artifacts.readInput)
        throw new Error("Artifact input capability is unavailable.");
      return context.artifacts.readInput(
        String(args[0] ?? ""),
        Number(args[1] ?? 0),
      );
    case "artifacts.publishOutput":
      if (!context.artifacts.publishOutput)
        throw new Error("Artifact output capability is unavailable.");
      return context.artifacts.publishOutput(
        String(args[0] ?? ""),
        String(args[1] ?? ""),
        objectArg(args[2]) as { name?: string; mediaType?: string },
      );
    case "secrets.get":
      return context.secrets.get(String(args[0] ?? ""));
    case "beam.objectStorage.download":
      return beamMethod(context, "objectStorage", "download", args);
    case "beam.objectStorage.upload":
      return beamMethod(context, "objectStorage", "upload", args);
    case "beam.objectStorage.delete":
      return beamMethod(context, "objectStorage", "delete", args);
    case "beam.fileExports.publishLocalFile":
      return beamMethod(context, "fileExports", "publishLocalFile", args);
    case "beam.files.publishTempFile":
      return beamMethod(context, "files", "publishTempFile", args);
    case "beam.rooms.publish":
      return beamMethod(context, "rooms", "publish", args);
    case "beam.rooms.status":
      return beamMethod(context, "rooms", "status", args);
    case "beam.rooms.cancel":
      return beamMethod(context, "rooms", "cancel", args);
    case "beam.transfer.execute":
      return beamMethod(context, "transfer", "execute", args);
    default:
      logger.warn({ method }, "Remote action sandbox requested unknown method");
      throw new Error(
        `Remote action requested unavailable method "${method}".`,
      );
  }
}

function beamMethod(
  context: ActionContext,
  namespace: string,
  method: string,
  args: unknown[],
) {
  const target = (context.beam as Record<string, unknown>)[namespace];
  if (!target || typeof target !== "object") {
    throw new Error(`Beam runtime namespace "${namespace}" is not available.`);
  }
  const fn = (target as Record<string, unknown>)[method];
  if (typeof fn !== "function") {
    throw new Error(
      `Beam runtime method "${namespace}.${method}" is not available.`,
    );
  }
  return fn(...args);
}

function objectArg(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function serializeError(
  error: unknown,
  redactor = new SandboxRedactor(),
): SerializedError {
  return error !== null && typeof error === "object"
    ? {
        name: stringErrorProperty(error, "name"),
        message: redactor.redactString(
          stringErrorProperty(error, "message") ?? String(error),
        ),
        stack: redactor.redactString(stringErrorProperty(error, "stack") ?? ""),
        ...retryableErrorProperty(error),
      }
    : { message: redactor.redactString(String(error)) };
}

function deserializeError(error: SerializedError, redactor: SandboxRedactor) {
  const result = new Error(redactor.redactString(error.message)) as Error & {
    retryable?: boolean;
  };
  result.name = error.name ?? "RemoteActionSandboxError";
  result.stack = redactor.redactString(error.stack ?? "");
  if (typeof error.retryable === "boolean") {
    result.retryable = error.retryable;
  }
  return result;
}

function stringErrorProperty(error: object, key: "message" | "name" | "stack") {
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function retryableErrorProperty(error: object) {
  const retryable = (error as { retryable?: unknown }).retryable;
  return typeof retryable === "boolean" ? { retryable } : {};
}

class SandboxRedactor {
  readonly #secretValues = new Set<string>();

  addSecret(value: unknown) {
    collectSecretStrings(value, this.#secretValues, 0);
  }

  redactString(value: string) {
    let result = redactSignedUrls(value) ?? value;
    for (const secret of this.#secretValues) {
      result = result.split(secret).join(redactedValue);
    }
    return result;
  }

  redactObject(value: Record<string, unknown>) {
    return this.redactUnknown(value, 0) as Record<string, unknown>;
  }

  redactError(error: Error) {
    const result = new Error(this.redactString(error.message)) as Error & {
      retryable?: boolean;
    };
    result.name = error.name;
    result.stack = this.redactString(error.stack ?? "");
    Object.assign(result, retryableErrorProperty(error));
    return result;
  }

  private redactUnknown(value: unknown, depth: number): unknown {
    if (typeof value === "string") {
      return this.redactString(value).slice(0, 8_192);
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (depth >= 6) {
      return "[TRUNCATED]";
    }
    if (Array.isArray(value)) {
      return value
        .slice(0, 100)
        .map((item) => this.redactUnknown(item, depth + 1));
    }
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, item]) => [key, this.redactUnknown(item, depth + 1)]),
    );
  }
}

class RedactingOutputLogger {
  #pending = "";
  #capturedBytes = 0;
  #truncated = false;

  constructor(
    private readonly redactor: SandboxRedactor,
    private readonly log: (output: string) => void,
  ) {}

  write(chunk: unknown) {
    if (this.#truncated) {
      return;
    }
    const text = String(chunk);
    const remaining = maxCapturedOutputBytes - this.#capturedBytes;
    if (remaining <= 0) {
      this.#truncated = true;
      return;
    }
    const accepted = Buffer.from(text).subarray(0, remaining).toString();
    this.#capturedBytes += Buffer.byteLength(accepted);
    this.#pending += accepted;
    let newline = this.#pending.indexOf("\n");
    while (newline >= 0) {
      this.emit(this.#pending.slice(0, newline));
      this.#pending = this.#pending.slice(newline + 1);
      newline = this.#pending.indexOf("\n");
    }
    if (Buffer.byteLength(text) > remaining) {
      this.#truncated = true;
    }
  }

  flush() {
    if (this.#pending) {
      this.emit(this.#pending);
      this.#pending = "";
    }
    if (this.#truncated) {
      this.log("[TRUNCATED: sandbox output limit reached]");
    }
  }

  private emit(value: string) {
    const output = this.redactor.redactString(value.trim());
    if (output) {
      this.log(output);
    }
  }
}

function collectSecretStrings(
  value: unknown,
  values: Set<string>,
  depth: number,
) {
  if (typeof value === "string") {
    if (value.length > 0) {
      values.add(value);
    }
    return;
  }
  if (!value || typeof value !== "object" || depth >= 6) {
    return;
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    collectSecretStrings(item, values, depth + 1);
  }
}

async function ensureSandboxRunner(
  actionCacheDir = "/tmp/beam-action-cache",
  isolation: "sandboxed-esm" | "trusted-node" = "sandboxed-esm",
) {
  const runnerDir = path.join(actionCacheDir, "sandbox");
  const runnerPath = path.join(
    runnerDir,
    isolation === "trusted-node"
      ? "trusted-node-action-runner.mjs"
      : "action-sandbox-runner.mjs",
  );
  await mkdir(runnerDir, { recursive: true });
  await writeFile(
    runnerPath,
    isolation === "trusted-node"
      ? trustedNodeRunnerSource
      : sandboxRunnerSource,
  );
  return runnerPath;
}

function actionRuntimeExecArgv(
  isolation: "sandboxed-esm" | "trusted-node",
  sandboxPaths: Awaited<ReturnType<typeof sandboxRuntimePaths>>,
  memoryLimitMb: number,
) {
  const normalizedMemoryLimitMb = Math.max(16, Math.floor(memoryLimitMb));
  const permissions = [
    `--max-old-space-size=${normalizedMemoryLimitMb}`,
    "--permission",
    ...sandboxPaths.allowedReadPaths.map(
      (allowedPath) => `--allow-fs-read=${allowedPath}`,
    ),
    ...sandboxPaths.allowedWritePaths.map(
      (allowedPath) => `--allow-fs-write=${allowedPath}`,
    ),
  ];
  if (isolation === "trusted-node") {
    return permissions;
  }
  return [...permissions, "--experimental-vm-modules", "--frozen-intrinsics"];
}

async function sandboxRuntimePaths(
  runnerPath: string,
  entrypointPath: string,
  scratchDir: string | undefined,
) {
  let scratchRunDir: string | null = null;
  if (scratchDir) {
    await mkdir(scratchDir, { recursive: true });
    const realScratchRoot = await realpath(scratchDir);
    scratchRunDir = await mkdtemp(path.join(realScratchRoot, "action-"));
  }
  const [realRunnerPath, realEntrypointPath, realScratchDir] =
    await Promise.all([
      realpath(runnerPath),
      realpath(entrypointPath),
      scratchRunDir ? realpath(scratchRunDir) : Promise.resolve(null),
    ]);
  const allowedReadPaths = [
    ...new Set([
      path.dirname(realRunnerPath),
      path.dirname(realEntrypointPath),
      ...(realScratchDir ? [realScratchDir] : []),
    ]),
  ];
  return {
    runnerPath: realRunnerPath,
    entrypointPath: realEntrypointPath,
    scratchDir: realScratchDir,
    allowedReadPaths,
    allowedWritePaths: realScratchDir ? [realScratchDir] : [],
  };
}

const sandboxRunnerSource = String.raw`
import { Buffer } from "node:buffer";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const entrypointPath = process.argv[2];
const scratchDir = process.argv[3] || "";
const scratchMaxBytes = Number(process.argv[4] || 0);
const rpcCallbacks = new Map();
const tempFiles = new Map();
let rpcId = 0;
let abortController = new AbortController();
let scratchBytesWritten = 0;

process.env = Object.freeze({});
globalThis.fetch = undefined;
globalThis.WebSocket = undefined;
globalThis.EventSource = undefined;

process.once("disconnect", () => process.exit(1));
process.on("message", (message) => {
  if (message?.type === "execute") {
    execute(message.input, message.context).catch((error) => {
      process.send?.({ type: "error", error: serializeError(error) });
    });
    return;
  }
  if (message?.type === "abort") {
    abortController.abort(message.reason || "aborted");
    return;
  }
  if (message?.type === "rpcResult") {
    const callback = rpcCallbacks.get(message.id);
    if (!callback) {
      return;
    }
    rpcCallbacks.delete(message.id);
    if (message.ok) {
      callback.resolve(message.value);
      return;
    }
    callback.reject(deserializeError(message.error));
  }
});

process.send?.({ type: "ready" });

async function execute(input, contextSnapshot) {
  const source = await readFile(entrypointPath, "utf8");
  const context = vm.createContext(
    {
      AbortController,
      Buffer,
      TextDecoder,
      TextEncoder,
      URL,
      URLSearchParams,
      atob,
      btoa,
      clearInterval,
      clearTimeout,
      console: sandboxConsole(),
      crypto: globalThis.crypto,
      queueMicrotask,
      setInterval,
      setTimeout,
      structuredClone,
    },
    { codeGeneration: { strings: false, wasm: false } }
  );
  vm.runInContext(
    'Object.setPrototypeOf(globalThis, null); Object.defineProperty(globalThis, "constructor", { value: undefined, configurable: false, writable: false });',
    context
  );
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: "beam-action://entrypoint",
    importModuleDynamically: async () => {
      throw new Error("Remote action sandbox does not allow dynamic imports.");
    },
  });
  await module.link(async () => {
    throw new Error("Remote action sandbox requires a bundled artifact and does not allow imports.");
  });
  await module.evaluate();
  const executeExport = resolveExecute(module.namespace);
  if (!executeExport) {
    throw new Error("Remote action does not export an execute function.");
  }
  const execution = executeExport(input, actionContext(contextSnapshot));
  process.send?.({ type: "started" });
  const result = await execution;
  process.send?.({ type: "result", result: result ?? {} });
}

function resolveExecute(namespace) {
  if (typeof namespace.execute === "function") {
    return namespace.execute;
  }
  if (typeof namespace.default === "function") {
    return namespace.default;
  }
  if (namespace.default && typeof namespace.default.execute === "function") {
    return namespace.default.execute;
  }
  return null;
}

function actionContext(snapshot) {
  const state = { ...(snapshot.state || {}) };
  return {
    ...snapshot,
    logger: {
      debug: (message, payload) => callHost("logger.debug", [message, payload]),
      info: (message, payload) => callHost("logger.info", [message, payload]),
      warn: (message, payload) => callHost("logger.warn", [message, payload]),
      error: (message, payload) => callHost("logger.error", [message, payload]),
    },
    state: {
      get: () => ({ ...state }),
      set: async (nextState) => {
        await callHost("state.set", [nextState]);
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, nextState);
      },
      patch: async (partialState) => {
        await callHost("state.patch", [partialState]);
        Object.assign(state, partialState);
      },
    },
    storage: {
      getJson: (key) => callHost("storage.getJson", [key]),
      putJson: (key, value) => callHost("storage.putJson", [key, value]),
    },
    artifacts: {
      publish: (artifact) => callHost("artifacts.publish", [artifact]),
      readInput: (port, index) => callHost("artifacts.readInput", [port, index]),
      publishOutput: (port, base64, options) => callHost("artifacts.publishOutput", [port, base64, options]),
    },
    secrets: {
      get: (name) => callHost("secrets.get", [name]),
    },
    beam: {
      objectStorage: {
        download: (endpoint) => callHost("beam.objectStorage.download", [endpoint]),
        upload: (endpoint, content, options) =>
          callHost("beam.objectStorage.upload", [endpoint, content, options]),
        delete: (endpoint) => callHost("beam.objectStorage.delete", [endpoint]),
      },
      fileExports: {
        publishLocalFile: (input) =>
          callHost("beam.fileExports.publishLocalFile", [input]),
      },
      files: {
        createTempFile,
      },
      rooms: {
        publish: () => callHost("beam.rooms.publish", []),
        status: () => callHost("beam.rooms.status", []),
        cancel: () => callHost("beam.rooms.cancel", []),
      },
      transfer: {
        execute: (input) => callHost("beam.transfer.execute", [input]),
      },
    },
    signal: abortController.signal,
  };
}

async function createTempFile(options = {}) {
  if (!scratchDir || !scratchMaxBytes) {
    throw new Error("Remote action disk writes are not enabled for this action.");
  }
  await mkdir(scratchDir, { recursive: true });
  const id = "tmp_" + randomId();
  const name = safeName(options.name || id);
  const tempFilePath = path.join(scratchDir, id + "-" + name);
  const stream = createWriteStream(tempFilePath, { flags: "wx" });
  const file = {
    id,
    tempFilePath,
    name,
    mediaType: options.mediaType,
    ttlSeconds: options.ttlSeconds,
    size: 0,
    closed: false,
    stream,
  };
  tempFiles.set(id, file);
  await onceOpen(stream);
  return {
    id,
    get size() {
      return file.size;
    },
    write: (chunk) => writeTempFile(file, chunk),
    close: () => closeTempFile(file),
    publish: async (publishOptions = {}) => {
      await closeTempFile(file);
      return callHost("beam.files.publishTempFile", [
        {
          tempFilePath,
          name: publishOptions.name || file.name,
          mediaType: publishOptions.mediaType || file.mediaType,
          ttlSeconds: publishOptions.ttlSeconds || file.ttlSeconds,
          size: file.size,
        },
      ]);
    },
  };
}

function writeTempFile(file, chunk) {
  if (file.closed) {
    throw new Error("Cannot write to a closed worker temp file.");
  }
  const buffer = normalizeChunk(chunk);
  if (scratchBytesWritten + buffer.byteLength > scratchMaxBytes) {
    throw new Error(
      "Worker temp file quota exceeded: " +
        (scratchBytesWritten + buffer.byteLength) +
        " > " +
        scratchMaxBytes +
        " bytes."
    );
  }
  file.size += buffer.byteLength;
  scratchBytesWritten += buffer.byteLength;
  return new Promise((resolve, reject) => {
    file.stream.write(buffer, (error) => {
      if (error) {
        file.size -= buffer.byteLength;
        scratchBytesWritten -= buffer.byteLength;
        reject(error);
        return;
      }
      resolve(file.size);
    });
  });
}

function closeTempFile(file) {
  if (file.closed) {
    return Promise.resolve();
  }
  file.closed = true;
  return new Promise((resolve, reject) => {
    file.stream.end((error) => (error ? reject(error) : resolve()));
  });
}

function normalizeChunk(chunk) {
  if (typeof chunk === "string") {
    return Buffer.from(chunk);
  }
  if (chunk instanceof ArrayBuffer) {
    return Buffer.from(chunk);
  }
  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new Error("Worker temp file writes require a string, ArrayBuffer, or typed array chunk.");
}

function safeName(value) {
  const name = String(value || "artifact.bin")
    .replace(/[/\\]/g, "_")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120);
  return name || "artifact.bin";
}

function randomId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID().replace(/-/g, "");
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function onceOpen(stream) {
  return new Promise((resolve, reject) => {
    stream.once("open", resolve);
    stream.once("error", reject);
  });
}

function sandboxConsole() {
  return {
    debug: (...args) => callHost("logger.debug", ["console.debug", { args }]),
    info: (...args) => callHost("logger.info", ["console.info", { args }]),
    log: (...args) => callHost("logger.info", ["console.log", { args }]),
    warn: (...args) => callHost("logger.warn", ["console.warn", { args }]),
    error: (...args) => callHost("logger.error", ["console.error", { args }]),
  };
}

function callHost(method, args) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    rpcCallbacks.set(id, { resolve, reject });
    process.send?.({ type: "rpc", id, method, args });
  });
}

function serializeError(error) {
  return error !== null && typeof error === "object"
    ? {
        name: error.name,
        message: error.message ?? String(error),
        stack: error.stack,
        retryable: error.retryable,
      }
    : { message: String(error) };
}

function deserializeError(error) {
  const result = new Error(error?.message ?? String(error));
  result.name = error?.name ?? "RemoteActionHostError";
  result.stack = error?.stack;
  if (typeof error?.retryable === "boolean") {
    result.retryable = error.retryable;
  }
  return result;
}
`;

const trustedNodeRunnerSource = String.raw`
import { createRequire } from "node:module";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const entrypointPath = process.argv[2];
const allowedNetwork = JSON.parse(process.argv[5] || "[]");
const rpcCallbacks = new Map();
let rpcId = 0;
const abortController = new AbortController();

globalThis.require = createRequire(import.meta.url);
process.env = Object.freeze({});
installNetworkPolicy();

function installNetworkPolicy() {
  const originalHttpRequest = http.request.bind(http);
  const originalHttpsRequest = https.request.bind(https);
  http.request = (...args) => {
    assertNetworkTarget(httpTarget(args, "http:"));
    return originalHttpRequest(...args);
  };
  http.get = (...args) => {
    const request = http.request(...args);
    request.end();
    return request;
  };
  https.request = (...args) => {
    assertNetworkTarget(httpTarget(args, "https:"));
    return originalHttpsRequest(...args);
  };
  https.get = (...args) => {
    const request = https.request(...args);
    request.end();
    return request;
  };

  const originalNetConnect = net.connect.bind(net);
  net.connect = net.createConnection = (...args) => {
    assertNetworkTarget(socketTarget(args));
    return originalNetConnect(...args);
  };
  const originalTlsConnect = tls.connect.bind(tls);
  tls.connect = (...args) => {
    assertNetworkTarget(tlsSocketTarget(args, 443));
    return originalTlsConnect(...args);
  };
  const originalHttp2Connect = http2.connect.bind(http2);
  http2.connect = (authority, ...args) => {
    assertNetworkTarget(urlTarget(authority, "https:"));
    return originalHttp2Connect(authority, ...args);
  };

  dgram.createSocket = () => {
    throw deniedNetwork("UDP sockets");
  };
  guardDnsModule(dns);
  guardDnsModule(dnsPromises);
  if (typeof globalThis.fetch === "function") {
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (resource, options) => {
      assertNetworkTarget(urlTarget(resource, "https:"));
      return originalFetch(resource, options);
    };
  }
  globalThis.WebSocket = class DeniedWebSocket {
    constructor(url) {
      assertNetworkTarget(urlTarget(url, "https:"));
      throw deniedNetwork("WebSocket connections");
    }
  };
  syncBuiltinESMExports();
}

function guardDnsModule(module) {
  for (const method of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "reverse"]) {
    if (typeof module[method] !== "function") continue;
    const original = module[method].bind(module);
    module[method] = (hostname, ...args) => {
      assertNetworkTarget({ hostname: String(hostname), port: null });
      return original(hostname, ...args);
    };
  }
}

function httpTarget(args, fallbackProtocol) {
  const first = args[0];
  const second = args[1];
  if (typeof first === "string" || first instanceof URL) {
    const parsed = new URL(String(first));
    const overrides = second && typeof second === "object" ? second : {};
    return {
      hostname: String(overrides.hostname || overrides.host || parsed.hostname),
      port: Number(overrides.port || parsed.port || defaultPort(parsed.protocol)),
    };
  }
  const options = first && typeof first === "object" ? first : {};
  const protocol = String(options.protocol || fallbackProtocol);
  return {
    hostname: String(options.hostname || options.host || "localhost").replace(/^\[|\]$/g, ""),
    port: Number(options.port || defaultPort(protocol)),
  };
}

function socketTarget(args, fallbackPort = 0) {
  const first = args[0];
  if (first && typeof first === "object") {
    return {
      hostname: String(first.host || first.hostname || "localhost").replace(/^\[|\]$/g, ""),
      port: Number(first.port || fallbackPort),
    };
  }
  return {
    hostname: String(args[1] || "localhost").replace(/^\[|\]$/g, ""),
    port: Number(first || fallbackPort),
  };
}

function tlsSocketTarget(args, fallbackPort = 443) {
  const target = socketTarget(args, fallbackPort);
  const options = args.find(
    (value) => value && typeof value === "object" && !(value instanceof URL),
  );
  const servername = String(options?.servername || "").trim();
  const wrappedSocketPort = Number(options?.socket?.remotePort || 0);
  return {
    hostname:
      servername && options?.rejectUnauthorized !== false
        ? servername
        : target.hostname,
    port: wrappedSocketPort || target.port,
  };
}

function urlTarget(value, fallbackProtocol) {
  const parsed = new URL(String(value), fallbackProtocol + "//localhost");
  return {
    hostname: parsed.hostname,
    port: Number(parsed.port || defaultPort(parsed.protocol)),
  };
}

function defaultPort(protocol) {
  return protocol === "https:" || protocol === "wss:" ? 443 : 80;
}

function assertNetworkTarget(target) {
  const hostname = String(target.hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  const port = target.port == null ? null : Number(target.port);
  const allowed = allowedNetwork.some((rule) => networkRuleMatches(String(rule), hostname, port));
  if (!allowed) {
    throw deniedNetwork(hostname + (port ? ":" + port : ""));
  }
}

function networkRuleMatches(rule, hostname, port) {
  const normalized = rule.trim().toLowerCase();
  if (!normalized || normalized === "*") return false;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(normalized);
  const plain = /^(.*?)(?::(\d+))?$/.exec(normalized);
  const ruleHost = bracketed?.[1] || plain?.[1] || "";
  const rulePort = bracketed?.[2] || plain?.[2];
  const hostMatches = ruleHost.startsWith("*.")
    ? hostname.endsWith(ruleHost.slice(1)) && hostname !== ruleHost.slice(2)
    : hostname === ruleHost;
  return hostMatches && (port === null || !rulePort || Number(rulePort) === port);
}

function deniedNetwork(destination) {
  const error = new Error("Remote trusted Node action network access denied for " + destination + ".");
  error.code = "ERR_ACCESS_DENIED";
  return error;
}

process.once("disconnect", () => process.exit(1));
process.on("message", (message) => {
  if (message?.type === "execute") {
    execute(message.input, message.context).catch((error) => {
      process.send?.({ type: "error", error: serializeError(error) });
    });
    return;
  }
  if (message?.type === "abort") {
    abortController.abort(message.reason || "aborted");
    return;
  }
  if (message?.type === "rpcResult") {
    const callback = rpcCallbacks.get(message.id);
    if (!callback) {
      return;
    }
    rpcCallbacks.delete(message.id);
    if (message.ok) {
      callback.resolve(message.value);
      return;
    }
    callback.reject(deserializeError(message.error));
  }
});

process.send?.({ type: "ready" });

async function execute(input, snapshot) {
  const actionModule = await import(pathToFileURL(entrypointPath).href);
  const executeExport = resolveExecute(actionModule);
  if (!executeExport) {
    throw new Error(
      "Remote trusted Node action does not export an execute function."
    );
  }
  const execution = executeExport(input, actionContext(snapshot));
  process.send?.({ type: "started" });
  const result = await execution;
  process.send?.({ type: "result", result: result ?? {} });
}

function resolveExecute(namespace) {
  if (typeof namespace.execute === "function") {
    return namespace.execute;
  }
  if (typeof namespace.default === "function") {
    return namespace.default;
  }
  if (namespace.default && typeof namespace.default.execute === "function") {
    return namespace.default.execute;
  }
  return null;
}

function actionContext(snapshot) {
  const state = { ...(snapshot.state || {}) };
  return {
    workflowRunId: snapshot.workflowRunId,
    taskId: snapshot.taskId,
    assignmentId: snapshot.assignmentId,
    stepRunId: snapshot.stepRunId,
    stepId: snapshot.stepId,
    attempt: snapshot.attempt,
    room: snapshot.room ?? null,
    logger: {
      debug: (message, payload) => callHost("logger.debug", [message, payload]),
      info: (message, payload) => callHost("logger.info", [message, payload]),
      warn: (message, payload) => callHost("logger.warn", [message, payload]),
      error: (message, payload) => callHost("logger.error", [message, payload]),
    },
    state: {
      get: () => ({ ...state }),
      set: async (nextState) => {
        await callHost("state.set", [nextState]);
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, nextState);
      },
      patch: async (partialState) => {
        await callHost("state.patch", [partialState]);
        Object.assign(state, partialState);
      },
    },
    storage: {
      getJson: (key) => callHost("storage.getJson", [key]),
      putJson: (key, value) => callHost("storage.putJson", [key, value]),
    },
    artifacts: {
      publish: (artifact) => callHost("artifacts.publish", [artifact]),
      readInput: (port, index) => callHost("artifacts.readInput", [port, index]),
      publishOutput: (port, base64, options) => callHost("artifacts.publishOutput", [port, base64, options]),
    },
    secrets: {
      get: (name) => callHost("secrets.get", [name]),
    },
    beam: {
      objectStorage: {
        download: (endpoint) =>
          callHost("beam.objectStorage.download", [endpoint]),
        upload: (endpoint, content, options) =>
          callHost("beam.objectStorage.upload", [endpoint, content, options]),
        delete: (endpoint) => callHost("beam.objectStorage.delete", [endpoint]),
      },
      fileExports: {
        publishLocalFile: (input) =>
          callHost("beam.fileExports.publishLocalFile", [input]),
      },
      rooms: {
        publish: () => callHost("beam.rooms.publish", []),
        status: () => callHost("beam.rooms.status", []),
        cancel: () => callHost("beam.rooms.cancel", []),
      },
      transfer: {
        execute: (input) => callHost("beam.transfer.execute", [input]),
      },
    },
    signal: abortController.signal,
  };
}

function callHost(method, args) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    rpcCallbacks.set(id, { resolve, reject });
    process.send?.({ type: "rpc", id, method, args });
  });
}

function serializeError(error) {
  return error !== null && typeof error === "object"
    ? {
        name: error.name,
        message: error.message ?? String(error),
        stack: error.stack,
        retryable: error.retryable,
      }
    : { message: String(error) };
}

function deserializeError(error) {
  const result = new Error(error?.message ?? String(error));
  result.name = error?.name ?? "RemoteActionHostError";
  result.stack = error?.stack;
  if (typeof error?.retryable === "boolean") {
    result.retryable = error.retryable;
  }
  return result;
}
`;
