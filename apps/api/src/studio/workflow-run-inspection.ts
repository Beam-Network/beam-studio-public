import {
  resolveActionRoomContext,
  roomWorkflowConfigSchema,
} from "@beam-studio/shared";
import { roomServiceForOrganization } from "../agent-control/room-service.js";
import { getWorkflowRun, resolveBeamEnvironmentTemplate } from "./store.js";
import { organizationScope } from "./repositories/organization-scope.js";

type Bundle = NonNullable<Awaited<ReturnType<typeof getWorkflowRun>>>;
type RoomServiceResolver = (
  organizationId: string,
  template: Awaited<ReturnType<typeof resolveBeamEnvironmentTemplate>>,
) => RoomAccess | Promise<RoomAccess>;
type RoomAccess = Pick<
  Awaited<ReturnType<typeof roomServiceForOrganization>>,
  "client" | "token"
>;
const dependencies = {
  getWorkflowRun,
  resolveBeamEnvironmentTemplate,
  roomService: roomServiceForOrganization as RoomServiceResolver,
};

// Diagnostics are refreshed only on inspection. Never rewrite committed action
// results, public workflow output, snapshots, or authoritative settlement.
// Route callers pass a request-bound resolver so the Coordinator is read with
// the user's session bearer; MCP callers use an organization Beam API key.
export async function inspectWorkflowRun(
  id: string,
  organizationId: string | null | undefined,
  overrides: Partial<typeof dependencies> = {},
) {
  const deps = { ...dependencies, ...overrides };
  const scope = organizationScope(organizationId);
  const bundle = await deps.getWorkflowRun(id, scope.organizationId);
  if (!bundle || bundle.run.organizationId !== scope.organizationId)
    return null;
  const stepRuns: Bundle["stepRuns"] = [];
  // Bound coordinator concurrency independently of the number of composed steps.
  for (let offset = 0; offset < bundle.stepRuns.length; offset += 4) {
    stepRuns.push(
      ...(await Promise.all(
        bundle.stepRuns.slice(offset, offset + 4).map(async (step) => {
          if (step.actionPackageName !== "@beam/room-transfer") return step;
          const frozen = bundle.steps.find(
            (candidate) => candidate.id === step.workflowStepId,
          );
          const state = step.state as Record<string, unknown>;
          const publicationId =
            typeof state.publicationId === "string" ? state.publicationId : "";
          if (!publicationId) return step;
          const inspectedAt = new Date().toISOString();
          const unavailable = (status: string) => ({
            ...step,
            state: {
              ...state,
              execution: null,
              executionInspection: { status, inspectedAt },
            },
          });
          try {
            if (!frozen) return unavailable("binding_unavailable");
            const config = roomWorkflowConfigSchema.parse(
              resolveActionRoomContext({
                workflowRoom: bundle.run.room,
                actionPackage: "@beam/room-transfer",
                config: frozen.config,
              }).config,
            );
            // A publication can only be read through its committed room binding.
            if (
              ["environmentTemplateKey", "roomId", "channelId"].some(
                (key) =>
                  state[key] !== undefined &&
                  state[key] !== config[key as keyof typeof config],
              )
            )
              return unavailable("binding_mismatch");
            const template = await deps.resolveBeamEnvironmentTemplate({
              organizationId: scope.organizationId,
              templateKey: config.environmentTemplateKey,
            });
            if (template.key !== config.environmentTemplateKey)
              return unavailable("binding_mismatch");
            const service = await deps.roomService(
              scope.organizationId,
              template,
            );
            const response = await service.client.organizationObjectExecution(
              scope.organizationId,
              config.roomId,
              config.channelId,
              publicationId,
              service.token,
            );
            const execution = response.execution as
              | Record<string, unknown>
              | undefined;
            if (
              !execution ||
              (execution.publication_id &&
                execution.publication_id !== publicationId)
            ) {
              return unavailable("pending");
            }
            return {
              ...step,
              state: {
                ...state,
                execution,
                executionInspection: {
                  status:
                    Array.isArray(execution.attempts) &&
                    execution.attempts.length
                      ? "current"
                      : "pending",
                  inspectedAt,
                },
              },
            };
          } catch (error) {
            const status = (error as { statusCode?: number }).statusCode;
            // Errors may contain provider details; expose only a stable diagnostic.
            return unavailable(
              status === 401 || status === 403
                ? "access_denied"
                : "unavailable",
            );
          }
        }),
      )),
    );
  }
  return { ...bundle, stepRuns };
}
