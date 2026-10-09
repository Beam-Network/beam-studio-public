import { z } from "zod";

/** Application data is encrypted by the two-member MLS control channel.
 * `recipientMemberId` always names the command executor, including in replies;
 * the reply's private transport recipient is `controllerMemberId`. The separate
 * requestReplyChannelId scopes the action grant, not the encrypted transport. */
export const roomActionContentType =
  "application/vnd.beam.room-action+json; version=1" as const;
export const roomActionProtocol = "room-action/v1" as const;
/** BTR bounds MLS ciphertext, so allow headroom above the 160 KiB JSON body. */
export const roomActionMinimumChannelPayloadBytes = 256 * 1024;

const id = z.string().trim().min(1).max(160);
const identity = {
  version: z.literal(roomActionProtocol),
  commandId: id,
  controllerMemberId: id,
  recipientMemberId: id,
  roomId: id,
  controlChannelId: id,
  requestReplyChannelId: id,
  workflowRunId: id,
  stepRunId: id,
  taskId: id,
  assignmentId: id,
  attempt: z.number().int().positive(),
  authorityGeneration: z.number().int().positive(),
  deadline: z.string().datetime({ offset: true }),
};

export const roomActionOperationSchema = z.enum([
  "action.invoke",
  "action.renew",
  "action.cancel",
  "action.reconcile",
  "action.publish",
  "action.artifact.release",
]);

export const roomActionCommandSchema = z
  .object({
    ...identity,
    kind: z.literal("command"),
    operation: roomActionOperationSchema,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export const roomActionReplySchema = z
  .object({
    ...identity,
    kind: z.literal("reply"),
    replyId: id,
    replyDeadline: z.string().datetime({ offset: true }),
    operation: roomActionOperationSchema,
    state: z.enum(["accepted", "running", "completed", "failed", "cancelled"]),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z
      .object({
        code: id,
        message: z.string().min(1).max(2_000),
        retryable: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type RoomActionCommand = z.infer<typeof roomActionCommandSchema>;
export type RoomActionReply = z.infer<typeof roomActionReplySchema>;

export class RoomActionEnvelopeError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Rejects a delivered reply before it can modify an assignment or task. */
export function assertRoomActionReply(
  reply: RoomActionReply,
  command: RoomActionCommand,
  delivery: {
    publisherMemberId: string;
    roomId: string;
    channelId: string;
    currentAuthorityGeneration: number;
    now?: number;
  },
) {
  const same = [
    "version",
    "commandId",
    "controllerMemberId",
    "recipientMemberId",
    "roomId",
    "controlChannelId",
    "requestReplyChannelId",
    "workflowRunId",
    "stepRunId",
    "taskId",
    "assignmentId",
    "attempt",
    "authorityGeneration",
    "deadline",
    "operation",
  ] as const;
  if (same.some((key) => reply[key] !== command[key]))
    throw new RoomActionEnvelopeError("room_action_identity_mismatch");
  if (
    delivery.publisherMemberId !== command.recipientMemberId ||
    delivery.roomId !== command.roomId ||
    delivery.channelId !== command.controlChannelId
  )
    throw new RoomActionEnvelopeError("room_action_sender_mismatch");
  if (command.authorityGeneration !== delivery.currentAuthorityGeneration)
    throw new RoomActionEnvelopeError("room_action_authority_fenced");
  const now = delivery.now ?? Date.now();
  const replyDeadline = Date.parse(reply.replyDeadline);
  if (
    !Number.isFinite(replyDeadline) || replyDeadline <= now ||
    replyDeadline > now + 120_000
  )
    throw new RoomActionEnvelopeError("room_action_reply_deadline_invalid");
  if (reply.state === "completed" && !reply.result)
    throw new RoomActionEnvelopeError("room_action_result_missing");
  if ((reply.state === "failed" || reply.state === "cancelled") && !reply.error)
    throw new RoomActionEnvelopeError("room_action_error_missing");
}
