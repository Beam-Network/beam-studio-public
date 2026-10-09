ALTER TABLE IF EXISTS execution.workflow_step_runs
  DROP CONSTRAINT IF EXISTS execution_workflow_step_runs_status_check;

ALTER TABLE IF EXISTS execution.workflow_step_runs
  ADD CONSTRAINT execution_workflow_step_runs_status_check CHECK (
    status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'skipped', 'not_reached')
  );

ALTER TABLE IF EXISTS workflow_step_runs
  DROP CONSTRAINT IF EXISTS workflow_step_runs_status_check;

ALTER TABLE IF EXISTS workflow_step_runs
  ADD CONSTRAINT workflow_step_runs_status_check CHECK (
    status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'skipped', 'not_reached')
  );
