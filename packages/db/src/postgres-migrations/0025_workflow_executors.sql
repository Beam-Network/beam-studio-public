ALTER TABLE workflow.steps ADD COLUMN IF NOT EXISTS execution_target_json jsonb;
UPDATE workflow.steps SET execution_target_json = CASE
  WHEN execution_location_id IS NOT NULL THEN jsonb_build_object('kind','remote-transport','executionLocationId',execution_location_id)
  WHEN placement='beamcore-public' THEN '{"kind":"remote-transport"}'::jsonb
  ELSE '{"kind":"studio"}'::jsonb END
WHERE kind='action' AND execution_target_json IS NULL;

ALTER TABLE agent_control.agents ADD COLUMN IF NOT EXISTS action_execution_json jsonb;

-- Durable assignment identity is distinct from a room member, room recipient,
-- transport command and task claim. A capability is never part of run history.
CREATE TABLE IF NOT EXISTS execution.executor_assignments (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  workflow_run_id text NOT NULL REFERENCES execution.workflow_runs(id),
  workflow_step_run_id text NOT NULL REFERENCES execution.workflow_step_runs(id),
  task_id text NOT NULL REFERENCES execution.workflow_tasks(id),
  attempt integer NOT NULL CHECK(attempt>0),
  backend text NOT NULL CHECK(backend IN ('studio','room-member','remote-transport','external-worker')),
  executor_id text NOT NULL,
  member_id text,
  session_generation bigint,
  declared_target_json jsonb NOT NULL,
  state text NOT NULL CHECK(state IN ('assigned','dispatching','running','cancel_requested','completed','failed','cancelled','reconciliation_required')),
  command_id text,
  lease_expires_at timestamptz NOT NULL,
  cancel_requested_at timestamptz,
  executor_stopped_at timestamptz,
  cleanup_confirmed_at timestamptz,
  result_json jsonb,
  error_json jsonb,
  progress_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id,attempt)
);
CREATE INDEX IF NOT EXISTS executor_assignments_active ON execution.executor_assignments(backend,state,lease_expires_at);
CREATE INDEX IF NOT EXISTS executor_assignments_run ON execution.executor_assignments(workflow_run_id,created_at);
CREATE TABLE IF NOT EXISTS execution.executor_assignment_capabilities (
  assignment_id text PRIMARY KEY REFERENCES execution.executor_assignments(id) ON DELETE CASCADE,
  authorization_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
