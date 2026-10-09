import { createHash, randomUUID } from "node:crypto";
import { vaultSecretFromEnv } from "@beam-studio/vault";
import { CredentialRepository } from "./repositories/credential-repository.js";
import { McpTokenRepository } from "./repositories/mcp-token-repository.js";
import { organizationScope } from "./repositories/organization-scope.js";
import {
  parseScheduleFrequency,
  projectSchedule,
} from "@beam-studio/core";
import type { PgPool } from "@beam-studio/db";
import {
  assistantEntityHref,
  parseAssistantOperationPlan,
  redactAssistantPayload,
  type AssistantInputRequest,
  type AssistantOperation,
  type AssistantOperationPlan,
  type AssistantOperationRisk,
  type AssistantPlanDiff,
  type AssistantPlanConfirmation,
  type AssistantReasoningEffort,
  type AssistantToolDescriptor,
  type AssistantWorkflowPatchOperation,
} from "@beam-studio/shared";
import {
  cancelRun,
  cancelWorkflowRun,
  createExecutionLocation,
  createEndpoint,
  createSchedule,
  createTransfer,
  createWorkflowTemplate,
  duplicateWorkflowTemplate,
  deleteEndpoint,
  deleteSchedule,
  deleteTransfer,
  deleteWorkflowTemplate,
  getRun,
  getTransfer,
  getWorkflowTemplate,
  getWorkflowRun,
  installPublicRegistryPackage,
  listDeadLetterRuns,
  listExecutionLocations,
  listMcpAuditEvents,
  listQueueRuns,
  listRegistryPackages,
  listRuns,
  listSchedules,
  listTransfers,
  listWorkerInstances,
  listWorkerRuntimeState,
  listWorkflowRuns,
  listWorkflowTemplates,
  retryRun,
  retryWorkflowRun,
  startRun,
  startWorkflowRun,
  toggleSchedule,
  toggleTransfer,
  updateEndpoint,
  updateSchedule,
  updateTransfer,
  updateWorkflowGraph,
  updateWorkflowTemplate,
} from "./store.js";
import {
  credentialBuckets,
  listCredentialObjects,
  validateProviderBuckets,
} from "./storage-browser.js";
import { transferEstimate } from "./transfer-estimates.js";
import {
  createAssistantUniversalPlanDraft,
  createAssistantWorkflowPlan,
  testAssistantProvider,
  type AssistantProviderConfig,
} from "./assistant.js";

type JsonObject = Record<string, unknown>;

export type AssistantActionPackage = {
  name: string;
  version: string;
  manifest: JsonObject;
};

export type AssistantExecutionScope = {
  organizationId: string;
  projectId: string | null;
  userId: string | null;
  permissions: string[];
};

const mcpTokens = (context: AssistantToolContext) =>
  new McpTokenRepository(context.pool);
const credentialStore = (context: AssistantToolContext) =>
  new CredentialRepository(context.pool, vaultSecretFromEnv);
const scope = (organizationId: string | null | undefined) =>
  organizationScope(organizationId);

/** Validation reads no data, so it is deliberately given no database access. */
type AssistantToolValidationContext = {
  actions: AssistantActionPackage[];
  scope: AssistantExecutionScope;
};

type AssistantToolContext = AssistantToolValidationContext & {
  repository?: AssistantPlanRepository;
  /** Backs the scoped repositories the secret-bearing tools use. */
  pool: PgPool;
};

type AssistantTool = {
  descriptor: AssistantToolDescriptor;
  validate(
    operation: AssistantOperation,
    context: AssistantToolValidationContext,
  ): string[];
  preview(operation: AssistantOperation): AssistantPlanDiff[];
  execute(
    operation: AssistantOperation,
    context: AssistantToolContext,
  ): Promise<JsonObject>;
  rollback?(
    operation: AssistantOperation,
    context: AssistantToolContext,
  ): Promise<void>;
};

type PlanRow = {
  plan_json: unknown;
};

const SUPPORTED_TRIGGER_TYPES = new Set([
  "manual",
  "schedule",
  "webhook",
  "date",
  "completion",
]);

export class AssistantPlanError extends Error {
  statusCode: number;
  code: string;
  details: string[];

  constructor(
    code: string,
    message: string,
    statusCode = 400,
    details: string[] = [],
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class AssistantPlanRepository {
  constructor(private readonly pool: PgPool) {}

  async findByIdempotencyKey(
    idempotencyKey: string,
    scope: AssistantExecutionScope,
  ) {
    const row = await this.pool.query<PlanRow>(
      `
      SELECT plan_json
      FROM assistant.operation_plans
      WHERE organization_id = $1
        AND idempotency_key = $2
        AND project_id IS NOT DISTINCT FROM $3
        AND user_id IS NOT DISTINCT FROM $4
      `,
      [scope.organizationId, idempotencyKey, scope.projectId, scope.userId],
    );
    return row.rows[0]
      ? parseAssistantOperationPlan(row.rows[0].plan_json)
      : null;
  }

  async create(
    plan: AssistantOperationPlan,
    idempotencyKey: string,
  ): Promise<AssistantOperationPlan> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await ensureAssistantIdentityScope(client, {
        organizationId: plan.organizationId,
        projectId: plan.projectId,
      });
      await client.query(
        `
        INSERT INTO assistant.operation_plans (
          id, organization_id, project_id, user_id, conversation_id,
          intent, summary, status, plan_json, validation_hash,
          idempotency_key, created_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9::jsonb, $10,
          $11, $12, $12
        )
        ON CONFLICT (organization_id, idempotency_key) DO NOTHING
        `,
        [
          plan.id,
          plan.organizationId,
          plan.projectId,
          plan.userId,
          plan.conversationId ?? null,
          plan.intent,
          plan.summary,
          plan.status,
          JSON.stringify(redactAssistantPayload(plan)),
          plan.preview?.validationHash ?? null,
          idempotencyKey,
          plan.createdAt,
        ],
      );
      const stored = await client.query<PlanRow>(
        `
        SELECT plan_json
        FROM assistant.operation_plans
        WHERE organization_id = $1
          AND idempotency_key = $2
          AND project_id IS NOT DISTINCT FROM $3
          AND user_id IS NOT DISTINCT FROM $4
        `,
        [plan.organizationId, idempotencyKey, plan.projectId, plan.userId],
      );
      await client.query("COMMIT");
      const storedPlan = stored.rows[0]?.plan_json;
      if (!storedPlan) {
        throw new AssistantPlanError(
          "idempotency_conflict",
          "This idempotency key belongs to another assistant scope.",
          409,
        );
      }
      return parseAssistantOperationPlan(storedPlan);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async get(id: string, scope: AssistantExecutionScope) {
    const result = await this.pool.query<PlanRow>(
      `
      SELECT plan_json
      FROM assistant.operation_plans
      WHERE id = $1
        AND organization_id = $2
        AND project_id IS NOT DISTINCT FROM $3
        AND user_id IS NOT DISTINCT FROM $4
      `,
      [id, scope.organizationId, scope.projectId, scope.userId],
    );
    return result.rows[0]
      ? parseAssistantOperationPlan(result.rows[0].plan_json)
      : null;
  }

  async update(plan: AssistantOperationPlan) {
    const updatedAt = new Date().toISOString();
    const next = parseAssistantOperationPlan({ ...plan, updatedAt });
    const result = await this.pool.query(
      `
      UPDATE assistant.operation_plans
      SET intent = $2,
          summary = $3,
          status = $4,
          plan_json = $5::jsonb,
          validation_hash = $6,
          confirmed_at = $7,
          executed_at = CASE WHEN $4 = 'completed' THEN $8 ELSE executed_at END,
          updated_at = $8
      WHERE id = $1
        AND organization_id = $9
        AND project_id IS NOT DISTINCT FROM $10
        AND user_id IS NOT DISTINCT FROM $11
      `,
      [
        next.id,
        next.intent,
        next.summary,
        next.status,
        JSON.stringify(redactAssistantPayload(next)),
        next.preview?.validationHash ?? null,
        next.confirmation.confirmedAt ?? null,
        updatedAt,
        next.organizationId,
        next.projectId,
        next.userId,
      ],
    );
    if (result.rowCount !== 1) {
      throw new AssistantPlanError("plan_not_found", "Plan not found.", 404);
    }
    return next;
  }

  async claimExecution(id: string, scope: AssistantExecutionScope) {
    const result = await this.pool.query<PlanRow>(
      `
      UPDATE assistant.operation_plans
      SET status = 'running',
          plan_json = jsonb_set(plan_json, '{status}', '"running"'::jsonb),
          updated_at = now()
      WHERE id = $1
        AND organization_id = $2
        AND project_id IS NOT DISTINCT FROM $3
        AND user_id IS NOT DISTINCT FROM $4
        AND status = 'confirmed'
      RETURNING plan_json
      `,
      [id, scope.organizationId, scope.projectId, scope.userId],
    );
    return result.rows[0]
      ? parseAssistantOperationPlan(result.rows[0].plan_json)
      : null;
  }

  async audit(
    plan: AssistantOperationPlan,
    input: {
      action: string;
      status:
        | "requested"
        | "accepted"
        | "rejected"
        | "started"
        | "succeeded"
        | "failed";
      operationId?: string;
      details?: JsonObject;
    },
  ) {
    await this.pool.query(
      `
      INSERT INTO assistant.audit_events (
        id, plan_id, operation_id, organization_id, project_id,
        user_id, action, status, details_json, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now())
      `,
      [
        `aae_${randomUUID()}`,
        plan.id,
        input.operationId ?? null,
        plan.organizationId,
        plan.projectId,
        plan.userId,
        input.action,
        input.status,
        JSON.stringify(redactAssistantPayload(input.details ?? {})),
      ],
    );
  }

  async listAudit(scope: AssistantExecutionScope, limit = 100) {
    const result = await this.pool.query(
      `
      SELECT
        id, plan_id, operation_id, action, status, details_json, created_at
      FROM assistant.audit_events
      WHERE organization_id = $1
        AND ($2 = '' OR project_id = $2)
        AND ($3 = '' OR user_id = $3)
      ORDER BY created_at DESC
      LIMIT $4
      `,
      [
        scope.organizationId,
        scope.projectId ?? "",
        scope.userId ?? "",
        Math.min(500, Math.max(1, limit)),
      ],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      planId: String(row.plan_id),
      operationId: row.operation_id ? String(row.operation_id) : null,
      action: String(row.action),
      status: String(row.status),
      details: redactAssistantPayload(row.details_json ?? {}),
      createdAt: String(row.created_at),
    }));
  }
}

export function studioAssistantToolDescriptors(): AssistantToolDescriptor[] {
  return [...toolCatalog().values()].map((tool) => tool.descriptor);
}

export function routeStudioAssistantIntent(prompt: string) {
  const normalized = normalizeText(prompt);
  const createVerb =
    /\b(create|build|generate|make|add|cr[ée]e?r?|construis|g[ée]n[èe]re|ajoute)\b/.test(
      normalized,
    );
  const workflow = /\b(workflow|workflows|flux)\b/.test(normalized);
  if (createVerb && workflow && !/\b(compos\w*|nested)\b/.test(normalized)) {
    return "workflow.create" as const;
  }
  const writeVerb =
    /\b(create|build|generate|make|add|cree|construis|genere|ajoute|modif|update|delete|remove|supprim|execute|lance|cancel|annul|retry|relance|install|active|desactive|clone|dupliqu|configure|change)\w*\b/.test(
      normalized,
    ) || /^(please\s+)?run\b/.test(normalized.trim());
  const structuredRead =
    /\b(show|list|search|inspect|compare|audit|montre|liste|cherche|consulte|affiche|compare|audite|etat|status)\w*\b/.test(
      normalized,
    ) &&
    /\b(workflow|transfer|transfert|run|queue|dead.?letter|registry|action|worker|orchestrat|mcp|credential|ressource)\w*\b/.test(
      normalized,
    );
  if (writeVerb) {
    return "studio.operation" as const;
  }
  return structuredRead ? ("studio.read" as const) : ("read" as const);
}

