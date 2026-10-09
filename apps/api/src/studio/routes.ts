import { opsAuthToken } from "@beam-studio/shared/ops-auth";
import { settleRouteAuth } from "../auth/kernel.js";
import { auth } from "../auth/policy.js";
import { studioSecureCookies } from "../env.js";
import { WorkflowReadRepository } from "./repositories/workflow-read-repository.js";
import { WorkflowHierarchyRepository } from "./repositories/workflow-hierarchy-repository.js";
import { WorkflowLayoutRepository } from "./repositories/workflow-layout-repository.js";
import { inspectWorkflowRun } from "./workflow-run-inspection.js";
import { readWorkflowArtifactContent } from "./workflow-artifact-content.js";
import { randomUUID } from "node:crypto";
import { CredentialRepository } from "./repositories/credential-repository.js";
import { McpTokenRepository } from "./repositories/mcp-token-repository.js";
import { organizationScope } from "./repositories/organization-scope.js";
import {
  encryptString,
  decryptString,
  vaultSecretFromEnv,
} from "@beam-studio/vault";
import { studioSessionFromMe } from "../auth/session.js";
import {
  AssistantRequestRepository,
  AssistantRequestWorker,
  requestSummary,
} from "./assistant-requests.js";
import { studioScope } from "../agent-control/routes.js";
import {
  fetchBudgetAlerts,
  mostUrgentAlert,
} from "../billing/budget-alerts-client.js";
import {
  assertRoomWorkflowRunServicesAvailable,
  assertRoomWorkflowServicesAvailable,
  createRoomWorkflow,
} from "./room-workflows.js";
import { roomServiceForRequest } from "../agent-control/room-service.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  STUDIO_SESSION_COOKIE,
  STUDIO_SESSION_MAX_AGE_SECONDS,
} from "../auth/browser-session.js";

/** Carries the bytes a webhook signature is computed over. */
type RawBodyRequest = FastifyRequest & { rawBody?: string };
import {
  readOrchestrationDatabaseConfig,
  type PgPool,
} from "@beam-studio/db";
import {
  redactAssistantPayload,
  type AssistantModelOption,
  type AssistantOperationPlan,
  type AssistantReasoningEffort,
  mergeCredentialPayload,
  safeCredentialPayload,
  templateKeyFromValue,
} from "@beam-studio/shared";
import { createApiLogger } from "../logging.js";
import { webEnv } from "../env.js";
import {
  StudioSessionManager,
  STUDIO_LOGIN_COOKIE,
  studioCookie,
} from "../auth/session-manager.js";
import { registerInstanceAccessRoutes } from "./instance-access-routes.js";
import {
  createInstanceKeyService,
  type InstanceKeyService,
} from "./instance-key.js";
import {
  machineCallerAdmission,
  type InstanceAdmission,
} from "../auth/instance-admission.js";
import {
  studioRequestSession,
  studioRequestAuth,
  studioRequestOrganizationId,
  studioRequestProjectId,
} from "../auth/request-context.js";
import type { BeamApiClient } from "../auth/beam-api-client.js";
import {
  assertCredentialProvider,
  cancelRun,
  cancelWorkflowRun,
  cancelWorkflowDynamicRegion,
  createApiKey,
  createCredential,
  createEndpoint,
  createExecutionLocation,
  createSchedule,
  createTransfer,
  createWorkflowTemplate,
  dashboardSummary,
  deleteApiKey,
  deleteBeamEnvironmentTemplate,
  deleteEndpoint,
  deleteSchedule,
  deleteTransfer,
  deleteWorkflowTemplate,
  getWorkflowReferences,
  duplicateWorkflowTemplate,
  testCredentialPayload,
  listZapierTools,
  getRun,
  getTransfer,
  getWorkflowRun,
  getWorkflowTemplate,
  installPublicRegistryPackage,
  listActionPackages,
  listApiKeys,
  listBillingApiKeys,
  listCachedOrganizations,
  listDeadLetterRuns,
  listExecutionLocations,
  listExecutionLogs,
  listMcpAuditEvents,
  listQueueRuns,
  listPublicRegistryPackages,
  listRegistryPackages,
  listRuns,
  listSchedules,
  listTransfers,
  listWorkerInstances,
  listWorkerRuntimeState,
  listWorkflowRuns,
  listWorkflowDynamicInstances,
  cacheAssistantProviderModels,
  createAssistantConversation,
  deleteAssistantConversation,
  getAssistantConversation,
  getAssistantProviderSettings,
  getBeamEnvironmentSettings,
  listAssistantConversations,
  listWorkflowTemplates,
  renameAssistantConversation,
  archiveAssistantConversation,
  retryRun,
  assertRunRetryable,
  retryWorkflowRun,
  retryWorkflowDynamicRegion,
  runsReportRows,
  resolveBeamEnvironmentTemplate,
  startRun,
  startWorkflowRun,
  startWorkflowWebhookRun,
  toggleSchedule,
  toggleTransfer,
  updateCredential,
  updateEndpoint,
  updateSchedule,
  updateTransfer,
  updateWorkflowStepConfig,
  updateWorkflowTemplate,
  upsertAssistantProviderSettings,
  updateBeamEnvironmentDefault,
  upsertBeamEnvironmentTemplate,
  workflowDashboardSummary,
  workflowRunActivity,
} from "./store.js";
import {
  credentialBuckets,
  listCredentialObjects,
  validateProviderBuckets,
} from "./storage-browser.js";
import {
  ASSISTANT_PROVIDER_CATALOG,
  BEAM_AI_PROVIDER_ID,
  BEAM_AI_SETTINGS_URL,
  assistantProviderConfigSummary,
  assistantProviderFromSettings,
  createAssistantChatResponse,
  createAssistantWorkflowPlan,
  listAssistantProviderModels,
  testAssistantProvider,
  type AssistantProviderConfig,
} from "./assistant.js";
import { saveWorkflowGraph } from "./workflow-graph-authoring.js";
import {
  AssistantPlanError,
  AssistantPlanRepository,
  cancelAssistantPlan,
  consumeAssistantOneTimeSecret,
  confirmAssistantPlan,
  createStudioOperationPlan,
  executeAssistantPlan,
  rollbackAssistantPlan,
  routeStudioAssistantIntent,
  studioAssistantToolDescriptors,
  validateAndPreviewAssistantPlan,
  type AssistantExecutionScope,
} from "./assistant-operations.js";
import {
  ActionNotBillableError,
  CreditReservationError,
  reserveAction,
  releaseReservation,
  type ActionReservation,
  type BillableAction,
} from "../billing/action-gate.js";
import {
  estimateWorkflowCredits,
  type TransferProjection,
} from "../billing/workflow-estimate.js";
import { priceSchedules, priceTransfers } from "./transfer-estimates.js";
import {
  BEAM_TRANSFER_ACTION,
  missingBillingKeyMessage,
  resolveWorkflowBillingKey,
} from "@beam-studio/core";
import { StudioValidationError } from "./validation-error.js";

type JsonObject = Record<string, unknown>;
type AssistantModelCatalogPayload = {
  models: AssistantModelOption[];
  cached: boolean;
  cachedAt: string | null;
  stale?: boolean;
};

const assistantModelLoads = new Map<
  string,
  Promise<AssistantModelCatalogPayload>
>();

type StudioAssistantRouteInfo = {
  actionPackageName?: string;
  routeKind: string;
  runId?: string;
  workflowId?: string;
};
type StudioAssistantResponse = {
  message: string;
  plan?: AssistantOperationPlan;
  citations?: Array<Record<string, unknown>>;
  provider?: Record<string, unknown>;
  degraded?: boolean;
  error?: string;
  providerMessage?: string;
};

type OrganizationOption = {
  id: string;
  name?: string | null;
  slug?: string | null;
  credits?: number | null;
  role?: string | null;
  restrictionStatus?: string | null;
  tier?: string | null;
};
type ProjectOption = {
  id: string;
  organizationId: string;
  name?: string | null;
  slug?: string | null;
  description?: string | null;
};
const STUDIO_ORGANIZATION_COOKIE = "beam-studio.organization-id";
const STUDIO_PROJECT_COOKIE = "beam-studio.project-id";
const logger = createApiLogger("beam-transfer-api:studio");
type StudioRouteServices = {
  pgPool: PgPool;
  sessions: StudioSessionManager;
  admission: InstanceAdmission;
  /** Tests pass a service with fake Beam endpoints. */
  instanceKeys?: InstanceKeyService;
};

/**
 * Whether a freshly signed-in account has any organization this deployment
 * serves, and if not, what to tell them.
 *
 * An unclaimed instance deliberately lets the session through: the claimant
 * has to be signed in to claim it, and the claim funnel is all they can reach
 * until they do.
 */
async function refuseUnservedAccount(
  services: { beamApi: { getJson: <T>(path: string) => Promise<T> } },
  admission: InstanceAdmission,
) {
  const instance = await admission.instance();
  if (instance.state !== "claimed") return null;

  const payload = await services.beamApi.getJson<{
    organizations?: Array<{ id: string }>;
  }>("/api/organizations");
  const organizations = payload.organizations ?? [];

  const verdicts = await Promise.all(
    organizations.map(async (organization) => ({
      organizationId: organization.id,
      verdict: await admission.check(organization.id),
    })),
  );
  if (verdicts.some((entry) => entry.verdict.outcome === "admitted")) {
    return null;
  }

  // A revoked organization cannot ask again: its row stays revoked, so telling
  // it "your request is pending" promised a decision that would never come and
  // that the owner could not even see under Requests. Answered as the session
  // plane answers it.
  const askable = verdicts.filter(
    (entry) => entry.verdict.outcome !== "revoked",
  );
  if (verdicts.length > 0 && askable.length === 0) {
    return {
      code: "instance_organization_revoked",
      error:
        "This Studio's owner has revoked your organization's access. Ask them to restore it.",
    };
  }

  if (instance.joinPolicy === "request") {
    // Beam has just confirmed these memberships, so recording the ask here is
    // bounded by organizations the caller genuinely belongs to.
    await Promise.all(
      askable.map((entry) =>
        admission.requestAccess(entry.organizationId, {
          userId: null,
          email: null,
        }),
      ),
    );
    return {
      code: "instance_join_pending",
      error:
        "This Studio is private. Your organization has asked to join; its owner decides.",
    };
  }

  return {
    code: "instance_private",
    error:
      "This Studio is private. Ask the team that runs it to admit your organization.",
  };
}

/**
 * The answer to a device poll or cancel with no sign-in attempt behind it:
 * the attempt ended (a refusal logs it out, as does a new attempt) or never
 * started. A stable code, so a client can tell "start again" from a failure.
 */
function deviceSessionRequired() {
  return {
    code: "device_session_required",
    error: "This sign-in attempt has ended. Start signing in again.",
  };
}

