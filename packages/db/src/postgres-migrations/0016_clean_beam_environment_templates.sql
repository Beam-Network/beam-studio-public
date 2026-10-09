CREATE OR REPLACE FUNCTION pg_temp.studio_room_transfer_template_config(config jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
WITH selected AS (
  SELECT
    NULLIF(config->>'environmentTemplateKey', '') AS current_key,
    CASE
      WHEN config->>'environment' IN ('dev', 'prod')
        THEN config->>'environment'
      ELSE NULL
    END AS legacy_key
),
target AS (
  SELECT COALESCE(current_key, legacy_key, 'prod') AS template_key
  FROM selected
)
SELECT
  (config - 'environment' - 'coordinatorUrl')
  || CASE
    WHEN template_key IS NULL THEN '{}'::jsonb
    ELSE jsonb_build_object('environmentTemplateKey', template_key)
  END
FROM target;
$$;

UPDATE workflow.steps
SET config_json = pg_temp.studio_room_transfer_template_config(config_json)
WHERE action_package_name = '@beam/room-transfer'
  AND (
    config_json ? 'environment'
    OR config_json ? 'coordinatorUrl'
    OR NOT (config_json ? 'environmentTemplateKey')
  );

ALTER TABLE studio.beam_environment_templates
  DROP CONSTRAINT IF EXISTS studio_beam_environment_templates_environment_check;

ALTER TABLE studio.beam_environment_templates
  DROP COLUMN IF EXISTS environment;
