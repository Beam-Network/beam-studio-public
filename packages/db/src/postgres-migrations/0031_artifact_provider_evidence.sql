CREATE TABLE IF NOT EXISTS execution.workflow_artifact_provider_attestations (
  manifest_id text NOT NULL REFERENCES execution.workflow_artifact_manifests(id) ON DELETE CASCADE,
  artifact_id text NOT NULL,
  member_id text NOT NULL,
  locator text NOT NULL,
  bucket text NOT NULL,
  object_key text NOT NULL,
  version_id text NOT NULL,
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  retention_mode text NOT NULL DEFAULT 'COMPLIANCE',
  retained_until timestamptz NOT NULL,
  verified_at timestamptz NOT NULL,
  PRIMARY KEY (manifest_id, artifact_id, member_id, locator),
  CONSTRAINT workflow_artifact_provider_retention_mode_check CHECK (retention_mode='COMPLIANCE')
);

ALTER TABLE execution.workflow_artifact_obligations
  ADD COLUMN IF NOT EXISTS cleanup_confirmed_at timestamptz;

ALTER TABLE execution.workflow_artifact_obligations
  DROP CONSTRAINT IF EXISTS workflow_artifact_obligations_status_check;
ALTER TABLE execution.workflow_artifact_obligations
  ADD CONSTRAINT workflow_artifact_obligations_status_check
  CHECK(status IN ('pending','active','releasing','released'));

UPDATE execution.workflow_artifact_obligations o
SET cleanup_confirmed_at=COALESCE(o.released_at,now())
FROM execution.workflow_artifact_manifests m
WHERE o.manifest_id=m.id AND o.status='released'
  AND o.cleanup_confirmed_at IS NULL
  AND EXISTS (
    SELECT 1 FROM agent_control.commands c
    WHERE c.operation='action.artifact.release' AND c.state='completed'
      AND c.payload_json->>'retentionObligationId'=o.obligation_id
      AND c.payload_json->>'assignmentId'=m.assignment_id
      AND c.result_json->>'retentionObligationId'=o.obligation_id
      AND c.result_json->>'assignmentId'=m.assignment_id
      AND c.result_json->>'cleanupConfirmed'='true'
  );
UPDATE execution.workflow_artifact_obligations
SET status='releasing'
WHERE status='released' AND cleanup_confirmed_at IS NULL;
