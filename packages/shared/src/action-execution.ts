import { z } from "zod";
import { workflowRoomContextSchema } from "./workflow-room-context.js";

const id = z.string().trim().min(1).max(160);
export const actionExecutionProtocol = "action-execution/v1" as const;
export const actionArtifactPortsProtocol = "action-artifact-ports/v1" as const;

export const actionExecutionTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("studio"),
      runnerIds: z.array(id).min(1).max(128).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("room-member"),
      memberIds: z.array(id).min(1).max(128),
      /** Object channel for routed V3 artifact output and input copies. */
      artifactChannelId: id.optional(),
      channelId: id,
      requesterMemberId: id,
      room: workflowRoomContextSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("external-worker"),
      workerIds: z.array(id).min(1).max(128).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("remote-transport"),
      executionLocationId: id.optional(),
    })
    .strict(),
]);
export type ActionExecutionTarget = z.infer<typeof actionExecutionTargetSchema>;

/** Runtime discovery is independent of room/storage membership capabilities. */
export const actionExecutionCapabilitiesSchema = z
  .object({
    protocol: z.literal(actionExecutionProtocol),
    artifactPorts: z.literal(actionArtifactPortsProtocol).optional(),
    /** Present only after the installed runtime verifies kernel resource enforcement. */
    manifestApiVersions: z.array(z.literal("workflow-actions/v2")).max(1).optional(),
    processOwnership: z.literal("action-process-ownership/v1"),
    runtimes: z
      .array(
        z
          .object({
            name: z.literal("node"),
            version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].*)?$/),
          })
          .strict(),
      )
      .length(1),
    isolations: z
      .array(z.enum(["sandboxed-esm", "trusted-node"]))
      .min(1)
      .max(2),
    hostOperations: z.array(id).max(64),
    permissions: z.array(id).max(128),
    allowedActions: z.array(id).min(1).max(256),
    capacity: z.number().int().min(1).max(64),
    maxLeaseSeconds: z.number().int().min(5).max(120),
    maxArtifactBytes: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  })
  .strict();
export type ActionExecutionCapabilities = z.infer<
  typeof actionExecutionCapabilitiesSchema
>;

export function actionTargetPlacement(target: ActionExecutionTarget) {
  switch (target.kind) {
    case "studio":
      return "local-workers" as const;
    case "room-member":
      return "room-members" as const;
    case "external-worker":
      return "external-workers" as const;
    case "remote-transport":
      return target.executionLocationId
        ? ("custom" as const)
        : ("beamcore-public" as const);
  }
}

const jsonObject = z.record(z.string(), z.unknown());
const artifactHash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const artifactTime = z.string().datetime({ offset: true });

/** Evidence is attached to one immutable task attempt, never inferred from a URI. */
export const roomArtifactManifestSchema = z
  .object({
    version: z.literal("room-artifact-manifest/v1"),
    publicationId: id,
    artifacts: z
      .array(
        z
          .object({
            artifactId: id,
            port: id,
            index: z.number().int().nonnegative(),
            sha256: artifactHash,
            sizeBytes: z.number().int().nonnegative(),
            mediaType: z.string().min(1),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    locations: z
      .array(
        z
          .object({
            artifactId: id,
            kind: z.enum(["member", "storage"]),
            locator: id,
            memberId: id.optional(),
            roomId: id,
            channelId: id,
            sourceMemberId: id,
            verifiedAt: artifactTime,
            verificationBasis: z.enum([
              "local_hash",
              "recipient_final_receipt",
              "provider_finalization",
            ]),
            durableUntil: artifactTime.nullable(),
            retentionObligationId: id.optional(),
          })
          .strict(),
      )
      .max(64),
    transfers: z
      .array(
        z
          .object({
            artifactId: id,
            destinationMemberId: id,
            publicationId: id,
            transferId: id,
            roomId: id,
            channelId: id,
            sourceMemberId: id,
            status: z.enum(["completed", "partial", "failed"]),
            fullDeliveryVerified: z.boolean(),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
export type RoomArtifactManifest = z.infer<typeof roomArtifactManifestSchema>;

/** Produced from the frozen route/retention plan, not from an executor result. */
export const artifactPublicationPlanSchema = z.record(
  id,
  z
    .object({
      roomId: id,
      channelId: id,
      sourceMemberId: id,
      targetMemberIds: z.array(id).max(128),
      retentionObligationId: id,
      requiredUntil: artifactTime,
      availability: z.enum(["durable", "temporary"]).default("durable"),
    })
    .strict(),
);
export type ArtifactPublicationPlan = z.infer<
  typeof artifactPublicationPlanSchema
>;
export const actionResultSchema = z
  .object({
    outputs: jsonObject.optional(),
    state: jsonObject.optional(),
    metadata: jsonObject.optional(),
    externalRef: z.string().nullable().optional(),
    artifacts: z
      .array(
        z
          .object({
            id: z.string().optional(),
            type: z.string(),
            name: z.string(),
            uri: z.string(),
            mediaType: z.string().optional(),
            metadata: jsonObject.optional(),
          })
          .strict(),
      )
      .optional(),
    artifactManifest: roomArtifactManifestSchema.optional(),
  })
  .strict();
