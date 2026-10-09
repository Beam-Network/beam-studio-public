-- Private backend evidence; process paths and fencing nonces are not run output.
CREATE TABLE IF NOT EXISTS execution.executor_process_ownership (
  assignment_id text PRIMARY KEY REFERENCES execution.executor_assignments(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'preparing' CHECK(state IN ('preparing','ready','stopped')),
  record_path text,
  record_nonce text,
  owner_scope text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(state<>'ready' OR (record_path IS NOT NULL AND record_nonce IS NOT NULL AND owner_scope IS NOT NULL))
);
