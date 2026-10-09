import { settleRouteAuth } from "../auth/kernel.js";
import { auth } from "../auth/policy.js";
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  pgOne,
  WorkflowAuthorizationError,
  WorkflowAuthorityUnavailableError,
  workflowAuthorityTransportCode,
  workflowAuthorityUrl,
  assertWorkflowReferencesAvailablePg,
  type PgPool,
} from "@beam-studio/db";
import {
  resolveActionRoomContext,
  resolveWorkflowRoomContext,
  roomWorkflowConfigSchema,
} from "@beam-studio/shared";
import { roomServiceForOrganization } from "../agent-control/room-service.js";
import {
  executionBeamApiKey,
  resolveBeamEnvironmentTemplate,
} from "./store.js";
import { roomMemberCan } from "../agent-control/room-workflow-options.js";
import { ensureWorkflowBillingReserved } from "../billing/workflow-billing.js";
import { freezeRegistryArtifactUrl } from "./registry-artifact-url.js";
import { webEnv } from "../env.js";
import { workflowAccountApiUrl, workflowManagedEnvironment } from "./workflow-account-authority.js";
import { parseMcpScopes } from "@beam-studio/shared";
import {
  parseWorkflowReferences,
  workflowActionEnvironment,
} from "@beam-studio/core";

type Row = Record<string, any>;
const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value : []);
function deny(code: string, message = code): never {
  throw new WorkflowAuthorizationError(code, message);
}

