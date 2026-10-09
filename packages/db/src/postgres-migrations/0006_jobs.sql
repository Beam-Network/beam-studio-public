-- Compatibility migration for the legacy unqualified PostgreSQL schema.
-- The production Studio target schema uses the namespaced equivalent.
CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  strategy text NOT NULL DEFAULT 'parallel' CHECK (strategy IN ('parallel', 'sequential', 'custom')),
  failure_policy text NOT NULL DEFAULT 'stop_on_failure' CHECK (failure_policy IN ('stop_on_failure', 'continue_on_failure')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS job_items (
  id text PRIMARY KEY, job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  workflow_template_id text NOT NULL REFERENCES workflow_templates(id) ON DELETE RESTRICT,
  position integer NOT NULL CHECK (position >= 0), input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, position)
);
CREATE TABLE IF NOT EXISTS job_triggers (
  id text PRIMARY KEY, job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('manual', 'schedule')), name text NOT NULL, enabled boolean NOT NULL DEFAULT true,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb, state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS job_runs (
  id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT, status text NOT NULL,
  strategy text NOT NULL, failure_policy text NOT NULL, trigger text NOT NULL DEFAULT 'manual', trigger_id text REFERENCES job_triggers(id) ON DELETE SET NULL,
  trigger_event_json jsonb NOT NULL DEFAULT '{}'::jsonb, composition_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text, queued_at timestamptz, started_at timestamptz, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('queued','running','cancel_requested','completed','failed','cancelled'))
);
CREATE TABLE IF NOT EXISTS job_run_items (
  id text PRIMARY KEY, job_run_id text NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
  job_item_id text NOT NULL REFERENCES job_items(id) ON DELETE RESTRICT,
  workflow_template_id text NOT NULL REFERENCES workflow_templates(id) ON DELETE RESTRICT, position integer NOT NULL,
  status text NOT NULL DEFAULT 'pending', workflow_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb, input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  workflow_run_id text UNIQUE, error text, started_at timestamptz, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (job_run_id, job_item_id)
);
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS job_run_id text REFERENCES job_runs(id) ON DELETE SET NULL;
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS job_item_id text REFERENCES job_run_items(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_job_runs_status ON job_runs(status, queued_at);
CREATE INDEX IF NOT EXISTS idx_job_run_items_run ON job_run_items(job_run_id, position);
