DO $$
DECLARE
  room_version actions.package_versions%ROWTYPE;
  room_package actions.packages%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM workflow.steps
    WHERE action_package_name = '@beam/room-transfer'
      AND retired_at IS NULL
  ) THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM execution.workflow_runs run
    JOIN workflow.steps step
      ON step.workflow_template_id = run.workflow_template_id
    WHERE step.action_package_name = '@beam/room-transfer'
      AND step.retired_at IS NULL
      AND run.status IN ('queued', 'running', 'cancel_requested')
  ) THEN
    RAISE EXCEPTION 'Room-transfer action contract migration requires no active room workflow runs.';
  END IF;

  SELECT package.* INTO room_package
  FROM actions.packages package
  WHERE package.package_name = '@beam/room-transfer';

  SELECT version.* INTO room_version
  FROM actions.package_versions version
  WHERE version.package_id = room_package.id
    AND version.version = '1.0.2'
    AND version.status IN ('active', 'deprecated');

  IF room_version.id IS NULL THEN
    RAISE EXCEPTION '@beam/room-transfer@1.0.2 must be installed before applying the action contract migration.';
  END IF;

  UPDATE workflow.steps
  SET config_json =
        (config_json - 'environment' - 'coordinatorUrl')
        || jsonb_build_object(
          'environmentTemplateKey',
          COALESCE(
            NULLIF(config_json->>'environmentTemplateKey', ''),
            CASE WHEN config_json->>'environment' IN ('dev', 'prod')
              THEN config_json->>'environment'
            END,
            'prod'
          )
        ),
      action_version_range = '1.0.2',
      updated_at = now()
  WHERE action_package_name = '@beam/room-transfer'
    AND retired_at IS NULL;

  UPDATE workflow.action_locks lock
  SET version_range = '1.0.2',
      resolved_version = room_version.version,
      package_version_id = room_version.id,
      checksum = room_version.manifest_checksum,
      artifact_checksum = room_version.artifact_checksum,
      artifact_reference = COALESCE(
        NULLIF(room_version.provenance_json->>'artifactReference', ''),
        NULLIF(room_version.provenance_json->>'registryArtifactUrl', ''),
        CASE
          WHEN room_version.hippius_bucket IS NOT NULL
            AND room_version.hippius_key IS NOT NULL
          THEN 's3://' || room_version.hippius_bucket || '/' || ltrim(room_version.hippius_key, '/')
        END
      ),
      source_registry = COALESCE(
        NULLIF(room_version.provenance_json->>'source', ''),
        NULLIF(room_package.metadata_json->>'source', ''),
        'local-registry'
      ),
      trust_level = COALESCE(
        NULLIF(room_version.provenance_json->>'registryTrustLevel', ''),
        room_package.trust_level
      ),
      created_at = now()
  WHERE lock.action_package_name = '@beam/room-transfer'
    AND EXISTS (
      SELECT 1 FROM workflow.steps step
      WHERE step.workflow_template_id = lock.workflow_template_id
        AND step.action_package_name = '@beam/room-transfer'
        AND step.retired_at IS NULL
    );

  IF EXISTS (
    SELECT 1 FROM workflow.steps
    WHERE action_package_name = '@beam/room-transfer'
      AND retired_at IS NULL
      AND (
        action_version_range <> '1.0.2'
        OR config_json ? 'environment'
        OR config_json ? 'coordinatorUrl'
        OR NOT (config_json ? 'environmentTemplateKey')
      )
  ) THEN
    RAISE EXCEPTION 'Room-transfer workflow migration did not converge on the template contract.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM workflow.steps step
    LEFT JOIN workflow.action_locks lock
      ON lock.workflow_template_id = step.workflow_template_id
      AND lock.action_package_name = step.action_package_name
    WHERE step.action_package_name = '@beam/room-transfer'
      AND step.retired_at IS NULL
      AND (
        lock.id IS NULL
        OR lock.version_range IS DISTINCT FROM '1.0.2'
        OR lock.resolved_version IS DISTINCT FROM room_version.version
        OR lock.package_version_id IS DISTINCT FROM room_version.id
        OR lock.checksum IS DISTINCT FROM room_version.manifest_checksum
        OR lock.artifact_checksum IS DISTINCT FROM room_version.artifact_checksum
      )
  ) THEN
    RAISE EXCEPTION 'Room-transfer action locks did not converge on @beam/room-transfer@1.0.2.';
  END IF;
END $$;