export async function assertWorkflowExecutionAuthorized(
  pool: PgPool,
  run: Row,
  stepId?: string,
  task?: Row,
) {
  const context = object(run.execution_context_json);
  let roomSnapshot: Row | null = null;
  if (context.mcpTokenId) {
    const token = await pgOne<Row>(
      pool,
      `SELECT scopes_json FROM mcp.tokens WHERE id=$1 AND organization_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())`,
      [context.mcpTokenId, run.organization_id],
    );
    if (
      !token ||
      !parseMcpScopes(JSON.stringify(token.scopes_json)).includes(
        "run:transfers",
      )
    )
      deny("execution_mcp_grant_revoked");
  }
  const snapshot = object(run.template_snapshot_json);
  let referenceDefinition = object(snapshot.workflowTemplate);
  let projectId = run.project_id ?? null;
  let room = resolveWorkflowRoomContext(null, context.room);
  const step = stepId
    ? rows(run.resolved_steps_json).find((step) => step.id === stepId)
    : null;
  if (stepId && !step) deny("execution_step_missing");
  if (step?.kind === "workflow") {
    const child = object(object(snapshot.dependencies)[step.calledWorkflowId]);
    if (child.organizationId !== run.organization_id)
      deny("execution_child_scope_denied");
    projectId = child.projectId ?? null;
    referenceDefinition = object(object(child.snapshot).workflowTemplate);
    room = resolveWorkflowRoomContext(
      room,
      object(object(child.snapshot).workflowTemplate).room,
    );
  } else if (step) {
    room = resolveActionRoomContext({
      workflowRoom: room,
      actionRoom:
        step.executionTarget?.kind === "room-member"
          ? step.executionTarget.room
          : undefined,
      actionPackage: String(step.actionPackage),
      config: object(step.config),
    }).room;
  }
  const credentialId = object(context.billing).apiKeyId;
  if (!credentialId)
    deny(
      "execution_credential_missing",
      "The frozen run has no execution credential. Run the current definition with a selected Beam key.",
    );
  // The run's own key is the only authority Beam accepts for this check; the
  // organization and its current permissions are taken from it.
  const apiKey = await executionBeamApiKey(pool, {
    credentialId,
    organizationId: run.organization_id,
    projectId,
  });
  if (!apiKey)
    deny(
      "execution_credential_revoked",
      "The execution credential is unavailable, expired, revoked, outside the project, or holds no Beam API key.",
    );
  let environments: Array<string | null>;
  try {
    const actionEnvironment = workflowActionEnvironment(
      context,
      step,
      object(task?.input_json),
    );
    environments = room
      ? [
          ...new Set([
            room.environmentTemplateKey,
            ...(step?.actionPackage === "@beam/transfer"
              ? [actionEnvironment]
              : []),
          ]),
        ]
      : [actionEnvironment];
  } catch (error) {
    deny(
      "execution_environment_unavailable",
      error instanceof Error
        ? error.message
        : "Frozen execution environment is unavailable.",
    );
  }
  const accountApiUrl = workflowAccountApiUrl(run);
  const managedEnvironment = workflowManagedEnvironment(run);
  for (const environment of environments) {
    if (managedEnvironment && environment !== managedEnvironment)
      deny("managed_qualification_environment_denied");
    const authorityUrl = workflowAuthorityUrl(
      "/v1/workflow-execution/authorize",
      accountApiUrl,
    );
    let response: Response;
    try {
      response = await fetch(authorityUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          projectId,
          initiatingPrincipalId: context.initiatingPrincipalId ?? null,
          environment,
          permission:
            step && step.kind !== "workflow"
              ? "actions:execute"
              : "workflows:run",
        }),
        signal: AbortSignal.timeout(8_000),
        redirect: "error",
      });
    } catch (error) {
      throw new WorkflowAuthorityUnavailableError(
        "execution_authority_unavailable",
        "Current account permissions could not be checked.",
        workflowAuthorityTransportCode(error),
      );
    }
    const authorization = (await response!
      .json()
      .catch(() => null)) as Row | null;
    if (
      response.status === 429 ||
      response.status >= 500 ||
      (response.ok && typeof authorization?.authorized !== "boolean")
    )
      throw new WorkflowAuthorityUnavailableError();
    if (!response!.ok || authorization?.authorized !== true)
      deny(
        String(authorization?.code ?? "execution_authority_unavailable"),
        "Current account permissions do not allow this execution.",
      );
  }
  await assertWorkflowReferencesAvailablePg(
    pool,
    parseWorkflowReferences(
      referenceDefinition.agentBindings ?? {},
      referenceDefinition.resourceBindings ?? {},
    ),
    String(run.organization_id),
    projectId,
  );
  if (step && step.kind !== "workflow") {
    const current = await pgOne<Row>(
      pool,
      `SELECT p.status AS package_status,p.trust_level,v.status,v.validation_status,v.manifest_checksum,v.artifact_checksum
      FROM actions.packages p JOIN actions.package_versions v ON v.package_id=p.id WHERE p.package_name=$1 AND v.version=$2
      AND (p.organization_id IS NULL OR p.organization_id=$3)`,
      [step.actionPackage, step.resolvedVersion, run.organization_id],
    );
    if (
      !current ||
      current.package_status === "blocked" ||
      current.trust_level === "blocked" ||
      !["active", "deprecated"].includes(current.status) ||
      ["rejected", "blocked"].includes(current.validation_status)
    )
      deny(
        "execution_action_revoked",
        "The action version is unavailable or blocked by current trust policy.",
      );
    if (
      current.manifest_checksum !== (step.manifestChecksum ?? step.checksum) ||
      current.artifact_checksum !== step.artifactChecksum
    )
      deny("execution_action_integrity_changed");
    if (step.executionLocationId) {
      const target = await pgOne<Row>(
        pool,
        "SELECT id FROM runtime.execution_locations WHERE id=$1 AND organization_id=$2 AND enabled=true AND (project_id IS NULL OR project_id=$3)",
        [step.executionLocationId, run.organization_id, projectId],
      );
      if (!target) deny("execution_target_revoked");
    }
    await assertReferencedCredentials(
      pool,
      run,
      step,
      object(task?.input_json),
    );
  }
  if (room) {
    let live: Row;
    try {
      const template = await resolveBeamEnvironmentTemplate({
        templateKey: room.environmentTemplateKey,
        organizationId: run.organization_id,
      });
      if (template.key !== room.environmentTemplateKey)
        deny("execution_room_environment_missing");
      const service = await roomServiceForOrganization(
        String(run.organization_id),
        template,
        runBillingApiKeyId(run),
      );
      live = await service.client.organizationRoomSnapshot(
        String(run.organization_id),
        room.roomId,
        service.token,
        true,
      );
    } catch (error) {
      if (error instanceof WorkflowAuthorizationError) throw error;
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 401 || status === 403 || status === 404)
        deny("execution_room_access_revoked");
      throw new WorkflowAuthorityUnavailableError(
        "execution_room_authority_unavailable",
        "Current room permissions could not be checked.",
        workflowAuthorityTransportCode(error),
      );
    }
    roomSnapshot = live;
    if (object(live.room).state !== "active")
      deny("execution_room_inactive", "The workflow room is no longer active.");
    if (step?.actionPackage === "@beam/room-transfer") {
      const config = roomWorkflowConfigSchema.parse(
        resolveActionRoomContext({
          workflowRoom: room,
          actionPackage: step.actionPackage,
          config: object(step.config),
        }).config,
      );
      if (
        !roomMemberCan(
          live,
          room.roomId,
          config.channelId,
          config.source.memberId,
          "publish",
        )
      )
        deny(
          "execution_room_publish_revoked",
          "The source member is no longer allowed to publish in this channel.",
        );
      for (const member of config.targetMemberIds)
        if (
          !roomMemberCan(
            live,
            room.roomId,
            config.channelId,
            member,
            "subscribe",
          )
        )
          deny(
            "execution_room_recipient_revoked",
            "A selected recipient is no longer allowed to receive this exchange.",
          );
    }
  }
  return { room, roomSnapshot };
}

