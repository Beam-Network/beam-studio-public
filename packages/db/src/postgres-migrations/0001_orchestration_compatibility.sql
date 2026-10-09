ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS template_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS resolved_steps_json jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE workflow_tasks
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_by text,
  ADD COLUMN IF NOT EXISTS lock_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS output_checksum text,
  ADD COLUMN IF NOT EXISTS idempotency_key text;

UPDATE workflow_tasks
SET attempts = attempt_count
WHERE attempts = 0 AND attempt_count > 0;

UPDATE workflow_tasks
SET locked_by = leased_by
WHERE locked_by IS NULL AND leased_by IS NOT NULL;

UPDATE workflow_tasks
SET lock_expires_at = lease_expires_at
WHERE lock_expires_at IS NULL AND lease_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pg_workflow_tasks_lock_expires
  ON workflow_tasks(lock_expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_workflow_tasks_legacy_idempotency
  ON workflow_tasks(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE execution_plans
  ADD COLUMN IF NOT EXISTS workflow_step_run_id text,
  ADD COLUMN IF NOT EXISTS workflow_step_id text,
  ADD COLUMN IF NOT EXISTS mode text,
  ADD COLUMN IF NOT EXISTS shard_count integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE worker_runtime_state
  ADD COLUMN IF NOT EXISTS capabilities_json jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_pg_execution_plans_step_run
  ON execution_plans(workflow_step_run_id);