export async function createStudioOperationPlan(input: {
  pool: PgPool;
  actions: AssistantActionPackage[];
  context: JsonObject;
  conversationId?: string | null;
  idempotencyKey: string;
  prompt: string;
  repository: AssistantPlanRepository;
  scope: AssistantExecutionScope;
  provider?: AssistantProviderConfig;
  reasoningEffort?: AssistantReasoningEffort;
}) {
  const intent = routeStudioAssistantIntent(input.prompt);
  if (intent === "workflow.create") {
    return createWorkflowOperationPlan(input);
  }
  const existing = await input.repository.findByIdempotencyKey(
    input.idempotencyKey,
    input.scope,
  );
  if (existing) return existing;
  const generated = await createAssistantUniversalPlanDraft({
    context: input.context,
    prompt: input.prompt,
    provider: input.provider,
    reasoningEffort: input.reasoningEffort,
    tools: studioAssistantToolDescriptors(),
  });
  input.provider?.signal?.throwIfAborted();
  const planId = `apl_${randomUUID()}`;
  const timestamp = new Date().toISOString();
  const refs = new Map(
    generated.draft.operations.map((operation) => [
      operation.ref,
      stableResourceId("aop", planId, operation.ref),
    ]),
  );
  const catalog = toolCatalog();
  const operations: AssistantOperation[] = generated.draft.operations.map(
    (operation) => {
      const tool = catalog.get(operation.tool);
      return {
        id:
          refs.get(operation.ref) ??
          stableResourceId("aop", planId, operation.ref),
        tool: operation.tool,
        arguments: normalizeUniversalOperationArguments(
          operation.tool,
          replaceOperationRefs(operation.arguments, refs) as JsonObject,
          planId,
          operation.ref,
        ),
        dependsOn: operation.dependsOn.map(
          (dependency) => refs.get(dependency) ?? dependency,
        ),
        risk: tool?.descriptor.risk ?? "security",
        reversible: tool?.descriptor.reversible ?? false,
        status: "pending",
      };
    },
  );
  const needsInput: AssistantInputRequest[] = generated.draft.needsInput.map(
    (request) => {
      const type = assistantInputType(request.type, request.sensitive);
      return {
        id: request.id,
        label: request.label,
        description: request.description,
        type,
        required: request.required !== false,
        sensitive: request.sensitive === true || type === "secure_secret",
        operationId: request.operationRef
          ? refs.get(request.operationRef)
          : undefined,
        argumentPath: request.argumentPath,
        options: request.options,
      };
    },
  );
  needsInput.push(...missingGenericInputs(operations, needsInput));
  for (const operation of operations) {
    if (operation.tool !== "workflow.create") continue;
    const generatedInputs = inputRequestsForWorkflow(
      operation.id,
      objectValue(operation.arguments.workflow),
      [],
      input.actions,
    );
    for (const request of generatedInputs) {
      if (!needsInput.some((existing) => existing.id === request.id)) {
        needsInput.push(request);
      }
    }
  }
  const plan: AssistantOperationPlan = {
    id: planId,
    version: 1,
    organizationId: input.scope.organizationId,
    projectId: input.scope.projectId,
    userId: input.scope.userId,
    conversationId: input.conversationId ?? null,
    intent: generated.draft.intent,
    summary: generated.draft.summary,
    operations,
    needsInput,
    assumptions: generated.draft.assumptions,
    risks: [
      ...generated.draft.risks,
      ...(generated.degraded
        ? [
            "The provider was unavailable; this plan used the local intent fallback.",
          ]
        : []),
    ],
    estimatedImpact: generated.draft.estimatedImpact,
    status: needsInput.length || !operations.length ? "needs_input" : "draft",
    confirmation: assistantConfirmationForRisk(maxRisk(operations)),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const stored = await input.repository.create(plan, input.idempotencyKey);
  await input.repository.audit(stored, {
    action: "plan.created",
    status: "succeeded",
    details: {
      intent: stored.intent,
      operationCount: stored.operations.length,
      degraded: generated.degraded,
    },
  });
  if (!stored.confirmation.required && !stored.needsInput.length) {
    const validated = await validateAndPreviewAssistantPlan({
      pool: input.pool,
      actions: input.actions,
      plan: stored,
      repository: input.repository,
      scope: input.scope,
    });
    if (!validated.errors.length) {
      const confirmed = await confirmAssistantPlan({
        plan: validated.plan,
        repository: input.repository,
        scope: input.scope,
      });
      return executeAssistantPlan({
        pool: input.pool,
        actions: input.actions,
        plan: confirmed,
        repository: input.repository,
        scope: input.scope,
      });
    }
    return validated.plan;
  }
  return stored;
}

export async function createWorkflowOperationPlan(input: {
  pool: PgPool;
  actions: AssistantActionPackage[];
  conversationId?: string | null;
  idempotencyKey: string;
  prompt: string;
  repository: AssistantPlanRepository;
  scope: AssistantExecutionScope;
  provider?: AssistantProviderConfig;
  reasoningEffort?: AssistantReasoningEffort;
}) {
  const existing = await input.repository.findByIdempotencyKey(
    input.idempotencyKey,
    input.scope,
  );
  if (existing) {
    return existing;
  }
  const safePrompt = String(redactAssistantPayload(input.prompt)).slice(
    0,
    6000,
  );
  const legacyPlan = await createAssistantWorkflowPlan({
    actions: input.actions,
    prompt: safePrompt,
    provider: input.provider,
    reasoningEffort: input.reasoningEffort,
    validationErrors: [],
    workflow: { triggers: [], triggerEdges: [], steps: [], edges: [] },
    workflowId: "assistant-new-workflow",
  });
  input.provider?.signal?.throwIfAborted();
  const planId = `apl_${randomUUID()}`;
  const operationId = `aop_${randomUUID()}`;
  const graph = workflowGraphFromPatch(
    legacyPlan.patch,
    planId,
    workflowName(safePrompt),
    legacyPlan.message,
  );
  const needsInput = inputRequestsForWorkflow(
    operationId,
    graph,
    legacyPlan.needsInput,
    input.actions,
  );
  const timestamp = new Date().toISOString();
  const plan: AssistantOperationPlan = {
    id: planId,
    version: 1,
    organizationId: input.scope.organizationId,
    projectId: input.scope.projectId,
    userId: input.scope.userId,
    conversationId: input.conversationId ?? null,
    intent: "workflow.create",
    summary:
      legacyPlan.message ||
      `Create workflow "${String(graph.name ?? "New workflow")}".`,
    operations: [
      {
        id: operationId,
        tool: "workflow.create",
        arguments: { workflow: graph },
        dependsOn: [],
        risk: "write",
        reversible: true,
        status: "pending",
      },
    ],
    needsInput,
    assumptions: legacyPlan.assumptions,
    risks: [
      ...legacyPlan.risks,
      ...(legacyPlan.patchErrors?.length
        ? legacyPlan.patchErrors.map((error) => `Validation: ${error}`)
        : []),
    ],
    estimatedImpact: {
      duration: "A few seconds",
      externalEffects: ["Creates one workflow draft in the current project."],
    },
    status: needsInput.length ? "needs_input" : "draft",
    confirmation: assistantConfirmationForRisk("write"),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const stored = await input.repository.create(plan, input.idempotencyKey);
  await input.repository.audit(stored, {
    action: "plan.created",
    status: "succeeded",
    details: {
      intent: stored.intent,
      operationCount: stored.operations.length,
    },
  });
  return stored;
}

export async function validateAndPreviewAssistantPlan(input: {
  pool: PgPool;
  actions: AssistantActionPackage[];
  inputs?: Record<string, unknown>;
  plan: AssistantOperationPlan;
  repository: AssistantPlanRepository;
  scope: AssistantExecutionScope;
}) {
  assertPlanScope(input.plan, input.scope);
  const result = validateAssistantPlan(input.plan, {
    actions: input.actions,
    inputs: input.inputs ?? {},
    scope: input.scope,
  });
  if (!result.errors.length && result.plan.preview) {
    result.plan.preview.diffs = (
      await Promise.all(
        result.plan.operations.map((operation) =>
          detailedOperationPreview(
            operation,
            input.scope,
            new CredentialRepository(input.pool, vaultSecretFromEnv),
          ),
        ),
      )
    ).flat();
  }
  const stored = await input.repository.update(result.plan);
  await input.repository.audit(stored, {
    action: "plan.validated",
    status: result.errors.length ? "rejected" : "succeeded",
    details: { errors: result.errors },
  });
  return { ...result, plan: stored };
}

export function validateAssistantPlan(
  originalPlan: AssistantOperationPlan,
  input: {
    actions: AssistantActionPackage[];
    inputs?: Record<string, unknown>;
    scope: AssistantExecutionScope;
  },
) {
  assertPlanScope(originalPlan, input.scope);
  const plan = structuredClone(originalPlan);
  const errors: string[] = [];
  applyAssistantInputs(plan, input.inputs ?? {}, errors);
  if (!plan.operations.length) {
    errors.push(
      "The plan contains no executable Studio operation; revise the request.",
    );
  }
  errors.push(...validateDependencies(plan.operations));
  const catalog = toolCatalog();
  for (const operation of plan.operations) {
    const tool = catalog.get(operation.tool);
    if (!tool) {
      errors.push(`Unknown Studio tool "${operation.tool}".`);
      continue;
    }
    if (operation.risk !== tool.descriptor.risk) {
      errors.push(
        `Operation ${operation.id} has risk ${operation.risk}; ${operation.tool} requires ${tool.descriptor.risk}.`,
      );
    }
    for (const permission of tool.descriptor.permissions) {
      if (!input.scope.permissions.includes(permission)) {
        errors.push(
          `Missing permission "${permission}" for ${operation.tool}.`,
        );
      }
    }
    if (containsForbiddenAssistantData(operation.arguments)) {
      errors.push(`Operation ${operation.id} contains forbidden secret data.`);
    }
    errors.push(
      ...tool
        .validate(operation, { actions: input.actions, scope: input.scope })
        .map((error) => `${operation.id}: ${error}`),
    );
  }
  const missingInputs = plan.needsInput.filter(
    (request) => request.required && !hasInputValue(request.value),
  );
  if (missingInputs.length) {
    errors.push(
      ...missingInputs.map((request) => `Missing input "${request.label}".`),
    );
  }
  const validationHash = assistantPlanValidationHash(
    plan,
    input.actions,
    input.scope,
  );
  const diffs = plan.operations.flatMap((operation) => {
    const tool = catalog.get(operation.tool);
    return tool ? tool.preview(operation) : [];
  });
  plan.preview =
    errors.length === 0
      ? {
          generatedAt: new Date().toISOString(),
          validationHash,
          diffs,
          warnings: plan.risks,
        }
      : undefined;
  plan.status = errors.length
    ? missingInputs.length
      ? "needs_input"
      : "draft"
    : "ready";
  plan.confirmation = assistantConfirmationForRisk(maxRisk(plan.operations));
  return { plan, errors };
}

export async function confirmAssistantPlan(input: {
  plan: AssistantOperationPlan;
  repository: AssistantPlanRepository;
  scope: AssistantExecutionScope;
}) {
  assertPlanScope(input.plan, input.scope);
  if (input.plan.status !== "ready" || !input.plan.preview) {
    throw new AssistantPlanError(
      "plan_not_ready",
      "Preview and validate the plan before confirming it.",
      409,
    );
  }
  const timestamp = new Date().toISOString();
  const plan: AssistantOperationPlan = {
    ...input.plan,
    status: "confirmed",
    confirmation: {
      ...input.plan.confirmation,
      confirmedAt: timestamp,
      confirmedBy: input.scope.userId ?? "studio-session",
      validationHash: input.plan.preview.validationHash,
    },
  };
  const stored = await input.repository.update(plan);
  await input.repository.audit(stored, {
    action: "plan.confirmed",
    status: "accepted",
    details: {
      policy: stored.confirmation.policy,
      validationHash: stored.confirmation.validationHash,
    },
  });
  return stored;
}

export async function executeAssistantPlan(input: {
  pool: PgPool;
  actions: AssistantActionPackage[];
  plan: AssistantOperationPlan;
  repository: AssistantPlanRepository;
  scope: AssistantExecutionScope;
}) {
  assertPlanScope(input.plan, input.scope);
  if (input.plan.status === "completed") {
    return input.plan;
  }
  if (input.plan.status !== "confirmed") {
    throw new AssistantPlanError(
      "confirmation_required",
      "The plan must be confirmed before execution.",
      409,
    );
  }
  const revalidation = validateAssistantPlan(input.plan, {
    actions: input.actions,
    scope: input.scope,
  });
  if (revalidation.errors.length || !revalidation.plan.preview) {
    throw new AssistantPlanError(
      "plan_invalid",
      "The plan is no longer valid.",
      409,
      revalidation.errors,
    );
  }
  if (
    input.plan.confirmation.validationHash !==
    revalidation.plan.preview.validationHash
  ) {
    throw new AssistantPlanError(
      "plan_changed",
      "The validated plan changed and must be previewed and confirmed again.",
      409,
    );
  }
  const claimed = await input.repository.claimExecution(
    input.plan.id,
    input.scope,
  );
  if (!claimed) {
    const current = await input.repository.get(input.plan.id, input.scope);
    if (current?.status === "completed") {
      return current;
    }
    throw new AssistantPlanError(
      "plan_execution_conflict",
      "The plan is already running or is no longer confirmed.",
      409,
    );
  }
  let plan: AssistantOperationPlan = {
    ...revalidation.plan,
    status: "running",
    confirmation: input.plan.confirmation,
  };
  const catalog = toolCatalog();
  const order = resolveAssistantOperationOrder(plan.operations);
  const completed: AssistantOperation[] = [];
  try {
    for (const operationId of order) {
      const operation = plan.operations.find((item) => item.id === operationId);
      if (!operation) {
        continue;
      }
      operation.status = "running";
      plan = await input.repository.update(plan);
      await input.repository.audit(plan, {
        action: "operation.execute",
        status: "started",
        operationId,
        details: { tool: operation.tool },
      });
      const tool = catalog.get(operation.tool);
      if (!tool) {
        throw new Error(`Unknown Studio tool "${operation.tool}".`);
      }
      operation.arguments = resolveOperationResultReferences(
        operation.arguments,
        plan.operations,
      ) as JsonObject;
      operation.result = await tool.execute(operation, {
        actions: input.actions,
        repository: input.repository,
        scope: input.scope,
        pool: input.pool,
      });
      operation.status = "completed";
      completed.push(operation);
      plan = await input.repository.update(plan);
      await input.repository.audit(plan, {
        action: "operation.execute",
        status: "succeeded",
        operationId,
        details: { tool: operation.tool, result: operation.result },
      });
    }
    plan.status = "completed";
    plan = await input.repository.update(plan);
    await input.repository.audit(plan, {
      action: "plan.execute",
      status: "succeeded",
      details: { operationCount: completed.length },
    });
    return plan;
  } catch (error) {
    const failed = plan.operations.find(
      (operation) => operation.status === "running",
    );
    if (failed) {
      failed.status = "failed";
      failed.error = error instanceof Error ? error.message : String(error);
    }
    for (const operation of [...completed].reverse()) {
      const tool = catalog.get(operation.tool);
      if (!operation.reversible || !tool?.rollback) {
        continue;
      }
      try {
        await tool.rollback(operation, {
          pool: input.pool,
          actions: input.actions,
          scope: input.scope,
        });
      } catch (rollbackError) {
        plan.risks = [
          ...plan.risks,
          `Rollback failed for ${operation.id}: ${
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError)
          }`,
        ];
      }
    }
    for (const operation of plan.operations) {
      if (operation.status === "pending") {
        operation.status = "skipped";
      }
    }
    plan.status = "failed";
    plan = await input.repository.update(plan);
    await input.repository.audit(plan, {
      action: "plan.execute",
      status: "failed",
      details: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return plan;
  }
}

export async function cancelAssistantPlan(input: {
  plan: AssistantOperationPlan;
  repository: AssistantPlanRepository;
  scope: AssistantExecutionScope;
}) {
  assertPlanScope(input.plan, input.scope);
  if (input.plan.status === "running" || input.plan.status === "completed") {
    throw new AssistantPlanError(
      "plan_cannot_cancel",
      "A running or completed plan cannot be cancelled.",
      409,
    );
  }
  const plan = await input.repository.update({
    ...input.plan,
    status: "cancelled",
  });
  await input.repository.audit(plan, {
    action: "plan.cancel",
    status: "succeeded",
  });
  return plan;
}

export async function rollbackAssistantPlan(input: {
  pool: PgPool;
  plan: AssistantOperationPlan;
  repository: AssistantPlanRepository;
  scope: AssistantExecutionScope;
}) {
  assertPlanScope(input.plan, input.scope);
  if (input.plan.status !== "completed") {
    throw new AssistantPlanError(
      "rollback_unavailable",
      "Only a completed plan can be rolled back.",
      409,
    );
  }
  const catalog = toolCatalog();
  for (const operation of [...input.plan.operations].reverse()) {
    const tool = catalog.get(operation.tool);
    if (!operation.reversible || !tool?.rollback) {
      continue;
    }
    await tool.rollback(operation, {
      pool: input.pool,
      actions: [],
      scope: input.scope,
    });
    await input.repository.audit(input.plan, {
      action: "operation.rollback",
      status: "succeeded",
      operationId: operation.id,
      details: { tool: operation.tool },
    });
  }
  const plan = await input.repository.update({
    ...input.plan,
    status: "cancelled",
  });
  await input.repository.audit(plan, {
    action: "plan.rollback",
    status: "succeeded",
  });
  return plan;
}

export function resolveAssistantOperationOrder(
  operations: AssistantOperation[],
): string[] {
  const errors = validateDependencies(operations);
  if (errors.length) {
    throw new AssistantPlanError(
      "invalid_dependencies",
      "Assistant operation dependencies are invalid.",
      422,
      errors,
    );
  }
  const byId = new Map(
    operations.map((operation) => [operation.id, operation]),
  );
  const visited = new Set<string>();
  const order: string[] = [];
  const visit = (id: string) => {
    if (visited.has(id)) {
      return;
    }
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      visit(dependency);
    }
    visited.add(id);
    order.push(id);
  };
  for (const operation of operations) {
    visit(operation.id);
  }
  return order;
}

export function assistantPlanValidationHash(
  plan: AssistantOperationPlan,
  actions: AssistantActionPackage[],
  scope: AssistantExecutionScope,
) {
  return createHash("sha256")
    .update(
      stableJson({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        operations: plan.operations.map((operation) => ({
          id: operation.id,
          tool: operation.tool,
          arguments: operation.arguments,
          dependsOn: operation.dependsOn,
          risk: operation.risk,
        })),
        registry: actions
          .map((action) => ({ name: action.name, version: action.version }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      }),
    )
    .digest("hex");
}

function toolCatalog() {
  const workflowCreate: AssistantTool = {
    descriptor: {
      name: "workflow.create",
      description:
        "Create a complete workflow graph of actions and child-workflow calls with explicit input and output contracts in the current scope.",
      inputSchema: {
        type: "object",
        required: ["workflow"],
        properties: {
          workflow: {
            type: "object",
            required: ["name", "triggers", "steps", "edges", "triggerEdges"],
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              enabled: { type: "boolean" },
              room: {
                type: ["object", "null"],
                required: ["environmentTemplateKey", "roomId"],
                properties: {
                  environmentTemplateKey: { type: "string" },
                  roomId: { type: "string" },
                },
                additionalProperties: false,
              },
              inputSchema: { type: ["object", "boolean"] },
              output: { type: "object", required: ["schema", "bindings"] },
              agentBindings: {
                type: "object",
                description:
                  "Named managed-agent references: {name: {agentId}}. References do not assign execution.",
              },
              resourceBindings: {
                type: "object",
                description:
                  "Named resources with kind credential, storage, endpoint, room-channel, or data. Credentials use IDs. Bind whole values using ${workflow.resources.name.field}.",
              },
              failurePolicy: {
                enum: ["stop_on_failure", "continue_on_failure"],
              },
              triggers: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "type", "enabled"],
                  properties: {
                    id: { type: "string" },
                    type: {
                      enum: [
                        "manual",
                        "schedule",
                        "webhook",
                        "date",
                        "completion",
                      ],
                    },
                    name: { type: "string" },
                    enabled: { type: "boolean" },
                    config: { type: "object" },
                  },
                },
              },
              steps: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "kind"],
                  properties: {
                    id: { type: "string" },
                    kind: { enum: ["action", "workflow"] },
                    calledWorkflowId: { type: "string" },
                    actionPackageName: { type: "string" },
                    actionVersionRange: { type: "string" },
                    config: { type: "object" },
                    inputBindings: { type: "object" },
                    executionTarget: {
                      type: "object",
                      required: ["kind"],
                      properties: {
                        kind: {
                          enum: ["studio", "room-member", "remote-transport"],
                        },
                        memberIds: { type: "array", items: { type: "string" } },
                        channelId: { type: "string" },
                        artifactChannelId: { type: "string" },
                        requesterMemberId: { type: "string" },
                        room: {
                          type: "object",
                          properties: {
                            environmentTemplateKey: { type: "string" },
                            roomId: { type: "string" },
                          },
                        },
                        executionLocationId: { type: "string" },
                      },
                    },
                    timeoutSeconds: { type: "number" },
                    required: { type: "boolean" },
                  },
                },
              },
              edges: { type: "array", items: { type: "object" } },
              triggerEdges: { type: "array", items: { type: "object" } },
            },
          },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        required: ["id", "href"],
        properties: { id: { type: "string" }, href: { type: "string" } },
      },
      risk: "write",
      permissions: ["workflow:write"],
      confirmationPolicy: "simple",
      reversible: true,
      rollbackStrategy: "Delete the workflow created by this operation.",
    },
    validate: validateWorkflowCreateOperation,
    preview: (operation) => {
      const workflow = objectValue(operation.arguments.workflow);
      const steps = arrayValue(workflow.steps);
      const triggers = arrayValue(workflow.triggers);
      return [
        {
          resourceType: "workflow",
          resourceId: stringValue(workflow.id) || undefined,
          label: stringValue(workflow.name) || "New workflow",
          change: "create",
          before: null,
          after: {
            name: stringValue(workflow.name),
            description: stringValue(workflow.description),
            enabled: workflow.enabled !== false,
            triggerCount: triggers.length,
            stepCount: steps.length,
            actionPackages: steps.map((step) =>
              stringValue(objectValue(step).actionPackageName),
            ),
          },
        },
      ];
    },
    execute: executeWorkflowCreateOperation,
    rollback: async (operation, context) => {
      const workflowId =
        stringValue(operation.result?.id) ||
        stringValue(objectValue(operation.arguments.workflow).id);
      if (!workflowId) {
        return;
      }
      const existing = await getWorkflowTemplate(
        workflowId,
        context.scope.organizationId,
        context.scope.projectId,
      );
      if (existing) {
        await deleteWorkflowTemplate(workflowId, context.scope.organizationId);
      }
    },
  };
  const catalog = new Map([[workflowCreate.descriptor.name, workflowCreate]]);
  for (const descriptor of genericToolDescriptors()) {
    catalog.set(descriptor.name, {
      descriptor,
      validate: validateGenericOperation,
      preview: genericOperationPreview,
      execute: executeGenericOperation,
      ...(descriptor.reversible ? { rollback: rollbackGenericOperation } : {}),
    });
  }
  return catalog;
}