async function assertReferencedCredentials(
  pool: PgPool,
  run: Row,
  step: Row,
  inputs: Row,
) {
  const requirements = rows(
    object(object(step.manifestSnapshot).catalog).credentialRequirements,
  );
  const ids = new Set<string>();
  for (const requirement of requirements)
    for (const path of rowsOrStrings(requirement.configPaths)) {
      let values: unknown[] = [{ config: object(step.config), inputs }];
      for (const part of path.split(".")) {
        const wildcard = part.endsWith("[*]");
        const key = wildcard ? part.slice(0, -3) : part;
        values = values.flatMap((value) => {
          const next = object(value)[key];
          return wildcard ? (Array.isArray(next) ? next : []) : [next];
        });
      }
      for (const value of values)
        if (typeof value === "string" && value) ids.add(value);
    }
  if (!ids.size) return;
  const valid = await pool.query<{ id: string }>(
    `SELECT c.id FROM secrets.credentials c WHERE c.id=ANY($1::text[]) AND c.organization_id=$2
    AND c.status='active' AND (c.expires_at IS NULL OR c.expires_at>now()) AND (c.project_id IS NULL OR c.project_id=$3)
    AND EXISTS(SELECT 1 FROM secrets.credential_versions v WHERE v.credential_id=c.id AND v.status='active' AND v.revoked_at IS NULL)`,
    [[...ids], run.organization_id, run.project_id],
  );
  if (valid.rows.length !== ids.size)
    deny("execution_resource_credential_revoked");
}
function rowsOrStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function registerWorkflowExecutionAuthorizationRoutes(
  server: FastifyInstance,
  pool: PgPool,
  reserveBilling = ensureWorkflowBillingReserved,
  freezeArtifactUrl = freezeRegistryArtifactUrl,
) {
  for (const kind of ["runs", "tasks"] as const)
    server.post<{
      Params: { id: string };
      Body: {
        stepId?: string;
        phase?: string;
        inputs?: Record<string, unknown>;
        artifactUrl?: boolean;
      };
    }>(
      `/internal/workflow-${kind}/:id/authorize`,
      {
        config: {
          auth: auth.capability(`/internal/workflow-${kind}/:id/authorize`),
        },
      },
      async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const result =
          kind === "runs"
            ? await pgOne<Row>(
                pool,
                `SELECT r.id,r.workflow_template_id,r.organization_id,r.project_id,r.status,r.execution_context_json,r.resolved_steps_json,
              CASE WHEN $2::text IS NULL THEN jsonb_build_object('workflowTemplate',r.template_snapshot_json->'workflowTemplate')
                ELSE r.template_snapshot_json END AS template_snapshot_json,
              c.authorization_token AS presented_capability FROM execution.workflow_runs r JOIN execution.workflow_run_capabilities c ON c.workflow_run_id=r.id WHERE r.id=$1`,
                [request.params.id, request.body?.stepId ?? null],
              )
            : await pgOne<Row>(
                pool,
                `SELECT r.id,r.workflow_template_id,r.organization_id,r.project_id,r.status,r.execution_context_json,r.resolved_steps_json,r.template_snapshot_json,
              t.claim_token AS presented_capability,t.id AS task_id,t.workflow_step_id,t.input_json AS task_input,t.status AS task_status,t.lease_expires_at,
          (a.cleanup_confirmed_at IS NULL AND a.cancel_requested_at IS NULL AND a.lease_expires_at>clock_timestamp()) AS assignment_active,
          (a.backend<>'studio' OR EXISTS(SELECT 1 FROM runtime.worker_runtime_state runner
            WHERE runner.worker_id=a.executor_id AND runner.status IN ('active','draining')
            AND runner.heartbeat_at>=clock_timestamp()-interval '30 seconds'
            AND (runner.organization_id IS NULL OR runner.organization_id=r.organization_id)
            AND (runner.project_id IS NULL OR runner.project_id=r.project_id))) AS execution_target_authorized
          FROM execution.workflow_tasks t JOIN execution.workflow_runs r ON r.id=t.workflow_run_id
          JOIN execution.executor_assignments a ON a.task_id=t.id AND a.attempt=t.attempt_count WHERE t.id=$1`,
                [request.params.id],
              );
        const expected = Buffer.from(
          String(result?.presented_capability ?? ""),
        );
        const presented = Buffer.from(
          String(request.headers.authorization ?? "").replace(/^Bearer /, ""),
        );
        if (
          !result ||
          !expected.length ||
          expected.length !== presented.length ||
          !timingSafeEqual(expected, presented)
        )
          return reply
            .code(403)
            .send({ authorized: false, code: "execution_capability_invalid" });
        settleRouteAuth(request);
        if (kind === "tasks" && !result.execution_target_authorized)
          return reply
            .code(403)
            .send({ authorized: false, code: "execution_target_revoked" });
        const allowedStatuses =
          kind === "runs" && request.body?.phase === "retry"
            ? ["running", "failed", "cancelled", "dead_letter"]
            : ["queued", "running"];
        if (
          !allowedStatuses.includes(result.status) ||
          (kind === "tasks" &&
            (result.task_status !== "running" ||
              !result.assignment_active ||
              !result.lease_expires_at ||
              new Date(result.lease_expires_at).getTime() <= Date.now()))
        )
          return reply.code(403).send({
            authorized: false,
            code: "execution_lease_expired_or_cancelled",
          });
        try {
          const stepId =
            kind === "tasks"
              ? String(result.workflow_step_id)
              : request.body?.stepId;
          await assertWorkflowExecutionAuthorized(pool, result, stepId, {
            input_json:
              kind === "tasks" ? result.task_input : request.body?.inputs,
          });
          // Signed before billing so a refused artifact reserves nothing.
          const step =
            request.body?.phase === "dispatch" &&
            request.body?.artifactUrl === true &&
            stepId
              ? (result.resolved_steps_json as Row[] | undefined)?.find(
                  (candidate) => candidate.id === stepId,
                )
              : undefined;
          const artifactUrl = step
            ? await freezeArtifactUrl(result, step)
            : null;
          if (["dispatch", "child_launch"].includes(request.body?.phase ?? ""))
            await reserveBilling(pool, String(result.id));
          return artifactUrl
            ? { authorized: true, artifactUrl }
            : { authorized: true };
        } catch (error) {
          if (!(error instanceof WorkflowAuthorizationError))
            request.log.warn(
              {
                code: "execution_authority_unavailable",
                transportCode:
                  error instanceof WorkflowAuthorityUnavailableError
                    ? error.transportCode
                    : undefined,
                phase: request.body?.phase,
              },
              "Execution authority unavailable",
            );
          return reply
            .code(error instanceof WorkflowAuthorizationError ? 403 : 503)
            .send({
              authorized: false,
              code:
                error instanceof WorkflowAuthorizationError ||
                error instanceof WorkflowAuthorityUnavailableError
                  ? error.code
                  : "execution_authority_unavailable",
              error:
                error instanceof WorkflowAuthorizationError ||
                error instanceof WorkflowAuthorityUnavailableError
                  ? error.message
                  : "Execution authority is unavailable.",
              retryable: !(error instanceof WorkflowAuthorizationError),
            });
        }
      },
    );
}

function runBillingApiKeyId(run: Row) {
  const billing = (run.execution_context_json as Row | undefined)?.billing as
    | Row
    | undefined;
  return typeof billing?.apiKeyId === "string" ? billing.apiKeyId : null;
}
