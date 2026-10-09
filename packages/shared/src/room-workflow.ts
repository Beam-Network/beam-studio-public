import { z } from "zod";
import {
  beamEnvironmentTemplateKeySchema,
  roomCoordinatorUrl,
} from "./beam-environment-templates.js";

export const roomTransferActionVersion = "2.1.2";

export const roomTransferSourceSchema = z
  .object({
    memberId: z.string().regex(/^btr_member_[a-z2-7]{26}$/),
    locator: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("agent_path"),
          path: z.string().trim().min(1).max(4096),
        })
        .strict(),
      z
        .object({
          type: z.literal("bucket_object"),
          objectKey: z.string().min(1).max(4096),
        })
        .strict(),
    ]),
  })
  .strict();

const roomWorkflowConfigObject = z
  .object({
    environmentTemplateKey: beamEnvironmentTemplateKeySchema,
    source: roomTransferSourceSchema,
    roomId: z.string().regex(/^btr_room_[a-z2-7]{26}$/),
    channelId: z.string().regex(/^btr_channel_[a-z2-7]{26}$/),
    targetMemberIds: z
      .array(z.string().regex(/^btr_member_[a-z2-7]{26}$/))
      .default([]),
    ttlSeconds: z.number().int().min(30).max(86400).default(600),
    allowPartial: z.boolean().default(false),
  })
  .strict();

export const roomWorkflowDefinitionConfigSchema = roomWorkflowConfigObject
  .partial({ roomId: true, environmentTemplateKey: true })
  .refine(
    (value) =>
      new Set(value.targetMemberIds).size === value.targetMemberIds.length,
    "Recipient IDs must be unique.",
  );
export const roomWorkflowConfigSchema = roomWorkflowConfigObject.refine(
  (value) =>
    new Set(value.targetMemberIds).size === value.targetMemberIds.length,
  "Recipient IDs must be unique.",
);

export { roomCoordinatorUrl };