function genericToolDescriptors(): AssistantToolDescriptor[] {
  const tool = (
    name: string,
    description: string,
    risk: AssistantOperationRisk,
    permissions: string[],
    required: string[],
    reversible = false,
  ): AssistantToolDescriptor => ({
    name,
    description,
    risk,
    permissions,
    reversible,
    confirmationPolicy: assistantConfirmationForRisk(risk).policy,
    inputSchema: {
      type: "object",
      required,
      properties: genericToolInputProperties(name),
      additionalProperties: true,
    },
    outputSchema: { type: "object" },
    ...(reversible
      ? {
          rollbackStrategy: `Compensate ${name} with the existing Studio service.`,
        }
      : {}),
  });
  return [
    tool(
      "studio.search",
      "Search scoped Studio resources by name or status.",
      "read",
      ["studio:read"],
      [],
    ),
    tool(
      "workspace.navigate",
      "Return a safe relative Studio route to open.",
      "draft",
      ["studio:read"],
      ["href"],
    ),
    tool(
      "workspace.switch",
      "Switch the active organization and optional project after server authorization.",
      "security",
      ["studio:read"],
      ["organizationId"],
    ),
    tool(
      "workflow.update",
      "Update workflow metadata and enabled state.",
      "write",
      ["workflow:write"],
      ["id"],
      true,
    ),
    tool(
      "workflow.export",
      "Export a scoped workflow definition without secrets.",
      "read",
      ["workflow:read"],
      ["id"],
    ),
    tool(
      "workflow.validate",
      "Validate a scoped workflow graph and Registry references without persistence.",
      "read",
      ["workflow:read"],
      ["id"],
    ),
    tool(
      "workflow.update_graph",
      "Replace a workflow graph after server validation.",
      "write",
      ["workflow:write"],
      ["id", "graph"],
      true,
    ),
    tool(
      "workflow.clone",
      "Clone a complete workflow in the current scope.",
      "write",
      ["workflow:write"],
      ["id"],
      true,
    ),
    tool(
      "workflow.delete",
      "Delete a workflow and its scoped history after impact confirmation.",
      "destructive",
      ["workflow:delete"],
      ["id"],
    ),
    tool(
      "workflow.run",
      "Start a workflow run with optional runtime input.",
      "execute",
      ["workflow:execute"],
      ["id"],
    ),
    tool(
      "workflow_run.cancel",
      "Cancel an active workflow run.",
      "execute",
      ["workflow:execute"],
      ["id"],
    ),
    tool(
      "workflow_run.retry",
      "Retry a failed or cancelled workflow run.",
      "execute",
      ["workflow:execute"],
      ["id"],
    ),
    tool(
      "transfer.create",
      "Create a legacy Transfer template; credentials are references only.",
      "write",
      ["transfer:write"],
      ["name", "beamConnectionId"],
      true,
    ),
    tool(
      "transfer.update",
      "Update a legacy Transfer template.",
      "write",
      ["transfer:write"],
      ["id"],
      true,
    ),
    tool(
      "transfer.delete",
      "Delete a legacy Transfer template after impact confirmation.",
      "destructive",
      ["transfer:delete"],
      ["id"],
    ),
    tool(
      "transfer.toggle",
      "Enable or disable a legacy Transfer template.",
      "write",
      ["transfer:write"],
      ["id"],
      true,
    ),
    tool(
      "transfer.estimate",
      "Return current Transfer size, credit and duration estimates.",
      "read",
      ["studio:read"],
      ["id"],
    ),
    tool(
      "transfer.migration_preview",
      "Prepare a native workflow migration draft for a legacy Transfer.",
      "draft",
      ["workflow:read"],
      ["id"],
    ),
    tool(
      "transfer.endpoint.create",
      "Add a source or destination to a legacy Transfer.",
      "write",
      ["transfer:write"],
      ["transferTemplateId", "kind", "name", "provider", "bucket", "objectKey"],
      true,
    ),
    tool(
      "transfer.endpoint.update",
      "Update a scoped Transfer source or destination.",
      "write",
      ["transfer:write"],
      ["id", "kind", "name", "provider", "bucket", "objectKey"],
      true,
    ),
    tool(
      "transfer.endpoint.delete",
      "Remove a scoped Transfer source or destination.",
      "destructive",
      ["transfer:delete"],
      ["id", "kind"],
    ),
    tool(
      "transfer.run",
      "Start a legacy Transfer run.",
      "execute",
      ["transfer:execute"],
      ["id"],
    ),
    tool(
      "transfer_run.cancel",
      "Cancel an active legacy Transfer run.",
      "execute",
      ["transfer:execute"],
      ["id"],
    ),
    tool(
      "transfer_run.retry",
      "Retry a failed legacy Transfer run.",
      "execute",
      ["transfer:execute"],
      ["id"],
    ),
    tool(
      "schedule.create",
      "Create a scoped Transfer schedule with limits and overlap policy.",
      "write",
      ["schedule:write"],
      ["transferTemplateId", "frequency"],
      true,
    ),
    tool(
      "schedule.preview",
      "Preview upcoming schedule occurrences and policy risks without persistence.",
      "draft",
      ["studio:read"],
      ["frequency"],
    ),
    tool(
      "schedule.update",
      "Update a Transfer schedule.",
      "write",
      ["schedule:write"],
      ["id"],
      true,
    ),
    tool(
      "schedule.toggle",
      "Enable or disable a schedule.",
      "write",
      ["schedule:write"],
      ["id"],
      true,
    ),
    tool(
      "schedule.delete",
      "Delete a schedule after confirmation.",
      "destructive",
      ["schedule:delete"],
      ["id"],
    ),
    tool(
      "credential.prepare",
      "Prepare a secure credential form without exposing secret fields to the model.",
      "draft",
      ["credential:write"],
      ["name", "kind"],
    ),
    tool(
      "credential.rotate",
      "Prepare secure credential rotation outside model context.",
      "draft",
      ["credential:write"],
      ["id"],
    ),
    tool(
      "credential.migrate",
      "Prepare migration to another credential provider through a secure form.",
      "draft",
      ["credential:write"],
      ["id", "targetKind"],
    ),
    tool(
      "credential.usage",
      "Analyze scoped credential references before rotation or deletion.",
      "read",
      ["credential:read"],
      ["id"],
    ),
    tool(
      "credential.buckets",
      "List configured bucket names for a scoped credential without exposing its payload.",
      "read",
      ["credential:read"],
      ["id"],
    ),
    tool(
      "credential.validate_access",
      "Validate storage bucket access server-side without exposing credential material.",
      "execute",
      ["credential:read"],
      ["id"],
    ),
    tool(
      "credential.browse",
      "Browse scoped buckets, prefixes and objects with an existing credential.",
      "execute",
      ["credential:read"],
      ["id", "bucket"],
    ),
    tool(
      "credential.delete",
      "Delete a credential after scoped usage analysis.",
      "destructive",
      ["credential:delete"],
      ["id", "usageReviewed"],
    ),
    tool(
      "registry.search",
      "Search and compare installed Registry actions.",
      "read",
      ["registry:read"],
      [],
    ),
    tool(
      "registry.install",
      "Install a public Registry action and version.",
      "security",
      ["registry:install"],
      ["packageName"],
    ),
    tool(
      "run.search",
      "Search workflow and Transfer runs.",
      "read",
      ["run:read"],
      [],
    ),
    tool(
      "run.get",
      "Get scoped run details, steps, artifacts and logs.",
      "read",
      ["run:read"],
      ["id"],
    ),
    tool(
      "run.compare",
      "Compare two scoped runs and their item or step outcomes.",
      "read",
      ["run:read"],
      ["leftId", "rightId"],
    ),
    tool(
      "run.report",
      "Produce a structured report for scoped runs.",
      "read",
      ["run:read"],
      ["ids"],
    ),
    tool(
      "run.monitor",
      "Poll a scoped run for a bounded period and return its latest state.",
      "read",
      ["run:read"],
      ["id"],
    ),
    tool(
      "run.diagnose",
      "Explain a scoped run failure from server-side status, item and log evidence.",
      "read",
      ["run:read"],
      ["id"],
    ),
    tool(
      "run.cancel",
      "Cancel a run after resolving its resource kind.",
      "execute",
      ["run:execute"],
      ["id"],
    ),
    tool(
      "run.retry",
      "Retry a run after resolving its resource kind.",
      "execute",
      ["run:execute"],
      ["id"],
    ),
    tool(
      "queue.inspect",
      "Inspect queued and running work.",
      "read",
      ["run:read"],
      [],
    ),
    tool(
      "dead_letter.inspect",
      "Inspect dead-letter and failed work.",
      "read",
      ["run:read"],
      [],
    ),
    tool(
      "orchestration.inspect",
      "Inspect execution locations and worker health.",
      "read",
      ["orchestration:read"],
      [],
    ),
    tool(
      "execution_location.create",
      "Create an execution location. Secret headers require a secure form.",
      "security",
      ["orchestration:write"],
      ["name", "kind"],
    ),
    tool(
      "mcp.token.create",
      "Create a least-privilege MCP token with one-time secret delivery.",
      "security",
      ["mcp:write"],
      ["name", "scopes"],
      true,
    ),
    tool(
      "mcp.token.revoke",
      "Revoke an MCP token.",
      "security",
      ["mcp:write"],
      ["id"],
    ),
    tool(
      "mcp.token.delete",
      "Permanently delete an MCP token.",
      "destructive",
      ["mcp:delete"],
      ["id"],
    ),
    tool(
      "mcp.connection_config",
      "Generate a connection configuration using an environment placeholder, never a raw token.",
      "draft",
      ["mcp:read"],
      ["id"],
    ),
    tool(
      "mcp.audit",
      "Inspect MCP token usage and audit events.",
      "read",
      ["mcp:read"],
      [],
    ),
    tool(
      "assistant.provider_test",
      "Test the configured AI provider without exposing its credential.",
      "execute",
      ["studio:read"],
      [],
    ),
    tool(
      "assistant.audit",
      "Return the redacted assistant operation audit for the current scope.",
      "read",
      ["studio:read"],
      [],
    ),
  ];
}

function genericToolInputProperties(name: string): JsonObject {
  const id = {
    id: { type: "string", description: "Existing scoped resource ID." },
  };
  const runInput = {
    ...id,
    triggerId: { type: "string" },
    input: { type: "object" },
  };
  switch (name) {
    case "studio.search":
    case "registry.search":
      return { query: { type: "string" }, status: { type: "string" } };
    case "workspace.navigate":
      return { href: { type: "string", pattern: "^/" } };
    case "workspace.switch":
      return {
        organizationId: { type: "string" },
        projectId: { type: "string" },
      };
    case "workflow.update":
      return {
        ...id,
        name: { type: "string" },
        description: { type: "string" },
        enabled: { type: "boolean" },
      };
    case "workflow.update_graph":
      return { ...id, graph: { type: "object" } };
    case "workflow.clone":
      return { ...id, name: { type: "string" } };
    case "workflow.run":
      return runInput;
    case "transfer.create":
      return {
        name: { type: "string" },
        description: { type: "string" },
        beamConnectionId: {
          type: "string",
          description: "Existing Beam connection metadata reference.",
        },
        beamServerUrl: { type: "string" },
        fileSuffixMode: { type: "string" },
        enabled: { type: "boolean" },
        frequency: { type: "string" },
      };
    case "transfer.update":
      return { ...id, ...genericToolInputProperties("transfer.create") };
    case "transfer.endpoint.create":
    case "transfer.endpoint.update":
      return {
        ...(name.endsWith(".update") ? id : {}),
        transferTemplateId: { type: "string" },
        kind: { enum: ["source", "destination"] },
        name: { type: "string" },
        provider: { type: "string" },
        bucket: { type: "string" },
        objectKey: { type: "string" },
        sourceType: { enum: ["file", "directory"] },
        region: { type: "string" },
        endpointUrl: { type: "string" },
        credentialId: {
          type: "string",
          description: "Existing credential reference; never a raw credential.",
        },
        filenamePolicy: { type: "string" },
        filenameTemplate: { type: "string" },
        filenameTimezone: { type: "string" },
      };
    case "transfer.endpoint.delete":
      return { ...id, kind: { enum: ["source", "destination"] } };
    case "schedule.create":
    case "schedule.update":
    case "schedule.preview":
      return {
        ...(name === "schedule.update" ? id : {}),
        transferTemplateId: { type: "string" },
        frequency: { type: "string" },
        enabled: { type: "boolean" },
        nextRunAt: { type: "string", format: "date-time" },
        endAt: { type: "string", format: "date-time" },
        timezone: { type: "string" },
        maxRunDurationSeconds: { type: "number" },
        creditBudgetLimit: { type: "number" },
        maxRuns: { type: "number" },
        windowStartTime: { type: "string" },
        windowEndTime: { type: "string" },
        windowDays: { type: "array", items: { type: "number" } },
        overlapPolicy: { enum: ["allow", "skip_new", "cancel_previous"] },
        budgetAlertThreshold: { type: "number" },
      };
    case "credential.prepare":
      return {
        name: { type: "string" },
        kind: { type: "string" },
      };
    case "credential.migrate":
      return { ...id, targetKind: { type: "string" } };
    case "credential.delete":
      return {
        ...id,
        usageReviewed: { type: "boolean", const: true },
        force: { type: "boolean" },
      };
    case "credential.validate_access":
      return {
        ...id,
        buckets: { type: "array", items: { type: "string" } },
      };
    case "credential.browse":
      return {
        ...id,
        bucket: { type: "string" },
        prefix: { type: "string" },
      };
    case "registry.install":
      return {
        packageName: { type: "string" },
        range: { type: "string" },
      };
    case "run.search":
      return {
        status: { type: "string" },
        from: { type: "string", format: "date-time" },
        to: { type: "string", format: "date-time" },
      };
    case "run.monitor":
      return {
        ...id,
        waitSeconds: {
          type: "number",
          minimum: 0,
          maximum: 50,
          description: "Bounded long-poll duration; the client may call again.",
        },
        pollIntervalMs: { type: "number", minimum: 250, maximum: 5000 },
      };
    case "run.compare":
      return {
        leftId: { type: "string" },
        rightId: { type: "string" },
      };
    case "run.report":
      return {
        ids: { type: "array", items: { type: "string" } },
      };
    case "execution_location.create":
      return {
        name: { type: "string" },
        kind: { type: "string" },
        endpointUrl: { type: "string" },
        enabled: { type: "boolean" },
        allowInsecureHttp: { type: "boolean" },
      };
    case "mcp.token.create":
      return {
        name: { type: "string" },
        scopes: {
          type: "array",
          items: {
            enum: [
              "read:runs",
              "read:transfers",
              "read:credentials",
              "read:api_keys",
              "write:transfers",
              "run:transfers",
              "write:schedules",
              "cancel:runs",
            ],
          },
        },
        expiresAt: { type: "string", format: "date-time" },
      };
    default:
      return id;
  }
}

