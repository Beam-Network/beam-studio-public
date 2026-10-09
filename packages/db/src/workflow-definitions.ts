import crypto from "node:crypto";
import {managedQualificationInput,assertWorkflowAdmissions} from './workflow-admission.js';
import {
  assertWorkflowActionConfig,
  actionExecutionTargetSchema,
  actionTargetPlacement,
  assertActionExecutionTarget,
  assertWorkflowValue,
  assertComposedWorkflowLimits,
  missingBillingKeyMessage,
  resolveWorkflowBillingKey,
  validateWorkflowContract,
  parseWorkflowReferences,
  resolveWorkflowReferences,
  type WorkflowGraphV2Control,
  type ActionJson,
  type ActionManifest,
  type WorkflowContract,
} from "@beam-studio/core";
import {
  resolveWorkflowRoomContext,
  type WorkflowRoomContext,
} from "@beam-studio/core";
import { pgMany, pgOne, type PgClient } from "./postgres.js";
import { assertWorkflowReferencesAvailablePg } from "./workflow-references.js";
import { captureWorkflowExecutionConfigurationPg } from "./workflow-execution-context.js";
import { workflowBillingOperationKey } from "./workflow-billing.js";
import { WorkflowAuthorizationError } from "./workflow-authorization.js";
import {
  prepareFixtureAdmissionPg,
  referenceFixtureGenerationsPg,
  countFixtureAdmissionPg,
} from "./fixture-campaigns.js";

import {
  actionCatalogSelectSql,
  resolveActionPackageVersionFromRows,
} from "./action-catalog.js";

type Row = Record<string, unknown>;
export type FrozenWorkflowDefinition = {
  revisionId: string;
  workflowTemplateId: string;
  organizationId: string;
  projectId: string | null;
  snapshot: Row & { contract: WorkflowContract };
  resolvedSteps: Row[];
};
export type FrozenWorkflowTree = {
  root: FrozenWorkflowDefinition;
  definitions: Record<string, FrozenWorkflowDefinition>;
};

/** Supplied by the application that owns the private room controller. An
 * absent gate means V3 runs cannot be captured for launch or enqueued. */
export type V3LaunchGate = {
  assertReady(
    client: PgClient,
    definition: FrozenWorkflowDefinition,
  ): Promise<void>;
};

const v3Unavailable =
  "workflow-graph/v3 execution is pending distributed task orchestration; this definition cannot launch yet.";

const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? (value as Row[]) : [];
const identifier = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

/** One statement reads the complete authoring closure at one PostgreSQL snapshot. */
async function readDefinitionClosure(
  client: PgClient,
  organizationId: string,
  rootId: string,
) {
  if (!organizationId.trim())
    throw new Error("Workflow organization scope is required.");
  return pgMany<Row>(
    client,
    `
    WITH RECURSIVE reachable(id) AS (
      SELECT id FROM workflow.templates WHERE id=$1 AND organization_id=$2
      UNION
      SELECT s.called_workflow_id FROM reachable r
      JOIN workflow.steps s ON s.workflow_template_id=r.id
      JOIN workflow.templates t ON t.id=s.called_workflow_id AND t.organization_id=$2
      WHERE s.kind='workflow' AND s.retired_at IS NULL
    )
    SELECT t.*,
      COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.position) FROM workflow.steps s WHERE s.workflow_template_id=t.id AND s.retired_at IS NULL),'[]') AS steps,
      COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM workflow.edges e WHERE e.workflow_template_id=t.id),'[]') AS edges,
      COALESCE((SELECT jsonb_agg(to_jsonb(x)-'state_json'-'updated_at' ORDER BY x.id) FROM workflow.triggers x WHERE x.workflow_template_id=t.id),'[]') AS triggers,
      COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM workflow.trigger_edges e WHERE e.workflow_template_id=t.id),'[]') AS trigger_edges,
      COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id) FROM workflow.decisions d WHERE d.workflow_template_id=t.id),'[]') AS decisions,
      COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM workflow.decision_edges e WHERE e.workflow_template_id=t.id),'[]') AS decision_edges,
      COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM workflow.action_locks l WHERE l.workflow_template_id=t.id),'[]') AS action_locks,
      COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM (${actionCatalogSelectSql}
        WHERE pv.status IN ('active','deprecated')
          AND (p.organization_id IS NULL OR p.organization_id=t.organization_id) AND p.package_name IN
          (SELECT s.action_package_name FROM workflow.steps s WHERE s.workflow_template_id=t.id AND s.retired_at IS NULL)) c),'[]') AS action_catalog
    FROM reachable r JOIN workflow.templates t ON t.id=r.id
    WHERE t.organization_id=$2 ORDER BY t.id`,
    [rootId, organizationId],
  );
}

