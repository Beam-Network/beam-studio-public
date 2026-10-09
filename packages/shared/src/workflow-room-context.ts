import { z } from "zod";
import { beamEnvironmentTemplateKeySchema } from "./beam-environment-templates.js";

export const workflowRoomContextSchema = z
  .object({
    environmentTemplateKey: beamEnvironmentTemplateKeySchema,
    roomId: z.string().regex(/^btr_room_[a-z2-7]{26}$/),
  })
  .strict();
export type WorkflowRoomContext = z.infer<typeof workflowRoomContextSchema>;

export class WorkflowRoomContextError extends Error {
  readonly code = "workflow_room_context_invalid";
  readonly statusCode = 400;
  readonly retryable = false;
}

export function workflowRoomContext(
  value: unknown,
): WorkflowRoomContext | null {
  if (value == null) return null;
  const parsed = workflowRoomContextSchema.safeParse(value);
  if (!parsed.success)
    throw new WorkflowRoomContextError(
      "Room context requires a Beam environment template and room ID.",
    );
  return parsed.data;
}

/** A room belongs to a subtree. Action-local selection never changes the parent context. */
export function resolveWorkflowRoomContext(
  inherited: unknown,
  declared: unknown,
  label = "Workflow",
): WorkflowRoomContext | null {
  const parent = workflowRoomContext(inherited);
  const own = workflowRoomContext(declared);
  if (
    parent &&
    own &&
    (parent.environmentTemplateKey !== own.environmentTemplateKey ||
      parent.roomId !== own.roomId)
  )
    throw new WorkflowRoomContextError(
      `${label} conflicts with the inherited room (${parent.environmentTemplateKey}/${parent.roomId}).`,
    );
  return parent ?? own;
}

export function resolveActionRoomContext<
  T extends Record<string, unknown>,
>(input: {
  workflowRoom: unknown;
  actionRoom?: unknown;
  actionPackage: string;
  config: T;
}): { room: WorkflowRoomContext | null; config: T } {
  const inherited = resolveWorkflowRoomContext(
    input.workflowRoom,
    input.actionRoom,
    "Action execution target",
  );
  if (input.actionPackage !== "@beam/room-transfer")
    return { room: inherited, config: input.config };
  const { roomId, environmentTemplateKey } = input.config;
  if (inherited) {
    if (
      (roomId != null && roomId !== "" && roomId !== inherited.roomId) ||
      (environmentTemplateKey != null &&
        environmentTemplateKey !== "" &&
        environmentTemplateKey !== inherited.environmentTemplateKey)
    )
      throw new WorkflowRoomContextError(
        "Action @beam/room-transfer conflicts with the inherited room.",
      );
    return { room: inherited, config: { ...input.config, ...inherited } };
  }
  if (
    roomId == null ||
    roomId === "" ||
    environmentTemplateKey == null ||
    environmentTemplateKey === ""
  ) {
    const partial = workflowRoomContextSchema.partial().safeParse({
      ...(roomId != null && roomId !== "" ? { roomId } : {}),
      ...(environmentTemplateKey != null && environmentTemplateKey !== ""
        ? { environmentTemplateKey }
        : {}),
    });
    if (!partial.success)
      throw new WorkflowRoomContextError("Invalid action room association.");
    return { room: null, config: input.config };
  }
  return {
    room: workflowRoomContext({ roomId, environmentTemplateKey }),
    config: input.config,
  };
}
