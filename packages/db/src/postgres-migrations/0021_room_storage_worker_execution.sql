-- Drain old storage executions before changing the execution contract. Historical
-- jobs remain readable; they cannot be resumed through the removed agent loops.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM studio.room_storage_transfer_jobs
    WHERE status IN ('queued','preparing','running','cancel_requested')) THEN
    RAISE EXCEPTION 'Drain active room storage transfers before deploying worker execution';
  END IF;
END $$;

ALTER TABLE studio.room_storage_transfer_jobs
  ADD COLUMN IF NOT EXISTS preparation_json jsonb,
  ADD COLUMN IF NOT EXISTS execution_json jsonb;