export async function registerStudioRoutes(
  server: FastifyInstance,
  options: StudioRouteServices,
) {
  registerInstanceAccessRoutes(server, {
    pgPool: options.pgPool,
    admission: options.admission,
    instanceKeys: options.instanceKeys ?? createInstanceKeyService(),
    instanceKeysEnabled: webEnv.instanceKeyEnabled,
  });
  // Secret-bearing domains go through repositories that require a verified
  // organization scope, rather than the store's optional-and-blank convention.
  const mcpTokenRepository = new McpTokenRepository(options.pgPool);
  const credentialRepository = new CredentialRepository(
    options.pgPool,
    vaultSecretFromEnv,
  );
  const scopeOf = (request: FastifyRequest) =>
    organizationScope(currentOrganizationId(request));

  // Handlers here read `request.body.<field>` directly. A request sent without
  // a body (a DELETE, or a POST from a client that omits `{}`) leaves the body
  // undefined, which turned into a TypeError and a 500. An absent body now
  // reads as an empty object, so each route's own validation decides.
  server.addHook("preValidation", async (request) => {
    if (
      request.body == null &&
      request.routeOptions.url?.startsWith("/studio/")
    ) {
      request.body = {};
    }
  });

  // Encapsulated so the raw-body parser below reaches this route and nothing
  // else. A trigger that requires a signature signs the bytes it sent, and
  // Fastify's default parser discards them; re-serialising the parsed object
  // would produce a different string and never verify.
  await server.register(async (hooks) => {
    hooks.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (request, body, done) => {
        const raw = typeof body === "string" ? body : body.toString("utf8");
        (request as RawBodyRequest).rawBody = raw;
        try {
          done(null, raw ? JSON.parse(raw) : {});
        } catch {
          done(
            Object.assign(new SyntaxError("Invalid JSON body."), {
              statusCode: 400,
            }),
            undefined,
          );
        }
      },
    );

    hooks.post<{
      Params: { workflowId: string; triggerId: string; token: string };
      Body: JsonObject;
    }>(
      "/hooks/workflows/:workflowId/:triggerId/:token",
      { config: { auth: auth.webhookTrigger() } },
      async (request, reply) => {
        let accepted: Awaited<ReturnType<typeof startWorkflowWebhookRun>>;
        try {
          accepted = await startWorkflowWebhookRun({
            workflowTemplateId: request.params.workflowId,
            triggerId: request.params.triggerId,
            token: request.params.token,
            payload: payloadObject(request.body),
            // Salesforce retries and a Flow can fire twice for one save, so a
            // caller-supplied key lets a repeat be dropped rather than re-run.
            idempotencyKey:
              text(request.headers["idempotency-key"]) ||
              text(request.body.idempotencyKey),
            signatureHeader: text(request.headers["x-beam-signature"]),
            timestampHeader: text(request.headers["x-beam-timestamp"]),
            rawBody: (request as RawBodyRequest).rawBody ?? "",
            // A webhook is a machine caller: an open join policy does not
            // admit it, a recorded admission does.
            isOrganizationAdmitted: machineCallerAdmission(options.admission),
          });
        } catch (error) {
          const refused = error as {
            code?: string;
            message?: string;
            reason?: string;
            retryAfterSeconds?: number;
          };
          if (refused?.code === "webhook_rate_limited") {
            return reply
              .code(429)
              .header("Retry-After", String(refused.retryAfterSeconds ?? 60))
              .send({
                code: "webhook_rate_limited",
                error: "Too many webhook deliveries for this trigger.",
                statusCode: 429,
              });
          }
          if (refused?.code !== "webhook_signature_rejected") throw error;
          // 401 rather than the 404 a bad token gets: the caller has already
          // proven it holds the token, and a customer wiring up HMAC has to be
          // told which part is wrong.
          settleRouteAuth(request);
          return reply.code(401).send({
            code: "webhook_signature_rejected",
            // `details` because the preSerialization normalizer keeps that key
            // on an error body and drops any other.
            details: { reason: refused.reason },
            error: refused.message ?? "The request signature was rejected.",
            statusCode: 401,
          });
        }
        // A bad token and a missing trigger are deliberately indistinguishable.
        if (!accepted) {
          return reply.code(404).send({ error: "Webhook not found" });
        }
        // startWorkflowWebhookRun only returns a result for a trigger whose
        // stored token matched, so reaching here is the accepted credential.
        settleRouteAuth(request);
        // A coalesced event has no run of its own yet; runId is null until the
        // window closes and the batch is flushed.
        return reply.code(202).send({
          accepted: true,
          runId: accepted.runId,
          pending: accepted.pending,
        });
      },
    );
  });

  server.get(
    "/studio/session",
    { config: { auth: auth.sessionProbe() } },
    async (request) => ({
      session: studioRequestSession(request),
    }),
  );

  server.post(
    "/studio/auth/device/authorize",
    { config: { auth: auth.public("starts the OAuth device grant") } },
    async (request, reply) => {
      const previous = studioCookie(
        request.headers.cookie,
        STUDIO_LOGIN_COOKIE,
      );
      await options.sessions.logout(previous);
      const { cookie, services } = options.sessions.create();
      const authorization = await services.oauth.authorizeDevice();
      reply.header("Cache-Control", "no-store");
      reply.header(
        "Set-Cookie",
        serializeCookie(STUDIO_LOGIN_COOKIE, cookie, {
          secure: requestIsSecure(request),
          maxAge: authorization.expires_in,
        }),
      );
      return authorization;
    },
  );

  server.post<{ Body: JsonObject }>(
    "/studio/auth/device/poll",
    { config: { auth: auth.loginSession() } },
    async (request, reply) => {
      const cookie = studioCookie(request.headers.cookie, STUDIO_LOGIN_COOKIE);
      const services = options.sessions.get(cookie);
      if (!services) return reply.code(401).send(deviceSessionRequired());
      settleRouteAuth(request);
      const result = await services.oauth.pollDevice(
        text(request.body.attempt_id),
      );
      if (result.status === "connected") {
        options.sessions.activate(cookie!);

        // A courtesy, not the boundary: verifyStudioSession is what actually
        // refuses every request. Without this a stranger would be handed a
        // 30-day cookie and then walk into a wall of 403s with nothing telling
        // them the installation is private. Do not remove one believing the
        // other covers it.
        const refusal = await refuseUnservedAccount(
          services,
          options.admission,
        );
        if (refusal) {
          await options.sessions.logout(cookie);
          reply.header("Set-Cookie", [expireCookie(STUDIO_LOGIN_COOKIE)]);
          reply.header("Cache-Control", "no-store");
          return reply.code(403).send(refusal);
        }

        const previous = studioCookie(
          request.headers.cookie,
          STUDIO_SESSION_COOKIE,
        );
        if (previous !== cookie) await options.sessions.logout(previous);
        reply.header("Set-Cookie", [
          serializeCookie(STUDIO_SESSION_COOKIE, cookie!, {
            secure: requestIsSecure(request),
            maxAge: STUDIO_SESSION_MAX_AGE_SECONDS,
          }),
          expireCookie(STUDIO_LOGIN_COOKIE),
          expireCookie(STUDIO_ORGANIZATION_COOKIE),
          expireCookie(STUDIO_PROJECT_COOKIE),
        ]);
      }
      reply.header("Cache-Control", "no-store");
      return result;
    },
  );

  server.post<{ Body: JsonObject }>(
    "/studio/auth/device/cancel",
    { config: { auth: auth.loginSession() } },
    async (request, reply) => {
      const cookie = studioCookie(request.headers.cookie, STUDIO_LOGIN_COOKIE);
      if (!cookie) return reply.code(401).send(deviceSessionRequired());
      settleRouteAuth(request);
      options.sessions
        .get(cookie)
        ?.oauth.cancelDevice(text(request.body.attempt_id));
      reply.header("Set-Cookie", expireCookie(STUDIO_LOGIN_COOKIE));
      return { status: "cancelled" };
    },
  );

  server.post(
    "/studio/auth/logout",
    {
      config: {
        auth: auth.public("clears cookies; must work without a valid session"),
      },
    },
    async (request, reply) => {
      await options.sessions.logout(
        studioCookie(request.headers.cookie, STUDIO_SESSION_COOKIE),
      );
      await options.sessions.logout(
        studioCookie(request.headers.cookie, STUDIO_LOGIN_COOKIE),
      );
      reply.header("Set-Cookie", [
        expireCookie("beam-studio.access-token"),
        expireCookie("beam-studio.device-code"),
        expireCookie(STUDIO_LOGIN_COOKIE),
        expireCookie(STUDIO_SESSION_COOKIE),
        expireCookie(STUDIO_ORGANIZATION_COOKIE),
        expireCookie(STUDIO_PROJECT_COOKIE),
      ]);
      return { ok: true };
    },
  );

  server.post<{ Body: JsonObject }>(
    "/studio/organization-context",
    { config: { auth: auth.selectOrganization() } },
    async (request, reply) => {
      const organizationId = text(request.body.organizationId);
      if (!organizationId) {
        return reply.code(400).send({ error: "organization_id_required" });
      }
      reply.header("Set-Cookie", [
        serializeCookie(STUDIO_ORGANIZATION_COOKIE, organizationId, {
          secure: requestIsSecure(request),
          maxAge: 60 * 60 * 24 * 365,
        }),
        expireCookie(STUDIO_PROJECT_COOKIE),
      ]);
      return { organizationId };
    },
  );

  server.post<{ Body: JsonObject }>(
    "/studio/project-context",
    { config: { auth: auth.selectProject() } },
    async (request, reply) => {
      const projectId = text(request.body.projectId);
      if (!projectId) {
        reply.header("Set-Cookie", expireCookie(STUDIO_PROJECT_COOKIE));
        return { projectId: null };
      }
      reply.header(
        "Set-Cookie",
        serializeCookie(STUDIO_PROJECT_COOKIE, projectId, {
          secure: requestIsSecure(request),
          maxAge: 60 * 60 * 24 * 365,
        }),
      );
      return { projectId };
    },
  );

  server.get(
    "/studio/organizations",
    // On the claim funnel: an unclaimed instance has no other way to learn
    // which organization is installing it, and this returns only the caller's
    // own Beam memberships, back to that caller.
    { config: { auth: auth.claimFunnel() } },
    async (request, reply) => {
      const payload = await studioRequestAuth(request).beamApi.getJson<{
        organizations?: OrganizationOption[];
      }>("/api/organizations");
      const organizations = payload.organizations ?? [];
      const selectedOrganizationId =
        authorizedOrganizationId(
          organizations,
          currentOrganizationId(request),
        ) ??
        organizations[0]?.id ??
        null;
      if (
        selectedOrganizationId &&
        selectedOrganizationId !== currentOrganizationId(request)
      ) {
        reply.header(
          "Set-Cookie",
          serializeCookie(STUDIO_ORGANIZATION_COOKIE, selectedOrganizationId, {
            secure: requestIsSecure(request),
            maxAge: 60 * 60 * 24 * 365,
          }),
        );
      }

      return {
        consoleUrl: webEnv.consoleUrl,
        organizations,
        selectedOrganizationId,
      };
    },
  );

  server.get(
    "/studio/projects",
    { config: { auth: auth.accountOptionalOrganization() } },
    async (request, reply) => {
      const organizationId = currentOrganizationId(request);
      if (!organizationId) {
        return {
          organizationId,
          projects: [],
          selectedProjectId: null,
        };
      }

      const payload = await studioRequestAuth(request).beamApi.getJson<{
        organizationId?: string;
        projects?: ProjectOption[];
      }>(`/api/projects?organizationId=${encodeURIComponent(organizationId)}`);
      const projects = payload.projects ?? [];
      const selectedProjectId =
        authorizedProjectId(projects, currentProjectId(request)) ?? null;

      return {
        organizationId,
        projects,
        selectedProjectId,
      };
    },
  );

  server.get(
    "/studio/settings",
    { config: { auth: auth.read({ machine: ["read:settings"] }) } },
    async (request) => {
      const organizationId = currentOrganizationId(request);
      const summary = await workflowDashboardSummary({ organizationId });
      const provider = await assistantProviderForRequest(request, options);
      const providerSettings = await getAssistantProviderSettings(
        await assistantScope(request, options),
      );
      const beamAiSettings =
        providerSettings?.providerId === BEAM_AI_PROVIDER_ID
          ? providerSettings
          : null;
      const beamEnvironmentSettings =
        await getBeamEnvironmentSettings(organizationId);
      return {
        appName: webEnv.appName,
        organizationId,
        dataStore: await activeDataStoreSettings(options.pgPool),
        beam: {
          defaultBaseUrl: webEnv.beamDefaultBaseUrl,
          authUrl: webEnv.authUrl,
          consoleUrl: webEnv.consoleUrl,
          adminUrl: webEnv.adminUrl,
          apiUrl: webEnv.apiUrl,
          studioUrl: webEnv.transferStudioUrl,
          serverOptions: webEnv.beamServerOptions,
          defaultCoordinatorUrl: webEnv.beamDefaultCoordinatorUrl,
          defaultNatsUrl: webEnv.beamDefaultNatsUrl,
          environments: beamEnvironmentSettings,
        },
        runtime: {
          authPortal: webEnv.studioAuthPortal,
          secureCookies: webEnv.secureCookies,
          devSettingsEnabled: webEnv.devSettingsEnabled,
        },
        assistant: {
          catalog: ASSISTANT_PROVIDER_CATALOG,
          providers: provider ? [assistantProviderConfigSummary(provider)] : [],
          settings: beamAiSettings
            ? {
                providerId: BEAM_AI_PROVIDER_ID,
                baseUrl: beamAiBaseUrl(),
                model: beamAiSettings.model,
                apiKeyConfigured: false,
                source: "user",
              }
            : null,
        },
        summary,
      };
    },
  );

  server.get(
    "/studio/beam-environment-settings",
    { config: { auth: auth.read({ machine: ["read:settings"] }) } },
    async (request) => {
      return getBeamEnvironmentSettings(currentOrganizationId(request));
    },
  );

  server.patch<{ Body: JsonObject }>(
    "/studio/beam-environment-settings",
    { config: { auth: auth.write() } },
    async (request) => {
      return updateBeamEnvironmentDefault({
        organizationId: currentOrganizationId(request),
        defaultTemplateKey: text(request.body.defaultTemplateKey),
      });
    },
  );

  server.put<{ Params: { key: string }; Body: JsonObject }>(
    "/studio/beam-environment-templates/:key",
    { config: { auth: auth.write() } },
    async (request) => {
      return upsertBeamEnvironmentTemplate({
        organizationId: currentOrganizationId(request),
        template: { ...request.body, key: request.params.key },
      });
    },
  );

  server.delete<{ Params: { key: string } }>(
    "/studio/beam-environment-templates/:key",
    { config: { auth: auth.write() } },
    async (request) => {
      return deleteBeamEnvironmentTemplate({
        organizationId: currentOrganizationId(request),
        templateKey: request.params.key,
      });
    },
  );

  server.get(
    "/studio/ai/providers",
    { config: { auth: auth.read() } },
    async (request) => {
      const provider = await assistantProviderForRequest(request, options);
      const settings = await getAssistantProviderSettings(
        await assistantScope(request, options),
      );
      const beamAiSettings =
        settings?.providerId === BEAM_AI_PROVIDER_ID ? settings : null;
      return {
        catalog: ASSISTANT_PROVIDER_CATALOG,
        providers: provider ? [assistantProviderConfigSummary(provider)] : [],
        settings: beamAiSettings
          ? {
              providerId: BEAM_AI_PROVIDER_ID,
              baseUrl: beamAiBaseUrl(),
              model: beamAiSettings.model,
              apiKeyConfigured: false,
              source: "user",
            }
          : null,
      };
    },
  );

  server.patch<{ Body: JsonObject }>(
    "/studio/ai/settings",
    { config: { auth: auth.write() } },
    async (request) => {
      const scope = await assistantScope(request, options);
      await upsertAssistantProviderSettings({
        ...scope,
        providerId: BEAM_AI_PROVIDER_ID,
        baseUrl: BEAM_AI_SETTINGS_URL,
        model: text(request.body.model),
        models: assistantModelOptions(request.body.models),
      });
      const provider = await assistantProviderForRequest(request, options);
      return {
        saved: true,
        provider: provider ? assistantProviderConfigSummary(provider) : null,
      };
    },
  );

  server.get(
    "/studio/ai/models",
    { config: { auth: auth.read() } },
    async (request) => {
      return assistantModelCatalog(request, options);
    },
  );

  server.post(
    "/studio/ai/models/refresh",
    { config: { auth: auth.write() } },
    async (request) => {
      return assistantModelCatalog(request, options, true);
    },
  );

  server.post<{ Body: JsonObject }>(
    "/studio/ai/models/discover",
    { config: { auth: auth.write() } },
    async (request) => {
      const provider = beamAiProviderForRequest(request, options, "");
      return { models: await listAssistantProviderModels(provider) };
    },
  );

  server.post<{ Body: JsonObject }>(
    "/studio/ai/providers/test",
    { config: { auth: auth.write() } },
    async (request) => {
      const provider = await assistantProviderForRequest(
        request,
        options,
        optionalText(request.body.model),
      );
      return testAssistantProvider(provider);
    },
  );

  server.get(
    "/studio/assistant/tools",
    { config: { auth: auth.read() } },
    async () => ({
      tools: studioAssistantToolDescriptors(),
    }),
  );

  server.post<{ Body: JsonObject }>(
    "/studio/assistant/plan",
    { config: { auth: auth.write() } },
    async (request) => {
      const scope = await assistantExecutionScope(request, options);
      const prompt = text(request.body.prompt);
      const provider = await assistantProviderForRequest(
        request,
        options,
        optionalText(request.body.model),
      );
      return {
        plan: await createStudioOperationPlan({
          pool: options.pgPool,
          actions: await listActionPackages({
            organizationId: scope.organizationId,
          }),
          context: isJsonObject(request.body.context)
            ? request.body.context
            : {},
          conversationId: text(request.body.conversationId) || null,
          idempotencyKey: text(request.body.idempotencyKey) || request.id,
          prompt,
          repository: new AssistantPlanRepository(options.pgPool),
          reasoningEffort: optionalReasoningEffort(
            request.body.reasoningEffort,
          ),
          scope,
          provider,
        }),
      };
    },
  );

  server.get<{ Params: { id: string } }>(
    "/studio/assistant/plans/:id",
    { config: { auth: auth.read() } },
    async (request) => ({
      plan: await requiredAssistantPlan(
        request.params.id,
        await assistantExecutionScope(request, options),
        options.pgPool,
      ),
    }),
  );

  server.post<{ Params: { id: string } }>(
    "/studio/assistant/secrets/:id",
    { config: { auth: auth.write() } },
    async (request) => {
      const scope = await assistantExecutionScope(request, options);
      return {
        secret: consumeAssistantOneTimeSecret(request.params.id, scope.userId),
      };
    },
  );

  server.post<{ Params: { id: string }; Body: JsonObject }>(
    "/studio/assistant/plans/:id/validate",
    { config: { auth: auth.write() } },
    async (request) => {
      const scope = await assistantExecutionScope(request, options);
      const repository = new AssistantPlanRepository(options.pgPool);
      const plan = await requiredAssistantPlan(
        request.params.id,
        scope,
        options.pgPool,
      );
      return validateAndPreviewAssistantPlan({
        pool: options.pgPool,
        actions: await listActionPackages({
          organizationId: scope.organizationId,
        }),
        inputs: isJsonObject(request.body.inputs) ? request.body.inputs : {},
        plan,
        repository,
        scope,
      });
    },
  );

  server.post<{ Params: { id: string } }>(
    "/studio/assistant/plans/:id/confirm",
    { config: { auth: auth.write() } },
    async (request) => {
      const scope = await assistantExecutionScope(request, options);
      const repository = new AssistantPlanRepository(options.pgPool);
      return {
        plan: await confirmAssistantPlan({
          plan: await requiredAssistantPlan(
            request.params.id,
            scope,
            options.pgPool,
          ),
          repository,
          scope,
        }),
      };
    },
  );

  server.post<{ Params: { id: string } }>(
    "/studio/assistant/plans/:id/execute",
    { config: { auth: auth.write() } },
    async (request, reply) => {
      const scope = await assistantExecutionScope(request, options);
      const repository = new AssistantPlanRepository(options.pgPool);
      const sourcePlan = await requiredAssistantPlan(
        request.params.id,
        scope,
        options.pgPool,
      );
      await validateAssistantWorkspaceSwitch(request, sourcePlan, options);
      const plan = await executeAssistantPlan({
        pool: options.pgPool,
        actions: await listActionPackages({
          organizationId: scope.organizationId,
        }),
        plan: sourcePlan,
        repository,
        scope,
      });
      const workspaceSwitch = plan.operations.find(
        (operation) =>
          operation.tool === "workspace.switch" &&
          operation.status === "completed" &&
          operation.result?.workspaceSwitch === true,
      )?.result;
      if (workspaceSwitch) {
        const organizationId = text(workspaceSwitch.organizationId);
        const projectId = text(workspaceSwitch.projectId);
        reply.header("Set-Cookie", [
          serializeCookie(STUDIO_ORGANIZATION_COOKIE, organizationId, {
            secure: requestIsSecure(request),
            maxAge: 60 * 60 * 24 * 365,
          }),
          projectId
            ? serializeCookie(STUDIO_PROJECT_COOKIE, projectId, {
                secure: requestIsSecure(request),
                maxAge: 60 * 60 * 24 * 365,
              })
            : expireCookie(STUDIO_PROJECT_COOKIE),
        ]);
      }
      return { plan };
    },
  );

  server.post<{ Params: { id: string } }>(
    "/studio/assistant/plans/:id/cancel",
    { config: { auth: auth.write() } },
    async (request) => {
      const scope = await assistantExecutionScope(request, options);
      const repository = new AssistantPlanRepository(options.pgPool);
      return {
        plan: await cancelAssistantPlan({
          plan: await requiredAssistantPlan(
            request.params.id,
            scope,
            options.pgPool,
          ),
          repository,
          scope,
        }),
      };
    },
  );

  server.post<{ Params: { id: string } }>(
    "/studio/assistant/plans/:id/rollback",
    { config: { auth: auth.write() } },
    async (request) => {
      const scope = await assistantExecutionScope(request, options);
      const repository = new AssistantPlanRepository(options.pgPool);
      return {
        plan: await rollbackAssistantPlan({
          pool: options.pgPool,
          plan: await requiredAssistantPlan(
            request.params.id,
            scope,
            options.pgPool,
          ),
          repository,
          scope,
        }),
      };
    },
  );

  server.get(
    "/studio/assistant/context",
    { config: { auth: auth.read() } },
    async (request) => {
      const organizationId = currentOrganizationId(request);
      const projectId = currentProjectId(request);
      const organizationPayload = await fetchCentralStudioJson<{
        organizations?: OrganizationOption[];
      }>("/api/organizations", studioRequestAuth(request).beamApi);
      const organizations = organizationPayload?.organizations ?? [];
      const projectPayload = organizationId
        ? await fetchCentralStudioJson<{ projects?: ProjectOption[] }>(
            `/api/projects?organizationId=${encodeURIComponent(organizationId)}`,
            studioRequestAuth(request).beamApi,
          )
        : null;
      const projects = projectPayload?.projects ?? [];
      const query = request.query as JsonObject;
      const route = text(query.route);
      const routeInfo = studioAssistantRouteInfo(route);
      const [
        summary,
        workflows,
        runs,
        credentials,
        registry,
        workflow,
        run,
        transfers,
        schedules,
        locations,
        mcpTokens,
        beamConnections,
      ] = await Promise.all([
        workflowDashboardSummary({ organizationId }),
        listWorkflowTemplates({ organizationId, projectId }),
        listWorkflowRuns({ organizationId, projectId }),
        credentialRepository
          .list(organizationScope(organizationId))
          .then((items) =>
            items.filter(
              (credential) => !projectId || credential.projectId === projectId,
            ),
          ),
        listRegistryPackages(organizationId),
        routeInfo.workflowId
          ? getWorkflowTemplate(routeInfo.workflowId, organizationId, projectId)
          : Promise.resolve(null),
        routeInfo.runId
          ? getWorkflowRun(routeInfo.runId, organizationId, projectId)
          : Promise.resolve(null),
        Promise.resolve(listTransfers({ organizationId, projectId })),
        Promise.resolve(listSchedules({ organizationId })),
        listExecutionLocations({ organizationId }),
        mcpTokenRepository.list(organizationScope(organizationId)),
        listApiKeys({ organizationId }),
      ]);
      const workflowDetails = await Promise.all(
        workflows
          .slice(0, 24)
          .map((item) =>
            getWorkflowTemplate(item.id, organizationId, projectId),
          ),
      );

      return {
        actionPackageName: routeInfo.actionPackageName,
        beamConnections: beamConnections.map((connection) => ({
          id: connection.id,
          name: connection.name,
          baseUrl: connection.baseUrl,
          status: connection.status,
          secretAvailable: connection.secretAvailable,
        })),
        credentials,
        executionLocations: locations,
        mcpTokens,
        organizationId,
        organizations: organizations.map((organization) => ({
          id: organization.id,
          name: organization.name,
          role: "role" in organization ? organization.role : null,
        })),
        projectId,
        projects: projects.map((project) => ({
          id: project.id,
          name: project.name,
        })),
        registry: compactAssistantRegistryContext(registry),
        route,
        routeKind: routeInfo.routeKind,
        run: assistantRunSummary(run),
        runId: routeInfo.runId,
        runs: runs.slice(0, 60).map(assistantRunSummary),
        studio: {
          generatedAt: new Date().toISOString(),
          source: "studio-assistant-context",
        },
        summary,
        schedules: schedules.filter((schedule) =>
          transfers.some(
            (transfer) => transfer.id === schedule.transferTemplateId,
          ),
        ),
        transfers: transfers.map((transfer) => ({
          ...transfer,
          href: `/transfers/${encodeURIComponent(transfer.id)}`,
        })),
        workflow,
        workflowId: routeInfo.workflowId,
        workflows: workflows.map((item, index) =>
          assistantWorkflowSummary(item, workflowDetails[index]),
        ),
      };
    },
  );

  const assistantRequests = new AssistantRequestRepository(options.pgPool);
  const assistantWorker = new AssistantRequestWorker(
    assistantRequests,
    async (job, signal) => {
      const input = job.input_json;
      const scope = input.scope;
      const auth = job.encrypted_session
        ? options.sessions.get(
            decryptString(job.encrypted_session, vaultSecretFromEnv()),
          )
        : null;
      {
        if (!auth || !(await auth.oauth.hasSession()))
          throw new Error("Studio session expired");
        const user = studioSessionFromMe(await auth.beamApi.getJson("/api/me"));
        const organizations = await auth.beamApi.getJson<{
          organizations?: OrganizationOption[];
        }>("/api/organizations");
        const organization = organizations.organizations?.find(
          (item) => item.id === scope.organizationId,
        );
        if (
          user?.userId !== job.user_id ||
          !organization ||
          organization.role === "viewer" ||
          organization.role === "read_only" ||
          organization.restrictionStatus === "restricted"
        ) {
          throw new Error("Studio access changed");
        }
        if (scope.projectId) {
          const projects = await auth.beamApi.getJson<{
            projects?: ProjectOption[];
          }>(
            `/api/projects?organizationId=${encodeURIComponent(scope.organizationId)}`,
          );
          if (!projects.projects?.some((item) => item.id === scope.projectId))
            throw new Error("Project access changed");
        }
      }
      const settings = await getAssistantProviderSettings(scope);
      const chatProvider =
        settings?.providerId === BEAM_AI_PROVIDER_ID
          ? assistantProviderFromSettings({
              providerId: BEAM_AI_PROVIDER_ID,
              baseUrl: beamAiBaseUrl(),
              managedCredentials: true,
              model: settings.model,
              selectedModel: input.model,
              request: auth
                ? (url, init) => auth.beamApi.fetchResponse(url, init)
                : undefined,
              requestHeaders: { "X-Organization-Id": scope.organizationId },
            })
          : undefined;
      if (chatProvider) chatProvider.signal = signal;
      const copilotProvider = chatProvider;
      const actions = await listActionPackages({
        organizationId: scope.organizationId,
      });
      const context = input.context;
      const route = input.route;
      const reasoningEffort = input.reasoningEffort;
      const messages = await assistantRequests.messages(job.conversation_id);
      const lastPrompt = input.prompt;
      const intent = routeStudioAssistantIntent(lastPrompt);
      let response: StudioAssistantResponse;

      if (intent === "read") {
        response = await createAssistantChatResponse({
          actions,
          messages,
          provider: chatProvider,
          reasoningEffort,
          route,
          routeContext: context,
        });
      } else {
        const plan = await createStudioOperationPlan({
          pool: options.pgPool,
          actions,
          context,
          conversationId: job.conversation_id,
          idempotencyKey: job.id,
          prompt: lastPrompt,
          repository: new AssistantPlanRepository(options.pgPool),
          reasoningEffort,
          scope,
          provider: copilotProvider,
        });
        if (intent === "studio.read") {
          response = await createAssistantChatResponse({
            actions,
            messages,
            provider: chatProvider,
            reasoningEffort,
            route,
            routeContext: {
              ...context,
              assistantResults: plan.operations.map((operation) => ({
                error: operation.error,
                result: operation.result,
                status: operation.status,
                tool: operation.tool,
              })),
            },
          });
        } else {
          response = {
            message: plan.summary,
            plan,
          };
        }
      }

      return response as Record<string, unknown>;
    },
    (error) =>
      server.log.error({ err: error }, "Assistant background worker failed"),
  );
  server.addHook("onReady", async () => assistantWorker.start());
  server.addHook("onClose", async () => assistantWorker.stop());

  function encryptedAssistantSession(request: FastifyRequest) {
    const cookie = studioCookie(request.headers.cookie, STUDIO_SESSION_COOKIE);
    return cookie ? encryptString(cookie, vaultSecretFromEnv()) : null;
  }
  async function enqueueAssistantRequest(
    request: FastifyRequest<{ Body: JsonObject }>,
  ) {
    const scope = await assistantExecutionScope(request, options);
    const body = request.body;
    const messages = Array.isArray(body.messages)
      ? body.messages.filter(isJsonObject)
      : [];
    const prompt =
      text(body.prompt) ||
      text(
        [...messages].reverse().find((message) => message.role === "user")
          ?.content,
      );
    const row = await assistantRequests.enqueue(
      {
        prompt,
        context: isJsonObject(body.context) ? body.context : {},
        route: text(body.route) || "/",
        model: optionalText(body.model),
        reasoningEffort: optionalReasoningEffort(body.reasoningEffort),
        scope,
      },
      text(body.idempotencyKey) || randomUUID(),
      text(body.conversationId) || null,
      encryptedAssistantSession(request),
    );
    assistantWorker.kick();
    return row;
  }
  server.post<{ Body: JsonObject }>(
    "/studio/assistant/requests",
    { config: { auth: auth.write() } },
    async (request, reply) => {
      const row = await enqueueAssistantRequest(request);
      return reply.code(202).send({
        conversationId: row.conversation_id,
        request: requestSummary(row),
      });
    },
  );
  server.get<{ Params: { id: string } }>(
    "/studio/assistant/requests/:id",
    { config: { auth: auth.read() } },
    async (request, reply) => {
      const row = await assistantRequests.get(
        request.params.id,
        await assistantScope(request, options),
      );
      if (!row) return reply.code(404).send({ error: "Request not found." });
      return { request: requestSummary(row), response: row.response_json };
    },
  );
  server.post<{ Params: { id: string } }>(
    "/studio/assistant/requests/:id/cancel",
    { config: { auth: auth.write() } },
    async (request, reply) => {
      const row = await assistantRequests.cancel(
        request.params.id,
        await assistantScope(request, options),
      );
      if (!row) return reply.code(404).send({ error: "Request not found." });
      if (row.status === "cancelled" && row.worker_id)
        assistantWorker.cancel(row.id, row.worker_id);
      return { request: requestSummary(row) };
    },
  );
  server.post<{ Params: { id: string } }>(
    "/studio/assistant/requests/:id/retry",
    { config: { auth: auth.write() } },
    async (request, reply) => {
      const row = await assistantRequests.retry(
        request.params.id,
        await assistantExecutionScope(request, options),
        encryptedAssistantSession(request),
      );
      assistantWorker.kick();
      return reply.code(202).send({
        conversationId: row.conversation_id,
        request: requestSummary(row),
      });
    },
  );
  server.post<{ Params: { id: string }; Body: JsonObject }>(
    "/studio/assistant/conversations/:id/read",
    { config: { auth: auth.write() } },
    async (request, reply) => {
      const found = await assistantRequests.markRead(
        request.params.id,
        text(request.body.requestId),
        await assistantScope(request, options),
      );
      if (!found) return reply.code(404).send({ error: "Response not found." });
      return { ok: true };
    },
  );

  // Compatibility for contextual clients. The HTTP response observes the same
  // durable job; closing the connection never cancels its execution.
  server.post<{ Body: JsonObject }>(
    "/studio/assistant/chat",
    { config: { auth: auth.write() } },
    async (request, reply) => {
      const queued = await enqueueAssistantRequest(request);
      const scope = await assistantScope(request, options);
      while (!reply.raw.destroyed) {
        const row = await assistantRequests.get(queued.id, scope);
        if (!row) return reply.code(404).send({ error: "Request not found." });
        if (row.status === "succeeded")
          return { ...row.response_json, conversationId: row.conversation_id };
        if (row.status === "failed" || row.status === "cancelled")
          return {
            conversationId: row.conversation_id,
            message: "",
            error: row.error_code || row.status,
            providerMessage: row.error || "Response cancelled.",
          };
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    },
  );

  server.get<{ Querystring: { archived?: string; search?: string } }>(
    "/studio/assistant/conversations",
    { config: { auth: auth.read() } },
    async (request) => ({
      conversations: await listAssistantConversations({
        ...(await assistantScope(request, options)),
        archived: request.query.archived === "true",
        search: request.query.search,
      }),
    }),
  );

  server.post<{ Body: JsonObject }>(
    "/studio/assistant/conversations",
    { config: { auth: auth.write() } },
    async (request) => {
      const scope = await assistantScope(request, options);
      if (!scope.organizationId) {
        throw new StudioValidationError(
          "organization_required",
          "An organization is required to start a conversation.",
        );
      }
      const conversationId = await createAssistantConversation({
        organizationId: scope.organizationId,
        projectId: currentProjectId(request),
        route: text(request.body?.route) || null,
        title: text(request.body?.title) || null,
        userId: scope.userId,
      });
      return {
        conversation: await getAssistantConversation(conversationId, scope),
      };
    },
  );

  server.get<{ Params: { id: string } }>(
    "/studio/assistant/conversations/:id",
    { config: { auth: auth.read() } },
    async (request, reply) => {
      const conversation = await getAssistantConversation(
        request.params.id,
        await assistantScope(request, options),
      );
      if (!conversation) {
        return reply.status(404).send({ error: "Conversation not found." });
      }
      return { conversation };
    },
  );

  server.post<{ Params: { id: string }; Body: JsonObject }>(
    "/studio/workflows/:id/duplicate",
    { config: { auth: auth.write({ machine: ["write:workflows"] }) } },
    async (request, reply) => {
      const id = await duplicateWorkflowTemplate({
        id: request.params.id,
        name: text(request.body?.name) || undefined,
        organizationId: currentOrganizationId(request),
        projectId: currentProjectId(request),
      });
      return reply.code(201).send({ id, duplicated: true });
    },
  );

  server.patch<{ Params: { id: string }; Body: JsonObject }>(
    "/studio/assistant/conversations/:id",
    { config: { auth: auth.write() } },
    async (request, reply) => {
      const scope = await assistantScope(request, options);
      const archived = request.body?.archived;
      if (archived !== undefined && typeof archived !== "boolean") {
        return reply.status(400).send({ error: "Archived must be a boolean." });
      }
      if (archived === undefined && !text(request.body?.title).trim()) {
        return reply
          .status(400)
          .send({ error: "Conversation title is required." });
      }
      const renamed =
        typeof archived === "boolean"
          ? await archiveAssistantConversation(
              request.params.id,
              archived,
              scope,
            )
          : await renameAssistantConversation(
              request.params.id,
              text(request.body?.title),
              scope,
            );
      if (!renamed) {
        return reply.status(404).send({ error: "Conversation not found." });
      }
      return { ok: true };
    },
  );

  server.delete<{ Params: { id: string } }>(
    "/studio/assistant/conversations/:id",
    { config: { auth: auth.write() } },
    async (request, reply) => {
      const deleted = await deleteAssistantConversation(
        request.params.id,
        await assistantScope(request, options),
      );
      if (!deleted) {
        return reply.status(404).send({ error: "Conversation not found." });
      }
      return { ok: true };
    },
  );

  server.get(
    "/studio/state",
    { config: { auth: auth.read({ machine: ["read:dashboard"] }) } },
    async (request) => {
      const organizationId = currentOrganizationId(request);
      return {
        organizationId,
        summary: dashboardSummary({ organizationId }),
        apiKeys: await listApiKeys({ organizationId }),
        credentials: await credentialRepository.list(
          organizationScope(organizationId),
        ),
        transfers: listTransfers({ organizationId }),
        schedules: listSchedules({ organizationId }),
        runs: listRuns({ organizationId }),
        logs: listExecutionLogs({ organizationId }),
      };
    },
  );

  server.get(
    "/studio/dashboard",
    { config: { auth: auth.read({ machine: ["read:dashboard"] }) } },
    async (request) => {
      const organizationId = currentOrganizationId(request);
      const [summary, workflows, runs, activity] = await Promise.all([
        workflowDashboardSummary({ organizationId }),
        listWorkflowTemplates({ organizationId }),
        listWorkflowRuns({ organizationId }),
        workflowRunActivity({ organizationId, days: 14 }),
      ]);

      return {
        organizationId,
        summary,
        activity,
        workflows: workflows.slice(0, 6),
        runs: runs.slice(0, 6),
      };
    },
  );

  server.get(
    "/studio/api-keys",
    { config: { auth: auth.read({ machine: ["read:api_keys"] }) } },
    async (request) => ({
      apiKeys: await listBillingApiKeys({
        organizationId: currentOrganizationId(request),
      }),
    }),
  );

  server.post<{ Body: JsonObject }>(
    "/studio/api-keys",
    { config: { auth: auth.write() } },
    async (request, reply) => {
      createApiKey({
        name: text(request.body.name),
        baseUrl: text(request.body.baseUrl),
        apiKey: text(request.body.apiKey),
      });
      return reply.code(201).send({ created: true });
    },
  );

  server.delete<{ Params: { id: string } }>(
    "/studio/api-keys/:id",
    { config: { auth: auth.write() } },
    async (request) => {
      deleteApiKey(request.params.id);
      return { deleted: true };
    },
  );

  server.get(
    "/studio/credentials",
    { config: { auth: auth.read({ machine: ["read:credentials"] }) } },
    async (request) => ({
      credentials: await credentialRepository.list(scopeOf(request)),
    }),
  );

  server.get<{ Params: { id: string } }>(
    "/studio/credentials/:id",
    { config: { auth: auth.read({ machine: ["read:credentials"] }) } },
    async (request, reply) => {
      const scope = scopeOf(request);
      const credential = (await credentialRepository.list(scope)).find(
        (item) => item.id === request.params.id,
      );
      if (!credential) {
        return reply.code(404).send({ error: "Credential not found" });
      }
      // The stored secrets never reach the browser. Editing needs the
      // non-secret configuration and to know which secrets are on file; the
      // values themselves stay behind the authorized backend boundary.
      const stored =
        (await credentialRepository.payload(scope, request.params.id)) ?? {};
      const { payload, secretFields } = safeCredentialPayload(stored);
      return { credential: { ...credential, payload, secretFields } };
    },
  );

  server.post<{ Body: JsonObject }>(
    "/studio/credentials",
    { config: { auth: auth.write({ machine: ["write:credentials"] }) } },
    async (request, reply) => {
      const kind = credentialKind(request.body.kind);
      const name = text(request.body.name);
      // Refuse an incomplete request before the connection test, which may
      // call the provider.
      await assertCredentialProvider(kind);
      if (!name) {
        throw new StudioValidationError(
          "credential_name_required",
          "Credential name is required.",
          { field: "name" },
        );
      }
      const payload = payloadObject(request.body.payload);
      const organizationId = currentOrganizationId(request);
      // Test before writing. A credential the provider rejects is refused
      // outright unless the caller explicitly opts out, so the gate holds for
      // API clients too and not just the Studio form.
      const validation = await testCredentialPayload({
        organizationId,
        kind,
        payload,
      });
      if (
        validation.status === "invalid" &&
        !truthy(request.body.allowUntested)
      ) {
        return reply.code(400).send({
          error:
            validation.errorMessage ??
            "The provider rejected these credentials.",
          code: validation.errorCode ?? "credential_rejected",
          validation,
        });
      }
      await createCredential({
        organizationId,
        name,
        kind,
        payload: JSON.stringify(payload),
        validation,
      });
      return reply.code(201).send({ created: true, validation });
    },
  );

  server.patch<{ Params: { id: string }; Body: JsonObject }>(
    "/studio/credentials/:id",
    { config: { auth: auth.write({ machine: ["write:credentials"] }) } },
    async (request) => {
      const organizationId = currentOrganizationId(request);
      const kind = credentialKind(request.body.kind);
      await assertCredentialProvider(kind);
      const payload = mergeCredentialPayload(
        (await credentialRepository.payload(
          scopeOf(request),
          request.params.id,
        )) ?? {},
        payloadObject(request.body.payload),
      );
      await validateProviderBuckets({
        provider: kind,
        payload,
        buckets: credentialBuckets(payload),
      });
      await updateCredential({
        id: request.params.id,
        organizationId,
        name: text(request.body.name),
        kind,
        payload: JSON.stringify(payload),
      });
      return { updated: true };
    },
  );

  server.delete<{ Params: { id: string } }>(
    "/studio/credentials/:id",
    { config: { auth: auth.write({ machine: ["write:credentials"] }) } },
    async (request, reply) => {
      // A credential belonging to another organization is not found here, and
      // reporting that honestly is what stops the caller's delete from reaching
      // it at all.
      const revoked = await credentialRepository.revoke(
        scopeOf(request),
        request.params.id,
      );
      if (!revoked) {
        return reply.code(404).send({ error: "Credential not found" });
      }
      return { deleted: true };
    },
  );

  server.post<{ Body: JsonObject }>(
    "/studio/credentials/validate-buckets",
    { config: { auth: auth.write({ machine: ["read:credentials"] }) } },
    async (request) => {
      const payload = payloadObject(request.body.payload);
      await validateProviderBuckets({
        provider: text(request.body.provider) || "s3",
        payload,
        buckets: credentialBuckets(payload),
      });
      return { ok: true };
    },
  );

  /**
   * Live connection test for any credential, run before it is saved.
   *
   * Returns the probe outcome rather than throwing, so the client can tell an
   * outright rejection ("invalid") apart from a check that could not complete
   * ("error"), and decide whether to offer saving anyway.
   */
  server.post<{ Body: JsonObject }>(
    "/studio/credentials/test",
    { config: { auth: auth.write({ machine: ["read:credentials"] }) } },
    async (request) => {
      const kind = credentialKind(request.body.kind);
      const payload = payloadObject(request.body.payload);
      return {
        result: await testCredentialPayload({
          organizationId: currentOrganizationId(request),
          kind,
          payload,
          credentialId: text(request.body.credentialId) || null,
        }),
      };
    },
  );

  /**
   * The actions a saved Zapier credential exposes.
   *
   * Read-only and named after the credential rather than the endpoint: the
   * MCP server URL carries a secret, so it never leaves the server.
   */
  server.get<{ Params: { id: string } }>(
    "/studio/credentials/:id/zapier/tools",
    { config: { auth: auth.read({ machine: ["read:credentials"] }) } },
    async (request, reply) => {
      try {
        return await listZapierTools({
          organizationId: currentOrganizationId(request),
          credentialId: request.params.id,
        });
      } catch (error) {
        // A picker that cannot reach Zapier falls back to free text, so this is
        // a reportable condition rather than a failed request.
        return reply.code(502).send({
          error: error instanceof Error ? error.message : "unknown error",
          tools: [],
        });
      }
    },
  );

  server.get(
    "/studio/storage/browser",
    { config: { auth: auth.read({ machine: ["read:credentials"] }) } },
    async (request) => {
      const query = request.query as JsonObject;
      return listCredentialObjects({
        pool: options.pgPool,
        organizationId: scopeOf(request).organizationId,
        credentialId: text(query.credentialId),
        bucket: text(query.bucket),
        prefix: text(query.prefix),
      });
    },
  );

  server.get(
    "/studio/transfers",
    { config: { auth: auth.read({ machine: ["read:transfers"] }) } },
    async (request) => {
      const query = request.query as JsonObject;
      return {
        transfers: listTransfers({
          organizationId: currentOrganizationId(request),
          q: text(query.q) || undefined,
          state: text(query.state) || "all",
        }),
      };
    },
  );

  server.post<{ Body: JsonObject }>(
    "/studio/transfers",
    { config: { auth: auth.write({ machine: ["write:transfers"] }) } },
    async (request, reply) => {
      const id = createTransfer({
        organizationId: currentOrganizationId(request),
        name: text(request.body.name),
        description: text(request.body.description),
        apiKeyId: text(request.body.apiKeyId),
        customApiKey: text(request.body.customApiKey),
        beamServerUrl: text(request.body.beamServerUrl),
        notificationWebhookUrl: text(request.body.notificationWebhookUrl),
        slackWebhookUrl: text(request.body.slackWebhookUrl),
        notifyOnStart: bool(request.body.notifyOnStart),
        notifyOnSuccess: bool(request.body.notifyOnSuccess),
        notifyOnFailure: bool(request.body.notifyOnFailure),
        notifyOnCancel: bool(request.body.notifyOnCancel),
        enabled:
          request.body.enabled === undefined
            ? true
            : bool(request.body.enabled),
        frequency: text(request.body.frequency),
      });
      return reply.code(201).send({ id, created: true });
    },
  );

  server.get<{ Params: { id: string } }>(
    "/studio/transfers/:id",
    { config: { auth: auth.read({ machine: ["read:transfers"] }) } },
    async (request, reply) => {
      const transfer = getTransfer(
        request.params.id,
        currentOrganizationId(request),
      );
      return transfer ?? reply.code(404).send({ error: "Transfer not found" });
    },
  );

  server.patch<{ Params: { id: string }; Body: JsonObject }>(
    "/studio/transfers/:id",
    { config: { auth: auth.write({ machine: ["write:transfers"] }) } },
    async (request) => {
      updateTransfer({
        id: request.params.id,
        organizationId: currentOrganizationId(request),
        name: text(request.body.name),
        description: text(request.body.description),
        apiKeyId: text(request.body.apiKeyId),
        customApiKey: text(request.body.customApiKey),
        removeCustomApiKey: bool(request.body.removeCustomApiKey),
        beamServerUrl: text(request.body.beamServerUrl),
        fileSuffixMode: text(request.body.fileSuffixMode) || "none",
        notificationWebhookUrl: text(request.body.notificationWebhookUrl),
        slackWebhookUrl: text(request.body.slackWebhookUrl),
        notifyOnStart: bool(request.body.notifyOnStart),
        notifyOnSuccess: bool(request.body.notifyOnSuccess),
        notifyOnFailure: bool(request.body.notifyOnFailure),
        notifyOnCancel: bool(request.body.notifyOnCancel),
        enabled: bool(request.body.enabled),
      });
      return { updated: true };
    },
  );

  server.delete<{ Params: { id: string } }>(
    "/studio/transfers/:id",
    { config: { auth: auth.write({ machine: ["write:transfers"] }) } },
    async (request) => {
      deleteTransfer(request.params.id, currentOrganizationId(request));
      return { deleted: true };
    },
  );

  server.post<{ Params: { id: string } }>(
    "/studio/transfers/:id/toggle",
    { config: { auth: auth.write({ machine: ["write:transfers"] }) } },
    async (request) => {
      toggleTransfer(request.params.id, currentOrganizationId(request));
      return { toggled: true };
    },
  );

  server.post<{ Params: { id: string } }>(
    "/studio/transfers/:id/run",
    { config: { auth: auth.write({ machine: ["run:transfers"] }) } },
    async (request, reply) => {
      const organizationId = currentOrganizationId(request);
      const transfer = getTransfer(request.params.id, organizationId);
      if (!transfer) {
        return reply.code(404).send({ error: "Transfer not found" });
      }

      // Reserve before enqueueing. Holding credit first means a run is never
      // started that the organization cannot pay for, and the hold is released
      // if the run turns out not to start.
      const reservation = await reserveActionCredit(reply, {
        action: "transfer.run",
        apiKeyId: transfer.transfer.apiKeyId,
        organizationId,
        transferId: request.params.id,
      });
      if (!reservation) return reply;

      try {
        const runId = startRun(request.params.id, organizationId, {
          creditOperationKey: reservation.operationKey,
        });
        return reply.code(202).send({ runId });
      } catch (error) {
        await releaseReservation(reservation, "run was never queued");
        throw error;
      }
    },
  );

  server.post<{ Params: { id: string }; Body: JsonObject }>(
    "/studio/transfers/:id/endpoints",
    { config: { auth: auth.write({ machine: ["write:transfers"] }) } },
    async (request, reply) => {
      const id = createEndpoint(endpointKind(request.body.kind), {
        organizationId: currentOrganizationId(request),
        transferTemplateId: request.params.id,
        name: text(request.body.name),
        provider: text(request.body.provider) || "s3",
        bucket: text(request.body.bucket),
        objectKey: text(request.body.objectKey),
        filenamePolicy: text(request.body.filenamePolicy),
        filenameTemplate: text(request.body.filenameTemplate),
        filenameTimezone: text(request.body.filenameTimezone),
        sourceType:
          text(request.body.sourceType) === "directory" ? "directory" : "file",
        region: text(request.body.region),
        endpointUrl: text(request.body.endpointUrl),
        credentialId: text(request.body.credentialId),
      });
      return reply.code(201).send({ id, created: true });
    },
  );

  server.patch<{
    Params: { id: string; endpointId: string };
    Body: JsonObject;
  }>(
    "/studio/transfers/:id/endpoints/:endpointId",
    { config: { auth: auth.write({ machine: ["write:transfers"] }) } },
    async (request) => {
      updateEndpoint(
        endpointKind(request.body.kind, request.params.endpointId),
        {
          organizationId: currentOrganizationId(request),
          transferTemplateId: request.params.id,
          id: request.params.endpointId,
          name: text(request.body.name),
          provider: text(request.body.provider) || "s3",
          bucket: text(request.body.bucket),
          objectKey: text(request.body.objectKey),
          filenamePolicy: text(request.body.filenamePolicy),
          filenameTemplate: text(request.body.filenameTemplate),
          filenameTimezone: text(request.body.filenameTimezone),
          sourceType:
            text(request.body.sourceType) === "directory"
              ? "directory"
              : "file",
          region: text(request.body.region),
          endpointUrl: text(request.body.endpointUrl),
          credentialId: text(request.body.credentialId),
        },
      );
      return { updated: true };
    },
  );

  // A DELETE usually has no body, so `kind` may also come from the query
  // string or, failing both, from the endpoint id.
  server.delete<{
    Params: { id: string; endpointId: string };
    Querystring: { kind?: string };
    Body: JsonObject;
  }>(
    "/studio/transfers/:id/endpoints/:endpointId",
    { config: { auth: auth.write({ machine: ["write:transfers"] }) } },
    async (request) => {
      deleteEndpoint(
        endpointKind(
          request.body.kind ?? request.query.kind,
          request.params.endpointId,
        ),
        request.params.endpointId,
        currentOrganizationId(request),
        request.params.id,
      );
      return { deleted: true };
    },
  );

  server.get(
    "/studio/runs",
    { config: { auth: auth.read({ machine: ["read:runs"] }) } },
    async (request) => {
      const query = request.query as JsonObject;
      const view = text(query.view);
      if (view === "queue") {
        return {
          runs: listQueueRuns({
            organizationId: currentOrganizationId(request),
          }),
        };
      }
      if (view === "dead-letter") {
        return {
          runs: listDeadLetterRuns({
            organizationId: currentOrganizationId(request),
          }),
        };
      }
      return {
        runs: listRuns({
          organizationId: currentOrganizationId(request),
          status: text(query.status) || "all",
          transferId: text(query.transferId) || undefined,
        }),
      };
    },
  );

  server.get(
    "/studio/reports/runs",
    { config: { auth: auth.read({ machine: ["read:dashboard"] }) } },
    async (request, reply) => {
      const rows = runsReportRows({
        organizationId: currentOrganizationId(request),
      });
      const query = request.query as JsonObject;
      if (text(query.format) === "csv") {
        return reply
          .type("text/csv; charset=utf-8")
          .header("Content-Disposition", 'attachment; filename="runs.csv"')
          .send(csv(rows));
      }
      return { runs: rows };
    },
  );

  server.get<{ Params: { id: string } }>(
    "/studio/runs/:id",
    { config: { auth: auth.read({ machine: ["read:runs"] }) } },
    async (request, reply) => {
      const run = getRun(request.params.id, currentOrganizationId(request));
      return run ?? reply.code(404).send({ error: "Run not found" });
    },
  );

  server.post<{ Params: { id: string } }>(
    "/studio/runs/:id/cancel",
    { config: { auth: auth.write({ machine: ["cancel:runs"] }) } },
    async (request) => {
      cancelRun(request.params.id, currentOrganizationId(request));
      return { cancelled: true };
    },
  );

  server.post<{ Params: { id: string } }>(
    "/studio/runs/:id/retry",
    { config: { auth: auth.write({ machine: ["run:transfers"] }) } },
    async (request, reply) => {
      const organizationId = currentOrganizationId(request);
      const run = getRun(request.params.id, organizationId);
      if (!run) {
        return reply.code(404).send({ error: "Run not found" });
      }
      // Refused before any credit is reserved for it.
      assertRunRetryable(run.run.status);

      // A retry is new work, so it is charged like any other run rather than
      // riding on the original run's settled reservation.
      const transfer = getTransfer(run.run.transferTemplateId, organizationId);
      const reservation = await reserveActionCredit(reply, {
        action: "transfer.run",
        apiKeyId: transfer?.transfer.apiKeyId,
        organizationId,
        transferId: run.run.transferTemplateId,
      });
      if (!reservation) return reply;

      try {
        const runId = retryRun(request.params.id, organizationId, {
          creditOperationKey: reservation.operationKey,
        });
        return reply.code(202).send({ runId });
      } catch (error) {
        await releaseReservation(reservation, "retry was never queued");
        throw error;
      }
    },
  );

  server.get(
    "/studio/queue",
    { config: { auth: auth.read({ machine: ["read:dashboard"] }) } },
    async (request) => ({
      runs: listQueueRuns({ organizationId: currentOrganizationId(request) }),
    }),
  );

  server.get(
    "/studio/dead-letter",
    { config: { auth: auth.read({ machine: ["read:dashboard"] }) } },
    async (request) => ({
      runs: listDeadLetterRuns({
        organizationId: currentOrganizationId(request),
      }),
    }),
  );

  server.get(
    "/studio/workers",
    { config: { auth: auth.read({ machine: ["read:dashboard"] }) } },
    async () => ({
      orchestrators: await listOrchestrators(),
      workers: await listWorkers(options.pgPool),
    }),
  );

  // Estimates are priced here, on read, from the published price book; an
  // estimate that cannot be priced is null and the UI says it is unavailable.
  server.get(
    "/studio/schedules",
    { config: { auth: auth.read({ machine: ["read:schedules"] }) } },
    async (request) => {
      const organizationId = currentOrganizationId(request);
      const transfers = await priceTransfers(
        listTransfers({ organizationId }),
        organizationId,
      );
      return {
        schedules: priceSchedules(listSchedules({ organizationId }), transfers),
        transfers,
      };
    },
  );

  server.post<{ Body: JsonObject }>(
    "/studio/schedules",
    { config: { auth: auth.write({ machine: ["write:schedules"] }) } },
    async (request, reply) => {
      const id = createSchedule({
        organizationId: currentOrganizationId(request),
        transferTemplateId: text(request.body.transferTemplateId),
        frequency: text(request.body.frequency),
        enabled:
          request.body.enabled === undefined
            ? true
            : bool(request.body.enabled),
        nextRunAt: text(request.body.nextRunAt),
        endAt: text(request.body.endAt),
        timezone: text(request.body.timezone),
        maxRunDurationSeconds: text(request.body.maxRunDurationSeconds),
        creditBudgetLimit: text(request.body.creditBudgetLimit),
        maxRuns: text(request.body.maxRuns),
        windowStartTime: text(request.body.windowStartTime),
        windowEndTime: text(request.body.windowEndTime),
        windowDays: stringArray(request.body.windowDays),
        overlapPolicy: text(request.body.overlapPolicy),
        budgetAlertThreshold: text(request.body.budgetAlertThreshold),
      });
      return reply.code(201).send({ id, created: true });
    },
  );

  server.get<{ Params: { id: string } }>(
    "/studio/schedules/:id",
    { config: { auth: auth.read({ machine: ["read:schedules"] }) } },
    async (request, reply) => {
      const organizationId = currentOrganizationId(request);
      const schedule = listSchedules({ organizationId }).find(
        (item) => item.id === request.params.id,
      );
      if (!schedule) {
        return reply.code(404).send({ error: "Schedule not found" });
      }
      const transfers = await priceTransfers(
        listTransfers({ organizationId }).filter(
          (transfer) => transfer.id === schedule.transferTemplateId,
        ),
        organizationId,
      );
      return { schedule: priceSchedules([schedule], transfers)[0] };
    },
  );

  server.patch<{ Params: { id: string }; Body: JsonObject }>(
    "/studio/schedules/:id",
    { config: { auth: auth.write({ machine: ["write:schedules"] }) } },
    async (request) => {
      updateSchedule({
        id: request.params.id,
        organizationId: currentOrganizationId(request),
        transferTemplateId: text(request.body.transferTemplateId),
        frequency: text(request.body.frequency),
        enabled: bool(request.body.enabled),
        nextRunAt: text(request.body.nextRunAt),
        endAt: text(request.body.endAt),
        timezone: text(request.body.timezone),
        maxRunDurationSeconds: text(request.body.maxRunDurationSeconds),
        creditBudgetLimit: text(request.body.creditBudgetLimit),
        maxRuns: text(request.body.maxRuns),
        windowStartTime: text(request.body.windowStartTime),
        windowEndTime: text(request.body.windowEndTime),
        windowDays: stringArray(request.body.windowDays),
        overlapPolicy: text(request.body.overlapPolicy),
        budgetAlertThreshold: text(request.body.budgetAlertThreshold),
      });
      return { updated: true };
    },
  );

  server.post<{ Params: { id: string } }>(
    "/studio/schedules/:id/toggle",
    { config: { auth: auth.write({ machine: ["write:schedules"] }) } },
    async (request) => {
      toggleSchedule(request.params.id, currentOrganizationId(request));
      return { toggled: true };
    },
  );

  server.delete<{ Params: { id: string } }>(
    "/studio/schedules/:id",
    { config: { auth: auth.write({ machine: ["write:schedules"] }) } },
    async (request) => {
      deleteSchedule(request.params.id, currentOrganizationId(request));
      return { deleted: true };
    },
  );

  server.get(
    "/studio/workflows",
    { config: { auth: auth.read({ machine: ["read:workflows"] }) } },
    async (request) => ({
      workflows: await new WorkflowReadRepository(options.pgPool).listWorkflows(
        organizationScope(currentOrganizationId(request)),
        currentProjectId(request),
      ),
    }),
  );

  server.get(
    "/studio/workflow-runs",
    { config: { auth: auth.read({ machine: ["read:runs"] }) } },
    async (request) => {
      const query = request.query as JsonObject;
      return new WorkflowReadRepository(options.pgPool).runsPage(
        organizationScope(currentOrganizationId(request)),
        {
          projectId: currentProjectId(request),
          status: text(query.status) || "all",
          workflowTemplateId: text(query.workflowTemplateId) || undefined,
          actionPackage: text(query.actionPackage) || undefined,
          from: text(query.from) || undefined,
          to: text(query.to) || undefined,
          search: text(query.search),
          view: text(query.view),
          limit: Number(query.limit) || 50,
          cursor: text(query.cursor) || undefined,
        },
      );
    },
  );

  server.patch<{ Params: { id: string }; Body: { parentId: string | null } }>(
    "/studio/workflows/:id/sidebar-parent",
    {
      config: { auth: auth.write({ machine: ["write:workflows"] }) },
      schema: {
        body: {
          type: "object",
          required: ["parentId"],
          additionalProperties: false,
          properties: {
            parentId: {
              anyOf: [
                { type: "string", minLength: 1, maxLength: 200 },
                { type: "null" },
              ],
            },
          },
        },
      },
    },
    async (request) =>
      new WorkflowHierarchyRepository(options.pgPool).move(
        organizationScope(currentOrganizationId(request)),
        request.params.id,
        request.body.parentId,
        currentProjectId(request),
      ),
  );

  /**
   * Budget threshold alerts for the warning bar.
   *
   * Read through a service account credential against the Beam management API,
   * so Studio sees exactly what that credential is permitted to see.
   */
  server.get(
    "/studio/budget-alerts",
    { config: { auth: auth.read({ machine: ["read:dashboard"] }) } },
    async (request, reply) => {
      const scope = await studioScope(request);
      const result = await fetchBudgetAlerts();

      // The credential speaks for one organization; this Studio serves several.
      // Serving its alerts to whoever happens to be looking would show one
      // organization's key names, spend and projects to another's members, so a
      // viewer outside that organization gets nothing rather than someone else's
      // budgets.
      const viewerOwnsThem =
        result.organizationId !== null &&
        result.organizationId === scope.organizationId;

      return reply.send({
        alerts: viewerOwnsThem ? result.alerts : [],
        configured: result.configured && viewerOwnsThem,
        mostUrgent: viewerOwnsThem ? mostUrgentAlert(result.alerts) : null,
      });
    },
  );

  server.post<{ Body: JsonObject }>(
    "/studio/room-workflows",
    { config: { auth: auth.write() } },
    async (request, reply) => {
      const { organizationId } = await studioScope(request);
      return reply.code(201).send(
        await createRoomWorkflow({
          organizationId,
          projectId: currentProjectId(request),
          name: text(request.body.name) || "Room transfer",
          apiKeyId: text(request.body.apiKeyId),
          requestId: text(request.body.requestId),
          config: await roomWorkflowConfigForRequest(
            organizationId,
            request.body.config,
          ),
        }),
      );
    },
  );

  server.post<{ Body: JsonObject }>(
    "/studio/workflows",
    { config: { auth: auth.write({ machine: ["write:workflows"] }) } },
    async (request, reply) => {
      const id = await createWorkflowTemplate({
        room: request.body.room as Parameters<
          typeof createWorkflowTemplate
        >[0]["room"],
        organizationId: currentOrganizationId(request),
        projectId: currentProjectId(request),
        name: text(request.body.name),
        description: text(request.body.description),
        apiKeyId: text(request.body.apiKeyId),
      });
      return reply.code(201).send({ id, created: true });
    },
  );

  server.get<{ Params: { id: string } }>(
    "/studio/workflows/:id",
    { config: { auth: auth.read({ machine: ["read:workflows"] }) } },
    async (request, reply) => {
      const workflow = await getWorkflowTemplate(
        request.params.id,
        currentOrganizationId(request),
      );
      return workflow ?? reply.code(404).send({ error: "Workflow not found" });
    },
  );

  server.patch<{ Params: { id: string }; Body: JsonObject }>(
    "/studio/workflows/:id",
    { config: { auth: auth.write({ machine: ["write:workflows"] }) } },
    async (request, reply) => {
      if (
        request.body.enabled !== undefined &&
        typeof request.body.enabled !== "boolean"
      ) {
        throw new StudioValidationError(
          "workflow_enabled_invalid",
          "enabled must be true or false.",
          { field: "enabled" },
        );
      }
      const workflow = await updateWorkflowTemplate({
        agentBindings: request.body.agentBindings as Parameters<
          typeof updateWorkflowTemplate
        >[0]["agentBindings"],
        resourceBindings: request.body.resourceBindings as Parameters<
          typeof updateWorkflowTemplate
        >[0]["resourceBindings"],
        room: request.body.room as Parameters<
          typeof updateWorkflowTemplate
        >[0]["room"],
        id: request.params.id,
        inputSchema: request.body.inputSchema as Parameters<
          typeof updateWorkflowTemplate
        >[0]["inputSchema"],
        output: request.body.output as Parameters<
          typeof updateWorkflowTemplate
        >[0]["output"],
        failurePolicy: request.body.failurePolicy as Parameters<
          typeof updateWorkflowTemplate
        >[0]["failurePolicy"],
        organizationId: currentOrganizationId(request),
        // undefined leaves the binding alone; an explicit empty value clears it.
        apiKeyId:
          request.body.apiKeyId === undefined
            ? undefined
            : text(request.body.apiKeyId),
        name:
          request.body.name === undefined ? undefined : text(request.body.name),
        description:
          request.body.description === undefined
            ? undefined
            : text(request.body.description),
        enabled: request.body.enabled,
      });
      return workflow ?? reply.code(404).send({ error: "Workflow not found" });
    },
  );

  server.get<{ Params: { id: string } }>(
    "/studio/workflows/:id/references",
    { config: { auth: auth.read({ machine: ["read:workflows"] }) } },
    async (request, reply) => {
      const references = await getWorkflowReferences(
        request.params.id,
        currentOrganizationId(request),
      );
      return references ?? reply.code(404).send({ error: "Workflow not found" });
    },
  );

  server.delete<{ Params: { id: string } }>(
    "/studio/workflows/:id",
    { config: { auth: auth.write({ machine: ["write:workflows"] }) } },
    async (request) => {
      await deleteWorkflowTemplate(
        request.params.id,
        currentOrganizationId(request),
      );
      return { deleted: true };
    },
  );

  /**
   * What this workflow would cost to run, priced from the published price book.
   *
   * Read-only: it takes no hold and settles nothing, so it is safe to call as a
   * graph is edited. It is deliberately off the run path — a price that cannot
   * be fetched must never delay or block a run.
   *
   * The caller describes the graph it currently has, including unsaved edits,
   * because an estimate for the last saved version would answer for a workflow
   * nobody is about to run.
   */
  server.post<{ Params: { id: string }; Body: JsonObject }>(
    "/studio/workflows/:id/credit-estimate",
    { config: { auth: auth.write({ machine: ["read:workflows"] }) } },
    async (request, reply) => {
      const organizationId = currentOrganizationId(request);
      const workflow = await getWorkflowTemplate(
        request.params.id,
        organizationId,
      );
      if (!workflow) {
        return reply.code(404).send({ error: "Workflow not found" });
      }

      // Priced with the key the run would be charged to: the one selected in
      // Workflow Settings or, without one, the Beam Transfer steps' credential
      // as the canvas currently has it.
      const billingKey = resolveWorkflowBillingKey(
        workflow.template.apiKeyId,
        transferCredentialIds(request.body).map((credentialId) => ({
          actionPackage: BEAM_TRANSFER_ACTION,
          config: { credentialId },
        })),
      );
      if (billingKey.apiKeyId === null) {
        return reply.code(400).send({
          error: missingBillingKeyMessage(billingKey.reason),
          code: "api_key_required",
        });
      }

      try {
        return await estimateWorkflowCredits({
          apiKeyId: billingKey.apiKeyId,
          organizationId,
          transfers: transferProjections(request.body),
        });
      } catch (error) {
        if (error instanceof ActionNotBillableError) {
          return reply
            .code(error.statusCode)
            .send({ error: error.message, code: "api_key_required" });
        }

        if (error instanceof CreditReservationError) {
          return reply.code(error.statusCode).send({
            error: error.message,
            code: error.code,
            reason: error.reason,
          });
        }

        throw error;
      }
    },
  );

  server.post<{ Params: { id: string }; Body: JsonObject }>(
    "/studio/workflows/:id/run",
    { config: { auth: auth.write({ machine: ["run:workflows"] }) } },
    async (request, reply) => {
      const organizationId = currentOrganizationId(request);
      logger.info(
        {
          workflowTemplateId: request.params.id,
          organizationId,
        },
        "Workflow run requested",
      );

      const workflow = await getWorkflowTemplate(
        request.params.id,
        organizationId,
      );
      if (!workflow) {
        return reply.code(404).send({ error: "Workflow not found" });
      }
      assertRoomWorkflowServicesAvailable(workflow);

      try {
        const runId = await startWorkflowRun(
          request.params.id,
          organizationId,
          {
            triggerId: text(request.body?.triggerId),
            triggerEvent: payloadObject(request.body?.triggerEvent),
            runtimeInput: payloadObject(request.body?.input),
            initiatingPrincipalId:
              studioRequestSession(request)?.userId ?? null,
          },
        );
        logger.info(
          {
            workflowTemplateId: request.params.id,
            organizationId,
            workflowRunId: runId,
          },
          "Workflow run queued",
        );
        return reply.code(202).send({ runId });
      } catch (error) {
        logger.error(
          {
            err: error,
            workflowTemplateId: request.params.id,
            organizationId,
          },
          "Workflow run request failed",
        );
        throw error;
      }
    },
  );

  const layouts = new WorkflowLayoutRepository(options.pgPool);
  server.get<{ Params: { id: string } }>(
    "/studio/workflows/:id/layout",
    { config: { auth: auth.read({ machine: ["read:workflows"] }) } },
    async (request, reply) => {
      const scope = organizationScope(currentOrganizationId(request));
      const revision = await layouts.revision(scope, request.params.id);
      const etag = `"layout-${request.params.id}-${revision}"`;
      reply.header("Cache-Control", "private, no-cache");
      if (request.headers["if-none-match"] === etag) {
        return reply.header("ETag", etag).code(304).send();
      }
      const layout = await layouts.read(scope, request.params.id);
      return reply
        .header("ETag", `"layout-${request.params.id}-${layout.revision}"`)
        .send(layout);
    },
  );
  server.patch<{ Params: { id: string }; Body: unknown }>(
    "/studio/workflows/:id/layout",
    { config: { auth: auth.write({ machine: ["write:workflows"] }) } },
    async (request) =>
      layouts.write(
        organizationScope(currentOrganizationId(request)),
        request.params.id,
        request.body,
      ),
  );

  server.patch<{ Params: { id: string }; Body: JsonObject }>(
    "/studio/workflows/:id/graph",
    { config: { auth: auth.write({ machine: ["write:workflows"] }) } },
    async (request, reply) => {
      const workflow = await saveWorkflowGraph({
        organizationId: currentOrganizationId(request),
        workflowTemplateId: request.params.id,
        body: request.body,
      });
      return workflow ?? reply.code(404).send({ error: "Workflow not found" });
    },
  );

  server.post<{ Params: { id: string }; Body: JsonObject }>(
    "/studio/workflows/:id/assistant/plan",
    { config: { auth: auth.write() } },
    async (request) => {
      const provider = await assistantProviderForRequest(
        request,
        options,
        optionalText(request.body.model),
      );
      return createAssistantWorkflowPlan({
        actions: await listActionPackages({
          organizationId: currentOrganizationId(request),
        }),
        prompt: text(request.body.prompt),
        provider,
        reasoningEffort: optionalReasoningEffort(request.body.reasoningEffort),
        selectedNodeId: text(request.body.selectedNodeId) || undefined,
        validationErrors: Array.isArray(request.body.validationErrors)
          ? request.body.validationErrors.map(String).slice(0, 80)
          : [],
        workflow: request.body.workflow,
        workflowId: request.params.id,
      });
    },
  );

  server.post<{ Body: JsonObject }>(
    "/studio/workflows/step-config",
    { config: { auth: auth.write({ machine: ["read:workflows"] }) } },
    async (request) => {
      await updateWorkflowStepConfig({
        organizationId: currentOrganizationId(request),
        stepId: text(request.body.stepId),
        configJson: text(request.body.configJson),
      });
      return { updated: true };
    },
  );

  server.get(
    "/studio/workflow-actions",
    { config: { auth: auth.read({ machine: ["read:workflows"] }) } },
    async (request) => ({
      actions: await listActionPackages({
        organizationId: currentOrganizationId(request),
      }),
    }),
  );

  server.get(
    "/studio/registry",
    { config: { auth: auth.read() } },
    async (request) => listRegistryPackages(currentOrganizationId(request)),
  );

  server.get(
    "/studio/registry/public",
    { config: { auth: auth.read({ machine: ["read:registry"] }) } },
    async (request) =>
      listPublicRegistryPackages(currentOrganizationId(request)),
  );

  server.post<{ Body: JsonObject }>(
    "/studio/registry/install",
    { config: { auth: auth.write() } },
    async (request) => ({
      installed: await installPublicRegistryPackage({
        packageName: text(request.body.packageName),
        range: text(request.body.range) ?? "latest",
        organizationId: currentOrganizationId(request),
      }),
    }),
  );

  server.get(
    "/studio/workflows/execution-locations",
    { config: { auth: auth.read({ machine: ["read:workflows"] }) } },
    async (request) => ({
      locations: await listExecutionLocations({
        organizationId: currentOrganizationId(request),
      }),
    }),
  );

  server.post<{ Body: JsonObject }>(
    "/studio/workflows/execution-locations",
    { config: { auth: auth.write({ machine: ["write:workflows"] }) } },
    async (request, reply) => {
      const id = await createExecutionLocation({
        organizationId: currentOrganizationId(request),
        name: text(request.body.name),
        kind: text(request.body.kind),
        endpointUrl: text(request.body.endpointUrl),
        headersJson: text(request.body.headersJson),
        enabled:
          request.body.enabled === undefined
            ? true
            : bool(request.body.enabled),
        allowInsecureHttp: bool(request.body.allowInsecureHttp),
      });
      return reply.code(201).send({ id, created: true });
    },
  );

  server.get<{ Params: { id: string } }>(
    "/studio/workflow-runs/:id",
    { config: { auth: auth.read({ machine: ["read:runs"] }) } },
    async (request, reply) => {
      const run = await getWorkflowRun(
        request.params.id,
        currentOrganizationId(request),
      );
      return run ?? reply.code(404).send({ error: "Workflow run not found" });
    },
  );

  server.get<{ Params: { id: string } }>(
    "/studio/workflow-runs/:id/evidence",
    { config: { auth: auth.read({ machine: ["read:runs"] }) } },
    async (request, reply) => {
      const bundle = await inspectWorkflowRun(
        request.params.id,
        currentOrganizationId(request),
        {
          roomService: (_organizationId, template) =>
            roomServiceForRequest(request, template),
        },
      );
      if (!bundle)
        return reply.code(404).send({ error: "Workflow run not found" });
      return {
        resolvedMembersByPartition: bundle.resolvedMembersByPartition,
        distributedTasks: bundle.distributedTasks,
        steps: bundle.stepRuns
          .filter((step) => step.actionPackageName === "@beam/room-transfer")
          .map((step) => ({
            id: step.id,
            attempt: step.attempt,
            publicationId: step.state.publicationId,
            execution: step.state.execution ?? null,
            executionInspection: step.state.executionInspection ?? null,
          })),
      };
    },
  );

  server.get<{ Params: { id: string; artifactId: string } }>(
    "/studio/workflow-runs/:id/artifacts/:artifactId/content",
    { config: { auth: auth.read({ machine: ["read:runs"] }) } },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header(
        "Content-Disposition",
        'attachment; filename="workflow-artifact"',
      );
      const scope = await studioScope(request);
      const result = await readWorkflowArtifactContent(options.pgPool, {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        runId: request.params.id,
        artifactId: request.params.artifactId,
      });
      if (result.status === "not_found")
        return reply.code(404).send({ code: "workflow_artifact_not_found" });
      if (result.status !== "ok")
        return reply
          .code(409)
          .send({ code: "workflow_artifact_content_unavailable" });
      return reply
        .type("application/octet-stream")
        .send(Buffer.from(result.bytes));
    },
  );

  server.post<{ Params: { id: string } }>(
    "/studio/workflow-runs/:id/cancel",
    { config: { auth: auth.write({ machine: ["cancel:runs"] }) } },
    async (request) => {
      await cancelWorkflowRun(
        request.params.id,
        currentOrganizationId(request),
      );
      return { cancelRequested: true };
    },
  );

  server.post<{ Params: { id: string } }>(
    "/studio/workflow-runs/:id/retry",
    { config: { auth: auth.write({ machine: ["run:workflows"] }) } },
    async (request, reply) => {
      const organizationId = currentOrganizationId(request);
      const workflowRun = await getWorkflowRun(
        request.params.id,
        organizationId,
      );
      if (!workflowRun) {
        return reply.code(404).send({ error: "Workflow run not found" });
      }

      if (!workflowRun.template) {
        return reply.code(404).send({ error: "Workflow not found" });
      }
      await assertRoomWorkflowRunServicesAvailable(
        request.params.id,
        organizationId,
      );
      const runId = await retryWorkflowRun(request.params.id, organizationId);
      return reply.code(202).send({ runId });
    },
  );

  server.get<{
    Params: { id: string; controlId: string };
    Querystring: { offset?: string; limit?: string };
  }>(
    "/studio/workflow-runs/:id/regions/:controlId/instances",
    { config: { auth: auth.read({ machine: ["read:runs"] }) } },
    async (request, reply) => {
      const result = await listWorkflowDynamicInstances({
        workflowRunId: request.params.id,
        controlId: request.params.controlId,
        organizationId: currentOrganizationId(request),
        offset: Number(request.query.offset ?? 0),
        limit: Number(request.query.limit ?? 50),
      });
      return (
        result ?? reply.code(404).send({ error: "Dynamic region not found" })
      );
    },
  );

  server.post<{ Params: { id: string; controlId: string } }>(
    "/studio/workflow-runs/:id/regions/:controlId/cancel",
    { config: { auth: auth.write({ machine: ["cancel:runs"] }) } },
    async (request) => {
      const session = studioRequestSession(request);
      return {
        region: await cancelWorkflowDynamicRegion({
          workflowRunId: request.params.id,
          controlId: request.params.controlId,
          organizationId: currentOrganizationId(request),
          requestedBy: session?.userId ?? null,
        }),
      };
    },
  );

  server.post<{ Params: { id: string; controlId: string } }>(
    "/studio/workflow-runs/:id/regions/:controlId/retry",
    { config: { auth: auth.write({ machine: ["run:workflows"] }) } },
    async (request, reply) => {
      const session = studioRequestSession(request);
      return reply.code(202).send({
        region: await retryWorkflowDynamicRegion({
          workflowRunId: request.params.id,
          controlId: request.params.controlId,
          organizationId: currentOrganizationId(request),
          requestedBy: session?.userId ?? null,
        }),
      });
    },
  );

  server.get(
    "/studio/mcp",
    { config: { auth: auth.read() } },
    async (request) => {
      const scope = scopeOf(request);
      const [tokens, usage] = await Promise.all([
        mcpTokenRepository.list(scope),
        mcpTokenRepository.usageSummaries(scope),
      ]);
      return {
        tokens,
        usage,
        activity: listMcpAuditEvents({ organizationId: scope.organizationId }),
      };
    },
  );

  server.post<{ Body: JsonObject }>(
    "/studio/mcp/tokens",
    { config: { auth: auth.write() } },
    async (request, reply) => {
      const result = await mcpTokenRepository.create(scopeOf(request), {
        name: text(request.body.name),
        expiresAt: text(request.body.expiresAt),
        scopes: stringArray(request.body.scopes),
      });
      return reply.code(201).send(result);
    },
  );

  server.post<{ Params: { id: string } }>(
    "/studio/mcp/tokens/:id/revoke",
    { config: { auth: auth.write() } },
    async (request) => {
      const revoked = await mcpTokenRepository.revoke(
        scopeOf(request),
        request.params.id,
      );
      if (!revoked) return { revoked: false };
      return { revoked: true };
    },
  );

  server.delete<{ Params: { id: string } }>(
    "/studio/mcp/tokens/:id",
    { config: { auth: auth.write() } },
    async (request) => {
      const deleted = await mcpTokenRepository.delete(
        scopeOf(request),
        request.params.id,
      );
      if (!deleted) return { deleted: false };
      return { deleted: true };
    },
  );
}

