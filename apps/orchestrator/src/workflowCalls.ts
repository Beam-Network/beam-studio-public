import crypto from "node:crypto";
import {
  type ActionJson,
  materializeWorkflowOutput,
  type WorkflowContract,
} from "@beam-studio/core";
import {
  enqueueFrozenWorkflowRunPg,
  authorizeWorkflowExecutionPg,
  type WorkflowExecutionAuthorizer,
  pgMany,
  pgOne,
  type FrozenWorkflowDefinition,
  type PgClient,
} from "@beam-studio/db";
import type { ApiWorkflowStep, Row } from "./types.js";

const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
const id = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

export async function createWorkflowCallPg(
  client: PgClient,
  input: {
    workflowRunId: string;
    organizationId: string;
    step: ApiWorkflowStep;
    inputs: Record<string, ActionJson>;
    dynamicInstanceId: string | null;
    authorizeExecution?: WorkflowExecutionAuthorizer;
  },
) {
  const parent = await pgOne<Row>(
    client,
    "SELECT * FROM execution.workflow_runs WHERE id=$1 AND organization_id=$2 FOR UPDATE",
    [input.workflowRunId, input.organizationId],
  );
  if (!parent || parent.status !== "running") return;
  const snapshot = object(parent.template_snapshot_json);
  const definitions = object(snapshot.dependencies) as Record<
    string,
    FrozenWorkflowDefinition
  >;
  const definition = definitions[input.step.calledWorkflowId ?? ""];
  if (!definition || definition.organizationId !== input.organizationId)
    throw new Error(
      "Child workflow is absent from the frozen dependency snapshot.",
    );
  const stepId = id("wsr");
  await client.query(
    `INSERT INTO execution.workflow_step_runs (
    id,workflow_run_id,workflow_step_id,dynamic_instance_id,kind,action_package_name,resolved_version,checksum,
    source_registry,resolved_placement,status,attempt,input_json,output_json,metadata_json,state_json,started_at,created_at,updated_at)
    VALUES($1,$2,$3,$4,'workflow',NULL,$5,$5,'workflow','dispatcher','queued',1,$6::jsonb,'null'::jsonb,'{}','{}',now(),now(),now())
    ON CONFLICT DO NOTHING`,
    [
      stepId,
      input.workflowRunId,
      input.step.id,
      input.dynamicInstanceId,
      definition.revisionId,
      JSON.stringify(input.inputs),
    ],
  );
  const stepRun = await pgOne<Row>(
    client,
    `SELECT * FROM execution.workflow_step_runs
    WHERE workflow_run_id=$1 AND workflow_step_id=$2 AND dynamic_instance_id IS NOT DISTINCT FROM $3
    ORDER BY attempt DESC LIMIT 1 FOR UPDATE`,
    [input.workflowRunId, input.step.id, input.dynamicInstanceId],
  );
  if (
    !stepRun ||
    stepRun.child_run_id ||
    !["queued", "running"].includes(String(stepRun.status))
  )
    return;
  try {
    await (input.authorizeExecution ?? authorizeWorkflowExecutionPg)(client, {
      workflowRunId: input.workflowRunId,
      stepId: input.step.id,
      phase: "child_launch",
    });
    const childId = await enqueueFrozenWorkflowRunPg(client, {
      definition,
      definitions,
      runtimeInput: input.inputs,
      parentRunId: input.workflowRunId,
      rootRunId: String(parent.root_run_id ?? input.workflowRunId),
      invokingStepRunId: String(stepRun.id),
      invocationAttempt: Number(stepRun.attempt),
      trigger: "workflow",
      executionContext: {
        ...object(parent.execution_context_json),
        parentRunId: input.workflowRunId,
      },
      metadata: { invokingStepId: input.step.id },
    });
    await client.query(
      `UPDATE execution.workflow_step_runs SET child_run_id=$2,status='running',started_at=now(),updated_at=now(),
      metadata_json=jsonb_build_object('invocation',jsonb_build_object('runId',$2::text,'status','queued')) WHERE id=$1`,
      [stepRun.id, childId],
    );
  } catch (error) {
    // Contract errors are an invocation outcome; PostgreSQL errors must abort the transaction.
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "workflow_contract_invalid"
    )
      throw error;
    await client.query(
      `UPDATE execution.workflow_step_runs SET status='failed',error=$2,completed_at=now(),updated_at=now() WHERE id=$1`,
      [stepRun.id, error.message],
    );
  }
}

