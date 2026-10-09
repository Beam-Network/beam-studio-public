import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  primaryKey,
  pgSchema,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const identity = pgSchema("identity");
const secrets = pgSchema("secrets");
const mcp = pgSchema("mcp");
const actions = pgSchema("actions");
const workflow = pgSchema("workflow");
const execution = pgSchema("execution");
const runtime = pgSchema("runtime");
const assistant = pgSchema("assistant");
const studio = pgSchema("studio");
const meta = pgSchema("meta");

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const jsonObject = sql`'{}'::jsonb`;
const jsonArray = sql`'[]'::jsonb`;

export const schemaMigrations = meta.table("schema_migrations", {
  id: text("id").primaryKey(),
  description: text("description").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const organizations = identity.table("organizations", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  metadataJson: jsonb("metadata_json").notNull().default(jsonObject),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const projects = identity.table(
  "projects",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    metadataJson: jsonb("metadata_json").notNull().default(jsonObject),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("idx_identity_projects_org_slug").on(
      table.organizationId,
      table.slug,
    ),
  ],
);

export const users = identity.table("users", {
  id: text("id").primaryKey(),
  externalId: text("external_id").unique(),
  email: text("email").unique(),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  metadataJson: jsonb("metadata_json").notNull().default(jsonObject),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const organizationMembers = identity.table(
  "organization_members",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull().default("member"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("idx_identity_organization_members_unique").on(
      table.organizationId,
      table.userId,
    ),
  ],
);

export const projectMembers = identity.table(
  "project_members",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull().default("member"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("idx_identity_project_members_unique").on(
      table.projectId,
      table.userId,
    ),
  ],
);

export const serviceAccounts = identity.table(
  "service_accounts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").references(() => projects.id),
    ownerUserId: text("owner_user_id").references(() => users.id),
    createdById: text("created_by_id").references(() => users.id),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status").notNull().default("active"),
    metadataJson: jsonb("metadata_json").notNull().default(jsonObject),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("idx_identity_service_accounts_org_slug").on(
      table.organizationId,
      table.slug,
    ),
  ],
);

export const credentialTypes = secrets.table("credential_types", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  secretSchemaJson: jsonb("secret_schema_json").notNull().default(jsonObject),
  metadataSchemaJson: jsonb("metadata_schema_json")
    .notNull()
    .default(jsonObject),
  displaySchemaJson: jsonb("display_schema_json").notNull().default(jsonObject),
  validationPolicyJson: jsonb("validation_policy_json")
    .notNull()
    .default(jsonObject),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const providerProfiles = secrets.table("provider_profiles", {
  id: text("id").primaryKey(),
  credentialTypeId: text("credential_type_id")
    .notNull()
    .references(() => credentialTypes.id),
  driver: text("driver").notNull(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  logoUrl: text("logo_url"),
  websiteUrl: text("website_url"),
  docsUrl: text("docs_url"),
  endpointTemplate: text("endpoint_template"),
  defaultRegion: text("default_region"),
  defaultEndpointUrl: text("default_endpoint_url"),
  requiredFieldsJson: jsonb("required_fields_json")
    .notNull()
    .default(jsonArray),
  optionalFieldsJson: jsonb("optional_fields_json")
    .notNull()
    .default(jsonArray),
  fieldDefaultsJson: jsonb("field_defaults_json").notNull().default(jsonObject),
  fieldLabelsJson: jsonb("field_labels_json").notNull().default(jsonObject),
  metadataJson: jsonb("metadata_json").notNull().default(jsonObject),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const credentials = secrets.table("credentials", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  projectId: text("project_id").references(() => projects.id),
  credentialTypeId: text("credential_type_id")
    .notNull()
    .references(() => credentialTypes.id),
  providerProfileId: text("provider_profile_id").references(
    () => providerProfiles.id,
  ),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  externalId: text("external_id"),
  externalSource: text("external_source"),
  prefix: text("prefix"),
  fingerprintHash: text("fingerprint_hash"),
  description: text("description"),
  metadataJson: jsonb("metadata_json").notNull().default(jsonObject),
  createdById: text("created_by_id").references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

export const credentialVersions = secrets.table(
  "credential_versions",
  {
    id: text("id").primaryKey(),
    credentialId: text("credential_id")
      .notNull()
      .references(() => credentials.id),
    version: integer("version").notNull(),
    encryptedPayload: text("encrypted_payload").notNull(),
    encryptionKeyId: text("encryption_key_id").notNull(),
    payloadSchemaVersion: integer("payload_schema_version")
      .notNull()
      .default(1),
    status: text("status").notNull().default("active"),
    createdById: text("created_by_id").references(() => users.id),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    replacedByVersionId: text("replaced_by_version_id"),
  },
  (table) => [
    uniqueIndex("idx_secrets_credential_versions_unique").on(
      table.credentialId,
      table.version,
    ),
  ],
);

export const credentialValidationEvents = secrets.table(
  "credential_validation_events",
  {
    id: text("id").primaryKey(),
    credentialId: text("credential_id")
      .notNull()
      .references(() => credentials.id),
    credentialVersionId: text("credential_version_id").references(
      () => credentialVersions.id,
    ),
    status: text("status").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    metadataJson: jsonb("metadata_json").notNull().default(jsonObject),
  },
);

export const credentialCapabilities = secrets.table("credential_capabilities", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  metadataJson: jsonb("metadata_json").notNull().default(jsonObject),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const credentialTypeCapabilities = secrets.table(
  "credential_type_capabilities",
  {
    id: text("id").primaryKey(),
    credentialTypeId: text("credential_type_id")
      .notNull()
      .references(() => credentialTypes.id),
    credentialCapabilityId: text("credential_capability_id")
      .notNull()
      .references(() => credentialCapabilities.id),
    metadataJson: jsonb("metadata_json").notNull().default(jsonObject),
    createdAt: createdAt(),
  },
);

export const workerRuntimeState = runtime.table("worker_runtime_state", {
  workerId: text("worker_id").primaryKey(),
  organizationId: text("organization_id").references(() => organizations.id),
  projectId: text("project_id").references(() => projects.id),
  networkIdentity: text("network_identity").notNull(),
  status: text("status").notNull(),
  reachability: text("reachability").notNull().default("local"),
  capabilitiesJson: jsonb("capabilities_json").notNull().default(jsonArray),
  accessibleEndpointsJson: jsonb("accessible_endpoints_json")
    .notNull()
    .default(jsonArray),
  version: text("version"),
  cpuLoad: real("cpu_load").notNull().default(0),
  memoryUsedBytes: bigint("memory_used_bytes", { mode: "number" })
    .notNull()
    .default(0),
  memoryTotalBytes: bigint("memory_total_bytes", { mode: "number" })
    .notNull()
    .default(0),
  bandwidthMbps: real("bandwidth_mbps").notNull().default(0),
  activeTaskCount: integer("active_task_count").notNull().default(0),
  loadScore: real("load_score").notNull().default(0),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull(),
  metadataJson: jsonb("metadata_json").notNull().default(jsonObject),
  updatedAt: updatedAt(),
});

export const workerCapabilities = runtime.table(
  "worker_capabilities",
  {
    id: text("id").primaryKey(),
    workerId: text("worker_id")
      .notNull()
      .references(() => workerRuntimeState.workerId),
    capability: text("capability").notNull(),
    versionRange: text("version_range"),
    metadataJson: jsonb("metadata_json").notNull().default(jsonObject),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("idx_runtime_worker_capabilities_unique").on(
      table.workerId,
      table.capability,
    ),
  ],
);

export const executionLocations = runtime.table("execution_locations", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  projectId: text("project_id").references(() => projects.id),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  endpointUrl: text("endpoint_url"),
  encryptedHeaders: text("encrypted_headers"),
  enabled: boolean("enabled").notNull().default(true),
  allowInsecureHttp: boolean("allow_insecure_http").notNull().default(false),
  metadataJson: jsonb("metadata_json").notNull().default(jsonObject),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const outboxEvents = runtime.table("outbox_events", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").references(() => organizations.id),
  projectId: text("project_id").references(() => projects.id),
  topic: text("topic").notNull(),
  payloadJson: jsonb("payload_json").notNull().default(jsonObject),
  status: text("status").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const mcpTokens = mcp.table("tokens", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  projectId: text("project_id").references(() => projects.id),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  prefix: text("prefix"),
  scopesJson: jsonb("scopes_json").notNull().default(jsonArray),
  status: text("status").notNull().default("active"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdById: text("created_by_id").references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const mcpAuditEvents = mcp.table("audit_events", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").references(() => organizations.id),
  projectId: text("project_id").references(() => projects.id),
  tokenId: text("token_id").references(() => mcpTokens.id),
  eventType: text("event_type").notNull(),
  subjectType: text("subject_type"),
  subjectId: text("subject_id"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  metadataJson: jsonb("metadata_json").notNull().default(jsonObject),
  createdAt: createdAt(),
});

export const actionCategories = actions.table("categories", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  parentId: text("parent_id"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const actionScopes = actions.table("scopes", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  ownerOrganizationId: text("owner_organization_id").references(
    () => organizations.id,
  ),
  status: text("status").notNull().default("active"),
  metadataJson: jsonb("metadata_json").notNull().default(jsonObject),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const actionScopeMembers = actions.table(
  "scope_members",
  {
    id: text("id").primaryKey(),
    scopeId: text("scope_id")
      .notNull()
      .references(() => actionScopes.id),
    organizationId: text("organization_id").references(() => organizations.id),
    userId: text("user_id").references(() => users.id),
    role: text("role").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("idx_actions_scope_members_subject").on(
      table.scopeId,
      table.userId,
      table.organizationId,
    ),
  ],
);

export const actionPackages = actions.table(
  "packages",
  {
    id: text("id").primaryKey(),
    scopeId: text("scope_id")
      .notNull()
      .references(() => actionScopes.id),
    categoryId: text("category_id").references(() => actionCategories.id),
    name: text("name").notNull(),
    packageName: text("package_name").notNull().unique(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    visibility: text("visibility").notNull().default("private"),
    status: text("status").notNull().default("active"),
    trustLevel: text("trust_level").notNull().default("external"),
    latestVersion: text("latest_version"),
    metadataJson: jsonb("metadata_json").notNull().default(jsonObject),
    organizationId: text("organization_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("idx_actions_packages_scope_name").on(
      table.scopeId,
      table.name,
    ),
  ],
);

export const actionPackageVersions = actions.table(
  "package_versions",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id")
      .notNull()
      .references(() => actionPackages.id),
    version: text("version").notNull(),
    manifestJson: jsonb("manifest_json").notNull(),
    manifestChecksum: text("manifest_checksum").notNull(),
    artifactChecksum: text("artifact_checksum").notNull(),
    artifactSizeBytes: bigint("artifact_size_bytes", { mode: "number" })
      .notNull()
      .default(0),
    hippiusBucket: text("hippius_bucket"),
    hippiusKey: text("hippius_key"),
    hippiusEndpoint: text("hippius_endpoint"),
    mediaType: text("media_type").notNull().default("application/gzip"),
    signature: text("signature"),
    provenanceJson: jsonb("provenance_json").notNull().default(jsonObject),
    validationStatus: text("validation_status").notNull().default("pending"),
    status: text("status").notNull().default("active"),
    publishedBy: text("published_by"),
    publishedAt: timestamp("published_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
    deprecationReason: text("deprecation_reason"),
    blockedAt: timestamp("blocked_at", { withTimezone: true }),
    blockReason: text("block_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("idx_actions_package_versions_unique").on(
      table.packageId,
      table.version,
    ),
  ],
);

export const actionDistTags = actions.table(
  "dist_tags",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id")
      .notNull()
      .references(() => actionPackages.id),
    tag: text("tag").notNull(),
    versionId: text("version_id")
      .notNull()
      .references(() => actionPackageVersions.id),
    updatedBy: text("updated_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("idx_actions_dist_tags_package_tag").on(
      table.packageId,
      table.tag,
    ),
  ],
);

export const credentialRequirements = actions.table(
  "credential_requirements",
  {
    id: text("id").primaryKey(),
    packageVersionId: text("package_version_id")
      .notNull()
      .references(() => actionPackageVersions.id),
    requirementKey: text("requirement_key").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    required: boolean("required").notNull().default(true),
    cardinality: text("cardinality").notNull().default("one"),
    purpose: text("purpose"),
    acceptedCredentialTypeId: text("accepted_credential_type_id").references(
      () => credentialTypes.id,
    ),
    acceptedCapabilityId: text("accepted_capability_id").references(
      () => credentialCapabilities.id,
    ),
    configPath: text("config_path"),
    permissionsJson: jsonb("permissions_json").notNull().default(jsonArray),
    metadataJson: jsonb("metadata_json").notNull().default(jsonObject),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("idx_actions_credential_requirements_unique").on(
      table.packageVersionId,
      table.requirementKey,
    ),
  ],
);

export const workflowTemplates = workflow.table("templates", {
  roomContextJson: jsonb("room_context_json"),
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  projectId: text("project_id").references(() => projects.id),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").notNull().default("draft"),
  inputSchemaJson: jsonb("input_schema_json")
    .notNull()
    .default({ type: "object", additionalProperties: true }),
  outputContractJson: jsonb("output_contract_json")
    .notNull()
    .default({
      schema: { type: "object", additionalProperties: false },
      bindings: {},
    }),
  agentBindingsJson: jsonb("agent_bindings_json").notNull().default(jsonObject),
  resourceBindingsJson: jsonb("resource_bindings_json")
    .notNull()
    .default(jsonObject),
  migrationSourceJson: jsonb("migration_source_json"),
  apiKeyId: text("api_key_id"),
  configJson: jsonb("config_json").notNull().default(jsonObject),
  retryPolicyJson: jsonb("retry_policy_json").notNull().default(jsonObject),
  graphVersion: text("graph_version").notNull().default("workflow-graph/v1"),
  layoutRevision: integer("layout_revision").notNull().default(0),
  graphJson: jsonb("graph_json").notNull().default(jsonObject),
  timeoutSeconds: integer("timeout_seconds"),
  enabled: boolean("enabled").notNull().default(true),
  createdById: text("created_by_id").references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});

export const workflowSteps = workflow.table(
  "steps",
  {
    id: text("id").primaryKey(),
    workflowTemplateId: text("workflow_template_id")
      .notNull()
      .references(() => workflowTemplates.id),
    name: text("name"),
    kind: text("kind").notNull().default("action"),
    calledWorkflowId: text("called_workflow_id").references(
      () => workflowTemplates.id,
    ),
    actionPackageName: text("action_package_name"),
    actionVersionRange: text("action_version_range").notNull().default("*"),
    position: integer("position").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    configJson: jsonb("config_json").notNull().default(jsonObject),
    inputBindingsJson: jsonb("input_bindings_json")
      .notNull()
      .default(jsonObject),
    executionTargetJson: jsonb("execution_target_json"),
    placement: text("placement").notNull().default("local-workers"),
    executionLocationId: text("execution_location_id").references(
      () => executionLocations.id,
    ),
    canvasX: real("canvas_x"),
    canvasY: real("canvas_y"),
    timeoutSeconds: integer("timeout_seconds"),
    required: boolean("required").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("idx_workflow_steps_template_position").on(
      table.workflowTemplateId,
      table.position,
    ),
  ],
);

export const workflowEdges = workflow.table("edges", {
  id: text("id").primaryKey(),
  workflowTemplateId: text("workflow_template_id")
    .notNull()
    .references(() => workflowTemplates.id),
  fromStepId: text("from_step_id")
    .notNull()
    .references(() => workflowSteps.id),
  toStepId: text("to_step_id")
    .notNull()
    .references(() => workflowSteps.id),
  conditionJson: jsonb("condition_json"),
  createdAt: createdAt(),
});

export const workflowTriggers = workflow.table("triggers", {
  id: text("id").primaryKey(),
  workflowTemplateId: text("workflow_template_id")
    .notNull()
    .references(() => workflowTemplates.id),
  type: text("type").notNull(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  configJson: jsonb("config_json").notNull().default(jsonObject),
  stateJson: jsonb("state_json").notNull().default(jsonObject),
  canvasX: real("canvas_x"),
  canvasY: real("canvas_y"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workflowTriggerEdges = workflow.table("trigger_edges", {
  id: text("id").primaryKey(),
  workflowTemplateId: text("workflow_template_id")
    .notNull()
    .references(() => workflowTemplates.id),
  triggerId: text("trigger_id")
    .notNull()
    .references(() => workflowTriggers.id),
  toStepId: text("to_step_id")
    .notNull()
    .references(() => workflowSteps.id),
  conditionJson: jsonb("condition_json"),
  createdAt: createdAt(),
});

export const workflowDecisions = workflow.table(
  "decisions",
  {
    id: text("id").primaryKey(),
    workflowTemplateId: text("workflow_template_id")
      .notNull()
      .references(() => workflowTemplates.id),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("if"),
    enabled: boolean("enabled").notNull().default(true),
    joinMode: text("join_mode").notNull().default("all"),
    handleFailure: boolean("handle_failure").notNull().default(false),
    configJson: jsonb("config_json").notNull().default(jsonObject),
    canvasX: real("canvas_x"),
    canvasY: real("canvas_y"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("idx_workflow_decisions_template_id").on(
      table.workflowTemplateId,
      table.id,
    ),
  ],
);

export const workflowDecisionEdges = workflow.table("decision_edges", {
  id: text("id").primaryKey(),
  workflowTemplateId: text("workflow_template_id")
    .notNull()
    .references(() => workflowTemplates.id),
  fromStepId: text("from_step_id"),
  fromDecisionId: text("from_decision_id"),
  toStepId: text("to_step_id"),
  toDecisionId: text("to_decision_id"),
  branch: text("branch"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workflowPlanVersions = workflow.table(
  "plan_versions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").references(() => projects.id),
    workflowTemplateId: text("workflow_template_id")
      .notNull()
      .references(() => workflowTemplates.id),
    version: integer("version").notNull(),
    status: text("status").notNull().default("active"),
    compiledPlanJson: jsonb("compiled_plan_json").notNull().default(jsonObject),
    manifestSnapshotJson: jsonb("manifest_snapshot_json")
      .notNull()
      .default(jsonObject),
    createdAt: createdAt(),
    createdBy: text("created_by"),
  },
  (table) => [
    uniqueIndex("idx_workflow_plan_versions_template_version").on(
      table.workflowTemplateId,
      table.version,
    ),
  ],
);

export const workflowActionLocks = workflow.table("action_locks", {
  id: text("id").primaryKey(),
  workflowTemplateId: text("workflow_template_id")
    .notNull()
    .references(() => workflowTemplates.id),
  actionPackageName: text("action_package_name").notNull(),
  versionRange: text("version_range").notNull(),
  resolvedVersion: text("resolved_version").notNull(),
  packageVersionId: text("package_version_id").references(
    () => actionPackageVersions.id,
  ),
  checksum: text("checksum").notNull(),
  artifactChecksum: text("artifact_checksum"),
  artifactReference: text("artifact_reference"),
  sourceRegistry: text("source_registry").notNull(),
  trustLevel: text("trust_level"),
  createdAt: createdAt(),
});

export const workflowStepCredentialBindings = workflow.table(
  "step_credential_bindings",
  {
    id: text("id").primaryKey(),
    workflowStepId: text("workflow_step_id")
      .notNull()
      .references(() => workflowSteps.id),
    credentialRequirementId: text("credential_requirement_id")
      .notNull()
      .references(() => credentialRequirements.id),
    credentialId: text("credential_id")
      .notNull()
      .references(() => credentials.id),
    requirementKey: text("requirement_key").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
);

export const workflowRuns = execution.table("workflow_runs", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  projectId: text("project_id").references(() => projects.id),
  workflowTemplateId: text("workflow_template_id")
    .notNull()
    .references(() => workflowTemplates.id),
  workflowPlanVersionId: text("workflow_plan_version_id").references(
    () => workflowPlanVersions.id,
  ),
  parentRunId: text("parent_run_id"),
  rootRunId: text("root_run_id"),
  invokingStepRunId: text("invoking_step_run_id"),
  invocationAttempt: integer("invocation_attempt"),
  executionContextJson: jsonb("execution_context_json")
    .notNull()
    .default(jsonObject),
  outputValidation: text("output_validation").notNull().default("unvalidated"),
  historical: boolean("historical").notNull().default(false),
  historicalSnapshotJson: jsonb("historical_snapshot_json"),
  creditOperationKey: text("credit_operation_key"),
  creditSettledAt: timestamp("credit_settled_at", { withTimezone: true }),
  status: text("status").notNull(),
  trigger: text("trigger").notNull().default("manual"),
  triggerId: text("trigger_id"),
  triggerType: text("trigger_type"),
  triggerEventJson: jsonb("trigger_event_json").notNull().default(jsonObject),
  inputJson: jsonb("input_json").notNull().default(jsonObject),
  outputJson: jsonb("output_json").notNull().default(jsonObject),
  metadataJson: jsonb("metadata_json").notNull().default(jsonObject),
  templateSnapshotJson: jsonb("template_snapshot_json")
    .notNull()
    .default(jsonObject),
  resolvedStepsJson: jsonb("resolved_steps_json").notNull().default(jsonArray),
  error: text("error"),
  queuedAt: timestamp("queued_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workflowBillingAttempts = execution.table(
  "workflow_billing_attempts",
  {
    operationKey: text("operation_key").primaryKey(),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id),
    attempt: integer("attempt").notNull(),
    organizationId: text("organization_id").notNull(),
    credentialId: text("credential_id"),
    authorityKeyId: text("authority_key_id"),
    reservationState: text("reservation_state").notNull().default("pending"),
    reserveStartedAt: timestamp("reserve_started_at", { withTimezone: true }),
    outcome: text("outcome"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    errorCode: text("error_code"),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
);

export const workflowRunCapabilities = execution.table(
  "workflow_run_capabilities",
  {
    workflowRunId: text("workflow_run_id")
      .primaryKey()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    authorizationToken: text("authorization_token").notNull(),
    createdAt: createdAt(),
  },
);

export const workflowDynamicRegions = execution.table(
  "workflow_dynamic_regions",
  {
    id: text("id").primaryKey(),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id),
    controlId: text("control_id").notNull(),
    controlPath: text("control_path").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    definitionJson: jsonb("definition_json").notNull().default(jsonObject),
    resolvedInputJson: jsonb("resolved_input_json"),
    outputJson: jsonb("output_json").notNull().default(jsonObject),
    instanceCount: integer("instance_count").notNull().default(0),
    completedCount: integer("completed_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    cancelledCount: integer("cancelled_count").notNull().default(0),
    concurrencyLimit: integer("concurrency_limit"),
    error: text("error"),
    cancellationRequestedAt: timestamp("cancellation_requested_at", {
      withTimezone: true,
    }),
    retryRequestedAt: timestamp("retry_requested_at", { withTimezone: true }),
    requestedBy: text("requested_by"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("idx_execution_workflow_dynamic_regions_path").on(
      table.workflowRunId,
      table.controlPath,
    ),
    index("idx_execution_workflow_dynamic_regions_run").on(
      table.workflowRunId,
      table.status,
    ),
  ],
);

export const workflowDynamicInstances = execution.table(
  "workflow_dynamic_instances",
  {
    id: text("id").primaryKey(),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id),
    dynamicRegionId: text("dynamic_region_id")
      .notNull()
      .references(() => workflowDynamicRegions.id),
    workflowStepId: text("workflow_step_id")
      .notNull()
      .references(() => workflowSteps.id),
    controlPath: text("control_path").notNull(),
    instanceIndex: integer("instance_index").notNull(),
    status: text("status").notNull().default("pending"),
    currentAttempt: integer("current_attempt").notNull().default(1),
    contextJson: jsonb("context_json").notNull().default(jsonObject),
    inputJson: jsonb("input_json").notNull().default(jsonObject),
    outputJson: jsonb("output_json").notNull().default(jsonObject),
    metadataJson: jsonb("metadata_json").notNull().default(jsonObject),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("idx_execution_workflow_dynamic_instances_logical").on(
      table.workflowRunId,
      table.controlPath,
      table.workflowStepId,
      table.instanceIndex,
    ),
    index("idx_execution_workflow_dynamic_instances_region").on(
      table.dynamicRegionId,
      table.instanceIndex,
      table.status,
    ),
    index("idx_execution_workflow_dynamic_instances_run").on(
      table.workflowRunId,
      table.controlPath,
      table.status,
    ),
  ],
);

export const workflowStepRuns = execution.table(
  "workflow_step_runs",
  {
    id: text("id").primaryKey(),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id),
    workflowStepId: text("workflow_step_id")
      .notNull()
      .references(() => workflowSteps.id),
    dynamicInstanceId: text("dynamic_instance_id").references(
      () => workflowDynamicInstances.id,
    ),
    kind: text("kind").notNull().default("action"),
    childRunId: text("child_run_id").references(() => workflowRuns.id),
    actionPackageName: text("action_package_name"),
    resolvedVersion: text("resolved_version").notNull(),
    checksum: text("checksum").notNull(),
    sourceRegistry: text("source_registry").notNull(),
    resolvedPlacement: text("resolved_placement").notNull(),
    executionLocationId: text("execution_location_id").references(
      () => executionLocations.id,
    ),
    status: text("status").notNull(),
    attempt: integer("attempt").notNull().default(1),
    inputJson: jsonb("input_json").notNull().default(jsonObject),
    outputJson: jsonb("output_json").notNull().default(jsonObject),
    metadataJson: jsonb("metadata_json").notNull().default(jsonObject),
    stateJson: jsonb("state_json").notNull().default(jsonObject),
    resourceExecutionJson: jsonb("resource_execution_json")
      .notNull()
      .default(jsonObject),
    externalRef: text("external_ref"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("idx_execution_workflow_step_runs_static_unique")
      .on(table.workflowRunId, table.workflowStepId)
      .where(sql`${table.dynamicInstanceId} IS NULL`),
    uniqueIndex("idx_execution_workflow_step_runs_dynamic_unique")
      .on(table.dynamicInstanceId)
      .where(sql`${table.dynamicInstanceId} IS NOT NULL`),
  ],
);

export const workflowTasks = execution.table(
  "workflow_tasks",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").references(() => projects.id),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id),
    workflowStepRunId: text("workflow_step_run_id").references(
      () => workflowStepRuns.id,
    ),
    workflowStepId: text("workflow_step_id")
      .notNull()
      .references(() => workflowSteps.id),
    taskKind: text("task_kind").notNull(),
    actionPackageName: text("action_package_name").notNull(),
    status: text("status").notNull(),
    priority: integer("priority").notNull().default(0),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    targetWorkerId: text("target_worker_id"),
    leasedBy: text("leased_by"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lockExpiresAt: timestamp("lock_expires_at", { withTimezone: true }),
    claimToken: text("claim_token"),
    attemptCount: integer("attempt_count").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    shardIndex: integer("shard_index"),
    shardCount: integer("shard_count"),
    inputChecksum: text("input_checksum").notNull(),
    outputChecksum: text("output_checksum"),
    idempotencyKey: text("idempotency_key"),
    inputJson: jsonb("input_json").notNull().default(jsonObject),
    outputJson: jsonb("output_json").notNull().default(jsonObject),
    metadataJson: jsonb("metadata_json").notNull().default(jsonObject),
    retryPolicyJson: jsonb("retry_policy_json").notNull().default(jsonObject),
    placementExplanationJson: jsonb("placement_explanation_json")
      .notNull()
      .default(jsonObject),
    natsSubject: text("nats_subject"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("idx_execution_workflow_tasks_claim").on(
      table.status,
      table.scheduledAt,
      table.priority,
      table.createdAt,
    ),
    index("idx_execution_workflow_tasks_lease_recovery").on(
      table.status,
      table.leaseExpiresAt,
    ),
  ],
);

export const commandOutbox = execution.table(
  "command_outbox",
  {
    id: text("id").primaryKey(),
    commandType: text("command_type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    transport: text("transport").notNull(),
    subject: text("subject"),
    payloadJson: jsonb("payload_json").notNull().default(jsonObject),
    state: text("state").notNull().default("pending"),
    publishAttempts: integer("publish_attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    claimedBy: text("claimed_by"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("idx_execution_command_outbox_dedupe").on(
      table.commandType,
      table.aggregateId,
    ),
    index("idx_execution_command_outbox_pending").on(
      table.state,
      table.transport,
      table.availableAt,
      table.createdAt,
    ),
  ],
);

export const workflowTaskAttempts = execution.table(
  "workflow_task_attempts",
  {
    id: text("id").primaryKey(),
    workflowTaskId: text("workflow_task_id")
      .notNull()
      .references(() => workflowTasks.id),
    attemptNumber: integer("attempt_number").notNull(),
    workerId: text("worker_id"),
    status: text("status").notNull(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    metadataJson: jsonb("metadata_json").notNull().default(jsonObject),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("idx_execution_workflow_task_attempts_unique").on(
      table.workflowTaskId,
      table.attemptNumber,
    ),
  ],
);

export const workflowTaskDeadLetters = execution.table(
  "workflow_task_dead_letters",
  {
    id: text("id").primaryKey(),
    workflowTaskId: text("workflow_task_id")
      .notNull()
      .references(() => workflowTasks.id),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id),
    workflowStepRunId: text("workflow_step_run_id").references(
      () => workflowStepRuns.id,
    ),
    reason: text("reason").notNull(),
    error: text("error").notNull(),
    attempts: integer("attempts").notNull(),
    maxAttempts: integer("max_attempts").notNull(),
    payloadJson: jsonb("payload_json").notNull().default(jsonObject),
    createdAt: createdAt(),
  },
);

export const workflowArtifacts = execution.table("workflow_artifacts", {
  id: text("id").primaryKey(),
  workflowRunId: text("workflow_run_id")
    .notNull()
    .references(() => workflowRuns.id),
  workflowStepRunId: text("workflow_step_run_id").references(
    () => workflowStepRuns.id,
  ),
  type: text("type").notNull(),
  name: text("name").notNull(),
  uri: text("uri").notNull(),
  mediaType: text("media_type"),
  metadataJson: jsonb("metadata_json").notNull().default(jsonObject),
  createdAt: createdAt(),
});

export const workflowArtifactIdentities = execution.table(
  "workflow_artifact_identities",
  {
    artifactId: text("artifact_id").primaryKey(),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id),
    taskId: text("task_id")
      .notNull()
      .references(() => workflowTasks.id),
    sha256: text("sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    mediaType: text("media_type").notNull(),
    createdAt: createdAt(),
  },
);

export const workflowArtifactManifests = execution.table(
  "workflow_artifact_manifests",
  {
    id: text("id").primaryKey(),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id),
    workflowStepRunId: text("workflow_step_run_id")
      .notNull()
      .references(() => workflowStepRuns.id),
    taskId: text("task_id")
      .notNull()
      .references(() => workflowTasks.id),
    assignmentId: text("assignment_id").notNull(),
    attempt: integer("attempt").notNull(),
    publicationId: text("publication_id").notNull(),
    artifactIdentityHash: text("artifact_identity_hash").notNull(),
    artifactsJson: jsonb("artifacts_json").notNull(),
    resultJson: jsonb("result_json").notNull(),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
);

export const workflowArtifactLocations = execution.table(
  "workflow_artifact_locations",
  {
    id: bigint("id", { mode: "number" })
      .generatedByDefaultAsIdentity()
      .primaryKey(),
    manifestId: text("manifest_id")
      .notNull()
      .references(() => workflowArtifactManifests.id),
    artifactId: text("artifact_id").notNull(),
    kind: text("kind").notNull(),
    locator: text("locator").notNull(),
    memberId: text("member_id"),
    roomId: text("room_id").notNull(),
    channelId: text("channel_id").notNull(),
    sourceMemberId: text("source_member_id").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    verificationBasis: text("verification_basis").notNull(),
    durableUntil: timestamp("durable_until", { withTimezone: true }),
    retentionObligationId: text("retention_obligation_id"),
    state: text("state").notNull().default("available"),
    lostAt: timestamp("lost_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
);

export const workflowArtifactTransfers = execution.table(
  "workflow_artifact_transfers",
  {
    manifestId: text("manifest_id")
      .notNull()
      .references(() => workflowArtifactManifests.id),
    artifactId: text("artifact_id").notNull(),
    destinationMemberId: text("destination_member_id").notNull(),
    publicationId: text("publication_id").notNull(),
    transferId: text("transfer_id").notNull(),
    roomId: text("room_id").notNull(),
    channelId: text("channel_id").notNull(),
    sourceMemberId: text("source_member_id").notNull(),
    status: text("status").notNull(),
    fullDeliveryVerified: boolean("full_delivery_verified")
      .notNull()
      .default(false),
    updatedAt: updatedAt(),
  },
);

export const workflowArtifactObligations = execution.table(
  "workflow_artifact_obligations",
  {
    obligationId: text("obligation_id").primaryKey(),
    manifestId: text("manifest_id")
      .notNull()
      .references(() => workflowArtifactManifests.id),
    artifactId: text("artifact_id").notNull(),
    requiredUntil: timestamp("required_until", {
      withTimezone: true,
    }).notNull(),
    status: text("status").notNull().default("pending"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
);

export const workflowEvents = execution.table(
  "workflow_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(() => organizations.id),
    projectId: text("project_id").references(() => projects.id),
    eventType: text("event_type").notNull(),
    eventVersion: integer("event_version").notNull().default(1),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    workflowTemplateId: text("workflow_template_id").references(
      () => workflowTemplates.id,
    ),
    workflowRunId: text("workflow_run_id").references(() => workflowRuns.id),
    workflowStepRunId: text("workflow_step_run_id").references(
      () => workflowStepRuns.id,
    ),
    workflowTaskId: text("workflow_task_id").references(() => workflowTasks.id),
    workerId: text("worker_id"),
    correlationId: text("correlation_id"),
    idempotencyKey: text("idempotency_key"),
    payloadJson: jsonb("payload_json").notNull().default(jsonObject),
    createdAt: createdAt(),
  },
  (table) => [
    index("idx_execution_workflow_events_run").on(
      table.workflowRunId,
      table.createdAt,
    ),
    index("idx_execution_workflow_events_subject").on(
      table.subjectType,
      table.subjectId,
      table.createdAt,
    ),
  ],
);

export const workflowConditionEvaluations = execution.table(
  "workflow_condition_evaluations",
  {
    id: text("id").primaryKey(),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id),
    dynamicRegionId: text("dynamic_region_id").references(
      () => workflowDynamicRegions.id,
    ),
    dynamicInstanceId: text("dynamic_instance_id").references(
      () => workflowDynamicInstances.id,
    ),
    scopeKey: text("scope_key").notNull(),
    edgeId: text("edge_id").notNull(),
    fromNodeId: text("from_node_id").notNull(),
    toNodeId: text("to_node_id").notNull(),
    outcome: text("outcome").notNull(),
    result: boolean("result"),
    reason: text("reason").notNull(),
    summaryJson: jsonb("summary_json").notNull().default(jsonObject),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("idx_execution_workflow_condition_evaluations_unique").on(
      table.workflowRunId,
      table.scopeKey,
      table.edgeId,
    ),
    index("idx_execution_workflow_condition_evaluations_run").on(
      table.workflowRunId,
      table.scopeKey,
      table.createdAt,
    ),
  ],
);

export const workflowDecisionEvaluations = execution.table(
  "workflow_decision_evaluations",
  {
    id: text("id").primaryKey(),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id),
    decisionId: text("decision_id").notNull(),
    scopeKey: text("scope_key").notNull().default("root"),
    joinMode: text("join_mode").notNull(),
    decisionKind: text("decision_kind").notNull().default("if"),
    evaluated: boolean("evaluated").notNull(),
    result: boolean("result"),
    takenBranch: text("taken_branch"),
    handledFailures: jsonb("handled_failures").notNull().default(jsonArray),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("idx_execution_workflow_decision_evaluations_unique").on(
      table.workflowRunId,
      table.scopeKey,
      table.decisionId,
    ),
    index("idx_execution_workflow_decision_evaluations_run").on(
      table.workflowRunId,
      table.createdAt,
    ),
  ],
);

export const workflowStepCredentialUses = execution.table(
  "workflow_step_credential_uses",
  {
    id: text("id").primaryKey(),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id),
    workflowStepRunId: text("workflow_step_run_id")
      .notNull()
      .references(() => workflowStepRuns.id),
    credentialId: text("credential_id")
      .notNull()
      .references(() => credentials.id),
    credentialVersionId: text("credential_version_id")
      .notNull()
      .references(() => credentialVersions.id),
    credentialRequirementId: text("credential_requirement_id")
      .notNull()
      .references(() => credentialRequirements.id),
    requirementKey: text("requirement_key").notNull(),
    credentialSnapshotJson: jsonb("credential_snapshot_json")
      .notNull()
      .default(jsonObject),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("idx_execution_workflow_step_credential_uses_unique").on(
      table.workflowStepRunId,
      table.credentialRequirementId,
      table.credentialId,
    ),
  ],
);

export const executionPlans = execution.table("execution_plans", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  projectId: text("project_id").references(() => projects.id),
  workflowPlanVersionId: text("workflow_plan_version_id").references(
    () => workflowPlanVersions.id,
  ),
  workflowRunId: text("workflow_run_id")
    .notNull()
    .references(() => workflowRuns.id),
  workflowStepRunId: text("workflow_step_run_id").references(
    () => workflowStepRuns.id,
  ),
  workflowStepId: text("workflow_step_id").references(() => workflowSteps.id),
  mode: text("mode"),
  shardCount: integer("shard_count").notNull().default(1),
  status: text("status").notNull().default("active"),
  planJson: jsonb("plan_json").notNull().default(jsonObject),
  retryPolicyJson: jsonb("retry_policy_json").notNull().default(jsonObject),
  schedulerExplanationJson: jsonb("scheduler_explanation_json")
    .notNull()
    .default(jsonObject),
  metadataJson: jsonb("metadata_json").notNull().default(jsonObject),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const executionPlanNodes = execution.table(
  "execution_plan_nodes",
  {
    id: text("id").primaryKey(),
    executionPlanId: text("execution_plan_id")
      .notNull()
      .references(() => executionPlans.id),
    workflowStepId: text("workflow_step_id")
      .notNull()
      .references(() => workflowSteps.id),
    actionPackageName: text("action_package_name").notNull(),
    resolvedVersion: text("resolved_version").notNull(),
    nodeJson: jsonb("node_json").notNull().default(jsonObject),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("idx_execution_plan_nodes_step").on(
      table.executionPlanId,
      table.workflowStepId,
    ),
  ],
);

export const executionPlanEdges = execution.table("execution_plan_edges", {
  id: text("id").primaryKey(),
  executionPlanId: text("execution_plan_id")
    .notNull()
    .references(() => executionPlans.id),
  fromNodeId: text("from_node_id")
    .notNull()
    .references(() => executionPlanNodes.id),
  toNodeId: text("to_node_id")
    .notNull()
    .references(() => executionPlanNodes.id),
  conditionJson: jsonb("condition_json"),
  createdAt: createdAt(),
});

export const executionPlanShards = execution.table("execution_plan_shards", {
  id: text("id").primaryKey(),
  executionPlanId: text("execution_plan_id")
    .notNull()
    .references(() => executionPlans.id),
  workflowTaskId: text("workflow_task_id").references(() => workflowTasks.id),
  shardIndex: integer("shard_index"),
  shardKind: text("shard_kind").notNull(),
  assignedWorkerId: text("assigned_worker_id"),
  natsSubject: text("nats_subject"),
  status: text("status").notNull(),
  inputWeight: integer("input_weight").notNull().default(0),
  sourceLocality: text("source_locality"),
  destinationLocality: text("destination_locality"),
  outputChecksum: text("output_checksum"),
  metadataJson: jsonb("metadata_json").notNull().default(jsonObject),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const assistantConversations = assistant.table(
  "conversations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").references(() => projects.id),
    // Opaque session user id. identity.users is not populated, so this is
    // deliberately not a foreign key.
    userId: text("user_id"),
    title: text("title").notNull().default("New conversation"),
    route: text("route"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_assistant_conversations_owner").on(
      table.organizationId,
      table.userId,
      table.updatedAt,
    ),
  ],
);

export const assistantMessages = assistant.table(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => assistantConversations.id),
    role: text("role").notNull(),
    content: text("content").notNull(),
    metaJson: jsonb("meta_json").notNull().default(jsonObject),
    createdAt: createdAt(),
  },
  (table) => [
    index("idx_assistant_messages_conversation").on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

export const assistantProviderSettings = assistant.table(
  "provider_settings",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    // Opaque session user id; see assistantConversations.userId.
    userId: text("user_id").notNull().default(""),
    providerId: text("provider_id").notNull(),
    baseUrl: text("base_url").notNull(),
    encryptedApiKey: text("encrypted_api_key"),
    model: text("model").notNull().default(""),
    // Compatibility columns for deployments that used split chat/copilot models.
    defaultChatModel: text("default_chat_model").notNull().default(""),
    defaultCopilotModel: text("default_copilot_model").notNull().default(""),
    modelsCacheJson: jsonb("models_cache_json").notNull().default(jsonArray),
    modelsCachedAt: timestamp("models_cached_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("idx_assistant_provider_settings_owner").on(
      table.organizationId,
      table.userId,
    ),
    index("idx_assistant_provider_settings_provider").on(
      table.organizationId,
      table.providerId,
    ),
  ],
);

export const assistantModelCatalogCache = assistant.table(
  "model_catalog_cache",
  {
    cacheKey: text("cache_key").primaryKey(),
    providerId: text("provider_id").notNull(),
    baseUrl: text("base_url").notNull(),
    modelsJson: jsonb("models_json").notNull().default(jsonArray),
    cachedAt: timestamp("cached_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("idx_assistant_model_catalog_provider").on(
      table.providerId,
      table.baseUrl,
    ),
  ],
);

export const beamEnvironmentTemplates = studio.table(
  "beam_environment_templates",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    baseUrl: text("base_url").notNull(),
    coordinatorUrl: text("coordinator_url").notNull(),
    natsUrl: text("nats_url").notNull(),
    authUrl: text("auth_url").notNull(),
    apiUrl: text("api_url").notNull(),
    registryUrl: text("registry_url").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("idx_studio_beam_environment_templates_pk").on(
      table.organizationId,
      table.key,
    ),
  ],
);

export const beamEnvironmentSettings = studio.table(
  "beam_environment_settings",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizations.id),
    defaultTemplateKey: text("default_template_key").notNull().default("prod"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
);

/**
 * The deployment itself, as one row. Studio had no representation of the host
 * it runs as, which is why a session check could only ask whether an
 * organization belonged to the caller and never whether it belonged here.
 */
export const instance = studio.table("instance", {
  id: text("id").primaryKey().default("singleton"),
  state: text("state").notNull().default("unclaimed"),
  // Not a reference to organizations: that table is filled lazily by whichever
  // write path needs it first, and admission is decided before any write.
  ownerOrganizationId: text("owner_organization_id"),
  joinPolicy: text("join_policy").notNull().default("closed"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  claimedByUserId: text("claimed_by_user_id"),
  claimedByEmail: text("claimed_by_email"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Which organizations this deployment serves. */
export const instanceOrganizations = studio.table(
  "instance_organizations",
  {
    organizationId: text("organization_id").primaryKey(),
    role: text("role").notNull().default("member"),
    status: text("status").notNull().default("admitted"),
    // Beam identity strings, not references: identity.users is never written.
    requestedByUserId: text("requested_by_user_id"),
    requestedByEmail: text("requested_by_email"),
    decidedByUserId: text("decided_by_user_id"),
    decidedByEmail: text("decided_by_email"),
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("studio_instance_single_owner")
      .on(table.role)
      .where(sql`${table.role} = 'owner'`),
    index("studio_instance_organizations_status").on(
      table.status,
      table.createdAt,
    ),
  ],
);

export const roomStorageBindings = studio.table(
  "room_storage_bindings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    environmentTemplateKey: text("environment_template_key").notNull(),
    credentialId: text("credential_id")
      .notNull()
      .references(() => credentials.id),
    providerProfileId: text("provider_profile_id")
      .notNull()
      .references(() => providerProfiles.id),
    bucket: text("bucket").notNull(),
    resourceId: text("resource_id").notNull(),
    roomId: text("room_id").notNull(),
    coordinatorMemberId: text("coordinator_member_id").notNull(),
    displayName: text("display_name").notNull(),
    objectChannelIdsJson: jsonb("object_channel_ids_json")
      .notNull()
      .default(jsonArray),
    destinationPrefix: text("destination_prefix").notNull().default(""),
    destinationLayout: text("destination_layout").notNull().default("isolated"),
    collisionPolicy: text("collision_policy")
      .notNull()
      .default("fail_if_exists"),
    sourceDelegateMemberIdsJson: jsonb("source_delegate_member_ids_json")
      .notNull()
      .default(jsonArray),
    sourceDelegateRoleIdsJson: jsonb("source_delegate_role_ids_json")
      .notNull()
      .default(jsonArray),
    availability: text("availability").notNull().default("available"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("idx_studio_room_storage_binding_identity").on(
      table.organizationId,
      table.environmentTemplateKey,
      table.roomId,
      table.resourceId,
    ),
    index("idx_studio_room_storage_binding_credential").on(table.credentialId),
  ],
);

export const roomStorageMultipartSessions = studio.table(
  "room_storage_multipart_sessions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    bindingId: text("binding_id").references(() => roomStorageBindings.id),
    targetMemberId: text("target_member_id").notNull(),
    publicationId: text("publication_id").notNull(),
    childExecutionId: text("child_execution_id").notNull(),
    multipartGroupId: text("multipart_group_id").notNull(),
    objectKey: text("object_key").notNull(),
    uploadId: text("upload_id").notNull(),
    partsJson: jsonb("parts_json").notNull().default(jsonArray),
    state: text("state").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("idx_studio_room_storage_multipart_child").on(
      table.organizationId,
      table.childExecutionId,
    ),
    index("idx_studio_room_storage_multipart_publication").on(
      table.publicationId,
    ),
  ],
);

export const roomStorageTransferJobs = studio.table(
  "room_storage_transfer_jobs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    environmentTemplateKey: text("environment_template_key").notNull(),
    roomId: text("room_id").notNull(),
    channelId: text("channel_id").notNull(),
    publicationId: text("publication_id").notNull(),
    originKind: text("origin_kind").notNull(),
    originKey: text("origin_key").notNull(),
    requestHash: text("request_hash").notNull(),
    workflowRunId: text("workflow_run_id"),
    workflowStepRunId: text("workflow_step_run_id"),
    initiatorAgentId: text("initiator_agent_id"),
    initiatorMemberId: text("initiator_member_id"),
    apiKeyId: text("api_key_id").notNull(),
    sourceMemberId: text("source_member_id").notNull(),
    sourceLocatorJson: jsonb("source_locator_json").notNull(),
    targetMemberIdsJson: jsonb("target_member_ids_json")
      .notNull()
      .default(jsonArray),
    ttlSeconds: integer("ttl_seconds").notNull(),
    allowPartial: boolean("allow_partial").notNull().default(false),
    status: text("status").notNull().default("queued"),
    transferId: text("transfer_id"),
    coordinatorStarted: boolean("coordinator_started").notNull().default(false),
    endpointRefsJson: jsonb("endpoint_refs_json").notNull().default(jsonArray),
    fileJson: jsonb("file_json"),
    preparationJson: jsonb("preparation_json"),
    executionJson: jsonb("execution_json"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("idx_studio_room_storage_transfer_publication").on(
      table.organizationId,
      table.publicationId,
    ),
    uniqueIndex("idx_studio_room_storage_transfer_origin").on(
      table.organizationId,
      table.originKey,
    ),
    index("idx_studio_room_storage_transfer_step").on(table.workflowStepRunId),
    index("idx_studio_room_storage_transfer_status").on(
      table.status,
      table.updatedAt,
    ),
  ],
);

export const executorAssignments = execution.table(
  "executor_assignments",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id),
    workflowStepRunId: text("workflow_step_run_id")
      .notNull()
      .references(() => workflowStepRuns.id),
    taskId: text("task_id")
      .notNull()
      .references(() => workflowTasks.id),
    attempt: integer("attempt").notNull(),
    backend: text("backend").notNull(),
    executorId: text("executor_id").notNull(),
    memberId: text("member_id"),
    sessionGeneration: bigint("session_generation", { mode: "number" }),
    declaredTargetJson: jsonb("declared_target_json").notNull(),
    state: text("state").notNull(),
    commandId: text("command_id"),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
    }).notNull(),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    executorStoppedAt: timestamp("executor_stopped_at", { withTimezone: true }),
    cleanupConfirmedAt: timestamp("cleanup_confirmed_at", {
      withTimezone: true,
    }),
    resultJson: jsonb("result_json"),
    errorJson: jsonb("error_json"),
    progressJson: jsonb("progress_json").notNull().default(jsonObject),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("executor_assignments_task_attempt").on(
      table.taskId,
      table.attempt,
    ),
    index("executor_assignments_active").on(
      table.backend,
      table.state,
      table.leaseExpiresAt,
    ),
    index("executor_assignments_run").on(table.workflowRunId, table.createdAt),
  ],
);
export const executorAssignmentCapabilities = execution.table(
  "executor_assignment_capabilities",
  {
    assignmentId: text("assignment_id")
      .primaryKey()
      .references(() => executorAssignments.id, { onDelete: "cascade" }),
    authorizationToken: text("authorization_token").notNull(),
    createdAt: createdAt(),
  },
);

export const executorProcessOwnership = execution.table(
  "executor_process_ownership",
  {
    assignmentId: text("assignment_id")
      .primaryKey()
      .references(() => executorAssignments.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("preparing"),
    recordPath: text("record_path"),
    recordNonce: text("record_nonce"),
    ownerScope: text("owner_scope"),
    ownerHostIdentity: text("owner_host_identity"),
    ownerBootId: text("owner_boot_id"),
    ownerNativeScope: text("owner_native_scope"),
    updatedAt: updatedAt(),
  },
);

export const fixtureCampaigns = workflow.table("fixture_campaigns", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  parentWorkflowId: text("parent_workflow_id")
    .notNull()
    .unique()
    .references(() => workflowTemplates.id),
  enabled: boolean("enabled").notNull().default(false),
  objectSizeBytes: bigint("object_size_bytes", { mode: "number" })
    .notNull()
    .default(20_000_000_000),
  managedPrefix: text("managed_prefix").notNull(),
  maxGrantTtlSeconds: integer("max_grant_ttl_seconds").notNull().default(86400),
  auditAllowanceSeconds: integer("audit_allowance_seconds")
    .notNull()
    .default(3600),
  admissions: bigint("admissions", { mode: "number" }).notNull().default(0),
  activeGenerationId: text("active_generation_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
export const fixtureSources = workflow.table(
  "fixture_sources",
  {
    campaignId: text("campaign_id")
      .notNull()
      .references(() => fixtureCampaigns.id),
    id: text("id").notNull(),
    workflowStepId: text("workflow_step_id")
      .notNull()
      .unique()
      .references(() => workflowSteps.id),
    bucket: text("bucket").notNull(),
    credentialId: text("credential_id")
      .notNull()
      .references(() => credentials.id),
    legacyKey: text("legacy_key").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.campaignId, table.id] }),
    uniqueIndex("fixture_sources_bucket").on(table.campaignId, table.bucket),
  ],
);
export const fixtureGenerations = workflow.table(
  "fixture_generations",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => fixtureCampaigns.id),
    status: text("status").notNull(),
    leaseToken: text("lease_token"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    admissions: bigint("admissions", { mode: "number" }).notNull().default(0),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    cleanupBlockedReason: text("cleanup_blocked_reason"),
    cleanupCheckedAt: timestamp("cleanup_checked_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("fixture_generation_preparation")
      .on(table.campaignId)
      .where(sql`${table.status} IN ('preparing','ready')`),
    uniqueIndex("fixture_generation_active")
      .on(table.campaignId)
      .where(sql`${table.status}='active'`),
  ],
);
export const fixtureObjects = workflow.table(
  "fixture_objects",
  {
    generationId: text("generation_id")
      .notNull()
      .references(() => fixtureGenerations.id),
    sourceId: text("source_id").notNull(),
    bucket: text("bucket").notNull(),
    objectKey: text("object_key").notNull().unique(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    uploadId: text("upload_id"),
    etag: text("etag"),
    bytesUploaded: bigint("bytes_uploaded", { mode: "number" })
      .notNull()
      .default(0),
    status: text("status").notNull().default("pending"),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.generationId, table.sourceId] })],
);
export const fixtureAbandonedObjects = workflow.table(
  "fixture_abandoned_objects",
  {
    generationId: text("generation_id")
      .notNull()
      .references(() => fixtureGenerations.id),
    sourceId: text("source_id").notNull(),
    bucket: text("bucket").notNull(),
    objectKey: text("object_key").primaryKey(),
    uploadId: text("upload_id"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    createdAt: createdAt(),
  },
);
export const fixtureGenerationReferences = execution.table(
  "fixture_generation_references",
  {
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "restrict" }),
    generationId: text("generation_id")
      .notNull()
      .references(() => fixtureGenerations.id),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.workflowRunId, table.generationId] }),
    index("fixture_generation_references_generation").on(table.generationId),
  ],
);