async function assistantScope(
  request: FastifyRequest,
  services: StudioRouteServices,
) {
  const session = studioRequestSession(request);
  return {
    organizationId: currentOrganizationId(request),
    projectId: currentProjectId(request),
    userId: session && "userId" in session ? session.userId : null,
  };
}

async function assistantModelCatalog(
  request: FastifyRequest,
  services: StudioRouteServices,
  refresh = false,
): Promise<AssistantModelCatalogPayload> {
  const settings = await getAssistantProviderSettings(
    await assistantScope(request, services),
  );
  if (!settings || settings.providerId !== BEAM_AI_PROVIDER_ID) {
    return { models: [], cached: false, cachedAt: null };
  }
  if (!refresh && settings.modelsCachedAt) {
    return {
      models: settings.models,
      cached: true,
      cachedAt: settings.modelsCachedAt,
    };
  }

  const cacheKey = [
    settings.organizationId,
    settings.userId,
    settings.providerId,
    settings.baseUrl,
    settings.updatedAt,
  ].join(":");
  const existingLoad = assistantModelLoads.get(cacheKey);
  if (existingLoad) return existingLoad;

  const load = (async () => {
    try {
      const provider = beamAiProviderForRequest(
        request,
        services,
        settings.model,
      );
      const models = await listAssistantProviderModels(provider);
      const cachedAt = await cacheAssistantProviderModels({
        organizationId: settings.organizationId,
        userId: settings.userId,
        providerId: settings.providerId,
        baseUrl: settings.baseUrl,
        settingsUpdatedAt: settings.updatedAt,
        models,
      });
      return { models, cached: false, cachedAt };
    } catch (error) {
      if (settings.modelsCachedAt) {
        return {
          models: settings.models,
          cached: true,
          cachedAt: settings.modelsCachedAt,
          stale: true,
        };
      }
      throw error;
    } finally {
      assistantModelLoads.delete(cacheKey);
    }
  })();
  assistantModelLoads.set(cacheKey, load);
  return load;
}