export async function captureWorkflowTreePg(
  client: PgClient,
  input: {
    organizationId: string;
    workflowTemplateId: string;
    validateOnly?: boolean;
    admission?: boolean;
    v3Launch?: V3LaunchGate;
  },
): Promise<FrozenWorkflowTree> {
  if (input.admission && !input.validateOnly)
    await prepareFixtureAdmissionPg(
      client,
      input.organizationId,
      input.workflowTemplateId,
    );
  const source = await readDefinitionClosure(
    client,
    input.organizationId,
    input.workflowTemplateId,
  );
  assertComposedWorkflowLimits(
    input.workflowTemplateId,
    new Map(
      source.map((definition) => [
        String(definition.id),
        {
          steps: rows(definition.steps).map((step) => ({
            id: String(step.id),
            enabled: step.enabled !== false,
            calledWorkflowId:
              step.kind === "workflow"
                ? String(step.called_workflow_id)
                : undefined,
          })),
          controls:
            definition.graph_version === "workflow-graph/v2" ||
            definition.graph_version === "workflow-graph/v3"
              ? (rows(
                  object(definition.graph_json).controls,
                ) as WorkflowGraphV2Control[])
              : [],
        },
      ]),
    ),
  );
  if (!input.validateOnly)
    for (const definition of source) {
      if (definition.graph_version === "workflow-graph/v3" && !input.v3Launch)
        throw new Error(v3Unavailable);
      if (definition.enabled === false || definition.status === "archived")
        throw new Error(`Workflow ${definition.id} is not runnable.`);
    }
  // Serialize revision-number allocation in a stable order, including concurrent saves.
  for (const row of source)
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `workflow-revision:${row.id}`,
    ]);
  const definitions: Record<string, FrozenWorkflowDefinition> = {};
  for (const template of source) {
    const id = String(template.id);
    const graph = object(template.graph_json);
    const references = parseWorkflowReferences(
      template.agent_bindings_json ?? {},
      template.resource_bindings_json ?? {},
    );
    await assertWorkflowReferencesAvailablePg(
      client,
      references,
      input.organizationId,
      template.project_id ? String(template.project_id) : null,
    );
    const contract = {
      inputSchema: template.input_schema_json,
      output: template.output_contract_json,
    } as WorkflowContract;
    validateWorkflowContract(contract);
    const steps = rows(template.steps);
    const normalized = steps.map((step) => ({
      id: String(step.id),
      kind: String(step.kind),
      calledWorkflowId: step.called_workflow_id,
      name: step.name ?? null,
      position: step.position,
      enabled: step.enabled,
      actionPackage: step.action_package_name,
      versionRange: step.action_version_range,
      config: object(step.config_json),
      inputBindings: object(step.input_bindings_json),
      executionTarget:
        step.kind === "workflow"
          ? undefined
          : actionExecutionTargetSchema.parse(
              step.execution_target_json ?? { kind: "studio" },
            ),
      placement: step.placement,
      executionLocationId: step.execution_location_id,
      timeoutSeconds: step.timeout_seconds,
      required: step.required,
      canvasX: step.canvas_x,
      canvasY: step.canvas_y,
    }));
    const snapshot: FrozenWorkflowDefinition["snapshot"] = {
      workflowTemplate: {
        id,
        organizationId: input.organizationId,
        projectId: template.project_id,
        name: template.name,
        description: template.description,
        config: object(template.config_json),
        apiKeyId: template.api_key_id ?? null,
        createdByUserId: template.created_by_id ?? null,
        timeoutSeconds: template.timeout_seconds ?? null,
        retryPolicy: object(template.retry_policy_json),
        enabled: template.enabled,
        status: template.status,
        createdAt: template.created_at,
        graphVersion: template.graph_version,
        ...references,
        room: template.room_context_json ?? null,
      },
      contract,
      graphVersion: template.graph_version,
      controls: rows(graph.controls),
      ...(template.graph_version === "workflow-graph/v3"
        ? { distribution: object(graph.distribution) }
        : {}),
      edges:
        template.graph_version === "workflow-graph/v2" ||
        template.graph_version === "workflow-graph/v3"
          ? rows(graph.edges)
          : rows(template.edges).map((edge) => ({
              id: edge.id,
              fromStepId: edge.from_step_id,
              toStepId: edge.to_step_id,
              condition: edge.condition_json,
            })),
      steps: normalized,
      triggers: rows(template.triggers).map((row) => ({
        id: row.id,
        type: row.type,
        name: row.name,
        enabled: row.enabled,
        config: row.config_json,
      })),
      triggerEdges: rows(template.trigger_edges).map((row) => ({
        id: row.id,
        triggerId: row.trigger_id,
        toStepId: row.to_step_id,
        condition: row.condition_json,
      })),
      decisions: rows(template.decisions).map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        enabled: row.enabled,
        joinMode: row.join_mode,
        handleFailure: row.handle_failure,
        config: row.config_json,
      })),
      decisionEdges: rows(template.decision_edges).map((row) => ({
        id: row.id,
        fromStepId: row.from_step_id,
        fromDecisionId: row.from_decision_id,
        toStepId: row.to_step_id,
        toDecisionId: row.to_decision_id,
        branch: row.branch,
      })),
    };
    const resolvedSteps: Row[] = [];
    for (const authored of normalized) {
      const step = {
        ...authored,
        config: resolveWorkflowReferences(
          authored.config as ActionJson,
          references,
          "config",
        ) as Record<string, ActionJson>,
        inputBindings: resolveWorkflowReferences(
          authored.inputBindings as ActionJson,
          references,
          "binding",
        ) as Record<string, ActionJson>,
      };
      if (step.kind === "workflow") {
        resolvedSteps.push(step);
        continue;
      }
      const lock = rows(template.action_locks).find(
        (lock) => lock.id === `wfl_${step.id}`,
      );
      const resolved = resolveActionPackageVersionFromRows(
        rows(template.action_catalog),
        String(step.actionPackage),
        String(lock?.resolved_version ?? step.versionRange),
      );
      assertActionExecutionTarget(resolved.manifest, step.executionTarget!);
      assertWorkflowActionConfig(
        resolved.manifest,
        step.config as Record<string, ActionJson>,
        template.room_context_json,
        false,
        step.executionTarget,
        false,
        template.graph_version === "workflow-graph/v3",
      );
      if (lock && String(lock.checksum) !== resolved.manifestChecksum)
        throw new Error(
          `Action checksum changed for ${step.id}. Save a reviewed action lock before running.`,
        );
      if (
        lock?.artifact_checksum &&
        String(lock.artifact_checksum) !== resolved.artifactChecksum
      )
        throw new Error(`Action artifact checksum changed for ${step.id}.`);
      resolvedSteps.push({
        ...step,
        ...resolved,
        resolvedVersion: resolved.version,
        checksum: resolved.manifestChecksum,
        manifestSnapshot: resolved.manifest,
        resolvedPlacement: actionTargetPlacement(step.executionTarget!),
      });
    }
    const revisionId = `wfv_${crypto.createHash("sha256").update(JSON.stringify({ snapshot, resolvedSteps })).digest("hex")}`;
    await client.query(
      `INSERT INTO workflow.plan_versions(id,organization_id,project_id,workflow_template_id,version,compiled_plan_json,manifest_snapshot_json)
      SELECT $1,$2,$3,$4,COALESCE(MAX(version),0)+1,$5::jsonb,$6::jsonb FROM workflow.plan_versions WHERE workflow_template_id=$4
      ON CONFLICT(id) DO NOTHING`,
      [
        revisionId,
        input.organizationId,
        template.project_id,
        id,
        JSON.stringify(snapshot),
        JSON.stringify(resolvedSteps),
      ],
    );
    definitions[id] = {
      revisionId,
      organizationId: input.organizationId,
      projectId: template.project_id ? String(template.project_id) : null,
      workflowTemplateId: id,
      snapshot,
      resolvedSteps,
    };
  }
  const validateRooms = (id: string, inherited: WorkflowRoomContext | null) => {
    const definition = definitions[id]!;
    const effective = resolveWorkflowRoomContext(
      inherited,
      object(definition.snapshot.workflowTemplate).room,
      `Workflow ${id}`,
    );
    for (const step of definition.resolvedSteps) {
      if (step.kind === "workflow")
        validateRooms(String(step.calledWorkflowId), effective);
      else
        assertWorkflowActionConfig(
          step.manifestSnapshot as ActionManifest,
          object(step.config) as Record<string, ActionJson>,
          effective,
          !input.validateOnly,
          step.executionTarget as import("@beam-studio/core").ActionExecutionTarget,
          definition.snapshot.graphVersion === "workflow-graph/v3",
          definition.snapshot.graphVersion === "workflow-graph/v3",
        );
    }
  };
  validateRooms(input.workflowTemplateId, null);
  if (!input.validateOnly)
    for (const definition of Object.values(definitions))
      if (definition.snapshot.graphVersion === "workflow-graph/v3")
        await input.v3Launch!.assertReady(client, definition);
  return { root: definitions[input.workflowTemplateId]!, definitions };
}

