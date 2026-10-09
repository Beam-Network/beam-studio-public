import { settleRouteAuth } from "../auth/kernel.js";
import { auth } from "../auth/policy.js";
import { inspectWorkflowRun } from "./workflow-run-inspection.js";
import { roomServiceForOrganization } from "../agent-control/room-service.js";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PgPool } from "@beam-studio/db";
import {
  MCP_TOOL_SCOPE_REQUIREMENTS,
  parseMcpScopes,
} from "@beam-studio/shared";
import {
  createRoomWorkflow,
  retryBilledWorkflow,
  runBilledWorkflow,
} from "./room-workflows.js";
import { cancelWorkflowRun, resolveBeamEnvironmentTemplate } from "./store.js";
import { createWorkflowTemplate, getWorkflowTemplate } from "./store.js";
import { saveWorkflowGraph } from "./workflow-graph-authoring.js";
import type { AgentControlRepository } from "../agent-control/repository.js";
import {
  attachStorageMember,
  listStorageMembers,
  removeStorageMember,
  updateStorageMember,
} from "../agent-control/room-storage-binding-service.js";

// The API verifies the original MCP bearer on every request. A token ID or
// caller-supplied organization header is never an execution authority.
export function registerWorkflowMcp(
  server: FastifyInstance,
  pool: PgPool,
  agents: AgentControlRepository,
) {
  server.post<{ Params: { tool: string }; Body: Record<string, any> }>(
    "/mcp/workflows/:tool",
    { config: { auth: auth.mcpPerTool() } },
    async (request, reply) => {
      const tools = new Set([
        "beam.list_rooms",
        "beam.list_room_storage_members",
        "beam.attach_room_storage_member",
        "beam.update_room_storage_member",
        "beam.remove_room_storage_member",
        "beam.create_room_workflow",
        "beam.create_workflow",
        "beam.get_workflow",
        "beam.update_workflow_graph",
        "beam.run_workflow",
        "beam.retry_workflow_run",
        "beam.get_workflow_run",
        "beam.cancel_workflow_run",
      ]);
      const tool = request.params.tool;
      if (!tools.has(tool))
        return reply.code(404).send({ error: "Unknown workflow tool." });
      const bearer = String(request.headers.authorization ?? "").replace(
        /^Bearer /,
        "",
      );
      const result = await pool.query<{
        id: string;
        organization_id: string;
        scopes_json: unknown;
      }>(
        `SELECT id, organization_id, scopes_json FROM mcp.tokens
      WHERE token_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
        [createHash("sha256").update(bearer).digest("hex")],
      );
      const token = result.rows[0];
      const required = MCP_TOOL_SCOPE_REQUIREMENTS[tool]!;
      if (
        !token ||
        !required.every((scope) =>
          parseMcpScopes(JSON.stringify(token.scopes_json)).includes(scope),
        )
      )
        return reply.code(403).send({ error: "MCP scope required." });
      settleRouteAuth(request);
      const organizationId = token.organization_id,
        input = request.body;
      switch (tool) {
        case "beam.create_workflow":
          return {
            id: await createWorkflowTemplate({
              organizationId,
              name: String(input.name ?? "Workflow"),
              description: optionalText(input.description),
              apiKeyId: optionalText(input.apiKeyId),
              room: input.room,
            }),
          };
        case "beam.get_workflow":
          return getWorkflowTemplate(String(input.workflowId), organizationId);
        case "beam.update_workflow_graph":
          return saveWorkflowGraph({
            organizationId,
            workflowTemplateId: String(input.workflowId),
            body: input,
          });
        case "beam.create_room_workflow":
          return createRoomWorkflow({
            organizationId,
            name: String(input.name ?? "Room transfer"),
            apiKeyId: String(input.apiKeyId ?? ""),
            requestId: String(input.requestId ?? ""),
            config: input.config,
          });
        case "beam.run_workflow":
          return runBilledWorkflow(
            String(input.workflowId),
            organizationId,
            input.input ?? {},
            { mcpTokenId: token.id },
          );
        case "beam.retry_workflow_run":
          return retryBilledWorkflow(String(input.runId), organizationId);
        case "beam.get_workflow_run":
          return inspectWorkflowRun(String(input.runId), organizationId);
        case "beam.cancel_workflow_run":
          await cancelWorkflowRun(String(input.runId), organizationId);
          return { cancelRequested: true };
        case "beam.list_rooms": {
          const template = await resolveBeamEnvironmentTemplate({
            organizationId,
            templateKey: optionalText(input.environmentTemplateKey),
          });
          const { client, token } = await roomServiceForOrganization(
            organizationId,
            template,
          );
          const listed = await client.listOrganizationRooms(
            organizationId,
            token,
          );
          const rooms = await Promise.all(
            (listed.rooms ?? [])
              .filter(
                (room) =>
                  String(
                    room.state ??
                      (room.room as Record<string, unknown>)?.state ??
                      "",
                  ).toLowerCase() !== "closed",
              )
              .map((room) =>
                client.organizationRoomSnapshot(
                  organizationId,
                  String(
                    room.room_id ??
                      (room.room as Record<string, unknown>)?.room_id,
                  ),
                  token,
                ),
              ),
          );
          return {
            environmentTemplateKey: template.key,
            rooms,
            agents: await agents.listAgents(organizationId),
          };
        }
        case "beam.list_room_storage_members": {
          const target = await storageTarget(organizationId, input);
          return {
            environmentTemplateKey: target.templateKey,
            bindings: await listStorageMembers({
              organizationId,
              roomId: String(input.roomId),
              target,
            }),
          };
        }
        case "beam.attach_room_storage_member": {
          const target = await storageTarget(organizationId, input);
          return attachStorageMember({
            organizationId,
            roomId: String(input.roomId),
            target,
            value: storageBindingInput(input),
          });
        }
        case "beam.update_room_storage_member": {
          const target = await storageTarget(organizationId, input);
          return {
            binding: await updateStorageMember({
              organizationId,
              roomId: String(input.roomId),
              bindingId: String(input.bindingId),
              target,
              value: storageBindingUpdate(input),
            }),
          };
        }
        case "beam.remove_room_storage_member": {
          const target = await storageTarget(organizationId, input);
          await removeStorageMember({
            organizationId,
            roomId: String(input.roomId),
            bindingId: String(input.bindingId),
            target,
          });
          return { removed: true };
        }
      }
    },
  );
}

async function storageTarget(
  organizationId: string,
  input: Record<string, any>,
) {
  const template = await resolveBeamEnvironmentTemplate({
    organizationId,
    templateKey: optionalText(input.environmentTemplateKey),
  });
  const service = await roomServiceForOrganization(organizationId, template);
  return {
    coordinator: service.client,
    token: service.token,
    templateKey: template.key,
  };
}

function storageBindingInput(input: Record<string, any>) {
  return {
    credentialId: input.credentialId,
    bucket: input.bucket,
    displayName: input.displayName,
    objectChannelIds: input.objectChannelIds,
    destinationPrefix: input.destinationPrefix,
    destinationLayout: input.destinationLayout,
    collisionPolicy: input.collisionPolicy,
    sourceDelegateMemberIds: input.sourceDelegateMemberIds,
    sourceDelegateRoleIds: input.sourceDelegateRoleIds,
    roleIds: input.roleIds,
  };
}

function storageBindingUpdate(input: Record<string, any>) {
  return {
    displayName: input.displayName,
    destinationPrefix: input.destinationPrefix,
    destinationLayout: input.destinationLayout,
    collisionPolicy: input.collisionPolicy,
    sourceDelegateMemberIds: input.sourceDelegateMemberIds,
    sourceDelegateRoleIds: input.sourceDelegateRoleIds,
  };
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredText(value: unknown, label: string) {
  const result = optionalText(value);
  if (result) return result;
  const error = new Error(`${label} is required.`) as Error & {
    statusCode: number;
  };
  error.statusCode = 400;
  throw error;
}