async function assistantProviderForRequest(
  request: FastifyRequest,
  services: StudioRouteServices,
  selectedModel?: string,
): Promise<AssistantProviderConfig | undefined> {
  const settings = await getAssistantProviderSettings(
    await assistantScope(request, services),
  );
  if (!settings || settings.providerId !== BEAM_AI_PROVIDER_ID) {
    return undefined;
  }

  return beamAiProviderForRequest(
    request,
    services,
    settings.model,
    selectedModel,
  );
}

function beamAiProviderForRequest(
  request: FastifyRequest,
  services: StudioRouteServices,
  model: string,
  selectedModel?: string,
) {
  const organizationId = currentOrganizationId(request);
  return assistantProviderFromSettings({
    providerId: BEAM_AI_PROVIDER_ID,
    baseUrl: beamAiBaseUrl(),
    managedCredentials: true,
    model,
    request: (input, init) =>
      studioRequestAuth(request).beamApi.fetchResponse(input, init),
    requestHeaders: organizationId
      ? { "X-Organization-Id": organizationId }
      : {},
    selectedModel,
  });
}

function beamAiBaseUrl() {
  return new URL("api/ai/v1", `${webEnv.apiUrl.replace(/\/+$/, "")}/`)
    .toString()
    .replace(/\/+$/, "");
}

