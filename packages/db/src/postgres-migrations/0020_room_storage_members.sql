-- Durable room bindings and transfer state for object-storage members.
-- Storage credentials remain in the existing secrets schema; these rows only
-- bind an existing credential-backed bucket to a room.

CREATE TABLE IF NOT EXISTS studio.room_storage_bindings (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  environment_template_key text NOT NULL,
  credential_id text NOT NULL REFERENCES secrets.credentials(id) ON DELETE RESTRICT,
  provider_profile_id text NOT NULL REFERENCES secrets.provider_profiles(id) ON DELETE RESTRICT,
  bucket text NOT NULL,
  resource_id text NOT NULL,
  room_id text NOT NULL,
  coordinator_member_id text NOT NULL,
  display_name text NOT NULL,
  object_channel_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  destination_prefix text NOT NULL DEFAULT '',
  destination_layout text NOT NULL DEFAULT 'isolated',
  collision_policy text NOT NULL DEFAULT 'fail_if_exists',
  source_delegate_member_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_delegate_role_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  availability text NOT NULL DEFAULT 'available',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT room_storage_bindings_layout_check CHECK (destination_layout IN ('isolated', 'preserve_path', 'flat_name')),
  CONSTRAINT room_storage_bindings_collision_check CHECK (collision_policy IN ('fail_if_exists', 'overwrite')),
  CONSTRAINT room_storage_bindings_availability_check CHECK (availability IN ('available', 'unavailable', 'revoked')),
  UNIQUE (organization_id, environment_template_key, room_id, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_studio_room_storage_binding_credential
  ON studio.room_storage_bindings(credential_id);
CREATE INDEX IF NOT EXISTS idx_studio_room_storage_binding_room
  ON studio.room_storage_bindings(organization_id, environment_template_key, room_id);

CREATE TABLE IF NOT EXISTS studio.room_storage_multipart_sessions (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  binding_id text REFERENCES studio.room_storage_bindings(id) ON DELETE CASCADE,
  target_member_id text NOT NULL,
  publication_id text NOT NULL,
  child_execution_id text NOT NULL,
  multipart_group_id text NOT NULL,
  object_key text NOT NULL,
  upload_id text NOT NULL,
  parts_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  state text NOT NULL DEFAULT 'active',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT room_storage_multipart_state_check CHECK (state IN ('active', 'completed', 'aborted', 'expired')),
  UNIQUE (organization_id, child_execution_id)
);

CREATE INDEX IF NOT EXISTS idx_studio_room_storage_multipart_publication
  ON studio.room_storage_multipart_sessions(publication_id);

CREATE TABLE IF NOT EXISTS studio.room_storage_transfer_jobs (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  environment_template_key text NOT NULL,
  room_id text NOT NULL,
  channel_id text NOT NULL,
  publication_id text NOT NULL,
  origin_kind text NOT NULL,
  origin_key text NOT NULL,
  request_hash text NOT NULL,
  workflow_run_id text,
  workflow_step_run_id text,
  initiator_agent_id text,
  initiator_member_id text,
  api_key_id text NOT NULL,
  source_member_id text NOT NULL,
  source_locator_json jsonb NOT NULL,
  target_member_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ttl_seconds integer NOT NULL,
  allow_partial boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'queued',
  transfer_id text,
  coordinator_started boolean NOT NULL DEFAULT false,
  endpoint_refs_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  file_json jsonb,
  error_code text,
  error_message text,
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT room_storage_transfer_jobs_status_check CHECK (status IN ('queued','preparing','running','completed','partial','failed','cancel_requested','cancelled')),
  CONSTRAINT room_storage_transfer_jobs_origin_check CHECK (origin_kind IN ('workflow','agent')),
  CONSTRAINT room_storage_transfer_jobs_ttl_check CHECK (ttl_seconds BETWEEN 15 AND 86400),
  UNIQUE (organization_id, publication_id),
  UNIQUE (organization_id, origin_key)
);

CREATE INDEX IF NOT EXISTS idx_studio_room_storage_transfer_status
  ON studio.room_storage_transfer_jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_studio_room_storage_transfer_step
  ON studio.room_storage_transfer_jobs(workflow_step_run_id)
  WHERE workflow_step_run_id IS NOT NULL;
