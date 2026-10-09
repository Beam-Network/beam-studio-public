# Beam Studio PostgreSQL Target Schema

Migration 0023 marks imported executions as historical and preserves original rows.
The `job` schema is removed by the explicit Workflow-first cutover,
which preserves existing PostgreSQL history; the fresh-database guidance below
concerns the earlier SQLite replacement.

Workflow composition adds immutable `workflow.plan_versions` revisions, explicit
input/output contracts, parent/root/invocation links on `execution.workflow_runs`,
and child links on `execution.workflow_step_runs`. A partial unique index fences
duplicate child invocations; snapshot triggers reject changes to frozen execution
intent. See [Workflow composition](workflow-composition.md) and migration 0022.

Migration 0027 records append-only workflow billing attempt identities separately
from a run's current attempt, preserves imported reservation history, and captures
terminal outcomes transactionally. See [Workflow billing](workflow-billing.md).

Migration 0028 adds private executor process ownership references and a preparation
fence. Record paths, nonces and local process scope stay outside business output
and run-history responses. See [Process ownership](action-process-ownership.md).

## Purpose

This document defines the target PostgreSQL database shape for Beam Studio once
SQLite and the legacy `beam_orchestration` public schema are retired.

The target database should be named `beam_studio`. Avoid `beam-studio` as the
physical database name because the dash requires quoting in SQL, scripts, and
backup tooling.

`public` should not contain application tables. It can remain empty and locked
down:

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

## Design Principles

- This is a clean cutover target. Do not backfill data from the current SQLite
  database or from the existing `beam_orchestration` database.
- Create a fresh `beam_studio` database, then adapt the application code to
  write and read this schema directly.
- PostgreSQL is the durable source of truth for Studio state.
- Schema names represent product domains, not implementation eras.
- `organization_id` is required on tenant-owned data.
- `project_id` is nullable on tenant-owned data.
- `project_id IS NULL` means organization-level scope.
- `project_id IS NOT NULL` means project-level scope.
- Credentials are first-class secrets and are not split into provider-specific
  tables.
- Actions declare which credential capabilities they need.
- Workflow execution state replaces legacy transfer, run, schedule, and log
  tables.
- NATS is a wake-up and task transport layer; PostgreSQL remains authoritative.

## Schemas

```text
beam_studio
+ identity
+ secrets
+ mcp
+ actions
+ workflow
+ execution
+ runtime
+ agent_control
+ studio
+ meta
```

Additional `*.sql` files in `packages/db/src/beam-studio-target-schema.d/` are
applied after the target schema, in name order, when a deployment ships them.

## `agent_control`

Agent control is the durable source of truth for outbound `beam-agentd`
sessions and Studio-issued commands:

```text
agent_control.machines
agent_control.agents
agent_control.enrollments
agent_control.credentials
agent_control.auth_nonces
agent_control.sessions
agent_control.commands
agent_control.events
agent_control.audit_events
```

Enrollment codes, renewable credential secrets, and authentication nonces are
stored only as hashes. Commands are organization-scoped, sequenced per agent,
and unique by `(agent_id, idempotency_key)`. Session generation fences stale
connections; PostgreSQL command state remains authoritative when the process-
local WebSocket registry restarts.

## Cutover Strategy

This redesign should not attempt to preserve existing development data.

Implementation should happen as a clean replacement:

1. Create a new PostgreSQL database named `beam_studio`.
2. Apply the target schemas and tables from this document.
3. Seed static catalogs such as credential types, provider profiles, credential
   capabilities, builtin actions, and action credential requirements.
4. Update configuration so all Studio, API, orchestrator, and worker processes
   use `beam_studio`.
5. Adapt code paths to the new schema names and table shapes.
6. Remove SQLite runtime dependencies and legacy `beam_orchestration` table
   assumptions after the new paths are working.

No data migration scripts are required for existing transfer templates, runs,
schedules, credentials, or logs. Users will recreate Studio configuration in
the new system.

## `identity`

Identity stores the organization, project, user, and service-account context
needed by Studio.

```text
identity.organizations
identity.projects
identity.users
identity.organization_members
identity.project_members
identity.service_accounts
```