const assistantOneTimeSecrets = new Map<
  string,
  { value: string; expiresAt: number; userId: string | null }
>();

export function consumeAssistantOneTimeSecret(
  receiptId: string,
  userId: string | null,
) {
  const receipt = assistantOneTimeSecrets.get(receiptId);
  assistantOneTimeSecrets.delete(receiptId);
  if (!receipt || receipt.userId !== userId || receipt.expiresAt < Date.now()) {
    throw new AssistantPlanError(
      "secret_receipt_expired",
      "This one-time secret is unavailable or has expired.",
      404,
    );
  }
  return receipt.value;
}

function validateGenericOperation(operation: AssistantOperation) {
  const descriptor = genericToolDescriptors().find(
    (candidate) => candidate.name === operation.tool,
  );
  if (!descriptor) return [`Unknown tool "${operation.tool}".`];
  const errors: string[] = [];
  const required = arrayValue(descriptor.inputSchema.required).map(stringValue);
  for (const key of required) {
    if (!hasInputValue(operation.arguments[key])) {
      errors.push(`arguments.${key} is required.`);
    }
  }
  if (
    operation.tool === "workspace.navigate" &&
    !safeStudioHref(stringValue(operation.arguments.href))
  ) {
    errors.push("href must be a safe relative Studio route.");
  }
  if (
    operation.tool === "credential.delete" &&
    operation.arguments.usageReviewed !== true
  ) {
    errors.push("Credential usage must be reviewed before deletion.");
  }
  if (
    operation.tool === "mcp.token.create" &&
    !arrayValue(operation.arguments.scopes).length
  ) {
    errors.push("At least one MCP scope is required.");
  }
  if (
    operation.tool === "run.report" &&
    !arrayValue(operation.arguments.ids).length
  ) {
    errors.push("At least one run ID is required.");
  }
  if (
    operation.tool === "schedule.preview" &&
    !parseScheduleFrequency(stringValue(operation.arguments.frequency))
  ) {
    errors.push("Schedule frequency is invalid.");
  }
  return errors;
}

function genericOperationPreview(
  operation: AssistantOperation,
): AssistantPlanDiff[] {
  const [resourceType = "studio", action = "update"] =
    operation.tool.split(".");
  const change: AssistantPlanDiff["change"] =
    action === "delete"
      ? "delete"
      : action === "run" ||
          action === "cancel" ||
          action === "retry" ||
          action === "install"
        ? "execute"
        : action === "create" || action === "clone"
          ? "create"
          : "update";
  return [
    {
      resourceType,
      resourceId: stringValue(operation.arguments.id) || undefined,
      label:
        stringValue(operation.arguments.name) ||
        stringValue(operation.arguments.id) ||
        operation.tool,
      change,
      before: null,
      after:
        change === "delete"
          ? null
          : (redactAssistantPayload(operation.arguments) as JsonObject),
    },
  ];
}

async function detailedOperationPreview(
  operation: AssistantOperation,
  scope: AssistantExecutionScope,
  credentials: CredentialRepository,
): Promise<AssistantPlanDiff[]> {
  const fallback = genericOperationPreview(operation);
  const id = stringValue(operation.arguments.id);
  if (!id) {
    return fallback;
  }
  if (operation.tool === "workflow.delete") {
    const workflow = await requiredWorkflow(
      id,
      scope.organizationId,
      scope.projectId,
    );
    const callers = await listWorkflowTemplates({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
    });
    const workflowReferences: Array<{ id: string; name: string }> = [];
    for (const caller of callers) {
      const bundle = await getWorkflowTemplate(
        caller.id,
        scope.organizationId,
        scope.projectId,
      );
      if (
        bundle?.steps.some(
          (step) => step.kind === "workflow" && step.calledWorkflowId === id,
        )
      )
        workflowReferences.push({ id: caller.id, name: caller.name });
    }
    return [
      {
        resourceType: "workflow",
        resourceId: id,
        label: workflow.template.name,
        change: "delete",
        before: {
          name: workflow.template.name,
          enabled: workflow.template.enabled,
          stepCount: workflow.steps.length,
          triggerCount: workflow.triggers.length,
          runCount: workflow.runCount,
          referencedByWorkflows: workflowReferences,
        },
        after: null,
      },
    ];
  }
  if (operation.tool === "transfer.delete") {
    const transfer = requiredTransfer(
      id,
      scope.organizationId,
      scope.projectId,
    );
    const schedules = listSchedules({
      organizationId: scope.organizationId,
    }).filter((schedule) => schedule.transferTemplateId === id);
    return [
      {
        resourceType: "transfer",
        resourceId: id,
        label: transfer.transfer.name,
        change: "delete",
        before: {
          name: transfer.transfer.name,
          enabled: transfer.transfer.enabled,
          sourceCount: transfer.sources.length,
          destinationCount: transfer.destinations.length,
          scheduleCount: schedules.length,
          runCount: transfer.runs.length,
        },
        after: null,
      },
    ];
  }
  if (operation.tool === "credential.delete") {
    const usage = await credentialUsage(
      credentials,
      id,
      scope.organizationId,
      scope.projectId,
    );
    return [
      {
        resourceType: "credential",
        resourceId: id,
        label: id,
        change: "delete",
        before: usage,
        after: null,
      },
    ];
  }
  return fallback;
}