async function assistantExecutionScope(
  request: FastifyRequest,
  services: StudioRouteServices,
): Promise<AssistantExecutionScope> {
  const session = studioRequestSession(request);
  const organizationId = currentOrganizationId(request);
  if (!organizationId) {
    throw new AssistantPlanError(
      "organization_required",
      "Select an organization before using Studio actions.",
      400,
    );
  }
  if (!session) {
    throw new AssistantPlanError(
      "authentication_required",
      "Sign in before using Studio actions.",
      401,
    );
  }
  const projectId = currentProjectId(request);
  let permissions = [
    "studio:read",
    "workflow:read",
    "workflow:write",
    "workflow:delete",
    "workflow:execute",
    "transfer:write",
    "transfer:delete",
    "transfer:execute",
    "schedule:write",
    "schedule:delete",
    "credential:read",
    "credential:write",
    "credential:delete",
    "registry:read",
    "registry:install",
    "run:read",
    "run:execute",
    "orchestration:read",
    "orchestration:write",
    "mcp:read",
    "mcp:write",
    "mcp:delete",
  ];
  {
    const organizationPayload = await fetchCentralStudioJson<{
      organizations?: OrganizationOption[];
    }>("/api/organizations", studioRequestAuth(request).beamApi);
    const organization = organizationPayload?.organizations?.find(
      (item) => item.id === organizationId,
    );
    if (!organization) {
      throw new AssistantPlanError(
        "organization_forbidden",
        "The current user cannot access the selected organization.",
        403,
      );
    }
    if (projectId) {
      const projectPayload = await fetchCentralStudioJson<{
        projects?: ProjectOption[];
      }>(
        `/api/projects?organizationId=${encodeURIComponent(organizationId)}`,
        studioRequestAuth(request).beamApi,
      );
      if (
        !projectPayload?.projects?.some((project) => project.id === projectId)
      ) {
        throw new AssistantPlanError(
          "project_forbidden",
          "The current user cannot access the selected project.",
          403,
        );
      }
    }
    const readOnly =
      organization.role === "viewer" ||
      organization.role === "read_only" ||
      organization.restrictionStatus === "restricted";
    permissions = readOnly
      ? [
          "studio:read",
          "workflow:read",
          "credential:read",
          "registry:read",
          "run:read",
          "orchestration:read",
          "mcp:read",
        ]
      : permissions;
  }
  return {
    organizationId,
    projectId,
    userId: session.userId,
    permissions,
  };
}

