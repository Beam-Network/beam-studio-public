-- Only the API/resource owner writes this evidence. Action state is business data,
-- and cannot attest that computation or a room publication has stopped.
ALTER TABLE execution.workflow_step_runs ADD COLUMN IF NOT EXISTS resource_execution_json jsonb NOT NULL DEFAULT '{}';
