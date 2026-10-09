-- The numbered migration chain still supports the legacy public-schema
-- runtime, while current installations use the execution schema. Upgrade both
-- layouts so this migration is safe before or after the target-schema cutover.

CREATE SCHEMA IF NOT EXISTS execution;

ALTER TABLE IF EXISTS execution.workflow_tasks
  ADD COLUMN IF NOT EXISTS claim_token text;

ALTER TABLE IF EXISTS public.workflow_tasks
  ADD COLUMN IF NOT EXISTS claim_token text;

DO $$
BEGIN
  IF to_regclass('execution.workflow_tasks') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_execution_workflow_tasks_lease_recovery
      ON execution.workflow_tasks(status, lease_expires_at)';
  END IF;
  IF to_regclass('public.workflow_tasks') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_pg_workflow_tasks_lease_recovery
      ON public.workflow_tasks(status, lease_expires_at)';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS execution.command_outbox (
  id text PRIMARY KEY,
  command_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  transport text NOT NULL,
  subject text,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'pending',
  publish_attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text,
  claim_expires_at timestamptz,
  published_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_command_outbox_dedupe UNIQUE (command_type, aggregate_id),
  CONSTRAINT execution_command_outbox_state_check CHECK (
    state IN ('pending', 'publishing', 'published', 'cancelled')
  ),
  CONSTRAINT execution_command_outbox_transport_check CHECK (
    transport IN ('postgres', 'nats')
  )
);

CREATE INDEX IF NOT EXISTS idx_execution_command_outbox_pending
  ON execution.command_outbox(state, transport, available_at, created_at);

CREATE TABLE IF NOT EXISTS public.command_outbox (
  id text PRIMARY KEY,
  command_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  transport text NOT NULL,
  subject text,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'pending',
  publish_attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text,
  claim_expires_at timestamptz,
  published_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT public_command_outbox_dedupe UNIQUE (command_type, aggregate_id),
  CONSTRAINT public_command_outbox_state_check CHECK (
    state IN ('pending', 'publishing', 'published', 'cancelled')
  ),
  CONSTRAINT public_command_outbox_transport_check CHECK (
    transport IN ('postgres', 'nats')
  )
);

CREATE INDEX IF NOT EXISTS idx_pg_command_outbox_pending
  ON public.command_outbox(state, transport, available_at, created_at);
