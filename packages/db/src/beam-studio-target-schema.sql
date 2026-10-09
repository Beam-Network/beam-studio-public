-- Existing Jobs require the explicit prepare/drain/backup/migrate cutover.
DO $$ BEGIN
  IF to_regclass('job.definitions') IS NOT NULL THEN
    RAISE EXCEPTION 'Workflow-first cutover required: run the workflow-job-cutover operator command before deploying this schema';
  END IF;
END $$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS secrets;
CREATE SCHEMA IF NOT EXISTS mcp;
CREATE SCHEMA IF NOT EXISTS actions;
CREATE SCHEMA IF NOT EXISTS workflow;
CREATE SCHEMA IF NOT EXISTS execution;
CREATE SCHEMA IF NOT EXISTS runtime;
CREATE SCHEMA IF NOT EXISTS assistant;
CREATE SCHEMA IF NOT EXISTS agent_control;
CREATE SCHEMA IF NOT EXISTS studio;
CREATE SCHEMA IF NOT EXISTS meta;

CREATE TABLE IF NOT EXISTS meta.schema_migrations (
  id text PRIMARY KEY,
  description text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  checksum text
);

CREATE TABLE IF NOT EXISTS identity.organizations (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identity.projects (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_projects_org_slug_unique UNIQUE (organization_id, slug)
);

CREATE TABLE IF NOT EXISTS identity.users (
  id text PRIMARY KEY,
  external_id text UNIQUE,
  email text UNIQUE,
  display_name text,
  avatar_url text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identity.organization_members (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_organization_members_unique UNIQUE (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS identity.project_members (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES identity.projects(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_project_members_unique UNIQUE (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS identity.service_accounts (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  project_id text REFERENCES identity.projects(id) ON DELETE SET NULL,
  owner_user_id text REFERENCES identity.users(id) ON DELETE SET NULL,
  created_by_id text REFERENCES identity.users(id) ON DELETE SET NULL,
  slug text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_service_accounts_org_slug_unique UNIQUE (organization_id, slug),
  CONSTRAINT identity_service_accounts_status_check CHECK (status IN ('active', 'disabled', 'deleted'))
);

CREATE TABLE IF NOT EXISTS secrets.credential_types (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  display_name text NOT NULL,
  description text,
  secret_schema_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_schema_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  display_schema_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation_policy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS secrets.provider_profiles (
  id text PRIMARY KEY,
  credential_type_id text NOT NULL REFERENCES secrets.credential_types(id),
  driver text NOT NULL,
  display_name text NOT NULL,
  description text,
  logo_url text,
  website_url text,
  docs_url text,
  endpoint_template text,
  default_region text,
  default_endpoint_url text,
  required_fields_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  optional_fields_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  field_defaults_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_labels_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS secrets.credentials (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  project_id text REFERENCES identity.projects(id) ON DELETE SET NULL,
  credential_type_id text NOT NULL REFERENCES secrets.credential_types(id),
  provider_profile_id text REFERENCES secrets.provider_profiles(id),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  external_id text,
  external_source text,
  prefix text,
  fingerprint_hash text,
  description text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_id text REFERENCES identity.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  last_validated_at timestamptz,
  expires_at timestamptz,
  CONSTRAINT secrets_credentials_status_check CHECK (status IN ('active', 'disabled', 'revoked', 'expired'))
);

CREATE TABLE IF NOT EXISTS secrets.credential_versions (
  id text PRIMARY KEY,
  credential_id text NOT NULL REFERENCES secrets.credentials(id) ON DELETE CASCADE,
  version integer NOT NULL,
  encrypted_payload text NOT NULL,
  encryption_key_id text NOT NULL,
  payload_schema_version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  created_by_id text REFERENCES identity.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  replaced_by_version_id text REFERENCES secrets.credential_versions(id),
  CONSTRAINT secrets_credential_versions_unique UNIQUE (credential_id, version),
  CONSTRAINT secrets_credential_versions_status_check CHECK (status IN ('active', 'revoked', 'superseded'))
);

CREATE TABLE IF NOT EXISTS secrets.credential_validation_events (
  id text PRIMARY KEY,
  credential_id text NOT NULL REFERENCES secrets.credentials(id) ON DELETE CASCADE,
  credential_version_id text REFERENCES secrets.credential_versions(id) ON DELETE SET NULL,
  status text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  error_code text,
  error_message text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT secrets_credential_validation_status_check CHECK (status IN ('valid', 'invalid', 'error', 'skipped'))
);

CREATE TABLE IF NOT EXISTS secrets.credential_capabilities (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  display_name text NOT NULL,
  description text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS secrets.credential_type_capabilities (
  id text PRIMARY KEY,
  credential_type_id text NOT NULL REFERENCES secrets.credential_types(id) ON DELETE CASCADE,
  credential_capability_id text NOT NULL REFERENCES secrets.credential_capabilities(id) ON DELETE CASCADE,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT secrets_credential_type_capabilities_unique UNIQUE (
    credential_type_id,
    credential_capability_id
  )
);

CREATE TABLE IF NOT EXISTS runtime.worker_runtime_state (
  worker_id text PRIMARY KEY,
  organization_id text REFERENCES identity.organizations(id) ON DELETE SET NULL,
  project_id text REFERENCES identity.projects(id) ON DELETE SET NULL,
  network_identity text NOT NULL,
  status text NOT NULL,
  reachability text NOT NULL DEFAULT 'local',
  capabilities_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  accessible_endpoints_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  version text,
  cpu_load real NOT NULL DEFAULT 0,
  memory_used_bytes bigint NOT NULL DEFAULT 0,
  memory_total_bytes bigint NOT NULL DEFAULT 0,
  bandwidth_mbps real NOT NULL DEFAULT 0,
  active_task_count integer NOT NULL DEFAULT 0,
  load_score real NOT NULL DEFAULT 0,
  heartbeat_at timestamptz NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_worker_runtime_state_status_check CHECK (
    status IN ('active', 'online', 'draining', 'offline', 'stale', 'stopped')
  )
);

CREATE TABLE IF NOT EXISTS runtime.worker_capabilities (
  id text PRIMARY KEY,
  worker_id text NOT NULL REFERENCES runtime.worker_runtime_state(worker_id) ON DELETE CASCADE,
  capability text NOT NULL,
  version_range text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_worker_capabilities_unique UNIQUE (worker_id, capability)
);

CREATE TABLE IF NOT EXISTS runtime.execution_locations (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  project_id text REFERENCES identity.projects(id) ON DELETE SET NULL,
  name text NOT NULL,
  kind text NOT NULL,
  endpoint_url text,
  encrypted_headers text,
  enabled boolean NOT NULL DEFAULT true,
  allow_insecure_http boolean NOT NULL DEFAULT false,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runtime.outbox_events (
  id text PRIMARY KEY,
  organization_id text REFERENCES identity.organizations(id) ON DELETE SET NULL,
  project_id text REFERENCES identity.projects(id) ON DELETE SET NULL,
  topic text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_outbox_events_status_check CHECK (status IN ('pending', 'publishing', 'published', 'failed'))
);

CREATE TABLE IF NOT EXISTS agent_control.machines (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  project_id text REFERENCES identity.projects(id) ON DELETE SET NULL,
  name text NOT NULL,
  worker_id text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_control.agents (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  project_id text REFERENCES identity.projects(id) ON DELETE SET NULL,
  machine_id text REFERENCES agent_control.machines(id) ON DELETE SET NULL,
  name text NOT NULL,
  public_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'offline',
  daemon_version text,
  daemon_commit text,
  daemon_build_date text,
  platform text,
  architecture text,
  capabilities_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  protocol_min integer,
  protocol_max integer,
  session_generation bigint NOT NULL DEFAULT 0,
  command_sequence bigint NOT NULL DEFAULT 0,
  event_sequence bigint NOT NULL DEFAULT 0,
  policy_revision bigint NOT NULL DEFAULT 0,
  policy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_by_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_control_agents_status_check CHECK (
    status IN ('offline', 'connecting', 'online', 'stale', 'revoked')
  )
);

CREATE TABLE IF NOT EXISTS agent_control.enrollments (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  project_id text REFERENCES identity.projects(id) ON DELETE SET NULL,
  machine_name text NOT NULL,
  code_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by_agent_id text REFERENCES agent_control.agents(id) ON DELETE SET NULL,
  created_by_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_control_enrollments_status_check CHECK (
    status IN ('pending', 'consumed', 'expired', 'revoked')
  )
);

CREATE TABLE IF NOT EXISTS agent_control.credentials (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agent_control.agents(id) ON DELETE CASCADE,
  secret_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  issued_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT agent_control_credentials_status_check CHECK (
    status IN ('active', 'revoked', 'expired')
  )
);

CREATE TABLE IF NOT EXISTS agent_control.auth_nonces (
  nonce_hash text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agent_control.agents(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_control.sessions (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agent_control.agents(id) ON DELETE CASCADE,
  generation bigint NOT NULL,
  boot_id text NOT NULL,
  connection_owner text,
  status text NOT NULL DEFAULT 'online',
  connected_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz,
  disconnect_reason text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT agent_control_sessions_status_check CHECK (
    status IN ('online', 'replaced', 'disconnected', 'expired')
  ),
  CONSTRAINT agent_control_sessions_generation_unique UNIQUE (agent_id, generation)
);

CREATE TABLE IF NOT EXISTS agent_control.commands (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  project_id text REFERENCES identity.projects(id) ON DELETE SET NULL,
  agent_id text NOT NULL REFERENCES agent_control.agents(id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  session_generation bigint,
  operation text NOT NULL,
  state text NOT NULL DEFAULT 'queued',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_json jsonb,
  error_json jsonb,
  requested_by_id text,
  expires_at timestamptz NOT NULL,
  dispatched_at timestamptz,
  accepted_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_control_commands_state_check CHECK (
    state IN (
      'queued', 'dispatched', 'accepted', 'running',
      'completed', 'failed', 'cancelled', 'expired'
    )
  ),
  CONSTRAINT agent_control_commands_sequence_unique UNIQUE (agent_id, sequence),
  CONSTRAINT agent_control_commands_idempotency_unique UNIQUE (agent_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS agent_control.events (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agent_control.agents(id) ON DELETE CASCADE,
  session_id text REFERENCES agent_control.sessions(id) ON DELETE SET NULL,
  command_id text REFERENCES agent_control.commands(id) ON DELETE SET NULL,
  sequence bigint,
  event_type text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_control_events_agent_sequence_unique UNIQUE (agent_id, sequence)
);

CREATE TABLE IF NOT EXISTS agent_control.audit_events (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  agent_id text REFERENCES agent_control.agents(id) ON DELETE SET NULL,
  enrollment_id text REFERENCES agent_control.enrollments(id) ON DELETE SET NULL,
  command_id text REFERENCES agent_control.commands(id) ON DELETE SET NULL,
  actor_id text,
  action text NOT NULL,
  status text NOT NULL,
  details_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_control.room_labels (
  organization_id text NOT NULL,
  room_id text NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_control_room_labels_primary_key PRIMARY KEY (organization_id, room_id),
  CONSTRAINT agent_control_room_labels_label_check CHECK (
    char_length(label) BETWEEN 1 AND 120
  )
);

-- Room ownership is authoritative in the external BTR coordinator. Studio may
-- label rooms for Beam organizations that are not mirrored into its local
-- identity schema, so this sidecar table must not depend on that local mirror.
ALTER TABLE agent_control.room_labels
  DROP CONSTRAINT IF EXISTS room_labels_organization_id_fkey;

-- MCP tokens used to be queried unqualified, which resolved to public.*
-- tables created only by the optional legacy migration. Authentication for the
-- MCP plane therefore depended on whether someone had run an optional command.
-- Everything now reads mcp.*; drop the old pair so only one can be reached.
DROP TABLE IF EXISTS public.mcp_audit_events CASCADE;
DROP TABLE IF EXISTS public.mcp_tokens CASCADE;

CREATE TABLE IF NOT EXISTS mcp.tokens (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  project_id text REFERENCES identity.projects(id) ON DELETE SET NULL,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  prefix text,
  scopes_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active',
  expires_at timestamptz,
  last_used_at timestamptz,
  created_by_id text REFERENCES identity.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT mcp_tokens_status_check CHECK (status IN ('active', 'revoked', 'expired'))
);

CREATE TABLE IF NOT EXISTS mcp.audit_events (
  id text PRIMARY KEY,
  organization_id text REFERENCES identity.organizations(id) ON DELETE SET NULL,
  project_id text REFERENCES identity.projects(id) ON DELETE SET NULL,
  token_id text REFERENCES mcp.tokens(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  subject_type text,
  subject_id text,
  ip_address text,
  user_agent text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS actions.categories (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  parent_id text REFERENCES actions.categories(id),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS actions.scopes (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  owner_organization_id text REFERENCES identity.organizations(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT actions_scopes_name_format_check CHECK (name ~ '^@[a-z0-9][a-z0-9._-]*$'),
  CONSTRAINT actions_scopes_status_check CHECK (status IN ('active', 'suspended', 'blocked'))
);

CREATE TABLE IF NOT EXISTS actions.scope_members (
  id text PRIMARY KEY,
  scope_id text NOT NULL REFERENCES actions.scopes(id) ON DELETE CASCADE,
  organization_id text REFERENCES identity.organizations(id) ON DELETE CASCADE,
  user_id text REFERENCES identity.users(id) ON DELETE CASCADE,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT actions_scope_members_role_check CHECK (role IN ('owner', 'maintainer', 'publisher', 'reviewer')),
  CONSTRAINT actions_scope_members_subject_check CHECK (user_id IS NOT NULL OR organization_id IS NOT NULL),
  CONSTRAINT actions_scope_members_unique_subject UNIQUE (scope_id, user_id, organization_id)
);

CREATE TABLE IF NOT EXISTS actions.packages (
  id text PRIMARY KEY,
  scope_id text NOT NULL REFERENCES actions.scopes(id),
  category_id text REFERENCES actions.categories(id),
  name text NOT NULL,
  package_name text NOT NULL UNIQUE,
  display_name text NOT NULL,
  description text,
  visibility text NOT NULL DEFAULT 'private',
  status text NOT NULL DEFAULT 'active',
  trust_level text NOT NULL DEFAULT 'external',
  latest_version text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  organization_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT actions_packages_name_format_check CHECK (name ~ '^[a-z0-9][a-z0-9._-]*$'),
  CONSTRAINT actions_packages_package_name_format_check CHECK (package_name ~ '^@[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$'),
  CONSTRAINT actions_packages_visibility_check CHECK (visibility IN ('private', 'unlisted', 'public')),
  CONSTRAINT actions_packages_status_check CHECK (status IN ('active', 'deprecated', 'blocked')),
  CONSTRAINT actions_packages_trust_level_check CHECK (trust_level IN ('builtin', 'verified', 'external', 'blocked')),
  CONSTRAINT actions_packages_scope_name_unique UNIQUE (scope_id, name)
);

CREATE TABLE IF NOT EXISTS actions.package_versions (
  id text PRIMARY KEY,
  package_id text NOT NULL REFERENCES actions.packages(id) ON DELETE CASCADE,
  version text NOT NULL,
  manifest_json jsonb NOT NULL,
  manifest_checksum text NOT NULL,
  artifact_checksum text NOT NULL,
  artifact_size_bytes bigint NOT NULL DEFAULT 0,
  hippius_bucket text,
  hippius_key text,
  hippius_endpoint text,
  media_type text NOT NULL DEFAULT 'application/gzip',
  signature text,
  provenance_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation_status text NOT NULL DEFAULT 'pending',
  status text NOT NULL DEFAULT 'active',
  published_by text,
  published_at timestamptz NOT NULL DEFAULT now(),
  deprecated_at timestamptz,
  deprecation_reason text,
  blocked_at timestamptz,
  block_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT actions_package_versions_semver_check CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'),
  CONSTRAINT actions_package_versions_validation_status_check CHECK (validation_status IN ('pending', 'validating', 'validated', 'verified', 'rejected', 'blocked')),
  CONSTRAINT actions_package_versions_status_check CHECK (status IN ('active', 'deprecated', 'blocked', 'yanked')),
  CONSTRAINT actions_package_versions_package_version_unique UNIQUE (package_id, version)
);

CREATE TABLE IF NOT EXISTS actions.dist_tags (
  id text PRIMARY KEY,
  package_id text NOT NULL REFERENCES actions.packages(id) ON DELETE CASCADE,
  tag text NOT NULL,
  version_id text NOT NULL REFERENCES actions.package_versions(id) ON DELETE CASCADE,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT actions_dist_tags_tag_format_check CHECK (tag ~ '^[a-z0-9][a-z0-9._-]*$'),
  CONSTRAINT actions_dist_tags_package_tag_unique UNIQUE (package_id, tag)
);

CREATE TABLE IF NOT EXISTS actions.credential_requirements (
  id text PRIMARY KEY,
  package_version_id text NOT NULL REFERENCES actions.package_versions(id) ON DELETE CASCADE,
  requirement_key text NOT NULL,
  display_name text NOT NULL,
  description text,
  required boolean NOT NULL DEFAULT true,
  cardinality text NOT NULL DEFAULT 'one',
  purpose text,
  accepted_credential_type_id text REFERENCES secrets.credential_types(id),
  accepted_capability_id text REFERENCES secrets.credential_capabilities(id),
  config_path text,
  permissions_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT actions_credential_requirements_unique UNIQUE (package_version_id, requirement_key),
  CONSTRAINT actions_credential_requirements_cardinality_check CHECK (cardinality IN ('one', 'many'))
);

CREATE TABLE IF NOT EXISTS workflow.templates (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  project_id text REFERENCES identity.projects(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft',
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  retry_policy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  graph_version text NOT NULL DEFAULT 'workflow-graph/v1',
  graph_json jsonb NOT NULL DEFAULT '{"version":"workflow-graph/v1","controls":[],"edges":[]}'::jsonb,
  timeout_seconds integer,
  enabled boolean NOT NULL DEFAULT true,
  created_by_id text REFERENCES identity.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT workflow_templates_status_check CHECK (status IN ('draft', 'active', 'archived'))
);

ALTER TABLE workflow.templates
  ADD COLUMN IF NOT EXISTS graph_version text NOT NULL DEFAULT 'workflow-graph/v1',
  ADD COLUMN IF NOT EXISTS layout_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS graph_json jsonb NOT NULL DEFAULT '{"version":"workflow-graph/v1","controls":[],"edges":[]}'::jsonb;

CREATE TABLE IF NOT EXISTS workflow.steps (
  id text PRIMARY KEY,
  workflow_template_id text NOT NULL REFERENCES workflow.templates(id) ON DELETE CASCADE,
  action_package_name text NOT NULL,
  action_version_range text NOT NULL DEFAULT '*',
  position integer NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_bindings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  placement text NOT NULL DEFAULT 'local-workers',
  execution_location_id text REFERENCES runtime.execution_locations(id) ON DELETE SET NULL,
  canvas_x real,
  canvas_y real,
  timeout_seconds integer,
  required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CONSTRAINT workflow_steps_position_check CHECK (position >= 0),
  CONSTRAINT workflow_steps_template_position_unique UNIQUE (workflow_template_id, position)
);

ALTER TABLE workflow.steps
  ADD COLUMN IF NOT EXISTS retired_at timestamptz;

-- A step's label is node metadata, not action configuration. It previously
-- lived in config_json.name by convention; backfill those once so the column
-- is the single source of truth.
ALTER TABLE workflow.steps
  ADD COLUMN IF NOT EXISTS name text;

UPDATE workflow.steps
SET name = config_json->>'name'
WHERE name IS NULL
  AND config_json ? 'name'
  AND length(trim(config_json->>'name')) > 0;

CREATE TABLE IF NOT EXISTS workflow.edges (
  id text PRIMARY KEY,
  workflow_template_id text NOT NULL REFERENCES workflow.templates(id) ON DELETE CASCADE,
  from_step_id text NOT NULL REFERENCES workflow.steps(id) ON DELETE CASCADE,
  to_step_id text NOT NULL REFERENCES workflow.steps(id) ON DELETE CASCADE,
  condition_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow.triggers (
  id text PRIMARY KEY,
  workflow_template_id text NOT NULL REFERENCES workflow.templates(id) ON DELETE CASCADE,
  type text NOT NULL,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  canvas_x real,
  canvas_y real,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per accepted webhook delivery, used to bound how often an
-- unauthenticated trigger can start runs. A webhook run costs credits, so an
-- unlimited trigger is unlimited spend for anyone holding the URL. Kept in the
-- database rather than in process memory because the API runs several
-- replicas and a restart must not reset the budget.
-- The same rows reject replays for a trigger that requires a body signature:
-- a signature already recorded inside the acceptance window cannot be spent
-- twice. Null for triggers that do not require one, so the index is partial.
CREATE TABLE IF NOT EXISTS workflow.webhook_deliveries (
  id text PRIMARY KEY,
  trigger_id text NOT NULL REFERENCES workflow.triggers(id) ON DELETE CASCADE,
  received_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE workflow.webhook_deliveries
  ADD COLUMN IF NOT EXISTS signature text;

CREATE TABLE IF NOT EXISTS workflow.trigger_edges (
  id text PRIMARY KEY,
  workflow_template_id text NOT NULL REFERENCES workflow.templates(id) ON DELETE CASCADE,
  trigger_id text NOT NULL REFERENCES workflow.triggers(id) ON DELETE CASCADE,
  to_step_id text NOT NULL REFERENCES workflow.steps(id) ON DELETE CASCADE,
  condition_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Prerequisite for the workflow.decision_edges composite foreign keys below.
-- Trivially satisfied because id is already the primary key.
-- This constraint cannot use the DROP CONSTRAINT IF EXISTS + ADD idiom used elsewhere in
-- this file: decision_edges depends on it, so a DROP fails with "cannot drop constraint ...
-- because other objects depend on it" on any re-apply, and CASCADE would drop those foreign
-- keys instead. Guard on the catalog.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workflow_steps_template_id_unique'
      AND conrelid = 'workflow.steps'::regclass
  ) THEN
    ALTER TABLE workflow.steps
      ADD CONSTRAINT workflow_steps_template_id_unique UNIQUE (workflow_template_id, id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS workflow.decisions (
  id text PRIMARY KEY,
  workflow_template_id text NOT NULL REFERENCES workflow.templates(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'if',
  enabled boolean NOT NULL DEFAULT true,
  join_mode text NOT NULL DEFAULT 'all',
  handle_failure boolean NOT NULL DEFAULT false,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  canvas_x real,
  canvas_y real,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_decisions_join_mode_check CHECK (join_mode IN ('all', 'any_settled')),
  CONSTRAINT workflow_decisions_kind_check CHECK (kind IN ('if', 'switch')),
  CONSTRAINT workflow_decisions_template_id_unique UNIQUE (workflow_template_id, id)
);

CREATE TABLE IF NOT EXISTS workflow.decision_edges (
  id text PRIMARY KEY,
  workflow_template_id text NOT NULL REFERENCES workflow.templates(id) ON DELETE CASCADE,
  from_step_id text,
  from_decision_id text,
  to_step_id text,
  to_decision_id text,
  branch text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_decision_edges_from_check
    CHECK ((from_step_id IS NOT NULL) <> (from_decision_id IS NOT NULL)),
  CONSTRAINT workflow_decision_edges_to_check
    CHECK ((to_step_id IS NOT NULL) <> (to_decision_id IS NOT NULL)),
  -- branch IS NOT NULL is required explicitly: without it a NULL branch makes
  -- "branch IN ('true','false')" evaluate to NULL, and a CHECK passes on NULL.
  CONSTRAINT workflow_decision_edges_branch_check CHECK (
    (from_decision_id IS NOT NULL AND branch IS NOT NULL AND (
      branch IN ('true', 'false', 'default')
      OR branch ~ '^case:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    ))
    OR (from_step_id IS NOT NULL AND branch IS NULL)
  ),
  CONSTRAINT workflow_decision_edges_from_step_fk
    FOREIGN KEY (workflow_template_id, from_step_id)
    REFERENCES workflow.steps (workflow_template_id, id) ON DELETE CASCADE,
  CONSTRAINT workflow_decision_edges_from_decision_fk
    FOREIGN KEY (workflow_template_id, from_decision_id)
    REFERENCES workflow.decisions (workflow_template_id, id) ON DELETE CASCADE,
  CONSTRAINT workflow_decision_edges_to_step_fk
    FOREIGN KEY (workflow_template_id, to_step_id)
    REFERENCES workflow.steps (workflow_template_id, id) ON DELETE CASCADE,
  CONSTRAINT workflow_decision_edges_to_decision_fk
    FOREIGN KEY (workflow_template_id, to_decision_id)
    REFERENCES workflow.decisions (workflow_template_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_decisions_template
  ON workflow.decisions (workflow_template_id);
CREATE INDEX IF NOT EXISTS idx_workflow_decision_edges_template
  ON workflow.decision_edges (workflow_template_id);

ALTER TABLE workflow.decisions
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'if';
ALTER TABLE workflow.decisions
  DROP CONSTRAINT IF EXISTS workflow_decisions_kind_check;
ALTER TABLE workflow.decisions
  ADD CONSTRAINT workflow_decisions_kind_check CHECK (kind IN ('if', 'switch'));
ALTER TABLE workflow.decision_edges
  DROP CONSTRAINT IF EXISTS workflow_decision_edges_branch_check;
ALTER TABLE workflow.decision_edges
  ADD CONSTRAINT workflow_decision_edges_branch_check CHECK (
    (from_decision_id IS NOT NULL AND branch IS NOT NULL AND (
      branch IN ('true', 'false', 'default')
      OR branch ~ '^case:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    ))
    OR (from_step_id IS NOT NULL AND branch IS NULL)
  );

CREATE TABLE IF NOT EXISTS workflow.plan_versions (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  project_id text REFERENCES identity.projects(id) ON DELETE SET NULL,
  workflow_template_id text NOT NULL REFERENCES workflow.templates(id) ON DELETE CASCADE,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'active',
  compiled_plan_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  manifest_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  CONSTRAINT workflow_plan_versions_template_version_unique UNIQUE (workflow_template_id, version),
  CONSTRAINT workflow_plan_versions_status_check CHECK (status IN ('active', 'superseded', 'archived'))
);

CREATE TABLE IF NOT EXISTS workflow.action_locks (
  id text PRIMARY KEY,
  workflow_template_id text NOT NULL REFERENCES workflow.templates(id) ON DELETE CASCADE,
  action_package_name text NOT NULL,
  version_range text NOT NULL,
  resolved_version text NOT NULL,
  package_version_id text REFERENCES actions.package_versions(id) ON DELETE SET NULL,
  checksum text NOT NULL,
  artifact_checksum text,
  artifact_reference text,
  source_registry text NOT NULL,
  trust_level text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE workflow.action_locks
  ADD COLUMN IF NOT EXISTS artifact_checksum text,
  ADD COLUMN IF NOT EXISTS artifact_reference text,
  ADD COLUMN IF NOT EXISTS trust_level text;

CREATE TABLE IF NOT EXISTS workflow.step_credential_bindings (
  id text PRIMARY KEY,
  workflow_step_id text NOT NULL REFERENCES workflow.steps(id) ON DELETE CASCADE,
  credential_requirement_id text NOT NULL REFERENCES actions.credential_requirements(id) ON DELETE CASCADE,
  credential_id text NOT NULL REFERENCES secrets.credentials(id) ON DELETE RESTRICT,
  requirement_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_step_credential_bindings_unique UNIQUE (workflow_step_id, requirement_key)
);

CREATE TABLE IF NOT EXISTS execution.workflow_runs (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  project_id text REFERENCES identity.projects(id) ON DELETE SET NULL,
  workflow_template_id text NOT NULL REFERENCES workflow.templates(id) ON DELETE RESTRICT,
  workflow_plan_version_id text REFERENCES workflow.plan_versions(id) ON DELETE SET NULL,
  status text NOT NULL,
  trigger text NOT NULL DEFAULT 'manual',
  trigger_id text,
  trigger_type text,
  trigger_event_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  template_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_steps_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  queued_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_workflow_runs_status_check CHECK (
    status IN ('queued', 'running', 'cancel_requested', 'completed', 'failed', 'cancelled')
  )
);

-- V2 dynamic graph regions are durable orchestration aggregates. A control path
-- is stable within the immutable graph snapshot attached to a workflow run.
CREATE TABLE IF NOT EXISTS execution.workflow_dynamic_regions (
  id text PRIMARY KEY,
  workflow_run_id text NOT NULL REFERENCES execution.workflow_runs(id) ON DELETE CASCADE,
  control_id text NOT NULL,
  control_path text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  definition_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_input_json jsonb NOT NULL DEFAULT 'null'::jsonb,
  output_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  instance_count integer NOT NULL DEFAULT 0,
  completed_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  cancelled_count integer NOT NULL DEFAULT 0,
  concurrency_limit integer,
  error text,
  cancellation_requested_at timestamptz,
  retry_requested_at timestamptz,
  requested_by text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_workflow_dynamic_regions_kind_check CHECK (
    kind IN ('loop', 'fan-out')
  ),
  CONSTRAINT execution_workflow_dynamic_regions_status_check CHECK (
    status IN ('pending', 'expanding', 'running', 'completed', 'failed', 'cancel_requested', 'cancelled', 'skipped', 'not_reached')
  ),
  CONSTRAINT execution_workflow_dynamic_regions_count_check CHECK (
    instance_count >= 0 AND completed_count >= 0 AND failed_count >= 0 AND cancelled_count >= 0
  ),
  CONSTRAINT execution_workflow_dynamic_regions_unique_path UNIQUE (workflow_run_id, control_path)
);

CREATE TABLE IF NOT EXISTS execution.workflow_dynamic_instances (
  id text PRIMARY KEY,
  workflow_run_id text NOT NULL REFERENCES execution.workflow_runs(id) ON DELETE CASCADE,
  dynamic_region_id text NOT NULL REFERENCES execution.workflow_dynamic_regions(id) ON DELETE CASCADE,
  workflow_step_id text NOT NULL REFERENCES workflow.steps(id) ON DELETE RESTRICT,
  control_path text NOT NULL,
  instance_index integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  current_attempt integer NOT NULL DEFAULT 1,
  context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_workflow_dynamic_instances_index_check CHECK (instance_index >= 0),
  CONSTRAINT execution_workflow_dynamic_instances_attempt_check CHECK (current_attempt >= 1),
  CONSTRAINT execution_workflow_dynamic_instances_status_check CHECK (
    status IN ('pending', 'queued', 'running', 'completed', 'failed', 'cancelled', 'skipped', 'not_reached')
  ),
  CONSTRAINT execution_workflow_dynamic_instances_unique_logical
    UNIQUE (workflow_run_id, control_path, workflow_step_id, instance_index)
);

CREATE TABLE IF NOT EXISTS execution.workflow_step_runs (
  id text PRIMARY KEY,
  workflow_run_id text NOT NULL REFERENCES execution.workflow_runs(id) ON DELETE CASCADE,
  workflow_step_id text NOT NULL REFERENCES workflow.steps(id) ON DELETE RESTRICT,
  dynamic_instance_id text REFERENCES execution.workflow_dynamic_instances(id) ON DELETE CASCADE,
  action_package_name text NOT NULL,
  resolved_version text NOT NULL,
  checksum text NOT NULL,
  source_registry text NOT NULL,
  resolved_placement text NOT NULL,
  execution_location_id text REFERENCES runtime.execution_locations(id) ON DELETE SET NULL,
  status text NOT NULL,
  attempt integer NOT NULL DEFAULT 1,
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_ref text,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_workflow_step_runs_status_check CHECK (
    status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'skipped', 'not_reached')
  )
);

-- Upgrade installations whose V1 table still has the original broad unique
-- constraint. V1 keeps the same invariant through a partial unique index while
-- V2 receives one step run per logical dynamic instance.
ALTER TABLE execution.workflow_step_runs
  ADD COLUMN IF NOT EXISTS dynamic_instance_id text
    REFERENCES execution.workflow_dynamic_instances(id) ON DELETE CASCADE;
ALTER TABLE execution.workflow_step_runs
  DROP CONSTRAINT IF EXISTS workflow_step_runs_unique_step;
ALTER TABLE execution.workflow_step_runs
  DROP CONSTRAINT IF EXISTS execution_workflow_step_runs_unique_step;
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_workflow_step_runs_static_unique
  ON execution.workflow_step_runs(workflow_run_id, workflow_step_id)
  WHERE dynamic_instance_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_workflow_step_runs_dynamic_unique
  ON execution.workflow_step_runs(dynamic_instance_id)
  WHERE dynamic_instance_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS execution.workflow_tasks (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  project_id text REFERENCES identity.projects(id) ON DELETE SET NULL,
  workflow_run_id text NOT NULL REFERENCES execution.workflow_runs(id) ON DELETE CASCADE,
  workflow_step_run_id text REFERENCES execution.workflow_step_runs(id) ON DELETE SET NULL,
  workflow_step_id text NOT NULL REFERENCES workflow.steps(id) ON DELETE RESTRICT,
  task_kind text NOT NULL,
  action_package_name text NOT NULL,
  status text NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  target_worker_id text,
  leased_by text,
  lease_expires_at timestamptz,
  locked_by text,
  lock_expires_at timestamptz,
  claim_token text,
  attempt_count integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  shard_index integer,
  shard_count integer,
  input_checksum text NOT NULL,
  output_checksum text,
  idempotency_key text,
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  retry_policy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  placement_explanation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  nats_subject text,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_workflow_tasks_status_check CHECK (
    status IN ('queued', 'leased', 'running', 'retry_scheduled', 'completed', 'failed', 'cancelled', 'dead_letter')
  )
);

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

-- `CREATE TABLE IF NOT EXISTS` does not add lease fencing columns to an
-- existing installation.
ALTER TABLE execution.workflow_tasks
  ADD COLUMN IF NOT EXISTS claim_token text;

CREATE TABLE IF NOT EXISTS execution.workflow_task_attempts (
  id text PRIMARY KEY,
  workflow_task_id text NOT NULL REFERENCES execution.workflow_tasks(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  worker_id text,
  status text NOT NULL,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_workflow_task_attempts_unique UNIQUE (workflow_task_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS execution.workflow_task_dead_letters (
  id text PRIMARY KEY,
  workflow_task_id text NOT NULL REFERENCES execution.workflow_tasks(id) ON DELETE CASCADE,
  workflow_run_id text NOT NULL REFERENCES execution.workflow_runs(id) ON DELETE CASCADE,
  workflow_step_run_id text REFERENCES execution.workflow_step_runs(id) ON DELETE SET NULL,
  reason text NOT NULL,
  error text NOT NULL,
  attempts integer NOT NULL,
  max_attempts integer NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_workflow_task_dead_letters_task_unique UNIQUE (workflow_task_id)
);

CREATE TABLE IF NOT EXISTS execution.workflow_artifacts (
  id text PRIMARY KEY,
  workflow_run_id text NOT NULL REFERENCES execution.workflow_runs(id) ON DELETE CASCADE,
  workflow_step_run_id text REFERENCES execution.workflow_step_runs(id) ON DELETE SET NULL,
  type text NOT NULL,
  name text NOT NULL,
  uri text NOT NULL,
  media_type text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS execution.workflow_events (
  id text PRIMARY KEY,
  organization_id text REFERENCES identity.organizations(id) ON DELETE SET NULL,
  project_id text REFERENCES identity.projects(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  event_version integer NOT NULL DEFAULT 1,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  workflow_template_id text REFERENCES workflow.templates(id) ON DELETE SET NULL,
  workflow_run_id text REFERENCES execution.workflow_runs(id) ON DELETE SET NULL,
  workflow_step_run_id text REFERENCES execution.workflow_step_runs(id) ON DELETE SET NULL,
  workflow_task_id text REFERENCES execution.workflow_tasks(id) ON DELETE SET NULL,
  worker_id text,
  correlation_id text,
  idempotency_key text,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);

CREATE TABLE IF NOT EXISTS execution.workflow_condition_evaluations (
  id text PRIMARY KEY,
  workflow_run_id text NOT NULL REFERENCES execution.workflow_runs(id) ON DELETE CASCADE,
  dynamic_region_id text REFERENCES execution.workflow_dynamic_regions(id) ON DELETE CASCADE,
  dynamic_instance_id text REFERENCES execution.workflow_dynamic_instances(id) ON DELETE CASCADE,
  scope_key text NOT NULL,
  edge_id text NOT NULL,
  from_node_id text NOT NULL,
  to_node_id text NOT NULL,
  outcome text NOT NULL,
  result boolean,
  reason text NOT NULL,
  summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_workflow_condition_evaluations_outcome_check CHECK (
    outcome IN ('taken', 'skipped', 'not_reached')
  ),
  CONSTRAINT execution_workflow_condition_evaluations_unique
    UNIQUE (workflow_run_id, scope_key, edge_id)
);

CREATE TABLE IF NOT EXISTS execution.workflow_decision_evaluations (
  id text PRIMARY KEY,
  workflow_run_id text NOT NULL REFERENCES execution.workflow_runs(id) ON DELETE CASCADE,
  decision_id text NOT NULL,
  scope_key text NOT NULL DEFAULT 'root',
  join_mode text NOT NULL,
  decision_kind text NOT NULL DEFAULT 'if',
  evaluated boolean NOT NULL,
  result boolean,
  taken_branch text,
  handled_failures jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_workflow_decision_evaluations_branch_check CHECK (
    taken_branch IS NULL
    OR taken_branch IN ('true', 'false', 'default')
    OR taken_branch ~ '^case:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  CONSTRAINT execution_workflow_decision_evaluations_unique
    UNIQUE (workflow_run_id, scope_key, decision_id)
);

ALTER TABLE execution.workflow_decision_evaluations
  ADD COLUMN IF NOT EXISTS decision_kind text NOT NULL DEFAULT 'if';
ALTER TABLE execution.workflow_decision_evaluations
  DROP CONSTRAINT IF EXISTS execution_workflow_decision_evaluations_kind_check;
ALTER TABLE execution.workflow_decision_evaluations
  ADD CONSTRAINT execution_workflow_decision_evaluations_kind_check
  CHECK (decision_kind IN ('if', 'switch'));
ALTER TABLE execution.workflow_decision_evaluations
  DROP CONSTRAINT IF EXISTS execution_workflow_decision_evaluations_branch_check;
ALTER TABLE execution.workflow_decision_evaluations
  ADD CONSTRAINT execution_workflow_decision_evaluations_branch_check CHECK (
    taken_branch IS NULL
    OR taken_branch IN ('true', 'false', 'default')
    OR taken_branch ~ '^case:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  );

CREATE TABLE IF NOT EXISTS execution.workflow_step_credential_uses (
  id text PRIMARY KEY,
  workflow_run_id text NOT NULL REFERENCES execution.workflow_runs(id) ON DELETE CASCADE,
  workflow_step_run_id text NOT NULL REFERENCES execution.workflow_step_runs(id) ON DELETE CASCADE,
  credential_id text NOT NULL REFERENCES secrets.credentials(id) ON DELETE RESTRICT,
  credential_version_id text NOT NULL REFERENCES secrets.credential_versions(id) ON DELETE RESTRICT,
  credential_requirement_id text NOT NULL REFERENCES actions.credential_requirements(id) ON DELETE RESTRICT,
  requirement_key text NOT NULL,
  credential_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_workflow_step_credential_uses_unique
  ON execution.workflow_step_credential_uses (
    workflow_step_run_id,
    credential_requirement_id,
    credential_id
  );

CREATE TABLE IF NOT EXISTS execution.execution_plans (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  project_id text REFERENCES identity.projects(id) ON DELETE SET NULL,
  workflow_plan_version_id text REFERENCES workflow.plan_versions(id) ON DELETE SET NULL,
  workflow_run_id text NOT NULL REFERENCES execution.workflow_runs(id) ON DELETE CASCADE,
  workflow_step_run_id text REFERENCES execution.workflow_step_runs(id) ON DELETE SET NULL,
  workflow_step_id text REFERENCES workflow.steps(id) ON DELETE SET NULL,
  mode text,
  shard_count integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  plan_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  retry_policy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  scheduler_explanation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS execution.execution_plan_nodes (
  id text PRIMARY KEY,
  execution_plan_id text NOT NULL REFERENCES execution.execution_plans(id) ON DELETE CASCADE,
  workflow_step_id text NOT NULL REFERENCES workflow.steps(id) ON DELETE RESTRICT,
  action_package_name text NOT NULL,
  resolved_version text NOT NULL,
  node_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_execution_plan_nodes_step_unique UNIQUE (execution_plan_id, workflow_step_id)
);

CREATE TABLE IF NOT EXISTS execution.execution_plan_edges (
  id text PRIMARY KEY,
  execution_plan_id text NOT NULL REFERENCES execution.execution_plans(id) ON DELETE CASCADE,
  from_node_id text NOT NULL REFERENCES execution.execution_plan_nodes(id) ON DELETE CASCADE,
  to_node_id text NOT NULL REFERENCES execution.execution_plan_nodes(id) ON DELETE CASCADE,
  condition_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS execution.execution_plan_shards (
  id text PRIMARY KEY,
  execution_plan_id text NOT NULL REFERENCES execution.execution_plans(id) ON DELETE CASCADE,
  workflow_task_id text REFERENCES execution.workflow_tasks(id) ON DELETE SET NULL,
  shard_index integer,
  shard_kind text NOT NULL,
  assigned_worker_id text,
  nats_subject text,
  status text NOT NULL,
  input_weight integer NOT NULL DEFAULT 0,
  source_locality text,
  destination_locality text,
  output_checksum text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_identity_projects_org ON identity.projects(organization_id, slug);
CREATE INDEX IF NOT EXISTS idx_identity_org_members_user ON identity.organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_identity_project_members_user ON identity.project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_secrets_provider_profiles_type ON secrets.provider_profiles(credential_type_id, driver);
CREATE INDEX IF NOT EXISTS idx_secrets_credentials_org ON secrets.credentials(organization_id, project_id, status);
CREATE INDEX IF NOT EXISTS idx_secrets_credentials_type ON secrets.credentials(credential_type_id, provider_profile_id);
CREATE INDEX IF NOT EXISTS idx_secrets_credential_versions_credential ON secrets.credential_versions(credential_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_webhook_deliveries_trigger ON workflow.webhook_deliveries(trigger_id, received_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_webhook_deliveries_signature ON workflow.webhook_deliveries(trigger_id, signature) WHERE signature IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_org ON mcp.tokens(organization_id, project_id, status);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_events_token ON mcp.audit_events(token_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_actions_categories_parent ON actions.categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_actions_packages_scope ON actions.packages(scope_id, name);
CREATE INDEX IF NOT EXISTS idx_actions_packages_category ON actions.packages(category_id, display_name);
-- A private Registry package is visible only to the organization that
-- installed it; NULL keeps a package instance-wide.
ALTER TABLE actions.packages ADD COLUMN IF NOT EXISTS organization_id text;
CREATE INDEX IF NOT EXISTS idx_actions_packages_organization ON actions.packages(organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_actions_package_versions_package ON actions.package_versions(package_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_actions_dist_tags_package ON actions.dist_tags(package_id, tag);
CREATE INDEX IF NOT EXISTS idx_actions_credential_requirements_version ON actions.credential_requirements(package_version_id);
CREATE INDEX IF NOT EXISTS idx_workflow_templates_org ON workflow.templates(organization_id, project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_template ON workflow.steps(workflow_template_id, position);
CREATE INDEX IF NOT EXISTS idx_workflow_edges_template ON workflow.edges(workflow_template_id);
CREATE INDEX IF NOT EXISTS idx_workflow_triggers_template ON workflow.triggers(workflow_template_id, type);
CREATE INDEX IF NOT EXISTS idx_workflow_trigger_edges_template ON workflow.trigger_edges(workflow_template_id);
CREATE INDEX IF NOT EXISTS idx_workflow_plan_versions_template ON workflow.plan_versions(workflow_template_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_execution_workflow_runs_status ON execution.workflow_runs(status, queued_at);
CREATE INDEX IF NOT EXISTS idx_execution_workflow_runs_template ON execution.workflow_runs(workflow_template_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_workflow_step_runs_run ON execution.workflow_step_runs(workflow_run_id, status);
CREATE INDEX IF NOT EXISTS idx_execution_workflow_dynamic_regions_run
  ON execution.workflow_dynamic_regions(workflow_run_id, status);
CREATE INDEX IF NOT EXISTS idx_execution_workflow_dynamic_instances_region
  ON execution.workflow_dynamic_instances(dynamic_region_id, instance_index, status);
CREATE INDEX IF NOT EXISTS idx_execution_workflow_dynamic_instances_run
  ON execution.workflow_dynamic_instances(workflow_run_id, control_path, status);
CREATE INDEX IF NOT EXISTS idx_execution_workflow_condition_evaluations_run
  ON execution.workflow_condition_evaluations(workflow_run_id, scope_key, created_at);
CREATE INDEX IF NOT EXISTS idx_execution_workflow_decision_evaluations_run
  ON execution.workflow_decision_evaluations(workflow_run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_execution_workflow_tasks_claim ON execution.workflow_tasks(status, scheduled_at, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_execution_workflow_tasks_lease_recovery ON execution.workflow_tasks(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_execution_command_outbox_pending ON execution.command_outbox(state, transport, available_at, created_at);
CREATE INDEX IF NOT EXISTS idx_execution_workflow_tasks_target ON execution.workflow_tasks(target_worker_id, status);
CREATE INDEX IF NOT EXISTS idx_execution_workflow_tasks_lock_expires ON execution.workflow_tasks(lock_expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_workflow_tasks_idempotency
  ON execution.workflow_tasks(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_execution_workflow_events_run ON execution.workflow_events(workflow_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_workflow_events_subject ON execution.workflow_events(subject_type, subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_execution_plans_run ON execution.execution_plans(workflow_run_id, status);
CREATE INDEX IF NOT EXISTS idx_execution_execution_plan_nodes_plan ON execution.execution_plan_nodes(execution_plan_id);
CREATE INDEX IF NOT EXISTS idx_execution_execution_plan_edges_plan ON execution.execution_plan_edges(execution_plan_id);
CREATE INDEX IF NOT EXISTS idx_execution_execution_plan_shards_plan ON execution.execution_plan_shards(execution_plan_id, status);
CREATE INDEX IF NOT EXISTS idx_runtime_worker_state_status ON runtime.worker_runtime_state(status, heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_runtime_execution_locations_org ON runtime.execution_locations(organization_id, project_id, enabled);
CREATE INDEX IF NOT EXISTS idx_runtime_outbox_events_ready ON runtime.outbox_events(status, available_at);
CREATE INDEX IF NOT EXISTS idx_agent_control_machines_org
  ON agent_control.machines(organization_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_control_agents_org_status
  ON agent_control.agents(organization_id, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_control_enrollments_org_status
  ON agent_control.enrollments(organization_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_control_credentials_agent_status
  ON agent_control.credentials(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_control_auth_nonces_expiry
  ON agent_control.auth_nonces(expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_control_sessions_agent_status
  ON agent_control.sessions(agent_id, status, heartbeat_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_control_commands_ready
  ON agent_control.commands(agent_id, state, sequence);
CREATE INDEX IF NOT EXISTS idx_agent_control_commands_org
  ON agent_control.commands(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_control_events_agent
  ON agent_control.events(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_control_audit_org
  ON agent_control.audit_events(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_control_room_labels_org
  ON agent_control.room_labels(organization_id, updated_at DESC);

INSERT INTO meta.schema_migrations (id, description)
VALUES ('0000_beam_studio_target_schema', 'Create Beam Studio target domain schemas')
ON CONFLICT (id) DO UPDATE
SET applied_at = now(),
    description = EXCLUDED.description;

ALTER TABLE runtime.worker_runtime_state
  DROP CONSTRAINT IF EXISTS runtime_worker_runtime_state_status_check;

ALTER TABLE runtime.worker_runtime_state
  ADD CONSTRAINT runtime_worker_runtime_state_status_check CHECK (
    status IN ('active', 'online', 'draining', 'offline', 'stale', 'stopped')
  );

ALTER TABLE runtime.worker_runtime_state
  ADD COLUMN IF NOT EXISTS capabilities_json jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS assistant.conversations (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  project_id text REFERENCES identity.projects(id) ON DELETE SET NULL,
  -- Session user id, not a FK: identity.users is not populated in this database
  -- (0 rows against 4 organizations), so a reference would reject every insert.
  user_id text,
  title text NOT NULL DEFAULT 'New conversation',
  route text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE IF NOT EXISTS assistant.messages (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES assistant.conversations(id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL,
  meta_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_messages_role_check CHECK (role IN ('user', 'assistant'))
);

-- Durable conversation turns. HTTP clients only submit and observe these jobs.
ALTER TABLE assistant.conversations ADD COLUMN IF NOT EXISTS read_request_id text;
CREATE TABLE IF NOT EXISTS assistant.requests (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES assistant.conversations(id) ON DELETE CASCADE,
  organization_id text NOT NULL,
  user_id text NOT NULL,
  project_id text,
  request_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  input_json jsonb NOT NULL,
  encrypted_session text,
  response_json jsonb,
  error text,
  error_code text,
  worker_id text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (organization_id, user_id, request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS assistant_one_active_request_per_conversation
  ON assistant.requests(conversation_id) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS assistant_requests_queue ON assistant.requests(created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS assistant_requests_conversation ON assistant.requests(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS assistant.provider_settings (
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  -- Session user id, intentionally not a FK for the same reason as conversations.user_id.
  user_id text NOT NULL DEFAULT '',
  provider_id text NOT NULL,
  base_url text NOT NULL,
  encrypted_api_key text,
  model text NOT NULL DEFAULT '',
  -- Kept during migration from the original split-model implementation.
  default_chat_model text NOT NULL DEFAULT '',
  default_copilot_model text NOT NULL DEFAULT '',
  models_cache_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  models_cached_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

ALTER TABLE assistant.provider_settings
  ADD COLUMN IF NOT EXISTS model text NOT NULL DEFAULT '';

ALTER TABLE assistant.provider_settings
  ADD COLUMN IF NOT EXISTS models_cache_json jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE assistant.provider_settings
  ADD COLUMN IF NOT EXISTS models_cached_at timestamptz;

UPDATE assistant.provider_settings
SET model = COALESCE(
  NULLIF(model, ''),
  NULLIF(default_chat_model, ''),
  default_copilot_model,
  ''
)
WHERE model = '';

-- BEAM AI owns the upstream SayGM credential. Provider-specific user keys must
-- never be forwarded to the managed proxy or retained as BEAM AI credentials.
UPDATE assistant.provider_settings
SET provider_id = 'beam-ai',
    base_url = 'beam://ai',
    encrypted_api_key = NULL,
    model = '',
    default_chat_model = '',
    default_copilot_model = '',
    models_cache_json = '[]'::jsonb,
    models_cached_at = NULL,
    updated_at = now()
WHERE provider_id <> 'beam-ai';

UPDATE assistant.provider_settings
SET base_url = 'beam://ai',
    encrypted_api_key = NULL,
    models_cache_json = '[]'::jsonb,
    models_cached_at = NULL,
    updated_at = now()
WHERE provider_id = 'beam-ai'
  AND (base_url <> 'beam://ai' OR encrypted_api_key IS NOT NULL);

CREATE TABLE IF NOT EXISTS assistant.model_catalog_cache (
  cache_key text PRIMARY KEY,
  provider_id text NOT NULL,
  base_url text NOT NULL,
  models_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  cached_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assistant_model_catalog_provider
  ON assistant.model_catalog_cache(provider_id, base_url);

CREATE TABLE IF NOT EXISTS assistant.operation_plans (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  project_id text REFERENCES identity.projects(id) ON DELETE SET NULL,
  user_id text,
  conversation_id text REFERENCES assistant.conversations(id) ON DELETE SET NULL,
  intent text NOT NULL,
  summary text NOT NULL,
  status text NOT NULL,
  plan_json jsonb NOT NULL,
  validation_hash text,
  idempotency_key text NOT NULL,
  confirmed_at timestamptz,
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_operation_plans_status_check CHECK (
    status IN (
      'draft', 'needs_input', 'ready', 'confirmed', 'running',
      'completed', 'failed', 'cancelled'
    )
  ),
  CONSTRAINT assistant_operation_plans_idempotency_unique
    UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS assistant.audit_events (
  id text PRIMARY KEY,
  plan_id text NOT NULL REFERENCES assistant.operation_plans(id) ON DELETE CASCADE,
  operation_id text,
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  project_id text REFERENCES identity.projects(id) ON DELETE SET NULL,
  user_id text,
  action text NOT NULL,
  status text NOT NULL,
  details_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_audit_events_status_check CHECK (
    status IN ('requested', 'accepted', 'rejected', 'started', 'succeeded', 'failed')
  )
);

CREATE TABLE IF NOT EXISTS studio.beam_environment_templates (
  organization_id text NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  base_url text NOT NULL,
  coordinator_url text NOT NULL,
  nats_url text NOT NULL,
  auth_url text NOT NULL,
  api_url text NOT NULL,
  registry_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, key)
);

CREATE TABLE IF NOT EXISTS studio.beam_environment_settings (
  organization_id text PRIMARY KEY REFERENCES identity.organizations(id) ON DELETE CASCADE,
  default_template_key text NOT NULL DEFAULT 'prod',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_studio_beam_environment_templates_org
  ON studio.beam_environment_templates(organization_id, key);

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
  preparation_json jsonb,
  execution_json jsonb,
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

CREATE INDEX IF NOT EXISTS idx_assistant_conversations_owner
  ON assistant.conversations(organization_id, user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_conversation
  ON assistant.messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_assistant_provider_settings_provider
  ON assistant.provider_settings(organization_id, provider_id);
CREATE INDEX IF NOT EXISTS idx_assistant_operation_plans_owner
  ON assistant.operation_plans(organization_id, project_id, user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistant_audit_events_plan
  ON assistant.audit_events(plan_id, created_at);

-- ---------------------------------------------------------------------------
-- Credit enforcement for billable actions
--
-- An organization holds one credit pool but may issue many API keys against it,
-- each with its own cap, monthly budget and usage reporting. A billable action
-- must therefore name the key it is charged to: choosing one implicitly would
-- spend a cap the operator assigned elsewhere and would attribute the usage to
-- the wrong key. Transfers already carry this binding; workflows get it
-- here.
-- ---------------------------------------------------------------------------

ALTER TABLE workflow.templates
  ADD COLUMN IF NOT EXISTS api_key_id text;

-- Credit is reserved before a run is enqueued and settled once the run reaches a
-- terminal state. Keeping the reservation key on the run is what lets settlement
-- run asynchronously without blocking run progression, and what makes a retried
-- settlement idempotent. Settled rows are kept as an audit trail.
ALTER TABLE execution.workflow_runs
  ADD COLUMN IF NOT EXISTS credit_operation_key text,
  ADD COLUMN IF NOT EXISTS credit_settled_at timestamptz;

-- The settler scans only unsettled runs holding a reservation, which is a small
-- slice of each table.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_credit_unsettled
  ON execution.workflow_runs (status)
  WHERE credit_operation_key IS NOT NULL AND credit_settled_at IS NULL;

-- The legacy transfer tables predate this schema file and are not created here,
-- so extend them only where they are already present.
DO $$
BEGIN
  IF to_regclass('public.runs') IS NOT NULL THEN
    ALTER TABLE public.runs
      ADD COLUMN IF NOT EXISTS credit_operation_key text,
      ADD COLUMN IF NOT EXISTS credit_settled_at timestamptz;
    CREATE INDEX IF NOT EXISTS idx_runs_credit_unsettled
      ON public.runs (status)
      WHERE credit_operation_key IS NOT NULL AND credit_settled_at IS NULL;
  END IF;
END
$$;

-- Remove retired Beam Transfer step options
-- (postgres-migrations/0038_transfer_step_config_cleanup.sql). Frozen
-- definitions and run snapshots stay immutable history.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'transfer_templates'
      AND column_name = 'test_mode'
  ) THEN
    ALTER TABLE public.transfer_templates DROP COLUMN test_mode;
  END IF;
END
$$;

UPDATE workflow.steps
SET config_json = config_json - 'testMode'
WHERE action_package_name = '@beam/transfer'
  AND config_json ? 'testMode';

-- Additive foundation; the Job cutover has its own drain/integrity gate.
ALTER TABLE workflow.templates
  ADD COLUMN IF NOT EXISTS input_schema_json jsonb NOT NULL DEFAULT '{"type":"object","additionalProperties":true}'::jsonb,
  ADD COLUMN IF NOT EXISTS output_contract_json jsonb NOT NULL DEFAULT '{"schema":{"type":"object","additionalProperties":false},"bindings":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS agent_bindings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS resource_bindings_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE workflow.steps
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'action' CHECK (kind IN ('action','workflow')),
  ADD COLUMN IF NOT EXISTS called_workflow_id text REFERENCES workflow.templates(id) ON DELETE RESTRICT;
ALTER TABLE workflow.steps ALTER COLUMN action_package_name DROP NOT NULL;

ALTER TABLE execution.workflow_runs
  ADD COLUMN IF NOT EXISTS parent_run_id text REFERENCES execution.workflow_runs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS root_run_id text REFERENCES execution.workflow_runs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS invoking_step_run_id text,
  ADD COLUMN IF NOT EXISTS invocation_attempt integer CHECK (invocation_attempt > 0),
  ADD COLUMN IF NOT EXISTS execution_context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS output_validation text NOT NULL DEFAULT 'unvalidated'
    CHECK (output_validation IN ('unvalidated','valid','invalid'));
CREATE UNIQUE INDEX IF NOT EXISTS workflow_child_invocation_unique
  ON execution.workflow_runs(invoking_step_run_id,invocation_attempt)
  WHERE invoking_step_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workflow_runs_parent ON execution.workflow_runs(parent_run_id);
CREATE INDEX IF NOT EXISTS workflow_runs_root ON execution.workflow_runs(root_run_id);

ALTER TABLE execution.workflow_step_runs
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'action' CHECK (kind IN ('action','workflow')),
  ADD COLUMN IF NOT EXISTS child_run_id text REFERENCES execution.workflow_runs(id) ON DELETE RESTRICT;
ALTER TABLE execution.workflow_step_runs ALTER COLUMN action_package_name DROP NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workflow_invoking_step_fk' AND conrelid='execution.workflow_runs'::regclass) THEN
    ALTER TABLE execution.workflow_runs ADD CONSTRAINT workflow_invoking_step_fk
      FOREIGN KEY(invoking_step_run_id) REFERENCES execution.workflow_step_runs(id)
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION workflow.protect_plan_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.compiled_plan_json IS DISTINCT FROM OLD.compiled_plan_json
     OR NEW.manifest_snapshot_json IS DISTINCT FROM OLD.manifest_snapshot_json
     OR NEW.workflow_template_id IS DISTINCT FROM OLD.workflow_template_id
     OR NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'Workflow definition revisions are immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS immutable_workflow_revision ON workflow.plan_versions;
CREATE TRIGGER immutable_workflow_revision BEFORE UPDATE ON workflow.plan_versions
  FOR EACH ROW EXECUTE FUNCTION workflow.protect_plan_revision();

CREATE OR REPLACE FUNCTION execution.protect_workflow_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.workflow_plan_version_id IS NOT NULL AND (
       NEW.template_snapshot_json IS DISTINCT FROM OLD.template_snapshot_json
    OR NEW.resolved_steps_json IS DISTINCT FROM OLD.resolved_steps_json
    OR NEW.input_json IS DISTINCT FROM OLD.input_json
    OR NEW.execution_context_json IS DISTINCT FROM OLD.execution_context_json
    OR NEW.workflow_plan_version_id IS DISTINCT FROM OLD.workflow_plan_version_id
    OR NEW.parent_run_id IS DISTINCT FROM OLD.parent_run_id
    OR NEW.root_run_id IS DISTINCT FROM OLD.root_run_id
    OR NEW.invoking_step_run_id IS DISTINCT FROM OLD.invoking_step_run_id
    OR NEW.invocation_attempt IS DISTINCT FROM OLD.invocation_attempt) THEN
    RAISE EXCEPTION 'Workflow run snapshots and invocation identities are immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS immutable_workflow_run ON execution.workflow_runs;
CREATE TRIGGER immutable_workflow_run BEFORE UPDATE ON execution.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION execution.protect_workflow_snapshot();

ALTER TABLE workflow.templates ADD COLUMN IF NOT EXISTS migration_source_json jsonb;
ALTER TABLE execution.workflow_runs
  ADD COLUMN IF NOT EXISTS historical boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS historical_snapshot_json jsonb;
ALTER TABLE execution.workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_output_validation_check;
ALTER TABLE execution.workflow_runs ADD CONSTRAINT workflow_runs_output_validation_check
  CHECK (output_validation IN ('unvalidated','valid','invalid','historical'));

CREATE OR REPLACE FUNCTION execution.protect_workflow_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.workflow_plan_version_id IS NOT NULL OR OLD.historical) AND (
       NEW.historical IS DISTINCT FROM OLD.historical
    OR NEW.historical_snapshot_json IS DISTINCT FROM OLD.historical_snapshot_json
    OR NEW.template_snapshot_json IS DISTINCT FROM OLD.template_snapshot_json
    OR NEW.resolved_steps_json IS DISTINCT FROM OLD.resolved_steps_json
    OR NEW.input_json IS DISTINCT FROM OLD.input_json
    OR NEW.execution_context_json IS DISTINCT FROM OLD.execution_context_json
    OR NEW.workflow_plan_version_id IS DISTINCT FROM OLD.workflow_plan_version_id
    OR NEW.parent_run_id IS DISTINCT FROM OLD.parent_run_id
    OR NEW.root_run_id IS DISTINCT FROM OLD.root_run_id
    OR NEW.invoking_step_run_id IS DISTINCT FROM OLD.invoking_step_run_id
    OR NEW.invocation_attempt IS DISTINCT FROM OLD.invocation_attempt) THEN
    RAISE EXCEPTION 'Workflow run snapshots and invocation identities are immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS immutable_workflow_run ON execution.workflow_runs;
CREATE TRIGGER immutable_workflow_run BEFORE UPDATE ON execution.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION execution.protect_workflow_snapshot();
ALTER TABLE workflow.templates ADD COLUMN IF NOT EXISTS room_context_json jsonb;

-- Scoped control capabilities are operational secrets, never definition/run snapshots.
CREATE TABLE IF NOT EXISTS execution.workflow_run_capabilities (
  workflow_run_id text PRIMARY KEY REFERENCES execution.workflow_runs(id) ON DELETE CASCADE,
  authorization_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE workflow.templates DROP CONSTRAINT IF EXISTS workflow_room_context_shape;
ALTER TABLE workflow.templates ADD CONSTRAINT workflow_room_context_shape CHECK (
  room_context_json IS NULL OR (jsonb_typeof(room_context_json)='object'
    AND jsonb_typeof(room_context_json->'environmentTemplateKey')='string'
    AND jsonb_typeof(room_context_json->'roomId')='string'
    AND room_context_json ? 'environmentTemplateKey' AND room_context_json ? 'roomId')
);

-- Workflow executor assignments (0025).
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
ALTER TABLE execution.workflow_step_runs ADD COLUMN IF NOT EXISTS resource_execution_json jsonb NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS executor_assignments_active ON execution.executor_assignments(backend,state,lease_expires_at);
CREATE INDEX IF NOT EXISTS executor_assignments_run ON execution.executor_assignments(workflow_run_id,created_at);
CREATE TABLE IF NOT EXISTS execution.executor_assignment_capabilities (
  assignment_id text PRIMARY KEY REFERENCES execution.executor_assignments(id) ON DELETE CASCADE,
  authorization_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Billing intent belongs to an invocation attempt, not to a mutable run column.
CREATE TABLE IF NOT EXISTS execution.workflow_billing_attempts (
  operation_key text PRIMARY KEY,
  workflow_run_id text NOT NULL REFERENCES execution.workflow_runs(id),
  attempt integer NOT NULL CHECK(attempt > 0),
  organization_id text NOT NULL,
  credential_id text,
  authority_key_id text,
  reservation_state text NOT NULL DEFAULT 'pending' CHECK(reservation_state IN ('pending','reserved','denied')),
  reserve_started_at timestamptz,
  outcome text CHECK(outcome IN ('completed','failed','cancelled')),
  settled_at timestamptz,
  error_code text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workflow_run_id,attempt)
);
CREATE INDEX IF NOT EXISTS workflow_billing_unsettled ON execution.workflow_billing_attempts(created_at)
  WHERE outcome IS NOT NULL AND settled_at IS NULL;

-- Retain existing holds, including Job records imported into canonical history.
CREATE OR REPLACE FUNCTION execution.capture_workflow_billing_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_attempt integer;
BEGIN
  IF NEW.credit_operation_key IS NOT NULL THEN
    SELECT COALESCE(MAX(attempt),0)+1 INTO next_attempt FROM execution.workflow_billing_attempts WHERE workflow_run_id=NEW.id;
    INSERT INTO execution.workflow_billing_attempts(operation_key,workflow_run_id,attempt,organization_id,credential_id,reservation_state,outcome,settled_at)
    VALUES(NEW.credit_operation_key,NEW.id,next_attempt,NEW.organization_id,
      COALESCE(NEW.execution_context_json #>> '{billing,apiKeyId}',NEW.template_snapshot_json #>> '{workflowTemplate,apiKeyId}'),
      CASE WHEN NEW.historical THEN 'reserved' ELSE 'pending' END,
      CASE WHEN NEW.status IN ('completed','failed','cancelled') THEN NEW.status ELSE NULL END,NEW.credit_settled_at)
    ON CONFLICT(operation_key) DO NOTHING;
    IF EXISTS(SELECT 1 FROM execution.workflow_billing_attempts
      WHERE operation_key=NEW.credit_operation_key AND (workflow_run_id<>NEW.id OR organization_id<>NEW.organization_id)) THEN
      RAISE EXCEPTION 'Workflow billing identity belongs to another invocation';
    END IF;
    IF NEW.status IN ('completed','failed','cancelled') THEN
      UPDATE execution.workflow_billing_attempts SET outcome=COALESCE(outcome,NEW.status),updated_at=now()
      WHERE operation_key=NEW.credit_operation_key;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS capture_workflow_billing_attempt ON execution.workflow_runs;
CREATE TRIGGER capture_workflow_billing_attempt AFTER INSERT OR UPDATE OF status,credit_operation_key ON execution.workflow_runs
FOR EACH ROW EXECUTE FUNCTION execution.capture_workflow_billing_attempt();

INSERT INTO execution.workflow_billing_attempts(operation_key,workflow_run_id,attempt,organization_id,credential_id,reservation_state,outcome,settled_at)
SELECT credit_operation_key,id,1,organization_id,
  COALESCE(execution_context_json #>> '{billing,apiKeyId}',template_snapshot_json #>> '{workflowTemplate,apiKeyId}'),
  'reserved',CASE WHEN status IN ('completed','failed','cancelled') THEN status ELSE NULL END,credit_settled_at
FROM execution.workflow_runs WHERE credit_operation_key IS NOT NULL
ON CONFLICT(operation_key) DO NOTHING;

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM execution.workflow_runs r
    LEFT JOIN execution.workflow_billing_attempts b ON b.operation_key=r.credit_operation_key
    WHERE r.credit_operation_key IS NOT NULL AND
      (b.operation_key IS NULL OR b.workflow_run_id<>r.id OR b.organization_id<>r.organization_id)) THEN
    RAISE EXCEPTION 'Workflow billing history failed ownership verification';
  END IF;
END $$;

-- Organization sidebar structure is authoring metadata, independent of execution.
CREATE TABLE IF NOT EXISTS workflow.sidebar_hierarchy (
  child_id text PRIMARY KEY REFERENCES workflow.templates(id) ON DELETE CASCADE,
  parent_id text NOT NULL REFERENCES workflow.templates(id) ON DELETE CASCADE,
  CHECK (child_id <> parent_id)
);
CREATE INDEX IF NOT EXISTS workflow_sidebar_hierarchy_parent ON workflow.sidebar_hierarchy(parent_id);

-- Private backend evidence; process paths and fencing nonces are not run output.
CREATE TABLE IF NOT EXISTS execution.executor_process_ownership (
  assignment_id text PRIMARY KEY REFERENCES execution.executor_assignments(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'preparing' CHECK(state IN ('preparing','ready','stopped')),
  record_path text,
  record_nonce text,
  owner_scope text,
  owner_host_identity text,
  owner_boot_id text,
  owner_native_scope text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(state<>'ready' OR (record_path IS NOT NULL AND record_nonce IS NOT NULL AND owner_scope IS NOT NULL
    AND ((owner_host_identity IS NULL AND owner_boot_id IS NULL AND owner_native_scope IS NULL)
      OR (owner_host_identity IS NOT NULL AND owner_boot_id IS NOT NULL AND owner_native_scope IS NOT NULL))))
);
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

-- Correct only provisional warnings contradicted by independent resource/process cleanup.
WITH verified AS MATERIALIZED (
  SELECT a.id AS assignment_id, t.id AS task_id, s.id AS step_id
  FROM execution.executor_assignments a
  JOIN execution.workflow_tasks t ON t.id=a.task_id AND t.attempt_count=a.attempt
  JOIN execution.workflow_step_runs s ON s.id=t.workflow_step_run_id
  JOIN execution.workflow_runs r ON r.id=t.workflow_run_id
  WHERE a.state='cancelled' AND t.status='cancelled' AND s.status='cancelled' AND r.status='cancelled'
    AND a.executor_stopped_at IS NOT NULL AND a.cleanup_confirmed_at IS NOT NULL
    AND s.resource_execution_json->>'kind'='room-publication'
    AND s.resource_execution_json->>'state'='cancelled'
), assignments AS (
  UPDATE execution.executor_assignments a
  SET error_json='{"code":"executor_cancelled","message":"Execution cancelled."}'::jsonb, updated_at=now()
  FROM verified v WHERE a.id=v.assignment_id
    AND a.error_json->>'message'='Room publication cleanup remains unconfirmed.'
  RETURNING a.id
), tasks AS (
  UPDATE execution.workflow_tasks t SET error='Execution cancelled.', updated_at=now()
  FROM verified v WHERE t.id=v.task_id AND t.error='Room publication cleanup remains unconfirmed.'
  RETURNING t.id
), attempts AS (
  UPDATE execution.workflow_task_attempts t SET error='Execution cancelled.'
  FROM verified v JOIN execution.executor_assignments a ON a.id=v.assignment_id
  WHERE t.workflow_task_id=v.task_id AND t.attempt_number=a.attempt
    AND t.error='Room publication cleanup remains unconfirmed.'
  RETURNING t.id
)
UPDATE execution.workflow_step_runs s SET error='Execution cancelled.', updated_at=now()
FROM verified v WHERE s.id=v.step_id AND s.error='Room publication cleanup remains unconfirmed.';
-- One immutable collection identity per task attempt. Pending evidence can gain
-- verified copies/transfers, but cannot change artifact bytes or provenance.
CREATE TABLE IF NOT EXISTS execution.workflow_artifact_identities (
  artifact_id text PRIMARY KEY,
  workflow_run_id text NOT NULL REFERENCES execution.workflow_runs(id) ON DELETE CASCADE,
  task_id text NOT NULL REFERENCES execution.workflow_tasks(id) ON DELETE CASCADE,
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL CHECK(size_bytes >= 0),
  media_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS execution.workflow_artifact_manifests (
  id text PRIMARY KEY,
  workflow_run_id text NOT NULL REFERENCES execution.workflow_runs(id) ON DELETE CASCADE,
  workflow_step_run_id text NOT NULL REFERENCES execution.workflow_step_runs(id) ON DELETE CASCADE,
  task_id text NOT NULL REFERENCES execution.workflow_tasks(id) ON DELETE CASCADE,
  assignment_id text NOT NULL REFERENCES execution.executor_assignments(id) ON DELETE CASCADE,
  attempt integer NOT NULL,
  publication_id text NOT NULL,
  artifact_identity_hash text NOT NULL,
  artifacts_json jsonb NOT NULL,
  result_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  error text,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_artifact_manifests_attempt_unique UNIQUE(task_id, attempt),
  CONSTRAINT workflow_artifact_manifests_publication_unique UNIQUE(publication_id),
  CONSTRAINT workflow_artifact_manifests_status_check CHECK(status IN ('pending','accepted','unavailable','failed'))
);

CREATE TABLE IF NOT EXISTS execution.workflow_artifact_locations (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  manifest_id text NOT NULL REFERENCES execution.workflow_artifact_manifests(id) ON DELETE CASCADE,
  artifact_id text NOT NULL,
  kind text NOT NULL,
  locator text NOT NULL,
  member_id text,
  room_id text NOT NULL,
  channel_id text NOT NULL,
  source_member_id text NOT NULL,
  verified_at timestamptz NOT NULL,
  verification_basis text NOT NULL,
  durable_until timestamptz,
  retention_obligation_id text,
  state text NOT NULL DEFAULT 'available',
  lost_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_artifact_locations_kind_check CHECK(kind IN ('member','storage')),
  CONSTRAINT workflow_artifact_locations_basis_check CHECK(verification_basis IN ('local_hash','recipient_final_receipt','provider_finalization')),
  CONSTRAINT workflow_artifact_locations_state_check CHECK(state IN ('available','lost','revoked'))
);

ALTER TABLE execution.workflow_artifact_locations
  ADD COLUMN IF NOT EXISTS id bigint GENERATED BY DEFAULT AS IDENTITY;
UPDATE execution.workflow_artifact_locations SET id=DEFAULT WHERE id IS NULL;
ALTER TABLE execution.workflow_artifact_locations
  DROP CONSTRAINT IF EXISTS workflow_artifact_locations_pkey;
ALTER TABLE execution.workflow_artifact_locations
  ADD CONSTRAINT workflow_artifact_locations_pkey PRIMARY KEY(id);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_artifact_locations_member_identity
  ON execution.workflow_artifact_locations
  (manifest_id,artifact_id,kind,locator,COALESCE(member_id,''));

CREATE TABLE IF NOT EXISTS execution.workflow_artifact_transfers (
  manifest_id text NOT NULL REFERENCES execution.workflow_artifact_manifests(id) ON DELETE CASCADE,
  artifact_id text NOT NULL,
  destination_member_id text NOT NULL,
  publication_id text NOT NULL,
  transfer_id text NOT NULL,
  room_id text NOT NULL,
  channel_id text NOT NULL,
  source_member_id text NOT NULL,
  status text NOT NULL,
  full_delivery_verified boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(manifest_id, artifact_id, destination_member_id),
  CONSTRAINT workflow_artifact_transfers_status_check CHECK(status IN ('completed','partial','failed'))
);

CREATE TABLE IF NOT EXISTS execution.workflow_artifact_obligations (
  obligation_id text PRIMARY KEY,
  manifest_id text NOT NULL REFERENCES execution.workflow_artifact_manifests(id) ON DELETE CASCADE,
  artifact_id text NOT NULL,
  required_until timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  released_at timestamptz,
  cleanup_confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_artifact_obligations_status_check CHECK(status IN ('pending','active','releasing','released')),
  CONSTRAINT workflow_artifact_obligations_identity_unique UNIQUE(manifest_id, artifact_id, obligation_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_artifact_locations_recovery
  ON execution.workflow_artifact_locations(state, manifest_id);
CREATE INDEX IF NOT EXISTS idx_workflow_artifact_obligations_active
  ON execution.workflow_artifact_obligations(manifest_id) WHERE status='active';

CREATE TABLE IF NOT EXISTS execution.workflow_artifact_provider_attestations (
  manifest_id text NOT NULL REFERENCES execution.workflow_artifact_manifests(id) ON DELETE CASCADE,
  artifact_id text NOT NULL,
  member_id text NOT NULL,
  locator text NOT NULL,
  bucket text NOT NULL,
  object_key text NOT NULL,
  version_id text NOT NULL,
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  retention_mode text NOT NULL DEFAULT 'COMPLIANCE',
  retained_until timestamptz NOT NULL,
  verified_at timestamptz NOT NULL,
  PRIMARY KEY (manifest_id, artifact_id, member_id, locator),
  CONSTRAINT workflow_artifact_provider_retention_mode_check CHECK (retention_mode='COMPLIANCE')
);

ALTER TABLE execution.workflow_artifact_obligations
  ADD COLUMN IF NOT EXISTS cleanup_confirmed_at timestamptz;
ALTER TABLE execution.workflow_artifact_obligations
  DROP CONSTRAINT IF EXISTS workflow_artifact_obligations_status_check;
ALTER TABLE execution.workflow_artifact_obligations
  ADD CONSTRAINT workflow_artifact_obligations_status_check
  CHECK(status IN ('pending','active','releasing','released'));

UPDATE execution.workflow_artifact_obligations o
SET cleanup_confirmed_at=COALESCE(o.released_at,now())
FROM execution.workflow_artifact_manifests m
WHERE o.manifest_id=m.id AND o.status='released'
  AND o.cleanup_confirmed_at IS NULL
  AND EXISTS (
    SELECT 1 FROM agent_control.commands c
    WHERE c.operation='action.artifact.release' AND c.state='completed'
      AND c.payload_json->>'retentionObligationId'=o.obligation_id
      AND c.payload_json->>'assignmentId'=m.assignment_id
      AND c.result_json->>'retentionObligationId'=o.obligation_id
      AND c.result_json->>'assignmentId'=m.assignment_id
      AND c.result_json->>'cleanupConfirmed'='true'
  );
UPDATE execution.workflow_artifact_obligations
SET status='releasing'
WHERE status='released' AND cleanup_confirmed_at IS NULL;
-- A run has one durable orchestration authority. An owner may renew its lease;
-- takeover advances the generation and fences every earlier assignment.
CREATE TABLE IF NOT EXISTS execution.workflow_run_authority (
  workflow_run_id text PRIMARY KEY REFERENCES execution.workflow_runs(id) ON DELETE CASCADE,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  owner_id text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO execution.workflow_run_authority(workflow_run_id,generation,owner_id,lease_expires_at)
SELECT id,1,'migration',clock_timestamp()
FROM execution.workflow_runs
WHERE status IN ('queued','running','cancel_requested')
ON CONFLICT (workflow_run_id) DO NOTHING;

ALTER TABLE execution.executor_assignments
  ADD COLUMN IF NOT EXISTS authority_generation bigint NOT NULL DEFAULT 1
    CHECK (authority_generation > 0),
  ADD COLUMN IF NOT EXISTS reserved_output_bytes bigint NOT NULL DEFAULT 0
    CHECK (reserved_output_bytes >= 0);

ALTER TABLE execution.workflow_tasks
  ADD COLUMN IF NOT EXISTS admission_deadline_at timestamptz;

CREATE INDEX IF NOT EXISTS workflow_tasks_admission_deadline
  ON execution.workflow_tasks(admission_deadline_at)
  WHERE status IN ('queued','retry_scheduled');

ALTER TABLE studio.room_storage_transfer_jobs
  ADD COLUMN IF NOT EXISTS admission_deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS assignment_id text,
  ADD COLUMN IF NOT EXISTS assignment_attempt integer,
  ADD COLUMN IF NOT EXISTS authority_generation bigint,
  ADD COLUMN IF NOT EXISTS provider_cleanup_confirmed_at timestamptz;

UPDATE studio.room_storage_transfer_jobs
SET provider_cleanup_confirmed_at=COALESCE(provider_cleanup_confirmed_at,updated_at)
WHERE provider_cleanup_confirmed_at IS NULL AND (
  (status IN ('completed','partial','cancelled') AND error_code IS NULL)
  OR (status='failed' AND coordinator_started=false AND transfer_id IS NULL
      AND error_code IS DISTINCT FROM 'room_storage_cleanup_incomplete')
);

ALTER TABLE studio.room_storage_transfer_jobs
  DROP CONSTRAINT IF EXISTS room_storage_assignment_attempt_positive,
  DROP CONSTRAINT IF EXISTS room_storage_authority_generation_positive;

ALTER TABLE studio.room_storage_transfer_jobs
  ADD CONSTRAINT room_storage_assignment_attempt_positive
    CHECK (assignment_attempt IS NULL OR assignment_attempt > 0),
  ADD CONSTRAINT room_storage_authority_generation_positive
    CHECK (authority_generation IS NULL OR authority_generation > 0);

CREATE INDEX IF NOT EXISTS room_storage_transfer_admission
  ON studio.room_storage_transfer_jobs(organization_id,status,admission_deadline_at);

-- Protected Web Agent action control. Legacy control commands retain their
-- original transport; a room-mls/v1 command is never emitted on that socket.
ALTER TABLE agent_control.commands
  ADD COLUMN IF NOT EXISTS transport text NOT NULL DEFAULT 'agent-control';
ALTER TABLE agent_control.commands
  DROP CONSTRAINT IF EXISTS agent_commands_transport_check;
ALTER TABLE agent_control.commands
  ADD CONSTRAINT agent_commands_transport_check
    CHECK (transport IN ('agent-control','room-mls/v1'));

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
  reconciliation_attempts integer NOT NULL DEFAULT 0,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, command_id),
  UNIQUE (reply_id)
);
CREATE INDEX IF NOT EXISTS room_action_deliveries_reconcile
  ON execution.room_action_deliveries(state,updated_at)
  WHERE state NOT IN ('terminal','blocked');

ALTER TABLE execution.room_action_deliveries
  ADD COLUMN IF NOT EXISTS reconciliation_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE execution.room_action_deliveries
  DROP CONSTRAINT IF EXISTS room_action_reconciliation_attempts_check;
ALTER TABLE execution.room_action_deliveries
  ADD CONSTRAINT room_action_reconciliation_attempts_check
    CHECK (reconciliation_attempts BETWEEN 0 AND 64);

-- Instance governance.
--
-- Studio learns organizations from Beam and created a tenant row for any of
-- them lazily, so every Beam account that could reach a deployment could use
-- it: the session check asks whether an organization belongs to the caller,
-- never whether it belongs to this deployment. These two tables are the
-- missing half of that sentence. They record a decision this deployment makes
-- about who it serves, rather than one Beam makes on its behalf.
--
-- Admission is keyed on organization because every tenant-owned record is, and
-- because machine tokens carry an organization but no user, so a per-person
-- rule would be unenforceable on that plane while reading as though it covered
-- everything.
CREATE TABLE IF NOT EXISTS studio.instance (
  id text PRIMARY KEY DEFAULT 'singleton',
  state text NOT NULL DEFAULT 'unclaimed',
  -- Deliberately not a foreign key to identity.organizations: that table is
  -- populated lazily by whichever write path needs it first, and admission has
  -- to be decidable before any write happens. Same reasoning as
  -- agent_control.room_labels.
  owner_organization_id text,
  join_policy text NOT NULL DEFAULT 'closed',
  claimed_at timestamptz,
  claimed_by_user_id text,
  claimed_by_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_instance_singleton_check CHECK (id = 'singleton'),
  CONSTRAINT studio_instance_state_check CHECK (
    state IN ('unclaimed','adopted','claimed')
  ),
  CONSTRAINT studio_instance_join_policy_check CHECK (
    join_policy IN ('open','request','closed')
  ),
  CONSTRAINT studio_instance_claimed_has_owner_check CHECK (
    state <> 'claimed' OR owner_organization_id IS NOT NULL
  )
);

CREATE TABLE IF NOT EXISTS studio.instance_organizations (
  organization_id text PRIMARY KEY,
  role text NOT NULL DEFAULT 'member',
  status text NOT NULL DEFAULT 'admitted',
  -- Beam identity strings rather than foreign keys: identity.users is never
  -- written by application code, so a reference would reject every insert.
  requested_by_user_id text,
  requested_by_email text,
  decided_by_user_id text,
  decided_by_email text,
  requested_at timestamptz,
  decided_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_instance_organizations_role_check CHECK (role IN ('owner','member')),
  CONSTRAINT studio_instance_organizations_status_check CHECK (
    status IN ('admitted','pending','revoked')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS studio_instance_single_owner
  ON studio.instance_organizations(role) WHERE role = 'owner';

-- Identifies this installation to Beam when it asks for its instance key: the
-- organization API key Studio holds for the owner organization after consent.
ALTER TABLE studio.instance
  ADD COLUMN IF NOT EXISTS instance_id uuid NOT NULL DEFAULT gen_random_uuid();

-- The instance key is a beam_api_key credential tagged
-- external_source='beam_studio_instance'; an organization holds at most one
-- active one. Rotation adds a version to the same credential.
CREATE UNIQUE INDEX IF NOT EXISTS secrets_credentials_one_active_instance_key
  ON secrets.credentials(organization_id)
  WHERE external_source = 'beam_studio_instance' AND status = 'active';
CREATE INDEX IF NOT EXISTS studio_instance_organizations_status
  ON studio.instance_organizations(status, created_at);

-- Upgrade seed.
--
-- 'adopted' is the state of a deployment that was already serving people when
-- this model arrived. It is deliberately not 'unclaimed', which serves nobody:
-- applying that to a live installation would sign out its operator along with
-- everyone else, on the very deploy that ships the fix. It is not 'claimed'
-- either, because choosing an owner automatically is the land-grab the claim
-- code exists to prevent, and the seed cannot tell which of the existing
-- organizations is the team that runs the host.
--
-- An adopted instance therefore behaves as it did before: its organizations
-- are admitted, the policy is open, and nothing changes until its owner claims
-- it. Only then can it be closed.
--
-- A genuinely new database has no organizations, seeds unclaimed, and serves
-- nobody until it is claimed.
--
-- This runs in the same transaction as the DDL above, so there is no window in
-- which the tables exist unseeded.
INSERT INTO studio.instance (id, state, join_policy)
SELECT
  'singleton',
  CASE
    WHEN EXISTS (
      SELECT 1 FROM identity.organizations WHERE id <> '__local__'
    ) THEN 'adopted'
    ELSE 'unclaimed'
  END,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM identity.organizations WHERE id <> '__local__'
    ) THEN 'open'
    ELSE 'closed'
  END
WHERE NOT EXISTS (SELECT 1 FROM studio.instance);

INSERT INTO studio.instance_organizations (organization_id, role, status, note)
SELECT o.id, 'member', 'admitted', 'adopted from existing tenants at upgrade'
  FROM identity.organizations o
 WHERE o.id <> '__local__'
   AND NOT EXISTS (SELECT 1 FROM studio.instance_organizations)
ON CONFLICT (organization_id) DO NOTHING;
