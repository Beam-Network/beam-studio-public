-- Move the remaining transfer-studio product state into PostgreSQL. These
-- tables intentionally keep their historical names so
-- the product repository can be cut over independently from the workflow
-- schema.

CREATE TABLE IF NOT EXISTS beam_api_keys (
  id text PRIMARY KEY,
  name text NOT NULL,
  base_url text NOT NULL,
  encrypted_api_key text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS organization_api_keys_cache (
  id text PRIMARY KEY,
  name text NOT NULL,
  prefix text,
  organization_id text NOT NULL,
  organization_name text,
  project_name text,
  status text NOT NULL,
  last_used_at timestamptz,
  expires_at timestamptz,
  credit_limit bigint,
  credits_used bigint,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  synced_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS transfer_templates (
  id text PRIMARY KEY,
  organization_id text NOT NULL DEFAULT '__local__',
  project_id text,
  name text NOT NULL,
  description text,
  api_key_id text NOT NULL,
  beam_server_url text,
  encrypted_custom_api_key text,
  test_mode integer NOT NULL DEFAULT 0,
  encrypted_notification_webhook_url text,
  encrypted_slack_webhook_url text,
  notify_on_start integer NOT NULL DEFAULT 0,
  notify_on_success integer NOT NULL DEFAULT 1,
  notify_on_failure integer NOT NULL DEFAULT 1,
  notify_on_cancel integer NOT NULL DEFAULT 1,
  enabled integer NOT NULL DEFAULT 0,
  total_source_size_bytes bigint NOT NULL DEFAULT 0,
  total_transfer_size_bytes bigint NOT NULL DEFAULT 0,
  estimated_credit_cost double precision NOT NULL DEFAULT 0,
  file_suffix_mode text NOT NULL DEFAULT 'none',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS transfer_sources (
  id text PRIMARY KEY,
  transfer_template_id text NOT NULL REFERENCES transfer_templates(id) ON DELETE CASCADE,
  name text NOT NULL,
  source_type text NOT NULL DEFAULT 'file',
  provider text NOT NULL,
  bucket text NOT NULL,
  object_key text NOT NULL,
  region text,
  endpoint_url text,
  credential_id text,
  object_size_bytes bigint,
  metadata_checked_at timestamptz,
  metadata_error text,
  enabled integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS transfer_destinations (
  id text PRIMARY KEY,
  transfer_template_id text NOT NULL REFERENCES transfer_templates(id) ON DELETE CASCADE,
  name text NOT NULL,
  provider text NOT NULL,
  bucket text NOT NULL,
  object_key text NOT NULL,
  filename_policy text NOT NULL DEFAULT 'overwrite',
  filename_template text,
  filename_timezone text NOT NULL DEFAULT 'UTC',
  region text,
  endpoint_url text,
  credential_id text,
  enabled integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
  id text PRIMARY KEY,
  transfer_template_id text NOT NULL REFERENCES transfer_templates(id) ON DELETE CASCADE,
  frequency text NOT NULL,
  enabled integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  start_at timestamptz,
  end_at timestamptz,
  timezone text NOT NULL DEFAULT 'UTC',
  next_run_at timestamptz,
  max_run_duration_seconds integer,
  credit_budget_limit double precision,
  credits_consumed double precision NOT NULL DEFAULT 0,
  max_runs integer,
  run_count integer NOT NULL DEFAULT 0,
  success_count integer NOT NULL DEFAULT 0,
  failure_count integer NOT NULL DEFAULT 0,
  last_run_at timestamptz,
  last_error text,
  window_start_time text,
  window_end_time text,
  window_days text,
  overlap_policy text NOT NULL DEFAULT 'skip_new',
  estimated_credit_cost double precision NOT NULL DEFAULT 0,
  budget_alert_threshold integer NOT NULL DEFAULT 80,
  alert_state text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY,
  transfer_template_id text NOT NULL REFERENCES transfer_templates(id) ON DELETE CASCADE,
  status text NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz,
  queued_at timestamptz,
  next_attempt_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  locked_at timestamptz,
  lock_expires_at timestamptz,
  locked_by text,
  schedule_id text REFERENCES schedules(id) ON DELETE SET NULL,
  trigger text NOT NULL DEFAULT 'manual',
  beam_transfer_id text,
  idempotency_key text,
  max_duration_seconds integer,
  credit_cost double precision NOT NULL DEFAULT 0,
  cancel_reason text,
  timed_out_at timestamptz,
  workflow_run_id text
);

CREATE TABLE IF NOT EXISTS run_transfers (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  source_id text,
  destination_id text,
  source_name text,
  destination_name text,
  destination_object_key text,
  status text NOT NULL,
  beam_transfer_id text,
  error text,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_logs (
  id text PRIMARY KEY,
  run_id text REFERENCES runs(id) ON DELETE CASCADE,
  event text NOT NULL,
  payload text NOT NULL,
  created_at timestamptz NOT NULL,
  level text NOT NULL DEFAULT 'info',
  correlation_id text,
  worker_id text
);

CREATE TABLE IF NOT EXISTS dead_letter_runs (
  id text PRIMARY KEY,
  run_id text NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  transfer_template_id text NOT NULL REFERENCES transfer_templates(id) ON DELETE CASCADE,
  reason text NOT NULL,
  error text NOT NULL,
  attempts integer NOT NULL,
  max_attempts integer NOT NULL,
  beam_transfer_id text,
  retry_run_id text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduler_metric_snapshots (
  id text PRIMARY KEY,
  worker_id text NOT NULL,
  queued_count integer NOT NULL,
  running_count integer NOT NULL,
  failed_count integer NOT NULL,
  dead_letter_count integer NOT NULL,
  retry_count integer NOT NULL,
  queue_lag_seconds integer NOT NULL,
  avg_run_duration_seconds integer NOT NULL,
  success_rate integer NOT NULL,
  active_worker_count integer NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_instances (
  id text PRIMARY KEY,
  hostname text NOT NULL,
  pid integer NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  stopped_at timestamptz,
  metadata text NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_transfer_templates_org ON transfer_templates(organization_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_transfer_templates_project ON transfer_templates(organization_id, project_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_runs_scheduler_queue ON runs(status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_execution_logs_run ON execution_logs(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dead_letter_runs_created ON dead_letter_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_scheduler_metric_snapshots_created ON scheduler_metric_snapshots(created_at);
CREATE INDEX IF NOT EXISTS idx_worker_instances_status ON worker_instances(status, heartbeat_at);
