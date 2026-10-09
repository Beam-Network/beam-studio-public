import type { RunBundle } from "./run-detail-data";

export type RunEvidence = {
  steps: Array<{
    id: string;
    attempt: number;
    publicationId: string;
    execution: unknown;
    executionInspection: unknown;
  }>;
};

/** Only diagnostics may change: outputs, lifecycle and invocation identity stay durable. */
export function withRunEvidence(
  bundle: RunBundle,
  evidence?: RunEvidence,
  failed = false,
): RunBundle {
  return {
    ...bundle,
    stepRuns: bundle.stepRuns?.map((step) => {
      if (step.actionPackageName !== "@beam/room-transfer") return step;
      const state =
        step.state && typeof step.state === "object"
          ? (step.state as Record<string, unknown>)
          : {};
      if (!state.publicationId) return step;
      const current =
        !failed &&
        evidence?.steps.find(
          (candidate) =>
            candidate.id === step.id &&
            candidate.attempt === step.attempt &&
            candidate.publicationId === state.publicationId,
        );
      return {
        ...step,
        state: {
          ...state,
          execution: current ? current.execution : null,
          executionInspection: current
            ? current.executionInspection
            : { status: failed ? "unavailable" : "loading" },
        },
      };
    }),
  };
}