async function validateAssistantWorkspaceSwitch(
  request: FastifyRequest,
  plan: AssistantOperationPlan,
  services: StudioRouteServices,
) {
  const operation = plan.operations.find(
    (candidate) => candidate.tool === "workspace.switch",
  );
  if (!operation) {
    return;
  }
  const organizationId = text(operation.arguments.organizationId);
  const projectId = text(operation.arguments.projectId);
  if (!organizationId) {
    throw new AssistantPlanError(
      "organization_required",
      "The target organization is required.",
      422,
    );
  }
  const organizationPayload = await fetchCentralStudioJson<{
    organizations?: OrganizationOption[];
  }>("/api/organizations", studioRequestAuth(request).beamApi);
  if (
    !organizationPayload?.organizations?.some(
      (organization) => organization.id === organizationId,
    )
  ) {
    throw new AssistantPlanError(
      "organization_forbidden",
      "The target organization is unavailable.",
      403,
    );
  }
  if (!projectId) {
    return;
  }
  const projectPayload = await fetchCentralStudioJson<{
    projects?: ProjectOption[];
  }>(
    `/api/projects?organizationId=${encodeURIComponent(organizationId)}`,
    studioRequestAuth(request).beamApi,
  );
  if (!projectPayload?.projects?.some((project) => project.id === projectId)) {
    throw new AssistantPlanError(
      "project_forbidden",
      "The target project is unavailable in the selected organization.",
      403,
    );
  }
}

