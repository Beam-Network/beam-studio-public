CREATE SCHEMA IF NOT EXISTS actions;

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
  owner_organization_id text,
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
  user_id text,
  organization_id text,
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

CREATE INDEX IF NOT EXISTS idx_actions_packages_scope ON actions.packages(scope_id, name);
CREATE INDEX IF NOT EXISTS idx_actions_packages_category ON actions.packages(category_id, display_name);
CREATE INDEX IF NOT EXISTS idx_actions_packages_status_trust ON actions.packages(status, trust_level);
CREATE INDEX IF NOT EXISTS idx_actions_package_versions_package ON actions.package_versions(package_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_actions_dist_tags_package ON actions.dist_tags(package_id, tag);
