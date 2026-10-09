export type SaveResponseDecision = {
  /** False when an older, overtaken response must be ignored entirely. */
  apply: boolean;
  /** True when the canvas moved on and its edits must survive the response. */
  preserveLocalEdits: boolean;
};

/**
 * Decides what a completed save may do to the editor.
 *
 * The graph stays editable while a save is in flight, so the response
 * describes the graph that was sent, not the one on screen. Two independent
 * hazards follow: edits made during the request would be overwritten, and
 * overlapping saves can settle out of order so an older response would undo a
 * newer one.
 */
export function reconcileSaveResponse(input: {
  requestId: number;
  appliedRequestId: number;
  requestSignature: string;
  currentSignature: string;
}): SaveResponseDecision {
  if (input.requestId < input.appliedRequestId) {
    return { apply: false, preserveLocalEdits: false };
  }
  return {
    apply: true,
    preserveLocalEdits: input.currentSignature !== input.requestSignature,
  };
}

/** Identifies one save request so its response can be placed in order. */
export type SaveRequestContext = {
  requestId: number;
  requestSignature: string;
  positions?: { nodeId: string; x: number; y: number }[];
};
