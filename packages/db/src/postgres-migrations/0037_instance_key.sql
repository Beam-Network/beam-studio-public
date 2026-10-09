-- Identifies this installation to Beam when it asks for its instance key, and
-- keeps at most one active instance key credential per organization.
ALTER TABLE studio.instance
  ADD COLUMN IF NOT EXISTS instance_id uuid NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS secrets_credentials_one_active_instance_key
  ON secrets.credentials(organization_id)
  WHERE external_source = 'beam_studio_instance' AND status = 'active';
