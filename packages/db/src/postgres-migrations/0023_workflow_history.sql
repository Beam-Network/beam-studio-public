ALTER TABLE workflow.templates ADD COLUMN IF NOT EXISTS migration_source_json jsonb;
ALTER TABLE execution.workflow_runs
  ADD COLUMN IF NOT EXISTS historical boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS historical_snapshot_json jsonb;
ALTER TABLE execution.workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_output_validation_check;
ALTER TABLE execution.workflow_runs ADD CONSTRAINT workflow_runs_output_validation_check
  CHECK (output_validation IN ('unvalidated','valid','invalid','historical'));

CREATE OR REPLACE FUNCTION execution.protect_workflow_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.workflow_plan_version_id IS NOT NULL OR OLD.historical) AND (
       NEW.historical IS DISTINCT FROM OLD.historical
    OR NEW.historical_snapshot_json IS DISTINCT FROM OLD.historical_snapshot_json
    OR NEW.template_snapshot_json IS DISTINCT FROM OLD.template_snapshot_json
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