### Required Relationships

```text
identity.projects.organization_id -> identity.organizations.id

identity.organization_members.organization_id -> identity.organizations.id
identity.organization_members.user_id -> identity.users.id

identity.project_members.organization_id -> identity.organizations.id
identity.project_members.project_id -> identity.projects.id
identity.project_members.user_id -> identity.users.id

identity.service_accounts.organization_id -> identity.organizations.id
identity.service_accounts.project_id -> identity.projects.id nullable
identity.service_accounts.owner_user_id -> identity.users.id nullable
identity.service_accounts.created_by_id -> identity.users.id nullable
```

### Important Constraints

```text
identity.projects unique (organization_id, slug)
identity.organization_members unique (organization_id, user_id)
identity.project_members unique (project_id, user_id)
identity.service_accounts unique (organization_id, slug)
```

## `secrets`

Secrets owns every credential the Studio can use. Beam API keys, S3-compatible
access keys, webhooks, HTTP tokens, and future provider credentials all use the
same model.

```text
secrets.credential_types
secrets.provider_profiles
secrets.credentials
secrets.credential_versions
secrets.credential_validation_events
secrets.credential_capabilities
secrets.credential_type_capabilities
```

### `secrets.credential_types`

Defines the technical shape of a credential.

Examples:

```text
beam_api_key
s3_compatible_access_key
gcs_service_account
http_bearer_token
slack_webhook
zapier_mcp
```

Suggested columns:

```text
id
slug
display_name
description
secret_schema_json
metadata_schema_json
display_schema_json
validation_policy_json
created_at
updated_at
```

`secret_schema_json` can contain defaults. Defaults should be materialized into
the encrypted payload at save time so future executions stay stable if the type
definition changes.

### `secrets.provider_profiles`

Defines provider-specific metadata and defaults without creating one credential
type per provider.

For object storage, all S3-compatible providers share
`s3_compatible_access_key`, while profiles distinguish `s3`, `r2`, `wasabi`,
`minio`, `backblaze-b2`, and the other supported providers.

Suggested columns:

```text
id
credential_type_id -> secrets.credential_types.id
driver
display_name
description
logo_url
website_url
docs_url
endpoint_template
default_region
default_endpoint_url
required_fields_json
optional_fields_json
field_defaults_json
field_labels_json
metadata_json
enabled
created_at
updated_at
```

### `secrets.credentials`

Stores credential metadata and scope. It does not store secret material.

Suggested columns:

```text
id
organization_id -> identity.organizations.id
project_id -> identity.projects.id nullable
credential_type_id -> secrets.credential_types.id
provider_profile_id -> secrets.provider_profiles.id nullable
name
status
external_id nullable
external_source nullable
prefix nullable
fingerprint_hash nullable
description nullable
metadata_json
created_by_id -> identity.users.id nullable
created_at
updated_at
last_used_at nullable
last_validated_at nullable
expires_at nullable
```

### `secrets.credential_versions`

Stores encrypted, versioned secret payloads.

Suggested columns:

```text
id
credential_id -> secrets.credentials.id
version
encrypted_payload
encryption_key_id
payload_schema_version
status
created_by_id -> identity.users.id nullable
created_at
revoked_at nullable
replaced_by_version_id -> secrets.credential_versions.id nullable
```

`encryption_key_id` holds the id of the vault key that wrote
`encrypted_payload` — `HMAC(key, "beam-studio.key-id.v1")`, truncated, so it is
one-way and safe to read. It used to be the constant `local-vault-secret` and
was never consulted; it is now kept in step with the value beside it, and a
rotation rewrites both together. The ciphertext also carries the same id
internally, so the column is a queryable projection rather than the source of
truth. See "Rotating the vault key" in the README.

### `secrets.credential_validation_events`

Stores validation attempts without exposing secret values.

```text
id
credential_id -> secrets.credentials.id
credential_version_id -> secrets.credential_versions.id nullable
status
checked_at
error_code nullable
error_message nullable
metadata_json
```

### Credential Capabilities

Capabilities allow actions to request behavior instead of enumerating every
provider.

