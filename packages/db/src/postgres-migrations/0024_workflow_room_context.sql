ALTER TABLE workflow.templates ADD COLUMN IF NOT EXISTS room_context_json jsonb;

-- Scoped control capabilities are operational secrets, never definition/run snapshots.
CREATE TABLE IF NOT EXISTS execution.workflow_run_capabilities (
  workflow_run_id text PRIMARY KEY REFERENCES execution.workflow_runs(id) ON DELETE CASCADE,
  authorization_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE workflow.templates DROP CONSTRAINT IF EXISTS workflow_room_context_shape;
ALTER TABLE workflow.templates ADD CONSTRAINT workflow_room_context_shape CHECK (
  room_context_json IS NULL OR (jsonb_typeof(room_context_json)='object'
    AND jsonb_typeof(room_context_json->'environmentTemplateKey')='string'
    AND jsonb_typeof(room_context_json->'roomId')='string'
    AND room_context_json ? 'environmentTemplateKey' AND room_context_json ? 'roomId')
);
