-- Remove retired Beam Transfer step options.

-- Authored Beam Transfer step configurations drop the retired key. Frozen
-- definitions and run snapshots stay immutable history.
UPDATE workflow.steps
SET config_json = config_json - 'testMode'
WHERE action_package_name = '@beam/transfer'
  AND config_json ? 'testMode';

-- The legacy transfer table, present only where 0008 ran, drops its column.
ALTER TABLE IF EXISTS transfer_templates DROP COLUMN IF EXISTS test_mode;
