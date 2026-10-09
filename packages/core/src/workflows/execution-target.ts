import {
  actionExecutionTargetSchema,
  actionTargetPlacement,
  type ActionExecutionTarget,
} from "@beam-studio/shared";
import {
  ActionPlacementError,
  supportedPlacements,
  type ActionManifest,
} from "./actions.js";

export {
  actionExecutionTargetSchema,
  actionTargetPlacement,
  type ActionExecutionTarget,
};

export function assertActionExecutionTarget(
  manifest: ActionManifest,
  target: ActionExecutionTarget,
) {
  if (target.kind === "external-worker")
    throw new ActionPlacementError(
      "External-worker onboarding and activation are not available.",
    );
  const placement = actionTargetPlacement(target);
  if (!supportedPlacements(manifest).includes(placement))
    throw new ActionPlacementError(
      `Action "${manifest.name}" does not support the ${target.kind} execution target.`,
    );
}