async function requiredAssistantPlan(
  id: string,
  scope: AssistantExecutionScope,
  pool: PgPool,
) {
  const plan = await new AssistantPlanRepository(pool).get(id, scope);
  if (!plan) {
    throw new AssistantPlanError("plan_not_found", "Plan not found.", 404);
  }
  return plan;
}

/**
 * Reserve credit for a billable action, replying with the right status when the
 * organization cannot pay.
 *
 * Returns null when a reply has already been sent, so the caller stops.
 *
 * A refusal names which limit was hit, because an organization has one pool but
 * many keys and the three causes are fixed in different places: top the
 * organization up, raise this key's cap, or wait out its monthly budget.
 */
async function reserveActionCredit(
  reply: FastifyReply,
  input: {
    action: BillableAction;
    apiKeyId: string | null | undefined;
    organizationId?: string | null;
    transferId?: string;
  },
): Promise<ActionReservation | null> {
  try {
    return await reserveAction(input);
  } catch (error) {
    if (error instanceof ActionNotBillableError) {
      reply.code(error.statusCode).send({ error: error.message });
      return null;
    }

    if (error instanceof CreditReservationError) {
      reply.code(error.statusCode).send({
        error: error.message,
        code: error.code,
        reason: error.reason,
      });
      return null;
    }

    throw error;
  }
}

function currentOrganizationId(request: FastifyRequest) {
  return studioRequestOrganizationId(request);
}

function studioAssistantRouteInfo(route: string): StudioAssistantRouteInfo {
  const pathname = route.split("?")[0] || "/";
  const workflowRunMatch = pathname.match(/^\/workflows\/runs\/([^/]+)/);
  const runMatch = pathname.match(/^\/runs\/([^/]+)/);
  const workflowMatch = pathname.match(
    /^\/workflows\/(?!actions(?:\/|$)|runs(?:\/|$)|new(?:\/|$))([^/]+)/,
  );
  const registryMatch = pathname.match(/^\/registry\/([^/]+)\/([^/]+)/);

  if (workflowRunMatch?.[1] || runMatch?.[1]) {
    return {
      routeKind: "run",
      runId: decodePathPart(workflowRunMatch?.[1] ?? runMatch?.[1] ?? ""),
    };
  }

  if (workflowMatch?.[1]) {
    return {
      routeKind: "workflow",
      workflowId: decodePathPart(workflowMatch[1]),
    };
  }

  if (registryMatch?.[1] && registryMatch[2]) {
    return {
      actionPackageName: `${decodePathPart(registryMatch[1])}/${decodePathPart(
        registryMatch[2],
      )}`,
      routeKind: "action",
    };
  }

  if (pathname.startsWith("/runs") || pathname.startsWith("/workflows/runs")) {
    return { routeKind: "runs" };
  }
  if (pathname.startsWith("/workflows")) {
    return { routeKind: "workflows" };
  }
  if (pathname.startsWith("/registry")) {
    return { routeKind: "registry" };
  }
  if (pathname.startsWith("/credentials")) {
    return { routeKind: "credentials" };
  }
  return { routeKind: "route" };
}

