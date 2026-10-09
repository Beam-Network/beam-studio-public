import { actionResultSchema } from "@beam-studio/shared";

/** A terminal command is not by itself evidence of executor/resource cleanup. */
export function assignmentOutcome(
  command: Record<string, any>,
  assignment: Record<string, any>,
) {
  if (command.state !== "completed") return null;
  if (
    Number(command.payload_json?.authorityGeneration ?? 1) !==
    Number(assignment.authority_generation ?? 1)
  )
    return null;
  const payload = command.result_json;
  if (
    !payload ||
    payload.assignmentId !== assignment.id ||
    payload.attempt !== assignment.attempt ||
    payload.cleanupConfirmed !== true ||
    payload.artifactStorageCleanupConfirmed === false ||
    (payload.transfers !== undefined &&
      (!Array.isArray(payload.transfers) ||
        payload.transfers.some((transfer: Record<string, unknown>) =>
          transfer?.transport === "hybrid"
            ? transfer.cleanupConfirmed !== true
            : !["completed", "failed", "cancelled", "expired"].includes(
                String(transfer?.state ?? ""),
              ),
        )))
  )
    return null;
  if (
    command.operation === "action.invoke" ||
    command.operation === "action.publish"
  )
    return {
      state: "completed",
      result: actionResultSchema.parse(payload.result),
      error: null,
    };
  if (
    !["action.cancel", "action.reconcile"].includes(command.operation) ||
    !["completed", "failed", "cancelled"].includes(payload.state)
  )
    return null;
  return {
    state: String(payload.state),
    result:
      payload.state === "completed"
        ? actionResultSchema.parse(payload.result?.result)
        : null,
    error: payload.error ?? null,
  };
}