async function executeGenericOperation(
  operation: AssistantOperation,
  context: AssistantToolContext,
): Promise<JsonObject> {
  const args = operation.arguments;
  const organizationId = context.scope.organizationId;
  switch (operation.tool) {
    case "studio.search": {
      const query = normalizeText(stringValue(args.query));
      const [workflows, transfers, credentials] = await Promise.all([
        listWorkflowTemplates({
          organizationId,
          projectId: context.scope.projectId,
        }),
        Promise.resolve(
          listTransfers({
            organizationId,
            projectId: context.scope.projectId,
          }),
        ),
        credentialStore(context)
          .list(scope(organizationId))
          .then((credentials) =>
            credentials.filter(
              (credential) =>
                !context.scope.projectId ||
                credential.projectId === context.scope.projectId,
            ),
          ),
      ]);
      return {
        workflows: filterNamed(workflows, query),
        transfers: filterNamed(transfers, query),
        credentials: filterNamed(credentials, query),
      };
    }
    case "workspace.navigate":
      return { href: stringValue(args.href) };
    case "workspace.switch":
      return {
        workspaceSwitch: true,
        organizationId: requiredArg(args, "organizationId"),
        projectId: stringValue(args.projectId) || null,
        href: "/",
      };
    case "workflow.export": {
      const id = requiredArg(args, "id");
      const workflow = await requiredWorkflow(
        id,
        organizationId,
        context.scope.projectId,
      );
      return {
        id,
        filename: `${safeFilename(workflow.template.name)}.workflow.json`,
        definition: redactAssistantPayload({
          template: workflow.template,
          triggers: workflow.triggers,
          triggerEdges: workflow.triggerEdges,
          steps: workflow.steps,
          edges: workflow.edges,
        }) as JsonObject,
      };
    }
    case "workflow.validate": {
      const id = requiredArg(args, "id");
      const workflow = await requiredWorkflow(
        id,
        organizationId,
        context.scope.projectId,
      );
      return validateWorkflowBundle(workflow, context.actions);
    }
    case "workflow.update": {
      const id = requiredArg(args, "id");
      const before = await requiredWorkflow(
        id,
        organizationId,
        context.scope.projectId,
      );
      const updated = await updateWorkflowTemplate({
        id,
        organizationId,
        name: optionalArg(args, "name"),
        description:
          args.description === undefined
            ? undefined
            : stringValue(args.description),
        enabled: typeof args.enabled === "boolean" ? args.enabled : undefined,
      });
      return {
        id,
        href: `/workflows/${encodeURIComponent(id)}/editor`,
        before: before.template,
        updated: updated?.template ?? {},
      };
    }
    case "workflow.update_graph": {
      const id = requiredArg(args, "id");
      const before = await requiredWorkflow(
        id,
        organizationId,
        context.scope.projectId,
      );
      const graph = objectValue(args.graph);
      await updateWorkflowGraph({
        workflowTemplateId: id,
        organizationId,
        graphVersion: graph.graphVersion as never,
        controls: graph.controls as never,
        room: graph.room as never,
        inputSchema: graph.inputSchema as never,
        output: graph.output as never,
        agentBindings: graph.agentBindings as never,
        resourceBindings: graph.resourceBindings as never,
        failurePolicy: graph.failurePolicy as never,
        triggers: arrayValue(graph.triggers) as never,
        triggerEdges: arrayValue(graph.triggerEdges) as never,
        decisions: arrayValue(graph.decisions) as never,
        decisionEdges: arrayValue(graph.decisionEdges) as never,
        steps: arrayValue(graph.steps) as never,
        edges: arrayValue(graph.edges) as never,
      });
      return {
        id,
        href: `/workflows/${encodeURIComponent(id)}/editor`,
        before: workflowGraphSnapshot(before),
      };
    }
    case "workflow.clone": {
      const source = await requiredWorkflow(
        requiredArg(args, "id"),
        organizationId,
        context.scope.projectId,
      );
      const id = await duplicateWorkflowTemplate({
        id: source.template.id,
        organizationId,
        projectId: context.scope.projectId,
        name: stringValue(args.name) || undefined,
      });
      return { id, href: `/workflows/${encodeURIComponent(id)}/editor` };
    }
    case "workflow.delete": {
      const id = requiredArg(args, "id");
      const before = await requiredWorkflow(
        id,
        organizationId,
        context.scope.projectId,
      );
      await deleteWorkflowTemplate(id, organizationId);
      return {
        id,
        deleted: true,
        impact: {
          runCount: before.runCount,
          stepCount: before.steps.length,
        },
      };
    }
    case "workflow.run": {
      const id = requiredArg(args, "id");
      await requiredWorkflow(id, organizationId, context.scope.projectId);
      const runId = await startWorkflowRun(id, organizationId, {
        initiatingPrincipalId: context.scope.userId,
        triggerId: stringValue(args.triggerId),
        triggerEvent: objectValue(args.triggerEvent),
        runtimeInput: objectValue(args.input),
      });
      return {
        id: runId,
        workflowId: id,
        href: `/workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`,
      };
    }
    case "workflow_run.cancel": {
      const id = requiredArg(args, "id");
      if (
        !(await getWorkflowRun(id, organizationId, context.scope.projectId))
      ) {
        throw new AssistantPlanError(
          "run_not_found",
          "Workflow run not found.",
          404,
        );
      }
      await cancelWorkflowRun(id, organizationId);
      return { id, cancelRequested: true };
    }
    case "workflow_run.retry": {
      const sourceId = requiredArg(args, "id");
      if (
        !(await getWorkflowRun(
          sourceId,
          organizationId,
          context.scope.projectId,
        ))
      ) {
        throw new AssistantPlanError(
          "run_not_found",
          "Workflow run not found.",
          404,
        );
      }
      const id = await retryWorkflowRun(sourceId, organizationId);
      return { id, href: `/workflows/runs/${encodeURIComponent(id)}` };
    }
    case "transfer.create": {
      const id = createTransfer(
        transferCreateInput(args, organizationId, context.scope.projectId),
      );
      return { id, href: `/transfers/${encodeURIComponent(id)}` };
    }
    case "transfer.update": {
      const id = requiredArg(args, "id");
      const before = requiredTransfer(
        id,
        organizationId,
        context.scope.projectId,
      );
      updateTransfer(
        transferUpdateInput(args, before.transfer, organizationId),
      );
      return {
        id,
        href: `/transfers/${encodeURIComponent(id)}`,
        before: before.transfer,
      };
    }
    case "transfer.delete": {
      const id = requiredArg(args, "id");
      const before = requiredTransfer(
        id,
        organizationId,
        context.scope.projectId,
      );
      deleteTransfer(id, organizationId);
      return {
        id,
        deleted: true,
        impact: {
          runCount: before.runs.length,
          sourceCount: before.sources.length,
          destinationCount: before.destinations.length,
        },
      };
    }
    case "transfer.toggle": {
      const id = requiredArg(args, "id");
      const before = requiredTransfer(
        id,
        organizationId,
        context.scope.projectId,
      );
      toggleTransfer(id, organizationId);
      return { id, enabledBefore: before.transfer.enabled };
    }
    case "transfer.estimate": {
      const id = requiredArg(args, "id");
      const transfer = requiredTransfer(
        id,
        organizationId,
        context.scope.projectId,
      );
      return {
        id,
        totalSourceSizeBytes: transfer.transfer.totalSourceSizeBytes,
        totalTransferSizeBytes: transfer.transfer.totalTransferSizeBytes,
        // Per run at the published price, or null when it cannot be priced.
        estimatedCreditCost: await transferEstimate(
          transfer.transfer,
          organizationId,
        ),
        sourceCount: transfer.sources.length,
        destinationCount: transfer.destinations.length,
      };
    }
    case "transfer.migration_preview": {
      const id = requiredArg(args, "id");
      const transfer = requiredTransfer(
        id,
        organizationId,
        context.scope.projectId,
      );
      const transferAction = context.actions.find(
        (action) =>
          action.name === "@beam/transfer" ||
          action.name.toLowerCase().includes("transfer"),
      );
      return {
        id,
        available: Boolean(transferAction),
        ...(transferAction
          ? {
              workflowDraft: {
                name: `${transfer.transfer.name} workflow`,
                actionPackageName: transferAction.name,
                actionVersionRange: `^${transferAction.version}`,
                sourceCount: transfer.sources.length,
                destinationCount: transfer.destinations.length,
                credentialReferences: [
                  ...new Set(
                    [...transfer.sources, ...transfer.destinations]
                      .map((endpoint) => endpoint.credentialId)
                      .filter(Boolean),
                  ),
                ],
              },
            }
          : {
              missingRegistryAction:
                "No installed Registry action can represent this Transfer.",
            }),
      };
    }
    case "transfer.endpoint.create": {
      const transferTemplateId = requiredArg(args, "transferTemplateId");
      requiredTransfer(
        transferTemplateId,
        organizationId,
        context.scope.projectId,
      );
      const kind = endpointKind(args.kind);
      const id = createEndpoint(
        kind,
        transferEndpointInput(args, organizationId, transferTemplateId),
      );
      return {
        id,
        transferTemplateId,
        kind,
        href: `/transfers/${encodeURIComponent(transferTemplateId)}`,
      };
    }
    case "transfer.endpoint.update": {
      const id = requiredArg(args, "id");
      const kind = endpointKind(args.kind);
      const existing = requiredTransferEndpoint(
        id,
        kind,
        organizationId,
        context.scope.projectId,
      );
      updateEndpoint(kind, {
        ...transferEndpointInput(
          { ...existing.endpoint, ...args },
          organizationId,
          existing.transferId,
        ),
        id,
      });
      return {
        id,
        kind,
        before: existing.endpoint,
        href: `/transfers/${encodeURIComponent(existing.transferId)}`,
      };
    }
    case "transfer.endpoint.delete": {
      const id = requiredArg(args, "id");
      const kind = endpointKind(args.kind);
      const existing = requiredTransferEndpoint(
        id,
        kind,
        organizationId,
        context.scope.projectId,
      );
      deleteEndpoint(kind, id, organizationId);
      return {
        id,
        kind,
        deleted: true,
        impact: {
          transferTemplateId: existing.transferId,
          endpoint: existing.endpoint,
        },
      };
    }
    case "transfer.run": {
      const transferId = requiredArg(args, "id");
      requiredTransfer(transferId, organizationId, context.scope.projectId);
      const id = startRun(transferId, organizationId);
      return { id, transferId, href: `/runs/${encodeURIComponent(id)}` };
    }
    case "transfer_run.cancel": {
      const id = requiredArg(args, "id");
      if (!getRun(id, organizationId, context.scope.projectId)) {
        throw new AssistantPlanError(
          "run_not_found",
          "Transfer run not found.",
          404,
        );
      }
      cancelRun(id, organizationId);
      return { id, cancelled: true };
    }
    case "transfer_run.retry": {
      const sourceId = requiredArg(args, "id");
      if (!getRun(sourceId, organizationId, context.scope.projectId)) {
        throw new AssistantPlanError(
          "run_not_found",
          "Transfer run not found.",
          404,
        );
      }
      const id = retryRun(sourceId, organizationId);
      return { id, href: `/runs/${encodeURIComponent(id)}` };
    }
    case "schedule.create": {
      requiredTransfer(
        requiredArg(args, "transferTemplateId"),
        organizationId,
        context.scope.projectId,
      );
      const id = createSchedule(scheduleInput(args, organizationId));
      return { ...(id ? { id } : {}), href: "/schedules" };
    }
    case "schedule.preview":
      return scheduleProjection(args);
    case "schedule.update": {
      const id = requiredArg(args, "id");
      const before = requiredSchedule(
        id,
        organizationId,
        context.scope.projectId,
      );
      updateSchedule(
        scheduleInput({ ...before, ...args, id }, organizationId) as never,
      );
      return { id, href: `/schedules/${encodeURIComponent(id)}`, before };
    }
    case "schedule.toggle": {
      const id = requiredArg(args, "id");
      const before = requiredSchedule(
        id,
        organizationId,
        context.scope.projectId,
      );
      toggleSchedule(id, organizationId);
      return { id, enabledBefore: before.enabled };
    }
    case "schedule.delete": {
      const id = requiredArg(args, "id");
      const before = requiredSchedule(
        id,
        organizationId,
        context.scope.projectId,
      );
      deleteSchedule(id, organizationId);
      return { id, deleted: true, before };
    }
    case "credential.prepare":
      return {
        href: `/credentials/new?name=${encodeURIComponent(requiredArg(args, "name"))}&provider=${encodeURIComponent(requiredArg(args, "kind"))}`,
        secureForm: true,
      };
    case "credential.rotate":
    case "credential.migrate": {
      const id = requiredArg(args, "id");
      const credential = (
        await credentialStore(context).list(scope(organizationId))
      ).find(
        (item) =>
          item.id === id &&
          (!context.scope.projectId ||
            item.projectId === context.scope.projectId),
      );
      if (!credential) {
        throw new AssistantPlanError(
          "credential_not_found",
          "Credential not found in the current organization and project.",
          404,
        );
      }
      const targetKind = stringValue(args.targetKind) || credential.kind;
      return {
        id,
        href: `/credentials/${encodeURIComponent(id)}?mode=${operation.tool === "credential.rotate" ? "rotate" : "migrate"}&provider=${encodeURIComponent(targetKind)}`,
        secureForm: true,
      };
    }
    case "credential.usage": {
      const id = requiredArg(args, "id");
      return credentialUsage(
        credentialStore(context),
        id,
        organizationId,
        context.scope.projectId,
      );
    }
    case "credential.buckets": {
      const id = requiredArg(args, "id");
      const credential = (
        await credentialStore(context).list(scope(organizationId))
      ).find(
        (item) =>
          item.id === id &&
          (!context.scope.projectId ||
            item.projectId === context.scope.projectId),
      );
      const payload = await credentialStore(context).payload(
        scope(organizationId),
        id,
      );
      if (!credential || !payload) {
        throw new AssistantPlanError(
          "credential_not_found",
          "Credential not found in the current organization and project.",
          404,
        );
      }
      return { id, buckets: credentialBuckets(payload) };
    }
    case "credential.validate_access": {
      const id = requiredArg(args, "id");
      const credential = (
        await credentialStore(context).list(scope(organizationId))
      ).find(
        (item) =>
          item.id === id &&
          (!context.scope.projectId ||
            item.projectId === context.scope.projectId),
      );
      const payload = await credentialStore(context).payload(
        scope(organizationId),
        id,
      );
      if (!credential || !payload) {
        throw new AssistantPlanError(
          "credential_not_found",
          "Credential not found in the current organization.",
          404,
        );
      }
      const requestedBuckets = arrayValue(args.buckets).map(String);
      const buckets = requestedBuckets.length
        ? requestedBuckets
        : credentialBuckets(payload);
      await validateProviderBuckets({
        provider: credential.kind,
        payload,
        buckets,
      });
      return { id, ok: true, buckets };
    }
    case "credential.browse": {
      const id = requiredArg(args, "id");
      const credential = (
        await credentialStore(context).list(scope(organizationId))
      ).find(
        (item) =>
          item.id === id &&
          (!context.scope.projectId ||
            item.projectId === context.scope.projectId),
      );
      if (!credential) {
        throw new AssistantPlanError(
          "credential_not_found",
          "Credential not found in the current organization and project.",
          404,
        );
      }
      return {
        id,
        ...(await listCredentialObjects({
          pool: context.pool,
          organizationId,
          credentialId: id,
          bucket: requiredArg(args, "bucket"),
          prefix: stringValue(args.prefix),
        })),
      };
    }
    case "credential.delete": {
      const id = requiredArg(args, "id");
      const usage = await credentialUsage(
        credentialStore(context),
        id,
        organizationId,
        context.scope.projectId,
      );
      if (Number(usage.referenceCount) > 0 && args.force !== true) {
        throw new AssistantPlanError(
          "credential_in_use",
          "Credential is still referenced. Set force only after reviewing impact.",
          409,
        );
      }
      await credentialStore(context).revoke(scope(organizationId), id);
      return { id, deleted: true, usage };
    }
    case "registry.search": {
      const registry = await listRegistryPackages(organizationId);
      const query = normalizeText(stringValue(args.query));
      return {
        packages: filterNamed(
          arrayValue(objectValue(registry).packages).map(objectValue),
          query,
        ).map((pkg) => ({
          ...pkg,
          href: assistantEntityHref(
            "registry_action",
            stringValue(pkg.packageName),
          ),
        })),
      };
    }
    case "registry.install": {
      const result = await installPublicRegistryPackage({
        packageName: requiredArg(args, "packageName"),
        range: stringValue(args.range) || "latest",
        organizationId,
      });
      return { installed: result as unknown as JsonObject };
    }
    case "run.search":
      return searchRuns(args, organizationId, context.scope.projectId);
    case "run.get":
      return getAnyRun(
        requiredArg(args, "id"),
        organizationId,
        context.scope.projectId,
      );
    case "run.compare": {
      const left = await getAnyRun(
        requiredArg(args, "leftId"),
        organizationId,
        context.scope.projectId,
      );
      const right = await getAnyRun(
        requiredArg(args, "rightId"),
        organizationId,
        context.scope.projectId,
      );
      return compareRunSnapshots(left, right);
    }
    case "run.report": {
      const ids = arrayValue(args.ids).map(String).filter(Boolean).slice(0, 50);
      const runs = await Promise.all(
        ids.map((id) => getAnyRun(id, organizationId, context.scope.projectId)),
      );
      const statuses = runs.reduce<Record<string, number>>((summary, run) => {
        const status = runSnapshotStatus(run) || "unknown";
        summary[status] = (summary[status] ?? 0) + 1;
        return summary;
      }, {});
      return {
        generatedAt: new Date().toISOString(),
        runCount: runs.length,
        statuses,
        runs: runs.map((run, index) => ({
          id: ids[index],
          kind: run.kind,
          status: runSnapshotStatus(run),
          terminal: runSnapshotTerminal(run),
        })),
      };
    }
    case "run.monitor":
      return monitorRun(args, organizationId, context.scope.projectId);
    case "run.diagnose":
      return diagnoseRun(
        requiredArg(args, "id"),
        organizationId,
        context.scope.projectId,
      );
    case "run.cancel":
      return cancelAnyRun(
        requiredArg(args, "id"),
        organizationId,
        context.scope.projectId,
      );
    case "run.retry":
      return retryAnyRun(
        requiredArg(args, "id"),
        organizationId,
        context.scope.projectId,
      );
    case "queue.inspect": {
      const transferIds = new Set(
        listTransfers({
          organizationId,
          projectId: context.scope.projectId,
        }).map((transfer) => transfer.id),
      );
      return {
        transferRuns: listQueueRuns({ organizationId }).filter((run) =>
          transferIds.has(run.transferTemplateId),
        ),
        workflowRuns: (
          await listWorkflowRuns({
            organizationId,
            projectId: context.scope.projectId,
          })
        ).filter((run) =>
          ["queued", "running", "cancel_requested"].includes(run.status),
        ),
      };
    }
    case "dead_letter.inspect": {
      const transferIds = new Set(
        listTransfers({
          organizationId,
          projectId: context.scope.projectId,
        }).map((transfer) => transfer.id),
      );
      return {
        transferRuns: listDeadLetterRuns({ organizationId }).filter((run) =>
          transferIds.has(run.transferTemplateId),
        ),
        workflowRuns: (
          await listWorkflowRuns({
            organizationId,
            projectId: context.scope.projectId,
          })
        ).filter((run) => ["failed", "cancelled"].includes(run.status)),
      };
    }
    case "orchestration.inspect":
      return {
        locations: await listExecutionLocations({ organizationId }),
        workers: listWorkerInstances(),
      };
    case "execution_location.create": {
      if (args.headersJson) {
        throw new AssistantPlanError(
          "secure_input_required",
          "Execution location headers must be entered in a secure form.",
          422,
        );
      }
      const id = await createExecutionLocation({
        organizationId,
        name: requiredArg(args, "name"),
        kind: requiredArg(args, "kind"),
        endpointUrl: stringValue(args.endpointUrl),
        enabled: args.enabled !== false,
        allowInsecureHttp: args.allowInsecureHttp === true,
      });
      return { id, href: "/orchestration/locations" };
    }
    case "mcp.token.create": {
      const created = await mcpTokens(context).create(scope(organizationId), {
        name: requiredArg(args, "name"),
        scopes: arrayValue(args.scopes).map(String) as never,
        expiresAt: stringValue(args.expiresAt),
      });
      const receiptId = `asr_${randomUUID()}`;
      assistantOneTimeSecrets.set(receiptId, {
        value: created.token,
        expiresAt: Date.now() + 5 * 60_000,
        userId: context.scope.userId,
      });
      return {
        id: created.record.id,
        tokenPrefix: created.record.tokenPrefix,
        oneTimeReceiptId: receiptId,
        oneTimeHref: `/studio/assistant/secrets/${encodeURIComponent(receiptId)}`,
        expiresInSeconds: 300,
      };
    }
    case "mcp.token.revoke": {
      const id = requiredArg(args, "id");
      const revoked = await mcpTokens(context).revoke(
        scope(organizationId),
        id,
      );
      if (!revoked) {
        throw new AssistantPlanError(
          "mcp_token_not_found",
          "MCP token not found in the current organization.",
          404,
        );
      }
      return { id, revoked: true };
    }
    case "mcp.token.delete": {
      const id = requiredArg(args, "id");
      const deleted = await mcpTokens(context).delete(
        scope(organizationId),
        id,
      );
      if (!deleted) {
        throw new AssistantPlanError(
          "mcp_token_not_found",
          "MCP token not found in the current organization.",
          404,
        );
      }
      return { id, deleted: true };
    }
    case "mcp.connection_config": {
      const id = requiredArg(args, "id");
      const token = (await mcpTokens(context).list(scope(organizationId))).find(
        (candidate) => candidate.id === id,
      );
      if (!token) {
        throw new AssistantPlanError(
          "mcp_token_not_found",
          "MCP token not found in the current organization.",
          404,
        );
      }
      return {
        id,
        config: {
          transport: "http",
          url: "/mcp",
          credentialVariableName: "BEAM_STUDIO_MCP_TOKEN",
        },
        tokenPrefix: token.tokenPrefix,
        note: "Set BEAM_STUDIO_MCP_TOKEN outside assistant context.",
      };
    }
    case "mcp.audit": {
      const auditScope = scope(organizationId);
      const repository = mcpTokens(context);
      const [tokens, usage] = await Promise.all([
        repository.list(auditScope),
        repository.usageSummaries(auditScope),
      ]);
      return { tokens, usage, events: listMcpAuditEvents({ organizationId }) };
    }
    case "assistant.provider_test":
      return testAssistantProvider();
    case "assistant.audit":
      return {
        events:
          (await context.repository?.listAudit(
            context.scope,
            Number(args.limit ?? 100),
          )) ?? [],
      };
    default:
      throw new AssistantPlanError(
        "tool_not_implemented",
        `Studio tool "${operation.tool}" is not implemented.`,
        422,
      );
  }
}

async function rollbackGenericOperation(
  operation: AssistantOperation,
  context: AssistantToolContext,
) {
  const result = operation.result ?? {};
  const organizationId = context.scope.organizationId;
  const id = stringValue(result.id) || stringValue(operation.arguments.id);
  switch (operation.tool) {
    case "workflow.update":
      if (isObject(result.before)) {
        await updateWorkflowTemplate({
          id,
          organizationId,
          name: stringValue(result.before.name),
          description: stringValue(result.before.description),
          enabled: result.before.enabled !== false,
        });
      }
      return;
    case "workflow.update_graph":
      if (isObject(result.before)) {
        await updateWorkflowGraph({
          workflowTemplateId: id,
          organizationId,
          graphVersion: result.before.graphVersion as never,
          controls: result.before.controls as never,
          decisions: result.before.decisions as never,
          decisionEdges: result.before.decisionEdges as never,
          room: result.before.room as never,
          inputSchema: result.before.inputSchema as never,
          output: result.before.output as never,
          agentBindings: result.before.agentBindings as never,
          resourceBindings: result.before.resourceBindings as never,
          failurePolicy: result.before.failurePolicy as never,
          triggers: arrayValue(result.before.triggers) as never,
          triggerEdges: arrayValue(result.before.triggerEdges) as never,
          steps: arrayValue(result.before.steps) as never,
          edges: arrayValue(result.before.edges) as never,
        });
      }
      return;
    case "workflow.clone":
      if (id) await deleteWorkflowTemplate(id, organizationId);
      return;
    case "transfer.create":
      if (id) deleteTransfer(id, organizationId);
      return;
    case "transfer.endpoint.create":
      if (id) {
        deleteEndpoint(
          endpointKind(operation.arguments.kind),
          id,
          organizationId,
        );
      }
      return;
    case "transfer.endpoint.update":
      if (isObject(result.before)) {
        const kind = endpointKind(operation.arguments.kind);
        const existing = requiredTransferEndpoint(
          id,
          kind,
          organizationId,
          context.scope.projectId,
        );
        updateEndpoint(kind, {
          ...transferEndpointInput(
            result.before,
            organizationId,
            existing.transferId,
          ),
          id,
        });
      }
      return;
    case "transfer.update":
      if (isObject(result.before)) {
        updateTransfer(
          transferUpdateInput(
            { id, ...result.before },
            result.before,
            organizationId,
          ),
        );
      }
      return;
    case "transfer.toggle":
      if (id) toggleTransfer(id, organizationId);
      return;
    case "schedule.create":
      if (id) deleteSchedule(id, organizationId);
      return;
    case "schedule.update":
      if (isObject(result.before)) {
        updateSchedule(scheduleInput(result.before, organizationId) as never);
      }
      return;
    case "schedule.toggle":
      if (id) toggleSchedule(id, organizationId);
      return;
    case "mcp.token.create":
      if (id) await mcpTokens(context).revoke(scope(organizationId), id);
      return;
    default:
      return;
  }
}

