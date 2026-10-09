-- A run has one durable orchestration authority. An owner may renew its lease;
-- takeover advances the generation and fences every earlier assignment.
CREATE TABLE IF NOT EXISTS execution.workflow_run_authority (
  workflow_run_id text PRIMARY KEY REFERENCES execution.workflow_runs(id) ON DELETE CASCADE,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  owner_id text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO execution.workflow_run_authority(workflow_run_id,generation,owner_id,lease_expires_at)
SELECT id,1,'migration',clock_timestamp()
FROM execution.workflow_runs
WHERE status IN ('queued','running','cancel_requested')
ON CONFLICT (workflow_run_id) DO NOTHING;

ALTER TABLE execution.executor_assignments
  ADD COLUMN IF NOT EXISTS authority_generation bigint NOT NULL DEFAULT 1
    CHECK (authority_generation > 0),
  ADD COLUMN IF NOT EXISTS reserved_output_bytes bigint NOT NULL DEFAULT 0
    CHECK (reserved_output_bytes >= 0);

ALTER TABLE execution.workflow_tasks
  ADD COLUMN IF NOT EXISTS admission_deadline_at timestamptz;

CREATE INDEX IF NOT EXISTS workflow_tasks_admission_deadline
  ON execution.workflow_tasks(admission_deadline_at)
  WHERE status IN ('queued','retry_scheduled');

ALTER TABLE studio.room_storage_transfer_jobs
  ADD COLUMN IF NOT EXISTS admission_deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS assignment_id text,
  ADD COLUMN IF NOT EXISTS assignment_attempt integer,
  ADD COLUMN IF NOT EXISTS authority_generation bigint,
  ADD COLUMN IF NOT EXISTS provider_cleanup_confirmed_at timestamptz;

UPDATE studio.room_storage_transfer_jobs
SET provider_cleanup_confirmed_at=COALESCE(provider_cleanup_confirmed_at,updated_at)
WHERE provider_cleanup_confirmed_at IS NULL AND (
  (status IN ('completed','partial','cancelled') AND error_code IS NULL)
  OR (status='failed' AND coordinator_started=false AND transfer_id IS NULL
      AND error_code IS DISTINCT FROM 'room_storage_cleanup_incomplete')
);

ALTER TABLE studio.room_storage_transfer_jobs
  DROP CONSTRAINT IF EXISTS room_storage_assignment_attempt_positive,
  DROP CONSTRAINT IF EXISTS room_storage_authority_generation_positive;

ALTER TABLE studio.room_storage_transfer_jobs
  ADD CONSTRAINT room_storage_assignment_attempt_positive
    CHECK (assignment_attempt IS NULL OR assignment_attempt > 0),
  ADD CONSTRAINT room_storage_authority_generation_positive
    CHECK (authority_generation IS NULL OR authority_generation > 0);

CREATE INDEX IF NOT EXISTS room_storage_transfer_admission
  ON studio.room_storage_transfer_jobs(organization_id,status,admission_deadline_at);
