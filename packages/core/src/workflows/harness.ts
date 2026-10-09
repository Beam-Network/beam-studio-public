import type {
  ActionArtifact,
  ActionContext,
  ActionExecute,
  ActionJson,
  ActionLogger,
  ActionResult,
} from "./actions.js";

export type ActionHarnessOptions = {
  workflowRunId?: string;
  stepRunId?: string;
  stepId?: string;
  secrets?: Record<string, string>;
  beam?: Record<string, unknown>;
  logger?: ActionLogger;
  /**
   * Step state as it would be on a retry. The runtime contract requires
   * long-running actions to resume from persisted state, so testing that path
   * means starting with state already present.
   */
  initialState?: Record<string, ActionJson>;
};

export type ActionHarnessResult = ActionResult & {
  artifacts: ActionArtifact[];
  state: Record<string, ActionJson>;
  storage: Map<string, ActionJson>;
};

export async function runActionHarness(
  execute: ActionExecute,
  input: {
    config?: Record<string, ActionJson>;
    inputs?: Record<string, ActionJson>;
  },
  options: ActionHarnessOptions = {},
): Promise<ActionHarnessResult> {
  const state: Record<string, ActionJson> = { ...(options.initialState ?? {}) };
  const storage = new Map<string, ActionJson>();
  const artifacts: ActionArtifact[] = [];
  const result = await execute(
    {
      config: input.config ?? {},
      inputs: input.inputs ?? {},
    },
    {
      workflowRunId: options.workflowRunId ?? "wfr_harness",
      stepRunId: options.stepRunId ?? "wsr_harness",
      stepId: options.stepId ?? "step_harness",
      attempt: 1,
      logger: options.logger ?? noopLogger,
      state: {
        get: () => ({ ...state }),
        set: (nextState) => {
          Object.keys(state).forEach((key) => delete state[key]);
          Object.assign(state, nextState);
        },
        patch: (partialState) => {
          Object.assign(state, partialState);
        },
      },
      storage: {
        getJson: async (key) => storage.get(key),
        putJson: async (key, value) => {
          storage.set(key, value);
        },
      },
      artifacts: {
        publish: async (artifact) => {
          artifacts.push(artifact);
          return artifact;
        },
      },
      secrets: {
        get: async (name) => options.secrets?.[name] ?? null,
      },
      beam: options.beam ?? {},
      signal: new AbortController().signal,
    } satisfies ActionContext,
  );

  const returnedArtifacts = result.artifacts ?? artifacts;
  return {
    ...result,
    artifacts: returnedArtifacts,
    state: { ...state, ...(result.state ?? {}) },
    storage,
  };
}

const noopLogger: ActionLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