function validateWorkflowCreateOperation(
  operation: AssistantOperation,
  context: AssistantToolContext,
) {
  const errors: string[] = [];
  const workflow = objectValue(operation.arguments.workflow);
  if (!stringValue(workflow.id)) {
    errors.push("workflow.id is required.");
  }
  if (!stringValue(workflow.name)) {
    errors.push("workflow.name is required.");
  }
  const triggers = arrayValue(workflow.triggers).map(objectValue);
  const steps = arrayValue(workflow.steps).map(objectValue);
  const edges = arrayValue(workflow.edges).map(objectValue);
  const triggerEdges = arrayValue(workflow.triggerEdges).map(objectValue);
  if (!triggers.length) {
    errors.push("At least one trigger is required.");
  }
  if (!steps.length) {
    errors.push("At least one workflow step is required.");
  }
  const triggerIds = new Set(
    triggers.map((trigger) => stringValue(trigger.id)),
  );
  const stepIds = new Set(steps.map((step) => stringValue(step.id)));
  const actionNames = new Set(context.actions.map((action) => action.name));
  for (const trigger of triggers) {
    const type = stringValue(trigger.type);
    if (!SUPPORTED_TRIGGER_TYPES.has(type)) {
      errors.push(`Unsupported trigger type "${type || "(missing)"}".`);
    }
  }
  for (const step of steps) {
    if (step.kind === "workflow") {
      if (!stringValue(step.calledWorkflowId))
        errors.push("Workflow calls require calledWorkflowId.");
      continue;
    }
    const actionPackageName = stringValue(step.actionPackageName);
    const action = context.actions.find(
      (candidate) => candidate.name === actionPackageName,
    );
    if (!actionNames.has(actionPackageName) || !action) {
      errors.push(`Registry action "${actionPackageName}" is not available.`);
      continue;
    }
    const configSchema = objectValue(action.manifest.configSchema);
    const required = arrayValue(configSchema.required).map(stringValue);
    const config = objectValue(step.config);
    for (const key of required) {
      if (!hasInputValue(config[key])) {
        errors.push(
          `Step ${stringValue(step.id)} requires config field "${key}".`,
        );
      }
    }
  }
  for (const edge of edges) {
    if (!stepIds.has(stringValue(edge.fromStepId))) {
      errors.push(`Edge ${stringValue(edge.id)} has an unknown source step.`);
    }
    if (!stepIds.has(stringValue(edge.toStepId))) {
      errors.push(`Edge ${stringValue(edge.id)} has an unknown target step.`);
    }
  }
  for (const edge of triggerEdges) {
    if (!triggerIds.has(stringValue(edge.triggerId))) {
      errors.push(
        `Trigger edge ${stringValue(edge.id)} has an unknown trigger.`,
      );
    }
    if (!stepIds.has(stringValue(edge.toStepId))) {
      errors.push(
        `Trigger edge ${stringValue(edge.id)} has an unknown target step.`,
      );
    }
  }
  return errors;
}

async function executeWorkflowCreateOperation(
  operation: AssistantOperation,
  context: AssistantToolContext,
) {
  const workflow = objectValue(operation.arguments.workflow);
  const workflowId = stringValue(workflow.id);
  let created = false;
  const existing = await getWorkflowTemplate(
    workflowId,
    context.scope.organizationId,
    context.scope.projectId,
  );
  if (!existing) {
    await createWorkflowTemplate({
      id: workflowId,
      organizationId: context.scope.organizationId,
      projectId: context.scope.projectId,
      name: stringValue(workflow.name),
      description: stringValue(workflow.description),
    });
    created = true;
  }
  try {
    await updateWorkflowGraph({
      workflowTemplateId: workflowId,
      organizationId: context.scope.organizationId,
      room: workflow.room as never,
      inputSchema: workflow.inputSchema as never,
      output: workflow.output as never,
      agentBindings: workflow.agentBindings as never,
      resourceBindings: workflow.resourceBindings as never,
      failurePolicy: workflow.failurePolicy as never,
      triggers: arrayValue(workflow.triggers).map((item) => {
        const trigger = objectValue(item);
        return {
          id: stringValue(trigger.id),
          type: stringValue(trigger.type),
          name: stringValue(trigger.name),
          enabled: trigger.enabled !== false,
          config: objectValue(trigger.config),
          state: objectValue(trigger.state),
          canvasX: numberOrNull(trigger.canvasX),
          canvasY: numberOrNull(trigger.canvasY),
        };
      }),
      triggerEdges: arrayValue(workflow.triggerEdges).map((item) => {
        const edge = objectValue(item);
        return {
          id: stringValue(edge.id),
          triggerId: stringValue(edge.triggerId),
          toStepId: stringValue(edge.toStepId),
          condition: jsonValue(edge.condition),
        };
      }),
      steps: arrayValue(workflow.steps).map((item, index) => {
        const step = objectValue(item);
        return {
          id: stringValue(step.id),
          kind: step.kind === "workflow" ? "workflow" : "action",
          calledWorkflowId: stringValue(step.calledWorkflowId) || null,
          actionPackageName: stringValue(step.actionPackageName),
          actionVersionRange: stringValue(step.actionVersionRange) || "*",
          position: Number.isInteger(step.position)
            ? Number(step.position)
            : index,
          enabled: step.enabled !== false,
          config: objectValue(step.config),
          inputBindings: objectValue(step.inputBindings),
          placement: stringValue(step.placement) || "local-workers",
          executionTarget: step.executionTarget as
            | import("@beam-studio/shared").ActionExecutionTarget
            | undefined,
          executionLocationId: stringValue(step.executionLocationId) || null,
          canvasX: numberOrNull(step.canvasX),
          canvasY: numberOrNull(step.canvasY),
          timeoutSeconds: numberOrNull(step.timeoutSeconds),
          required: step.required !== false,
        };
      }),
      edges: arrayValue(workflow.edges).map((item) => {
        const edge = objectValue(item);
        return {
          id: stringValue(edge.id),
          fromStepId: stringValue(edge.fromStepId),
          toStepId: stringValue(edge.toStepId),
          condition: jsonValue(edge.condition),
        };
      }),
    });
  } catch (error) {
    if (created) {
      await deleteWorkflowTemplate(workflowId, context.scope.organizationId);
    }
    throw error;
  }
  return {
    id: workflowId,
    href: `/workflows/${encodeURIComponent(workflowId)}/editor`,
    created: true,
  };
}

function workflowGraphFromPatch(
  patch: AssistantWorkflowPatchOperation[],
  planId: string,
  name: string,
  description: string,
) {
  const refIds = new Map<string, string>();
  const triggerRefs = new Set<string>();
  const decisionRefs = new Set<string>();
  const steps: JsonObject[] = [];
  const triggers: JsonObject[] = [];
  const decisions: JsonObject[] = [];
  for (const operation of patch) {
    if (operation.op === "add_trigger") {
      const id = stableResourceId("wft", planId, operation.ref);
      refIds.set(operation.ref, id);
      triggerRefs.add(operation.ref);
      triggers.push({
        id,
        type: operation.triggerType,
        name: operation.name ?? assistantTriggerName(operation.triggerType),
        enabled: true,
        config: operation.config ?? {},
        state: {},
        canvasX: 0,
        canvasY: triggers.length * 140,
      });
    }
    if (operation.op === "add_decision") {
      const id = stableResourceId("dec", planId, operation.ref);
      refIds.set(operation.ref, id);
      decisionRefs.add(operation.ref);
      decisions.push({
        id,
        name: operation.name ?? "Decision",
        enabled: true,
        joinMode: operation.joinMode ?? "all",
        handleFailure: operation.handleFailure ?? false,
        config: { predicate: operation.predicate ?? null },
        canvasX: 240,
        canvasY: decisions.length * 180,
      });
    }
    if (operation.op === "add_step") {
      const id = stableResourceId("wfs", planId, operation.ref);
      refIds.set(operation.ref, id);
      steps.push({
        id,
        actionPackageName: operation.actionPackageName,
        actionVersionRange: "*",
        position: steps.length,
        enabled: true,
        config: operation.config ?? {},
        inputBindings: {},
        placement: "local-workers",
        executionLocationId: null,
        canvasX: 300 + steps.length * 260,
        canvasY: 0,
        timeoutSeconds: null,
        required: true,
      });
    }
  }
  const stepById = new Map(steps.map((step) => [stringValue(step.id), step]));
  for (const operation of patch) {
    if (
      operation.op === "configure_step" ||
      operation.op === "rename_step" ||
      operation.op === "set_binding"
    ) {
      const step = stepById.get(
        refIds.get(operation.stepRef) ?? operation.stepRef,
      );
      if (!step) {
        continue;
      }
      if (operation.op === "configure_step") {
        step.config = {
          ...objectValue(step.config),
          ...operation.config,
        };
      }
      if (operation.op === "rename_step") {
        step.config = { ...objectValue(step.config), name: operation.name };
      }
      if (operation.op === "set_binding") {
        step.inputBindings = {
          ...objectValue(step.inputBindings),
          [operation.inputKey]: resolvePatchExpression(
            operation.expression,
            refIds,
          ),
        };
      }
    }
  }
  const edges: JsonObject[] = [];
  const triggerEdges: JsonObject[] = [];
  const decisionEdges: JsonObject[] = [];
  for (const operation of patch) {
    if (operation.op !== "connect") {
      continue;
    }
    const fromId = refIds.get(operation.fromRef) ?? operation.fromRef;
    const toId = refIds.get(operation.toRef) ?? operation.toRef;
    const fromDecision = decisionRefs.has(operation.fromRef);
    const toDecision = decisionRefs.has(operation.toRef);
    if (fromDecision || toDecision) {
      decisionEdges.push({
        id: stableResourceId(
          "de",
          planId,
          `${operation.fromRef}:${operation.toRef}`,
        ),
        ...(fromDecision ? { fromDecisionId: fromId } : { fromStepId: fromId }),
        ...(toDecision ? { toDecisionId: toId } : { toStepId: toId }),
        // A branch is required leaving a decision and refused entering one.
        branch: fromDecision ? (operation.branch ?? "true") : null,
      });
      continue;
    }
    if (triggerRefs.has(operation.fromRef)) {
      triggerEdges.push({
        id: stableResourceId(
          "wfte",
          planId,
          `${operation.fromRef}:${operation.toRef}`,
        ),
        triggerId: fromId,
        toStepId: toId,
        condition: operation.condition ?? null,
      });
    } else {
      edges.push({
        id: stableResourceId(
          "wfe",
          planId,
          `${operation.fromRef}:${operation.toRef}`,
        ),
        fromStepId: fromId,
        toStepId: toId,
        condition: operation.condition ?? null,
      });
    }
  }
  if (!triggers.length && steps.length) {
    triggers.push({
      id: stableResourceId("wft", planId, "default_manual_trigger"),
      type: "manual",
      name: "Trigger manually",
      enabled: true,
      config: {},
      state: {},
      canvasX: 0,
      canvasY: 0,
    });
  }
  if (triggers.length && steps.length) {
    const incomingStepIds = new Set(
      edges.map((edge) => stringValue(edge.toStepId)),
    );
    const connectedRootIds = new Set(
      triggerEdges.map((edge) => stringValue(edge.toStepId)),
    );
    const triggerId = stringValue(triggers[0]?.id);
    for (const step of steps) {
      const stepId = stringValue(step.id);
      if (incomingStepIds.has(stepId) || connectedRootIds.has(stepId)) {
        continue;
      }
      triggerEdges.push({
        id: stableResourceId("wfte", planId, `default:${stepId}`),
        triggerId,
        toStepId: stepId,
        condition: null,
      });
    }
  }
  return {
    id: stableResourceId("wft_ast", planId, "workflow"),
    name,
    description,
    enabled: true,
    triggers,
    triggerEdges,
    decisions,
    decisionEdges,
    steps,
    edges,
  };
}

function inputRequestsForWorkflow(
  operationId: string,
  workflow: JsonObject,
  legacyNeedsInput: string[],
  actions: AssistantActionPackage[],
) {
  const requests: AssistantInputRequest[] = [];
  const steps = arrayValue(workflow.steps).map(objectValue);
  for (const [stepIndex, step] of steps.entries()) {
    const config = objectValue(step.config);
    const action = actions.find(
      (candidate) => candidate.name === stringValue(step.actionPackageName),
    );
    const configSchema = objectValue(action?.manifest.configSchema);
    const requiredKeys = arrayValue(configSchema.required).map(stringValue);
    const emptyKeys = Object.entries(config)
      .filter(([, value]) => value === "")
      .map(([key]) => key);
    const requestedKeys = [...new Set([...emptyKeys, ...requiredKeys])];
    const properties = objectValue(configSchema.properties);
    for (const key of requestedKeys) {
      if (hasInputValue(config[key])) {
        continue;
      }
      const credential = /credentialid$/i.test(key);
      const property = objectValue(properties[key]);
      const sensitive =
        property.writeOnly === true ||
        /secret|token|api[_-]?key|password|private[_-]?key/i.test(key);
      requests.push({
        id: `${operationId}:step:${stepIndex}:config:${key}`,
        label: humanizeKey(key),
        description: `${stringValue(step.actionPackageName)} · step ${
          stepIndex + 1
        }`,
        type: sensitive
          ? "secure_secret"
          : credential
            ? "credential_reference"
            : property.type === "number" || property.type === "integer"
              ? "number"
              : property.type === "boolean"
                ? "boolean"
                : "text",
        required: true,
        sensitive,
        operationId,
        argumentPath: `/workflow/steps/${stepIndex}/config/${escapePointer(key)}`,
      });
    }
  }
  if (!requests.length && legacyNeedsInput.length) {
    requests.push(
      ...legacyNeedsInput.map((label, index) => ({
        id: `${operationId}:input:${index}`,
        label,
        type: "text" as const,
        required: true,
        sensitive: false,
        operationId,
      })),
    );
  }
  return requests;
}

function applyAssistantInputs(
  plan: AssistantOperationPlan,
  inputs: Record<string, unknown>,
  errors: string[],
) {
  for (const request of plan.needsInput) {
    if (!Object.hasOwn(inputs, request.id)) {
      continue;
    }
    const value = inputs[request.id];
    if (request.sensitive || request.type === "secure_secret") {
      errors.push(
        `Input "${request.label}" must be entered through a secure Studio form.`,
      );
      continue;
    }
    if (containsForbiddenAssistantData(value)) {
      errors.push(`Input "${request.label}" looks like secret data.`);
      continue;
    }
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      errors.push(`Input "${request.label}" has an invalid value.`);
      continue;
    }
    request.value = value;
    if (request.argumentPath && request.operationId) {
      const operation = plan.operations.find(
        (item) => item.id === request.operationId,
      );
      if (!operation) {
        errors.push(`Input "${request.label}" targets an unknown operation.`);
        continue;
      }
      setJsonPointer(operation.arguments, request.argumentPath, value);
    }
  }
}

