import { z } from "zod";
import { actionExecutionCapabilitiesSchema } from "./action-execution.js";

export const agentControlProtocolVersion = 1;
export const agentControlMaxMessageBytes = 256 * 1024;

export const agentControlCapabilities = [
  "endpoints",
  "operations",
  "rooms",
  "logs",
  "metrics",
  "room-messages",
  "room-transfers",
  "room-storage-publish",
  "action-execution/v1",
] as const;

export const agentControlOperations = [
  "action.invoke",
  "action.publish",
  "action.artifact.release",
  "action.renew",
  "action.cancel",
  "action.reconcile",
  "agent.status.get",
  "endpoint.list",
  "endpoint.get",
  "tunnel.create",
  "destination.create",
  "room.storage.source.inspect",
  "room.storage.source.register",
  "endpoint.close",
  "operation.list",
  "operation.get",
  "operation.start",
  "operation.cancel",
  "room.list",
  "room.get",
  // room.create is absent on purpose: starting a room is billable and the payer
  // is a Beam API key Studio holds. Rooms are created on the organization's
  // delegated path so no key secret reaches an agent.
  "room.join",
  "room.leave",
  "room.close",
  "room.refresh",
  "room.invitation.create",
  "room.invitations.list",
  "room.invitation.get",
  "room.invitation.revoke",
  "room.memberships.list",
  "room.membership.remove",
  "room.roles.list",
  "room.role.create",
  "room.role.assign",
  "room.role.revoke",
  "room.role.delete",
  "room.channels.list",
  "room.channel.create",
  "room.channel.activate",
  "room.channel.update",
  "room.channel.close",
  "room.grants.list",
  "room.grant.put",
  "room.grant.revoke",
  "room.channel.object.publish",
  "room.channel.object.list",
  "room.channel.object.status",
  "room.channel.object.cancel",
  "logs.snapshot",
  "logs.subscribe",
  "logs.unsubscribe",
  "metrics.snapshot",
] as const;

export type AgentControlOperation = (typeof agentControlOperations)[number];

export const agentControlCommandStates = [
  "queued",
  "dispatched",
  "accepted",
  "running",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const;

export type AgentControlCommandState =
  (typeof agentControlCommandStates)[number];

const identifierSchema = z.string().trim().min(1).max(160);
const timestampSchema = z.string().datetime({ offset: true });
const jsonObjectSchema = z.record(z.string(), z.unknown());

export const agentHelloPayloadSchema = z
  .object({
    agentId: identifierSchema,
    bootId: identifierSchema,
    daemonVersion: z.string().trim().min(1).max(80),
    daemonCommit: z.string().trim().max(160).optional(),
    daemonBuildDate: z.string().trim().max(80).optional(),
    protocolMin: z.number().int().positive(),
    protocolMax: z.number().int().positive(),
    capabilities: z.array(z.string().trim().min(1).max(120)).max(128),
    actionExecution: actionExecutionCapabilitiesSchema.optional(),
    platform: z.string().trim().min(1).max(80),
    architecture: z.string().trim().min(1).max(80),
    machineName: z.string().trim().min(1).max(160).optional(),
    lastCommandSequence: z.number().int().nonnegative(),
    lastEventSequence: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.capabilities.includes("action-execution/v1") !==
      Boolean(value.actionExecution)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Action execution requires both the protocol capability and structured capabilities",
        path: ["actionExecution"],
      });
    }
    if (value.protocolMin > value.protocolMax) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "protocolMin must not exceed protocolMax",
        path: ["protocolMin"],
      });
    }
  });

export type AgentHelloPayload = z.infer<typeof agentHelloPayloadSchema>;

export const agentCommandPayloadSchema = z
  .object({
    commandId: identifierSchema,
    sequence: z.number().int().positive(),
    idempotencyKey: identifierSchema,
    sessionGeneration: z.number().int().positive(),
    operation: z.enum(agentControlOperations),
    expiresAt: timestampSchema,
    payload: jsonObjectSchema,
  })
  .strict();

export type AgentCommandPayload = z.infer<typeof agentCommandPayloadSchema>;

