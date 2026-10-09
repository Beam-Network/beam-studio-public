-- Additive foundation; the Job cutover has its own drain/integrity gate.
ALTER TABLE workflow.templates
  ADD COLUMN IF NOT EXISTS input_schema_json jsonb NOT NULL DEFAULT '{"type":"object","additionalProperties":true}'::jsonb,
  ADD COLUMN IF NOT EXISTS output_contract_json jsonb NOT NULL DEFAULT '{"schema":{"type":"object","additionalProperties":false},"bindings":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS agent_bindings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS resource_bindings_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE workflow.steps
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'action' CHECK (kind IN ('action','workflow')),
  ADD COLUMN IF NOT EXISTS called_workflow_id text REFERENCES workflow.templates(id) ON DELETE RESTRICT;
ALTER TABLE workflow.steps ALTER COLUMN action_package_name DROP NOT NULL;

ALTER TABLE execution.workflow_runs
  ADD COLUMN IF NOT EXISTS parent_run_id text REFERENCES execution.workflow_runs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS root_run_id text REFERENCES execution.workflow_runs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS invoking_step_run_id text,
  ADD COLUMN IF NOT EXISTS invocation_attempt integer CHECK (invocation_attempt > 0),
  ADD COLUMN IF NOT EXISTS execution_context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS output_validation text NOT NULL DEFAULT 'unvalidated'
    CHECK (output_validation IN ('unvalidated','valid','invalid'));
CREATE UNIQUE INDEX IF NOT EXISTS workflow_child_invocation_unique
  ON execution.workflow_runs(invoking_step_run_id,invocation_attempt)
  WHERE invoking_step_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workflow_runs_parent ON execution.workflow_runs(parent_run_id);
CREATE INDEX IF NOT EXISTS workflow_runs_root ON execution.workflow_runs(root_run_id);

ALTER TABLE execution.workflow_step_runs
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'action' CHECK (kind IN ('action','workflow')),
  ADD COLUMN IF NOT EXISTS child_run_id text REFERENCES execution.workflow_runs(id) ON DELETE RESTRICT;
ALTER TABLE execution.workflow_step_runs ALTER COLUMN action_package_name DROP NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workflow_invoking_step_fk' AND conrelid='execution.workflow_runs'::regclass) THEN
    ALTER TABLE execution.workflow_runs ADD CONSTRAINT workflow_invoking_step_fk
      FOREIGN KEY(invoking_step_run_id) REFERENCES execution.workflow_step_runs(id)
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION workflow.protect_plan_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.compiled_plan_json IS DISTINCT FROM OLD.compiled_plan_json
     OR NEW.manifest_snapshot_json IS DISTINCT FROM OLD.manifest_snapshot_json
     OR NEW.workflow_template_id IS DISTINCT FROM OLD.workflow_template_id
     OR NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'Workflow definition revisions are immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS immutable_workflow_revision ON workflow.plan_versions;
CREATE TRIGGER immutable_workflow_revision BEFORE UPDATE ON workflow.plan_versions
  FOR EACH ROW EXECUTE FUNCTION workflow.protect_plan_revision();

CREATE OR REPLACE FUNCTION execution.protect_workflow_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.workflow_plan_version_id IS NOT NULL AND (
       NEW.template_snapshot_json IS DISTINCT FROM OLD.template_snapshot_json
    OR NEW.resolved_steps_json IS DISTINCT FROM OLD.resolved_steps_json
    OR NEW.input_json IS DISTINCT FROM OLD.input_json
    OR NEW.execution_context_json IS DISTINCT FROM OLD.execution_context_json
    OR NEW.workflow_plan_version_id IS DISTINCT FROM OLD.workflow_plan_version_id
    OR NEW.parent_run_id IS DISTINCT FROM OLD.parent_run_id
    OR NEW.root_run_id IS DISTINCT FROM OLD.root_run_id
    OR NEW.invoking_step_run_id IS DISTINCT FROM OLD.invoking_step_run_id
    OR NEW.invocation_attempt IS DISTINCT FROM OLD.invocation_attempt) THEN
    RAISE EXCEPTION 'Workflow run snapshots and invocation identities are immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS immutable_workflow_run ON execution.workflow_runs;
CREATE TRIGGER immutable_workflow_run BEFORE UPDATE ON execution.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION execution.protect_workflow_snapshot();
