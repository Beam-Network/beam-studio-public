import type {
  ActionContext,
  ActionJson,
  ActionResult,
} from "@beam-studio/core";
import {
  resolveActionPackage,
  type ActionStepSnapshot,
} from "./actionLoader.js";
import {
  actionArtifactPortsRequired,
  isRuntimeArtifactMethod,
  sandboxRpcMethodsForAction,
} from "./actionPermissions.js";
import { executeWithArtifactPorts } from "./artifactPorts.js";
import type { ActionRuntimeOptions } from "./types.js";

export type RuntimeInvocation = {
  artifactPortsProtocol?: "action-artifact-ports/v1";
  assignmentId: string;
  taskId?: string;
  workflowRunId: string;
  stepRunId: string;
  stepId: string;
  attempt: number;
  room: { environmentTemplateKey: string; roomId: string };
  step: ActionStepSnapshot;
  config: Record<string, ActionJson>;
  inputs: Record<string, ActionJson>;
  state: Record<string, ActionJson>;
};

export type RuntimeHost = {
  call(method: string, args: unknown[], signal: AbortSignal): Promise<unknown>;
};

/** The parent supplies scoped host capabilities. This process has no Studio store or queue. */
export async function executeRuntimeInvocation(
  invocation: RuntimeInvocation,
  options: ActionRuntimeOptions,
  host: RuntimeHost,
  signal: AbortSignal,
): Promise<ActionResult> {
  const action = await resolveActionPackage(
    invocation.step,
    { ...options, placement: "room-members", requireArtifact: true },
    signal,
  );
  if (
    actionArtifactPortsRequired(action.manifest) &&
    invocation.artifactPortsProtocol !== "action-artifact-ports/v1"
  )
    throw new Error(
      "Artifact port protocol is unavailable for this invocation.",
    );
  if (
    actionArtifactPortsRequired(action.manifest) &&
    (!invocation.taskId || !invocation.assignmentId)
  )
    throw new Error("Artifact port invocation is missing its task identity.");
  const allowed = new Set(sandboxRpcMethodsForAction(action.manifest));
  for (const method of allowed) {
    if (
      !isRuntimeArtifactMethod(method) &&
      !options.allowedHostOperations?.includes(method)
    )
      throw new Error(`Required host operation is unavailable: ${method}`);
  }
  const call = async (method: string, args: unknown[]) => {
    const cleanup =
      method === "beam.rooms.cancel" || method.startsWith("logger.");
    if (!cleanup) signal.throwIfAborted();
    if (!allowed.has(method))
      throw new Error(`Action host operation is not declared: ${method}`);
    return host.call(
      method,
      args,
      cleanup && signal.aborted ? AbortSignal.timeout(25_000) : signal,
    );
  };
  let state = { ...invocation.state };
  const log =
    (level: string) =>
    async (message: string, data?: Record<string, ActionJson>) => {
      await call(`logger.${level}`, [message, data]);
    };
  const context: ActionContext = {
    taskId: invocation.taskId,
    assignmentId: invocation.assignmentId,
    workflowRunId: invocation.workflowRunId,
    stepRunId: invocation.stepRunId,
    stepId: invocation.stepId,
    attempt: invocation.attempt,
    room: invocation.room,
    logger: {
      debug: log("debug"),
      info: log("info"),
      warn: log("warn"),
      error: log("error"),
    },
    state: {
      get: () => state,
      set: async (next) => {
        await call("state.set", [next]);
        state = { ...next };
      },
      patch: async (next) => {
        await call("state.patch", [next]);
        state = { ...state, ...next };
      },
    },
    storage: {
      getJson: async (key) =>
        (await call("storage.getJson", [key])) as ActionJson | undefined,
      putJson: async (key, value) => {
        await call("storage.putJson", [key, value]);
      },
    },
    artifacts: {
      publish: async (artifact) =>
        (await call("artifacts.publish", [artifact])) as typeof artifact,
    },
    secrets: {
      get: async (name) => (await call("secrets.get", [name])) as string | null,
    },
    beam: {},
    signal,
  };
  // Only fixed manifest-derived methods are installed; caller data cannot supply a method path.
  for (const method of allowed) {
    if (!method.startsWith("beam.")) continue;
    const [, category, operation] = method.split(".");
    if (!category || !operation) throw new Error("Invalid host operation");
    const namespace = (context.beam[category] ??= {}) as Record<
      string,
      unknown
    >;
    namespace[operation] = (...args: unknown[]) => call(method, args);
  }
  return executeWithArtifactPorts(
    action,
    { config: invocation.config, inputs: invocation.inputs },
    context,
  );
}