export const agentCommandEventPayloadSchema = z
  .object({
    agentId: identifierSchema,
    commandId: identifierSchema,
    sequence: z.number().int().nonnegative(),
    sessionGeneration: z.number().int().positive(),
    state: z.enum(agentControlCommandStates),
    result: jsonObjectSchema.optional(),
    error: z
      .object({
        code: z.string().trim().min(1).max(120),
        message: z.string().trim().min(1).max(2_000),
        retryable: z.boolean().default(false),
        details: jsonObjectSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type AgentCommandEventPayload = z.infer<
  typeof agentCommandEventPayloadSchema
>;

const baseEnvelopeFields = {
  protocolVersion: z.literal(agentControlProtocolVersion),
  messageId: identifierSchema,
  sentAt: timestampSchema,
};

export const agentHelloEnvelopeSchema = z
  .object({
    ...baseEnvelopeFields,
    type: z.literal("agent.hello"),
    payload: agentHelloPayloadSchema,
  })
  .strict();

export const agentHeartbeatEnvelopeSchema = z
  .object({
    ...baseEnvelopeFields,
    type: z.literal("agent.heartbeat"),
    payload: z
      .object({
        agentId: identifierSchema,
        bootId: identifierSchema,
        sessionGeneration: z.number().int().positive(),
        lastCommandSequence: z.number().int().nonnegative(),
        lastEventSequence: z.number().int().nonnegative(),
        metrics: jsonObjectSchema.optional(),
      })
      .strict(),
  })
  .strict();

const agentCommandEventTypes = [
  "command.accepted",
  "command.progress",
  "command.completed",
  "command.failed",
  "command.cancelled",
] as const;

export const agentCommandEventEnvelopeSchema = z
  .object({
    ...baseEnvelopeFields,
    type: z.enum(agentCommandEventTypes),
    payload: agentCommandEventPayloadSchema,
  })
  .strict();

export const agentEventEnvelopeSchema = z
  .object({
    ...baseEnvelopeFields,
    type: z.literal("agent.event"),
    payload: z
      .object({
        agentId: identifierSchema,
        sequence: z.number().int().positive(),
        category: z.string().trim().min(1).max(120),
        data: jsonObjectSchema,
      })
      .strict(),
  })
  .strict();

export const agentGoodbyeEnvelopeSchema = z
  .object({
    ...baseEnvelopeFields,
    type: z.literal("agent.goodbye"),
    payload: z
      .object({
        agentId: identifierSchema,
        sessionGeneration: z.number().int().positive(),
        reason: z.string().trim().min(1).max(240),
      })
      .strict(),
  })
  .strict();

const roomObservationKindSchema = z.enum([
  "message",
  "datagram",
  "command",
  "stream",
  "object",
  "media",
]);

const channelAddressSchema = z
  .object({
    subscriptionId: identifierSchema,
    roomId: identifierSchema,
    channelId: identifierSchema,
    kind: roomObservationKindSchema.optional(),
  })
  .strict();

export const agentChannelSubscribedEnvelopeSchema = z
  .object({
    ...baseEnvelopeFields,
    type: z.literal("channel.subscribed"),
    payload: channelAddressSchema
      .extend({
        agentId: identifierSchema,
        kind: roomObservationKindSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const agentChannelDeliveryEnvelopeSchema = z
  .object({
    ...baseEnvelopeFields,
    type: z.literal("channel.delivery"),
    payload: z
      .object({
        agentId: identifierSchema,
        subscriptionId: identifierSchema,
        kind: roomObservationKindSchema.optional(),
        workloadId: identifierSchema.optional(),
        eof: z.boolean().optional(),
        publicationId: identifierSchema.optional(),
        publisherMemberId: identifierSchema.optional(),
        publisherSequence: z.number().int().nonnegative().optional(),
        contentType: z.string().trim().min(1).max(160).optional(),
        payloadBase64: z
          .string()
          .max(128 * 1024)
          .optional(),
        planVersion: z.number().int().nonnegative().optional(),
        receivedAt: timestampSchema,
        metadata: jsonObjectSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const agentChannelPublicationEnvelopeSchema = z
  .object({
    ...baseEnvelopeFields,
    type: z.literal("channel.publication"),
    payload: z
      .object({
        agentId: identifierSchema,
        subscriptionId: identifierSchema,
        clientMessageId: identifierSchema,
        publicationId: identifierSchema,
        publisherSequence: z.number().int().nonnegative(),
        onlineDeliveries: z.number().int().nonnegative(),
        acceptedDeliveries: z.number().int().nonnegative(),
        deliveredDeliveries: z.number().int().nonnegative(),
        failedDeliveries: z.number().int().nonnegative(),
        expiredDeliveries: z.number().int().nonnegative(),
        skippedOnlineOnly: z.number().int().nonnegative(),
        duplicate: z.boolean().optional(),
        expiresAt: timestampSchema,
      })
      .strict(),
  })
  .strict();

export const agentChannelErrorEnvelopeSchema = z
  .object({
    ...baseEnvelopeFields,
    type: z.literal("channel.error"),
    payload: z
      .object({
        agentId: identifierSchema,
        subscriptionId: identifierSchema,
        clientMessageId: identifierSchema.optional(),
        code: z.string().trim().min(1).max(120),
        message: z.string().trim().min(1).max(2_000),
        retryable: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const agentMediaAnswerEnvelopeSchema = z
  .object({
    ...baseEnvelopeFields,
    type: z.literal("media.answer"),
    payload: z
      .object({
        agentId: identifierSchema,
        subscriptionId: identifierSchema,
        clientId: identifierSchema,
        sdp: z
          .string()
          .min(1)
          .max(192 * 1024),
      })
      .strict(),
  })
  .strict();

export const agentObjectChunkEnvelopeSchema = z
  .object({
    ...baseEnvelopeFields,
    type: z.literal("object.chunk"),
    payload: z
      .object({
        agentId: identifierSchema,
        subscriptionId: identifierSchema,
        requestId: identifierSchema,
        transferId: identifierSchema,
        filename: z.string().trim().min(1).max(1_024).optional(),
        sizeBytes: z.number().int().nonnegative().optional(),
        offset: z.number().int().nonnegative(),
        payloadBase64: z
          .string()
          .max(224 * 1024)
          .optional(),
        eof: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

const roomStorageRequestPayloadSchema = z
  .object({
    agentId: identifierSchema,
    requestId: identifierSchema,
    operation: z.enum(["publish", "status", "cancel"]),
    roomId: identifierSchema,
    channelId: identifierSchema,
    publicationId: identifierSchema.optional(),
    sourceMemberId: identifierSchema.optional(),
    sourceLocator: z
      .discriminatedUnion("type", [
        z
          .object({
            type: z.literal("agent_path"),
            path: z.string().min(1).max(4096),
          })
          .strict(),
        z
          .object({
            type: z.literal("bucket_object"),
            objectKey: z.string().min(1).max(4096),
          })
          .strict(),
      ])
      .optional(),
    targetMemberIds: z.array(identifierSchema).optional(),
    ttlSeconds: z.number().int().min(15).max(86_400).optional(),
    allowPartial: z.boolean().optional(),
    idempotencyKey: identifierSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.operation === "publish" &&
      (!value.sourceLocator || !value.sourceMemberId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "A storage publication requires sourceMemberId and sourceLocator.",
      });
    }
    if (value.operation !== "publish" && !value.publicationId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Storage status and cancellation require publicationId.",
      });
    }
  });

export const agentRoomStorageRequestEnvelopeSchema = z
  .object({
    ...baseEnvelopeFields,
    type: z.literal("room.storage.request"),
    payload: roomStorageRequestPayloadSchema,
  })
  .strict();

export const agentToStudioEnvelopeSchema = z.discriminatedUnion("type", [
  agentHelloEnvelopeSchema,
  agentHeartbeatEnvelopeSchema,
  agentCommandEventEnvelopeSchema,
  agentEventEnvelopeSchema,
  agentGoodbyeEnvelopeSchema,
  agentChannelSubscribedEnvelopeSchema,
  agentChannelDeliveryEnvelopeSchema,
  agentChannelPublicationEnvelopeSchema,
  agentChannelErrorEnvelopeSchema,
  agentMediaAnswerEnvelopeSchema,
  agentObjectChunkEnvelopeSchema,
  agentRoomStorageRequestEnvelopeSchema,
]);

export const serverWelcomeEnvelopeSchema = z
  .object({
    ...baseEnvelopeFields,
    type: z.literal("server.welcome"),
    payload: z
      .object({
        connectionId: identifierSchema,
        sessionGeneration: z.number().int().positive(),
        heartbeatIntervalSeconds: z.number().int().min(5).max(300),
        commandSequence: z.number().int().nonnegative(),
        policyRevision: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const serverCommandEnvelopeSchema = z
  .object({
    ...baseEnvelopeFields,
    type: z.literal("command"),
    payload: agentCommandPayloadSchema,
  })
  .strict();

export const serverSessionReplacedEnvelopeSchema = z
  .object({
    ...baseEnvelopeFields,
    type: z.literal("session.replaced"),
    payload: z
      .object({
        sessionGeneration: z.number().int().positive(),
        reason: z.string().trim().min(1).max(240),
      })
      .strict(),
  })
  .strict();

export const serverPolicyUpdatedEnvelopeSchema = z
  .object({
    ...baseEnvelopeFields,
    type: z.literal("policy.updated"),
    payload: z
      .object({
        revision: z.number().int().nonnegative(),
        policy: jsonObjectSchema,
      })
      .strict(),
  })
  .strict();

export const serverPingEnvelopeSchema = z
  .object({
    ...baseEnvelopeFields,
    type: z.literal("server.ping"),
    payload: z.object({ nonce: identifierSchema }).strict(),
  })
  .strict();

export const serverChannelSubscribeEnvelopeSchema = z
  .object({
    ...baseEnvelopeFields,
    type: z.literal("channel.subscribe"),
    payload: channelAddressSchema,
  })
  .strict();

export const serverChannelUnsubscribeEnvelopeSchema = z
  .object({
    ...baseEnvelopeFields,
    type: z.literal("channel.unsubscribe"),
    payload: z.object({ subscriptionId: identifierSchema }).strict(),
  })
  .strict();

export const serverChannelPublishEnvelopeSchema = z
  .object({
    ...baseEnvelopeFields,
    type: z.literal("channel.publish"),
    payload: channelAddressSchema
      .extend({
        clientMessageId: identifierSchema,
        contentType: z.string().trim().min(1).max(160),
        payloadBase64: z
          .string()
          .min(1)
          .max(128 * 1024),
      })
      .strict(),
  })
  .strict();

export const serverMediaOfferEnvelopeSchema = z
  .object({
    ...baseEnvelopeFields,
    type: z.literal("media.offer"),
    payload: z
      .object({
        subscriptionId: identifierSchema,
        clientId: identifierSchema,
        workloadId: identifierSchema.optional(),
        sdp: z
          .string()
          .min(1)
          .max(192 * 1024),
      })
      .strict(),
  })
  .strict();

export const serverMediaCloseEnvelopeSchema = z
  .object({
    ...baseEnvelopeFields,
    type: z.literal("media.close"),
    payload: z
      .object({ subscriptionId: identifierSchema, clientId: identifierSchema })
      .strict(),
  })
  .strict();

export const serverObjectDownloadEnvelopeSchema = z
  .object({
    ...baseEnvelopeFields,
    type: z.literal("object.download"),
    payload: z
      .object({
        subscriptionId: identifierSchema,
        requestId: identifierSchema,
        transferId: identifierSchema,
      })
      .strict(),
  })
  .strict();

export const serverRoomStorageResponseEnvelopeSchema = z
  .object({
    ...baseEnvelopeFields,
    type: z.literal("room.storage.response"),
    payload: z
      .object({
        requestId: identifierSchema,
        operation: z.enum(["publish", "status", "cancel"]),
        state: z.enum(["completed", "failed"]),
        publicationId: identifierSchema.optional(),
        status: jsonObjectSchema.optional(),
        error: z
          .object({
            code: identifierSchema,
            message: z.string().trim().min(1).max(500),
            retryable: z.boolean(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

export const studioToAgentEnvelopeSchema = z.discriminatedUnion("type", [
  serverWelcomeEnvelopeSchema,
  serverCommandEnvelopeSchema,
  serverSessionReplacedEnvelopeSchema,
  serverPolicyUpdatedEnvelopeSchema,
  serverPingEnvelopeSchema,
  serverChannelSubscribeEnvelopeSchema,
  serverChannelUnsubscribeEnvelopeSchema,
  serverChannelPublishEnvelopeSchema,
  serverMediaOfferEnvelopeSchema,
  serverMediaCloseEnvelopeSchema,
  serverObjectDownloadEnvelopeSchema,
  serverRoomStorageResponseEnvelopeSchema,
]);

export type AgentToStudioEnvelope = z.infer<typeof agentToStudioEnvelopeSchema>;
export type StudioToAgentEnvelope = z.infer<typeof studioToAgentEnvelopeSchema>;

export function parseAgentControlMessage(
  value: string | Uint8Array,
  direction: "agent-to-studio" | "studio-to-agent",
) {
  const bytes =
    typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
  if (bytes > agentControlMaxMessageBytes) {
    throw new Error(
      `Agent control message exceeds ${agentControlMaxMessageBytes} bytes.`,
    );
  }
  const decoded = JSON.parse(
    typeof value === "string" ? value : new TextDecoder().decode(value),
  );
  return direction === "agent-to-studio"
    ? agentToStudioEnvelopeSchema.parse(decoded)
    : studioToAgentEnvelopeSchema.parse(decoded);
}