function validateDependencies(operations: AssistantOperation[]) {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const operation of operations) {
    if (ids.has(operation.id)) {
      errors.push(`Duplicate operation id "${operation.id}".`);
    }
    ids.add(operation.id);
  }
  for (const operation of operations) {
    for (const dependency of operation.dependsOn) {
      if (!ids.has(dependency)) {
        errors.push(
          `Operation ${operation.id} depends on unknown operation ${dependency}.`,
        );
      }
      if (dependency === operation.id) {
        errors.push(`Operation ${operation.id} cannot depend on itself.`);
      }
    }
  }
  const state = new Map<string, "visiting" | "visited">();
  const byId = new Map(
    operations.map((operation) => [operation.id, operation]),
  );
  const visit = (id: string) => {
    if (state.get(id) === "visiting") {
      errors.push(`Dependency cycle detected at operation ${id}.`);
      return;
    }
    if (state.get(id) === "visited") {
      return;
    }
    state.set(id, "visiting");
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dependency)) {
        visit(dependency);
      }
    }
    state.set(id, "visited");
  };
  for (const operation of operations) {
    visit(operation.id);
  }
  return [...new Set(errors)];
}

function assertPlanScope(
  plan: AssistantOperationPlan,
  scope: AssistantExecutionScope,
) {
  if (
    plan.organizationId !== scope.organizationId ||
    plan.projectId !== scope.projectId ||
    plan.userId !== scope.userId
  ) {
    throw new AssistantPlanError(
      "scope_mismatch",
      "The plan does not belong to the current organization, project and user.",
      403,
    );
  }
}

export function assistantConfirmationForRisk(
  risk: AssistantOperationRisk,
): AssistantPlanConfirmation {
  const policy: AssistantPlanConfirmation["policy"] =
    risk === "read" || risk === "draft"
      ? "none"
      : risk === "write"
        ? "simple"
        : risk === "execute"
          ? "inputs_and_effects"
          : risk === "security"
            ? "reinforced"
            : "explicit";
  return { policy, required: policy !== "none" };
}

function maxRisk(operations: AssistantOperation[]) {
  const order: AssistantOperationRisk[] = [
    "read",
    "draft",
    "write",
    "execute",
    "security",
    "destructive",
  ];
  return operations.reduce<AssistantOperationRisk>(
    (highest, operation) =>
      order.indexOf(operation.risk) > order.indexOf(highest)
        ? operation.risk
        : highest,
    "read",
  );
}

function containsForbiddenAssistantData(value: unknown) {
  if (value === "[redacted]") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(containsForbiddenAssistantData);
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as JsonObject)) {
      if (
        (/(?:secret|token|api[_-]?key|apikey|private[_-]?key|password|authorization|bearer|session|cookie|env(?:ironment)?[_-]?(?:var|vars)?)/i.test(
          key,
        ) &&
          !/(?:id|ids)$/i.test(key)) ||
        containsForbiddenAssistantData(item)
      ) {
        return true;
      }
    }
  }
  return stableJson(redactAssistantPayload(value)) !== stableJson(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function setJsonPointer(
  target: JsonObject,
  pointer: string,
  value: string | number | boolean,
) {
  const parts = pointer
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = target;
  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1) {
      if (Array.isArray(current)) {
        current[Number(part)] = value;
      } else if (current && typeof current === "object") {
        (current as JsonObject)[part] = value;
      }
      return;
    }
    if (Array.isArray(current)) {
      current = current[Number(part)];
    } else if (current && typeof current === "object") {
      current = (current as JsonObject)[part];
    } else {
      return;
    }
  }
}

async function ensureAssistantIdentityScope(
  client: {
    query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      values?: unknown[],
    ): Promise<{ rows: T[]; rowCount: number | null }>;
  },
  scope: { organizationId: string; projectId: string | null },
) {
  const slug = safeSlug(scope.organizationId) || "organization";
  await client.query(
    `
    INSERT INTO identity.organizations (
      id, slug, name, metadata_json, created_at, updated_at
    )
    VALUES ($1, $2, $1, '{"source":"assistant"}'::jsonb, now(), now())
    ON CONFLICT (id) DO NOTHING
    `,
    [scope.organizationId, slug],
  );
  if (!scope.projectId) {
    return;
  }
  const existing = await client.query<{ organization_id: string }>(
    "SELECT organization_id FROM identity.projects WHERE id = $1",
    [scope.projectId],
  );
  if (
    existing.rows[0] &&
    existing.rows[0].organization_id !== scope.organizationId
  ) {
    throw new AssistantPlanError(
      "scope_mismatch",
      "The selected project does not belong to the current organization.",
      403,
    );
  }
  if (!existing.rows[0]) {
    await client.query(
      `
      INSERT INTO identity.projects (
        id, organization_id, slug, name, metadata_json, created_at, updated_at
      )
      VALUES ($1, $2, $3, $1, '{"source":"assistant"}'::jsonb, now(), now())
      `,
      [scope.projectId, scope.organizationId, safeSlug(scope.projectId)],
    );
  }
}

function stableResourceId(prefix: string, planId: string, ref: string) {
  return `${prefix}_${createHash("sha256")
    .update(`${planId}:${ref}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function resolvePatchExpression(
  expression: string,
  refs: ReadonlyMap<string, string>,
) {
  return expression.replace(
    /\$\{steps\.([^.}]+)\.(outputs|artifacts)([.}])/g,
    (match, ref: string, kind: string, suffix: string) =>
      `\${steps.${refs.get(ref) ?? ref}.${kind}${suffix}`,
  );
}

function workflowName(prompt: string) {
  const quoted = prompt.match(/["“«]([^"”»]{2,80})["”»]/)?.[1]?.trim();
  if (quoted) {
    return quoted;
  }
  const normalized = normalizeText(prompt);
  if (
    normalized.includes("s3") &&
    normalized.includes("csv") &&
    normalized.includes("transfer")
  ) {
    return "S3 CSV transfer";
  }
  const afterWorkflow = prompt
    .match(/\bworkflow\s+(?:qui|that|pour|to)?\s*([^.,]{3,72})/i)?.[1]
    ?.trim();
  return afterWorkflow
    ? `Workflow ${afterWorkflow}`.slice(0, 90)
    : "Workflow generated by Studio";
}

function humanizeKey(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function assistantTriggerName(type: string) {
  if (type === "schedule") {
    return "On a schedule";
  }
  if (type === "webhook") {
    return "Webhook HTTP";
  }
  if (type === "date") {
    return "At a specific time";
  }
  if (type === "completion") {
    return "After workflow";
  }
  return "Trigger manually";
}

function safeSlug(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "resource"
  );
}

function escapePointer(value: string) {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function hasInputValue(value: unknown) {
  return value !== undefined && value !== null && value !== "";
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function jsonValue(value: unknown) {
  return value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    Array.isArray(value) ||
    (value && typeof value === "object")
    ? (value as JsonObject | string | number | boolean | null)
    : null;
}

function assistantInputType(
  value: string | undefined,
  sensitive: boolean | undefined,
): AssistantInputRequest["type"] {
  if (sensitive || value === "secure_secret") return "secure_secret";
  if (
    value === "text" ||
    value === "number" ||
    value === "boolean" ||
    value === "select" ||
    value === "credential_reference"
  ) {
    return value;
  }
  return "text";
}

function missingGenericInputs(
  operations: AssistantOperation[],
  existing: AssistantInputRequest[],
) {
  const requests: AssistantInputRequest[] = [];
  const descriptors = new Map(
    genericToolDescriptors().map((descriptor) => [descriptor.name, descriptor]),
  );
  for (const operation of operations) {
    const descriptor = descriptors.get(operation.tool);
    const required = arrayValue(descriptor?.inputSchema.required).map(
      stringValue,
    );
    for (const key of required) {
      if (
        hasInputValue(operation.arguments[key]) ||
        existing.some(
          (request) =>
            request.operationId === operation.id &&
            request.argumentPath === `/${escapePointer(key)}`,
        )
      ) {
        continue;
      }
      if (key === "items" || key === "scopes" || key === "graph") {
        continue;
      }
      const sensitive =
        /secret|token|api[_-]?key|password|headers/i.test(key) &&
        !/(?:id|ids)$/i.test(key);
      requests.push({
        id: `${operation.id}:argument:${key}`,
        label: humanizeKey(key),
        type: sensitive
          ? "secure_secret"
          : /credential|connectionId/i.test(key)
            ? "credential_reference"
            : "text",
        required: true,
        sensitive,
        operationId: operation.id,
        argumentPath: sensitive ? undefined : `/${escapePointer(key)}`,
      });
    }
  }
  return requests;
}

function replaceOperationRefs(
  value: unknown,
  refs: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === "string") {
    return value.replace(
      /\$\{operations\.([^.}]+)\.result\.([^}]+)\}/g,
      (_match, ref: string, path: string) =>
        `\${operations.${refs.get(ref) ?? ref}.result.${path}}`,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceOperationRefs(item, refs));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject).map(([key, item]) => [
        key,
        replaceOperationRefs(item, refs),
      ]),
    );
  }
  return value;
}

function normalizeUniversalOperationArguments(
  tool: string,
  args: JsonObject,
  planId: string,
  operationRef: string,
) {
  if (tool !== "workflow.create") return args;
  const workflow = objectValue(args.workflow);
  const workflowId =
    stringValue(workflow.id) ||
    stableResourceId("wft_ast", planId, operationRef);
  const triggers = arrayValue(workflow.triggers).map((item, index) => {
    const trigger = objectValue(item);
    const type = stringValue(trigger.type) || "manual";
    return {
      ...trigger,
      id:
        stringValue(trigger.id) ||
        stableResourceId("wft", workflowId, `trigger_${index}`),
      type,
      name: stringValue(trigger.name) || assistantTriggerName(type),
      enabled: trigger.enabled !== false,
      config: objectValue(trigger.config),
      state: objectValue(trigger.state),
      canvasX: numberOrNull(trigger.canvasX) ?? 0,
      canvasY: numberOrNull(trigger.canvasY) ?? index * 140,
    };
  });
  const steps = arrayValue(workflow.steps).map((item, index) => {
    const step = objectValue(item);
    return {
      ...step,
      id:
        stringValue(step.id) ||
        stableResourceId("wfs", workflowId, `step_${index}`),
      actionVersionRange: stringValue(step.actionVersionRange) || "*",
      position: index,
      enabled: step.enabled !== false,
      config: objectValue(step.config),
      inputBindings: objectValue(step.inputBindings),
      placement: stringValue(step.placement) || "local-workers",
      executionTarget: step.executionTarget as
        | import("@beam-studio/shared").ActionExecutionTarget
        | undefined,
      executionLocationId: stringValue(step.executionLocationId) || null,
      canvasX: numberOrNull(step.canvasX) ?? 300 + index * 260,
      canvasY: numberOrNull(step.canvasY) ?? 0,
      timeoutSeconds: numberOrNull(step.timeoutSeconds),
      required: step.required !== false,
    };
  });
  const edges = arrayValue(workflow.edges);
  const triggerEdges = arrayValue(workflow.triggerEdges);
  if (!triggers.length && steps.length) {
    triggers.push({
      id: stableResourceId("wft", workflowId, "manual"),
      type: "manual",
      name: "Trigger manually",
      enabled: true,
      config: {},
      state: {},
      canvasX: 0,
      canvasY: 0,
    });
  }
  if (!triggerEdges.length && triggers.length && steps.length) {
    const incoming = new Set(
      edges.map((edge) => stringValue(objectValue(edge).toStepId)),
    );
    for (const step of steps) {
      if (incoming.has(stringValue(step.id))) continue;
      triggerEdges.push({
        id: stableResourceId("wfte", workflowId, stringValue(step.id)),
        triggerId: stringValue(triggers[0]?.id),
        toStepId: stringValue(step.id),
        condition: null,
      });
    }
  }
  return {
    ...args,
    workflow: {
      ...workflow,
      id: workflowId,
      name: stringValue(workflow.name) || "Workflow generated by Studio",
      description: stringValue(workflow.description),
      enabled: workflow.enabled !== false,
      triggers,
      steps,
      edges,
      triggerEdges,
    },
  };
}

function resolveOperationResultReferences(
  value: unknown,
  operations: AssistantOperation[],
): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\$\{operations\.([^.}]+)\.result\.([^}]+)\}$/);
    if (exact) {
      const operation = operations.find((item) => item.id === exact[1]);
      return readObjectPath(operation?.result, exact[2] ?? "");
    }
    return value.replace(
      /\$\{operations\.([^.}]+)\.result\.([^}]+)\}/g,
      (match, operationId: string, path: string) => {
        const operation = operations.find((item) => item.id === operationId);
        const resolved = readObjectPath(operation?.result, path);
        return resolved === undefined ? match : String(resolved);
      },
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      resolveOperationResultReferences(item, operations),
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject).map(([key, item]) => [
        key,
        resolveOperationResultReferences(item, operations),
      ]),
    );
  }
  return value;
}

function readObjectPath(value: unknown, path: string) {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current && typeof current === "object") {
      return (current as JsonObject)[key];
    }
    return undefined;
  }, value);
}

function requiredArg(args: JsonObject, key: string) {
  const value = stringValue(args[key]);
  if (!value) {
    throw new AssistantPlanError(
      "invalid_arguments",
      `arguments.${key} is required.`,
      422,
    );
  }
  return value;
}

function optionalArg(args: JsonObject, key: string) {
  return args[key] === undefined ? undefined : stringValue(args[key]);
}

async function requiredWorkflow(
  id: string,
  organizationId: string,
  projectId: string | null,
) {
  const workflow = await getWorkflowTemplate(id, organizationId, projectId);
  if (!workflow) {
    throw new AssistantPlanError(
      "workflow_not_found",
      "Workflow not found in the current organization and project.",
      404,
    );
  }
  return workflow;
}

function requiredTransfer(
  id: string,
  organizationId: string,
  projectId: string | null,
) {
  const transfer = getTransfer(id, organizationId, projectId);
  if (!transfer) {
    throw new AssistantPlanError(
      "transfer_not_found",
      "Transfer not found in the current organization and project.",
      404,
    );
  }
  return transfer;
}

function endpointKind(value: unknown): "source" | "destination" {
  if (value === "source" || value === "destination") {
    return value;
  }
  throw new AssistantPlanError(
    "invalid_endpoint_kind",
    'Transfer endpoint kind must be "source" or "destination".',
    422,
  );
}

function requiredTransferEndpoint(
  id: string,
  kind: "source" | "destination",
  organizationId: string,
  projectId: string | null,
) {
  for (const transfer of listTransfers({ organizationId, projectId })) {
    const bundle = getTransfer(transfer.id, organizationId, projectId);
    const endpoint = (
      kind === "source" ? bundle?.sources : bundle?.destinations
    )?.find((item) => item.id === id);
    if (endpoint) {
      return {
        endpoint: endpoint as unknown as JsonObject,
        transferId: transfer.id,
      };
    }
  }
  throw new AssistantPlanError(
    "transfer_endpoint_not_found",
    "Transfer endpoint not found in the current organization.",
    404,
  );
}

function requiredSchedule(
  id: string,
  organizationId: string,
  projectId: string | null,
) {
  const schedule = listSchedules({ organizationId }).find(
    (item) => item.id === id,
  );
  if (
    !schedule ||
    !getTransfer(schedule.transferTemplateId, organizationId, projectId)
  ) {
    throw new AssistantPlanError(
      "schedule_not_found",
      "Schedule not found in the current organization and project.",
      404,
    );
  }
  return schedule;
}

function workflowGraphSnapshot(
  workflow: NonNullable<Awaited<ReturnType<typeof getWorkflowTemplate>>>,
) {
  return {
    room: workflow.template.room,
    inputSchema: workflow.template.inputSchema,
    output: workflow.template.output,
    agentBindings: workflow.template.agentBindings,
    resourceBindings: workflow.template.resourceBindings,
    failurePolicy: workflow.template.failurePolicy,
    graphVersion: workflow.template.graphVersion,
    controls: workflow.controls,
    decisions: workflow.decisions,
    decisionEdges: workflow.decisionEdges,
    triggers: workflow.triggers,
    triggerEdges: workflow.triggerEdges,
    steps: workflow.steps,
    edges: workflow.edges,
  };
}