```text
secrets.credential_capabilities
secrets.credential_type_capabilities
```

Examples:

```text
object_storage.read
object_storage.write
object_storage.list
beam.transfer
webhook.send
```

## `mcp`

```text
mcp.tokens
mcp.audit_events
```

These are the only MCP tables. Applying the target schema drops the
`public.mcp_tokens` and `public.mcp_audit_events` pair that the optional legacy
migration used to create, so a query cannot reach a second copy.

`mcp.audit_events` keeps the event's detail — status, client name, error — in
`metadata_json` rather than as columns, since it is detail rather than
structure. `mcp.tokens.scopes_json` is jsonb; the legacy `scopes` column was
text.

Relationships:

```text
mcp.tokens.organization_id -> identity.organizations.id
mcp.tokens.project_id -> identity.projects.id nullable

mcp.audit_events.organization_id -> identity.organizations.id nullable
mcp.audit_events.project_id -> identity.projects.id nullable
mcp.audit_events.token_id -> mcp.tokens.id nullable
```

## `actions`

Actions owns the package registry, versions, distribution tags, and declared
credential requirements.

```text
actions.categories
actions.scopes
actions.scope_members
actions.packages
actions.package_versions
actions.dist_tags
actions.credential_requirements
```

Relationships:

```text
actions.categories.parent_id -> actions.categories.id nullable

actions.scopes.owner_organization_id -> identity.organizations.id nullable

actions.scope_members.scope_id -> actions.scopes.id
actions.scope_members.organization_id -> identity.organizations.id nullable
actions.scope_members.user_id -> identity.users.id nullable

actions.packages.scope_id -> actions.scopes.id
actions.packages.category_id -> actions.categories.id nullable

actions.package_versions.package_id -> actions.packages.id

actions.dist_tags.package_id -> actions.packages.id
actions.dist_tags.version_id -> actions.package_versions.id
```

### `actions.credential_requirements`

Declares which credentials a package version needs.

Suggested columns:

```text
id
package_version_id -> actions.package_versions.id
requirement_key
display_name
description
required
cardinality
purpose
accepted_credential_type_id -> secrets.credential_types.id nullable
accepted_capability_id -> secrets.credential_capabilities.id nullable
config_path nullable
permissions_json
metadata_json
created_at
updated_at
```

Examples:

```text
@beam/transfer requires beam.transfer
@beam/object-storage-endpoint requires object_storage.read/list/write
@beam/s3-read requires object_storage.read
@beam/s3-write requires object_storage.write
@beam/http-request requires http.request (credential optional)
@beam/webhook requires webhook.send (optional)
@beam/zapier requires http.request
```

## `workflow`

Workflow stores editable workflow definitions and credential bindings.

```text
workflow.templates
workflow.steps
workflow.edges
workflow.triggers
workflow.trigger_edges
workflow.decisions (kind is if or switch; config stores predicate or ordered cases)
workflow.decision_edges (branch is true/false, case:<stable-id>, or default)
workflow.plan_versions
workflow.action_locks
workflow.step_credential_bindings
```

Relationships:

```text
workflow.templates.organization_id -> identity.organizations.id
workflow.templates.project_id -> identity.projects.id nullable

workflow.steps.workflow_template_id -> workflow.templates.id
workflow.steps.execution_location_id -> runtime.execution_locations.id nullable
workflow.steps.retired_at hides a step from the editable graph and future run snapshots while preserving historical execution foreign keys.

workflow.edges.workflow_template_id -> workflow.templates.id
workflow.edges.from_step_id -> workflow.steps.id
workflow.edges.to_step_id -> workflow.steps.id

workflow.triggers.workflow_template_id -> workflow.templates.id

workflow.trigger_edges.workflow_template_id -> workflow.templates.id
workflow.trigger_edges.trigger_id -> workflow.triggers.id
workflow.trigger_edges.to_step_id -> workflow.steps.id

workflow.plan_versions.organization_id -> identity.organizations.id
workflow.plan_versions.project_id -> identity.projects.id nullable
workflow.plan_versions.workflow_template_id -> workflow.templates.id

workflow.action_locks.workflow_template_id -> workflow.templates.id
```

