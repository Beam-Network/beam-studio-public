-- One immutable collection identity per task attempt. Pending evidence can gain
-- verified copies/transfers, but cannot change artifact bytes or provenance.
CREATE TABLE IF NOT EXISTS execution.workflow_artifact_identities (
  artifact_id text PRIMARY KEY,
  workflow_run_id text NOT NULL REFERENCES execution.workflow_runs(id) ON DELETE CASCADE,
  task_id text NOT NULL REFERENCES execution.workflow_tasks(id) ON DELETE CASCADE,
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL CHECK(size_bytes >= 0),
  media_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS execution.workflow_artifact_manifests (
  id text PRIMARY KEY,
  workflow_run_id text NOT NULL REFERENCES execution.workflow_runs(id) ON DELETE CASCADE,
  workflow_step_run_id text NOT NULL REFERENCES execution.workflow_step_runs(id) ON DELETE CASCADE,
  task_id text NOT NULL REFERENCES execution.workflow_tasks(id) ON DELETE CASCADE,
  assignment_id text NOT NULL REFERENCES execution.executor_assignments(id) ON DELETE CASCADE,
  attempt integer NOT NULL,
  publication_id text NOT NULL,
  artifact_identity_hash text NOT NULL,
  artifacts_json jsonb NOT NULL,
  result_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  error text,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_artifact_manifests_attempt_unique UNIQUE(task_id, attempt),
  CONSTRAINT workflow_artifact_manifests_publication_unique UNIQUE(publication_id),
  CONSTRAINT workflow_artifact_manifests_status_check CHECK(status IN ('pending','accepted','unavailable','failed'))
);

CREATE TABLE IF NOT EXISTS execution.workflow_artifact_locations (
  manifest_id text NOT NULL REFERENCES execution.workflow_artifact_manifests(id) ON DELETE CASCADE,
  artifact_id text NOT NULL,
  kind text NOT NULL,
  locator text NOT NULL,
  member_id text,
  room_id text NOT NULL,
  channel_id text NOT NULL,
  source_member_id text NOT NULL,
  verified_at timestamptz NOT NULL,
  verification_basis text NOT NULL,
  durable_until timestamptz,
  retention_obligation_id text,
  state text NOT NULL DEFAULT 'available',
  lost_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(manifest_id, artifact_id, kind, locator),
  CONSTRAINT workflow_artifact_locations_kind_check CHECK(kind IN ('member','storage')),
  CONSTRAINT workflow_artifact_locations_basis_check CHECK(verification_basis IN ('local_hash','recipient_final_receipt','provider_finalization')),
  CONSTRAINT workflow_artifact_locations_state_check CHECK(state IN ('available','lost','revoked'))
);

CREATE TABLE IF NOT EXISTS execution.workflow_artifact_transfers (
  manifest_id text NOT NULL REFERENCES execution.workflow_artifact_manifests(id) ON DELETE CASCADE,
  artifact_id text NOT NULL,
  destination_member_id text NOT NULL,
  publication_id text NOT NULL,
  transfer_id text NOT NULL,
  room_id text NOT NULL,
  channel_id text NOT NULL,
  source_member_id text NOT NULL,
  status text NOT NULL,
  full_delivery_verified boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(manifest_id, artifact_id, destination_member_id),
  CONSTRAINT workflow_artifact_transfers_status_check CHECK(status IN ('completed','partial','failed'))
);

CREATE TABLE IF NOT EXISTS execution.workflow_artifact_obligations (
  obligation_id text PRIMARY KEY,
  manifest_id text NOT NULL REFERENCES execution.workflow_artifact_manifests(id) ON DELETE CASCADE,
  artifact_id text NOT NULL,
  required_until timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_artifact_obligations_status_check CHECK(status IN ('pending','active','released')),
  CONSTRAINT workflow_artifact_obligations_identity_unique UNIQUE(manifest_id, artifact_id, obligation_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_artifact_locations_recovery
  ON execution.workflow_artifact_locations(state, manifest_id);
CREATE INDEX IF NOT EXISTS idx_workflow_artifact_obligations_active
  ON execution.workflow_artifact_obligations(manifest_id) WHERE status='active';
