import { z } from "zod";
import { beamEnvironmentTemplateKeySchema } from "./beam-environment-templates.js";

export const roomStorageDestinationLayoutSchema = z.enum([
  "isolated",
  "preserve_path",
  "flat_name",
]);
export const roomStorageCollisionPolicySchema = z.enum([
  "fail_if_exists",
  "overwrite",
]);

export const roomStorageBindingInputSchema = z
  .object({
    environmentTemplateKey: beamEnvironmentTemplateKeySchema,
    roomId: z.string().regex(/^btr_room_[a-z2-7]{26}$/),
    credentialId: z.string().trim().min(1).max(160),
    bucket: z.string().trim().min(1).max(1024),
    displayName: z.string().trim().min(1).max(128),
    objectChannelIds: z
      .array(z.string().regex(/^btr_channel_[a-z2-7]{26}$/))
      .min(1),
    destinationPrefix: z.string().max(4096).default(""),
    destinationLayout: roomStorageDestinationLayoutSchema.default("isolated"),
    collisionPolicy: roomStorageCollisionPolicySchema.default("fail_if_exists"),
    sourceDelegateMemberIds: z
      .array(z.string().regex(/^btr_member_[a-z2-7]{26}$/))
      .default([]),
    sourceDelegateRoleIds: z
      .array(z.string().regex(/^btr_role_[a-z2-7]{26}$/))
      .default([]),
    roleIds: z.array(z.string().regex(/^btr_role_[a-z2-7]{26}$/)).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [field, values] of [
      ["objectChannelIds", value.objectChannelIds],
      ["sourceDelegateMemberIds", value.sourceDelegateMemberIds],
      ["sourceDelegateRoleIds", value.sourceDelegateRoleIds],
      ["roleIds", value.roleIds],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} must contain unique values.`,
        });
      }
    }
  });

export type RoomStorageBindingInput = z.infer<
  typeof roomStorageBindingInputSchema
>;

export const roomStorageBindingUpdateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(128),
    destinationPrefix: z.string().max(4096).default(""),
    destinationLayout: roomStorageDestinationLayoutSchema.default("isolated"),
    collisionPolicy: roomStorageCollisionPolicySchema.default("fail_if_exists"),
    sourceDelegateMemberIds: z
      .array(z.string().regex(/^btr_member_[a-z2-7]{26}$/))
      .default([]),
    sourceDelegateRoleIds: z
      .array(z.string().regex(/^btr_role_[a-z2-7]{26}$/))
      .default([]),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [field, values] of [
      ["sourceDelegateMemberIds", value.sourceDelegateMemberIds],
      ["sourceDelegateRoleIds", value.sourceDelegateRoleIds],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} must contain unique values.`,
        });
      }
    }
  });

export type RoomStorageBindingUpdate = z.infer<
  typeof roomStorageBindingUpdateSchema
>;

export type RoomStorageBinding = RoomStorageBindingInput & {
  id: string;
  organizationId: string;
  providerProfileId: string;
  resourceId: string;
  coordinatorMemberId: string;
  availability: "available" | "unavailable" | "revoked";
  createdAt: string;
  updatedAt: string;
};