### `workflow.step_credential_bindings`

Stores the credential selected for a workflow step requirement.

```text
id
workflow_step_id -> workflow.steps.id
credential_requirement_id -> actions.credential_requirements.id
credential_id -> secrets.credentials.id
requirement_key
created_at
updated_at
```

Validation rule:

```text
credential.credential_type_id matches the requirement type
or credential type has the required capability

credential.organization_id = workflow.organization_id

credential.project_id IS NULL
or credential.project_id = workflow.project_id
```

## `execution`

Execution stores run-time state, event history, tasks, attempts, artifacts, and
compiled plans. It replaces legacy transfer runs, run transfers, dead-letter
runs, and execution logs.

```text
execution.workflow_runs
execution.workflow_step_runs
execution.workflow_tasks
execution.workflow_task_attempts
execution.workflow_task_dead_letters
execution.workflow_artifacts
execution.workflow_events
execution.workflow_step_credential_uses
execution.execution_plans
execution.execution_plan_nodes
execution.execution_plan_edges
execution.execution_plan_shards
```

Relationships:

```text
execution.workflow_runs.organization_id -> identity.organizations.id
execution.workflow_runs.project_id -> identity.projects.id nullable
execution.workflow_runs.workflow_template_id -> workflow.templates.id
execution.workflow_runs.workflow_plan_version_id -> workflow.plan_versions.id nullable

execution.workflow_step_runs.workflow_run_id -> execution.workflow_runs.id

execution.workflow_tasks.organization_id -> identity.organizations.id
execution.workflow_tasks.project_id -> identity.projects.id nullable
execution.workflow_tasks.workflow_run_id -> execution.workflow_runs.id
execution.workflow_tasks.workflow_step_run_id -> execution.workflow_step_runs.id nullable

execution.workflow_task_attempts.workflow_task_id -> execution.workflow_tasks.id

execution.workflow_task_dead_letters.workflow_task_id -> execution.workflow_tasks.id
execution.workflow_task_dead_letters.workflow_run_id -> execution.workflow_runs.id
execution.workflow_task_dead_letters.workflow_step_run_id -> execution.workflow_step_runs.id nullable

execution.workflow_artifacts.workflow_run_id -> execution.workflow_runs.id
execution.workflow_artifacts.workflow_step_run_id -> execution.workflow_step_runs.id nullable

execution.execution_plans.organization_id -> identity.organizations.id
execution.execution_plans.project_id -> identity.projects.id nullable
execution.execution_plans.workflow_plan_version_id -> workflow.plan_versions.id nullable
execution.execution_plans.workflow_run_id -> execution.workflow_runs.id

execution.execution_plan_nodes.execution_plan_id -> execution.execution_plans.id
execution.execution_plan_edges.execution_plan_id -> execution.execution_plans.id
execution.execution_plan_shards.execution_plan_id -> execution.execution_plans.id
execution.execution_plan_shards.workflow_task_id -> execution.workflow_tasks.id nullable
```

### `execution.workflow_events`

This is the central event journal.

Suggested columns:

```text
id
organization_id -> identity.organizations.id nullable
project_id -> identity.projects.id nullable
event_type
event_version
subject_type
subject_id
workflow_template_id -> workflow.templates.id nullable
workflow_run_id -> execution.workflow_runs.id nullable
workflow_step_run_id -> execution.workflow_step_runs.id nullable
workflow_task_id -> execution.workflow_tasks.id nullable
worker_id nullable
correlation_id nullable
idempotency_key nullable
payload_json
created_at
created_by nullable
```

### `execution.workflow_step_credential_uses`

Snapshots the exact credential version used by a step run.

```text
id
workflow_run_id -> execution.workflow_runs.id
workflow_step_run_id -> execution.workflow_step_runs.id
credential_id -> secrets.credentials.id
credential_version_id -> secrets.credential_versions.id
credential_requirement_id -> actions.credential_requirements.id
requirement_key
credential_snapshot_json
created_at
```

