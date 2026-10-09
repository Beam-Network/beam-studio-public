-- Bound repeated journal probes when a protected reply is lost.
ALTER TABLE execution.room_action_deliveries
  ADD COLUMN IF NOT EXISTS reconciliation_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE execution.room_action_deliveries
  DROP CONSTRAINT IF EXISTS room_action_reconciliation_attempts_check;
ALTER TABLE execution.room_action_deliveries
  ADD CONSTRAINT room_action_reconciliation_attempts_check
    CHECK (reconciliation_attempts BETWEEN 0 AND 64);
