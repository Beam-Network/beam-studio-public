import { createInterface } from "node:readline";
import {
  executeRuntimeInvocation,
  type RuntimeInvocation,
} from "./process-host.js";
import type { ActionRuntimeOptions } from "./types.js";
import {
  probeProcessOwnership,
  prepareProcessOwnership,
  reconcileProcessOwnership,
  registerProcessController,
  recordSandboxStopped,
  ownershipProtocol,
} from "./process-ownership.js";
import { probeActionResourceBudgets } from "./resource-budgets.js";

const protocol = "action-execution/v1";
if (Number(process.versions.node.split(".")[0]) < 22)
  throw new Error("Action runtime requires Node.js 22 or later.");
if (process.argv.includes("--process-ownership")) {
  let source = "";
  for await (const chunk of process.stdin) {
    source += String(chunk);
    if (Buffer.byteLength(source) > 16 * 1024)
      throw new Error("Ownership request exceeds its size limit");
  }
  const request = JSON.parse(source);
  if (request.operation === "prepare") {
    if (
      typeof request.directory !== "string" ||
      typeof request.identity !== "string" ||
      !Number.isSafeInteger(request.ownerPid)
    )
      throw new Error("Invalid ownership preparation");
    const ownership = await prepareProcessOwnership(
      request.directory,
      request.identity,
      request.ownerPid,
    );
    process.stdout.write(
      JSON.stringify({ protocol: ownershipProtocol, ownership }) + "\n",
    );
  } else {
    if (
      !request.ownership ||
      typeof request.ownership.path !== "string" ||
      typeof request.ownership.nonce !== "string"
    )
      throw new Error("Invalid process ownership reference");
    if (request.operation === "stopped") {
      await recordSandboxStopped(request.ownership);
      process.stdout.write(
        JSON.stringify({
          protocol: ownershipProtocol,
          cleanupConfirmed: true,
        }) + "\n",
      );
    } else if (request.operation === "reconcile") {
      process.stdout.write(
        JSON.stringify(await reconcileProcessOwnership(request.ownership)) +
          "\n",
      );
    } else throw new Error("Unsupported ownership operation");
  }
} else if (process.argv.includes("--capabilities")) {
  await probeProcessOwnership();
  const v2BudgetsAvailable = await probeActionResourceBudgets();
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22)
    throw new Error("Action runtime requires Node.js 22 or later.");
  process.stdout.write(
    JSON.stringify({
      protocol,
      artifactPorts: "action-artifact-ports/v1",
      ...(v2BudgetsAvailable
        ? { manifestApiVersions: ["workflow-actions/v2"] }
        : {}),
      processOwnership: ownershipProtocol,
      runtimes: [{ name: "node", version: process.versions.node }],
      isolations: ["sandboxed-esm", "trusted-node"],
    }) + "\n",
  );
} else {
  const controller = new AbortController();
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  let nextId = 0,
    started = false,
    finished = false;
  const emit = (message: unknown) =>
    process.stdout.write(JSON.stringify(message) + "\n");
  const fail = (error: unknown) => {
    if (finished) return;
    finished = true;
    const value =
      error instanceof Error ? error : new Error("Action execution failed");
    emit({
      type: "error",
      error: {
        message: value.message,
        retryable: "retryable" in value ? value.retryable : false,
      },
    });
  };
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const abort = (reason: string) => {
    controller.abort(new Error(reason));
    for (const request of pending.values()) request.reject(new Error(reason));
    pending.clear();
  };
  input.on("close", () => {
    process.stdin.pause();
    process.stdin.unref?.();
    if (!finished) abort("Action control connection closed");
  });
  process.once("SIGTERM", () => abort("Action runtime stopped"));
  input.on("line", (line) => {
    if (Buffer.byteLength(line) > 256 * 1024) {
      abort("Runtime command exceeds its size limit");
      fail(new Error("Runtime command exceeds its size limit"));
      input.close();
      return;
    }
    try {
      const message = JSON.parse(line) as Record<string, any>;
      if (message.type === "abort") {
        abort(String(message.reason ?? "Action cancelled"));
        return;
      }
      if (message.type === "rpcResult") {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.ok) request.resolve(message.value);
        else
          request.reject(
            Object.assign(
              new Error(
                message.error?.message ?? "Scoped host operation failed",
              ),
              { retryable: message.error?.retryable === true },
            ),
          );
        return;
      }
      if (message.type !== "invoke" || started || message.protocol !== protocol)
        throw new Error("Invalid runtime invocation");
      started = true;
      const invocation = message.invocation as RuntimeInvocation;
      if (
        !invocation ||
        !invocation.step ||
        !invocation.room ||
        typeof invocation.assignmentId !== "string" ||
        !Number.isSafeInteger(invocation.attempt) ||
        invocation.attempt < 1
      )
        throw new Error("Incomplete runtime invocation");
      const policy = message.policy as Omit<ActionRuntimeOptions, "logger"> & {
        allowedActions: string[];
        isolations: string[];
      };
      if (
        !policy?.processOwnership ||
        typeof policy.processOwnership.path !== "string" ||
        typeof policy.processOwnership.nonce !== "string"
      )
        throw new Error("Durable process ownership is required");
      if (
        !policy ||
        !Array.isArray(policy.allowedActions) ||
        !policy.allowedActions.includes(invocation.step?.actionPackage)
      )
        throw new Error("Action is not locally allowlisted");
      if (
        !policy.isolations?.includes(
          invocation.step.manifestSnapshot?.execution?.isolation ??
            "sandboxed-esm",
        )
      )
        throw new Error("Action isolation is not locally allowed");
      const log = (level: string) => (data: unknown, message: string) => {
        emit({ type: "log", level, message, data });
      };
      const logger: ActionRuntimeOptions["logger"] = {
        debug: log("debug"),
        info: log("info"),
        warn: log("warn"),
        error: log("error"),
      };
      void registerProcessController(policy.processOwnership)
        .then(() =>
          executeRuntimeInvocation(
            invocation,
            { ...policy, logger },
            {
              call: (method, args, signal) =>
                new Promise((resolve, reject) => {
                  if (signal.aborted) {
                    reject(signal.reason);
                    return;
                  }
                  const id = ++nextId;
                  pending.set(id, { resolve, reject });
                  emit({ type: "rpc", id, method, args });
                }),
            },
            controller.signal,
          ),
        )
        .finally(() => recordSandboxStopped(policy.processOwnership!))
        .then(
          (result) => {
            if (!finished) {
              finished = true;
              emit({ type: "result", result });
              input.close();
            }
          },
          (error) => {
            fail(error);
            input.close();
          },
        );
    } catch (error) {
      abort("Invalid runtime command");
      fail(error);
      input.close();
    }
  });
}