function assistantWorkflowSummary(template: unknown, workflow: unknown) {
  const templateRecord = isJsonObject(template) ? template : {};
  const workflowRecord = isJsonObject(workflow) ? workflow : {};
  const steps = Array.isArray(workflowRecord.steps)
    ? workflowRecord.steps.filter(isJsonObject)
    : [];
  const triggers = Array.isArray(workflowRecord.triggers)
    ? workflowRecord.triggers.filter(isJsonObject)
    : [];
  const id = text(templateRecord.id);
  return {
    actionPackages: [
      ...new Set(steps.map((step) => text(step.actionPackageName))),
    ].filter(Boolean),
    description: text(templateRecord.description),
    enabled: templateRecord.enabled === true,
    href: id ? `/workflows/${encodeURIComponent(id)}/editor` : undefined,
    id,
    lastRunStatus: text(templateRecord.lastRunStatus),
    name: text(templateRecord.name) || id,
    runCount: Number(templateRecord.runCount ?? 0),
    stepCount: Number(templateRecord.stepCount ?? steps.length),
    steps: steps.slice(0, 16).map((step) => ({
      actionPackageName: text(step.actionPackageName),
      enabled: step.enabled !== false,
      id: text(step.id),
      position: Number(step.position ?? 0),
    })),
    triggers: triggers.slice(0, 8).map((trigger) => ({
      enabled: trigger.enabled !== false,
      id: text(trigger.id),
      name: text(trigger.name),
      type: text(trigger.type),
    })),
    updatedAt: text(templateRecord.updatedAt),
  };
}

function assistantRunSummary(run: unknown) {
  if (!isJsonObject(run)) {
    return run;
  }
  const id = text(run.id);
  return {
    ...run,
    href: id ? `/workflows/runs/${encodeURIComponent(id)}` : undefined,
  };
}

function compactAssistantRegistryContext(registry: unknown) {
  if (!isJsonObject(registry)) {
    return registry;
  }
  return {
    ...registry,
    packages: Array.isArray(registry.packages)
      ? registry.packages.slice(0, 80)
      : [],
  };
}

function decodePathPart(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function currentProjectId(request: FastifyRequest) {
  return studioRequestProjectId(request);
}

function authorizedOrganizationId(
  organizations: OrganizationOption[],
  organizationId: string | null,
) {
  if (!organizationId) {
    return null;
  }
  return organizations.some(
    (organization) => organization.id === organizationId,
  )
    ? organizationId
    : null;
}

function authorizedProjectId(
  projects: ProjectOption[],
  projectId: string | null,
) {
  if (!projectId) {
    return null;
  }
  return projects.some((project) => project.id === projectId)
    ? projectId
    : null;
}

function organizationOptions() {
  return listCachedOrganizations();
}

async function fetchCentralStudioJson<T>(
  path: string,
  beamApi: BeamApiClient,
): Promise<T | null> {
  try {
    return await beamApi.getJson<T>(path);
  } catch (error) {
    logger.warn(
      {
        errorCode: (error as { code?: unknown })?.code,
        path,
        statusCode: (error as { statusCode?: unknown })?.statusCode,
      },
      "Central Studio API request failed",
    );
    return null;
  }
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

/**
 * Transfer steps as the editor currently has them configured.
 *
 * The client reports what it can see of its own graph, including unsaved edits
 * and the sizes it managed to resolve. Nothing here is charged, so this input
 * only has to be well formed: an entry that is not is dropped rather than
 * guessed at, because inventing a size would quietly move the total.
 */
function transferProjections(
  body: JsonObject | undefined,
): TransferProjection[] {
  const entries = Array.isArray(body?.transfers) ? body.transfers : [];

  return entries.flatMap((entry) => {
    const record = payloadObject(entry);
    const stepId = text(record.stepId);
    if (!stepId) return [];

    return [
      {
        stepId,
        label: text(record.label) || "Transfer",
        sourceBytes: byteCount(record.sourceBytes),
        destinationCount: Math.max(
          0,
          Math.trunc(Number(record.destinationCount) || 0),
        ),
        partial: bool(record.partial),
      },
    ];
  });
}

/** The Beam credential each transfer on the canvas names, blank when none. */
function transferCredentialIds(body: JsonObject | undefined) {
  const entries = Array.isArray(body?.transfers) ? body.transfers : [];
  return entries.map((entry) => text(payloadObject(entry).credentialId));
}

/**
 * A byte count as a decimal string, or null when it is not one.
 *
 * Sizes are strings end to end because a bucket can hold more bytes than a
 * double can count exactly, and an estimate that silently loses precision at
 * petabyte scale is worse than one that admits it does not know.
 */
function byteCount(value: unknown) {
  if (value === null || value === undefined) return null;
  const raw = text(value);
  return /^\d+$/.test(raw) ? raw : null;
}

/** Opt-out flags arrive as a JSON boolean from the form and as a string from curl. */
function truthy(value: unknown) {
  return value === true || value === "true";
}

function optionalText(value: unknown) {
  return text(value) || undefined;
}

function assistantModelOptions(
  value: unknown,
): AssistantModelOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((model) => {
      if (!isJsonObject(model)) return null;
      const id = text(model.id);
      if (!id) return null;
      return {
        id,
        name: text(model.name) || id,
        ...(model.recommended === true ? { recommended: true } : {}),
      };
    })
    .filter((model): model is AssistantModelOption => Boolean(model))
    .slice(0, 5_000);
}

function optionalReasoningEffort(
  value: unknown,
): AssistantReasoningEffort | undefined {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : undefined;
}

function bool(value: unknown) {
  return value === true || value === "true" || value === "on" || value === "1";
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function payloadObject(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim()) {
    return JSON.parse(value) as Record<string, unknown>;
  }
  return {};
}

async function roomWorkflowConfigForRequest(
  organizationId: string,
  value: unknown,
) {
  const config = payloadObject(value);
  const requestedTemplateKey = optionalText(config.environmentTemplateKey);
  if (
    requestedTemplateKey &&
    webEnv.devSettingsEnabled &&
    templateKeyFromValue(requestedTemplateKey) !== requestedTemplateKey
  ) {
    throw Object.assign(new Error("Beam environment template is invalid."), {
      code: "beam_environment_template_invalid",
      statusCode: 400,
    });
  }
  const template = await resolveBeamEnvironmentTemplate({
    organizationId,
    templateKey: requestedTemplateKey,
  });
  if (
    requestedTemplateKey &&
    webEnv.devSettingsEnabled &&
    template.key !== requestedTemplateKey
  ) {
    throw Object.assign(new Error("Beam environment template not found."), {
      code: "beam_environment_template_not_found",
      statusCode: 404,
    });
  }
  return {
    ...config,
    environmentTemplateKey: template.key,
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * The credential provider profile id (`kind`) of a credential request.
 *
 * An absent kind keeps its historical default, `s3`. A kind that is present
 * but empty is passed through, so the provider lookup answers it with a 400
 * `credential_provider_required` instead of it silently meaning `s3`.
 */
function credentialKind(value: unknown) {
  return value === undefined || value === null ? "s3" : text(value);
}

const ENDPOINT_KINDS = ["source", "destination"] as const;

/**
 * Resolves which endpoint table a transfer endpoint request addresses.
 *
 * An explicit `kind` must be one of {@link ENDPOINT_KINDS}; anything else is a
 * 400 rather than silently meaning "source". Without one, the kind follows
 * the endpoint id's `src_`/`dst_` prefix, and a new endpoint stays a source as
 * it always has.
 */
function endpointKind(value: unknown, endpointId?: string) {
  const requested = text(value);
  if (requested) {
    if ((ENDPOINT_KINDS as readonly string[]).includes(requested)) {
      return requested as (typeof ENDPOINT_KINDS)[number];
    }
    throw new StudioValidationError(
      "endpoint_kind_invalid",
      `Unsupported endpoint kind "${requested}". Use "source" or "destination".`,
      { field: "kind", acceptedValues: [...ENDPOINT_KINDS] },
    );
  }
  return endpointId?.startsWith("dst_") ? "destination" : "source";
}

function csv(rows: Record<string, unknown>[]) {
  if (!rows.length) {
    return "";
  }
  const headers = Object.keys(rows[0] ?? {});
  return [
    headers.join(","),
    ...rows.map((row) =>
      headers.map((header) => csvCell(row[header])).join(","),
    ),
  ].join("\n");
}

function csvCell(value: unknown) {
  const textValue = String(value ?? "");
  return /[",\n]/.test(textValue)
    ? `"${textValue.replaceAll('"', '""')}"`
    : textValue;
}

async function listWorkers(pgPool: PgPool) {
  const runtimeWorkers = await listWorkerRuntimeState(pgPool);
  const legacyWorkers = listWorkerInstances();
  const runtimeIds = new Set(runtimeWorkers.map((worker) => worker.id));
  return [
    ...runtimeWorkers,
    ...legacyWorkers.filter((worker) => !runtimeIds.has(worker.id)),
  ];
}

async function activeDataStoreSettings(pgPool: PgPool) {
  const config = readOrchestrationDatabaseConfig();
  const connectionUrl = config.postgresUrl;
  const parsed = postgresConnectionParts(connectionUrl);

  try {
    const result = await pgPool.query<{
      current_database_name: string;
      current_user_name: string;
      server_address: string | null;
      server_port: number | null;
      server_version: string;
    }>(`
      SELECT
        current_database() AS current_database_name,
        current_user AS current_user_name,
        inet_server_addr()::text AS server_address,
        inet_server_port() AS server_port,
        current_setting('server_version') AS server_version
    `);
    const row = result.rows[0];

    return {
      engine: "postgresql",
      mode: config.mode,
      status: "connected",
      source: postgresDatabaseEnvName(),
      connectionUrl: maskDatabaseUrl(connectionUrl),
      host: parsed.host,
      port: parsed.port,
      database: parsed.database,
      user: parsed.user,
      currentDatabase: row?.current_database_name ?? parsed.database,
      currentUser: row?.current_user_name ?? parsed.user,
      serverAddress: row?.server_address ?? parsed.host,
      serverPort: row?.server_port ?? parsed.port,
      serverVersion: row?.server_version ?? null,
    };
  } catch (error) {
    return {
      engine: "postgresql",
      mode: config.mode,
      status: "unavailable",
      source: postgresDatabaseEnvName(),
      connectionUrl: maskDatabaseUrl(connectionUrl),
      host: parsed.host,
      port: parsed.port,
      database: parsed.database,
      user: parsed.user,
      error: error instanceof Error ? error.message : "Unavailable",
    };
  }
}

function postgresDatabaseEnvName() {
  return process.env.DATABASE_URL ? "DATABASE_URL" : "not configured";
}

function postgresConnectionParts(connectionUrl: string | null) {
  if (!connectionUrl) {
    return {
      host: null,
      port: null,
      database: null,
      user: null,
    };
  }

  try {
    const url = new URL(connectionUrl);
    return {
      host: url.hostname || null,
      port: url.port ? Number(url.port) : null,
      database: url.pathname.replace(/^\/+/, "") || null,
      user: url.username ? decodeURIComponent(url.username) : null,
    };
  } catch {
    return {
      host: null,
      port: null,
      database: null,
      user: null,
    };
  }
}

function maskDatabaseUrl(connectionUrl: string | null) {
  if (!connectionUrl) {
    return null;
  }

  try {
    const url = new URL(connectionUrl);
    if (url.password) {
      url.password = "***";
    }
    return url.toString();
  } catch {
    return connectionUrl.replace(
      /(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s/]+@/i,
      "$1***@",
    );
  }
}

async function listOrchestrators() {
  const endpoint = orchestratorEndpoint();
  const [health, readiness, load] = await Promise.all([
    fetchJson(`${endpoint}/health`),
    fetchJson(`${endpoint}/ready`),
    fetchJson(`${endpoint}/workers/load`),
  ]);

  return [
    {
      id: "local-orchestrator",
      name: "Local orchestrator",
      endpoint,
      status: health.ok && readiness.ok ? "active" : "offline",
      service:
        textValue(health.data?.service) ||
        textValue(readiness.data?.service) ||
        "beam-studio-orchestrator",
      health: health.ok ? "healthy" : health.error,
      readiness: readiness.ok ? "ready" : readiness.error,
      load: load.ok ? load.data : null,
    },
  ];
}

function orchestratorEndpoint() {
  const configured = process.env.ORCHESTRATOR_URL;
  if (configured) {
    return configured.replace(/\/$/, "");
  }
  const port = process.env.ORCHESTRATOR_PORT ?? process.env.API_PORT ?? "8787";
  return `http://127.0.0.1:${port}`;
}

async function fetchJson(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      // Cross-container, so the loopback exemption does not apply: the API has
      // to present the ops token like any other caller.
      headers: { authorization: `Bearer ${opsAuthToken()}` },
    });
    if (!response.ok) {
      return { ok: false, data: null, error: `HTTP ${response.status}` };
    }
    return {
      ok: true,
      data: (await response.json()) as JsonObject,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      data: null,
      error: error instanceof Error ? error.message : "Unavailable",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function textValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

/**
 * True when the browser reached us over HTTPS, including through a terminating
 * reverse proxy — which is how most Studio installs serve TLS.
 */
function requestIsSecure(request: FastifyRequest) {
  const forwarded = request.headers["x-forwarded-proto"];
  const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof header === "string" && header.trim()) {
    return header.split(",")[0]!.trim().toLowerCase() === "https";
  }
  return request.protocol === "https";
}

function serializeCookie(
  name: string,
  value: string,
  options: { maxAge?: number; secure?: boolean } = {},
) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  // The explicit setting still wins; otherwise follow the request's own
  // scheme rather than NODE_ENV, which was leaving an HTTPS deployment with a
  // non-Secure session cookie whenever NODE_ENV was not "production".
  if (studioSecureCookies(options.secure)) {
    parts.push("Secure");
  }
  if (options.maxAge) {
    parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  }
  return parts.join("; ");
}

function expireCookie(name: string) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