function transferCreateInput(
  args: JsonObject,
  organizationId: string,
  projectId: string | null,
) {
  return {
    organizationId,
    projectId,
    name: requiredArg(args, "name"),
    description: stringValue(args.description),
    apiKeyId: requiredArg(args, "beamConnectionId"),
    customApiKey: null,
    beamServerUrl: stringValue(args.beamServerUrl),
    fileSuffixMode: stringValue(args.fileSuffixMode) || "none",
    notificationWebhookUrl: null,
    slackWebhookUrl: null,
    notifyOnStart: args.notifyOnStart === true,
    notifyOnSuccess: args.notifyOnSuccess === true,
    notifyOnFailure: args.notifyOnFailure !== false,
    notifyOnCancel: args.notifyOnCancel === true,
    enabled: args.enabled !== false,
    frequency: stringValue(args.frequency),
  };
}

function transferUpdateInput(
  args: JsonObject,
  before: JsonObject,
  organizationId: string,
) {
  return {
    id: requiredArg(args, "id"),
    organizationId,
    name: stringValue(args.name) || stringValue(before.name),
    description:
      args.description === undefined
        ? stringValue(before.description)
        : stringValue(args.description),
    apiKeyId:
      stringValue(args.beamConnectionId) || stringValue(before.apiKeyId),
    beamServerUrl:
      args.beamServerUrl === undefined
        ? stringValue(before.beamServerUrl)
        : stringValue(args.beamServerUrl),
    fileSuffixMode:
      stringValue(args.fileSuffixMode) ||
      stringValue(before.fileSuffixMode) ||
      "none",
    notificationWebhookUrl: null,
    slackWebhookUrl: null,
    notifyOnStart:
      typeof args.notifyOnStart === "boolean"
        ? args.notifyOnStart
        : before.notifyOnStart === true,
    notifyOnSuccess:
      typeof args.notifyOnSuccess === "boolean"
        ? args.notifyOnSuccess
        : before.notifyOnSuccess === true,
    notifyOnFailure:
      typeof args.notifyOnFailure === "boolean"
        ? args.notifyOnFailure
        : before.notifyOnFailure === true,
    notifyOnCancel:
      typeof args.notifyOnCancel === "boolean"
        ? args.notifyOnCancel
        : before.notifyOnCancel === true,
    enabled:
      typeof args.enabled === "boolean"
        ? args.enabled
        : before.enabled !== false,
  };
}

function transferEndpointInput(
  args: JsonObject,
  organizationId: string,
  transferTemplateId: string,
) {
  return {
    organizationId,
    transferTemplateId,
    name: requiredArg(args, "name"),
    provider: requiredArg(args, "provider"),
    bucket: requiredArg(args, "bucket"),
    objectKey: requiredArg(args, "objectKey"),
    sourceType:
      args.sourceType === "directory"
        ? ("directory" as const)
        : ("file" as const),
    region: stringValue(args.region),
    endpointUrl: stringValue(args.endpointUrl),
    credentialId: stringValue(args.credentialId),
    filenamePolicy: stringValue(args.filenamePolicy),
    filenameTemplate: stringValue(args.filenameTemplate),
    filenameTimezone: stringValue(args.filenameTimezone),
  };
}

function scheduleInput(args: JsonObject, organizationId: string) {
  return {
    ...(stringValue(args.id) ? { id: stringValue(args.id) } : {}),
    organizationId,
    transferTemplateId: requiredArg(args, "transferTemplateId"),
    frequency: requiredArg(args, "frequency"),
    enabled: args.enabled !== false,
    nextRunAt: stringValue(args.nextRunAt),
    endAt: stringValue(args.endAt),
    timezone: stringValue(args.timezone),
    maxRunDurationSeconds: numericOrString(args.maxRunDurationSeconds),
    creditBudgetLimit: numericOrString(args.creditBudgetLimit),
    maxRuns: numericOrString(args.maxRuns),
    windowStartTime: stringValue(args.windowStartTime),
    windowEndTime: stringValue(args.windowEndTime),
    windowDays: Array.isArray(args.windowDays)
      ? args.windowDays.map(String)
      : stringValue(args.windowDays),
    overlapPolicy: stringValue(args.overlapPolicy),
    budgetAlertThreshold: numericOrString(args.budgetAlertThreshold),
  };
}

function scheduleProjection(args: JsonObject) {
  const frequency = requiredArg(args, "frequency");
  const parsed = parseScheduleFrequency(frequency);
  const projection = projectSchedule({
    frequency,
    nextRunAt: stringValue(args.nextRunAt) || undefined,
    endAt: stringValue(args.endAt) || undefined,
    maxRuns: typeof args.maxRuns === "number" ? args.maxRuns : undefined,
    timezone: stringValue(args.timezone) || "UTC",
    windowStartTime: stringValue(args.windowStartTime) || undefined,
    windowEndTime: stringValue(args.windowEndTime) || undefined,
    windowDays: arrayValue(args.windowDays)
      .map(Number)
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6),
    maxOccurrences: 10,
    horizonDays: 30,
  });
  return {
    valid: Boolean(parsed),
    frequency,
    timezone: stringValue(args.timezone) || "UTC",
    ...projection,
  };
}

function validateWorkflowBundle(
  workflow: Awaited<ReturnType<typeof getWorkflowTemplate>>,
  actions: AssistantActionPackage[],
) {
  if (!workflow) {
    return { valid: false, errors: ["Workflow not found."] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const stepIds = new Set(workflow.steps.map((step) => step.id));
  const triggerIds = new Set(workflow.triggers.map((trigger) => trigger.id));
  const actionNames = new Set(actions.map((action) => action.name));
  if (!workflow.triggers.some((trigger) => trigger.enabled)) {
    errors.push("At least one enabled trigger is required.");
  }
  for (const step of workflow.steps) {
    if (step.kind !== "workflow" && !actionNames.has(step.actionPackageName)) {
      errors.push(
        `Registry action "${step.actionPackageName}" is not installed.`,
      );
    }
    if (!step.enabled && step.required) {
      warnings.push(`Required step "${step.id}" is disabled.`);
    }
  }
  for (const edge of workflow.edges) {
    if (!stepIds.has(edge.fromStepId) || !stepIds.has(edge.toStepId)) {
      errors.push(`Edge "${edge.id}" references a missing step.`);
    }
  }
  for (const edge of workflow.triggerEdges) {
    if (!triggerIds.has(edge.triggerId) || !stepIds.has(edge.toStepId)) {
      errors.push(`Trigger edge "${edge.id}" references a missing node.`);
    }
  }
  return {
    id: workflow.template.id,
    valid: errors.length === 0,
    errors,
    warnings,
    stepCount: workflow.steps.length,
    triggerCount: workflow.triggers.length,
  };
}

function compareRunSnapshots(left: JsonObject, right: JsonObject) {
  const leftStatus = runSnapshotStatus(left);
  const rightStatus = runSnapshotStatus(right);
  const leftEvidence = collectDiagnosticEvidence(left);
  const rightEvidence = collectDiagnosticEvidence(right);
  return {
    left: {
      kind: left.kind,
      status: leftStatus,
      terminal: runSnapshotTerminal(left),
      evidence: leftEvidence.slice(0, 10),
    },
    right: {
      kind: right.kind,
      status: rightStatus,
      terminal: runSnapshotTerminal(right),
      evidence: rightEvidence.slice(0, 10),
    },
    differences: {
      statusChanged: leftStatus !== rightStatus,
      onlyLeft: leftEvidence.filter((item) => !rightEvidence.includes(item)),
      onlyRight: rightEvidence.filter((item) => !leftEvidence.includes(item)),
    },
  };
}

function safeFilename(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workflow"
  );
}

function numericOrString(value: unknown) {
  return typeof value === "number" || typeof value === "string" ? value : null;
}

async function credentialUsage(
  repository: CredentialRepository,
  id: string,
  organizationId: string,
  projectId: string | null,
) {
  const credential = (
    await repository.list(organizationScope(organizationId))
  ).find(
    (item) => item.id === id && (!projectId || item.projectId === projectId),
  );
  if (!credential) {
    throw new AssistantPlanError(
      "credential_not_found",
      "Credential not found in the current organization.",
      404,
    );
  }
  const workflows = await listWorkflowTemplates({
    organizationId,
    projectId,
  });
  const workflowReferences: Array<{ id: string; name: string }> = [];
  for (const summary of workflows) {
    const workflow = await getWorkflowTemplate(
      summary.id,
      organizationId,
      projectId,
    );
    if (
      workflow?.steps.some(
        (step) =>
          deepContainsValue(step.config, id) ||
          deepContainsValue(step.inputBindings, id),
      )
    ) {
      workflowReferences.push({ id: summary.id, name: summary.name });
    }
  }
  const transferReferences = listTransfers({ organizationId, projectId })
    .map((transfer) => getTransfer(transfer.id, organizationId, projectId))
    .filter(
      (transfer) =>
        transfer &&
        [...transfer.sources, ...transfer.destinations].some(
          (endpoint) => endpoint.credentialId === id,
        ),
    )
    .map((transfer) => ({
      id: String(transfer?.transfer.id),
      name: String(transfer?.transfer.name),
    }));
  return {
    id,
    referenceCount: workflowReferences.length + transferReferences.length,
    workflows: workflowReferences,
    transfers: transferReferences,
  };
}

function deepContainsValue(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) {
    return value.some((item) => deepContainsValue(item, expected));
  }
  if (value && typeof value === "object") {
    return Object.values(value as JsonObject).some((item) =>
      deepContainsValue(item, expected),
    );
  }
  return false;
}

async function searchRuns(
  args: JsonObject,
  organizationId: string,
  projectId: string | null,
) {
  const status = stringValue(args.status) || "all";
  const [workflowRuns] = await Promise.all([
    listWorkflowRuns({ organizationId, projectId, status }),
  ]);
  const transferIds = new Set(
    listTransfers({ organizationId, projectId }).map((transfer) => transfer.id),
  );
  return {
    workflowRuns,
    transferRuns: listRuns({ organizationId, status }).filter((run) =>
      transferIds.has(run.transferTemplateId),
    ),
  };
}

async function getAnyRun(
  id: string,
  organizationId: string,
  projectId: string | null,
) {
  const workflow = await getWorkflowRun(id, organizationId, projectId);
  if (workflow) return { kind: "workflow", ...workflow };

  const transfer = getRun(id, organizationId, projectId);
  if (transfer) return { kind: "transfer", run: transfer };
  throw new AssistantPlanError(
    "run_not_found",
    "Run not found in the current organization.",
    404,
  );
}

async function monitorRun(
  args: JsonObject,
  organizationId: string,
  projectId: string | null,
) {
  const id = requiredArg(args, "id");
  const waitSeconds = Math.min(
    50,
    Math.max(0, Number(args.waitSeconds ?? 0) || 0),
  );
  const pollIntervalMs = Math.min(
    5_000,
    Math.max(250, Number(args.pollIntervalMs ?? 1_000) || 1_000),
  );
  const deadline = Date.now() + waitSeconds * 1_000;
  let snapshot = await getAnyRun(id, organizationId, projectId);
  while (!runSnapshotTerminal(snapshot) && Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollIntervalMs, deadline - Date.now())),
    );
    snapshot = await getAnyRun(id, organizationId, projectId);
  }
  return {
    ...snapshot,
    terminal: runSnapshotTerminal(snapshot),
    monitoredUntil: new Date().toISOString(),
    ...(runSnapshotTerminal(snapshot) ? {} : { pollAfterMs: pollIntervalMs }),
  };
}

async function diagnoseRun(
  id: string,
  organizationId: string,
  projectId: string | null,
) {
  const snapshot = await getAnyRun(id, organizationId, projectId);
  const status = runSnapshotStatus(snapshot);
  const evidence = collectDiagnosticEvidence(snapshot).slice(0, 20);
  const normalized = evidence.join(" ").toLowerCase();
  const suggestions = [
    ...(normalized.includes("credential") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden")
      ? [
          "Review the referenced credential in the secure credential form and validate access before retrying.",
        ]
      : []),
    ...(normalized.includes("timeout")
      ? [
          "Preview a larger step or run timeout and verify worker capacity before retrying.",
        ]
      : []),
    ...(normalized.includes("action") &&
    (normalized.includes("missing") || normalized.includes("version"))
      ? [
          "Compare the workflow action version range with the installed Registry package before changing the graph.",
        ]
      : []),
    ...(normalized.includes("bucket") ||
    normalized.includes("object") ||
    normalized.includes("endpoint")
      ? [
          "Validate the scoped storage endpoint, bucket and object path with its credential.",
        ]
      : []),
  ];
  return {
    id,
    kind: snapshot.kind,
    status,
    terminal: runSnapshotTerminal(snapshot),
    summary:
      evidence[0] ??
      (status
        ? `Run status is ${status}; no explicit server error was recorded.`
        : "No explicit server error was recorded."),
    evidence,
    suggestions: suggestions.length
      ? suggestions
      : [
          "Inspect the failed step or item logs and preview any correction before retrying.",
        ],
    href: runHref(snapshot.kind, id),
  };
}

function runSnapshotStatus(snapshot: JsonObject) {
  const run = objectValue(snapshot.run);
  const nestedRun = objectValue(run.run);
  return (
    stringValue(run.status) ||
    stringValue(nestedRun.status) ||
    stringValue(snapshot.status)
  );
}

function runSnapshotTerminal(snapshot: JsonObject) {
  return [
    "completed",
    "failed",
    "cancelled",
    "cancelled_timeout",
    "dead_letter",
    "skipped",
  ].includes(runSnapshotStatus(snapshot));
}

function collectDiagnosticEvidence(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectDiagnosticEvidence(item, `${path}[${index}]`),
    );
  }
  if (!isObject(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, item]) => {
    const nextPath = path ? `${path}.${key}` : key;
    if (
      ["error", "message", "reason", "status"].includes(key.toLowerCase()) &&
      typeof item === "string" &&
      item.trim()
    ) {
      return [`${nextPath}: ${item.trim().slice(0, 500)}`];
    }
    return collectDiagnosticEvidence(item, nextPath);
  });
}

function runHref(kind: unknown, id: string) {
  return kind === "workflow"
    ? `/workflows/runs/${encodeURIComponent(id)}`
    : `/runs/${encodeURIComponent(id)}`;
}

async function cancelAnyRun(
  id: string,
  organizationId: string,
  projectId: string | null,
) {
  if (await getWorkflowRun(id, organizationId, projectId)) {
    await cancelWorkflowRun(id, organizationId);
    return { id, kind: "workflow", cancelRequested: true };
  }
  if (getRun(id, organizationId, projectId)) {
    cancelRun(id, organizationId);
    return { id, kind: "transfer", cancelled: true };
  }
  throw new AssistantPlanError("run_not_found", "Run not found.", 404);
}

async function retryAnyRun(
  id: string,
  organizationId: string,
  projectId: string | null,
) {
  if (await getWorkflowRun(id, organizationId, projectId)) {
    const nextId = await retryWorkflowRun(id, organizationId);
    return { id: nextId, kind: "workflow" };
  }
  if (getRun(id, organizationId, projectId)) {
    const nextId = retryRun(id, organizationId);
    return { id: nextId, kind: "transfer" };
  }
  throw new AssistantPlanError("run_not_found", "Run not found.", 404);
}

function filterNamed<T extends { name?: unknown; id?: unknown }>(
  values: T[],
  query: string,
) {
  if (!query) return values.slice(0, 50);
  return values
    .filter((value) =>
      normalizeText(
        `${stringValue(value.name)} ${stringValue(value.id)}`,
      ).includes(query),
    )
    .slice(0, 50);
}

function safeStudioHref(value: string) {
  return value.startsWith("/") && !value.startsWith("//");
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
