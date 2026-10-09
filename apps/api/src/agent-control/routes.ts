import { settleRouteAuth } from "../auth/kernel.js";
import { auth } from "../auth/policy.js";
import { selectRoomConsumer } from "./room-consumer.js";
import {
  RoomConsumerAttacher,
  RoomConsumerError,
  type AttachableRoomConsumer,
} from "./room-consumer-attach.js";
import {
  createRoomWithConsumer,
  roomConsumerUnavailableCode,
  roomConsumerUnavailableMessage,
} from "./room-create.js";
import {
  roomServiceForOrganization,
  roomServiceForRequest,
} from "./room-service.js";
import {
  consumerSharedSecret,
  resolveConsumerOrganization,
  type ConsumerBootstrapRefusal,
  type ConsumerInstanceReader,
} from "./consumer-bootstrap.js";
import { type BeamEnvironmentTemplate } from "@beam-studio/shared";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import {
  studioRequestSession,
  studioRequestAuth,
  studioRequestOrganizationId,
  studioRequestProjectId,
} from "../auth/request-context.js";
import { webEnv } from "../env.js";
import {
  isAllowedStudioOrigin,
  studioAgentControlOrigins,
} from "../cors-policy.js";
import { agentControlOperations } from "@beam-studio/shared";
import { AgentControlRepository } from "./repository.js";
import { AgentGateway } from "./gateway.js";
import { CoordinatorRoomClient } from "./coordinator-client.js";
import { issueMediaTicket, verifyMediaTicket } from "./media-ticket.js";
import {
  getDecryptedApiKey,
  listRoomStorageBindings,
  resolveBeamEnvironmentTemplate,
} from "../studio/store.js";
import {
  paginateRoomWorkflowRooms,
  resolveRoomWorkflowRecipients,
  roomWorkflowContext,
  roomWorkflowRecipientPage,
} from "./room-workflow-options.js";
import {
  attachStorageMember,
  listStorageMembers,
  removeStorageMember,
  updateStorageMember,
} from "./room-storage-binding-service.js";

const delegatedRoomOperations = new Set([
  "room.create",
  "room.close",
  "room.invitation.create",
  "room.invitation.revoke",
  "room.membership.remove",
  "room.role.create",
  "room.role.assign",
  "room.role.revoke",
  "room.role.delete",
  "room.channel.create",
  "room.channel.activate",
  "room.channel.update",
  "room.channel.close",
  "room.grant.put",
  "room.grant.revoke",
]);

type JsonObject = Record<string, unknown>;