export async function enqueueFrozenWorkflowRunPg(
  client: PgClient,
  input: {
    definition: FrozenWorkflowDefinition;
    definitions: Record<string, FrozenWorkflowDefinition>;
    runtimeInput: unknown;
    runId?: string;
    parentRunId?: string | null;
    rootRunId?: string | null;
    invokingStepRunId?: string | null;
    invocationAttempt?: number;
    trigger: string;
    triggerId?: string | null;
    triggerEvent?: Row;
    executionContext?: Row;
    metadata?: Row;
    v3Launch?: V3LaunchGate;
  },
) {
  const definition = input.definition;
  const id = input.runId ?? identifier("wfr");
  const creditOperationKey = input.parentRunId
    ? null
    : workflowBillingOperationKey(id, 1);
  // A child run is charged to its parent's key. A root run uses the key
  // selected in Workflow Settings or, without one, its Beam Transfer steps'.
  const rootKey = input.parentRunId
    ? null
    : resolveWorkflowBillingKey(
        object(definition.snapshot.workflowTemplate).apiKeyId,
        definition.resolvedSteps,
      );
  const billing = input.parentRunId
    ? object(input.executionContext?.billing)
    : { apiKeyId: rootKey?.apiKeyId ?? null, creditOperationKey };
  if (typeof billing.apiKeyId !== "string" || !billing.apiKeyId.trim())
    throw new WorkflowAuthorizationError(
      "execution_credential_missing",
      rootKey && rootKey.apiKeyId === null
        ? missingBillingKeyMessage(rootKey.reason)
        : "The parent run has no Beam API key to charge this run to.",
    );
  for (const candidate of Object.values(input.definitions))
    if (candidate.snapshot.graphVersion === "workflow-graph/v3") {
      if (!input.v3Launch) throw new Error(v3Unavailable);
      await input.v3Launch.assertReady(client, candidate);
    }
  const configuration = input.parentRunId
    ? {
        environment: input.executionContext?.environment,
        beam: input.executionContext?.beam,
      }
    : await captureWorkflowExecutionConfigurationPg(client, {
        organizationId: definition.organizationId,
        projectIds: [
          ...new Set(
            Object.values(input.definitions).flatMap((definition) =>
              definition.projectId ? [definition.projectId] : [],
            ),
          ),
        ],
        billingCredentialId: billing.apiKeyId,
      });
  const qualificationInput = await managedQualificationInput({workflowId:definition.workflowTemplateId,
    organizationId:definition.organizationId,credentialId:billing.apiKeyId,
    environment:typeof configuration.environment==='string'?configuration.environment:undefined});
  if(!input.parentRunId&&!Object.keys(qualificationInput).length)
    await assertWorkflowAdmissions(configuration.environment,Object.values(input.definitions).flatMap(d=>d.resolvedSteps));
  const runtimeInput = {...object(input.runtimeInput),...qualificationInput};
  const effectiveRoom = resolveWorkflowRoomContext(
    input.executionContext?.room,
    object(definition.snapshot.workflowTemplate).room,
  );
  const resolvedSteps = definition.resolvedSteps.map((step) => {
    if (step.kind === "workflow") return step;
    const resolved = assertWorkflowActionConfig(
      step.manifestSnapshot as ActionManifest,
      object(step.config) as Record<string, ActionJson>,
      effectiveRoom,
      true,
      step.executionTarget as import("@beam-studio/core").ActionExecutionTarget,
      definition.snapshot.graphVersion === "workflow-graph/v3",
      definition.snapshot.graphVersion === "workflow-graph/v3",
    );
    return { ...step, config: resolved.config, executionRoom: resolved.room };
  });
  assertWorkflowValue(
    definition.snapshot.contract.inputSchema,
    Object.keys(qualificationInput).length ? runtimeInput : input.runtimeInput,
    "Workflow input",
  );
  const inserted = await client.query<Row>(
    `INSERT INTO execution.workflow_runs (
      id,organization_id,project_id,workflow_template_id,workflow_plan_version_id,status,
      trigger,trigger_id,trigger_type,trigger_event_json,template_snapshot_json,resolved_steps_json,input_json,
      output_json,metadata_json,execution_context_json,parent_run_id,root_run_id,invoking_step_run_id,invocation_attempt,
      credit_operation_key,queued_at,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'queued',$6,$7,$6,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,'null'::jsonb,
      $12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,now(),now(),now())
    ON CONFLICT(invoking_step_run_id,invocation_attempt) WHERE invoking_step_run_id IS NOT NULL DO NOTHING RETURNING id`,
    [
      id,
      definition.organizationId,
      definition.projectId,
      definition.workflowTemplateId,
      definition.revisionId,
      input.trigger,
      input.triggerId ?? null,
      JSON.stringify(input.triggerEvent ?? {}),
      JSON.stringify({
        ...definition.snapshot,
        dependencies: input.definitions,
      }),
      JSON.stringify(resolvedSteps),
      JSON.stringify(Object.keys(qualificationInput).length ? runtimeInput : input.runtimeInput),
      JSON.stringify({
        ...input.metadata,
        observability: {
          ...object(input.metadata?.observability),
          correlationId: id,
        },
      }),
      JSON.stringify({
        ...input.executionContext,
        ...configuration,
        organizationId: definition.organizationId,
        projectId: definition.projectId,
        billing,
        trigger: input.trigger,
        triggerId: input.triggerId ?? null,
        room: effectiveRoom,
      }),
      input.parentRunId ?? null,
      input.rootRunId ?? id,
      input.invokingStepRunId ?? null,
      input.invocationAttempt ?? null,
      creditOperationKey,
    ],
  );
  const actualId =
    inserted.rows[0]?.id ??
    (
      await pgOne<Row>(
        client,
        "SELECT id FROM execution.workflow_runs WHERE invoking_step_run_id=$1 AND invocation_attempt=$2",
        [input.invokingStepRunId, input.invocationAttempt],
      )
    )?.id;
  if (!actualId)
    throw new Error("Workflow invocation did not create or recover a run.");
  if (inserted.rows.length) {
    await referenceFixtureGenerationsPg(client, String(actualId), {
      definitions: input.definitions,
      runtimeInput: input.runtimeInput,
      resolvedSteps,
    });
    if (!input.parentRunId)
      await countFixtureAdmissionPg(
        client,
        String(actualId),
        definition.workflowTemplateId,
      );
    await client.query(
      "INSERT INTO execution.workflow_run_capabilities(workflow_run_id,authorization_token) VALUES($1,$2)",
      [actualId, crypto.randomBytes(32).toString("base64url")],
    );
    await client.query(
      `INSERT INTO execution.workflow_events (
      id,organization_id,workflow_template_id,workflow_run_id,workflow_step_run_id,workflow_task_id,
      event_type,event_version,subject_type,subject_id,correlation_id,payload_json,created_at)
      VALUES($1,$2,$3,$4,NULL,NULL,'WorkflowRunQueued',1,'workflow_run',$4,$4,$5::jsonb,now())`,
      [
        identifier("wfe"),
        definition.organizationId,
        definition.workflowTemplateId,
        actualId,
        JSON.stringify({
          trigger: input.trigger,
          parentRunId: input.parentRunId ?? null,
        }),
      ],
    );
  }
  await client.query(
    `INSERT INTO execution.command_outbox(id,command_type,aggregate_type,aggregate_id,transport,payload_json,state,available_at,created_at,updated_at)
    VALUES($1,'workflow_run.queued','workflow_run',$2,'postgres',$3::jsonb,'pending',now(),now(),now())
    ON CONFLICT(command_type,aggregate_id) DO NOTHING`,
    [identifier("cmd"), actualId, JSON.stringify({ workflowRunId: actualId })],
  );
  return String(actualId);
}
