-- Persist trusted host and boot evidence beside the fenced process journal.
ALTER TABLE execution.executor_process_ownership
  ADD COLUMN IF NOT EXISTS owner_host_identity text,
  ADD COLUMN IF NOT EXISTS owner_boot_id text,
  ADD COLUMN IF NOT EXISTS owner_native_scope text;

ALTER TABLE execution.executor_process_ownership
  DROP CONSTRAINT IF EXISTS executor_process_ownership_check;
ALTER TABLE execution.executor_process_ownership
  ADD CONSTRAINT executor_process_ownership_check CHECK (
    state <> 'ready' OR (
      record_path IS NOT NULL AND record_nonce IS NOT NULL AND owner_scope IS NOT NULL
      AND (
        (owner_host_identity IS NULL AND owner_boot_id IS NULL AND owner_native_scope IS NULL)
        OR
        (owner_host_identity IS NOT NULL AND owner_boot_id IS NOT NULL AND owner_native_scope IS NOT NULL)
      )
    )
  );
