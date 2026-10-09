-- New room action traffic is never dispatched on the agent control socket.
ALTER TABLE agent_control.commands
  ADD COLUMN IF NOT EXISTS transport text NOT NULL DEFAULT 'agent-control';
ALTER TABLE agent_control.commands
  DROP CONSTRAINT IF EXISTS agent_commands_transport_check;
ALTER TABLE agent_control.commands
  ADD CONSTRAINT agent_commands_transport_check
    CHECK (transport IN ('agent-control','room-mls/v1'));

-- The command row remains Studio's durable, trusted invocation journal.
-- This table stores only protected-transport identities and recovery state.
CREATE TABLE IF NOT EXISTS execution.room_action_deliveries (
  command_id text PRIMARY KEY REFERENCES agent_control.commands(id) ON DELETE CASCADE,
  assignment_id text NOT NULL REFERENCES execution.executor_assignments(id) ON DELETE CASCADE,
  controller_agent_id text NOT NULL,
  controller_member_id text NOT NULL,
  recipient_member_id text NOT NULL,
  room_id text NOT NULL,
  control_channel_id text NOT NULL,
  request_reply_channel_id text NOT NULL,
  authority_generation bigint NOT NULL CHECK (authority_generation > 0),
  deadline_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (
    state IN ('queued','publishing','published','reconciliation_required','accepted','terminal','blocked')
  ),
  publication_id text,
  reply_id text,
  reply_publication_id text,
  reconciliation_command_id text REFERENCES agent_control.commands(id),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, command_id),
  UNIQUE (reply_id)
);
CREATE INDEX IF NOT EXISTS room_action_deliveries_reconcile
  ON execution.room_action_deliveries(state,updated_at)
  WHERE state NOT IN ('terminal','blocked');
