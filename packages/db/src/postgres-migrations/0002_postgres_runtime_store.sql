CREATE TABLE IF NOT EXISTS credentials (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  kind text NOT NULL,
  encrypted_payload text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_artifacts (
  id text PRIMARY KEY,
  workflow_run_id text NOT NULL REFERENCES workflow_runs(id),
  workflow_step_run_id text REFERENCES workflow_step_runs(id),
  type text NOT NULL,
  name text NOT NULL,
  uri text NOT NULL,
  media_type text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pg_credentials_org
  ON credentials(organization_id, kind, name);

CREATE INDEX IF NOT EXISTS idx_pg_workflow_artifacts_run
  ON workflow_artifacts(workflow_run_id, created_at);