export async function reconcileWorkflowCallsPg(
  client: PgClient,
  workflowRunId: string,
  steps: ApiWorkflowStep[],
  authorizeExecution?: WorkflowExecutionAuthorizer,
) {
  const queued = await pgMany<Row>(
    client,
    "SELECT * FROM execution.workflow_step_runs WHERE workflow_run_id=$1 AND kind='workflow' AND status='queued' AND child_run_id IS NULL",
    [workflowRunId],
  );
  for (const call of queued) {
    const step = steps.find((step) => step.id === call.workflow_step_id);
    const owner = await pgOne<Row>(
      client,
      "SELECT organization_id FROM execution.workflow_runs WHERE id=$1",
      [workflowRunId],
    );
    if (step && owner)
      await createWorkflowCallPg(client, {
        workflowRunId,
        organizationId: String(owner.organization_id),
        step,
        inputs: call.input_json as Record<string, ActionJson>,
        dynamicInstanceId: call.dynamic_instance_id
          ? String(call.dynamic_instance_id)
          : null,
        authorizeExecution,
      });
  }
  const calls = await pgMany<Row>(
    client,
    `SELECT s.*,c.status AS child_status,c.error AS child_error,c.output_json AS child_output,c.output_validation
    FROM execution.workflow_step_runs s JOIN execution.workflow_runs c ON c.id=s.child_run_id
    WHERE s.workflow_run_id=$1 AND s.kind='workflow' AND s.status IN ('queued','running') FOR UPDATE OF s`,
    [workflowRunId],
  );
  for (const call of calls) {
    const step = steps.find((step) => step.id === call.workflow_step_id);
    if (
      ["queued", "running"].includes(String(call.child_status)) &&
      step?.timeoutSeconds &&
      call.started_at &&
      Date.now() - new Date(String(call.started_at)).getTime() >=
        step.timeoutSeconds * 1000
    ) {
      await client.query(
        `UPDATE execution.workflow_runs SET status='cancel_requested',error='workflow call timeout',updated_at=now()
        WHERE id=$1 AND status IN ('queued','running')`,
        [call.child_run_id],
      );
      await client.query(
        `UPDATE execution.workflow_step_runs SET metadata_json=metadata_json || '{"callTimedOut":true}'::jsonb WHERE id=$1`,
        [call.id],
      );
    }
    if (
      !["completed", "failed", "cancelled"].includes(String(call.child_status))
    )
      continue;
    const invalidOutput =
      call.child_status === "completed" && call.output_validation !== "valid";
    const timedOut = object(call.metadata_json).callTimedOut === true;
    const status =
      invalidOutput || timedOut ? "failed" : String(call.child_status);
    const error = invalidOutput
      ? "Child workflow output was not contract-validated."
      : timedOut
        ? "workflow call timeout"
        : call.child_error;
    await client.query(
      `UPDATE execution.workflow_step_runs SET status=$2,output_json=$3::jsonb,error=$4,completed_at=now(),updated_at=now(),
      metadata_json=metadata_json || jsonb_build_object('invocation',jsonb_build_object('runId',child_run_id,'status',$2::text,'error',$4::text)) WHERE id=$1`,
      [
        call.id,
        status,
        JSON.stringify(status === "completed" ? call.child_output : null),
        error ?? null,
      ],
    );
  }
}

export async function requestChildCancellationsPg(
  client: PgClient,
  parentRunId: string,
  reason: string,
  preservedStepIds: string[] = [],
) {
  await client.query(
    `WITH RECURSIVE descendants(id) AS (
    SELECT r.id FROM execution.workflow_runs r JOIN execution.workflow_step_runs s ON s.id=r.invoking_step_run_id
      WHERE r.parent_run_id=$1 AND NOT (s.workflow_step_id=ANY($3::text[]))
    UNION ALL SELECT r.id FROM execution.workflow_runs r JOIN descendants d ON r.parent_run_id=d.id
  ) UPDATE execution.workflow_runs SET status='cancel_requested',error=COALESCE(error,$2),updated_at=now()
    WHERE id IN (SELECT id FROM descendants) AND status IN ('queued','running')`,
    [parentRunId, reason, preservedStepIds],
  );
}

export async function resolveRunOutputPg(
  client: PgClient,
  workflowRunId: string,
): Promise<ActionJson> {
  const run = await pgOne<Row>(
    client,
    "SELECT template_snapshot_json,input_json FROM execution.workflow_runs WHERE id=$1",
    [workflowRunId],
  );
  if (!run) throw new Error("Workflow run not found.");
  const contract = object(run.template_snapshot_json).contract as
    | WorkflowContract
    | undefined;
  if (!contract)
    throw new Error(
      "Workflow run has no frozen output contract; migrate it before execution.",
    );
  const steps = await pgMany<Row>(
    client,
    "SELECT * FROM execution.workflow_step_runs WHERE workflow_run_id=$1 AND dynamic_instance_id IS NULL ORDER BY attempt",
    [workflowRunId],
  );
  const publicResults = new Map(
    steps.map((step) => [
      String(step.workflow_step_id),
      {
        status: String(step.status),
        output: step.output_json as ActionJson,
        error: step.error ? String(step.error) : null,
        runId: step.child_run_id ? String(step.child_run_id) : null,
      },
    ]),
  );
  const controls = await pgMany<Row>(
    client,
    "SELECT control_id,status,output_json,error,definition_json FROM execution.workflow_dynamic_regions WHERE workflow_run_id=$1",
    [workflowRunId],
  );
  for (const control of controls) {
    const value = {
      status: String(control.status),
      output: control.output_json as ActionJson,
      error: control.error ? String(control.error) : null,
      runId: null,
    };
    publicResults.set(String(control.control_id), value);
    const definition = object(control.definition_json);
    if (definition.kind === "fan-out" && definition.fanInId)
      publicResults.set(String(definition.fanInId), value);
  }
  return materializeWorkflowOutput(contract.output, {
    input: run.input_json as ActionJson,
    steps: publicResults,
  });
}
