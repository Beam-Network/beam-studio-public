CREATE SCHEMA job;
-- Jobs deliberately live beside workflows: a job composes workflows but is not
-- itself executable by the workflow engine.  Its coordinator creates normal
-- workflow runs from this frozen composition.
CREATE TABLE IF NOT EXISTS job.definitions (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  project_id text REFERENCES identity.projects(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text,
  strategy text NOT NULL DEFAULT 'parallel',
  failure_policy text NOT NULL DEFAULT 'stop_on_failure',
  enabled boolean NOT NULL DEFAULT true,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_definitions_strategy_check CHECK (strategy IN ('parallel', 'sequential', 'custom')),
  CONSTRAINT job_definitions_failure_policy_check CHECK (failure_policy IN ('stop_on_failure', 'continue_on_failure'))
);

ALTER TABLE job.definitions
  DROP CONSTRAINT IF EXISTS job_definitions_strategy_check;
ALTER TABLE job.definitions
  ADD CONSTRAINT job_definitions_strategy_check
  CHECK (strategy IN ('parallel', 'sequential', 'custom'));

CREATE TABLE IF NOT EXISTS job.items (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES job.definitions(id) ON DELETE CASCADE,
  workflow_template_id text NOT NULL REFERENCES workflow.templates(id) ON DELETE RESTRICT,
  position integer NOT NULL,
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_items_position_check CHECK (position >= 0),
  CONSTRAINT job_items_unique_position UNIQUE (job_id, position)
);

CREATE TABLE IF NOT EXISTS job.triggers (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES job.definitions(id) ON DELETE CASCADE,
  type text NOT NULL,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_triggers_type_check CHECK (type IN ('manual', 'schedule'))
);

CREATE TABLE IF NOT EXISTS execution.job_runs (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  job_id text NOT NULL REFERENCES job.definitions(id) ON DELETE RESTRICT,
  status text NOT NULL,
  strategy text NOT NULL,
  failure_policy text NOT NULL,
  trigger text NOT NULL DEFAULT 'manual',
  trigger_id text REFERENCES job.triggers(id) ON DELETE SET NULL,
  trigger_event_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  composition_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  queued_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_job_runs_status_check CHECK (status IN ('queued', 'running', 'cancel_requested', 'completed', 'failed', 'cancelled')),
  CONSTRAINT execution_job_runs_strategy_check CHECK (strategy IN ('parallel', 'sequential', 'custom')),
  CONSTRAINT execution_job_runs_failure_policy_check CHECK (failure_policy IN ('stop_on_failure', 'continue_on_failure'))
);

ALTER TABLE execution.job_runs
  DROP CONSTRAINT IF EXISTS execution_job_runs_strategy_check;
ALTER TABLE execution.job_runs
  ADD CONSTRAINT execution_job_runs_strategy_check
  CHECK (strategy IN ('parallel', 'sequential', 'custom'));

CREATE TABLE IF NOT EXISTS execution.job_run_items (
  id text PRIMARY KEY,
  job_run_id text NOT NULL REFERENCES execution.job_runs(id) ON DELETE CASCADE,
  job_item_id text NOT NULL REFERENCES job.items(id) ON DELETE RESTRICT,
  workflow_template_id text NOT NULL REFERENCES workflow.templates(id) ON DELETE RESTRICT,
  position integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  workflow_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  workflow_run_id text UNIQUE,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_job_run_items_status_check CHECK (status IN ('pending', 'queued', 'running', 'completed', 'failed', 'cancelled', 'skipped')),
  CONSTRAINT execution_job_run_items_unique UNIQUE (job_run_id, job_item_id)
);


ALTER TABLE job.definitions ADD COLUMN api_key_id text;
ALTER TABLE execution.job_runs ADD COLUMN credit_operation_key text, ADD COLUMN credit_settled_at timestamptz;
ALTER TABLE execution.workflow_runs
  ADD COLUMN job_run_id text REFERENCES execution.job_runs(id) ON DELETE SET NULL,
  ADD COLUMN job_item_id text REFERENCES execution.job_run_items(id) ON DELETE SET NULL;