export async function registerAgentControlRoutes(
  server: FastifyInstance,
  options: {
    repository: AgentControlRepository;
    gateway: AgentGateway;
    instance?: ConsumerInstanceReader | null;
    /** Organization room authority; injected by tests. */
    consumerRoomService?: typeof roomServiceForOrganization;
  },
) {
  const consumer: ConsumerBootstrapDependencies = {
    instance: options.instance,
    roomService: options.consumerRoomService ?? roomServiceForOrganization,
  };
  const consumers = new RoomConsumerAttacher(
    options.repository,
    options.gateway,
  );
  await server.register(websocket, {
    options: { maxPayload: 256 * 1024, perMessageDeflate: false },
  });

  server.post<{ Body: JsonObject }>(
    "/agent-control/v1/bootstrap",
    { config: { auth: auth.serviceSecret("BEAM_STUDIO_SHARED_SECRET") } },
    async (request, reply) => {
      const sharedSecret = consumerSharedSecret();
      if (!sharedSecret) {
        return reply.code(503).send({
          code: "consumer_bootstrap_unavailable",
          error: "Studio consumer bootstrap is not configured.",
          retryable: true,
          statusCode: 503,
        });
      }
      // Authenticated before anything else is resolved, so the claim state and
      // the key situation are only ever told to the deployment's own consumer.
      const presented = bearerToken(request.headers.authorization);
      if (!presented || !sameSecret(presented, sharedSecret)) {
        return reply.code(401).send({
          code: "consumer_bootstrap_rejected",
          error: "Studio consumer bootstrap authentication failed.",
          statusCode: 401,
        });
      }
      settleRouteAuth(request);
      const publicKeyFingerprint = text(
        request.body.publicKeyFingerprint,
      ).toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(publicKeyFingerprint)) {
        return reply.code(400).send({
          code: "consumer_bootstrap_key_invalid",
          error: "A valid Ed25519 public key fingerprint is required.",
          statusCode: 400,
        });
      }
      const resolved = await consumerBootstrapConfig(request, consumer);
      if (!resolved.ok) {
        // Answered rather than thrown: the consumer polls this while the
        // instance is unclaimed or has no key, and each poll is expected, not
        // a failure worth an error log. The consumer retries any 503.
        return reply.code(503).send({
          code: resolved.code,
          error: resolved.error,
          retryable: true,
          statusCode: 503,
        });
      }
      const config = resolved.config;
      const machineName = (
        optionalText(request.body.machineName) ?? "Studio room consumer"
      ).slice(0, 160);
      const existingAgentId = optionalText(request.body.agentId);
      const studioEnrollment = await options.repository.createEnrollment({
        organizationId: config.organizationId,
        machineName,
        createdById: null,
      });
      const coordinatorEnrollment = existingAgentId
        ? null
        : await config.coordinator.createAgentEnrollment(
            config.organizationId,
            machineName,
            publicKeyFingerprint,
            config.coordinatorToken,
          );
      reply.header("Cache-Control", "no-store");
      return reply.code(201).send({
        coordinatorUrl: config.coordinator.url,
        coordinatorEnrollmentToken:
          coordinatorEnrollment?.enrollment_token ?? null,
        organizationId: config.organizationId,
        studioEnrollmentCode: studioEnrollment.code,
        expiresAt: studioEnrollment.expiresAt,
      });
    },
  );

  server.post<{ Body: JsonObject }>(
    "/agent-control/v1/enroll",
    { config: { auth: auth.credentialExchange("agent-enrollment-code") } },
    async (request, reply) => {
      const result = await options.repository.consumeEnrollment({
        code: text(request.body.code),
        publicKey: text(request.body.publicKey),
        machineName: optionalText(request.body.machineName),
        agentId: optionalText(request.body.agentId),
      });
      settleRouteAuth(request);
      // A freshly enrolled agent is not connected yet. Its joined rooms are
      // reconciled once its control connection is accepted.
      return reply.code(201).send(result);
    },
  );

  server.post<{ Body: JsonObject }>(
    "/agent-control/v1/token",
    { config: { auth: auth.credentialExchange("agent-ed25519-proof") } },
    async (request) => {
      const issued = await options.repository.issueAccessToken({
        credential: text(request.body.credential),
        nonce: text(request.body.nonce),
        issuedAt: text(request.body.issuedAt),
        signature: text(request.body.signature),
      });
      settleRouteAuth(request);
      return issued;
    },
  );

  server.get(
    "/agent-control/v1/connect",
    { config: { auth: auth.agent() }, websocket: true },
    (socket, request) => {
      // A machine endpoint, authenticated by a bearer token a browser cannot
      // set on a WebSocket. Browsers always send Origin on a handshake and
      // native clients never do, so refusing any handshake that carries one
      // removes the cross-site case outright, rather than maintaining an
      // allowlist for callers that should never be browsers.
      if (request.headers.origin) {
        socket.close(1008, "origin not permitted on an agent connection");
        return;
      }
      const token = bearerToken(request.headers.authorization);
      if (!token) {
        socket.close(1008, "authentication required");
        return;
      }
      let agentId = "";
      try {
        agentId = options.repository.verifyAccessToken(token).agentId;
        settleRouteAuth(request);
      } catch {
        // The gateway owns WebSocket authentication and its rejection response.
      }
      void options.gateway
        .accept(socket, token)
        .then(async (accepted) => {
          if (!accepted) return;
          if (!agentId || !consumerSharedSecret()) return;
          const organization = await consumerOrganization(consumer);
          if (!organization.ok) return;
          const agent = await options.repository.getAgent(
            organization.organizationId,
            agentId,
          );
          if (
            agent.status === "revoked" ||
            !agent.capabilities.includes("studio-room-consumer")
          ) {
            return;
          }
          const bootstrap = await optionalConsumerBootstrapConfig(
            request,
            consumer,
          );
          if (!bootstrap) return;
          await refreshJoinedConsumerRooms(bootstrap, agent, consumers);
          request.log.info(
            { agentId },
            "Studio consumer rooms reconciled after connection",
          );
        })
        .catch((error) => {
          request.log.warn(
            { agentId: agentId || undefined, error },
            "Studio consumer connection reconciliation failed",
          );
        });
    },
  );

  server.get<{
    Params: { roomId: string };
  }>(
    "/studio/rooms/:roomId/transfers",
    { config: { auth: auth.read() } },
    async (request, reply) => {
      const scope = await studioScope(request);
      const target = await roomTarget(
        request,
        scope.organizationId,
      );
      const history = await target.coordinator.listOrganizationRoomTransfers(
        scope.organizationId,
        request.params.roomId,
        null,
        target.token,
      );
      return options.repository.linkRoomWorkflowRuns(
        scope.organizationId,
        target.template.key,
        history.transfers ?? [],
      );
    },
  );

  server.get<{
    Params: { roomId: string; channelId: string };
  }>(
    "/studio/rooms/:roomId/channels/:channelId/transfers",
    { config: { auth: auth.read() } },
    async (request, reply) => {
      const scope = await studioScope(request);
      const target = await roomTarget(
        request,
        scope.organizationId,
      );
      const history = await target.coordinator.listOrganizationRoomTransfers(
        scope.organizationId,
        request.params.roomId,
        request.params.channelId,
        target.token,
      );
      return options.repository.linkRoomWorkflowRuns(
        scope.organizationId,
        target.template.key,
        history.transfers ?? [],
      );
    },
  );

  server.post<{
    Params: { agentId: string; roomId: string; channelId: string };
  }>(
    "/studio/agents/:agentId/rooms/:roomId/channels/:channelId/media-session",
    { config: { auth: auth.write() } },
    async (request, reply) => {
      const scope = await studioScope(request);
      const secret = process.env.BEAM_STUDIO_SECRET_KEY?.trim();
      if (!secret) {
        return reply.code(503).send({
          code: "media_session_unavailable",
          error: "Temporary Studio media sessions are not configured.",
          statusCode: 503,
        });
      }
      const agent = await options.repository.getAgent(
        scope.organizationId,
        request.params.agentId,
      );
      if (
        agent.status === "revoked" ||
        !agent.capabilities.includes("studio-room-consumer")
      ) {
        return reply.code(409).send({
          code: "media_consumer_unavailable",
          error: "The Studio room consumer is unavailable.",
          statusCode: 409,
        });
      }
      const target = await roomTarget(
        request,
        scope.organizationId,
      );
      const snapshot = await target.coordinator.organizationRoomSnapshot(
        scope.organizationId,
        request.params.roomId,
        target.token,
      );
      const channel = array(snapshot.channels).find(
        (item) =>
          (optionalText(item.channel_id) ?? optionalText(item.id)) ===
          request.params.channelId,
      );
      if (optionalText(channel?.kind) !== "media") {
        return reply.code(404).send({
          code: "media_channel_not_found",
          error: "The requested media channel is unavailable to this consumer.",
          statusCode: 404,
        });
      }
      // Throws room_consumer_offline or room_consumer_not_ready, which the API
      // error handler answers with that code and message.
      await consumers.attach({
        coordinator: target.coordinator,
        token: target.token,
        organizationId: scope.organizationId,
        roomId: request.params.roomId,
        consumer: agent,
        idempotencyKey: `studio-media-consumer:${agent.id}:${request.params.roomId}`,
      });
      const token = issueMediaTicket(secret, {
        agentId: agent.id,
        organizationId: scope.organizationId,
        roomId: request.params.roomId,
        channelId: request.params.channelId,
      });
      reply.header("Cache-Control", "no-store");
      return {
        websocketPath: `/studio/room-media/connect?ticket=${encodeURIComponent(token)}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
  );

  server.get<{ Querystring: { ticket?: string } }>(
    "/studio/room-media/connect",
    { config: { auth: auth.mediaTicket() }, websocket: true },
    (socket, request) => {
      void (async () => {
        const secret = process.env.BEAM_STUDIO_SECRET_KEY?.trim() ?? "";
        const ticket = verifyMediaTicket(secret, request.query.ticket ?? "");
        if (!ticket) {
          socket.close(1008, "media ticket rejected");
          return;
        }
        settleRouteAuth(request);
        try {
          const agent = await options.repository.getAgent(
            ticket.organizationId,
            ticket.agentId,
          );
          if (
            agent.status === "revoked" ||
            !agent.capabilities.includes("studio-room-consumer")
          ) {
            socket.close(1008, "media consumer unavailable");
            return;
          }
          options.gateway.acceptChannelClient(socket, {
            agentId: ticket.agentId,
            roomId: ticket.roomId,
            channelId: ticket.channelId,
            kind: "media",
          });
        } catch {
          socket.close(1008, "media ticket rejected");
        }
      })();
    },
  );

  server.get<{
    Params: { agentId: string; roomId: string; channelId: string };
  }>(
    "/studio/agents/:agentId/rooms/:roomId/channels/:channelId/connect",
    { config: { auth: auth.read() }, websocket: true },
    (socket, request) => {
      void (async () => {
        try {
          if (
            !isAllowedStudioOrigin(
              request.headers.origin,
              studioAgentControlOrigins(),
            )
          ) {
            socket.close(1008, "Studio origin rejected");
            return;
          }
          const scope = await studioScope(request);
          const agent = await options.repository.getAgent(
            scope.organizationId,
            request.params.agentId,
          );
          if (
            agent.status === "revoked" ||
            (!agent.capabilities.includes("room-messages") &&
              !agent.capabilities.includes("room-workloads"))
          ) {
            socket.close(1008, "room observation unavailable");
            return;
          }
          const target = await roomTarget(
            request,
            scope.organizationId,
          );
          const snapshot = await target.coordinator.organizationRoomSnapshot(
            scope.organizationId,
            request.params.roomId,
            target.token,
          );
          const channel = array(snapshot.channels).find(
            (item) =>
              (optionalText(item.channel_id) ?? optionalText(item.id)) ===
              request.params.channelId,
          );
          const rawKind = channel ? optionalText(channel.kind) : null;
          const kind = rawKind === "request_reply" ? "command" : rawKind;
          if (
            kind !== "message" &&
            kind !== "datagram" &&
            kind !== "command" &&
            kind !== "stream" &&
            kind !== "media" &&
            kind !== "object"
          ) {
            socket.close(1008, "live channel observation unavailable");
            return;
          }
          await consumers.attach({
            coordinator: target.coordinator,
            token: target.token,
            organizationId: scope.organizationId,
            roomId: request.params.roomId,
            consumer: agent,
            idempotencyKey: `studio-channel-consumer:${agent.id}:${request.params.roomId}`,
          });
          options.gateway.acceptChannelClient(socket, {
            agentId: agent.id,
            roomId: request.params.roomId,
            channelId: request.params.channelId,
            kind,
          });
        } catch (error) {
          if (error instanceof RoomConsumerError) {
            closeWithRoomConsumerError(socket, error);
            return;
          }
          socket.close(1008, "Studio authorization failed");
        }
      })();
    },
  );

  server.get<{
    Params: { agentId: string; roomId: string; channelId: string };
  }>(
    "/studio/agents/:agentId/rooms/:roomId/channels/:channelId/objects",
    { config: { auth: auth.read() } },
    async (request, reply) => {
      const scope = await studioScope(request);
      const target = await roomTarget(
        request,
        scope.organizationId,
      );
      const agent = await options.repository.getAgent(
        scope.organizationId,
        request.params.agentId,
      );
      if (!agent.capabilities.includes("room-transfers")) {
        return reply.code(409).send({
          code: "agent_room_transfers_unsupported",
          error: "The managed agent does not support room transfers.",
          statusCode: 409,
        });
      }
      return target.coordinator.listRoomObjects(
        scope.organizationId,
        agent.id,
        request.params.roomId,
        request.params.channelId,
        target.token,
      );
    },
  );

  server.post<{ Body: JsonObject }>(
    "/studio/agents/enrollments",
    { config: { auth: auth.write() } },
    async (request, reply) => {
      const scope = await studioScope(request);
      const result = await options.repository.createEnrollment({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        machineName: text(request.body.machineName),
        createdById: scope.userId,
      });
      return reply.code(201).send(result);
    },
  );

  server.get<{ Params: { id: string } }>(
    "/studio/agents/enrollments/:id",
    { config: { auth: auth.read() } },
    async (request) => {
      const scope = await studioScope(request);
      return options.repository.getEnrollment(
        scope.organizationId,
        request.params.id,
      );
    },
  );

  server.get(
    "/studio/rooms",
    { config: { auth: auth.read() } },
    async (request, reply) => {
      const scope = await studioScope(request);
      const target = await roomTarget(
        request,
        scope.organizationId,
      );
      const [allAgents, roomLabels, organizationRooms] = await Promise.all([
        options.repository.listAgents(scope.organizationId),
        options.repository.listRoomLabels(scope.organizationId),
        target.coordinator.listOrganizationRooms(
          scope.organizationId,
          target.token,
        ),
      ]);
      const agents = allAgents.filter(
        (agent) =>
          agent.status !== "revoked" &&
          agent.capabilities.some((capability) => capability === "rooms"),
      );
      const authorizedAgentIds = new Set<string>();
      const organizationSnapshots = await Promise.all(
        array(organizationRooms.rooms).map(async (listedRoom) => {
          if (listedRoomIsClosed(listedRoom)) return null;
          const roomId = roomIdentifier(listedRoom);
          if (!roomId) return null;
          let snapshot: JsonObject;
          try {
            snapshot = await target.coordinator.organizationRoomSnapshot(
              scope.organizationId,
              roomId,
              target.token,
            );
          } catch (error) {
            request.log.warn(
              { error, roomId },
              "Coordinator room snapshot unavailable; using list response",
            );
            snapshot = listedRoom;
          }
          return {
            ...snapshot,
            label: roomLabels[roomId] ?? null,
            agent: null,
            commands: [],
            events: [],
            coordinator: {
              url: target.coordinator.url,
              source: "organization_delegation",
              template_key: target.template.key,
            },
          };
        }),
      );
      const roomGroups = await Promise.all(
        agents.map(async (agent) => {
          let listed: { rooms?: JsonObject[] };
          try {
            listed = await target.coordinator.listRooms(
              scope.organizationId,
              agent.id,
              target.token,
            );
            authorizedAgentIds.add(agent.id);
          } catch (error) {
            request.log.warn(
              { agentId: agent.id, error },
              "Coordinator agent room inventory unavailable",
            );
            return [];
          }
          const commands = await options.repository.listCommands(
            scope.organizationId,
            agent.id,
            200,
          );
          const events = await options.repository.listEvents(
            scope.organizationId,
            agent.id,
            300,
          );
          return Promise.all(
            array(listed.rooms).map(async (listedRoom) => {
              if (listedRoomIsClosed(listedRoom)) return null;
              const roomId = roomIdentifier(listedRoom);
              if (!roomId) return null;
              let snapshot: JsonObject;
              try {
                snapshot = await target.coordinator.roomSnapshot(
                  scope.organizationId,
                  agent.id,
                  roomId,
                  target.token,
                );
              } catch (error) {
                request.log.warn(
                  { agentId: agent.id, error, roomId },
                  "Coordinator agent room snapshot unavailable",
                );
                return null;
              }
              return {
                ...snapshot,
                label: roomLabels[roomId] ?? null,
                agent,
                commands,
                events,
                coordinator: {
                  url: target.coordinator.url,
                  source: "direct_delegation",
                  template_key: target.template.key,
                },
              };
            }),
          );
        }),
      );
      const selection = selectRoomConsumer(allAgents, authorizedAgentIds);
      return {
        rooms: [
          ...organizationSnapshots.filter(Boolean),
          ...roomGroups.flat().filter(Boolean),
        ],
        agents,
        consumer: selection.consumer,
        consumerUnavailableReason: selection.reason,
        source: "coordinator",
      };
    },
  );

  server.get<{ Params: { roomId: string } }>(
    "/studio/rooms/:roomId/storage-members",
    { config: { auth: auth.read() } },
    async (request) => {
      const scope = await studioScope(request);
      const target = await roomTarget(
        request,
        scope.organizationId,
      );
      return {
        bindings: await listStorageMembers({
          organizationId: scope.organizationId,
          roomId: request.params.roomId,
          target: {
            coordinator: target.coordinator,
            token: target.token,
            templateKey: target.template.key,
          },
        }),
        templateKey: target.template.key,
      };
    },
  );

  server.post<{ Params: { roomId: string }; Body: JsonObject }>(
    "/studio/rooms/:roomId/storage-members",
    { config: { auth: auth.write() } },
    async (request, reply) => {
      const scope = await studioScope(request);
      const target = await roomTarget(
        request,
        scope.organizationId,
      );
      const result = await attachStorageMember({
        organizationId: scope.organizationId,
        roomId: request.params.roomId,
        value: request.body,
        target: {
          coordinator: target.coordinator,
          token: target.token,
          templateKey: target.template.key,
        },
      });
      return reply.code(201).send(result);
    },
  );

  server.patch<{
    Params: { roomId: string; bindingId: string };
    Body: JsonObject;
  }>(
    "/studio/rooms/:roomId/storage-members/:bindingId",
    { config: { auth: auth.write() } },
    async (request) => {
      const scope = await studioScope(request);
      const target = await roomTarget(
        request,
        scope.organizationId,
      );
      return {
        binding: await updateStorageMember({
          organizationId: scope.organizationId,
          roomId: request.params.roomId,
          bindingId: request.params.bindingId,
          value: request.body,
          target: {
            coordinator: target.coordinator,
            token: target.token,
            templateKey: target.template.key,
          },
        }),
      };
    },
  );

  server.delete<{ Params: { roomId: string; bindingId: string } }>(
    "/studio/rooms/:roomId/storage-members/:bindingId",
    { config: { auth: auth.write() } },
    async (request, reply) => {
      const scope = await studioScope(request);
      const target = await roomTarget(
        request,
        scope.organizationId,
      );
      await removeStorageMember({
        organizationId: scope.organizationId,
        roomId: request.params.roomId,
        bindingId: request.params.bindingId,
        target: {
          coordinator: target.coordinator,
          token: target.token,
          templateKey: target.template.key,
        },
      });
      return reply.code(204).send();
    },
  );

  server.get(
    "/studio/room-workflow-options/rooms",
    { config: { auth: auth.read() } },
    async (request) => {
      const scope = await studioScope(request);
      const target = await roomTarget(
        request,
        scope.organizationId,
      );
      const query = object(request.query);
      const [listed, labels] = await Promise.all([
        target.coordinator.listOrganizationRooms(
          scope.organizationId,
          target.token,
        ),
        options.repository.listRoomLabels(scope.organizationId),
      ]);
      const rooms = array(listed.rooms).flatMap((room) => {
        if (listedRoomIsClosed(room)) return [];
        const id = roomIdentifier(room);
        if (!id) return [];
        return [
          {
            id,
            name:
              labels[id] ??
              optionalText(room.label) ??
              optionalText(room.name) ??
              id,
            state: optionalText(room.state) ?? "unknown",
          },
        ];
      });
      return {
        ...paginateRoomWorkflowRooms(
          rooms,
          optionalText(query.query),
          optionalText(query.cursor),
          optionalNumber(query.limit),
        ),
        templateKey: target.template.key,
      };
    },
  );

  server.get<{ Params: { roomId: string } }>(
    "/studio/room-workflow-options/rooms/:roomId/context",
    { config: { auth: auth.read() } },
    async (request) => {
      const scope = await studioScope(request);
      const target = await roomTarget(
        request,
        scope.organizationId,
      );
      const [snapshot, agents, labels, storageBindings] = await Promise.all([
        target.coordinator.organizationRoomSnapshot(
          scope.organizationId,
          request.params.roomId,
          target.token,
        ),
        options.repository.listAgents(scope.organizationId),
        options.repository.listRoomLabels(scope.organizationId),
        listRoomStorageBindings(
          scope.organizationId,
          target.template.key,
          request.params.roomId,
        ),
      ]);
      return {
        ...roomWorkflowContext(
          request.params.roomId,
          labels[request.params.roomId] ?? request.params.roomId,
          snapshot,
          agents,
          storageBindings,
        ),
        templateKey: target.template.key,
      };
    },
  );

  server.post<{ Params: { roomId: string }; Body: JsonObject }>(
    "/studio/room-workflow-options/rooms/:roomId/recipients/search",
    { config: { auth: auth.write() } },
    async (request) => {
      const scope = await studioScope(request);
      const target = await roomTarget(
        request,
        scope.organizationId,
      );
      const [snapshot, agents, storageBindings] = await Promise.all([
        target.coordinator.organizationRoomSnapshot(
          scope.organizationId,
          request.params.roomId,
          target.token,
        ),
        options.repository.listAgents(scope.organizationId),
        listRoomStorageBindings(
          scope.organizationId,
          target.template.key,
          request.params.roomId,
        ),
      ]);
      return {
        ...roomWorkflowRecipientPage(
          request.params.roomId,
          snapshot,
          agents,
          {
            channelId: text(request.body.channelId),
            sourceMemberId: text(request.body.sourceMemberId),
            query: optionalText(request.body.query),
            roleId: optionalText(request.body.roleId),
            presence: optionalText(request.body.presence),
            selectedOnly: request.body.selectedOnly === true,
            selectedMemberIds: textArray(request.body.selectedMemberIds),
            cursor: optionalText(request.body.cursor),
            limit: optionalNumber(request.body.limit),
          },
          storageBindings,
        ),
        templateKey: target.template.key,
      };
    },
  );

  server.post<{ Params: { roomId: string }; Body: JsonObject }>(
    "/studio/room-workflow-options/rooms/:roomId/recipients/resolve",
    { config: { auth: auth.write() } },
    async (request) => {
      const scope = await studioScope(request);
      const target = await roomTarget(
        request,
        scope.organizationId,
      );
      const [snapshot, agents, storageBindings] = await Promise.all([
        target.coordinator.organizationRoomSnapshot(
          scope.organizationId,
          request.params.roomId,
          target.token,
        ),
        options.repository.listAgents(scope.organizationId),
        listRoomStorageBindings(
          scope.organizationId,
          target.template.key,
          request.params.roomId,
        ),
      ]);
      return {
        memberIds: resolveRoomWorkflowRecipients(
          request.params.roomId,
          snapshot,
          agents,
          {
            channelId: text(request.body.channelId),
            sourceMemberId: text(request.body.sourceMemberId),
            query: optionalText(request.body.query),
            roleId: optionalText(request.body.roleId),
            presence: optionalText(request.body.presence),
          },
          storageBindings,
        ),
        templateKey: target.template.key,
      };
    },
  );

  server.get(
    "/studio/room-workflow-options/recent-paths",
    { config: { auth: auth.read() } },
    async (request) => {
      const scope = await studioScope(request);
      const target = await roomTarget(
        request,
        scope.organizationId,
      );
      const query = object(request.query);
      return {
        paths: await options.repository.listRecentRoomSourcePaths(
          scope.organizationId,
          target.template.key,
          text(query.sourceMemberId),
          optionalNumber(query.limit),
        ),
        templateKey: target.template.key,
      };
    },
  );

  server.post<{ Params: { agentId: string } }>(
    "/studio/room-consumers/:agentId/reconcile",
    { config: { auth: auth.write() } },
    async (request, reply) => {
      const scope = await studioScope(request);
      const target = await roomTarget(
        request,
        scope.organizationId,
      );
      const consumer = await options.repository.getAgent(
        scope.organizationId,
        request.params.agentId,
      );
      if (
        consumer.status === "revoked" ||
        !consumer.capabilities.includes("studio-room-consumer")
      ) {
        return reply.code(400).send({
          code: "invalid_room_consumer",
          error: "The selected agent is not an active Studio room consumer.",
          statusCode: 400,
        });
      }
      const listed = await target.coordinator.listOrganizationRooms(
        scope.organizationId,
        target.token,
      );
      const rooms = array(listed.rooms).filter(
        (room) => !listedRoomIsClosed(room) && Boolean(roomIdentifier(room)),
      );
      const memberships = await Promise.all(
        rooms.map((room) => {
          const roomId = roomIdentifier(room)!;
          return consumers.attach({
            coordinator: target.coordinator,
            token: target.token,
            organizationId: scope.organizationId,
            roomId,
            consumer,
            idempotencyKey: `studio-consumer:${consumer.id}:${roomId}`,
          });
        }),
      );
      return { consumer, rooms: rooms.length, memberships };
    },
  );

  server.post<{ Body: JsonObject }>(
    "/studio/rooms",
    { config: { auth: auth.write() } },
    async (request, reply) => {
      const scope = await studioScope(request);
      // Starting a room is billable, so the caller names the API key to charge.
      // The coordinator refuses a create with no key rather than starting a room
      // nobody pays for.
      const apiKeyId = optionalText(request.body.apiKeyId);
      if (!apiKeyId) {
        return reply.code(400).send({
          code: "api_key_required",
          error: "Select the Beam API key to charge this room to.",
          statusCode: 400,
        });
      }
      const apiKey = await getDecryptedApiKey(apiKeyId, scope.organizationId);
      if (!apiKey) {
        return reply.code(400).send({
          code: "api_key_unavailable",
          error: "The selected Beam API key could not be read.",
          statusCode: 400,
        });
      }

      const target = await roomTarget(
        request,
        scope.organizationId,
      );
      // The coordinator commits the room credit on create, so the consumer is
      // resolved first and nothing billable is requested without one.
      const outcome = await createRoomWithConsumer(
        {
          organizationId: scope.organizationId,
          agents: await options.repository.listAgents(scope.organizationId),
          coordinator: target.coordinator,
          token: target.token,
          payload: object(request.body.payload),
          idempotencyKey:
            optionalText(request.body.idempotencyKey) ?? randomUUID(),
          apiKey,
          attachConsumer: (consumer, roomId) =>
            consumers.attach({
              coordinator: target.coordinator,
              token: target.token,
              organizationId: scope.organizationId,
              roomId,
              consumer,
              idempotencyKey: `studio-consumer:${consumer.id}:${roomId}`,
            }),
        },
        (consumer, roomId, error) =>
          server.log.warn(
            {
              agentId: consumer.id,
              roomId,
              code: (error as { code?: unknown } | null)?.code,
            },
            "Room created before Studio consumer attachment completed",
          ),
      );
      if (!outcome.created) {
        request.log.warn(
          { organizationId: scope.organizationId, reason: outcome.reason },
          "Room creation refused: no Studio room consumer available",
        );
        return reply.code(409).send({
          code: roomConsumerUnavailableCode(outcome.reason),
          error: roomConsumerUnavailableMessage(outcome.reason),
          statusCode: 409,
          details: { reason: outcome.reason, charged: false },
        });
      }
      return reply.code(201).send({
        result: outcome.result,
        delegated: true,
        consumer: outcome.consumer,
        membership: outcome.membership,
        consumerAttachmentError: outcome.consumerAttachmentError,
      });
    },
  );

  server.post<{
    Params: { roomId: string };
    Body: JsonObject;
  }>(
    "/studio/rooms/:roomId/commands",
    { config: { auth: auth.write() } },
    async (request, reply) => {
      const scope = await studioScope(request);
      const operation = text(request.body.operation);
      if (
        operation === "room.create" ||
        !delegatedRoomOperations.has(operation)
      ) {
        return reply.code(400).send({
          code: "room_operation_unsupported",
          error: "Unsupported organization room operation",
          statusCode: 400,
        });
      }
      const target = await roomTarget(
        request,
        scope.organizationId,
      );
      const result = await target.coordinator.mutateOrganizationRoom(
        scope.organizationId,
        operation,
        { ...object(request.body.payload), room_id: request.params.roomId },
        optionalText(request.body.idempotencyKey) ?? randomUUID(),
        target.token,
      );
      return reply.code(202).send({ result, delegated: true });
    },
  );

  server.patch<{ Params: { roomId: string }; Body: JsonObject }>(
    "/studio/rooms/:roomId",
    { config: { auth: auth.write() } },
    async (request) => {
      const scope = await studioScope(request);
      const value = request.body.label;
      if (value !== null && typeof value !== "string") {
        throw Object.assign(new Error("Room label must be a string or null."), {
          code: "invalid_room_label",
          statusCode: 400,
        });
      }
      const label = await options.repository.setRoomLabel({
        organizationId: scope.organizationId,
        roomId: request.params.roomId,
        label: value,
      });
      return { roomId: request.params.roomId, label };
    },
  );

  server.get(
    "/studio/agents",
    { config: { auth: auth.read() } },
    async (request) => {
      const scope = await studioScope(request);
      return {
        agents: await options.repository.listAgents(scope.organizationId),
      };
    },
  );

  server.get<{ Params: { id: string } }>(
    "/studio/agents/:id",
    { config: { auth: auth.read() } },
    async (request) => {
      const scope = await studioScope(request);
      return {
        agent: await options.repository.getAgent(
          scope.organizationId,
          request.params.id,
        ),
        commands: await options.repository.listCommands(
          scope.organizationId,
          request.params.id,
          100,
        ),
        events: await options.repository.listEvents(
          scope.organizationId,
          request.params.id,
          200,
        ),
      };
    },
  );

  server.patch<{ Params: { id: string }; Body: { name?: unknown } }>(
    "/studio/agents/:id",
    { config: { auth: auth.write() } },
    async (request) => {
      const scope = await studioScope(request);
      return {
        agent: await options.repository.renameAgent(
          scope.organizationId,
          request.params.id,
          request.body?.name,
          scope.userId,
        ),
      };
    },
  );

  server.post<{ Params: { id: string } }>(
    "/studio/agents/:id/revoke",
    { config: { auth: auth.write() } },
    async (request) => {
      const scope = await studioScope(request);
      await options.repository.revokeAgent(
        scope.organizationId,
        request.params.id,
        scope.userId,
      );
      options.gateway.revoke(request.params.id);
      return { revoked: true };
    },
  );

  server.delete<{ Params: { id: string } }>(
    "/studio/agents/:id",
    { config: { auth: auth.write() } },
    async (request) => {
      const scope = await studioScope(request);
      await options.repository.deleteRevokedAgent(
        scope.organizationId,
        request.params.id,
        scope.userId,
      );
      return { deleted: true };
    },
  );

  server.post<{ Params: { id: string }; Body: JsonObject }>(
    "/studio/agents/:id/commands",
    { config: { auth: auth.write() } },
    async (request, reply) => {
      const scope = await studioScope(request);
      const operation = text(request.body.operation);
      if (
        operation.startsWith("action.") ||
        !agentControlOperations.includes(operation as never)
      ) {
        return reply.code(400).send({
          code: "agent_operation_unsupported",
          error: "Unsupported agent operation",
          statusCode: 400,
        });
      }
      const payload = object(request.body.payload);
      const idempotencyKey = optionalText(request.body.idempotencyKey);
      if (delegatedRoomOperations.has(operation)) {
        const agent = await options.repository.getAgent(
          scope.organizationId,
          request.params.id,
        );
        if (!agent.capabilities.includes("rooms")) {
          return reply.code(409).send({
            code: "agent_rooms_unsupported",
            error: "The managed agent does not support Rooms.",
            statusCode: 409,
          });
        }
        const stableKey = idempotencyKey ?? randomUUID();
        // The managed Studio consumer receives Admin only so it can keep MLS
        // media state available. User-requested mutations still use the
        // organization's delegation to preserve the Studio actor and billing
        // context instead of impersonating the consumer agent.
        const target = await roomTarget(
          request,
          scope.organizationId,
        );
        const result = agent.capabilities.includes("studio-room-consumer")
          ? await target.coordinator.mutateOrganizationRoom(
              scope.organizationId,
              operation,
              payload,
              stableKey,
              target.token,
            )
          : await target.coordinator.mutateRoom(
              scope.organizationId,
              request.params.id,
              operation,
              payload,
              stableKey,
              target.token,
            );
        const command = await options.repository.recordDelegatedCommand({
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          agentId: request.params.id,
          operation: operation as (typeof agentControlOperations)[number],
          payload,
          result: delegatedCommandHistoryResult(operation, result),
          idempotencyKey: stableKey,
          requestedById: scope.userId,
        });
        return reply.code(202).send({
          command: { ...command, result },
          dispatched: true,
          delegated: true,
        });
      }
      const command = await options.repository.createCommand({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        agentId: request.params.id,
        operation: operation as (typeof agentControlOperations)[number],
        payload,
        idempotencyKey,
        requestedById: scope.userId,
        ttlSeconds: optionalNumber(request.body.ttlSeconds),
      });
      const dispatched = await options.gateway.dispatchAgent(request.params.id);
      return reply.code(202).send({ command, dispatched });
    },
  );

  server.get<{ Params: { id: string } }>(
    "/studio/agents/:id/commands",
    { config: { auth: auth.read() } },
    async (request) => {
      const scope = await studioScope(request);
      return {
        commands: await options.repository.listCommands(
          scope.organizationId,
          request.params.id,
        ),
      };
    },
  );

  server.get<{ Params: { id: string } }>(
    "/studio/agents/:id/events",
    { config: { auth: auth.read() } },
    async (request) => {
      const scope = await studioScope(request);
      return {
        events: await options.repository.listEvents(
          scope.organizationId,
          request.params.id,
        ),
      };
    },
  );
}

type ConsumerBootstrapConfig = {
  coordinator: CoordinatorRoomClient;
  coordinatorToken: string;
  organizationId: string;
  sharedSecret: string;
};

type ConsumerBootstrapDependencies = {
  instance?: ConsumerInstanceReader | null;
  roomService: typeof roomServiceForOrganization;
};

function consumerOrganization(dependencies: ConsumerBootstrapDependencies) {
  return resolveConsumerOrganization({
    configured: process.env.BEAM_STUDIO_CONSUMER_ORGANIZATION_ID,
    instance: dependencies.instance,
  });
}

/**
 * What the deployment's own room consumer bootstraps with, or why it cannot
 * yet. Every refusal is temporary and answered 503: no shared secret, no
 * owner organization yet (unclaimed), or no organization Beam API key yet.
 */
async function consumerBootstrapConfig(
  request: FastifyRequest,
  dependencies: ConsumerBootstrapDependencies,
): Promise<
  { ok: true; config: ConsumerBootstrapConfig } | ConsumerBootstrapRefusal
> {
  const sharedSecret = consumerSharedSecret();
  if (!sharedSecret) {
    return {
      ok: false,
      code: "consumer_bootstrap_unavailable",
      error: "Studio consumer bootstrap is not configured.",
    };
  }
  const organization = await consumerOrganization(dependencies);
  if (!organization.ok) return organization;
  const { organizationId } = organization;
  const template = await selectedRoomTemplate(request, organizationId);
  let service: Awaited<ReturnType<typeof roomServiceForOrganization>>;
  try {
    service = await dependencies.roomService(organizationId, template);
  } catch (error) {
    if (
      (error as { code?: unknown }).code !== "room_authority_key_unavailable"
    ) {
      throw error;
    }
    // Not fatal for the consumer: it enrolls once the owner stores a key.
    return {
      ok: false,
      code: "room_authority_key_unavailable",
      error: (error as Error).message,
    };
  }
  const target = coordinatorTarget(template, service);
  return {
    ok: true,
    config: {
      coordinator: target.coordinator,
      coordinatorToken: target.token,
      organizationId,
      sharedSecret,
    },
  };
}

/** The bootstrap configuration for room reconciliation, when there is one. */
async function optionalConsumerBootstrapConfig(
  request: FastifyRequest,
  dependencies: ConsumerBootstrapDependencies,
) {
  const resolved = await consumerBootstrapConfig(request, dependencies);
  return resolved.ok ? resolved.config : null;
}

async function refreshJoinedConsumerRooms(
  config: ConsumerBootstrapConfig,
  consumer: AttachableRoomConsumer,
  consumers: RoomConsumerAttacher,
) {
  // Reconnect refreshes existing memberships only. A new identity must not gain
  // access to every existing organization room merely by enrolling.
  const listed = await config.coordinator.listRooms(
    config.organizationId,
    consumer.id,
    config.coordinatorToken,
  );
  const rooms = array(listed.rooms).filter(
    (room) => !listedRoomIsClosed(room) && Boolean(roomIdentifier(room)),
  );
  await Promise.all(
    rooms.map((room) => {
      const roomId = roomIdentifier(room)!;
      return consumers.attach({
        coordinator: config.coordinator,
        token: config.coordinatorToken,
        organizationId: config.organizationId,
        roomId,
        consumer,
        idempotencyKey: `studio-consumer:${consumer.id}:${roomId}`,
      });
    }),
  );
}

/** Tells the browser why the room consumer cannot serve the channel. */
function closeWithRoomConsumerError(
  socket: {
    send(data: string): void;
    close(code: number, reason: string): void;
  },
  error: RoomConsumerError,
) {
  socket.send(
    JSON.stringify({
      type: "channel.error",
      payload: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      },
    }),
  );
  socket.close(1013, webSocketCloseReason(error.message));
}

/** WebSocket close reasons are limited to 123 UTF-8 bytes. */
function webSocketCloseReason(value: string) {
  let reason = value;
  while (Buffer.byteLength(reason) > 123) reason = reason.slice(0, -1);
  return reason;
}

function sameSecret(presented: string, expected: string) {
  const left = createHash("sha256").update(presented).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

export function delegatedCommandHistoryResult(
  operation: string,
  result: JsonObject,
) {
  if (operation !== "room.invitation.create") return result;
  const invitation = object(result.invitation);
  return {
    ...result,
    invitation: {
      ...invitation,
      invitation_token: "[REDACTED]",
    },
  };
}

export async function studioScope(request: FastifyRequest) {
  const session = studioRequestSession(request);
  const organizationId = studioRequestOrganizationId(request);
  if (!session) throw forbidden("studio_session_required");
  if (!organizationId) throw forbidden("organization_required");
  // The static coordinator token used to stand in here when the request had a
  // session but no services, which only the dev bypass produced. README states
  // that user-initiated room control uses the user's own Beam Auth session
  // bearer and has no static credential; now it always does.
  const accessToken = await studioRequestAuth(request).oauth.getAccessToken();
  return {
    organizationId,
    projectId: studioRequestProjectId(request),
    userId: session.userId,
    accessToken,
  };
}

function forbidden(code: string) {
  return Object.assign(new Error("Studio authorization failed."), {
    code,
    statusCode: 403,
  });
}

function bearerToken(value: string | undefined) {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function header(request: FastifyRequest, name: string) {
  const value = request.headers[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function array(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is JsonObject =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function roomIdentifier(value: JsonObject) {
  const room = object(value.room);
  return optionalText(room.room_id) ?? optionalText(value.room_id);
}

export function listedRoomIsClosed(value: unknown) {
  const listedRoom = object(value);
  const room = object(listedRoom.room);
  return (
    (
      optionalText(room.state) ?? optionalText(listedRoom.state)
    )?.toLowerCase() === "closed"
  );
}

function text(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error("A required text value is missing."), {
      code: "invalid_request",
      statusCode: 400,
    });
  }
  return value.trim();
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function textArray(value: unknown) {
  return [
    ...new Set(
      Array.isArray(value)
        ? value
            .filter(
              (item): item is string =>
                typeof item === "string" && Boolean(item.trim()),
            )
            .map((item) => item.trim())
        : [],
    ),
  ];
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

type RoomTarget = {
  coordinator: CoordinatorRoomClient;
  token: string;
  template: BeamEnvironmentTemplate;
};

/** User-initiated room operations act with the user's own session bearer. */
async function roomTarget(
  request: FastifyRequest,
  organizationId: string,
): Promise<RoomTarget> {
  const template = await selectedRoomTemplate(request, organizationId);
  const service = await roomServiceForRequest(request, template);
  return coordinatorTarget(template, service);
}

/** Consumer bootstrap has no user session and keeps the static service token. */
function coordinatorTarget(
  template: BeamEnvironmentTemplate,
  service: { client: CoordinatorRoomClient; token: string },
): RoomTarget {
  return { coordinator: service.client, token: service.token, template };
}

async function selectedRoomTemplate(
  request: FastifyRequest,
  organizationId: string,
) {
  return resolveBeamEnvironmentTemplate({
    organizationId,
    templateKey: selectedTemplateKey(request),
  });
}

function selectedTemplateKey(request: FastifyRequest) {
  const headerValue = request.headers["x-beam-environment-template"];
  if (typeof headerValue === "string") return headerValue;
  const query = request.query as Record<string, unknown> | undefined;
  return typeof query?.environmentTemplateKey === "string"
    ? query.environmentTemplateKey
    : null;
}