Unique key: `(workflow_step_run_id, credential_requirement_id, credential_id)`.
The snapshot JSON contains only redacted credential type, provider, and version
metadata.

## `runtime`

Runtime stores worker state, execution locations, capabilities, and durable
outbox events.

```text
runtime.worker_runtime_state
runtime.worker_capabilities
runtime.execution_locations
runtime.outbox_events
```

Relationships:

```text
runtime.worker_runtime_state.organization_id -> identity.organizations.id nullable
runtime.worker_runtime_state.project_id -> identity.projects.id nullable

runtime.worker_capabilities.worker_id -> runtime.worker_runtime_state.worker_id

runtime.execution_locations.organization_id -> identity.organizations.id
runtime.execution_locations.project_id -> identity.projects.id nullable
```

### `runtime.outbox_events`

Durable publication queue for API, orchestrator, and worker events that need to
reach NATS or another external transport.

```text
id
organization_id -> identity.organizations.id nullable
project_id -> identity.projects.id nullable
topic
payload_json
status
attempt_count
available_at
published_at nullable
created_at
updated_at
```

## `studio`

Studio stores product settings that do not belong to execution, secrets, or
agent-control state.

```text
studio.beam_environment_templates
studio.beam_environment_settings
```

`studio.beam_environment_templates` is organization-scoped and keyed by
`(organization_id, key)`. Each row owns the Beam environment endpoints used by
the Beam environment selectors: BeamCore/runtime URL, coordinator URL, NATS URL, Auth
URL, Beam API URL, and Registry URL. Built-in templates such as `prod` are
supplied by code and do not require rows.

`studio.beam_environment_settings` stores the organization default template key.
When `BEAM_STUDIO_DEV_SETTINGS_ENABLED` is unset or `false`, application code
does not read these tables for public/default room operations and forces the
built-in PROD template instead.

## `meta`

```text
meta.schema_migrations
```

This should be a PostgreSQL-native migration ledger for the fresh
`beam_studio` database. Do not migrate the SQLite `schema_migrations` rows.

## Legacy Tables Not Recreated

```text
beam_api_keys
organization_api_keys_cache
action_packages
transfer_templates
transfer_sources
transfer_destinations
schedules
runs
run_transfers
dead_letter_runs
execution_logs
scheduler_metric_snapshots
worker_instances
schema_migrations
```

Only the dev-only `db:pg:migrate` chain (`postgres-migrations/0008_legacy_product_state.sql`)
creates these tables, so older deployments may still hold rows in them. The API
(`apps/api/src/studio/store.ts`) and MCP server (`apps/mcp-server/src/studio-store.ts`)
check for them once per process (`legacyProductTablesPresent` in `packages/db`). When
they are absent, the legacy transfer, schedule and run readers return no rows, Beam API
keys are read from `secrets.credentials` only, and legacy writes fail with
`410 legacy_product_retired` instead of a missing-relation error.

## Legacy Replacement Map

| Legacy table                  | Target                                                              |
| ----------------------------- | ------------------------------------------------------------------- |
| `beam_api_keys`               | `secrets.credentials` with `credential_type = beam_api_key`         |
| `organization_api_keys_cache` | Removed; use credentials and identity/project scope                 |
| `action_packages`             | `actions.packages`, `actions.package_versions`, `actions.dist_tags` |
| `transfer_templates`          | `workflow.templates`, `workflow.steps`                              |
| `transfer_sources`            | Step config and credential bindings                                 |
| `transfer_destinations`       | Step config and credential bindings                                 |
| `schedules`                   | `workflow.triggers` with `type = schedule`                          |
| `runs`                        | `execution.workflow_runs`                                           |
| `run_transfers`               | `execution.workflow_step_runs`, artifacts, outputs, and events      |
| `dead_letter_runs`            | `execution.workflow_task_dead_letters`                              |
| `execution_logs`              | `execution.workflow_events`                                         |
| `scheduler_metric_snapshots`  | Runtime metrics/events; not a core product table                    |
| `worker_instances`            | `runtime.worker_runtime_state`                                      |
| SQLite `schema_migrations`    | `meta.schema_migrations`                                            |
