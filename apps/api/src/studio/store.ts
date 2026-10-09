import {
  WorkflowReadRepository,
  type WorkflowRunFilters,
} from "./repositories/workflow-read-repository.js";
import { ensureIdentityOrganization } from "./repositories/identity-organization.js";
import { organizationScope } from "./repositories/organization-scope.js";
import { defaultWorkflowKeyPg } from "./default-workflow-key.js";
import {
  resolvedWorkflowMembers,
  workflowRunTaskInspection,
} from "./workflow-run-task-inspection.js";
import {
  prepareWorkflowDeletion,
  readWorkflowReferences,
  type WorkflowReferences,
} from "./repositories/workflow-deletion.js";
import {
  actionExecutionTargetSchema,
  actionTargetPlacement,
  assertActionExecutionTarget,
  type ActionExecutionTarget,
} from "@beam-studio/core";
import {
  authorizeWorkflowExecutionPg,
  legacyProductTablesPresent,
  LegacyProductRetiredError,
  type WorkflowExecutionAuthorizer,
} from "@beam-studio/db";
import {
  defaultWorkflowContract,
  validateWorkflowContract,
  parseWorkflowReferences,
  resolveWorkflowReferences,
  type WorkflowJsonSchema,
  type WorkflowOutputContract,
} from "@beam-studio/core";
import {
  captureWorkflowTreePg,
  enqueueFrozenWorkflowRunPg,
  requestWorkflowCancellationPg,
  retryFrozenWorkflowRunPg,
  referenceFixtureGenerationsPg,
} from "@beam-studio/db";
import {
  requestSummary,
  type AssistantRequestRow,
} from "./assistant-requests.js";
import type { AssistantRequestSummary } from "@beam-studio/shared";
import {
  builtinBeamEnvironmentTemplates,
  defaultBeamEnvironmentTemplateKey,
  normalizeBeamEnvironmentTemplate,
  roomWorkflowConfigSchema,
  roomWorkflowDefinitionConfigSchema,
  workflowRoomContext,
  resolveActionRoomContext,
  type WorkflowRoomContext,
  templateKeyFromValue,
  type BeamEnvironmentTemplate,
} from "@beam-studio/shared";
import { configuredV3LaunchGate } from "../agent-control/v3-room-resolution.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  ActionInputError,
  assertWorkflowActionConfig,
  normalizeClockTime,
  checksumManifest,
  createBuiltinActionRegistry,
  describeFrequency,
  parseScheduleFrequency,
  parseWindowDays,
  projectSchedule,
  normalizeWorkflowEdges,
  validateTriggerTargets,
  workflowNodeDefinition,
  BEAM_TRANSFER_FOLDER_SOURCE_ISSUE,
  beamTransferFolderSources,
  validateWorkflowGraphV2,
  validateActionManifest,
  validateGraphWorkflow,
  workflowPredicateError,
  WORKFLOW_GRAPH_V2,
  WORKFLOW_GRAPH_V3,
  validateWorkflowGraphV3,
  McpError,
  listMcpTools,
  type ActionJson,
  type ActionManifest,
  type ActionPlacement,
  type OverlapPolicy,
  type WorkflowGraphV2Control,
  type WorkflowGraphV3LoopControl,
  type WorkflowGraphV2Definition,
  type WorkflowGraphV3Definition,
  type WorkflowGraphV3Distribution,
} from "@beam-studio/core";
import {
  LOCAL_ORGANIZATION_ID,
  createPostgresPool,
  openSynchronousPostgres,
  pgMany,
  type SqlDatabase,
  pgOne,
  withPostgresTransaction,
  type PgClient,
  type PgPool,
} from "@beam-studio/db";
import {
  mcpScopesJson,
  normalizeCredentialPayloadAliases,
  parseMcpScopes,
  type AssistantModelOption,
  type McpScope,
  isRunStatus,
  type RunStatus,
} from "@beam-studio/shared";
import {
  probeCredential,
  type CredentialProbeResult,
} from "./credential-probe.js";
import { validateProviderBuckets } from "./storage-browser.js";
import {
  decryptString,
  encryptString,
  vaultKeyId,
  vaultSecretFromEnv,
} from "@beam-studio/vault";
import {
  SIGNATURE_WINDOW_SECONDS,
  verifyWebhookSignature,
  webhookSigningSecret,
} from "./webhook-signature.js";
import { webEnv } from "../env.js";
import {
  roundCredits,
  type CreditRounding,
} from "../billing/credit-amount.js";
import { createApiLogger, type ApiLogger } from "../logging.js";
import {
  resolveActionPackageVersionPg,
  type ResolvedActionPackageVersion,
} from "@beam-studio/db";
import { assertWorkflowStudioRunnersAvailablePg } from "./workflow-runner-availability.js";
import {
  assertRegistryVersionInstallable,
  createRegistryClient,
  freshSignedArtifactUrl,
  registryClientUrl,
  normalizeSha256Checksum,
  RegistryClientError,
  type RegistryAdvisory,
} from "./registry-client.js";
import { credentialText, parsePayload } from "./repositories/record-helpers.js";
import { roomTransferActionState } from "./room-transfer-action-state.js";
import { roomTransferActionVersion } from "@beam-studio/shared";
import {
  credentialMetadata,
  credentialPrefix,
  credentialRecordFromRow,
  credentialValuePresent,
  normalizeCredentialPayload,
  prepareCredentialPayload,
} from "./repositories/credential-projection.js";
import {
  StudioConflictError,
  StudioForbiddenError,
  StudioNotFoundError,
  StudioValidationError,
} from "./validation-error.js";

type Row = Record<string, unknown>;

const BEAM_TRANSFER_ACTION = "@beam/transfer";

export type ApiKeyRecord = {
  id: string;
  name: string;
  baseUrl: string;
  natsUrl: string | null;
  environment: string | null;
  source: "local" | "organization";
  organizationId: string | null;
  organizationName: string | null;
  prefix: string | null;
  status: string | null;
  projectName: string | null;
  creditLimit: number | null;
  creditsUsed: number | null;
  secretAvailable: boolean;
  /** The Studio instance key, which new workflows and transfers default to. */
  instanceDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BeamEnvironmentSettingsRecord = {
  devSettingsEnabled: boolean;
  defaultTemplateKey: string;
  /**
   * Whether the room-transfer action is installed. Installation-wide rather
   * than per template: the action comes from the Registry, not from a Beam
   * environment.
   */
  roomTransferAction: {
    available: boolean;
    version: string;
    reason?: string;
  };
  templates: Array<
    BeamEnvironmentTemplate & {
      roomControlAvailable: boolean;
    }
  >;
};

function roomTransferActionSummary() {
  const state = roomTransferActionState();
  return {
    available: state.available,
    version: roomTransferActionVersion,
    ...(state.reason ? { reason: state.reason } : {}),
  };
}

export type CredentialRecord = {
  id: string;
  organizationId: string;
  projectId: string | null;
  name: string;
  kind: string;
  credentialType: string;
  credentialTypeId: string;
  providerProfileId: string | null;
  providerDisplayName: string | null;
  status: string;
  metadata: Row;
  payloadPreview: string;
  /** "studio-instance" for the instance key, which only Studio may change. */
  managedBy: "studio-instance" | null;
  createdAt: string;
  updatedAt: string;
};

export type AssistantProviderSettingsRecord = {
  organizationId: string;
  userId: string;
  providerId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  models: AssistantModelOption[];
  modelsCachedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type McpTokenRecord = {
  id: string;
  organizationId: string;
  name: string;
  tokenPrefix: string;
  scopes: McpScope[];
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: "active" | "revoked" | "expired";
};

export type McpAuditEventRecord = {
  id: string;
  organizationId: string | null;
  tokenId: string | null;
  action: string;
  target: string;
  status: "success" | "failure";
  ipAddress: string | null;
  userAgent: string | null;
  clientName: string | null;
  error: string | null;
  createdAt: string;
};

export type McpTokenUsageSummary = {
  tokenId: string;
  successCount: number;
  failureCount: number;
  lastActivityAt: string | null;
};

export type TransferTemplateRecord = {
  id: string;
  organizationId: string;
  projectId: string | null;
  name: string;
  description: string | null;
  apiKeyId: string;
  apiKeyName: string | null;
  customApiKeyConfigured: boolean;
  baseUrl: string | null;
  beamServerUrl: string | null;
  fileSuffixMode: string;
  notificationWebhookUrl: string | null;
  slackWebhookUrl: string | null;
  notifyOnStart: boolean;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
  notifyOnCancel: boolean;
  enabled: boolean;
  frequency: string;
  sourceCount: number;
  destinationCount: number;
  totalSourceSizeBytes: number;
  totalTransferSizeBytes: number;
  runCount: number;
  lastRunStatus: RunStatus | null;
  createdAt: string;
  updatedAt: string;
};

export type EndpointRecord = {
  id: string;
  transferTemplateId: string;
  name: string;
  sourceType: "file" | "directory";
  provider: string;
  bucket: string;
  objectKey: string;
  filenamePolicy: DestinationFilenamePolicy;
  filenameTemplate: string | null;
  filenameTimezone: string;
  region: string | null;
  endpointUrl: string | null;
  credentialId: string | null;
  credentialName: string | null;
  objectSizeBytes: number | null;
  metadataCheckedAt: string | null;
  metadataError: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type DestinationFilenamePolicy =
  | "overwrite"
  | "run_id"
  | "timestamp"
  | "date_partition"
  | "custom";

export type ScheduleRecord = {
  id: string;
  transferTemplateId: string;
  transferName: string | null;
  frequency: string;
  enabled: boolean;
  status: string;
  startAt: string | null;
  endAt: string | null;
  timezone: string;
  nextRunAt: string | null;
  maxRunDurationSeconds: number | null;
  creditBudgetLimit: number | null;
  creditsConsumed: number;
  maxRuns: number | null;
  runCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgRunDurationSeconds: number;
  lastRunAt: string | null;
  lastError: string | null;
  windowStartTime: string | null;
  windowEndTime: string | null;
  windowDays: number[];
  overlapPolicy: OverlapPolicy;
  estimatedRunCount: number;
  estimateHorizonDays: number | null;
  previewRunAt: string[];
  risks: string[];
  budgetAlertThreshold: number;
  alertState: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RunRecord = {
  id: string;
  transferTemplateId: string;
  transferName: string | null;
  status: RunStatus;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string | null;
  queuedAt: string | null;
  nextAttemptAt: string | null;
  attempts: number;
  maxAttempts: number;
  lockedBy: string | null;
  beamTransferId: string | null;
  trigger: string;
  maxDurationSeconds: number | null;
  creditCost: number;
  cancelReason: string | null;
  timedOutAt: string | null;
};

export type RunTransferRecord = {
  id: string;
  runId: string;
  sourceName: string | null;
  destinationName: string | null;
  destinationObjectKey: string | null;
  status: string;
  beamTransferId: string | null;
  error: string | null;
  createdAt: string;
};

export type ExecutionLogRecord = {
  id: string;
  runId: string | null;
  event: string;
  payload: Row;
  createdAt: string;
  level: string;
  correlationId: string | null;
  workerId: string | null;
};

export type WorkerInstanceRecord = {
  id: string;
  hostname?: string;
  pid?: number;
  status: string;
  source?: "legacy" | "runtime";
  startedAt?: string | null;
  heartbeatAt: string;
  stoppedAt: string | null;
  networkIdentity?: string;
  reachability?: string;
  accessibleEndpoints?: string[];
  capabilities?: string[];
  cpuLoad?: number;
  memoryUsedBytes?: number;
  memoryTotalBytes?: number;
  bandwidthMbps?: number;
  activeTaskCount?: number;
  loadScore?: number;
  updatedAt?: string;
  metadata: Row;
};

export type DeadLetterRunRecord = {
  id: string;
  runId: string;
  transferTemplateId: string;
  transferName: string | null;
  reason: string;
  error: string;
  attempts: number;
  maxAttempts: number;
  beamTransferId: string | null;
  retryRunId: string | null;
  resolvedAt: string | null;
  createdAt: string;
};

export type ActionPackageRecord = {
  id: string;
  name: string;
  version: string;
  source: string;
  manifest: Row;
  checksum: string;
  createdAt: string;
  updatedAt: string;
};

export type RegistryCategoryRecord = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  packageCount: number;
};

export type RegistryPackageVersionRecord = {
  version: string;
  manifest: Row;
  manifestChecksum: string | null;
  artifactChecksum: string | null;
  artifactSizeBytes: number;
  artifactReference: string | null;
  sourceRegistry: string;
  trustLevel: string;
  validationStatus: string | null;
  status: string;
  publishedAt: string | null;
  advisories: RegistryAdvisory[];
  vulnerable: boolean;
};

export type RegistryPackageRecord = {
  id: string;
  packageName: string;
  scope: string;
  name: string;
  displayName: string;
  description: string | null;
  category: string | null;
  categorySlug: string | null;
  visibility: string;
  status: string;
  trustLevel: string;
  latestVersion: string | null;
  versionCount: number;
  latestValidationStatus: string | null;
  latestVersionStatus: string | null;
  latestManifestChecksum: string | null;
  latestArtifactChecksum: string | null;
  latestArtifactReference: string | null;
  latestSourceRegistry: string;
  latestHippiusBucket: string | null;
  latestHippiusKey: string | null;
  latestManifest: Row;
  versions: RegistryPackageVersionRecord[];
  permissions: string[];
  placements: string[];
  tags: string[];
  advisories: RegistryAdvisory[];
  vulnerable: boolean;
  updatedAt: string;
};

export type WorkflowTemplateRecord = {
  room: WorkflowRoomContext | null;
  failurePolicy: "stop_on_failure" | "continue_on_failure";
  inputSchema: WorkflowJsonSchema;
  output: WorkflowOutputContract;
  agentBindings: Row;
  resourceBindings: Row;
  id: string;
  organizationId: string;
  projectId: string | null;
  legacyTransferTemplateId: string | null;
  legacyTransferName: string | null;
  name: string;
  description: string | null;
  /**
   * Beam API key this workflow's runs are charged to. An organization may hold
   * several keys with different caps, so the binding is explicit rather than
   * inferred at run time.
   */
  apiKeyId: string | null;
  graphVersion: "workflow-graph/v1" | "workflow-graph/v2" | "workflow-graph/v3";
  graph: Row;
  enabled: boolean;
  stepCount: number;
  runCount: number;
  lastRunStatus: string | null;
  scheduled: boolean;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateWorkflowTemplateInput = {
  room?: WorkflowRoomContext | null;
  id?: string;
  organizationId?: string | null;
  projectId?: string | null;
  name: string;
  description?: string | null;
  /**
   * Beam API key this workflow's runs are charged to. Defaults to the
   * organization's only key when it has exactly one; otherwise it must be
   * chosen, because spending an unrelated key's allowance is not a safe guess.
   */
  apiKeyId?: string | null;
};

export type UpdateWorkflowTemplateInput = {
  agentBindings?: Row;
  resourceBindings?: Row;
  room?: WorkflowRoomContext | null;
  inputSchema?: WorkflowJsonSchema;
  output?: WorkflowOutputContract;
  failurePolicy?: "stop_on_failure" | "continue_on_failure";
  id: string;
  organizationId?: string | null;
  name?: string;
  description?: string | null;
  enabled?: boolean;
  apiKeyId?: string | null;
};

export type WorkflowStepRecord = {
  executionTarget?: ActionExecutionTarget;
  id: string;
  kind?: "action" | "workflow";
  calledWorkflowId?: string | null;
  workflowTemplateId: string;
  name: string | null;
  actionPackageName: string;
  actionVersionRange: string;
  position: number;
  enabled: boolean;
  config: Row;
  inputBindings: Row;
  placement: string;
  executionLocationId: string | null;
  canvasX: number | null;
  canvasY: number | null;
  timeoutSeconds: number | null;
  required: boolean;
  manifest: Row | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowActionLockRecord = {
  id: string;
  workflowTemplateId: string;
  actionPackageName: string;
  versionRange: string;
  resolvedVersion: string;
  packageVersionId: string | null;
  manifestChecksum: string;
  artifactChecksum: string | null;
  artifactReference: string | null;
  sourceRegistry: string;
  trustLevel: string | null;
  createdAt: string;
};

export type WorkflowActionLockChange = {
  stepId: string;
  kind: "update" | "remove";
  actionPackageName: string;
  previous: WorkflowActionLockRecord;
  next: WorkflowActionLockRecord | null;
};

export type WorkflowEdgeRecord = {
  id: string;
  workflowTemplateId: string;
  fromStepId: string;
  toStepId: string;
  condition: Row | string | boolean | number | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowTriggerType = "manual" | "schedule" | (string & {});

export type WorkflowTriggerRecord = {
  id: string;
  workflowTemplateId: string;
  type: WorkflowTriggerType;
  name: string;
  enabled: boolean;
  config: Row;
  state: Row;
  canvasX: number | null;
  canvasY: number | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowTriggerEdgeRecord = {
  id: string;
  workflowTemplateId: string;
  triggerId: string;
  toStepId: string;
  condition: Row | string | boolean | number | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowDecisionRecord = {
  id: string;
  workflowTemplateId: string;
  name: string;
  kind: "if" | "switch";
  enabled: boolean;
  joinMode: "all" | "any_settled";
  handleFailure: boolean;
  config: Row;
  canvasX: number | null;
  canvasY: number | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowDecisionEdgeRecord = {
  id: string;
  workflowTemplateId: string;
  fromStepId: string | null;
  fromDecisionId: string | null;
  toStepId: string | null;
  toDecisionId: string | null;
  branch: "true" | "false" | `case:${string}` | "default" | null;
  createdAt: string;
  updatedAt: string;
};

export type ExecutionLocationRecord = {
  id: string;
  organizationId: string;
  name: string;
  kind: string;
  endpointUrl: string | null;
  enabled: boolean;
  allowInsecureHttp: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowGraphStepInput = {
  executionTarget?: ActionExecutionTarget;
  id: string;
  kind?: "action" | "workflow";
  calledWorkflowId?: string | null;
  name?: string | null;
  actionPackageName: string;
  actionVersionRange: string;
  position: number;
  enabled: boolean;
  config: Row;
  inputBindings: Row;
  placement: string;
  executionLocationId: string | null;
  canvasX: number | null;
  canvasY: number | null;
  timeoutSeconds: number | null;
  required: boolean;
};

export type WorkflowGraphEdgeInput = {
  id: string;
  fromStepId: string;
  toStepId: string;
  condition: Row | string | boolean | number | null;
};

export type WorkflowGraphTriggerInput = {
  id: string;
  type: string;
  name?: string | null;
  enabled: boolean;
  config?: Row | null;
  state?: Row | null;
  canvasX: number | null;
  canvasY: number | null;
};

export type WorkflowGraphTriggerEdgeInput = {
  id: string;
  triggerId: string;
  toStepId: string;
  condition: Row | string | boolean | number | null;
};

export type WorkflowGraphDecisionInput = {
  id: string;
  name?: string | null;
  kind?: unknown;
  enabled?: boolean;
  joinMode?: unknown;
  handleFailure?: boolean;
  config?: Row | null;
  canvasX: number | null;
  canvasY: number | null;
};

export type WorkflowGraphDecisionEdgeInput = {
  id: string;
  fromStepId?: string | null;
  fromDecisionId?: string | null;
  toStepId?: string | null;
  toDecisionId?: string | null;
  branch?: unknown;
};

export type WorkflowRunRecord = {
  room: WorkflowRoomContext | null;
  organizationId: string;
  parentRunId: string | null;
  rootRunId: string | null;
  output: unknown;
  outputValidation: string;
  historical: boolean;
  historicalSnapshot: Row | null;
  definitionRevisionId: string | null;
  id: string;
  workflowTemplateId: string;
  workflowName: string | null;
  legacyRunId: string | null;
  status: string;
  trigger: string;
  triggerId: string | null;
  triggerType: string | null;
  triggerEvent: Row;
  error: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowDynamicRegionRecord = {
  id: string;
  workflowRunId: string;
  controlId: string;
  controlPath: string;
  kind: string;
  status: string;
  instanceCount: number;
  completedCount: number;
  pendingCount: number;
  runningCount: number;
  failedCount: number;
  cancelledCount: number;
  concurrencyLimit: number | null;
  output: Row;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowDynamicInstanceRecord = {
  id: string;
  dynamicRegionId: string;
  workflowStepId: string;
  controlPath: string;
  instanceIndex: number;
  status: string;
  currentAttempt: number;
  context: Row;
  input: Row;
  output: Row;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type WorkflowStepRunRecord = {
  kind: "action" | "workflow";
  childRunId: string | null;
  id: string;
  workflowRunId: string;
  workflowStepId: string;
  actionPackageName: string;
  resolvedVersion: string;
  checksum: string;
  sourceRegistry: string;
  resolvedPlacement: string;
  executionLocationId: string | null;
  status: string;
  attempt: number;
  input: Row;
  output: ActionJson;
  metadata: Row;
  progress: {
    total: number;
    completed: number;
    running: number;
    failed: number;
    percent: number;
  } | null;
  shardErrors: string[];
  state: Row;
  externalRef: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowArtifactRecord = {
  id: string;
  workflowRunId: string;
  workflowStepRunId: string | null;
  type: string;
  name: string;
  uri: string;
  mediaType: string | null;
  metadata: Row;
  createdAt: string;
};

export type DashboardSummary = {
  transferCount: number;
  enabledTransferCount: number;
  activeScheduleCount: number;
  runCount: number;
  completedRunCount: number;
  failedRunCount: number;
  successRate: number;
  sourceCount: number;
  destinationCount: number;
};

export type WorkflowDashboardSummary = {
  workflowCount: number;
  enabledWorkflowCount: number;
  activeScheduleCount: number;
  runCount: number;
  completedRunCount: number;
  failedRunCount: number;
  successRate: number;
};

export type WorkflowRunActivityPoint = {
  date: string;
  completed: number;
  failed: number;
  other: number;
  total: number;
};

const globalForStudio = globalThis as typeof globalThis & {
  __beamStudioDb?: SqlDatabase;
  __beamStudioPgPool?: PgPool;
};

export const CUSTOM_API_KEY_SELECT_VALUE = "__custom_api_key__";

function now() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

function normalizeOptionalIsoDate(value?: string | null) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new StudioValidationError(
      "expiration_date_invalid",
      "Expiration date must be a valid date.",
      { field: "expiresAt" },
    );
  }

  return new Date(parsed).toISOString();
}

function vaultSecret() {
  return vaultSecretFromEnv();
}

let storeLogger: ApiLogger | undefined;

/** The API service logger, for connection failures of the store's own pools. */
function studioStoreLogger() {
  storeLogger ??= createApiLogger();
  return storeLogger;
}

function db() {
  if (globalForStudio.__beamStudioDb) {
    return globalForStudio.__beamStudioDb;
  }
  const database = openSynchronousPostgres(webEnv.databaseUrl, {
    logger: studioStoreLogger(),
    name: "studio-store-sync",
  });
  globalForStudio.__beamStudioDb = database;
  return database;
}

function pg() {
  if (!globalForStudio.__beamStudioPgPool) {
    globalForStudio.__beamStudioPgPool = createPostgresPool(undefined, {
      logger: studioStoreLogger(),
      name: "studio-store",
    });
  }
  return globalForStudio.__beamStudioPgPool;
}

async function ensureOrganizationPg(
  client: PgPool | PgClient,
  organizationId?: string | null,
) {
  return ensureIdentityOrganization(client, organizationId);
}

function one<T>(sql: string, params: Record<string, unknown> = {}) {
  return db().prepare(sql).get(params) as T | undefined;
}

function many<T>(sql: string, params: Record<string, unknown> = {}) {
  return db().prepare(sql).all(params) as T[];
}

function organizationFilterValue(organizationId?: string | null) {
  return organizationId?.trim() ?? "";
}

let legacyProductState: boolean | null = null;

/**
 * Whether this database still has the pre-workflow transfer tables
 * (`transfer_templates`, `schedules`, `runs`, `beam_api_keys`, ...).
 *
 * The target schema does not create them, so on a fresh Studio database the
 * legacy readers below return no rows and the legacy writers refuse with
 * LegacyProductRetiredError, instead of failing with a missing-relation 500.
 * Deployments migrated before the cutover keep reading their existing rows.
 */
function legacyProductStateAvailable() {
  legacyProductState ??= legacyProductTablesPresent(db());
  return legacyProductState;
}

const retiredLegacyProduct = {
  apiKeys:
    "Legacy Beam API keys are retired on this Studio database. Store Beam API keys as credentials instead.",
  transfers:
    "Transfer templates are retired on this Studio database. Use workflows instead.",
  schedules:
    "Transfer schedules are retired on this Studio database. Use workflow schedule triggers instead.",
  runs: "Transfer runs are retired on this Studio database. Use workflow runs instead.",
} as const;

function requireLegacyProductState(feature: keyof typeof retiredLegacyProduct) {
  if (!legacyProductStateAvailable()) {
    throw new LegacyProductRetiredError(retiredLegacyProduct[feature]);
  }
}

function organizationIdForApiKey(apiKeyId: string) {
  const row = one<Row>(
    "SELECT organization_id FROM organization_api_keys_cache WHERE id = :id",
    { id: apiKeyId },
  );

  return row?.organization_id
    ? String(row.organization_id)
    : LOCAL_ORGANIZATION_ID;
}

function requireApiKeyInOrganization(
  apiKeyId: string,
  organizationId?: string | null,
) {
  const scopedOrganizationId = organizationFilterValue(organizationId);
  if (!scopedOrganizationId) {
    return;
  }

  const row = one<Row>(
    "SELECT organization_id FROM organization_api_keys_cache WHERE id = :id",
    { id: apiKeyId },
  );

  if (!row || String(row.organization_id) !== scopedOrganizationId) {
    const localKey = one<Row>("SELECT id FROM beam_api_keys WHERE id = :id", {
      id: apiKeyId,
    });
    if (!localKey) {
      throw new StudioValidationError(
        "api_key_not_found",
        "API key not found for the selected organization.",
        { field: "apiKeyId" },
      );
    }
  }
}

export async function getBeamEnvironmentSettings(
  organizationId?: string | null,
): Promise<BeamEnvironmentSettingsRecord> {
  if (!webEnv.devSettingsEnabled) {
    const template = deploymentProdTemplate();
    return {
      devSettingsEnabled: false,
      defaultTemplateKey: defaultBeamEnvironmentTemplateKey,
      roomTransferAction: roomTransferActionSummary(),
      templates: [
        {
          ...template,
          roomControlAvailable: Boolean(template.coordinatorUrl),
        },
      ],
    };
  }
  const templates = await listBeamEnvironmentTemplates({ organizationId });
  const configuredDefault =
    await beamEnvironmentDefaultTemplateKey(organizationId);
  const defaultTemplateKey =
    templates.some((template) => template.key === configuredDefault) &&
    webEnv.devSettingsEnabled
      ? configuredDefault
      : defaultBeamEnvironmentTemplateKey;
  return {
    devSettingsEnabled: webEnv.devSettingsEnabled,
    defaultTemplateKey,
    roomTransferAction: roomTransferActionSummary(),
    templates: templates.map((template) => ({
      ...template,
      roomControlAvailable: Boolean(template.coordinatorUrl),
    })),
  };
}

export async function listBeamEnvironmentTemplates(
  filters: { organizationId?: string | null } = {},
): Promise<BeamEnvironmentTemplate[]> {
  const organizationId = organizationFilterValue(filters.organizationId);
  const builtIns = webEnv.devSettingsEnabled
    ? [deploymentProdTemplate(), builtinBeamEnvironmentTemplates.dev]
    : [deploymentProdTemplate()];
  if (!webEnv.devSettingsEnabled) return builtIns;

  const rows = await pgMany<Row>(
    pg(),
    `
    SELECT *
    FROM studio.beam_environment_templates
    WHERE ($1 = '' OR organization_id = $1)
    ORDER BY key
    `,
    [organizationId],
  );
  const custom = rows.map(beamEnvironmentTemplateRecord);
  const byKey = new Map<string, BeamEnvironmentTemplate>();
  for (const template of [...builtIns, ...custom]) {
    byKey.set(template.key, template);
  }
  return [...byKey.values()].sort((left, right) => {
    if (left.key === defaultBeamEnvironmentTemplateKey) return -1;
    if (right.key === defaultBeamEnvironmentTemplateKey) return 1;
    return left.name.localeCompare(right.name);
  });
}

export async function resolveBeamEnvironmentTemplate(input: {
  organizationId?: string | null;
  templateKey?: string | null;
}): Promise<BeamEnvironmentTemplate> {
  if (!webEnv.devSettingsEnabled) return deploymentProdTemplate();
  const settings = await getBeamEnvironmentSettings(input.organizationId);
  const requested =
    templateKeyFromValue(input.templateKey) ?? settings.defaultTemplateKey;
  return (
    settings.templates.find((template) => template.key === requested) ??
    settings.templates.find(
      (template) => template.key === settings.defaultTemplateKey,
    ) ??
    deploymentProdTemplate()
  );
}

export async function updateBeamEnvironmentDefault(input: {
  organizationId?: string | null;
  defaultTemplateKey: string;
}) {
  if (!webEnv.devSettingsEnabled) {
    throw Object.assign(new Error("Beam environment templates are disabled."), {
      code: "beam_environment_templates_disabled",
      statusCode: 404,
    });
  }
  const template = await resolveBeamEnvironmentTemplate({
    organizationId: input.organizationId,
    templateKey: input.defaultTemplateKey,
  });
  if (template.key !== input.defaultTemplateKey) {
    throw Object.assign(new Error("Beam environment template not found."), {
      code: "beam_environment_template_not_found",
      statusCode: 404,
    });
  }
  const timestamp = now();
  await withPostgresTransaction(pg(), async (client) => {
    const organizationId = await ensureOrganizationPg(
      client,
      input.organizationId,
    );
    await client.query(
      `
      INSERT INTO studio.beam_environment_settings (
        organization_id, default_template_key, created_at, updated_at
      )
      VALUES ($1, $2, $3, $3)
      ON CONFLICT (organization_id) DO UPDATE
      SET default_template_key = EXCLUDED.default_template_key,
          updated_at = EXCLUDED.updated_at
      `,
      [organizationId, template.key, timestamp],
    );
  });
  return getBeamEnvironmentSettings(input.organizationId);
}

export async function upsertBeamEnvironmentTemplate(input: {
  organizationId?: string | null;
  template: unknown;
}) {
  if (!webEnv.devSettingsEnabled) {
    throw Object.assign(new Error("Beam environment templates are disabled."), {
      code: "beam_environment_templates_disabled",
      statusCode: 404,
    });
  }
  const template = normalizeBeamEnvironmentTemplate(input.template);
  if (template.key === defaultBeamEnvironmentTemplateKey) {
    throw Object.assign(
      new Error("The built-in PROD template cannot be edited."),
      {
        code: "beam_environment_template_locked",
        statusCode: 409,
      },
    );
  }
  const timestamp = now();
  await withPostgresTransaction(pg(), async (client) => {
    const organizationId = await ensureOrganizationPg(
      client,
      input.organizationId,
    );
    await client.query(
      `
      INSERT INTO studio.beam_environment_templates (
        organization_id, key, name, base_url, coordinator_url, nats_url,
        auth_url, api_url, registry_url, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
      ON CONFLICT (organization_id, key) DO UPDATE
      SET name = EXCLUDED.name,
          base_url = EXCLUDED.base_url,
          coordinator_url = EXCLUDED.coordinator_url,
          nats_url = EXCLUDED.nats_url,
          auth_url = EXCLUDED.auth_url,
          api_url = EXCLUDED.api_url,
          registry_url = EXCLUDED.registry_url,
          updated_at = EXCLUDED.updated_at
      `,
      [
        organizationId,
        template.key,
        template.name,
        template.baseUrl,
        template.coordinatorUrl,
        template.natsUrl,
        template.authUrl,
        template.apiUrl,
        template.registryUrl,
        timestamp,
      ],
    );
  });
  return getBeamEnvironmentSettings(input.organizationId);
}

export async function deleteBeamEnvironmentTemplate(input: {
  organizationId?: string | null;
  templateKey: string;
}) {
  if (!webEnv.devSettingsEnabled) {
    throw Object.assign(new Error("Beam environment templates are disabled."), {
      code: "beam_environment_templates_disabled",
      statusCode: 404,
    });
  }
  const templateKey = templateKeyFromValue(input.templateKey);
  if (!templateKey) {
    throw Object.assign(new Error("Beam environment template not found."), {
      code: "beam_environment_template_not_found",
      statusCode: 404,
    });
  }
  if (templateKey === defaultBeamEnvironmentTemplateKey) {
    throw Object.assign(
      new Error("The built-in PROD template cannot be deleted."),
      {
        code: "beam_environment_template_locked",
        statusCode: 409,
      },
    );
  }
  await withPostgresTransaction(pg(), async (client) => {
    const organizationId = await ensureOrganizationPg(
      client,
      input.organizationId,
    );
    await client.query(
      `
      DELETE FROM studio.beam_environment_templates
      WHERE organization_id = $1 AND key = $2
      `,
      [organizationId, templateKey],
    );
    await client.query(
      `
      UPDATE studio.beam_environment_settings
      SET default_template_key = $2, updated_at = $3
      WHERE organization_id = $1 AND default_template_key = $4
      `,
      [organizationId, defaultBeamEnvironmentTemplateKey, now(), templateKey],
    );
  });
  return getBeamEnvironmentSettings(input.organizationId);
}

async function beamEnvironmentDefaultTemplateKey(
  organizationId?: string | null,
) {
  const row = await pgOne<Row>(
    pg(),
    `
    SELECT default_template_key
    FROM studio.beam_environment_settings
    WHERE organization_id = $1
    `,
    [organizationFilterValue(organizationId) || LOCAL_ORGANIZATION_ID],
  );
  return (
    templateKeyFromValue(row?.default_template_key) ??
    defaultBeamEnvironmentTemplateKey
  );
}

function deploymentProdTemplate(): BeamEnvironmentTemplate {
  return {
    ...builtinBeamEnvironmentTemplates.prod,
    baseUrl: webEnv.beamDefaultBaseUrl,
    coordinatorUrl: webEnv.beamDefaultCoordinatorUrl,
    natsUrl: webEnv.beamDefaultNatsUrl,
    authUrl: webEnv.authUrl,
    apiUrl: webEnv.apiUrl,
    registryUrl: webEnv.beamDefaultRegistryUrl,
  };
}

function beamEnvironmentTemplateRecord(row: Row): BeamEnvironmentTemplate {
  return {
    key: String(row.key),
    name: String(row.name),
    baseUrl: String(row.base_url),
    coordinatorUrl: String(row.coordinator_url),
    natsUrl: String(row.nats_url),
    authUrl: String(row.auth_url),
    apiUrl: String(row.api_url),
    registryUrl: String(row.registry_url),
    builtIn: false,
    createdAt: row.created_at ? String(row.created_at) : null,
    updatedAt: row.updated_at ? String(row.updated_at) : null,
  };
}

async function credentialProfileForProvider(
  client: PgPool | PgClient,
  provider: string,
) {
  const providerProfileId = provider.trim().toLowerCase();
  if (!providerProfileId) {
    throw await unsupportedCredentialProvider(client, provider);
  }

  const row = await pgOne<Row>(
    client,
    `
    SELECT
      pp.id AS provider_profile_id,
      pp.display_name AS provider_display_name,
      pp.required_fields_json,
      pp.field_defaults_json,
      ct.id AS credential_type_id,
      ct.slug AS credential_type_slug
    FROM secrets.provider_profiles pp
    JOIN secrets.credential_types ct ON ct.id = pp.credential_type_id
    WHERE pp.id = $1
      AND pp.enabled = true
    `,
    [providerProfileId],
  );

  if (!row) {
    throw await unsupportedCredentialProvider(client, provider);
  }

  return row;
}

/**
 * The 400 for a credential `kind` that names no enabled provider profile.
 *
 * `kind` is a provider profile id (`beam`, `s3`, `gcs`, ...), not a credential
 * type (`beam_api_key`, `s3_compatible_access_key`, ...). Callers that send
 * the type are told which profile ids carry it rather than getting a 500.
 */
async function unsupportedCredentialProvider(
  client: PgPool | PgClient,
  provider: string,
) {
  const requested = provider.trim();
  const profiles = await pgMany<Row>(
    client,
    `
    SELECT pp.id, ct.slug AS credential_type_slug
    FROM secrets.provider_profiles pp
    JOIN secrets.credential_types ct ON ct.id = pp.credential_type_id
    WHERE pp.enabled = true
    ORDER BY pp.id
    `,
  );
  const acceptedValues = profiles.map((profile) => String(profile.id));
  const forType = profiles
    .filter(
      (profile) =>
        String(profile.credential_type_slug) === requested.toLowerCase(),
    )
    .map((profile) => String(profile.id));
  const hint = forType.length
    ? ` "${requested}" is a credential type; use the provider ${forType
        .map((id) => `"${id}"`)
        .join(" or ")} as the kind.`
    : "";
  return new StudioValidationError(
    requested
      ? "credential_provider_unsupported"
      : "credential_provider_required",
    requested
      ? `Unsupported credential provider "${requested}".${hint}`
      : "Credential provider is required.",
    {
      field: "kind",
      acceptedValues,
      ...(forType.length ? { suggestedValues: forType } : {}),
    },
  );
}

/**
 * Rejects a credential `kind` that names no enabled provider profile with the
 * same 400 as a write would, so a route can refuse it before doing any work.
 */
export async function assertCredentialProvider(kind: string) {
  await credentialProfileForProvider(pg(), kind);
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Row)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableJson(nested)]),
    );
  }
  return value;
}

function transferBelongsToOrganization(
  database: SqlDatabase,
  transferId: string,
  organizationId?: string | null,
) {
  const scopedOrganizationId = organizationFilterValue(organizationId);
  if (!scopedOrganizationId) {
    return true;
  }

  const row = database
    .prepare(
      "SELECT id FROM transfer_templates WHERE id = :id AND organization_id = :organizationId",
    )
    .get({ id: transferId, organizationId: scopedOrganizationId }) as
    | Row
    | undefined;

  return Boolean(row);
}

/**
 * The endpoint's row, refused as not found when the request names a transfer
 * and the endpoint is missing or belongs to a different transfer. Without the
 * transfer check a caller could edit any endpoint of their organization through
 * the URL of an unrelated transfer.
 */
function requireEndpointOwnership(
  table: "transfer_sources" | "transfer_destinations",
  endpointId: string,
  transferTemplateId?: string | null,
) {
  const row = one<Row>(
    `SELECT transfer_template_id FROM ${table} WHERE id = :id`,
    { id: endpointId },
  );
  const expectedTransferId = transferTemplateId?.trim();
  if (
    expectedTransferId !== undefined &&
    (!row || String(row.transfer_template_id) !== expectedTransferId)
  ) {
    throw new StudioNotFoundError(
      "endpoint_not_found",
      "Endpoint not found for this transfer.",
    );
  }
  return row;
}

function requireTransferInOrganization(
  database: SqlDatabase,
  transferId: string,
  organizationId?: string | null,
) {
  if (!transferBelongsToOrganization(database, transferId, organizationId)) {
    throw new StudioNotFoundError(
      "transfer_not_found",
      "Transfer template not found.",
    );
  }
}

function bool(value: unknown) {
  return Number(value) === 1;
}

function destinationFilenamePolicy(value: unknown): DestinationFilenamePolicy {
  return value === "run_id" ||
    value === "timestamp" ||
    value === "date_partition" ||
    value === "custom"
    ? value
    : "overwrite";
}

function destinationFilenameTimezone(value: unknown) {
  const timezone = value ? String(value).trim() : "";
  return timezone || "UTC";
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function positiveNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * A positive credit amount at two decimals, or null. An estimate rounds up and
 * a budget down, so neither lets a schedule spend more than was entered.
 */
function positiveCredits(value: unknown, rounding: CreditRounding) {
  const number = positiveNumber(value);
  if (number === null) return null;
  const credits = roundCredits(number, rounding);
  return credits > 0 ? credits : null;
}

function normalizeOverlapPolicy(value: unknown): OverlapPolicy {
  const policy = String(value ?? "skip_new");
  return policy === "cancel_old" ||
    policy === "allow_parallel" ||
    policy === "queue_new"
    ? policy
    : "skip_new";
}

function normalizeTimezone(value: unknown) {
  const timezone = String(value ?? "").trim();
  if (!timezone) {
    return "UTC";
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    return "UTC";
  }
}

function runStatus(value: unknown): RunStatus {
  const status = String(value);
  if (isRunStatus(status)) {
    return status;
  }

  throw new Error(`Unknown run status: ${status}`);
}

function isCustomApiKeyId(apiKeyId: string) {
  return (
    apiKeyId === CUSTOM_API_KEY_SELECT_VALUE || apiKeyId.startsWith("custom:")
  );
}

function encryptOptionalSecret(value?: string | null) {
  const trimmed = value?.trim() ?? "";
  return trimmed ? encryptString(trimmed, vaultSecret()) : null;
}

function decryptOptionalSecret(value: unknown) {
  if (!value) {
    return null;
  }

  try {
    return decryptString(String(value), vaultSecret());
  } catch {
    return null;
  }
}

function maxRunAttempts() {
  const value = Number(process.env.WORKER_MAX_ATTEMPTS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 3;
}

function workerStaleWorkerTtlMs() {
  const value = Number(process.env.WORKER_STALE_WORKER_TTL_MS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 60_000;
}

function jsonStringArray(payload: unknown) {
  const value =
    typeof payload === "string"
      ? safeJsonParse(payload)
      : payload instanceof Array
        ? payload
        : [];
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter(Boolean)
    : [];
}

function safeJsonParse(payload: string) {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return [];
  }
}

function timestampText(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function endpointFromRow(row: Row): EndpointRecord {
  const sourceType = String(row.source_type ?? "file");
  return {
    id: String(row.id),
    transferTemplateId: String(row.transfer_template_id),
    name: String(row.name),
    sourceType: sourceType === "directory" ? "directory" : "file",
    provider: String(row.provider),
    bucket: String(row.bucket),
    objectKey: String(row.object_key),
    filenamePolicy: destinationFilenamePolicy(row.filename_policy),
    filenameTemplate: row.filename_template
      ? String(row.filename_template)
      : null,
    filenameTimezone: destinationFilenameTimezone(row.filename_timezone),
    region: row.region ? String(row.region) : null,
    endpointUrl: row.endpoint_url ? String(row.endpoint_url) : null,
    credentialId: row.credential_id ? String(row.credential_id) : null,
    credentialName: row.credential_name ? String(row.credential_name) : null,
    objectSizeBytes:
      row.object_size_bytes === null || row.object_size_bytes === undefined
        ? null
        : Number(row.object_size_bytes),
    metadataCheckedAt: row.metadata_checked_at
      ? String(row.metadata_checked_at)
      : null,
    metadataError: row.metadata_error ? String(row.metadata_error) : null,
    enabled: bool(row.enabled),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function getStudioDatabasePath() {
  return webEnv.databaseUrl;
}

export function listCachedOrganizations() {
  if (!legacyProductStateAvailable()) return [];
  return many<Row>(
    `
    SELECT organization_id, organization_name
    FROM organization_api_keys_cache
    GROUP BY organization_id, organization_name
    ORDER BY organization_name, organization_id
    `,
  ).map((row) => ({
    id: String(row.organization_id),
    name: row.organization_name
      ? String(row.organization_name)
      : String(row.organization_id),
  }));
}

/**
 * Legacy `beam_api_keys` rows carry no organization: they were created for
 * the single local organization. A scoped caller sees one only when it is the
 * local organization or one of its own transfers is bound to that key, never
 * every organization's local keys.
 */
const LEGACY_LOCAL_API_KEYS_FOR_ORGANIZATION_SQL = `
  SELECT k.id, k.name, k.base_url, k.created_at, k.updated_at
  FROM beam_api_keys k
  WHERE :organizationId = ''
     OR :organizationId = :localOrganizationId
     OR EXISTS (
       SELECT 1 FROM transfer_templates t
       WHERE t.api_key_id = k.id AND t.organization_id = :organizationId
     )
  ORDER BY k.name
`;

/**
 * Beam API keys visible to the organization: its stored `beam_api_key`
 * credentials, plus the legacy local and cached organization keys on
 * databases that still have those tables.
 */
export async function listApiKeys(
  filters: { organizationId?: string | null } = {},
): Promise<ApiKeyRecord[]> {
  const credentialKeys = await listBillingApiKeys(filters);
  if (!legacyProductStateAvailable()) return credentialKeys;
  const organizationId = organizationFilterValue(filters.organizationId);
  const localKeys = many<Row>(LEGACY_LOCAL_API_KEYS_FOR_ORGANIZATION_SQL, {
    organizationId,
    localOrganizationId: LOCAL_ORGANIZATION_ID,
  }).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    baseUrl: String(row.base_url),
    natsUrl: null,
    environment: null,
    source: "local" as const,
    organizationId: null,
    organizationName: null,
    prefix: null,
    status: "ACTIVE",
    projectName: null,
    creditLimit: null,
    creditsUsed: null,
    secretAvailable: true,
    instanceDefault: false,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));

  const organizationKeys = many<Row>(
    `
    SELECT *
    FROM organization_api_keys_cache
    WHERE (:organizationId = '' OR organization_id = :organizationId)
    ORDER BY organization_name, name
    `,
    { organizationId },
  ).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    baseUrl: webEnv.beamDefaultBaseUrl,
    natsUrl: webEnv.beamDefaultNatsUrl,
    environment: "prod",
    source: "organization" as const,
    organizationId: String(row.organization_id),
    organizationName: row.organization_name
      ? String(row.organization_name)
      : null,
    prefix: row.prefix ? String(row.prefix) : null,
    status: row.status ? String(row.status) : null,
    projectName: row.project_name ? String(row.project_name) : null,
    creditLimit:
      row.credit_limit === null || row.credit_limit === undefined
        ? null
        : Number(row.credit_limit),
    creditsUsed:
      row.credits_used === null || row.credits_used === undefined
        ? null
        : Number(row.credits_used),
    secretAvailable: false,
    instanceDefault: false,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));

  const legacyKeys = [...organizationKeys, ...localKeys];
  const legacyIds = new Set(legacyKeys.map((key) => key.id));
  return [
    ...legacyKeys,
    ...credentialKeys.filter((key) => !legacyIds.has(key.id)),
  ];
}

async function requireVisibleApiKey(
  apiKeyId: string,
  organizationId?: string | null,
) {
  const keys = await listApiKeys({ organizationId });
  if (!keys.some((key) => key.id === apiKeyId)) {
    throw new StudioValidationError(
      "api_key_not_found",
      "API key not found for the selected organization.",
      { field: "apiKeyId" },
    );
  }
}

export function createApiKey(input: {
  name: string;
  baseUrl: string;
  apiKey: string;
}) {
  requireLegacyProductState("apiKeys");
  const timestamp = now();
  const apiKey = input.apiKey.trim();
  if (!input.name.trim() || !input.baseUrl.trim() || !apiKey) {
    throw new StudioValidationError(
      "api_key_fields_required",
      "Name, base URL and API key are required.",
    );
  }

  db()
    .prepare(
      `
    INSERT INTO beam_api_keys (id, name, base_url, encrypted_api_key, created_at, updated_at)
    VALUES (:id, :name, :baseUrl, :encryptedApiKey, :createdAt, :updatedAt)
  `,
    )
    .run({
      id: id("key"),
      name: input.name.trim(),
      baseUrl: input.baseUrl.trim(),
      encryptedApiKey: encryptString(apiKey, vaultSecret()),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
}

export function deleteApiKey(apiKeyId: string) {
  requireLegacyProductState("apiKeys");
  db()
    .prepare("DELETE FROM beam_api_keys WHERE id = :id")
    .run({ id: apiKeyId });
}

export async function listBillingApiKeys(
  filters: { organizationId?: string | null } = {},
): Promise<ApiKeyRecord[]> {
  const credentials = (await listCredentials(filters))
    .filter((credential) => credential.credentialType === "beam_api_key")
    .map((credential) => ({
      id: credential.id,
      name: credential.name,
      baseUrl:
        credentialText(credential.metadata.baseUrl) ||
        webEnv.beamDefaultBaseUrl,
      natsUrl: credentialText(credential.metadata.natsUrl) || null,
      environment: credentialText(credential.metadata.environment) || null,
      source: "local" as const,
      organizationId: credential.organizationId,
      organizationName: null,
      prefix: credentialText(credential.metadata.apiKeyPrefix) || null,
      status: credential.status.toUpperCase(),
      projectName: null,
      creditLimit: null,
      creditsUsed: null,
      secretAvailable: true,
      instanceDefault: credential.managedBy === "studio-instance",
      createdAt: credential.createdAt,
      updatedAt: credential.updatedAt,
    }));
  return credentials;
}

/**
 * The organization's own Beam API key, in the order room control already
 * prefers: its default billing key, then its first active stored key.
 *
 * This is the only credential Studio holds that speaks for an organization
 * with nobody signed in, so it is what an organization-level check has to
 * use. Returns null when the organization has stored none.
 */
export async function organizationBeamApiKey(organizationId: string) {
  const candidates: string[] = [];
  const preferred = await defaultBillingApiKeyId(organizationId);
  if (preferred) candidates.push(preferred);
  for (const key of await listBillingApiKeys({ organizationId })) {
    if (key.status === "ACTIVE" && key.secretAvailable !== false) {
      candidates.push(key.id);
    }
  }
  for (const candidate of new Set(candidates)) {
    const token = await getDecryptedApiKey(candidate, organizationId);
    if (token) return token;
  }
  return null;
}

export async function defaultBillingApiKeyId(
  organizationId?: string | null,
  projectId?: string | null,
  client: PgClient | PgPool = pg(),
): Promise<string | null> {
  if (!organizationId) return null;
  const template = await resolveBeamEnvironmentTemplate({ organizationId });
  return defaultWorkflowKeyPg(client, {
    organizationId,
    projectId,
    template,
    defaultBaseUrl: webEnv.beamDefaultBaseUrl,
  });
}

export async function getDecryptedApiKey(
  apiKeyId: string,
  organizationId?: string | null,
) {
  // Beam API keys are credentials. The legacy public.beam_api_keys table is
  // not part of the target schema, so it is only consulted where it survives.
  const payload = await getCredentialPayload(apiKeyId, organizationId);
  if (payload) return credentialText(payload.api_key) || null;
  if (!legacyProductStateAvailable()) return null;
  const row = one<Row>(
    "SELECT encrypted_api_key FROM beam_api_keys WHERE id = :id",
    { id: apiKeyId },
  );
  return row
    ? decryptString(String(row.encrypted_api_key), vaultSecret())
    : null;
}

/**
 * The raw Beam API key of a run's execution credential, read through the filter
 * execution authorization applies: active, unexpired, inside the project and on
 * an unrevoked version. Authorization and billing both read the key here, so
 * neither acts on a credential the other refuses. Null when none qualifies.
 */
export async function executionBeamApiKey(
  client: PgClient | PgPool,
  input: {
    credentialId: string;
    organizationId: string;
    projectId: string | null;
  },
) {
  const row = await pgOne<Row>(
    client,
    `SELECT v.encrypted_payload FROM secrets.credentials c JOIN secrets.credential_versions v ON v.credential_id=c.id
    WHERE c.id=$1 AND c.organization_id=$2 AND c.status='active' AND (c.expires_at IS NULL OR c.expires_at>now())
    AND (c.project_id IS NULL OR c.project_id=$3) AND v.status='active' AND v.revoked_at IS NULL ORDER BY v.version DESC LIMIT 1`,
    [input.credentialId, input.organizationId, input.projectId],
  );
  if (!row) return null;
  const payload = normalizeCredentialPayload(
    parsePayload(decryptString(String(row.encrypted_payload), vaultSecret())),
  );
  return credentialText(payload.api_key) || null;
}

async function listCredentials(
  filters: { organizationId?: string | null } = {},
): Promise<CredentialRecord[]> {
  const organizationId = organizationFilterValue(filters.organizationId);
  const rows = await pgMany<Row>(
    pg(),
    `
    SELECT
      c.*,
      ct.slug AS credential_type_slug,
      pp.id AS provider_profile_slug,
      pp.display_name AS provider_display_name
    FROM secrets.credentials c
    JOIN secrets.credential_types ct ON ct.id = c.credential_type_id
    LEFT JOIN secrets.provider_profiles pp ON pp.id = c.provider_profile_id
    WHERE c.status = 'active'
      AND ($1 = '' OR c.organization_id = $1)
    ORDER BY COALESCE(pp.display_name, ct.display_name), c.name
    `,
    [organizationId],
  );

  return rows.map(credentialRecordFromRow);
}

async function getCredentialPayload(
  credentialId: string,
  organizationId?: string | null,
) {
  const row = await pgOne<Row>(
    pg(),
    `
    SELECT cv.encrypted_payload
    FROM secrets.credentials c
    JOIN secrets.credential_versions cv ON cv.credential_id = c.id
    WHERE c.id = $1
      AND c.status = 'active'
      AND cv.status = 'active'
      AND ($2 = '' OR c.organization_id = $2)
    ORDER BY cv.version DESC
    LIMIT 1
    `,
    [credentialId, organizationFilterValue(organizationId)],
  );

  if (!row) {
    return null;
  }

  return normalizeCredentialPayload(
    parsePayload(decryptString(String(row.encrypted_payload), vaultSecret())),
  );
}

/**
 * Runs a live connection test against a credential payload before it is saved.
 *
 * When credentialId is supplied the form is an edit, where password fields are
 * submitted blank to mean "keep the stored value" — so the saved payload is
 * merged underneath before probing, or the test would fail on a secret the user
 * never intended to change.
 */
/**
 * Recomputes metadata_json and prefix for every stored credential.
 *
 * Credentials written before secret hints were separated from public
 * identifiers carry plaintext in metadata_json, which is not encrypted: a
 * secret of twelve characters or fewer was stored verbatim, and longer ones
 * leaked their first eight and last four characters. Recomputing from the
 * encrypted payload re-derives every projection under the current rules.
 *
 * Uses the newest version of each credential regardless of status, because a
 * revoked credential keeps its metadata row and therefore keeps the leak.
 */
export async function backfillCredentialMetadata(
  options: { dryRun?: boolean } = {},
) {
  const rows = await pgMany<Row>(
    pg(),
    `
    SELECT
      c.id,
      c.name,
      c.prefix,
      c.metadata_json,
      c.provider_profile_id,
      ct.slug AS credential_type_slug,
      pp.display_name AS provider_display_name,
      pp.field_defaults_json,
      cv.encrypted_payload
    FROM secrets.credentials c
    JOIN secrets.credential_types ct ON ct.id = c.credential_type_id
    LEFT JOIN secrets.provider_profiles pp ON pp.id = c.provider_profile_id
    JOIN LATERAL (
      SELECT encrypted_payload
      FROM secrets.credential_versions
      WHERE credential_id = c.id
      ORDER BY version DESC
      LIMIT 1
    ) cv ON true
    ORDER BY c.created_at
    `,
  );

  const changed: Array<{
    id: string;
    name: string;
    before: string;
    after: string;
  }> = [];
  let unreadable = 0;

  for (const row of rows) {
    let payload: Row;
    try {
      payload = parsePayload(
        decryptString(String(row.encrypted_payload), vaultSecret()),
      );
    } catch {
      // A payload encrypted under a retired key cannot be re-derived. Leave it
      // untouched and report it rather than writing empty metadata over it.
      unreadable += 1;
      continue;
    }

    const normalized = normalizeCredentialPayload({
      ...parsePayload(row.field_defaults_json),
      ...payload,
    });
    const prefix = credentialPrefix(normalized);
    const metadata = credentialMetadata({
      payload: normalized,
      prefix,
      credentialTypeSlug: credentialText(row.credential_type_slug),
      providerProfileId: credentialText(row.provider_profile_id),
      providerDisplayName: credentialText(row.provider_display_name),
    });

    // Compare on sorted keys: the projection builds metadata in a different
    // order than the stored row, and reporting that as a change would bury the
    // rows that actually leak.
    const beforeJson = JSON.stringify(
      stableJson(parsePayload(row.metadata_json)),
    );
    const afterJson = JSON.stringify(stableJson(metadata));
    if (
      beforeJson === afterJson &&
      credentialText(row.prefix) === (prefix ?? "")
    ) {
      continue;
    }
    changed.push({
      id: String(row.id),
      name: credentialText(row.name),
      before: beforeJson,
      after: afterJson,
    });

    if (!options.dryRun) {
      await pg().query(
        `UPDATE secrets.credentials
         SET metadata_json = $2::jsonb, prefix = $3, updated_at = now()
         WHERE id = $1`,
        [String(row.id), JSON.stringify(metadata), prefix],
      );
    }
  }

  return {
    scanned: rows.length,
    changed,
    unreadable,
    dryRun: Boolean(options.dryRun),
  };
}

/**
 * The actions a saved Zapier credential exposes.
 *
 * The workflow editor needs this because a Zapier tool name is an opaque slug
 * that only the user's own MCP server knows; without it the step's Action field
 * is a text box the user has to fill from memory. The names come back, never
 * the endpoint, so nothing here widens what a credential already discloses.
 */
export async function listZapierTools(input: {
  organizationId?: string | null;
  credentialId: string;
}): Promise<{ tools: Array<{ name: string; description: string }> }> {
  const payload = await getCredentialPayload(
    input.credentialId,
    input.organizationId,
  );
  if (!payload) {
    throw new StudioNotFoundError(
      "credential_not_found",
      `Credential "${input.credentialId}" was not found.`,
    );
  }

  const parsed = parsePayload(payload);
  const endpoint = credentialText(parsed.base_url);
  const apiKey = credentialText(parsed.api_key);
  if (!endpoint) {
    throw new StudioValidationError(
      "credential_mcp_url_missing",
      "This credential has no MCP server URL.",
    );
  }

  try {
    const tools = await listMcpTools(
      {
        endpoint,
        ...(apiKey ? { apiKey } : {}),
        timeoutMs: 15_000,
      },
      // The editor is waiting on this, so fail fast rather than backing off.
      { maxAttempts: 1 },
    );
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
      })),
    };
  } catch (error) {
    // The endpoint is a secret, so no message that might quote it escapes.
    throw new Error(
      error instanceof McpError
        ? error.message
        : "The Zapier MCP server could not be reached.",
    );
  }
}

export async function testCredentialPayload(input: {
  organizationId?: string | null;
  kind: string;
  payload: Row;
  credentialId?: string | null;
}): Promise<CredentialProbeResult> {
  const profile = await credentialProfileForProvider(pg(), input.kind);
  const credentialTypeSlug = String(profile.credential_type_slug);

  let payload = input.payload;
  if (input.credentialId) {
    const saved = await getCredentialPayload(
      input.credentialId,
      input.organizationId,
    );
    if (saved) {
      const merged = { ...parsePayload(saved) };
      for (const [key, value] of Object.entries(input.payload)) {
        if (credentialValuePresent(value)) {
          merged[key] = value;
        }
      }
      payload = merged;
    }
  }

  const prepared = {
    ...parsePayload(profile.field_defaults_json),
    ...normalizeCredentialPayload(payload),
  };

  // S3 reachability already has a dedicated check that lists a real bucket.
  if (credentialTypeSlug === "s3_compatible_access_key") {
    const buckets = credentialBucketList(prepared);
    if (!buckets.length) {
      return {
        status: "skipped",
        errorCode: "no_bucket",
        errorMessage: "Add a bucket to test this credential.",
      };
    }
    try {
      await validateProviderBuckets({
        provider: input.kind,
        payload: prepared,
        buckets,
      });
      return { status: "valid", metadata: { buckets: buckets.length } };
    } catch (error) {
      return {
        status: "invalid",
        errorCode: "bucket_unreachable",
        errorMessage: String(
          error instanceof Error ? error.message : error,
        ).slice(0, 500),
      };
    }
  }

  return probeCredential({
    credentialType: credentialTypeSlug,
    payload: prepared,
  });
}

function credentialBucketList(payload: Row) {
  const raw = payload.buckets;
  const list = Array.isArray(raw) ? raw.map((b) => credentialText(b)) : [];
  const single = credentialText(payload.bucket);
  return [...new Set([...list, single].filter(Boolean))];
}

export async function createCredential(input: {
  organizationId?: string | null;
  projectId?: string | null;
  name: string;
  kind: string;
  payload: string;
  /** Outcome of the pre-save connection test, recorded for audit. */
  validation?: CredentialProbeResult;
}) {
  if (!input.name.trim() || !input.kind.trim() || !input.payload.trim()) {
    throw new StudioValidationError(
      "credential_fields_required",
      "Name, provider and JSON payload are required.",
    );
  }

  const clearPayload = parsePayload(input.payload);
  await withPostgresTransaction(pg(), async (client) => {
    const organizationId = await ensureIdentityOrganization(
      client,
      input.organizationId,
    );
    const profile = await credentialProfileForProvider(client, input.kind);
    const prepared = prepareCredentialPayload({
      payload: clearPayload,
      credentialTypeSlug: String(profile.credential_type_slug),
      providerProfileId: String(profile.provider_profile_id),
      providerDisplayName: String(profile.provider_display_name),
      providerDefaults: parsePayload(profile.field_defaults_json),
      requiredFields: jsonStringArray(profile.required_fields_json),
    });
    const timestamp = now();
    const credentialId = id("cred");
    const versionId = id("credv");
    await client.query(
      `
      INSERT INTO secrets.credentials (
        id,
        organization_id,
        project_id,
        credential_type_id,
        provider_profile_id,
        name,
        status,
        prefix,
        fingerprint_hash,
        metadata_json,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9::jsonb, $10, $10)
      `,
      [
        credentialId,
        organizationId,
        input.projectId?.trim() || null,
        profile.credential_type_id,
        profile.provider_profile_id,
        input.name.trim(),
        prepared.prefix,
        prepared.fingerprintHash,
        JSON.stringify(prepared.metadata),
        timestamp,
      ],
    );
    await client.query(
      `
      INSERT INTO secrets.credential_versions (
        id,
        credential_id,
        version,
        encrypted_payload,
        encryption_key_id,
        payload_schema_version,
        status,
        created_at
      )
      VALUES ($1, $2, 1, $3, $4, 1, 'active', $5)
      `,
      [
        versionId,
        credentialId,
        encryptString(JSON.stringify(prepared.payload), vaultSecret()),
        vaultKeyId(vaultSecret()),
        timestamp,
      ],
    );
    await recordCredentialValidationPg(
      client,
      credentialId,
      versionId,
      input.validation,
      timestamp,
    );
  });
}

/**
 * Writes the outcome of a connection test.
 *
 * secrets.credential_validation_events and credentials.last_validated_at were
 * defined in the target schema but never written; this is the first producer.
 */
async function recordCredentialValidationPg(
  client: PgClient,
  credentialId: string,
  credentialVersionId: string,
  validation: CredentialProbeResult | undefined,
  timestamp: string,
) {
  if (!validation) {
    return;
  }
  await client.query(
    `
    INSERT INTO secrets.credential_validation_events (
      id, credential_id, credential_version_id, status, checked_at,
      error_code, error_message, metadata_json
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    `,
    [
      id("credval"),
      credentialId,
      credentialVersionId,
      validation.status,
      timestamp,
      validation.errorCode ?? null,
      validation.errorMessage ?? null,
      JSON.stringify(validation.metadata ?? {}),
    ],
  );
  if (validation.status === "valid") {
    await client.query(
      `UPDATE secrets.credentials SET last_validated_at = $2 WHERE id = $1`,
      [credentialId, timestamp],
    );
  }
}

export async function updateCredential(input: {
  id: string;
  organizationId?: string | null;
  projectId?: string | null;
  name: string;
  kind: string;
  payload: string;
}) {
  if (
    !input.id.trim() ||
    !input.name.trim() ||
    !input.kind.trim() ||
    !input.payload.trim()
  ) {
    throw new StudioValidationError(
      "credential_fields_required",
      "ID, name, provider and JSON payload are required.",
    );
  }

  const clearPayload = parsePayload(input.payload);
  await withPostgresTransaction(pg(), async (client) => {
    const existing = await client.query<Row>(
      `
      SELECT id, external_source
      FROM secrets.credentials
      WHERE id = $1
        AND status = 'active'
        AND ($2 = '' OR organization_id = $2)
      FOR UPDATE
      `,
      [input.id.trim(), organizationFilterValue(input.organizationId)],
    );
    if (existing.rowCount === 0) {
      throw new StudioNotFoundError(
        "credential_not_found",
        "Credential not found for the selected organization.",
      );
    }
    if (existing.rows[0]?.external_source === INSTANCE_KEY_SOURCE) {
      throw managedInstanceKeyError();
    }

    const profile = await credentialProfileForProvider(client, input.kind);
    const prepared = prepareCredentialPayload({
      payload: clearPayload,
      credentialTypeSlug: String(profile.credential_type_slug),
      providerProfileId: String(profile.provider_profile_id),
      providerDisplayName: String(profile.provider_display_name),
      providerDefaults: parsePayload(profile.field_defaults_json),
      requiredFields: jsonStringArray(profile.required_fields_json),
    });
    const timestamp = now();
    const nextVersion =
      Number(
        (
          await pgOne<Row>(
            client,
            `
            SELECT COALESCE(MAX(version), 0) + 1 AS next_version
            FROM secrets.credential_versions
            WHERE credential_id = $1
            `,
            [input.id.trim()],
          )
        )?.next_version ?? 1,
      ) || 1;
    const versionId = id("credv");

    await client.query(
      `
      UPDATE secrets.credential_versions
      SET status = 'superseded',
          revoked_at = $2
      WHERE credential_id = $1
        AND status = 'active'
      `,
      [input.id.trim(), timestamp],
    );
    await client.query(
      `
      UPDATE secrets.credentials
      SET name = $2,
          project_id = COALESCE($3, project_id),
          credential_type_id = $4,
          provider_profile_id = $5,
          prefix = $6,
          fingerprint_hash = $7,
          metadata_json = $8::jsonb,
          updated_at = $9
      WHERE id = $1
      `,
      [
        input.id.trim(),
        input.name.trim(),
        input.projectId?.trim() || null,
        profile.credential_type_id,
        profile.provider_profile_id,
        prepared.prefix,
        prepared.fingerprintHash,
        JSON.stringify(prepared.metadata),
        timestamp,
      ],
    );
    await client.query(
      `
      INSERT INTO secrets.credential_versions (
        id,
        credential_id,
        version,
        encrypted_payload,
        encryption_key_id,
        payload_schema_version,
        status,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, 1, 'active', $6)
      `,
      [
        versionId,
        input.id.trim(),
        nextVersion,
        encryptString(JSON.stringify(prepared.payload), vaultSecret()),
        vaultKeyId(vaultSecret()),
        timestamp,
      ],
    );
  });
}

/**
 * Tags the Beam API key Studio holds for its owner organization after the
 * owner consented at Beam Auth. It is an ordinary beam_api_key credential
 * otherwise, so authorization, billing and transfers use it like any key.
 */
export const INSTANCE_KEY_SOURCE = "beam_studio_instance";

/** Edits and deletes go through Settings → Access, which keeps Beam in step. */
export function managedInstanceKeyError() {
  return new StudioValidationError(
    "credential_managed_by_studio",
    "Studio manages its instance key. Rotate or revoke it under Settings → Access.",
    { field: "id" },
  );
}

export type InstanceKeyCredential = {
  credentialId: string;
  /** The key's id at Beam, as the Console shows it. */
  beamKeyId: string | null;
  name: string;
  prefix: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function readInstanceKeyCredential(
  organizationId: string,
  client: PgClient | PgPool = pg(),
): Promise<InstanceKeyCredential | null> {
  const row = await pgOne<Row>(
    client,
    `SELECT id, external_id, name, prefix, created_at, updated_at
       FROM secrets.credentials
      WHERE organization_id = $1
        AND external_source = $2
        AND status = 'active'`,
    [organizationId, INSTANCE_KEY_SOURCE],
  );
  return row
    ? {
        credentialId: String(row.id),
        beamKeyId: row.external_id ? String(row.external_id) : null,
        name: String(row.name),
        prefix: row.prefix ? String(row.prefix) : null,
        createdAt: timestampText(row.created_at),
        updatedAt: timestampText(row.updated_at),
      }
    : null;
}

/** The instance key's secret, for revoking it with itself. */
export async function instanceKeySecret(organizationId: string) {
  const credential = await readInstanceKeyCredential(organizationId);
  if (!credential) return null;
  const secret = await getDecryptedApiKey(
    credential.credentialId,
    organizationId,
  );
  return secret ? { credentialId: credential.credentialId, secret } : null;
}

/**
 * Stores a freshly minted instance key.
 *
 * A rotation keeps the credential id and adds a version, superseding the old
 * secret, so every workflow and step that names the credential follows the
 * new key. Owner-organization workflows with no billing key adopt it: before
 * this key they had nothing to run with.
 */
export async function storeInstanceKeyCredential(input: {
  organizationId: string;
  beamKeyId: string;
  name: string;
  secret: string;
}): Promise<{ credentialId: string; rotated: boolean }> {
  return withPostgresTransaction(pg(), async (client) => {
    const organizationId = await ensureIdentityOrganization(
      client,
      input.organizationId,
    );
    const existing = await pgOne<Row>(
      client,
      `SELECT id FROM secrets.credentials
        WHERE organization_id = $1 AND external_source = $2 AND status = 'active'
        FOR UPDATE`,
      [organizationId, INSTANCE_KEY_SOURCE],
    );
    const profile = await credentialProfileForProvider(client, "beam");
    const prepared = prepareCredentialPayload({
      payload: { api_key: input.secret },
      credentialTypeSlug: String(profile.credential_type_slug),
      providerProfileId: String(profile.provider_profile_id),
      providerDisplayName: String(profile.provider_display_name),
      providerDefaults: parsePayload(profile.field_defaults_json),
      requiredFields: jsonStringArray(profile.required_fields_json),
    });
    const timestamp = now();
    const encrypted = encryptString(
      JSON.stringify(prepared.payload),
      vaultSecret(),
    );
    const keyId = vaultKeyId(vaultSecret());

    let credentialId: string;
    let version = 1;
    if (existing) {
      credentialId = String(existing.id);
      version =
        Number(
          (
            await pgOne<Row>(
              client,
              `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
                 FROM secrets.credential_versions WHERE credential_id = $1`,
              [credentialId],
            )
          )?.next_version ?? 1,
        ) || 1;
      await client.query(
        `UPDATE secrets.credential_versions
            SET status = 'superseded', revoked_at = $2
          WHERE credential_id = $1 AND status = 'active'`,
        [credentialId, timestamp],
      );
      await client.query(
        `UPDATE secrets.credentials
            SET name = $2, external_id = $3, prefix = $4,
                fingerprint_hash = $5, metadata_json = $6::jsonb, updated_at = $7
          WHERE id = $1`,
        [
          credentialId,
          input.name,
          input.beamKeyId,
          prepared.prefix,
          prepared.fingerprintHash,
          JSON.stringify(prepared.metadata),
          timestamp,
        ],
      );
    } else {
      credentialId = id("cred");
      await client.query(
        `INSERT INTO secrets.credentials (
          id, organization_id, project_id, credential_type_id,
          provider_profile_id, name, status, external_id, external_source,
          prefix, fingerprint_hash, metadata_json, created_at, updated_at
        )
        VALUES ($1, $2, NULL, $3, $4, $5, 'active', $6, $7, $8, $9, $10::jsonb, $11, $11)`,
        [
          credentialId,
          organizationId,
          profile.credential_type_id,
          profile.provider_profile_id,
          input.name,
          input.beamKeyId,
          INSTANCE_KEY_SOURCE,
          prepared.prefix,
          prepared.fingerprintHash,
          JSON.stringify(prepared.metadata),
          timestamp,
        ],
      );
    }
    await client.query(
      `INSERT INTO secrets.credential_versions (
        id, credential_id, version, encrypted_payload, encryption_key_id,
        payload_schema_version, status, created_at
      )
      VALUES ($1, $2, $3, $4, $5, 1, 'active', $6)`,
      [id("credv"), credentialId, version, encrypted, keyId, timestamp],
    );
    await client.query(
      `UPDATE workflow.templates
          SET api_key_id = $2, updated_at = $3
        WHERE organization_id = $1
          AND NULLIF(btrim(api_key_id), '') IS NULL`,
      [organizationId, credentialId, timestamp],
    );
    return { credentialId, rotated: Boolean(existing) };
  });
}

/** Marks the organization's instance key revoked, with every live version. */
export async function markInstanceKeyRevoked(
  organizationId: string,
  client: PgClient | PgPool = pg(),
) {
  const timestamp = now();
  const revoked = await pgMany<Row>(
    client,
    `UPDATE secrets.credentials
        SET status = 'revoked', updated_at = $3
      WHERE organization_id = $1 AND external_source = $2 AND status = 'active'
      RETURNING id`,
    [organizationId, INSTANCE_KEY_SOURCE, timestamp],
  );
  for (const row of revoked) {
    await client.query(
      `UPDATE secrets.credential_versions
          SET status = 'revoked', revoked_at = $2
        WHERE credential_id = $1 AND status = 'active'`,
      [String(row.id), timestamp],
    );
  }
  return revoked.length > 0;
}

export type RoomStorageCredential = {
  credentialId: string;
  providerProfileId: string;
  providerName: string;
};

export async function requireRoomStorageCredential(
  organizationId: string,
  credentialId: string,
): Promise<RoomStorageCredential> {
  const result = await pg().query(
    `
    SELECT c.id AS credential_id,
           pp.id AS provider_profile_id,
           pp.display_name AS provider_name,
           pp.driver,
           EXISTS (
             SELECT 1 FROM secrets.credential_versions cv
             WHERE cv.credential_id = c.id AND cv.status = 'active'
           ) AS has_active_version
    FROM secrets.credentials c
    JOIN secrets.provider_profiles pp ON pp.id = c.provider_profile_id
    WHERE c.id = $1 AND c.organization_id = $2 AND c.status = 'active' AND pp.enabled = TRUE
    `,
    [credentialId, organizationId],
  );
  const row = result.rows[0];
  if (
    !row ||
    row.driver !== "s3-compatible" ||
    row.has_active_version !== true
  ) {
    throw new StudioValidationError(
      "storage_credential_invalid",
      "Select an active S3-compatible credential with an available vault version.",
      { field: "credentialId" },
    );
  }
  return {
    credentialId: String(row.credential_id),
    providerProfileId: String(row.provider_profile_id),
    providerName: String(row.provider_name),
  };
}

export async function createRoomStorageBinding(input: {
  organizationId: string;
  environmentTemplateKey: string;
  roomId: string;
  credentialId: string;
  providerProfileId: string;
  bucket: string;
  coordinatorMemberId: string;
  displayName: string;
  objectChannelIds: string[];
  destinationPrefix: string;
  destinationLayout: "isolated" | "preserve_path" | "flat_name";
  collisionPolicy: "fail_if_exists" | "overwrite";
  sourceDelegateMemberIds: string[];
  sourceDelegateRoleIds: string[];
}) {
  const resourceId = roomStorageResourceId(input);
  const id = `rsb_${randomBytes(16).toString("hex")}`;
  const timestamp = now();
  const result = await pg().query(
    `
    INSERT INTO studio.room_storage_bindings (
      id, organization_id, environment_template_key, credential_id, provider_profile_id,
      bucket, resource_id, room_id, coordinator_member_id, display_name,
      object_channel_ids_json, destination_prefix, destination_layout, collision_policy,
      source_delegate_member_ids_json, source_delegate_role_ids_json, availability, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15::jsonb,$16::jsonb,'available',$17,$17)
    ON CONFLICT (organization_id, environment_template_key, room_id, resource_id)
    DO UPDATE SET coordinator_member_id = EXCLUDED.coordinator_member_id,
                  display_name = EXCLUDED.display_name,
                  object_channel_ids_json = EXCLUDED.object_channel_ids_json,
                  destination_prefix = EXCLUDED.destination_prefix,
                  destination_layout = EXCLUDED.destination_layout,
                  collision_policy = EXCLUDED.collision_policy,
                  source_delegate_member_ids_json = EXCLUDED.source_delegate_member_ids_json,
                  source_delegate_role_ids_json = EXCLUDED.source_delegate_role_ids_json,
                  availability = 'available', updated_at = EXCLUDED.updated_at
    RETURNING *
    `,
    [
      id,
      input.organizationId,
      input.environmentTemplateKey,
      input.credentialId,
      input.providerProfileId,
      input.bucket,
      resourceId,
      input.roomId,
      input.coordinatorMemberId,
      input.displayName,
      JSON.stringify(input.objectChannelIds),
      input.destinationPrefix,
      input.destinationLayout,
      input.collisionPolicy,
      JSON.stringify(input.sourceDelegateMemberIds),
      JSON.stringify(input.sourceDelegateRoleIds),
      timestamp,
    ],
  );
  return roomStorageBindingRow(result.rows[0]);
}

export async function listRoomStorageBindings(
  organizationId: string,
  environmentTemplateKey: string,
  roomId: string,
) {
  const result = await pg().query(
    `SELECT * FROM studio.room_storage_bindings
     WHERE organization_id=$1 AND environment_template_key=$2 AND room_id=$3 AND availability <> 'revoked'
     ORDER BY display_name, id`,
    [organizationId, environmentTemplateKey, roomId],
  );
  return result.rows.map(roomStorageBindingRow);
}

export async function listRoomStorageBindingsAcrossTemplates(
  organizationId: string,
  roomId: string,
) {
  const result = await pg().query(
    `SELECT * FROM studio.room_storage_bindings
     WHERE organization_id=$1 AND room_id=$2 AND availability <> 'revoked'
     ORDER BY environment_template_key, display_name, id`,
    [organizationId, roomId],
  );
  return result.rows.map(roomStorageBindingRow);
}

export async function getRoomStorageBindingByMember(
  organizationId: string,
  environmentTemplateKey: string,
  roomId: string,
  memberId: string,
) {
  const result = await pg().query(
    `SELECT * FROM studio.room_storage_bindings
     WHERE organization_id=$1 AND environment_template_key=$2 AND room_id=$3 AND coordinator_member_id=$4 AND availability <> 'revoked'`,
    [organizationId, environmentTemplateKey, roomId, memberId],
  );
  return result.rows[0] ? roomStorageBindingRow(result.rows[0]) : null;
}

export async function revokeRoomStorageBinding(
  organizationId: string,
  bindingId: string,
) {
  const result = await pg().query(
    `UPDATE studio.room_storage_bindings SET availability='revoked', updated_at=$3
     WHERE id=$1 AND organization_id=$2 RETURNING *`,
    [bindingId, organizationId, now()],
  );
  return result.rows[0] ? roomStorageBindingRow(result.rows[0]) : null;
}

export async function updateRoomStorageBinding(input: {
  organizationId: string;
  bindingId: string;
  displayName: string;
  destinationPrefix: string;
  destinationLayout: "isolated" | "preserve_path" | "flat_name";
  collisionPolicy: "fail_if_exists" | "overwrite";
  sourceDelegateMemberIds: string[];
  sourceDelegateRoleIds: string[];
}) {
  const result = await pg().query(
    `UPDATE studio.room_storage_bindings
     SET display_name=$3, destination_prefix=$4, destination_layout=$5,
         collision_policy=$6, source_delegate_member_ids_json=$7::jsonb,
         source_delegate_role_ids_json=$8::jsonb, updated_at=$9
     WHERE id=$1 AND organization_id=$2 AND availability <> 'revoked'
     RETURNING *`,
    [
      input.bindingId,
      input.organizationId,
      input.displayName,
      input.destinationPrefix,
      input.destinationLayout,
      input.collisionPolicy,
      JSON.stringify(input.sourceDelegateMemberIds),
      JSON.stringify(input.sourceDelegateRoleIds),
      now(),
    ],
  );
  return result.rows[0] ? roomStorageBindingRow(result.rows[0]) : null;
}

export function roomStorageResourceId(input: {
  organizationId: string;
  environmentTemplateKey: string;
  credentialId: string;
  providerProfileId: string;
  bucket: string;
}) {
  return `btr_storage_${createHash("sha256")
    .update(
      [
        input.organizationId,
        input.environmentTemplateKey,
        input.credentialId,
        input.providerProfileId,
        input.bucket,
      ].join("\0"),
    )
    .digest("hex")}`;
}

function roomStorageBindingRow(row: Row) {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    environmentTemplateKey: String(row.environment_template_key),
    credentialId: String(row.credential_id),
    providerProfileId: String(row.provider_profile_id),
    bucket: String(row.bucket),
    resourceId: String(row.resource_id),
    roomId: String(row.room_id),
    coordinatorMemberId: String(row.coordinator_member_id),
    displayName: String(row.display_name),
    objectChannelIds: jsonArrayText(row.object_channel_ids_json),
    destinationPrefix: String(row.destination_prefix),
    destinationLayout: String(row.destination_layout),
    collisionPolicy: String(row.collision_policy),
    sourceDelegateMemberIds: jsonArrayText(row.source_delegate_member_ids_json),
    availability: String(row.availability),
    sourceDelegateRoleIds: jsonArrayText(row.source_delegate_role_ids_json),
    createdAt: timestampText(row.created_at),
    updatedAt: timestampText(row.updated_at),
  };
}

function jsonArrayText(value: unknown): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

/** Reads the detail the target schema keeps in mcp.audit_events.metadata_json. */
function mcpAuditMetadata(value: unknown) {
  const payload =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    status: typeof payload.status === "string" ? payload.status : "failure",
    clientName:
      typeof payload.clientName === "string" ? payload.clientName : null,
    error: typeof payload.error === "string" ? payload.error : null,
  };
}

export function listMcpAuditEvents(
  filters: {
    organizationId?: string | null;
    tokenId?: string | null;
    limit?: number;
  } = {},
): McpAuditEventRecord[] {
  const organizationId = organizationFilterValue(filters.organizationId);
  const tokenId = filters.tokenId?.trim() ?? "";
  const limit = Math.min(Math.max(filters.limit ?? 40, 1), 200);

  return many<Row>(
    `
    SELECT *
    FROM mcp.audit_events
    WHERE (:organizationId = '' OR organization_id = :organizationId)
      AND (:tokenId = '' OR token_id = :tokenId)
    ORDER BY created_at DESC
    LIMIT :limit
    `,
    { organizationId, tokenId, limit },
  ).map((row) => ({
    id: String(row.id),
    organizationId: row.organization_id ? String(row.organization_id) : null,
    tokenId: row.token_id ? String(row.token_id) : null,
    action: String(row.event_type),
    target: String(row.subject_id ?? ""),
    // status, clientName and error are event detail rather than structure, so
    // the target schema keeps them in the payload.
    status:
      mcpAuditMetadata(row.metadata_json).status === "success"
        ? "success"
        : "failure",
    ipAddress: row.ip_address ? String(row.ip_address) : null,
    userAgent: row.user_agent ? String(row.user_agent) : null,
    clientName: mcpAuditMetadata(row.metadata_json).clientName,
    error: mcpAuditMetadata(row.metadata_json).error,
    createdAt: String(row.created_at),
  }));
}

export function listTransfers(
  filters: {
    q?: string;
    state?: string;
    organizationId?: string | null;
    projectId?: string | null;
  } = {},
): TransferTemplateRecord[] {
  if (!legacyProductStateAvailable()) return [];
  const organizationId = organizationFilterValue(filters.organizationId);
  const projectId = organizationFilterValue(filters.projectId);
  const rows = many<Row>(
    `
    SELECT
      t.*,
      CASE
        WHEN t.encrypted_custom_api_key IS NOT NULL THEN COALESCE(k.name, ok.name, 'Custom API key')
        ELSE COALESCE(k.name, ok.name)
      END AS api_key_name,
      COALESCE(t.beam_server_url, k.base_url, :defaultBaseUrl) AS base_url,
      CASE WHEN ok.id IS NOT NULL THEN 'organization' ELSE 'local' END AS api_key_source,
      COALESCE(src.count, 0) AS source_count,
      COALESCE(dst.count, 0) AS destination_count,
      COALESCE(run_counts.count, 0) AS run_count,
      last_run.status AS last_run_status,
      schedule.frequency AS frequency
    FROM transfer_templates t
    LEFT JOIN beam_api_keys k ON k.id = t.api_key_id
    LEFT JOIN organization_api_keys_cache ok ON ok.id = t.api_key_id
    LEFT JOIN (SELECT transfer_template_id, COUNT(*) AS count FROM transfer_sources GROUP BY transfer_template_id) src
      ON src.transfer_template_id = t.id
    LEFT JOIN (SELECT transfer_template_id, COUNT(*) AS count FROM transfer_destinations GROUP BY transfer_template_id) dst
      ON dst.transfer_template_id = t.id
    LEFT JOIN (SELECT transfer_template_id, COUNT(*) AS count FROM runs GROUP BY transfer_template_id) run_counts
      ON run_counts.transfer_template_id = t.id
    LEFT JOIN (
      SELECT r1.transfer_template_id, r1.status
      FROM runs r1
      INNER JOIN (
        SELECT transfer_template_id, MAX(created_at) AS created_at
        FROM runs
        GROUP BY transfer_template_id
      ) latest ON latest.transfer_template_id = r1.transfer_template_id AND latest.created_at = r1.created_at
    ) last_run ON last_run.transfer_template_id = t.id
    LEFT JOIN (
      SELECT DISTINCT ON (transfer_template_id)
        transfer_template_id, frequency
      FROM schedules
      ORDER BY transfer_template_id, updated_at DESC
    ) schedule ON schedule.transfer_template_id = t.id
    WHERE (:q = '' OR LOWER(t.name) LIKE LOWER(:likeQ) OR LOWER(COALESCE(t.description, '')) LIKE LOWER(:likeQ))
      AND (:state = 'all' OR (:state = 'enabled' AND t.enabled = 1) OR (:state = 'disabled' AND t.enabled = 0))
      AND (:organizationId = '' OR t.organization_id = :organizationId)
      AND (:projectId = '' OR t.project_id = :projectId)
    ORDER BY t.updated_at DESC, t.created_at DESC
    `,
    {
      q: filters.q?.trim() ?? "",
      likeQ: `%${filters.q?.trim() ?? ""}%`,
      state: filters.state ?? "all",
      organizationId,
      projectId,
      defaultBaseUrl: webEnv.beamDefaultBaseUrl,
    },
  );

  return rows.map((row) => ({
    id: String(row.id),
    organizationId: String(row.organization_id ?? LOCAL_ORGANIZATION_ID),
    projectId: row.project_id ? String(row.project_id) : null,
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    apiKeyId: String(row.api_key_id),
    apiKeyName: row.api_key_name ? String(row.api_key_name) : null,
    customApiKeyConfigured: Boolean(row.encrypted_custom_api_key),
    baseUrl: row.base_url ? String(row.base_url) : null,
    beamServerUrl: row.beam_server_url ? String(row.beam_server_url) : null,
    fileSuffixMode: row.file_suffix_mode
      ? String(row.file_suffix_mode)
      : "none",
    notificationWebhookUrl: decryptOptionalSecret(
      row.encrypted_notification_webhook_url,
    ),
    slackWebhookUrl: decryptOptionalSecret(row.encrypted_slack_webhook_url),
    notifyOnStart: bool(row.notify_on_start),
    notifyOnSuccess: bool(row.notify_on_success ?? 1),
    notifyOnFailure: bool(row.notify_on_failure ?? 1),
    notifyOnCancel: bool(row.notify_on_cancel ?? 1),
    enabled: bool(row.enabled),
    frequency: row.frequency ? String(row.frequency) : "manual",
    sourceCount: Number(row.source_count ?? 0),
    destinationCount: Number(row.destination_count ?? 0),
    totalSourceSizeBytes: Number(row.total_source_size_bytes ?? 0),
    totalTransferSizeBytes: Number(row.total_transfer_size_bytes ?? 0),
    runCount: Number(row.run_count ?? 0),
    lastRunStatus: row.last_run_status ? runStatus(row.last_run_status) : null,
    createdAt: timestampText(row.created_at),
    updatedAt: timestampText(row.updated_at),
  }));
}

export function getTransfer(
  idValue: string,
  organizationId?: string | null,
  projectId?: string | null,
) {
  const transfer =
    listTransfers({ organizationId, projectId }).find(
      (item) => item.id === idValue,
    ) ?? null;
  if (!transfer) {
    return null;
  }

  const sources = many<Row>(
    `
    SELECT s.*, c.name AS credential_name
    FROM transfer_sources s
    LEFT JOIN secrets.credentials c ON c.id = s.credential_id
    WHERE s.transfer_template_id = :id
    ORDER BY s.created_at
    `,
    { id: idValue },
  ).map(endpointFromRow);
  const destinations = many<Row>(
    `
    SELECT d.*, c.name AS credential_name
    FROM transfer_destinations d
    LEFT JOIN secrets.credentials c ON c.id = d.credential_id
    WHERE d.transfer_template_id = :id
    ORDER BY d.created_at
    `,
    { id: idValue },
  ).map(endpointFromRow);
  const runs = listRuns({ transferId: idValue, organizationId }).slice(0, 12);
  const schedules = listSchedules({ organizationId }).filter(
    (schedule) => schedule.transferTemplateId === idValue,
  );

  return { transfer, sources, destinations, runs, schedules };
}

export function createTransfer(input: {
  organizationId?: string | null;
  projectId?: string | null;
  name: string;
  description?: string | null;
  apiKeyId: string;
  customApiKey?: string | null;
  beamServerUrl?: string | null;
  fileSuffixMode?: string;
  notificationWebhookUrl?: string | null;
  slackWebhookUrl?: string | null;
  notifyOnStart: boolean;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
  notifyOnCancel: boolean;
  enabled: boolean;
  frequency?: string | null;
}) {
  requireLegacyProductState("transfers");
  const timestamp = now();
  const customApiKey = input.customApiKey?.trim() ?? "";
  const transferId = id("tpl");
  const selectedApiKeyId = input.apiKeyId.trim();
  const storedApiKeyId =
    selectedApiKeyId && !isCustomApiKeyId(selectedApiKeyId)
      ? selectedApiKeyId
      : customApiKey
        ? `custom:${transferId}`
        : "";

  if (!input.name.trim() || (!storedApiKeyId && !customApiKey)) {
    throw new StudioValidationError(
      "transfer_fields_required",
      "Name and API key are required.",
    );
  }

  const organizationId =
    organizationFilterValue(input.organizationId) ||
    (isCustomApiKeyId(storedApiKeyId)
      ? LOCAL_ORGANIZATION_ID
      : organizationIdForApiKey(storedApiKeyId));
  if (!isCustomApiKeyId(storedApiKeyId)) {
    requireApiKeyInOrganization(storedApiKeyId, input.organizationId);
  }
  db()
    .prepare(
      `
    INSERT INTO transfer_templates (
      id, organization_id, project_id, name, description, api_key_id, beam_server_url,
      encrypted_custom_api_key,
      file_suffix_mode, encrypted_notification_webhook_url, encrypted_slack_webhook_url,
      notify_on_start, notify_on_success, notify_on_failure, notify_on_cancel,
      enabled, created_at, updated_at
    )
    VALUES (
      :id, :organizationId, :projectId, :name, :description, :apiKeyId, :beamServerUrl,
      :encryptedCustomApiKey,
      :fileSuffixMode, :encryptedNotificationWebhookUrl, :encryptedSlackWebhookUrl,
      :notifyOnStart, :notifyOnSuccess, :notifyOnFailure, :notifyOnCancel,
      :enabled, :createdAt, :updatedAt
    )
  `,
    )
    .run({
      id: transferId,
      organizationId,
      projectId: input.projectId?.trim() || null,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      apiKeyId: storedApiKeyId,
      beamServerUrl: input.beamServerUrl?.trim() || null,
      encryptedCustomApiKey: customApiKey
        ? encryptString(customApiKey, vaultSecret())
        : null,
      fileSuffixMode: input.fileSuffixMode ?? "none",
      encryptedNotificationWebhookUrl: encryptOptionalSecret(
        input.notificationWebhookUrl,
      ),
      encryptedSlackWebhookUrl: encryptOptionalSecret(input.slackWebhookUrl),
      notifyOnStart: input.notifyOnStart ? 1 : 0,
      notifyOnSuccess: input.notifyOnSuccess ? 1 : 0,
      notifyOnFailure: input.notifyOnFailure ? 1 : 0,
      notifyOnCancel: input.notifyOnCancel ? 1 : 0,
      enabled: input.enabled ? 1 : 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

  if (input.frequency?.trim() && input.frequency.trim() !== "manual") {
    createSchedule({
      organizationId,
      transferTemplateId: transferId,
      frequency: input.frequency.trim(),
      enabled: input.enabled,
    });
  }

  return transferId;
}

export function updateTransfer(input: {
  id: string;
  organizationId?: string | null;
  name: string;
  description?: string | null;
  apiKeyId: string;
  customApiKey?: string | null;
  removeCustomApiKey?: boolean;
  beamServerUrl?: string | null;
  fileSuffixMode?: string;
  notificationWebhookUrl?: string | null;
  slackWebhookUrl?: string | null;
  notifyOnStart: boolean;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
  notifyOnCancel: boolean;
  enabled: boolean;
}) {
  requireLegacyProductState("transfers");
  const existing = one<Row>(
    "SELECT organization_id, encrypted_custom_api_key FROM transfer_templates WHERE id = :id",
    { id: input.id },
  );
  if (!existing) {
    throw new StudioNotFoundError(
      "transfer_not_found",
      "Transfer template not found.",
    );
  }

  const selectedApiKeyId = input.apiKeyId.trim();
  const customApiKey = input.customApiKey?.trim() ?? "";
  const encryptedCustomApiKey = input.removeCustomApiKey
    ? null
    : customApiKey
      ? encryptString(customApiKey, vaultSecret())
      : existing.encrypted_custom_api_key
        ? String(existing.encrypted_custom_api_key)
        : null;
  const storedApiKeyId =
    selectedApiKeyId && !isCustomApiKeyId(selectedApiKeyId)
      ? selectedApiKeyId
      : encryptedCustomApiKey
        ? `custom:${input.id}`
        : "";
  if (!input.name.trim() || (!storedApiKeyId && !encryptedCustomApiKey)) {
    throw new StudioValidationError(
      "transfer_fields_required",
      "Name and API key are required.",
    );
  }

  const organizationId =
    organizationFilterValue(input.organizationId) ||
    (isCustomApiKeyId(storedApiKeyId)
      ? String(existing.organization_id ?? LOCAL_ORGANIZATION_ID)
      : organizationIdForApiKey(storedApiKeyId));
  if (!isCustomApiKeyId(storedApiKeyId)) {
    requireApiKeyInOrganization(storedApiKeyId, input.organizationId);
  }
  db()
    .prepare(
      `
    UPDATE transfer_templates
    SET organization_id = :organizationId,
        name = :name,
        description = :description,
        api_key_id = :apiKeyId,
        beam_server_url = :beamServerUrl,
        encrypted_custom_api_key = :encryptedCustomApiKey,
        file_suffix_mode = :fileSuffixMode,
        encrypted_notification_webhook_url = :encryptedNotificationWebhookUrl,
        encrypted_slack_webhook_url = :encryptedSlackWebhookUrl,
        notify_on_start = :notifyOnStart,
        notify_on_success = :notifyOnSuccess,
        notify_on_failure = :notifyOnFailure,
        notify_on_cancel = :notifyOnCancel,
        enabled = :enabled,
        updated_at = :updatedAt
    WHERE id = :id
      AND (:currentOrganizationId = '' OR organization_id = :currentOrganizationId)
  `,
    )
    .run({
      id: input.id,
      organizationId,
      currentOrganizationId: organizationFilterValue(input.organizationId),
      name: input.name.trim(),
      description: input.description?.trim() || null,
      apiKeyId: storedApiKeyId,
      beamServerUrl: input.beamServerUrl?.trim() || null,
      encryptedCustomApiKey,
      fileSuffixMode: input.fileSuffixMode ?? "none",
      encryptedNotificationWebhookUrl: encryptOptionalSecret(
        input.notificationWebhookUrl,
      ),
      encryptedSlackWebhookUrl: encryptOptionalSecret(input.slackWebhookUrl),
      notifyOnStart: input.notifyOnStart ? 1 : 0,
      notifyOnSuccess: input.notifyOnSuccess ? 1 : 0,
      notifyOnFailure: input.notifyOnFailure ? 1 : 0,
      notifyOnCancel: input.notifyOnCancel ? 1 : 0,
      enabled: input.enabled ? 1 : 0,
      updatedAt: now(),
    });
}

export function deleteTransfer(
  transferId: string,
  organizationId?: string | null,
) {
  requireLegacyProductState("transfers");
  const database = db();
  requireTransferInOrganization(database, transferId, organizationId);
  database.exec("BEGIN");
  try {
    const runIds = many<Row>(
      "SELECT id FROM runs WHERE transfer_template_id = :id",
      { id: transferId },
    );
    for (const run of runIds) {
      database
        .prepare("DELETE FROM run_transfers WHERE run_id = :id")
        .run({ id: String(run.id) });
      database
        .prepare("DELETE FROM execution_logs WHERE run_id = :id")
        .run({ id: String(run.id) });
    }
    database
      .prepare("DELETE FROM runs WHERE transfer_template_id = :id")
      .run({ id: transferId });
    database
      .prepare("DELETE FROM schedules WHERE transfer_template_id = :id")
      .run({ id: transferId });
    database
      .prepare("DELETE FROM transfer_sources WHERE transfer_template_id = :id")
      .run({ id: transferId });
    database
      .prepare(
        "DELETE FROM transfer_destinations WHERE transfer_template_id = :id",
      )
      .run({ id: transferId });
    database
      .prepare("DELETE FROM transfer_templates WHERE id = :id")
      .run({ id: transferId });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function toggleTransfer(
  transferId: string,
  organizationId?: string | null,
) {
  requireLegacyProductState("transfers");
  db()
    .prepare(
      `
    UPDATE transfer_templates
    SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END,
        updated_at = :updatedAt
    WHERE id = :id
      AND (:organizationId = '' OR organization_id = :organizationId)
  `,
    )
    .run({
      id: transferId,
      organizationId: organizationFilterValue(organizationId),
      updatedAt: now(),
    });
}

function recomputeTransferSizeWithDatabase(
  database: SqlDatabase,
  transferId: string,
  options: { touchUpdatedAt?: boolean } = {},
) {
  const sourceSizeRow = database
    .prepare(
      `
    SELECT COALESCE(SUM(COALESCE(object_size_bytes, 0)), 0) AS total
    FROM transfer_sources
    WHERE transfer_template_id = :id
    `,
    )
    .get({ id: transferId }) as Row | undefined;
  const destinationCountRow = database
    .prepare(
      `
    SELECT COUNT(*) AS count
    FROM transfer_destinations
    WHERE transfer_template_id = :id
    `,
    )
    .get({ id: transferId }) as Row | undefined;
  const totalSourceSizeBytes = Number(sourceSizeRow?.total ?? 0);
  const destinationCount = Number(destinationCountRow?.count ?? 0);
  const totalTransferSizeBytes = totalSourceSizeBytes * destinationCount;

  const touchUpdatedAt = options.touchUpdatedAt ?? true;

  database
    .prepare(
      `
    UPDATE transfer_templates
    SET total_source_size_bytes = :totalSourceSizeBytes,
        total_transfer_size_bytes = :totalTransferSizeBytes,
        updated_at = CASE WHEN :touchUpdatedAt = 1 THEN :updatedAt ELSE updated_at END
    WHERE id = :id
  `,
    )
    .run({
      id: transferId,
      totalSourceSizeBytes,
      totalTransferSizeBytes,
      touchUpdatedAt: touchUpdatedAt ? 1 : 0,
      updatedAt: now(),
    });
}

function recomputeTransferSize(
  transferId: string,
  options: { touchUpdatedAt?: boolean } = {},
) {
  recomputeTransferSizeWithDatabase(db(), transferId, options);
}

export function validateEndpointFields(input: {
  name: string;
  bucket: string;
  objectKey: string;
  sourceType?: "file" | "directory";
}) {
  if (!input.name.trim()) {
    throw new StudioValidationError(
      "endpoint_name_required",
      "Endpoint name is required.",
      { field: "name" },
    );
  }

  if (!input.bucket.trim()) {
    throw new StudioValidationError(
      "endpoint_bucket_required",
      "Endpoint bucket is required.",
      { field: "bucket" },
    );
  }

  if (!input.objectKey.trim()) {
    throw new StudioValidationError(
      "endpoint_object_key_required",
      input.sourceType === "directory"
        ? "Source directory prefix is required."
        : "Endpoint object key is required.",
      { field: "objectKey" },
    );
  }
}

export function createEndpoint(
  kind: "source" | "destination",
  input: {
    organizationId?: string | null;
    transferTemplateId: string;
    name: string;
    provider: string;
    bucket: string;
    objectKey: string;
    filenamePolicy?: DestinationFilenamePolicy | string | null;
    filenameTemplate?: string | null;
    filenameTimezone?: string | null;
    sourceType?: "file" | "directory";
    region?: string | null;
    endpointUrl?: string | null;
    credentialId?: string | null;
    objectSizeBytes?: number | null;
    metadataError?: string | null;
  },
) {
  requireLegacyProductState("transfers");
  const table =
    kind === "source" ? "transfer_sources" : "transfer_destinations";
  requireTransferInOrganization(
    db(),
    input.transferTemplateId,
    input.organizationId,
  );
  validateEndpointFields(input);
  const timestamp = now();
  const endpointId = id(kind === "source" ? "src" : "dst");
  const sourceType =
    kind === "source" && input.sourceType === "directory"
      ? "directory"
      : "file";
  const baseValues = {
    id: endpointId,
    transferTemplateId: input.transferTemplateId,
    name: input.name.trim(),
    provider: input.provider,
    bucket: input.bucket.trim(),
    objectKey: input.objectKey.trim(),
    filenamePolicy:
      kind === "destination"
        ? destinationFilenamePolicy(input.filenamePolicy)
        : "overwrite",
    filenameTemplate:
      kind === "destination" ? input.filenameTemplate?.trim() || null : null,
    filenameTimezone:
      kind === "destination"
        ? destinationFilenameTimezone(input.filenameTimezone)
        : "UTC",
    region: input.region?.trim() || null,
    endpointUrl: input.endpointUrl?.trim() || null,
    credentialId: input.credentialId?.trim() || null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  if (kind === "source") {
    db()
      .prepare(
        `
      INSERT INTO ${table} (
        id, transfer_template_id, name, source_type, provider, bucket, object_key,
        region, endpoint_url, credential_id, object_size_bytes,
        metadata_checked_at, metadata_error, enabled, created_at, updated_at
      )
      VALUES (
        :id, :transferTemplateId, :name, :sourceType, :provider, :bucket, :objectKey,
        :region, :endpointUrl, :credentialId, :objectSizeBytes,
        :metadataCheckedAt, :metadataError, 1, :createdAt, :updatedAt
      )
    `,
      )
      .run({
        id: baseValues.id,
        transferTemplateId: baseValues.transferTemplateId,
        name: baseValues.name,
        sourceType,
        provider: baseValues.provider,
        bucket: baseValues.bucket,
        objectKey: baseValues.objectKey,
        region: baseValues.region,
        endpointUrl: baseValues.endpointUrl,
        credentialId: baseValues.credentialId,
        objectSizeBytes:
          input.objectSizeBytes === null || input.objectSizeBytes === undefined
            ? null
            : Math.max(0, Math.round(input.objectSizeBytes)),
        metadataCheckedAt: timestamp,
        metadataError: input.metadataError?.trim() || null,
        createdAt: baseValues.createdAt,
        updatedAt: baseValues.updatedAt,
      });
  } else {
    db()
      .prepare(
        `
      INSERT INTO ${table} (
        id, transfer_template_id, name, provider, bucket, object_key,
        filename_policy, filename_template, filename_timezone,
        region, endpoint_url, credential_id, enabled, created_at, updated_at
      )
      VALUES (
        :id, :transferTemplateId, :name, :provider, :bucket, :objectKey,
        :filenamePolicy, :filenameTemplate, :filenameTimezone,
        :region, :endpointUrl, :credentialId, 1, :createdAt, :updatedAt
      )
    `,
      )
      .run(baseValues);
  }

  recomputeTransferSize(input.transferTemplateId);
  return endpointId;
}

export function updateEndpoint(
  kind: "source" | "destination",
  input: {
    organizationId?: string | null;
    /**
     * The transfer named in the request. When given, an endpoint of any other
     * transfer is not found, even inside the caller's organization.
     */
    transferTemplateId?: string | null;
    id: string;
    name: string;
    provider: string;
    bucket: string;
    objectKey: string;
    filenamePolicy?: DestinationFilenamePolicy | string | null;
    filenameTemplate?: string | null;
    filenameTimezone?: string | null;
    sourceType?: "file" | "directory";
    region?: string | null;
    endpointUrl?: string | null;
    credentialId?: string | null;
    objectSizeBytes?: number | null;
    metadataError?: string | null;
  },
) {
  requireLegacyProductState("transfers");
  const table =
    kind === "source" ? "transfer_sources" : "transfer_destinations";
  const row = requireEndpointOwnership(
    table,
    input.id,
    input.transferTemplateId,
  );
  if (row?.transfer_template_id) {
    requireTransferInOrganization(
      db(),
      String(row.transfer_template_id),
      input.organizationId,
    );
  }
  validateEndpointFields(input);
  const sourceType =
    kind === "source" && input.sourceType === "directory"
      ? "directory"
      : "file";
  const baseValues = {
    id: input.id,
    name: input.name.trim(),
    provider: input.provider,
    bucket: input.bucket.trim(),
    objectKey: input.objectKey.trim(),
    filenamePolicy:
      kind === "destination"
        ? destinationFilenamePolicy(input.filenamePolicy)
        : "overwrite",
    filenameTemplate:
      kind === "destination" ? input.filenameTemplate?.trim() || null : null,
    filenameTimezone:
      kind === "destination"
        ? destinationFilenameTimezone(input.filenameTimezone)
        : "UTC",
    region: input.region?.trim() || null,
    endpointUrl: input.endpointUrl?.trim() || null,
    credentialId: input.credentialId?.trim() || null,
    updatedAt: now(),
  };

  if (kind === "source") {
    db()
      .prepare(
        `
      UPDATE ${table}
      SET name = :name,
          source_type = :sourceType,
          provider = :provider,
          bucket = :bucket,
          object_key = :objectKey,
          region = :region,
          endpoint_url = :endpointUrl,
          credential_id = :credentialId,
          object_size_bytes = :objectSizeBytes,
          metadata_checked_at = :metadataCheckedAt,
          metadata_error = :metadataError,
          updated_at = :updatedAt
      WHERE id = :id
    `,
      )
      .run({
        id: baseValues.id,
        name: baseValues.name,
        sourceType,
        provider: baseValues.provider,
        bucket: baseValues.bucket,
        objectKey: baseValues.objectKey,
        region: baseValues.region,
        endpointUrl: baseValues.endpointUrl,
        credentialId: baseValues.credentialId,
        objectSizeBytes:
          input.objectSizeBytes === null || input.objectSizeBytes === undefined
            ? null
            : Math.max(0, Math.round(input.objectSizeBytes)),
        metadataCheckedAt: baseValues.updatedAt,
        metadataError: input.metadataError?.trim() || null,
        updatedAt: baseValues.updatedAt,
      });
  } else {
    db()
      .prepare(
        `
      UPDATE ${table}
      SET name = :name,
          provider = :provider,
          bucket = :bucket,
          object_key = :objectKey,
          filename_policy = :filenamePolicy,
          filename_template = :filenameTemplate,
          filename_timezone = :filenameTimezone,
          region = :region,
          endpoint_url = :endpointUrl,
          credential_id = :credentialId,
          updated_at = :updatedAt
      WHERE id = :id
    `,
      )
      .run(baseValues);
  }

  if (row?.transfer_template_id) {
    recomputeTransferSize(String(row.transfer_template_id));
  }
}

export function deleteEndpoint(
  kind: "source" | "destination",
  endpointId: string,
  organizationId?: string | null,
  transferTemplateId?: string | null,
) {
  requireLegacyProductState("transfers");
  const table =
    kind === "source" ? "transfer_sources" : "transfer_destinations";
  const row = requireEndpointOwnership(table, endpointId, transferTemplateId);
  if (row?.transfer_template_id) {
    requireTransferInOrganization(
      db(),
      String(row.transfer_template_id),
      organizationId,
    );
  }
  db().prepare(`DELETE FROM ${table} WHERE id = :id`).run({ id: endpointId });

  if (row?.transfer_template_id) {
    recomputeTransferSize(String(row.transfer_template_id));
  }
}

export function listSchedules(
  filters: { organizationId?: string | null } = {},
): ScheduleRecord[] {
  if (!legacyProductStateAvailable()) return [];
  return many<Row>(
    `
    SELECT
      s.*,
      t.name AS transfer_name,
      COALESCE(run_stats.avg_run_duration_seconds, 0) AS avg_run_duration_seconds
    FROM schedules s
    LEFT JOIN transfer_templates t ON t.id = s.transfer_template_id
    LEFT JOIN (
      SELECT
        schedule_id,
        AVG(strftime('%s', completed_at) - strftime('%s', started_at)) AS avg_run_duration_seconds
      FROM runs
      WHERE started_at IS NOT NULL
        AND completed_at IS NOT NULL
      GROUP BY schedule_id
    ) run_stats ON run_stats.schedule_id = s.id
    WHERE (:organizationId = '' OR t.organization_id = :organizationId)
    ORDER BY s.enabled DESC, s.next_run_at ASC, s.updated_at DESC
    `,
    { organizationId: organizationFilterValue(filters.organizationId) },
  ).map((row) => {
    const windowDays = parseWindowDays(
      row.window_days ? String(row.window_days) : null,
    );
    const projection = projectSchedule({
      frequency: String(row.frequency),
      startAt: row.start_at ? String(row.start_at) : null,
      nextRunAt: row.next_run_at ? String(row.next_run_at) : null,
      endAt: row.end_at ? String(row.end_at) : null,
      maxRuns: nullableNumber(row.max_runs),
      completedRunCount: Number(row.run_count ?? 0),
      timezone: row.timezone ? String(row.timezone) : "UTC",
      windowStartTime: row.window_start_time
        ? String(row.window_start_time)
        : null,
      windowEndTime: row.window_end_time ? String(row.window_end_time) : null,
      windowDays,
      maxOccurrences: 10,
      horizonDays: 30,
    });

    return {
      id: String(row.id),
      transferTemplateId: String(row.transfer_template_id),
      transferName: row.transfer_name ? String(row.transfer_name) : null,
      frequency: String(row.frequency),
      enabled: bool(row.enabled),
      status: row.status
        ? String(row.status)
        : bool(row.enabled)
          ? "active"
          : "paused",
      startAt: row.start_at ? String(row.start_at) : null,
      endAt: row.end_at ? String(row.end_at) : null,
      timezone: row.timezone ? String(row.timezone) : "UTC",
      nextRunAt: row.next_run_at ? String(row.next_run_at) : null,
      maxRunDurationSeconds: nullableNumber(row.max_run_duration_seconds),
      creditBudgetLimit: nullableNumber(row.credit_budget_limit),
      creditsConsumed: Number(row.credits_consumed ?? 0),
      maxRuns: nullableNumber(row.max_runs),
      runCount: Number(row.run_count ?? 0),
      successCount: Number(row.success_count ?? 0),
      failureCount: Number(row.failure_count ?? 0),
      successRate: Number(row.run_count ?? 0)
        ? Math.round(
            (Number(row.success_count ?? 0) / Number(row.run_count)) * 100,
          )
        : 0,
      avgRunDurationSeconds: Math.round(
        Number(row.avg_run_duration_seconds ?? 0),
      ),
      lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
      lastError: row.last_error ? String(row.last_error) : null,
      windowStartTime: row.window_start_time
        ? String(row.window_start_time)
        : null,
      windowEndTime: row.window_end_time ? String(row.window_end_time) : null,
      windowDays,
      overlapPolicy: normalizeOverlapPolicy(row.overlap_policy),
      estimatedRunCount: projection.estimatedRunCount,
      estimateHorizonDays: projection.estimateHorizonDays,
      previewRunAt: projection.occurrences,
      risks: projection.risks,
      budgetAlertThreshold: Number(row.budget_alert_threshold ?? 80),
      alertState: row.alert_state ? String(row.alert_state) : null,
      createdAt: timestampText(row.created_at),
      updatedAt: timestampText(row.updated_at),
    };
  });
}

export function createSchedule(input: {
  organizationId?: string | null;
  transferTemplateId: string;
  frequency: string;
  enabled: boolean;
  nextRunAt?: string | null;
  endAt?: string | null;
  timezone?: string | null;
  maxRunDurationSeconds?: number | string | null;
  creditBudgetLimit?: number | string | null;
  maxRuns?: number | string | null;
  windowStartTime?: string | null;
  windowEndTime?: string | null;
  windowDays?: string | string[] | number[] | null;
  overlapPolicy?: string | null;
  budgetAlertThreshold?: number | string | null;
}) {
  requireLegacyProductState("schedules");
  requireTransferInOrganization(
    db(),
    input.transferTemplateId,
    input.organizationId,
  );
  const frequency = parseScheduleFrequency(input.frequency);
  if (!frequency) {
    throw new StudioValidationError(
      "schedule_frequency_invalid",
      `Invalid schedule frequency: ${input.frequency}`,
      { field: "frequency" },
    );
  }

  const timestamp = now();
  const startAt = input.nextRunAt || timestamp;
  const scheduleId = id("sch");
  const endAt = input.endAt?.trim() || null;
  if (endAt && new Date(endAt).getTime() < new Date(startAt).getTime()) {
    throw new StudioValidationError(
      "schedule_end_invalid",
      "Schedule end date must be after the first run.",
      { field: "endAt" },
    );
  }
  const windowDays = Array.isArray(input.windowDays)
    ? input.windowDays
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6)
    : parseWindowDays(input.windowDays ?? null);
  db()
    .prepare(
      `
    INSERT INTO schedules (
      id, transfer_template_id, frequency, enabled, status, start_at, end_at,
      timezone, next_run_at, max_run_duration_seconds, credit_budget_limit,
      max_runs, window_start_time, window_end_time, window_days, overlap_policy,
      budget_alert_threshold, created_at, updated_at
    )
    VALUES (
      :id, :transferTemplateId, :frequency, :enabled, :status, :startAt, :endAt,
      :timezone, :nextRunAt, :maxRunDurationSeconds, :creditBudgetLimit,
      :maxRuns, :windowStartTime, :windowEndTime, :windowDays, :overlapPolicy,
      :budgetAlertThreshold, :createdAt, :updatedAt
    )
  `,
    )
    .run({
      id: scheduleId,
      transferTemplateId: input.transferTemplateId,
      frequency: describeFrequency(frequency),
      enabled: input.enabled ? 1 : 0,
      status: input.enabled ? "active" : "paused",
      startAt,
      endAt,
      timezone: normalizeTimezone(input.timezone),
      nextRunAt: startAt,
      maxRunDurationSeconds: positiveInteger(input.maxRunDurationSeconds),
      creditBudgetLimit: positiveCredits(input.creditBudgetLimit, "down"),
      maxRuns: positiveInteger(input.maxRuns),
      windowStartTime: normalizeClockTime(input.windowStartTime),
      windowEndTime: normalizeClockTime(input.windowEndTime),
      windowDays: windowDays.length ? windowDays.join(",") : null,
      overlapPolicy: normalizeOverlapPolicy(input.overlapPolicy),
      budgetAlertThreshold: positiveInteger(input.budgetAlertThreshold) ?? 80,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  return scheduleId;
}

export function updateSchedule(input: {
  id: string;
  organizationId?: string | null;
  transferTemplateId: string;
  frequency: string;
  enabled: boolean;
  nextRunAt?: string | null;
  endAt?: string | null;
  timezone?: string | null;
  maxRunDurationSeconds?: number | string | null;
  creditBudgetLimit?: number | string | null;
  maxRuns?: number | string | null;
  windowStartTime?: string | null;
  windowEndTime?: string | null;
  windowDays?: string | string[] | number[] | null;
  overlapPolicy?: string | null;
  budgetAlertThreshold?: number | string | null;
}) {
  requireLegacyProductState("schedules");
  requireTransferInOrganization(
    db(),
    input.transferTemplateId,
    input.organizationId,
  );
  const frequency = parseScheduleFrequency(input.frequency);
  if (!frequency) {
    throw new StudioValidationError(
      "schedule_frequency_invalid",
      `Invalid schedule frequency: ${input.frequency}`,
      { field: "frequency" },
    );
  }

  const timestamp = now();
  const nextRunAt = input.nextRunAt || timestamp;
  const endAt = input.endAt?.trim() || null;
  if (endAt && new Date(endAt).getTime() < new Date(nextRunAt).getTime()) {
    throw new StudioValidationError(
      "schedule_end_invalid",
      "Schedule end date must be after the next run.",
      { field: "endAt" },
    );
  }
  const windowDays = Array.isArray(input.windowDays)
    ? input.windowDays
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6)
    : parseWindowDays(input.windowDays ?? null);

  db()
    .prepare(
      `
    UPDATE schedules
    SET transfer_template_id = :transferTemplateId,
        frequency = :frequency,
        enabled = :enabled,
        status = :status,
        start_at = :nextRunAt,
        end_at = :endAt,
        timezone = :timezone,
        next_run_at = :nextRunAt,
        max_run_duration_seconds = :maxRunDurationSeconds,
        credit_budget_limit = :creditBudgetLimit,
        max_runs = :maxRuns,
        window_start_time = :windowStartTime,
        window_end_time = :windowEndTime,
        window_days = :windowDays,
        overlap_policy = :overlapPolicy,
        budget_alert_threshold = :budgetAlertThreshold,
        updated_at = :updatedAt
    WHERE id = :id
      AND (
        :organizationId = ''
        OR EXISTS (
          SELECT 1
          FROM transfer_templates t
          WHERE t.id = schedules.transfer_template_id
            AND t.organization_id = :organizationId
        )
      )
  `,
    )
    .run({
      id: input.id,
      organizationId: organizationFilterValue(input.organizationId),
      transferTemplateId: input.transferTemplateId,
      frequency: describeFrequency(frequency),
      enabled: input.enabled ? 1 : 0,
      status: input.enabled ? "active" : "paused",
      nextRunAt,
      endAt,
      timezone: normalizeTimezone(input.timezone),
      maxRunDurationSeconds: positiveInteger(input.maxRunDurationSeconds),
      creditBudgetLimit: positiveCredits(input.creditBudgetLimit, "down"),
      maxRuns: positiveInteger(input.maxRuns),
      windowStartTime: normalizeClockTime(input.windowStartTime),
      windowEndTime: normalizeClockTime(input.windowEndTime),
      windowDays: windowDays.length ? windowDays.join(",") : null,
      overlapPolicy: normalizeOverlapPolicy(input.overlapPolicy),
      budgetAlertThreshold: positiveInteger(input.budgetAlertThreshold) ?? 80,
      updatedAt: timestamp,
    });
}

export function toggleSchedule(
  scheduleId: string,
  organizationId?: string | null,
) {
  requireLegacyProductState("schedules");
  db()
    .prepare(
      `
    UPDATE schedules
    SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END,
        status = CASE enabled WHEN 1 THEN 'paused' ELSE 'active' END,
        updated_at = :updatedAt
    WHERE id = :id
      AND (
        :organizationId = ''
        OR EXISTS (
          SELECT 1
          FROM transfer_templates t
          WHERE t.id = schedules.transfer_template_id
            AND t.organization_id = :organizationId
        )
      )
  `,
    )
    .run({
      id: scheduleId,
      organizationId: organizationFilterValue(organizationId),
      updatedAt: now(),
    });
}

export function deleteSchedule(
  scheduleId: string,
  organizationId?: string | null,
) {
  requireLegacyProductState("schedules");
  db()
    .prepare(
      `
    DELETE FROM schedules
    WHERE id = :id
      AND (
        :organizationId = ''
        OR EXISTS (
          SELECT 1
          FROM transfer_templates t
          WHERE t.id = schedules.transfer_template_id
            AND t.organization_id = :organizationId
        )
      )
  `,
    )
    .run({
      id: scheduleId,
      organizationId: organizationFilterValue(organizationId),
    });
}

export function listRuns(
  filters: {
    transferId?: string;
    scheduleId?: string;
    status?: string;
    organizationId?: string | null;
  } = {},
): RunRecord[] {
  if (!legacyProductStateAvailable()) return [];
  return many<Row>(
    `
    SELECT r.*, t.name AS transfer_name
    FROM runs r
    LEFT JOIN transfer_templates t ON t.id = r.transfer_template_id
    WHERE (:transferId = '' OR r.transfer_template_id = :transferId)
      AND (:scheduleId = '' OR r.schedule_id = :scheduleId)
      AND (:status = 'all' OR r.status = :status)
      AND (:organizationId = '' OR t.organization_id = :organizationId)
    ORDER BY r.created_at DESC
    LIMIT 120
    `,
    {
      transferId: filters.transferId ?? "",
      scheduleId: filters.scheduleId ?? "",
      status: filters.status ?? "all",
      organizationId: organizationFilterValue(filters.organizationId),
    },
  ).map((row) => ({
    id: String(row.id),
    transferTemplateId: String(row.transfer_template_id),
    transferName: row.transfer_name ? String(row.transfer_name) : null,
    status: runStatus(row.status),
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    error: row.error ? String(row.error) : null,
    createdAt: String(row.created_at),
    updatedAt: row.updated_at ? String(row.updated_at) : null,
    queuedAt: row.queued_at ? String(row.queued_at) : null,
    nextAttemptAt: row.next_attempt_at ? String(row.next_attempt_at) : null,
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    lockedBy: row.locked_by ? String(row.locked_by) : null,
    beamTransferId: row.beam_transfer_id ? String(row.beam_transfer_id) : null,
    trigger: String(row.trigger ?? "manual"),
    maxDurationSeconds: nullableNumber(row.max_duration_seconds),
    creditCost: Number(row.credit_cost ?? 0),
    cancelReason: row.cancel_reason ? String(row.cancel_reason) : null,
    timedOutAt: row.timed_out_at ? String(row.timed_out_at) : null,
  }));
}

export function listQueueRuns(
  filters: { organizationId?: string | null } = {},
): RunRecord[] {
  if (!legacyProductStateAvailable()) return [];
  return many<Row>(
    `
    SELECT r.*, t.name AS transfer_name
    FROM runs r
    LEFT JOIN transfer_templates t ON t.id = r.transfer_template_id
    WHERE r.status IN ('queued', 'running', 'cancel_requested')
      AND (:organizationId = '' OR t.organization_id = :organizationId)
    ORDER BY
      CASE r.status
        WHEN 'running' THEN 0
        WHEN 'cancel_requested' THEN 1
        ELSE 2
      END,
      COALESCE(r.next_attempt_at, r.created_at) ASC
    LIMIT 160
    `,
    { organizationId: organizationFilterValue(filters.organizationId) },
  ).map(
    (row) =>
      ({
        id: String(row.id),
        transferTemplateId: String(row.transfer_template_id),
        transferName: row.transfer_name ? String(row.transfer_name) : null,
        status: runStatus(row.status),
        startedAt: row.started_at ? String(row.started_at) : null,
        completedAt: row.completed_at ? String(row.completed_at) : null,
        error: row.error ? String(row.error) : null,
        createdAt: String(row.created_at),
        updatedAt: row.updated_at ? String(row.updated_at) : null,
        queuedAt: row.queued_at ? String(row.queued_at) : null,
        nextAttemptAt: row.next_attempt_at ? String(row.next_attempt_at) : null,
        attempts: Number(row.attempts ?? 0),
        maxAttempts: Number(row.max_attempts ?? 3),
        lockedBy: row.locked_by ? String(row.locked_by) : null,
        beamTransferId: row.beam_transfer_id
          ? String(row.beam_transfer_id)
          : null,
        trigger: String(row.trigger ?? "manual"),
        maxDurationSeconds: nullableNumber(row.max_duration_seconds),
        creditCost: Number(row.credit_cost ?? 0),
        cancelReason: row.cancel_reason ? String(row.cancel_reason) : null,
        timedOutAt: row.timed_out_at ? String(row.timed_out_at) : null,
      }) satisfies RunRecord,
  );
}

export function listWorkerInstances(): WorkerInstanceRecord[] {
  if (!legacyProductStateAvailable()) return [];
  markStaleWorkerInstances();
  return many<Row>(
    `
    SELECT *
    FROM worker_instances
    ORDER BY
      CASE status
        WHEN 'active' THEN 0
        WHEN 'draining' THEN 1
        WHEN 'stale' THEN 2
        ELSE 3
      END,
      heartbeat_at DESC
    `,
  ).map((row) => ({
    id: String(row.id),
    hostname: String(row.hostname),
    pid: Number(row.pid),
    status: String(row.status),
    source: "legacy",
    startedAt: String(row.started_at),
    heartbeatAt: String(row.heartbeat_at),
    stoppedAt: row.stopped_at ? String(row.stopped_at) : null,
    metadata: parsePayload(row.metadata),
  }));
}

export async function listWorkerRuntimeState(
  pool: PgPool,
): Promise<WorkerInstanceRecord[]> {
  const staleBefore = new Date(
    Date.now() - workerStaleWorkerTtlMs(),
  ).toISOString();
  const rows = await pgMany<Row>(
    pool,
    `
    SELECT
      w.*,
      COALESCE(
        jsonb_agg(c.capability ORDER BY c.capability)
          FILTER (WHERE c.capability IS NOT NULL),
        '[]'::jsonb
      ) AS capabilities_json
    FROM runtime.worker_runtime_state w
    LEFT JOIN runtime.worker_capabilities c ON c.worker_id = w.worker_id
    GROUP BY w.worker_id
    ORDER BY
      CASE
        WHEN w.status = 'active' AND w.heartbeat_at >= $1 THEN 0
        WHEN w.status = 'draining' AND w.heartbeat_at >= $1 THEN 1
        WHEN w.heartbeat_at < $1 THEN 2
        ELSE 3
      END,
      w.heartbeat_at DESC
    `,
    [staleBefore],
  );

  return rows.map((row) => {
    const heartbeatAt = timestampText(row.heartbeat_at);
    const isStale =
      Date.parse(heartbeatAt) < Date.parse(staleBefore) &&
      ["active", "draining"].includes(String(row.status));
    const metadata = parsePayload(row.metadata_json);
    delete metadata.config;
    const capabilities = jsonStringArray(row.capabilities_json);
    const accessibleEndpoints = jsonStringArray(row.accessible_endpoints_json);
    const networkIdentity = String(row.network_identity ?? "");
    const workerId = String(row.worker_id);

    return {
      id: workerId,
      hostname: networkIdentity || String(metadata.networkIdentity ?? ""),
      status: isStale ? "stale" : String(row.status),
      source: "runtime",
      startedAt: null,
      heartbeatAt,
      stoppedAt: null,
      networkIdentity,
      reachability: String(row.reachability ?? "local"),
      accessibleEndpoints,
      capabilities,
      cpuLoad: Number(row.cpu_load ?? 0),
      memoryUsedBytes: Number(row.memory_used_bytes ?? 0),
      memoryTotalBytes: Number(row.memory_total_bytes ?? 0),
      bandwidthMbps: Number(row.bandwidth_mbps ?? 0),
      activeTaskCount: Number(row.active_task_count ?? 0),
      loadScore: Number(row.load_score ?? 0),
      updatedAt: timestampText(row.updated_at),
      metadata,
    };
  });
}

function markStaleWorkerInstances() {
  const staleBefore = new Date(
    Date.now() - workerStaleWorkerTtlMs(),
  ).toISOString();
  db()
    .prepare(
      `
    UPDATE worker_instances
    SET status = 'stale'
    WHERE status IN ('active', 'draining')
      AND heartbeat_at < :staleBefore
  `,
    )
    .run({ staleBefore });
}

export function listDeadLetterRuns(
  filters: { organizationId?: string | null } = {},
): DeadLetterRunRecord[] {
  if (!legacyProductStateAvailable()) return [];
  return many<Row>(
    `
    SELECT d.*, t.name AS transfer_name
    FROM dead_letter_runs d
    LEFT JOIN transfer_templates t ON t.id = d.transfer_template_id
    WHERE (:organizationId = '' OR t.organization_id = :organizationId)
    ORDER BY d.created_at DESC
    LIMIT 160
    `,
    { organizationId: organizationFilterValue(filters.organizationId) },
  ).map((row) => ({
    id: String(row.id),
    runId: String(row.run_id),
    transferTemplateId: String(row.transfer_template_id),
    transferName: row.transfer_name ? String(row.transfer_name) : null,
    reason: String(row.reason),
    error: String(row.error),
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 0),
    beamTransferId: row.beam_transfer_id ? String(row.beam_transfer_id) : null,
    retryRunId: row.retry_run_id ? String(row.retry_run_id) : null,
    resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
    createdAt: String(row.created_at),
  }));
}

export function getRun(
  idValue: string,
  organizationId?: string | null,
  projectId?: string | null,
) {
  if (!legacyProductStateAvailable()) return null;
  const run = one<Row>(
    `
    SELECT r.*, t.name AS transfer_name
    FROM runs r
    LEFT JOIN transfer_templates t ON t.id = r.transfer_template_id
    WHERE r.id = :id
      AND (:organizationId = '' OR t.organization_id = :organizationId)
      AND (:projectId = '' OR t.project_id = :projectId)
    `,
    {
      id: idValue,
      organizationId: organizationFilterValue(organizationId),
      projectId: organizationFilterValue(projectId),
    },
  );
  if (!run) {
    return null;
  }

  const transfers = many<Row>(
    "SELECT * FROM run_transfers WHERE run_id = :id ORDER BY created_at",
    { id: idValue },
  ).map((row) => ({
    id: String(row.id),
    runId: String(row.run_id),
    sourceName: row.source_name ? String(row.source_name) : null,
    destinationName: row.destination_name ? String(row.destination_name) : null,
    destinationObjectKey: row.destination_object_key
      ? String(row.destination_object_key)
      : null,
    status: String(row.status),
    beamTransferId: row.beam_transfer_id ? String(row.beam_transfer_id) : null,
    error: row.error ? String(row.error) : null,
    createdAt: String(row.created_at),
  }));
  const logs = listExecutionLogs({ runId: idValue, organizationId });

  return {
    run: {
      id: String(run.id),
      transferTemplateId: String(run.transfer_template_id),
      transferName: run.transfer_name ? String(run.transfer_name) : null,
      status: runStatus(run.status),
      startedAt: run.started_at ? String(run.started_at) : null,
      completedAt: run.completed_at ? String(run.completed_at) : null,
      error: run.error ? String(run.error) : null,
      createdAt: String(run.created_at),
      updatedAt: run.updated_at ? String(run.updated_at) : null,
      queuedAt: run.queued_at ? String(run.queued_at) : null,
      nextAttemptAt: run.next_attempt_at ? String(run.next_attempt_at) : null,
      attempts: Number(run.attempts ?? 0),
      maxAttempts: Number(run.max_attempts ?? 3),
      lockedBy: run.locked_by ? String(run.locked_by) : null,
      beamTransferId: run.beam_transfer_id
        ? String(run.beam_transfer_id)
        : null,
      trigger: String(run.trigger ?? "manual"),
      maxDurationSeconds: nullableNumber(run.max_duration_seconds),
      creditCost: Number(run.credit_cost ?? 0),
      cancelReason: run.cancel_reason ? String(run.cancel_reason) : null,
      timedOutAt: run.timed_out_at ? String(run.timed_out_at) : null,
    } satisfies RunRecord,
    transfers,
    logs,
  };
}

export function startRun(
  transferId: string,
  organizationId?: string | null,
  options: {
    /**
     * Credit reservation this run is charged against. Settled once the run
     * reaches a terminal state, so the hold is released if the run never ran.
     */
    creditOperationKey?: string | null;
  } = {},
) {
  requireLegacyProductState("runs");
  const bundle = getTransfer(transferId, organizationId);
  if (!bundle) {
    throw new StudioNotFoundError(
      "transfer_not_found",
      "Transfer template not found.",
    );
  }

  const timestamp = now();
  const runId = id("run");
  const database = db();

  database.exec("BEGIN");
  try {
    database
      .prepare(
        `
      INSERT INTO runs (
        id, transfer_template_id, status, started_at, completed_at, error,
        created_at, updated_at, queued_at, next_attempt_at, attempts, max_attempts,
        trigger, idempotency_key, credit_operation_key
      )
      VALUES (
        :id, :transferTemplateId, 'queued', NULL, NULL, NULL,
        :createdAt, :updatedAt, :queuedAt, :nextAttemptAt, 0, :maxAttempts,
        'manual', :idempotencyKey, :creditOperationKey
      )
    `,
      )
      .run({
        id: runId,
        transferTemplateId: transferId,
        createdAt: timestamp,
        updatedAt: timestamp,
        queuedAt: timestamp,
        nextAttemptAt: timestamp,
        maxAttempts: maxRunAttempts(),
        idempotencyKey: `run:${runId}`,
        creditOperationKey: options.creditOperationKey ?? null,
      });

    appendExecutionLog(
      runId,
      "run_queued",
      {
        trigger: "manual",
        transferTemplateId: transferId,
        transferName: bundle.transfer.name,
        sourceCount: bundle.sources.length,
        destinationCount: bundle.destinations.length,
      },
      database,
    );

    database.exec("COMMIT");
    return runId;
  } catch (errorObject) {
    database.exec("ROLLBACK");
    throw errorObject;
  }
}

export function cancelRun(runId: string, organizationId?: string | null) {
  requireLegacyProductState("runs");
  const timestamp = now();
  const database = db();
  const row = database
    .prepare(
      `
    SELECT r.status
    FROM runs r
    LEFT JOIN transfer_templates t ON t.id = r.transfer_template_id
    WHERE r.id = :id
      AND (:organizationId = '' OR t.organization_id = :organizationId)
  `,
    )
    .get({
      id: runId,
      organizationId: organizationFilterValue(organizationId),
    }) as Row | undefined;
  if (!row) {
    return;
  }

  if (["queued", "running"].includes(String(row.status))) {
    database
      .prepare(
        `
      UPDATE runs
      SET status = 'cancelled',
          completed_at = COALESCE(completed_at, :completedAt),
          updated_at = :updatedAt,
          error = COALESCE(error, 'cancellation requested')
      WHERE id = :id AND status IN ('queued', 'running')
    `,
      )
      .run({ id: runId, completedAt: timestamp, updatedAt: timestamp });
    appendExecutionLog(runId, "run_cancelled", {
      runId,
      reason: "cancelled_by_user",
    });
  }
}

/** Refuses (409) a manual retry of a transfer run that has not ended badly. */
export function assertRunRetryable(status: string) {
  if (
    !["failed", "cancelled", "cancelled_timeout", "dead_letter"].includes(
      status,
    )
  ) {
    throw new StudioConflictError(
      "run_not_retryable",
      "Only failed, cancelled or dead-letter runs can be retried manually.",
      { status },
    );
  }
}

export function retryRun(
  runId: string,
  organizationId?: string | null,
  options: {
    /** Credit reservation for the retry. A retry is new work and is charged. */
    creditOperationKey?: string | null;
  } = {},
) {
  requireLegacyProductState("runs");
  const row = one<Row>(
    `
    SELECT r.*
    FROM runs r
    LEFT JOIN transfer_templates t ON t.id = r.transfer_template_id
    WHERE r.id = :id
      AND (:organizationId = '' OR t.organization_id = :organizationId)
    `,
    { id: runId, organizationId: organizationFilterValue(organizationId) },
  );
  if (!row) {
    throw new StudioNotFoundError("run_not_found", "Run not found.");
  }

  assertRunRetryable(String(row.status));

  const timestamp = now();
  const nextRunId = id("run");
  const transferTemplateId = String(row.transfer_template_id);
  const database = db();

  database.exec("BEGIN");
  try {
    database
      .prepare(
        `
      INSERT INTO runs (
        id, transfer_template_id, status, started_at, completed_at, error,
        created_at, updated_at, queued_at, next_attempt_at, attempts, max_attempts,
        trigger, idempotency_key, credit_operation_key
      )
      VALUES (
        :id, :transferTemplateId, 'queued', NULL, NULL, NULL,
        :createdAt, :updatedAt, :queuedAt, :nextAttemptAt, 0, :maxAttempts,
        'manual_retry', :idempotencyKey, :creditOperationKey
      )
    `,
      )
      .run({
        id: nextRunId,
        transferTemplateId,
        createdAt: timestamp,
        updatedAt: timestamp,
        queuedAt: timestamp,
        nextAttemptAt: timestamp,
        maxAttempts: Math.max(
          Number(row.max_attempts ?? maxRunAttempts()),
          maxRunAttempts(),
        ),
        idempotencyKey: `run:${nextRunId}`,
        creditOperationKey: options.creditOperationKey ?? null,
      });

    appendExecutionLog(
      runId,
      "run_retry_requested",
      {
        retryRunId: nextRunId,
        transferTemplateId,
        previousStatus: status,
      },
      database,
    );
    appendExecutionLog(
      nextRunId,
      "run_queued",
      {
        trigger: "manual_retry",
        transferTemplateId,
        retriedFromRunId: runId,
      },
      database,
    );
    database
      .prepare(
        `
      UPDATE dead_letter_runs
      SET retry_run_id = :retryRunId,
          resolved_at = :resolvedAt
      WHERE run_id = :runId
    `,
      )
      .run({
        runId,
        retryRunId: nextRunId,
        resolvedAt: timestamp,
      });
    database.exec("COMMIT");
    return nextRunId;
  } catch (errorObject) {
    database.exec("ROLLBACK");
    throw errorObject;
  }
}

/**
 * Installed actions an organization can use: every instance-wide package
 * (builtins, public and unlisted Registry packages) plus the private Registry
 * packages that organization installed. Without an organization, only the
 * instance-wide packages are returned.
 */
export async function listActionPackages(
  filters: { source?: string; organizationId?: string | null } = {},
) {
  const pool = pg();
  return pgMany<Row>(
    pool,
    `
    SELECT
      pv.id,
      p.package_name AS name,
      pv.version,
      p.metadata_json->>'source' AS source,
      pv.manifest_json,
      pv.manifest_checksum AS checksum,
      pv.created_at,
      pv.updated_at
    FROM actions.packages p
    JOIN actions.package_versions pv ON pv.package_id = p.id
    WHERE ($1 = '' OR COALESCE(p.metadata_json->>'source', 'builtin') = $1)
      AND (p.organization_id IS NULL OR p.organization_id = $2)
    ORDER BY p.package_name ASC, pv.version DESC
    `,
    [filters.source ?? "", organizationFilterValue(filters.organizationId)],
  ).then((rows) =>
    rows.map(
      (row): ActionPackageRecord => ({
        id: String(row.id),
        name: String(row.name),
        version: String(row.version),
        source: String(row.source ?? "builtin"),
        manifest: parsePayload(row.manifest_json),
        checksum: String(row.checksum),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      }),
    ),
  );
}

export async function listRegistryPackages(organizationId?: string | null) {
  const pool = pg();
  const organization = organizationFilterValue(organizationId);
  const [categories, packages] = await Promise.all([
    pgMany<Row>(
      pool,
      `
      SELECT
        c.*,
        COUNT(p.id) AS package_count
      FROM actions.categories c
      LEFT JOIN actions.packages p ON p.category_id = c.id
        AND (p.organization_id IS NULL OR p.organization_id = $1)
      GROUP BY c.id
      ORDER BY c.sort_order ASC, c.name ASC
      `,
      [organization],
    ),
    pgMany<Row>(
      pool,
      `
      SELECT
        p.*,
        s.name AS scope_name,
        c.name AS category_name,
        c.slug AS category_slug,
        latest.version AS latest_version_resolved,
        latest.validation_status AS latest_validation_status,
        latest.status AS latest_version_status,
        latest.manifest_checksum AS latest_manifest_checksum,
        latest.artifact_checksum AS latest_artifact_checksum,
        latest.artifact_size_bytes AS latest_artifact_size_bytes,
        latest.hippius_bucket AS latest_hippius_bucket,
        latest.hippius_key AS latest_hippius_key,
        latest.provenance_json AS latest_provenance_json,
        latest.manifest_json AS latest_manifest_json,
        (
          SELECT COUNT(*)
          FROM actions.package_versions pv
          WHERE pv.package_id = p.id
        ) AS version_count,
        (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'version', pv.version,
            'manifest', pv.manifest_json,
            'manifestChecksum', pv.manifest_checksum,
            'artifactChecksum', pv.artifact_checksum,
            'artifactSizeBytes', pv.artifact_size_bytes,
            'hippiusBucket', pv.hippius_bucket,
            'hippiusKey', pv.hippius_key,
            'provenance', pv.provenance_json,
            'validationStatus', pv.validation_status,
            'status', pv.status,
            'publishedAt', pv.published_at
          ) ORDER BY pv.published_at DESC, pv.version DESC), '[]'::jsonb)
          FROM actions.package_versions pv
          WHERE pv.package_id = p.id
        ) AS versions_json
      FROM actions.packages p
      JOIN actions.scopes s ON s.id = p.scope_id
      LEFT JOIN actions.categories c ON c.id = p.category_id
      LEFT JOIN actions.dist_tags latest_tag
        ON latest_tag.package_id = p.id
       AND latest_tag.tag = 'latest'
      LEFT JOIN actions.package_versions latest
        ON latest.id = latest_tag.version_id
       AND latest.package_id = p.id
      WHERE p.organization_id IS NULL OR p.organization_id = $1
      ORDER BY p.package_name ASC
      `,
      [organization],
    ),
  ]);

  return {
    categories: categories.map(registryCategoryRecord),
    packages: packages.map(registryPackageRecord),
  };
}

export async function listPublicRegistryPackages(
  organizationId?: string | null,
) {
  return (await registryClient(organizationId)).list();
}

export async function installPublicRegistryPackage(input: {
  packageName: string;
  range?: string;
  /** The installing organization; required to install a private package. */
  organizationId?: string | null;
}) {
  const packageName = input.packageName.trim();
  if (!/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(packageName)) {
    throw new StudioValidationError(
      "action_package_name_invalid",
      "Action package name must use @scope/name.",
      { field: "packageName" },
    );
  }
  const range = input.range?.trim() || "latest";
  const organizationId = input.organizationId?.trim() || null;
  const resolved = await (
    await registryClient(organizationId)
  ).resolve(packageName, range);
  assertRegistryVersionInstallable(resolved);
  // A private package stays visible only to the organization that could read
  // it from the Registry; everything else is instance-wide as before.
  const ownerOrganizationId =
    resolved.packageVisibility === "private" ? organizationId : null;
  if (resolved.packageVisibility === "private" && !ownerOrganizationId) {
    throw new RegistryClientError(
      "registry_private_package_requires_organization",
      `${packageName} is private and can only be installed for an organization.`,
      {
        statusCode: 409,
        action: "Install the package from a signed-in organization workspace.",
      },
    );
  }
  const manifest = resolved.version.manifest;
  validateActionManifest(manifest);
  const version = resolved.version;
  const artifactChecksum = normalizeSha256Checksum(version.artifactChecksum)!;
  const computedManifestChecksum = checksumManifest(manifest);
  const manifestChecksum = normalizeManifestChecksum(version.manifestChecksum);
  if (manifestChecksum !== computedManifestChecksum) {
    throw new RegistryClientError(
      "registry_manifest_checksum_mismatch",
      `Manifest checksum verification failed for ${packageName}@${resolved.resolvedVersion}.`,
      {
        statusCode: 409,
        action:
          "Do not install this version; ask the Registry operator to verify its manifest.",
        details: {
          expectedChecksum: manifestChecksum,
          computedChecksum: computedManifestChecksum,
        },
      },
    );
  }
  const registryUrl = normalizedRegistryUrl();
  const generatedArtifactUrl = registryClientUrl(
    registryUrl,
    `v1/packages/${registryPackagePath(packageName)}/versions/${encodeURIComponent(
      manifest.version,
    )}/artifact`,
  ).toString();
  const artifactUrl =
    httpUrlOrNull(version.artifactReference) ?? generatedArtifactUrl;
  const artifactReference = version.artifactReference ?? artifactUrl;
  const timestamp = now();

  await withPostgresTransaction(pg(), async (client) => {
    await assertPackageOwnerAvailablePg(client, {
      packageName,
      ownerOrganizationId,
    });
    await assertPublicVersionIdentityAvailablePg(client, {
      packageName,
      version: manifest.version,
      manifestChecksum,
      artifactChecksum,
    });
    await persistPublicActionVersionPg(client, {
      ownerOrganizationId,
      visibility: resolved.packageVisibility,
      manifest,
      manifestChecksum,
      artifactChecksum,
      artifactSizeBytes: version.artifactSizeBytes,
      hippiusBucket: version.hippiusBucket,
      hippiusKey: version.hippiusKey,
      hippiusEndpoint: version.hippiusEndpoint,
      mediaType: version.mediaType,
      signature: version.signature,
      provenance: {
        ...version.provenance,
        source: "public-registry",
        sourceRegistryUrl: registryUrl,
        registryArtifactUrl: artifactUrl,
        artifactReference,
        registryVisibility: resolved.packageVisibility,
        registryTrustLevel: version.trustLevel,
        advisories: version.advisories,
        vulnerable: version.vulnerable,
        installedAt: timestamp,
      },
      validationStatus: version.validationStatus,
      status: version.status,
      publishedBy: version.publishedBy ?? "registry",
      publishedAt: version.publishedAt ?? timestamp,
      timestamp,
    });
  });

  return {
    packageName,
    requestedRange: range,
    resolvedVersion: resolved.resolvedVersion,
    manifestChecksum,
    artifactChecksum,
    artifactUrl,
    artifactReference,
    sourceRegistry: version.sourceRegistry,
    trustLevel: version.trustLevel,
    status: version.status,
    advisories: version.advisories,
  };
}

export async function listExecutionLocations(
  filters: { organizationId?: string | null } = {},
) {
  return pgMany<Row>(
    pg(),
    `
    SELECT *
    FROM runtime.execution_locations
    WHERE ($1 = '' OR organization_id = $1)
    ORDER BY enabled DESC, name ASC
    `,
    [organizationFilterValue(filters.organizationId)],
  ).then((rows) => rows.map(executionLocationRecord));
}

export async function createExecutionLocation(input: {
  organizationId?: string | null;
  name: string;
  kind: string;
  endpointUrl?: string | null;
  headersJson?: string | null;
  enabled?: boolean;
  allowInsecureHttp?: boolean;
}) {
  const timestamp = now();
  const locationId = id("xel");
  await withPostgresTransaction(pg(), async (client) => {
    const organizationId = await ensureOrganizationPg(
      client,
      input.organizationId,
    );
    await client.query(
      `
      INSERT INTO runtime.execution_locations (
        id, organization_id, name, kind, endpoint_url, encrypted_headers,
        enabled, allow_insecure_http, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $9
      )
      `,
      [
        locationId,
        organizationId,
        input.name.trim(),
        input.kind.trim() || "custom-worker",
        input.endpointUrl?.trim() || null,
        input.headersJson?.trim() || null,
        input.enabled === false ? false : true,
        Boolean(input.allowInsecureHttp),
        timestamp,
      ],
    );
  });
  return locationId;
}

export async function listWorkflowTemplates(
  filters: {
    organizationId?: string | null;
    projectId?: string | null;
  } = {},
) {
  return pgMany<Row>(
    pg(),
    `
    SELECT
      w.*,
      NULL AS legacy_transfer_name,
      (SELECT COUNT(*) FROM workflow.steps s WHERE s.workflow_template_id = w.id AND s.retired_at IS NULL) AS step_count,
      (SELECT COUNT(*) FROM execution.workflow_runs r WHERE r.workflow_template_id = w.id) AS run_count,
      (
        SELECT status
        FROM execution.workflow_runs r
        WHERE r.workflow_template_id = w.id
        ORDER BY r.created_at DESC
        LIMIT 1
      ) AS last_run_status,
      EXISTS (
        SELECT 1
        FROM workflow.triggers t
        WHERE t.workflow_template_id = w.id
          AND t.type = 'schedule'
          AND t.enabled = true
      ) AS scheduled,
      (
        SELECT MIN(NULLIF(t.config_json->>'nextRunAt', '')::timestamptz)
        FROM workflow.triggers t
        WHERE t.workflow_template_id = w.id
          AND t.type = 'schedule'
          AND t.enabled = true
      ) AS next_run_at
    FROM workflow.templates w
    WHERE ($1 = '' OR w.organization_id = $1)
      AND ($2 = '' OR w.project_id = $2)
    ORDER BY w.updated_at DESC
    LIMIT 160
    `,
    [
      organizationFilterValue(filters.organizationId),
      organizationFilterValue(filters.projectId),
    ],
  ).then((rows) => rows.map(workflowTemplateRecord));
}

export async function createWorkflowTemplate(
  input: CreateWorkflowTemplateInput,
) {
  const name = input.name.trim();
  if (!name) {
    throw new StudioValidationError(
      "workflow_name_required",
      "Workflow name is required.",
      { field: "name" },
    );
  }

  const timestamp = now();
  const workflowTemplateId = input.id
    ? textId(input.id, "workflow template id")
    : id("wft");

  await withPostgresTransaction(pg(), async (client) => {
    const organizationId = await ensureOrganizationPg(
      client,
      input.organizationId,
    );
    const projectId = await ensureProjectScopePg(
      client,
      organizationId,
      input.projectId,
    );
    const apiKeyId =
      input.apiKeyId?.trim() ||
      (await defaultBillingApiKeyId(organizationId, projectId, client));
    await persistBuiltinActionPackagesPg(client, timestamp);
    await client.query(
      `
        INSERT INTO workflow.templates (
          id, organization_id, project_id, name, description, api_key_id,
          config_json, retry_policy_json, timeout_seconds, enabled, created_at, updated_at, room_context_json
        )
        VALUES (
          $1, $2, $3, $4, $5, $7,
          '{}'::jsonb, '{}'::jsonb, NULL, true, $6, $6, $8::jsonb
        )
      `,
      [
        workflowTemplateId,
        organizationId,
        projectId,
        name,
        input.description?.trim() || null,
        timestamp,
        apiKeyId,
        roomContextJson(input.room),
      ],
    );
    await insertDefaultWorkflowTriggerPg(client, {
      workflowTemplateId,
      timestamp,
    });
    await captureWorkflowTreePg(client, {
      organizationId,
      workflowTemplateId,
      validateOnly: true,
    });
  });

  return workflowTemplateId;
}

export async function duplicateWorkflowTemplate(input: {
  id: string;
  name?: string | null;
  organizationId?: string | null;
  projectId?: string | null;
}) {
  const source = await getWorkflowTemplate(
    input.id,
    input.organizationId,
    input.projectId,
  );
  if (!source) {
    throw new StudioNotFoundError(
      "workflow_not_found",
      "Workflow template not found.",
    );
  }

  // The copy belongs to the same organization as the original, exactly as it
  // already inherits the original's project. A caller with no organization
  // scope reads the source through the "" wildcard filter, so taking the
  // request's organization here would drop the copy into the local fallback
  // organization, where none of the duplicated steps' credentials resolve.
  const organizationId = source.template.organizationId;

  const duplicatedWorkflowId = await createWorkflowTemplate({
    organizationId,
    projectId: source.template.projectId,
    name: input.name?.trim() || `${source.template.name} copy`,
    description: source.template.description,
    // Runs are charged to a key, and a copy with no key cannot run at all.
    apiKeyId: source.template.apiKeyId,
  });
  const stepIdMap = new Map(source.steps.map((step) => [step.id, id("wfs")]));
  const triggerIdMap = new Map(
    source.triggers.map((trigger) => [trigger.id, id("wftg")]),
  );

  try {
    await updateWorkflowGraph({
      workflowTemplateId: duplicatedWorkflowId,
      organizationId,
      graphVersion: source.template.graphVersion,
      controls: source.controls.map((control) => ({
        ...control,
        ...(source.template.graphVersion === WORKFLOW_GRAPH_V3 &&
        control.kind === "loop"
          ? {
              initial: {
                routes: (
                  control as WorkflowGraphV3LoopControl
                ).initial.routes.map((route) => ({
                  ...route,
                  from: {
                    ...route.from,
                    stepId:
                      stepIdMap.get(route.from.stepId) ?? route.from.stepId,
                  },
                  to: {
                    ...route.to,
                    stepId: stepIdMap.get(route.to.stepId) ?? route.to.stepId,
                  },
                })),
              },
              carry: {
                routes: (
                  control as WorkflowGraphV3LoopControl
                ).carry.routes.map((route) => ({
                  ...route,
                  from: {
                    ...route.from,
                    stepId:
                      stepIdMap.get(route.from.stepId) ?? route.from.stepId,
                  },
                  to: {
                    ...route.to,
                    stepId: stepIdMap.get(route.to.stepId) ?? route.to.stepId,
                  },
                })),
              },
            }
          : {}),
        ...(control.kind === "loop"
          ? {
              iterations: remapWorkflowStepReferences(
                control.iterations,
                stepIdMap,
              ),
            }
          : { items: remapWorkflowStepReferences(control.items, stepIdMap) }),
        body: {
          ...control.body,
          stepIds: control.body.stepIds.map(
            (stepId) => stepIdMap.get(stepId) ?? stepId,
          ),
          entryStepId:
            stepIdMap.get(control.body.entryStepId) ?? control.body.entryStepId,
          outputStepId:
            stepIdMap.get(control.body.outputStepId) ??
            control.body.outputStepId,
          edges: control.body.edges.map((edge) => ({
            ...edge,
            from: stepIdMap.get(edge.from) ?? edge.from,
            to: stepIdMap.get(edge.to) ?? edge.to,
          })),
        },
      })),
      ...(source.template.graphVersion === WORKFLOW_GRAPH_V3
        ? {
            distribution: remapWorkflowGraphDistribution(
              source.template.graph.distribution as WorkflowGraphV3Distribution,
              stepIdMap,
            ),
          }
        : {}),
      failurePolicy: source.template.failurePolicy,
      room: source.template.room,
      inputSchema: source.template.inputSchema,
      output: {
        ...source.template.output,
        bindings: remapWorkflowStepReferences(
          source.template.output.bindings,
          stepIdMap,
        ),
      },
      agentBindings: source.template.agentBindings,
      resourceBindings: source.template.resourceBindings,
      steps: source.steps.map((step) => ({
        ...step,
        id: stepIdMap.get(step.id)!,
        config: remapWorkflowStepReferences(step.config, stepIdMap),
        inputBindings: remapWorkflowStepReferences(
          step.inputBindings,
          stepIdMap,
        ),
      })),
      edges: source.edges.flatMap((edge) => {
        const fromStepId =
          stepIdMap.get(edge.fromStepId) ??
          (source.template.graphVersion === "workflow-graph/v1"
            ? undefined
            : edge.fromStepId);
        const toStepId =
          stepIdMap.get(edge.toStepId) ??
          (source.template.graphVersion === "workflow-graph/v1"
            ? undefined
            : edge.toStepId);
        return fromStepId && toStepId
          ? [
              {
                ...edge,
                id: id("wfe"),
                fromStepId,
                toStepId,
                condition: remapWorkflowStepReferences(
                  edge.condition,
                  stepIdMap,
                ),
              },
            ]
          : [];
      }),
      triggers: source.triggers.map((trigger) => ({
        ...trigger,
        id: triggerIdMap.get(trigger.id)!,
        workflowTemplateId: duplicatedWorkflowId,
        config: remapWorkflowStepReferences(trigger.config, stepIdMap),
        state: {},
      })),
      triggerEdges: source.triggerEdges.flatMap((edge) => {
        const triggerId = triggerIdMap.get(edge.triggerId);
        const toStepId = stepIdMap.get(edge.toStepId);
        return triggerId && toStepId
          ? [
              {
                ...edge,
                id: id("wfte"),
                triggerId,
                toStepId,
                condition: remapWorkflowStepReferences(
                  edge.condition,
                  stepIdMap,
                ),
              },
            ]
          : [];
      }),
    });
    if (!source.template.enabled) {
      await updateWorkflowTemplate({
        id: duplicatedWorkflowId,
        organizationId,
        enabled: false,
      });
    }
  } catch (error) {
    await pg().query(
      `
      DELETE FROM workflow.templates
      WHERE id = $1
        AND ($2 = '' OR organization_id = $2)
      `,
      [duplicatedWorkflowId, organizationFilterValue(organizationId)],
    );
    throw error;
  }

  return duplicatedWorkflowId;
}

function remapWorkflowGraphDistribution(
  distribution: WorkflowGraphV3Distribution,
  stepIdMap: ReadonlyMap<string, string>,
): WorkflowGraphV3Distribution {
  return {
    partitions: structuredClone(distribution.partitions),
    steps: distribution.steps.map((step) => ({
      ...structuredClone(step),
      stepId: stepIdMap.get(step.stepId) ?? step.stepId,
    })),
    routes: distribution.routes.map((route) => ({
      ...structuredClone(route),
      from: {
        ...route.from,
        stepId: stepIdMap.get(route.from.stepId) ?? route.from.stepId,
      },
      to: {
        ...route.to,
        stepId: stepIdMap.get(route.to.stepId) ?? route.to.stepId,
      },
    })),
  };
}

async function ensureProjectScopePg(
  client: PgClient,
  organizationId: string,
  projectId?: string | null,
) {
  const scopedProjectId = projectId?.trim();
  if (!scopedProjectId) {
    return null;
  }
  const existing = await pgOne<Row>(
    client,
    "SELECT organization_id FROM identity.projects WHERE id = $1",
    [scopedProjectId],
  );
  if (existing) {
    if (String(existing.organization_id) !== organizationId) {
      throw new StudioForbiddenError(
        "project_organization_mismatch",
        "Project does not belong to the selected organization.",
      );
    }
    return scopedProjectId;
  }
  const slug =
    scopedProjectId
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  await client.query(
    `
    INSERT INTO identity.projects (
      id, organization_id, slug, name, metadata_json, created_at, updated_at
    )
    VALUES ($1, $2, $3, $1, '{"source":"studio-context"}'::jsonb, $4, $4)
    `,
    [scopedProjectId, organizationId, slug, now()],
  );
  return scopedProjectId;
}

export async function updateWorkflowTemplate(
  input: UpdateWorkflowTemplateInput,
) {
  const workflow = await getWorkflowTemplate(input.id, input.organizationId);
  if (!workflow) {
    throw new StudioNotFoundError(
      "workflow_not_found",
      "Workflow template not found.",
    );
  }

  const name =
    input.name === undefined ? workflow.template.name : input.name.trim();
  if (!name) {
    throw new StudioValidationError(
      "workflow_name_required",
      "Workflow name is required.",
      { field: "name" },
    );
  }

  const description =
    input.description === undefined
      ? workflow.template.description
      : input.description?.trim() || null;
  const enabled = input.enabled ?? workflow.template.enabled;
  const apiKeyId =
    input.apiKeyId === undefined
      ? workflow.template.apiKeyId
      : input.apiKeyId?.trim() || null;
  // A new binding must name a key this organization can see; an unknown or
  // other-organization id used to be stored as is and only failed at run time.
  if (apiKeyId && apiKeyId !== workflow.template.apiKeyId) {
    await requireVisibleApiKey(apiKeyId, input.organizationId);
  }

  await withPostgresTransaction(pg(), async (client) => {
    const contract = {
      inputSchema: input.inputSchema ?? workflow.template.inputSchema,
      output: input.output ?? workflow.template.output,
    };
    validateWorkflowContract(contract);
    const references = parseWorkflowReferences(
      input.agentBindings === undefined
        ? workflow.template.agentBindings
        : input.agentBindings,
      input.resourceBindings === undefined
        ? workflow.template.resourceBindings
        : input.resourceBindings,
    );
    await client.query(
      `
      UPDATE workflow.templates
      SET name = $2, description = $3, enabled = $4, updated_at = $5, api_key_id = $7,
          input_schema_json=$8::jsonb,output_contract_json=$9::jsonb,
          config_json=jsonb_set(config_json,'{failurePolicy}',to_jsonb($10::text)),room_context_json=$11::jsonb,
          agent_bindings_json=$12::jsonb,resource_bindings_json=$13::jsonb
      WHERE id = $1
        AND ($6 = '' OR organization_id = $6)
    `,
      [
        input.id,
        name,
        description,
        enabled,
        now(),
        organizationFilterValue(input.organizationId),
        apiKeyId,
        JSON.stringify(contract.inputSchema),
        JSON.stringify(contract.output),
        workflowFailurePolicy(
          input.failurePolicy ?? workflow.template.failurePolicy,
        ),
        roomContextJson(
          input.room === undefined ? workflow.template.room : input.room,
        ),
        JSON.stringify(references.agentBindings),
        JSON.stringify(references.resourceBindings),
      ],
    );

    await captureWorkflowTreePg(client, {
      organizationId: workflow.template.organizationId,
      workflowTemplateId: input.id,
      validateOnly: true,
    });
  });

  return getWorkflowTemplate(input.id, input.organizationId);
}

export async function getWorkflowTemplate(
  idValue: string,
  organizationId?: string | null,
  projectId?: string | null,
) {
  const template = await pgOne<Row>(
    pg(),
    `
    SELECT w.*, NULL AS legacy_transfer_name
    FROM workflow.templates w
    WHERE w.id = $1
      AND ($2 = '' OR w.organization_id = $2)
      AND ($3 = '' OR w.project_id = $3)
    `,
    [
      idValue,
      organizationFilterValue(organizationId),
      organizationFilterValue(projectId),
    ],
  );
  if (!template) {
    return null;
  }

  const templateRecord = workflowTemplateRecord(template);
  const [
    persistedEdges,
    triggers,
    triggerEdges,
    decisions,
    decisionEdges,
    steps,
    actionLocks,
    runCount,
  ] = await Promise.all([
    listWorkflowEdges(idValue),
    listWorkflowTriggers(idValue),
    listWorkflowTriggerEdges(idValue),
    listWorkflowDecisions(idValue),
    listWorkflowDecisionEdges(idValue),
    listWorkflowSteps(idValue),
    listWorkflowActionLocks(idValue),
    pgOne<{ count: number }>(
      pg(),
      "SELECT count(*)::int AS count FROM execution.workflow_runs WHERE workflow_template_id=$1 AND organization_id=$2",
      [idValue, String(template.organization_id)],
    ),
  ]);
  const graph = workflowGraphFromTemplateRecord(templateRecord, persistedEdges);
  return {
    template: templateRecord,
    graph,
    controls: graph.controls,
    triggers,
    triggerEdges,
    decisions,
    decisionEdges,
    steps,
    actionLocks,
    edges: graph.edges.map((edge, index) => ({
      id: edge.id ?? `wfe_graph_${index}`,
      workflowTemplateId: idValue,
      fromStepId: edge.from,
      toStepId: edge.to,
      condition: (edge.condition ?? null) as
        | Row
        | string
        | boolean
        | number
        | null,
      createdAt: templateRecord.updatedAt,
      updatedAt: templateRecord.updatedAt,
    })),
    runCount: runCount?.count ?? 0,
  };
}

export async function listWorkflowActionLocks(workflowTemplateId: string) {
  return pgMany<Row>(
    pg(),
    `
    SELECT *
    FROM workflow.action_locks
    WHERE workflow_template_id = $1
    ORDER BY id ASC
    `,
    [workflowTemplateId],
  ).then((rows) => rows.map(workflowActionLockRecord));
}

export async function listWorkflowSteps(workflowTemplateId: string) {
  return pgMany<Row>(
    pg(),
    `
    SELECT s.*, pv.manifest_json
    FROM workflow.steps s
    LEFT JOIN workflow.action_locks action_lock
      ON action_lock.id = 'wfl_' || s.id
      AND action_lock.workflow_template_id = s.workflow_template_id
      AND action_lock.action_package_name = s.action_package_name
    LEFT JOIN actions.packages ap ON ap.package_name = s.action_package_name
    LEFT JOIN actions.package_versions pv
      ON pv.package_id = ap.id
      AND pv.version = action_lock.resolved_version
      AND pv.manifest_checksum = action_lock.checksum
      AND (action_lock.package_version_id IS NULL OR pv.id = action_lock.package_version_id)
    WHERE s.workflow_template_id = $1
      AND s.retired_at IS NULL
    ORDER BY s.position ASC
    `,
    [workflowTemplateId],
  ).then((rows) => rows.map(workflowStepRecord));
}

export async function listWorkflowEdges(workflowTemplateId: string) {
  return pgMany<Row>(
    pg(),
    `
    SELECT *
    FROM workflow.edges
    WHERE workflow_template_id = $1
    ORDER BY created_at ASC
    `,
    [workflowTemplateId],
  ).then((rows) => rows.map(workflowEdgeRecord));
}

export async function listWorkflowTriggers(workflowTemplateId: string) {
  return pgMany<Row>(
    pg(),
    `
    SELECT *
    FROM workflow.triggers
    WHERE workflow_template_id = $1
    ORDER BY created_at ASC
    `,
    [workflowTemplateId],
  ).then((rows) => rows.map(workflowTriggerRecord));
}

export async function listWorkflowTriggerEdges(workflowTemplateId: string) {
  return pgMany<Row>(
    pg(),
    `
    SELECT *
    FROM workflow.trigger_edges
    WHERE workflow_template_id = $1
    ORDER BY created_at ASC
    `,
    [workflowTemplateId],
  ).then((rows) => rows.map(workflowTriggerEdgeRecord));
}

export async function listWorkflowDecisions(workflowTemplateId: string) {
  return pgMany<Row>(
    pg(),
    `
    SELECT *
    FROM workflow.decisions
    WHERE workflow_template_id = $1
    ORDER BY created_at ASC
    `,
    [workflowTemplateId],
  ).then((rows) => rows.map(workflowDecisionRecord));
}

export async function listWorkflowDecisionEdges(workflowTemplateId: string) {
  return pgMany<Row>(
    pg(),
    `
    SELECT *
    FROM workflow.decision_edges
    WHERE workflow_template_id = $1
    ORDER BY created_at ASC
    `,
    [workflowTemplateId],
  ).then((rows) => rows.map(workflowDecisionEdgeRecord));
}

export async function listWorkflowRuns(
  filters: WorkflowRunFilters & { organizationId?: string | null } = {},
) {
  return new WorkflowReadRepository(pg()).listRuns(
    organizationScope(filters.organizationId),
    filters,
  );
}

export async function workflowDashboardSummary(
  filters: { organizationId?: string | null } = {},
): Promise<WorkflowDashboardSummary> {
  const row =
    (await pgOne<Row>(
      pg(),
      `
      SELECT
        (
          SELECT COUNT(*)
          FROM workflow.templates w
          WHERE ($1 = '' OR w.organization_id = $1)
        ) AS workflow_count,
        (
          SELECT COUNT(*)
          FROM workflow.templates w
          WHERE w.enabled = true
            AND ($1 = '' OR w.organization_id = $1)
        ) AS enabled_workflow_count,
        (
          SELECT COUNT(*)
          FROM workflow.triggers t
          INNER JOIN workflow.templates w ON w.id = t.workflow_template_id
          WHERE t.type = 'schedule'
            AND t.enabled = true
            AND w.enabled = true
            AND ($1 = '' OR w.organization_id = $1)
        ) AS active_schedule_count,
        (
          SELECT COUNT(*)
          FROM execution.workflow_runs r
          INNER JOIN workflow.templates w ON w.id = r.workflow_template_id
          WHERE ($1 = '' OR w.organization_id = $1)
        ) AS run_count,
        (
          SELECT COUNT(*)
          FROM execution.workflow_runs r
          INNER JOIN workflow.templates w ON w.id = r.workflow_template_id
          WHERE r.status = 'completed'
            AND ($1 = '' OR w.organization_id = $1)
        ) AS completed_run_count,
        (
          SELECT COUNT(*)
          FROM execution.workflow_runs r
          INNER JOIN workflow.templates w ON w.id = r.workflow_template_id
          WHERE r.status = 'failed'
            AND ($1 = '' OR w.organization_id = $1)
        ) AS failed_run_count
      `,
      [organizationFilterValue(filters.organizationId)],
    )) ?? {};
  const runCount = Number(row.run_count ?? 0);
  const completedRunCount = Number(row.completed_run_count ?? 0);

  return {
    workflowCount: Number(row.workflow_count ?? 0),
    enabledWorkflowCount: Number(row.enabled_workflow_count ?? 0),
    activeScheduleCount: Number(row.active_schedule_count ?? 0),
    runCount,
    completedRunCount,
    failedRunCount: Number(row.failed_run_count ?? 0),
    successRate: runCount
      ? Math.round((completedRunCount / runCount) * 100)
      : 0,
  };
}

export async function workflowRunActivity(
  filters: { organizationId?: string | null; days?: number } = {},
): Promise<WorkflowRunActivityPoint[]> {
  const days = Math.min(Math.max(Math.trunc(filters.days ?? 14), 1), 90);
  const rows = await pgMany<Row>(
    pg(),
    `
    SELECT
      to_char(d.day, 'YYYY-MM-DD') AS date,
      COUNT(r.id) FILTER (WHERE r.status = 'completed') AS completed,
      COUNT(r.id) FILTER (WHERE r.status = 'failed') AS failed,
      COUNT(r.id) FILTER (WHERE r.status NOT IN ('completed', 'failed')) AS other
    FROM generate_series(
      date_trunc('day', now()) - make_interval(days => $2::int - 1),
      date_trunc('day', now()),
      interval '1 day'
    ) AS d(day)
    LEFT JOIN execution.workflow_runs r
      ON r.created_at >= d.day
      AND r.created_at < d.day + interval '1 day'
      AND ($1 = '' OR r.organization_id = $1)
    GROUP BY d.day
    ORDER BY d.day
    `,
    [organizationFilterValue(filters.organizationId), days],
  );

  return rows.map((row) => {
    const completed = Number(row.completed ?? 0);
    const failed = Number(row.failed ?? 0);
    const other = Number(row.other ?? 0);

    return {
      date: String(row.date),
      completed,
      failed,
      other,
      total: completed + failed + other,
    };
  });
}

function snapshotRows(value: unknown): Row[] {
  return Array.isArray(value) ? (value as Row[]) : [];
}

export async function getWorkflowRun(
  idValue: string,
  organizationId?: string | null,
  projectId?: string | null,
) {
  const run = await pgOne<Row>(
    pg(),
    `
    SELECT r.*, w.name AS workflow_name
    FROM execution.workflow_runs r
    INNER JOIN workflow.templates w ON w.id = r.workflow_template_id
    WHERE r.id = $1
      AND ($2 = '' OR w.organization_id = $2)
      AND ($3 = '' OR w.project_id = $3)
    `,
    [
      idValue,
      organizationFilterValue(organizationId),
      organizationFilterValue(projectId),
    ],
  );
  if (!run) {
    return null;
  }

  const workflowTemplateId = String(run.workflow_template_id);
  const snapshot = parsePayload(run.template_snapshot_json);
  const frozenTemplate = parsePayload(snapshot.workflowTemplate);
  const frozenContract = parsePayload(snapshot.contract);

  return {
    run: workflowRunRecord(run),
    resolvedMembersByPartition:
      snapshot.graphVersion === WORKFLOW_GRAPH_V3
        ? resolvedWorkflowMembers(parsePayload(run.metadata_json))
        : {},
    distributedTasks:
      snapshot.graphVersion === WORKFLOW_GRAPH_V3
        ? await workflowRunTaskInspection(pg(), idValue, snapshot.distribution)
        : [],
    childRuns: (
      await pgMany<Row>(
        pg(),
        `SELECT id, workflow_template_id, invoking_step_run_id, invocation_attempt, status, error, created_at
      FROM execution.workflow_runs WHERE parent_run_id=$1 AND organization_id=$2 ORDER BY created_at,id`,
        [idValue, String(run.organization_id)],
      )
    ).map((child) => ({
      id: String(child.id),
      workflowTemplateId: String(child.workflow_template_id),
      invokingStepRunId: String(child.invoking_step_run_id),
      invocationAttempt: Number(child.invocation_attempt),
      status: String(child.status),
      error: child.error ?? null,
      createdAt: timestampText(child.created_at),
    })),
    template: Object.keys(frozenTemplate).length
      ? workflowTemplateRecord({
          ...frozenTemplate,
          id: workflowTemplateId,
          organization_id: run.organization_id,
          project_id: run.project_id,
          api_key_id: frozenTemplate.apiKeyId ?? frozenTemplate.api_key_id,
          graph_version:
            snapshot.graphVersion ??
            frozenTemplate.graphVersion ??
            frozenTemplate.graph_version,
          graph_json: {
            version: snapshot.graphVersion,
            controls: snapshot.controls ?? [],
            edges: snapshot.edges ?? [],
            ...(snapshot.distribution
              ? { distribution: snapshot.distribution }
              : {}),
          },
          input_schema_json: frozenContract.inputSchema,
          output_contract_json: frozenContract.output,
          agent_bindings_json: frozenTemplate.agentBindings,
          resource_bindings_json: frozenTemplate.resourceBindings,
          room_context_json: frozenTemplate.room,
          created_at:
            frozenTemplate.createdAt ??
            frozenTemplate.created_at ??
            run.created_at,
          updated_at: run.created_at,
        })
      : null,
    triggers: snapshotRows(snapshot.triggers).map((value) => {
      const trigger = value as Row;
      return workflowTriggerRecord({
        ...trigger,
        workflow_template_id: workflowTemplateId,
        config_json: trigger.config ?? trigger.config_json,
        state_json: {},
        created_at: run.created_at,
        updated_at: run.created_at,
      });
    }),
    triggerEdges: snapshotRows(snapshot.triggerEdges).map((value) => {
      const edge = value as Row;
      return workflowTriggerEdgeRecord({
        ...edge,
        workflow_template_id: workflowTemplateId,
        trigger_id: edge.triggerId ?? edge.trigger_id,
        to_step_id: edge.toStepId ?? edge.to_step_id,
        condition_json: edge.condition ?? edge.condition_json,
        created_at: run.created_at,
        updated_at: run.created_at,
      });
    }),
    steps: snapshotRows(run.resolved_steps_json).map((value) => {
      const step = value as Row;
      return workflowStepRecord({
        ...step,
        workflow_template_id: workflowTemplateId,
        called_workflow_id: step.calledWorkflowId ?? step.called_workflow_id,
        action_package_name: step.actionPackage ?? step.action_package_name,
        action_version_range: step.versionRange ?? step.action_version_range,
        config_json: step.config ?? step.config_json,
        input_bindings_json: step.inputBindings ?? step.input_bindings_json,
        execution_location_id:
          step.executionLocationId ?? step.execution_location_id,
        execution_target_json:
          step.executionTarget ?? step.execution_target_json,
        canvas_x: step.canvasX ?? step.canvas_x,
        canvas_y: step.canvasY ?? step.canvas_y,
        timeout_seconds: step.timeoutSeconds ?? step.timeout_seconds,
        manifest_json: step.manifestSnapshot,
        created_at: run.created_at,
        updated_at: run.created_at,
      });
    }),
    edges: snapshotRows(snapshot.edges).map((value) => {
      const edge = value as Row;
      return workflowEdgeRecord({
        ...edge,
        workflow_template_id: workflowTemplateId,
        from_step_id: edge.fromStepId ?? edge.from ?? edge.from_step_id,
        to_step_id: edge.toStepId ?? edge.to ?? edge.to_step_id,
        condition_json: edge.condition ?? edge.condition_json,
        created_at: run.created_at,
        updated_at: run.created_at,
      });
    }),
    stepRuns: (
      await pgMany<Row>(
        pg(),
        `
      SELECT s.*,COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',a.id,'attempt',a.attempt,'backend',a.backend,'executorId',a.executor_id,'memberId',a.member_id,
        'declaredTarget',a.declared_target_json,'state',a.state,'leaseExpiresAt',a.lease_expires_at,
        'cancelRequestedAt',a.cancel_requested_at,'cleanupConfirmedAt',a.cleanup_confirmed_at,
        'progress',a.progress_json,'error',a.error_json) ORDER BY a.attempt)
        FROM execution.executor_assignments a WHERE a.workflow_step_run_id=s.id),'[]'::jsonb) AS executor_assignments
      FROM execution.workflow_step_runs s
      WHERE s.workflow_run_id = $1
      ORDER BY s.created_at ASC
      `,
        [idValue],
      )
    ).map(workflowStepRunRecord),
    dynamicRegions: (
      await pgMany<Row>(
        pg(),
        `SELECT region.*,
                COUNT(instance.id) FILTER (WHERE instance.status = 'pending')::int AS pending_count,
                COUNT(instance.id) FILTER (WHERE instance.status IN ('queued', 'running'))::int AS running_count
         FROM execution.workflow_dynamic_regions region
         LEFT JOIN execution.workflow_dynamic_instances instance
           ON instance.dynamic_region_id = region.id
         WHERE region.workflow_run_id = $1
         GROUP BY region.id
         ORDER BY region.created_at ASC`,
        [idValue],
      )
    ).map(workflowDynamicRegionRecord),
    conditionEvaluations: (
      await pgMany<Row>(
        pg(),
        `SELECT * FROM execution.workflow_condition_evaluations
         WHERE workflow_run_id = $1 ORDER BY created_at ASC`,
        [idValue],
      )
    ).map(workflowConditionEvaluationRecord),
    decisionEvaluations: (
      await pgMany<Row>(
        pg(),
        `SELECT * FROM execution.workflow_decision_evaluations
         WHERE workflow_run_id = $1 ORDER BY created_at ASC`,
        [idValue],
      )
    ).map(workflowDecisionEvaluationRecord),
    artifacts: (
      await pgMany<Row>(
        pg(),
        `
      SELECT *
      FROM execution.workflow_artifacts
      WHERE workflow_run_id = $1
      ORDER BY created_at ASC
      `,
        [idValue],
      )
    ).map(workflowArtifactRecord),
    logs: await workflowEventsAsLogs(idValue),
    legacyRun: null,
  };
}

export async function updateWorkflowStepConfig(input: {
  stepId: string;
  configJson: string;
  organizationId?: string | null;
}) {
  let parsed = parseEditableJson(input.configJson, "config");
  const step = await pgOne<Row>(
    pg(),
    `SELECT s.action_package_name,t.room_context_json,t.agent_bindings_json,t.resource_bindings_json
     FROM workflow.steps s JOIN workflow.templates t ON t.id=s.workflow_template_id
     WHERE s.id=$1 AND ($2='' OR t.organization_id=$2)`,
    [input.stepId, organizationFilterValue(input.organizationId)],
  );
  if (step)
    parsed = sanitizeWorkflowStepConfig(
      String(step.action_package_name),
      parsed,
      step.room_context_json,
      parseWorkflowReferences(
        step.agent_bindings_json ?? {},
        step.resource_bindings_json ?? {},
      ),
    );
  const timestamp = now();
  await withPostgresTransaction(pg(), async (client) => {
    const result = await client.query(
      `
      UPDATE workflow.steps
      SET config_json = $2::jsonb,
          updated_at = $3
      WHERE id = $1
        AND retired_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM workflow.templates w
          WHERE w.id = workflow.steps.workflow_template_id
            AND ($4 = '' OR w.organization_id = $4)
        )
    `,
      [
        input.stepId,
        JSON.stringify(parsed),
        timestamp,
        organizationFilterValue(input.organizationId),
      ],
    );
    if (result.rowCount === 0) {
      throw new StudioNotFoundError(
        "workflow_step_not_found",
        "Workflow step not found.",
      );
    }
    const owner = await pgOne<Row>(
      client,
      `SELECT t.id,t.organization_id FROM workflow.templates t JOIN workflow.steps s ON s.workflow_template_id=t.id WHERE s.id=$1`,
      [input.stepId],
    );
    if (owner)
      await captureWorkflowTreePg(client, {
        organizationId: String(owner.organization_id),
        workflowTemplateId: String(owner.id),
        validateOnly: true,
      });
  });
}

export async function previewWorkflowActionLockChanges(input: {
  workflowTemplateId: string;
  organizationId?: string | null;
  steps: WorkflowGraphStepInput[];
}): Promise<WorkflowActionLockChange[]> {
  const bundle = await getWorkflowTemplate(
    input.workflowTemplateId,
    input.organizationId,
  );
  if (!bundle) {
    throw new StudioNotFoundError(
      "workflow_not_found",
      "Workflow template not found.",
    );
  }
  const currentLocks = new Map(
    bundle.actionLocks.map((lock) => [lock.id, lock]),
  );
  const nextLocks: WorkflowActionLockRecord[] = [];

  for (const step of input.steps.filter((step) => step.kind !== "workflow")) {
    const stepId = textId(step.id, "step");
    const actionPackageName = textId(step.actionPackageName, "action package");
    const versionRange = step.actionVersionRange?.trim() || "*";
    const lockId = `wfl_${stepId}`;
    const previous = currentLocks.get(lockId);
    if (!previous) {
      continue;
    }
    const resolved = await resolveActionPackageVersionPg(
      pg(),
      actionPackageName,
      versionRange,
      bundle.template.organizationId,
    );
    const next = workflowActionLockFromResolved({
      actionPackageName,
      createdAt: previous.createdAt,
      lockId,
      resolved,
      versionRange,
      workflowTemplateId: input.workflowTemplateId,
    });
    nextLocks.push(next);
  }
  return diffWorkflowActionLocks(
    bundle.actionLocks,
    nextLocks,
    new Set(input.steps.map((step) => `wfl_${textId(step.id, "step")}`)),
  );
}

export function diffWorkflowActionLocks(
  currentLocks: WorkflowActionLockRecord[],
  nextLocks: WorkflowActionLockRecord[],
  retainedLockIds = new Set(nextLocks.map((lock) => lock.id)),
): WorkflowActionLockChange[] {
  const nextById = new Map(nextLocks.map((lock) => [lock.id, lock]));
  const changes: WorkflowActionLockChange[] = [];
  for (const previous of currentLocks) {
    const next = nextById.get(previous.id);
    if (next && !sameWorkflowActionLock(previous, next)) {
      changes.push({
        stepId: previous.id.replace(/^wfl_/, ""),
        kind: "update",
        actionPackageName: next.actionPackageName,
        previous,
        next,
      });
    } else if (!next && !retainedLockIds.has(previous.id)) {
      changes.push({
        stepId: previous.id.replace(/^wfl_/, ""),
        kind: "remove",
        actionPackageName: previous.actionPackageName,
        previous,
        next: null,
      });
    }
  }
  return changes;
}

export function workflowActionLockConfirmationError(
  changes: WorkflowActionLockChange[],
) {
  const error = new Error(
    `${changes.length} workflow action lock${changes.length === 1 ? "" : "s"} would change. Review the exact version and checksum identities before saving.`,
  ) as Error & {
    action: string;
    code: string;
    details: { lockChanges: WorkflowActionLockChange[] };
    retryable: boolean;
    statusCode: number;
  };
  error.code = "workflow_action_lock_confirmation_required";
  error.statusCode = 409;
  error.retryable = false;
  error.action = "Review the lock changes and confirm the workflow save.";
  error.details = { lockChanges: changes };
  return error;
}

export function workflowActionLockFromResolved(input: {
  actionPackageName: string;
  createdAt: string;
  lockId: string;
  resolved: ResolvedActionPackageVersion;
  versionRange: string;
  workflowTemplateId: string;
}): WorkflowActionLockRecord {
  return {
    id: input.lockId,
    workflowTemplateId: input.workflowTemplateId,
    actionPackageName: input.actionPackageName,
    versionRange: input.versionRange,
    resolvedVersion: input.resolved.version,
    packageVersionId: input.resolved.packageVersionId,
    manifestChecksum: input.resolved.manifestChecksum,
    artifactChecksum: input.resolved.artifactChecksum,
    artifactReference: input.resolved.artifactReference,
    sourceRegistry: input.resolved.sourceRegistry,
    trustLevel: input.resolved.trustLevel,
    createdAt: input.createdAt,
  };
}

function sameWorkflowActionLock(
  left: WorkflowActionLockRecord,
  right: WorkflowActionLockRecord,
) {
  return (
    left.actionPackageName === right.actionPackageName &&
    left.versionRange === right.versionRange &&
    left.resolvedVersion === right.resolvedVersion &&
    left.manifestChecksum === right.manifestChecksum &&
    left.artifactChecksum === right.artifactChecksum &&
    left.artifactReference === right.artifactReference &&
    left.sourceRegistry === right.sourceRegistry &&
    left.trustLevel === right.trustLevel
  );
}

function sanitizeWorkflowStepConfig(
  actionPackageName: string,
  config: Row,
  room?: unknown,
  references?: ReturnType<typeof parseWorkflowReferences>,
) {
  if (references) {
    const resolved = resolveWorkflowReferences(
      config as ActionJson,
      references,
      "config",
    ) as Row;
    if (JSON.stringify(resolved) !== JSON.stringify(config)) {
      sanitizeWorkflowStepConfig(actionPackageName, resolved, room);
      return config;
    }
  }
  if (actionPackageName === "@beam/room-transfer") {
    const resolved = resolveActionRoomContext({
      workflowRoom: room,
      actionPackage: actionPackageName,
      config,
    });
    if (resolved.room) roomWorkflowConfigSchema.parse(resolved.config);
    return roomWorkflowDefinitionConfigSchema.parse(config);
  }
  if (actionPackageName !== BEAM_TRANSFER_ACTION) {
    return config;
  }
  const sanitized = { ...config };
  for (const field of ["apiKey", "transferTemplateId"]) {
    delete sanitized[field];
  }
  return sanitized;
}

export async function listHistoryBackedWorkflowStepIdsPg(
  client: PgPool | PgClient,
  stepIds: string[],
) {
  if (!stepIds.length) {
    return [];
  }
  const rows = await pgMany<Row>(
    client,
    `
    SELECT DISTINCT workflow_step_id
    FROM (
      SELECT workflow_step_id
      FROM execution.workflow_dynamic_instances
      WHERE workflow_step_id = ANY($1::text[])
      UNION
      SELECT workflow_step_id
      FROM execution.workflow_step_runs
      WHERE workflow_step_id = ANY($1::text[])
      UNION
      SELECT workflow_step_id
      FROM execution.workflow_tasks
      WHERE workflow_step_id = ANY($1::text[])
      UNION
      SELECT workflow_step_id
      FROM execution.execution_plans
      WHERE workflow_step_id = ANY($1::text[])
      UNION
      SELECT workflow_step_id
      FROM execution.execution_plan_nodes
      WHERE workflow_step_id = ANY($1::text[])
    ) referenced_steps
    `,
    [stepIds],
  );
  return rows.map((row) => String(row.workflow_step_id));
}

export async function updateWorkflowGraph(input: {
  room?: WorkflowRoomContext | null;
  failurePolicy?: "stop_on_failure" | "continue_on_failure";
  inputSchema?: WorkflowJsonSchema;
  output?: WorkflowOutputContract;
  agentBindings?: Row;
  resourceBindings?: Row;
  workflowTemplateId: string;
  organizationId?: string | null;
  graphVersion?: unknown;
  controls?: unknown[];
  distribution?: unknown;
  triggers?: WorkflowGraphTriggerInput[];
  triggerEdges?: WorkflowGraphTriggerEdgeInput[];
  decisions?: WorkflowGraphDecisionInput[];
  decisionEdges?: WorkflowGraphDecisionEdgeInput[];
  steps: WorkflowGraphStepInput[];
  edges: WorkflowGraphEdgeInput[];
}) {
  const bundle = await getWorkflowTemplate(
    input.workflowTemplateId,
    input.organizationId,
  );
  if (!bundle) {
    throw new StudioNotFoundError(
      "workflow_not_found",
      "Workflow template not found.",
    );
  }

  const references = parseWorkflowReferences(
    input.agentBindings === undefined
      ? bundle.template.agentBindings
      : input.agentBindings,
    input.resourceBindings === undefined
      ? bundle.template.resourceBindings
      : input.resourceBindings,
  );
  const timestamp = now();
  const sanitizedSteps = input.steps.map((step, index) => {
    const kind = step.kind === "workflow" ? "workflow" : "action";
    const actionPackageName =
      kind === "workflow"
        ? ""
        : textId(step.actionPackageName, "action package");
    return {
      id: textId(step.id, "step"),
      kind,
      calledWorkflowId:
        kind === "workflow"
          ? textId(step.calledWorkflowId, "called workflow")
          : null,
      name: step.name?.trim() || null,
      actionPackageName,
      actionVersionRange: step.actionVersionRange?.trim() || "*",
      position: Number.isInteger(step.position) ? step.position : index,
      enabled: Boolean(step.enabled),
      config:
        kind === "workflow"
          ? {}
          : sanitizeWorkflowStepConfig(
              actionPackageName,
              jsonObject(step.config, "config"),
              input.room === undefined ? bundle.template.room : input.room,
              references,
            ),
      inputBindings: jsonObject(step.inputBindings, "input bindings"),
      executionTarget:
        kind === "workflow"
          ? undefined
          : actionExecutionTargetSchema.parse(
              step.executionTarget ?? { kind: "studio" },
            ),
      placement:
        kind === "workflow"
          ? "dispatcher"
          : actionTargetPlacement(
              actionExecutionTargetSchema.parse(
                step.executionTarget ?? { kind: "studio" },
              ),
            ),
      executionLocationId:
        step.executionTarget?.kind === "remote-transport"
          ? (step.executionTarget.executionLocationId ?? null)
          : null,
      canvasX: finiteNumberOrNull(step.canvasX),
      canvasY: finiteNumberOrNull(step.canvasY),
      timeoutSeconds: finiteNumberOrNull(step.timeoutSeconds),
      required: step.required !== false,
    };
  });
  const sanitizedEdges = input.edges.map((edge) => ({
    id: textId(edge.id, "edge"),
    fromStepId: textId(edge.fromStepId, "edge source"),
    toStepId: textId(edge.toStepId, "edge target"),
    condition: edge.condition ?? null,
  }));
  const graphVersion = workflowGraphVersion(
    input.graphVersion ?? bundle.template.graphVersion,
    input.controls,
    input.decisions,
  );
  if (
    bundle.template.graphVersion === WORKFLOW_GRAPH_V3 &&
    graphVersion !== WORKFLOW_GRAPH_V3
  ) {
    throw graphValidationError(
      "A distributed workflow graph cannot be downgraded without creating a new definition.",
    );
  }
  if (
    graphVersion === WORKFLOW_GRAPH_V3 &&
    bundle.template.graphVersion !== WORKFLOW_GRAPH_V3 &&
    !webEnv.roomWorkflowsEnabled
  ) {
    throw graphValidationError("Distributed workflows are not available yet.");
  }
  const sanitizedControls =
    graphVersion === WORKFLOW_GRAPH_V2 || graphVersion === WORKFLOW_GRAPH_V3
      ? sanitizeWorkflowGraphControls(
          input.controls ?? bundle.controls ?? [],
          graphVersion === WORKFLOW_GRAPH_V3,
        )
      : [];
  if (graphVersion !== WORKFLOW_GRAPH_V3 && input.distribution !== undefined) {
    throw graphValidationError("Distribution requires workflow-graph/v3.");
  }
  const distribution =
    graphVersion === WORKFLOW_GRAPH_V3
      ? (input.distribution ?? bundle.template.graph.distribution)
      : undefined;
  const graphDefinition: WorkflowGraphV2Definition = {
    version: WORKFLOW_GRAPH_V2,
    controls: sanitizedControls,
    edges: sanitizedEdges.map((edge) => ({
      id: edge.id,
      from: edge.fromStepId,
      to: edge.toStepId,
      condition: edge.condition as ActionJson,
    })),
  };
  const sanitizedTriggers = (input.triggers ?? []).map((trigger) => {
    const type = workflowTriggerType(trigger.type);
    return {
      id: textId(trigger.id, "trigger"),
      type,
      name: trigger.name?.trim() || workflowTriggerName(type),
      enabled: Boolean(trigger.enabled),
      config: sanitizeWorkflowTriggerConfig(type, trigger.config ?? {}, true),
      state: jsonObjectOrEmpty(trigger.state),
      canvasX: finiteNumberOrNull(trigger.canvasX),
      canvasY: finiteNumberOrNull(trigger.canvasY),
    };
  });
  const sanitizedTriggerEdges = (input.triggerEdges ?? []).map((edge) => ({
    id: textId(edge.id, "trigger edge"),
    triggerId: textId(edge.triggerId, "trigger edge source"),
    toStepId: textId(edge.toStepId, "trigger edge target"),
    condition: edge.condition ?? null,
  }));
  const triggerIds = new Set(sanitizedTriggers.map((trigger) => trigger.id));
  const stepIds = new Set(sanitizedSteps.map((step) => step.id));
  for (const edge of sanitizedTriggerEdges) {
    if (!triggerIds.has(edge.triggerId)) {
      throw new StudioValidationError(
        "workflow_graph_invalid",
        `Trigger edge ${edge.id} references a missing trigger.`,
      );
    }
    if (!stepIds.has(edge.toStepId)) {
      throw new StudioValidationError(
        "workflow_graph_invalid",
        `Trigger edge ${edge.id} references a missing step.`,
      );
    }
  }

  const sanitizedDecisions = (input.decisions ?? []).map((decision) => {
    const kind = workflowDecisionKind(decision.kind);
    return {
      id: textId(decision.id, "decision"),
      name:
        decision.name?.trim() || (kind === "switch" ? "Switch" : "Decision"),
      kind,
      enabled: decision.enabled !== false,
      joinMode: workflowDecisionJoinMode(decision.joinMode),
      handleFailure: Boolean(decision.handleFailure),
      config: sanitizeWorkflowDecisionConfig(kind, decision.config ?? {}),
      canvasX: finiteNumberOrNull(decision.canvasX),
      canvasY: finiteNumberOrNull(decision.canvasY),
    };
  });
  const sanitizedDecisionEdges = (input.decisionEdges ?? []).map((edge) => ({
    id: textId(edge.id, "decision edge"),
    fromStepId: optionalTextId(edge.fromStepId),
    fromDecisionId: optionalTextId(edge.fromDecisionId),
    toStepId: optionalTextId(edge.toStepId),
    toDecisionId: optionalTextId(edge.toDecisionId),
    branch: workflowDecisionBranch(edge.branch),
  }));
  const decisionIds = new Set(
    sanitizedDecisions.map((decision) => decision.id),
  );
  const decisionsById = new Map(
    sanitizedDecisions.map((decision) => [decision.id, decision]),
  );
  const outgoingBranches = new Map<string, Set<string>>();
  for (const edge of sanitizedDecisionEdges) {
    // Mirrors the database CHECK constraints so the user sees a real message
    // instead of a raw constraint violation.
    if (Boolean(edge.fromStepId) === Boolean(edge.fromDecisionId)) {
      throw graphValidationError(
        `Decision edge ${edge.id} must start at exactly one step or decision.`,
      );
    }
    if (Boolean(edge.toStepId) === Boolean(edge.toDecisionId)) {
      throw graphValidationError(
        `Decision edge ${edge.id} must end at exactly one step or decision.`,
      );
    }
    if (edge.fromDecisionId && !edge.branch) {
      throw graphValidationError(
        `Decision edge ${edge.id} must identify its output branch.`,
      );
    }
    if (edge.fromStepId && edge.branch) {
      throw graphValidationError(
        `Decision edge ${edge.id} enters a decision and cannot carry a branch.`,
      );
    }
    for (const [id, label] of [
      [edge.fromStepId, "step"],
      [edge.toStepId, "step"],
    ] as const) {
      if (id && !stepIds.has(id)) {
        throw graphValidationError(
          `Decision edge ${edge.id} references a missing ${label}.`,
        );
      }
    }
    for (const id of [edge.fromDecisionId, edge.toDecisionId]) {
      if (id && !decisionIds.has(id)) {
        throw graphValidationError(
          `Decision edge ${edge.id} references a missing decision.`,
        );
      }
    }
    if (edge.fromDecisionId && edge.branch) {
      const decision = decisionsById.get(edge.fromDecisionId)!;
      const cases = decision.config.cases as Array<{ id: string }> | undefined;
      const valid =
        decision.kind === "if"
          ? edge.branch === "true" || edge.branch === "false"
          : edge.branch === "default" ||
            cases?.some((entry) => edge.branch === `case:${entry.id}`) === true;
      if (!valid) {
        throw graphValidationError(
          `Decision edge ${edge.id} references output "${edge.branch}" that does not exist on ${decision.name}.`,
        );
      }
      const seen = outgoingBranches.get(decision.id) ?? new Set<string>();
      if (seen.has(edge.branch)) {
        throw graphValidationError(
          `${decision.name} has more than one edge from output "${edge.branch}".`,
        );
      }
      seen.add(edge.branch);
      outgoingBranches.set(decision.id, seen);
    }
  }
  for (const decision of sanitizedDecisions) {
    if (
      decision.kind === "switch" &&
      !outgoingBranches.get(decision.id)?.has("default")
    ) {
      throw graphValidationError(
        `${decision.name} requires a connected Default output.`,
      );
    }
  }

  if (sanitizedSteps.length) {
    try {
      const snapshot = {
        workflowRunId: "wfr_validation",
        templateId: input.workflowTemplateId,
        graphVersion,
        templateSnapshot: {},
        runtimeInputs: {},
        steps: sanitizedSteps.map((step) => ({
          id: step.id,
          position: step.position,
          enabled: step.enabled,
          actionPackage: step.actionPackageName,
          versionRange: step.actionVersionRange,
          config: step.config as Record<string, ActionJson>,
          inputBindings: step.inputBindings as Record<string, ActionJson>,
          placement: step.placement as ActionPlacement,
          executionTarget: step.executionTarget,
          executionLocationId: step.executionLocationId,
          timeoutSeconds: step.timeoutSeconds,
          required: step.required,
        })),
        edges: sanitizedEdges.map((edge) => ({
          id: edge.id,
          from: edge.fromStepId,
          to: edge.toStepId,
          condition: edge.condition as ActionJson,
        })),
        ...(graphVersion === WORKFLOW_GRAPH_V2
          ? { controls: sanitizedControls }
          : {}),
      } as const;
      validateGraphWorkflow({
        ...snapshot,
        graphVersion:
          graphVersion === WORKFLOW_GRAPH_V3 ? WORKFLOW_GRAPH_V2 : graphVersion,
        controls: sanitizedControls,
      });
      if (graphVersion === WORKFLOW_GRAPH_V2) {
        validateWorkflowGraphV2(graphDefinition, snapshot.steps);
      }
      if (graphVersion === WORKFLOW_GRAPH_V3) {
        validateWorkflowGraphV3(
          {
            ...graphDefinition,
            version: WORKFLOW_GRAPH_V3,
            distribution: distribution as WorkflowGraphV3Distribution,
          } as WorkflowGraphV3Definition,
          snapshot.steps,
        );
      }
    } catch (error) {
      throw graphValidationError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (graphVersion === WORKFLOW_GRAPH_V3 && !sanitizedSteps.length) {
    validateWorkflowGraphV3(
      {
        ...graphDefinition,
        version: WORKFLOW_GRAPH_V3,
        distribution: distribution as WorkflowGraphV3Distribution,
      },
      [],
    );
  }
  validateWorkflowTriggersForGraph({
    triggers: sanitizedTriggers,
    triggerEdges: sanitizedTriggerEdges,
    steps: sanitizedSteps,
    edges: sanitizedEdges,
  });
  // The same rule the editor marks on the canvas: a folder source always
  // fails when the transfer is created, so it is refused before it is saved.
  const [folderSource] = beamTransferFolderSources(sanitizedSteps);
  if (folderSource) {
    throw graphValidationError(
      `${folderSource.id}: ${BEAM_TRANSFER_FOLDER_SOURCE_ISSUE}`,
    );
  }

  const existingStepIds = new Set(bundle.steps.map((step) => step.id));
  const nextStepIds = new Set(sanitizedSteps.map((step) => step.id));
  const removedStepIds = [...existingStepIds].filter(
    (stepId) => !nextStepIds.has(stepId),
  );
  const historyBackedRemovedStepIds = removedStepIds.length
    ? await listHistoryBackedWorkflowStepIdsPg(pg(), removedStepIds)
    : [];
  const historyBackedRemovedStepIdSet = new Set(historyBackedRemovedStepIds);
  const disposableRemovedStepIds = removedStepIds.filter(
    (stepId) => !historyBackedRemovedStepIdSet.has(stepId),
  );

  try {
    await withPostgresTransaction(pg(), async (client) => {
      const lockedLayout = await client.query<{
        controls: WorkflowGraphV2Control[];
      }>(
        "SELECT COALESCE(graph_json->'controls','[]'::jsonb) AS controls FROM workflow.templates WHERE id=$1 AND organization_id=$2 FOR UPDATE",
        [input.workflowTemplateId, bundle.template.organizationId],
      );
      // Definition writes must not restore stale coordinates from another editor.
      // Seed new nodes from the draft; existing nodes retain the latest saved layout.
      const currentPositions = await client.query<{
        kind: string;
        id: string;
        x: number | null;
        y: number | null;
      }>(
        `
        SELECT 'step' AS kind,id,canvas_x AS x,canvas_y AS y FROM workflow.steps WHERE workflow_template_id=$1
        UNION ALL SELECT 'trigger',id,canvas_x,canvas_y FROM workflow.triggers WHERE workflow_template_id=$1
        UNION ALL SELECT 'decision',id,canvas_x,canvas_y FROM workflow.decisions WHERE workflow_template_id=$1`,
        [input.workflowTemplateId],
      );
      const byNode = new Map(
        currentPositions.rows.map((p) => [`${p.kind}:${p.id}`, p]),
      );
      for (const [kind, entries] of [
        ["step", sanitizedSteps],
        ["trigger", sanitizedTriggers],
        ["decision", sanitizedDecisions],
      ] as const) {
        for (const node of entries) {
          const existing = byNode.get(`${kind}:${node.id}`);
          if (existing) {
            node.canvasX = existing.x;
            node.canvasY = existing.y;
          }
        }
      }
      const currentControls = new Map(
        (lockedLayout.rows[0]?.controls ?? []).map((c) => [c.id, c]),
      );
      for (const control of sanitizedControls) {
        const existing = currentControls.get(control.id);
        if (existing) control.layout = existing.layout;
      }
      const contract = {
        inputSchema:
          input.inputSchema ??
          bundle.template.inputSchema ??
          defaultWorkflowContract.inputSchema,
        output:
          input.output ??
          bundle.template.output ??
          defaultWorkflowContract.output,
      };
      validateWorkflowContract(contract);
      await client.query(
        `UPDATE workflow.templates SET input_schema_json=$2::jsonb,output_contract_json=$3::jsonb,
        agent_bindings_json=$4::jsonb,resource_bindings_json=$5::jsonb,
        config_json=jsonb_set(config_json,'{failurePolicy}',to_jsonb($7::text)),room_context_json=$8::jsonb WHERE id=$1 AND organization_id=$6`,
        [
          input.workflowTemplateId,
          JSON.stringify(contract.inputSchema),
          JSON.stringify(contract.output),
          JSON.stringify(references.agentBindings),
          JSON.stringify(references.resourceBindings),
          bundle.template.organizationId,
          workflowFailurePolicy(
            input.failurePolicy ?? bundle.template.failurePolicy,
          ),
          roomContextJson(
            input.room === undefined ? bundle.template.room : input.room,
          ),
        ],
      );
      await persistBuiltinActionPackagesPg(client, timestamp);
      await client.query(
        "DELETE FROM workflow.trigger_edges WHERE workflow_template_id = $1",
        [input.workflowTemplateId],
      );
      await client.query(
        "DELETE FROM workflow.triggers WHERE workflow_template_id = $1",
        [input.workflowTemplateId],
      );
      // Decision edges reference decisions, so they go first.
      await client.query(
        "DELETE FROM workflow.decision_edges WHERE workflow_template_id = $1",
        [input.workflowTemplateId],
      );
      await client.query(
        "DELETE FROM workflow.decisions WHERE workflow_template_id = $1",
        [input.workflowTemplateId],
      );
      await client.query(
        "DELETE FROM workflow.edges WHERE workflow_template_id = $1",
        [input.workflowTemplateId],
      );
      await client.query(
        "DELETE FROM workflow.action_locks WHERE workflow_template_id = $1",
        [input.workflowTemplateId],
      );
      await client.query(
        `
        WITH bounds AS (
          SELECT COALESCE(MAX(position), 0) + 1000000 AS base_position
          FROM workflow.steps
          WHERE workflow_template_id = $1
        ),
        ranked AS (
          SELECT
            id,
            row_number() OVER (ORDER BY position ASC, id ASC) - 1 AS offset_position
          FROM workflow.steps
          WHERE workflow_template_id = $1
        )
        UPDATE workflow.steps s
        SET position = bounds.base_position + ranked.offset_position,
            updated_at = $2
        FROM ranked, bounds
        WHERE s.id = ranked.id
        `,
        [input.workflowTemplateId, timestamp],
      );
      if (removedStepIds.length) {
        await client.query(
          "DELETE FROM workflow.step_credential_bindings WHERE workflow_step_id = ANY($1::text[])",
          [removedStepIds],
        );
      }
      if (historyBackedRemovedStepIds.length) {
        await client.query(
          `
          UPDATE workflow.steps
          SET enabled = false,
              retired_at = COALESCE(retired_at, $3),
              updated_at = $3
          WHERE workflow_template_id = $1
            AND id = ANY($2::text[])
          `,
          [input.workflowTemplateId, historyBackedRemovedStepIds, timestamp],
        );
      }
      if (disposableRemovedStepIds.length) {
        await client.query(
          "DELETE FROM workflow.steps WHERE workflow_template_id = $1 AND id = ANY($2::text[])",
          [input.workflowTemplateId, disposableRemovedStepIds],
        );
      }

      for (const step of sanitizedSteps) {
        if (step.kind === "workflow") {
          const called = await pgOne<Row>(
            client,
            "SELECT id FROM workflow.templates WHERE id=$1 AND organization_id=$2",
            [step.calledWorkflowId, bundle.template.organizationId],
          );
          if (!called)
            throw new StudioValidationError(
              "called_workflow_not_found",
              "Called workflow is unavailable in this organization.",
              { field: "calledWorkflowId" },
            );
          await client.query(
            `INSERT INTO workflow.steps(id,workflow_template_id,kind,called_workflow_id,name,action_package_name,
            action_version_range,position,enabled,config_json,input_bindings_json,placement,canvas_x,canvas_y,timeout_seconds,required,created_at,updated_at)
            VALUES($1,$2,'workflow',$3,$4,NULL,'*',$5,$6,'{}',$7::jsonb,'dispatcher',$8,$9,$10,$11,$12,$12)
            ON CONFLICT(id) DO UPDATE SET kind='workflow',called_workflow_id=EXCLUDED.called_workflow_id,name=EXCLUDED.name,
              action_package_name=NULL,position=EXCLUDED.position,enabled=EXCLUDED.enabled,config_json='{}',input_bindings_json=EXCLUDED.input_bindings_json,
              placement='dispatcher',execution_location_id=NULL,execution_target_json=NULL,canvas_x=EXCLUDED.canvas_x,canvas_y=EXCLUDED.canvas_y,timeout_seconds=EXCLUDED.timeout_seconds,
              required=EXCLUDED.required,retired_at=NULL,updated_at=EXCLUDED.updated_at
            WHERE workflow.steps.workflow_template_id=EXCLUDED.workflow_template_id`,
            [
              step.id,
              input.workflowTemplateId,
              step.calledWorkflowId,
              step.name,
              step.position,
              step.enabled,
              JSON.stringify(step.inputBindings),
              step.canvasX,
              step.canvasY,
              step.timeoutSeconds,
              step.required,
              timestamp,
            ],
          );
          continue;
        }
        const resolvedPackage = await resolveActionPackageVersionPg(
          client,
          step.actionPackageName,
          step.actionVersionRange,
          bundle.template.organizationId,
        );
        try {
          assertWorkflowActionConfig(
            resolvedPackage.manifest,
            resolveWorkflowReferences(
              step.config as ActionJson,
              references,
              "config",
            ) as Record<string, ActionJson>,
            input.room === undefined ? bundle.template.room : input.room,
            false,
            step.executionTarget,
            false,
            graphVersion === WORKFLOW_GRAPH_V3,
          );
        } catch (error) {
          // A step config the action refuses is the caller's graph to fix.
          if (error instanceof ActionInputError) {
            throw graphValidationError(error.message);
          }
          throw error;
        }
        assertActionExecutionTarget(
          resolvedPackage.manifest,
          step.executionTarget!,
        );
        const actionLock = workflowActionLockFromResolved({
          actionPackageName: step.actionPackageName,
          createdAt: timestamp,
          lockId: `wfl_${step.id}`,
          resolved: resolvedPackage,
          versionRange: step.actionVersionRange,
          workflowTemplateId: input.workflowTemplateId,
        });
        await client.query(
          `
          INSERT INTO workflow.steps (
            id, workflow_template_id, name, action_package_name,
            action_version_range,
            position, enabled, config_json, input_bindings_json, placement,
            execution_location_id, canvas_x, canvas_y, timeout_seconds, required,
            retired_at, created_at, updated_at, execution_target_json
          )
          VALUES (
            $1, $2, $16, $3, $4,
            $5, $6, $7::jsonb, $8::jsonb, $9,
            $10, $11, $12, $13, $14,
            NULL, $15, $15, $17::jsonb
          )
          ON CONFLICT (id) DO UPDATE SET
            kind = 'action', called_workflow_id = NULL,
            name = EXCLUDED.name,
            action_package_name = EXCLUDED.action_package_name,
            action_version_range = EXCLUDED.action_version_range,
            position = EXCLUDED.position,
            enabled = EXCLUDED.enabled,
            config_json = EXCLUDED.config_json,
            input_bindings_json = EXCLUDED.input_bindings_json,
            placement = EXCLUDED.placement,
            execution_location_id = EXCLUDED.execution_location_id,
            execution_target_json = EXCLUDED.execution_target_json,
            canvas_x = EXCLUDED.canvas_x,
            canvas_y = EXCLUDED.canvas_y,
            timeout_seconds = EXCLUDED.timeout_seconds,
            required = EXCLUDED.required,
            retired_at = NULL,
            updated_at = EXCLUDED.updated_at
          WHERE workflow.steps.workflow_template_id = EXCLUDED.workflow_template_id
        `,
          [
            step.id,
            input.workflowTemplateId,
            step.actionPackageName,
            step.actionVersionRange,
            step.position,
            step.enabled,
            JSON.stringify(step.config),
            JSON.stringify(step.inputBindings),
            step.placement,
            step.executionLocationId,
            step.canvasX,
            step.canvasY,
            step.timeoutSeconds,
            step.required,
            timestamp,
            step.name,
            JSON.stringify(step.executionTarget),
          ],
        );
        await client.query(
          `
          INSERT INTO workflow.action_locks (
            id, workflow_template_id, action_package_name, version_range,
            resolved_version, package_version_id, checksum, artifact_checksum,
            artifact_reference, source_registry, trust_level, created_at
          )
          VALUES (
            $1, $2, $3, $4,
            $5, $6, $7, $8,
            $9, $10, $11, $12
          )
        `,
          [
            actionLock.id,
            actionLock.workflowTemplateId,
            actionLock.actionPackageName,
            actionLock.versionRange,
            actionLock.resolvedVersion,
            actionLock.packageVersionId,
            actionLock.manifestChecksum,
            actionLock.artifactChecksum,
            actionLock.artifactReference,
            actionLock.sourceRegistry,
            actionLock.trustLevel,
            actionLock.createdAt,
          ],
        );
      }

      for (const trigger of sanitizedTriggers) {
        await client.query(
          `
          INSERT INTO workflow.triggers (
            id, workflow_template_id, type, name, enabled, config_json,
            state_json, canvas_x, canvas_y, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $10)
        `,
          [
            trigger.id,
            input.workflowTemplateId,
            trigger.type,
            trigger.name,
            trigger.enabled,
            JSON.stringify(trigger.config),
            JSON.stringify(trigger.state),
            trigger.canvasX,
            trigger.canvasY,
            timestamp,
          ],
        );
      }

      for (const edge of sanitizedTriggerEdges) {
        await client.query(
          `
          INSERT INTO workflow.trigger_edges (
            id, workflow_template_id, trigger_id, to_step_id,
            condition_json, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6)
        `,
          [
            edge.id,
            input.workflowTemplateId,
            edge.triggerId,
            edge.toStepId,
            edge.condition === null ? null : JSON.stringify(edge.condition),
            timestamp,
          ],
        );
      }

      for (const decision of sanitizedDecisions) {
        await client.query(
          `
          INSERT INTO workflow.decisions (
            id, workflow_template_id, name, kind, enabled, join_mode, handle_failure,
            config_json, canvas_x, canvas_y, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $11)
        `,
          [
            decision.id,
            input.workflowTemplateId,
            decision.name,
            decision.kind,
            decision.enabled,
            decision.joinMode,
            decision.handleFailure,
            JSON.stringify(decision.config),
            decision.canvasX,
            decision.canvasY,
            timestamp,
          ],
        );
      }

      for (const edge of sanitizedDecisionEdges) {
        await client.query(
          `
          INSERT INTO workflow.decision_edges (
            id, workflow_template_id, from_step_id, from_decision_id,
            to_step_id, to_decision_id, branch, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
        `,
          [
            edge.id,
            input.workflowTemplateId,
            edge.fromStepId,
            edge.fromDecisionId,
            edge.toStepId,
            edge.toDecisionId,
            edge.branch,
            timestamp,
          ],
        );
      }

      for (const edge of sanitizedEdges.filter(
        (candidate) =>
          stepIds.has(candidate.fromStepId) && stepIds.has(candidate.toStepId),
      )) {
        await client.query(
          `
          INSERT INTO workflow.edges (
            id, workflow_template_id, from_step_id, to_step_id,
            condition_json, created_at, updated_at
          )
          VALUES (
            $1, $2, $3, $4,
            $5::jsonb, $6, $6
          )
        `,
          [
            edge.id,
            input.workflowTemplateId,
            edge.fromStepId,
            edge.toStepId,
            edge.condition === null ? null : JSON.stringify(edge.condition),
            timestamp,
          ],
        );
      }

      await client.query(
        `
        UPDATE workflow.templates
        SET graph_version = $2,
            graph_json = $3::jsonb,
            layout_revision = layout_revision + 1,
            updated_at = $4
        WHERE id = $1
      `,
        [
          input.workflowTemplateId,
          graphVersion,
          JSON.stringify(
            graphVersion === WORKFLOW_GRAPH_V2 ||
              graphVersion === WORKFLOW_GRAPH_V3
              ? graphVersion === WORKFLOW_GRAPH_V3
                ? {
                    ...graphDefinition,
                    version: WORKFLOW_GRAPH_V3,
                    distribution,
                  }
                : graphDefinition
              : {
                  version: "workflow-graph/v1",
                  controls: [],
                  edges: graphDefinition.edges,
                },
          ),
          timestamp,
        ],
      );
      await captureWorkflowTreePg(client, {
        organizationId: bundle.template.organizationId,
        workflowTemplateId: input.workflowTemplateId,
        validateOnly: true,
      });
    });
  } catch (error) {
    if (isPostgresErrorCode(error, "23503") && bundle.runCount) {
      throw workflowGraphHistoryConflictError();
    }
    throw error;
  }

  return getWorkflowTemplate(input.workflowTemplateId, input.organizationId);
}

/** Workflows and fixture campaigns that would block deleting this workflow. */
export async function getWorkflowReferences(
  workflowTemplateId: string,
  organizationId?: string | null,
): Promise<WorkflowReferences | null> {
  const scope = organizationScope(organizationId);
  const template = await pgOne<Row>(
    pg(),
    "SELECT id FROM workflow.templates WHERE id = $1 AND organization_id = $2",
    [workflowTemplateId, scope.organizationId],
  );
  if (!template) return null;
  const { callers, fixtureCampaignIds } = await readWorkflowReferences(
    pg(),
    scope,
    workflowTemplateId,
  );
  return { callers, fixtureCampaignIds };
}

export async function deleteWorkflowTemplate(
  workflowTemplateId: string,
  organizationId?: string | null,
) {
  const scope = organizationScope(organizationId);
  const bundle = await getWorkflowTemplate(
    workflowTemplateId,
    scope.organizationId,
  );
  if (!bundle) {
    throw new StudioNotFoundError(
      "workflow_not_found",
      "Workflow template not found.",
    );
  }

  await withPostgresTransaction(pg(), async (client) => {
    const runIds = await prepareWorkflowDeletion(
      client,
      scope,
      workflowTemplateId,
    );

    if (runIds.length) {
      await client.query(
        "DELETE FROM execution.workflow_task_dead_letters WHERE workflow_run_id = ANY($1::text[])",
        [runIds],
      );
      await client.query(
        `
        DELETE FROM execution.workflow_task_attempts
        WHERE workflow_task_id IN (
          SELECT id FROM execution.workflow_tasks WHERE workflow_run_id = ANY($1::text[])
        )
        `,
        [runIds],
      );
      await client.query(
        "DELETE FROM execution.execution_plan_shards WHERE execution_plan_id IN (SELECT id FROM execution.execution_plans WHERE workflow_run_id = ANY($1::text[]))",
        [runIds],
      );
      await client.query(
        "DELETE FROM execution.execution_plan_edges WHERE execution_plan_id IN (SELECT id FROM execution.execution_plans WHERE workflow_run_id = ANY($1::text[]))",
        [runIds],
      );
      await client.query(
        "DELETE FROM execution.execution_plan_nodes WHERE execution_plan_id IN (SELECT id FROM execution.execution_plans WHERE workflow_run_id = ANY($1::text[]))",
        [runIds],
      );
      await client.query(
        "DELETE FROM execution.execution_plans WHERE workflow_run_id = ANY($1::text[])",
        [runIds],
      );
      await client.query(
        "DELETE FROM execution.workflow_artifacts WHERE workflow_run_id = ANY($1::text[])",
        [runIds],
      );
      await client.query(
        "DELETE FROM execution.workflow_tasks WHERE workflow_run_id = ANY($1::text[])",
        [runIds],
      );
      await client.query(
        "DELETE FROM execution.workflow_runs WHERE id = ANY($1::text[])",
        [runIds],
      );
    }

    await client.query(
      "DELETE FROM workflow.edges WHERE workflow_template_id = $1",
      [workflowTemplateId],
    );
    await client.query(
      "DELETE FROM workflow.trigger_edges WHERE workflow_template_id = $1",
      [workflowTemplateId],
    );
    await client.query(
      "DELETE FROM workflow.triggers WHERE workflow_template_id = $1",
      [workflowTemplateId],
    );
    await client.query(
      "DELETE FROM workflow.decision_edges WHERE workflow_template_id = $1",
      [workflowTemplateId],
    );
    await client.query(
      "DELETE FROM workflow.decisions WHERE workflow_template_id = $1",
      [workflowTemplateId],
    );
    await client.query(
      "DELETE FROM workflow.steps WHERE workflow_template_id = $1",
      [workflowTemplateId],
    );
    await client.query(
      "DELETE FROM workflow.action_locks WHERE workflow_template_id = $1",
      [workflowTemplateId],
    );
    await client.query(
      "DELETE FROM workflow.plan_versions WHERE workflow_template_id = $1",
      [workflowTemplateId],
    );
    await client.query(
      "DELETE FROM workflow.templates WHERE id = $1 AND organization_id = $2",
      [workflowTemplateId, scope.organizationId],
    );
  });
}

export async function startWorkflowRun(
  workflowTemplateId: string,
  organizationId?: string | null,
  options: {
    triggerId?: string | null;
    triggerType?: string | null;
    triggerEvent?: Row | null;
    runtimeInput?: Row | null;
    initiatingPrincipalId?: string | null;
    mcpTokenId?: string | null;
  } = {},
) {
  const v3Launch = configuredV3LaunchGate();
  const bundle = await getWorkflowTemplate(workflowTemplateId, organizationId);
  if (!bundle) {
    throw new StudioNotFoundError(
      "workflow_not_found",
      "Workflow template not found.",
    );
  }
  if (bundle.template.legacyTransferTemplateId) {
    throw new StudioConflictError(
      "legacy_workflow_migration_required",
      "Legacy transfer workflows must be migrated before execution.",
    );
  }
  const trigger = resolveWorkflowRunTrigger(bundle.triggers, options);
  if (trigger.id && !trigger.enabled) {
    throw new StudioConflictError(
      "workflow_trigger_disabled",
      "Workflow trigger is disabled.",
    );
  }

  return withPostgresTransaction(pg(), async (client) => {
    const tree = await captureWorkflowTreePg(client, {
      admission: true,
      organizationId: bundle.template.organizationId,
      workflowTemplateId,
      v3Launch,
    });
    await assertWorkflowStudioRunnersAvailablePg(client, tree);
    return enqueueFrozenWorkflowRunPg(client, {
      definition: tree.root,
      definitions: tree.definitions,
      runtimeInput: jsonObjectOrEmpty(options.runtimeInput),
      trigger: trigger.type,
      triggerId: trigger.id,
      triggerEvent: jsonObjectOrEmpty(options.triggerEvent),
      executionContext: {
        organizationId: bundle.template.organizationId,
        projectId: tree.root.projectId,
        trigger: trigger.type,
        triggerId: trigger.id,
        initiatingPrincipalId: options.initiatingPrincipalId ?? null,
        mcpTokenId: options.mcpTokenId ?? null,
      },
      v3Launch,
    });
  });
}

const WEBHOOK_RATE_WINDOW_SECONDS = 60;
const WEBHOOK_RATE_DEFAULT_PER_MINUTE = 120;

/**
 * Records the delivery, and reports whether it may proceed.
 *
 * Two things ride on the same row. A webhook run costs credits and the trigger
 * token is the whole credential, so without a ceiling anyone holding the URL
 * has unlimited spend; and a signed delivery may not be replayed, which means
 * remembering signatures already spent. One statement prunes, inserts and
 * counts: an in-process counter would reset on restart and would not span the
 * API's replicas.
 *
 * Rows are retained for the signature window rather than the rate window,
 * because a replay is only refused while the row that proves it is still
 * there, and the signature window is the longer of the two.
 */
async function recordWebhookDelivery(
  triggerId: string,
  config: Row,
  signature: string | null,
) {
  const limit =
    boundedInt(
      config.rateLimitPerMinute,
      WEBHOOK_RATE_DEFAULT_PER_MINUTE,
      1,
      10_000,
    ) || WEBHOOK_RATE_DEFAULT_PER_MINUTE;
  const retention = Math.max(
    WEBHOOK_RATE_WINDOW_SECONDS,
    SIGNATURE_WINDOW_SECONDS,
  );
  let result: Row | null | undefined;
  try {
    result = await pgOne<Row>(
      pg(),
      `
    WITH pruned AS (
      DELETE FROM workflow.webhook_deliveries
      WHERE trigger_id = $1
        AND received_at < now() - ($2 || ' seconds')::interval
    ), recorded AS (
      INSERT INTO workflow.webhook_deliveries (id, trigger_id, signature)
      VALUES ($3, $1, $4)
      RETURNING trigger_id
    )
    SELECT count(*)::int AS deliveries
    FROM workflow.webhook_deliveries
    WHERE trigger_id = $1
      AND received_at >= now() - ($5 || ' seconds')::interval
    `,
      [
        triggerId,
        String(retention),
        id("whd"),
        signature,
        String(WEBHOOK_RATE_WINDOW_SECONDS),
      ],
    );
  } catch (error) {
    // The partial unique index on (trigger_id, signature) is what rejects a
    // replay. Losing the race is the same answer as losing the check.
    if (isUniqueViolation(error)) return "replayed" as const;
    throw error;
  }
  // The counting SELECT does not observe the sibling INSERT, so the row just
  // recorded is added here.
  const deliveries = Number(result?.deliveries ?? 0) + 1;
  return deliveries <= limit
    ? ("accepted" as const)
    : ("rate_limited" as const);
}

function isUniqueViolation(error: unknown) {
  return (error as { code?: string } | null)?.code === "23505";
}

function signatureMessage(reason: string) {
  if (reason === "missing") {
    return "This trigger requires X-Beam-Signature and X-Beam-Timestamp.";
  }
  if (reason === "stale") {
    return `The timestamp is outside the ${SIGNATURE_WINDOW_SECONDS} second window.`;
  }
  if (reason === "malformed") {
    return "X-Beam-Signature must be v1=<64 hex characters>.";
  }
  return "The signature does not match the request body.";
}

export async function startWorkflowWebhookRun(input: {
  workflowTemplateId: string;
  triggerId: string;
  token: string;
  payload?: Row | null;
  /** Optional client key; a repeat inside the window is dropped. */
  idempotencyKey?: string;
  /** Present only for a trigger that requires a body signature. */
  signatureHeader?: string;
  timestampHeader?: string;
  /** The body exactly as received; a reserialized one would not verify. */
  rawBody?: string;
  /**
   * Whether this deployment still serves the workflow's organization.
   *
   * A webhook token is a long-lived secret held by a third party, so it keeps
   * firing runs on the operator's workers long after the organization that
   * created it stopped being welcome here. Refusing looks exactly like an
   * unknown trigger, which is what a caller holding a stale token should see.
   */
  isOrganizationAdmitted?: (organizationId: string) => Promise<boolean>;
}) {
  const row = await pgOne<Row>(
    pg(),
    `
    SELECT t.*, w.organization_id, w.enabled AS workflow_enabled
    FROM workflow.triggers t
    INNER JOIN workflow.templates w ON w.id = t.workflow_template_id
    WHERE t.id = $1
      AND t.workflow_template_id = $2
      AND t.type = 'webhook'
      AND t.enabled = true
      AND w.enabled = true
    `,
    [input.triggerId, input.workflowTemplateId],
  );
  if (!row) {
    return null;
  }

  if (
    input.isOrganizationAdmitted &&
    !(await input.isOrganizationAdmitted(String(row.organization_id)))
  ) {
    return null;
  }

  const config = parsePayload(row.config_json);
  const token = decryptWebhookToken(String(config.token ?? ""));
  if (!secureTextEqual(token, input.token)) {
    return null;
  }

  // A signature failure answers 401 rather than the 404 a bad token gets. The
  // caller has already proven it holds the token, so there is nothing left to
  // conceal, and a customer wiring up HMAC needs to be told which part is
  // wrong.
  let signature: string | null = null;
  if (config.requireSignature === true) {
    const check = verifyWebhookSignature({
      secret: webhookSigningSecret(input.triggerId, token),
      signatureHeader: String(input.signatureHeader ?? ""),
      timestampHeader: String(input.timestampHeader ?? ""),
      rawBody: String(input.rawBody ?? ""),
    });
    if (!check.ok) {
      throw Object.assign(new Error(signatureMessage(check.reason)), {
        code: "webhook_signature_rejected",
        reason: check.reason,
        statusCode: 401,
        expose: true,
      });
    }
    signature = check.signature;
  }

  const delivery = await recordWebhookDelivery(
    input.triggerId,
    config,
    signature,
  );
  if (delivery === "replayed") {
    throw Object.assign(new Error("This delivery has already been used."), {
      code: "webhook_signature_rejected",
      reason: "replayed",
      statusCode: 401,
      expose: true,
    });
  }
  if (delivery === "rate_limited") {
    throw Object.assign(new Error("Too many webhook deliveries."), {
      code: "webhook_rate_limited",
      statusCode: 429,
      expose: true,
      retryAfterSeconds: WEBHOOK_RATE_WINDOW_SECONDS,
    });
  }

  const receivedAt = now();
  const payload = jsonObjectOrEmpty(input.payload);
  const organizationId = String(row.organization_id);
  const windowSeconds = Number(config.coalesceWindowSeconds ?? 0) || 0;
  const maxConcurrentRuns = Number(config.maxConcurrentRuns ?? 1) || 1;

  if (windowSeconds > 0) {
    return coalesceWebhookEvent({
      workflowTemplateId: input.workflowTemplateId,
      triggerId: input.triggerId,
      organizationId,
      payload,
      idempotencyKey: input.idempotencyKey ?? "",
      receivedAt,
      windowSeconds,
      maxConcurrentRuns,
    });
  }

  const triggerEvent = {
    receivedAt,
    triggerId: input.triggerId,
    type: "webhook",
  };
  const runId = await startWorkflowRun(
    input.workflowTemplateId,
    organizationId,
    {
      triggerId: input.triggerId,
      triggerEvent,
      runtimeInput: {
        ...payload,
        _trigger: triggerEvent,
      },
    },
  );
  return { runId, accepted: true as const, pending: 0 };
}

/**
 * Buffers a webhook event and starts at most one run per coalescing window.
 *
 * A Salesforce Record-Triggered Flow fires once per record, so a bulk update
 * arrives as a burst. Events accumulate in the trigger's state row; a run is
 * started only when the window since the first buffered event has elapsed, and
 * it carries every event collected so far.
 *
 * The whole read-modify-write is done under a row lock, because the burst is by
 * definition concurrent: without it two requests both see an empty buffer and
 * both start a run.
 */
async function coalesceWebhookEvent(input: {
  workflowTemplateId: string;
  triggerId: string;
  organizationId: string;
  payload: Row;
  idempotencyKey: string;
  receivedAt: string;
  windowSeconds: number;
  maxConcurrentRuns: number;
}): Promise<{ runId: string | null; accepted: true; pending: number }> {
  return withPostgresTransaction(pg(), async (client) => {
    const locked = await pgOne<Row>(
      client,
      `SELECT state_json FROM workflow.triggers WHERE id = $1 FOR UPDATE`,
      [input.triggerId],
    );
    const state = parsePayload(locked?.state_json);
    const buffered = Array.isArray(state.pending)
      ? (state.pending as Row[])
      : [];
    const seenKeys = Array.isArray(state.seenKeys)
      ? (state.seenKeys as string[])
      : [];

    // Salesforce retries, and a Flow can fire twice for one save. Dropping a
    // repeat is cheaper than de-duplicating records downstream.
    if (input.idempotencyKey && seenKeys.includes(input.idempotencyKey)) {
      return { runId: null, accepted: true as const, pending: buffered.length };
    }

    const pending = [
      ...buffered,
      { receivedAt: input.receivedAt, payload: input.payload },
    ];
    const firstAt = String(state.firstReceivedAt ?? input.receivedAt);
    const windowElapsedMs = Date.parse(input.receivedAt) - Date.parse(firstAt);
    const windowOpen = windowElapsedMs < input.windowSeconds * 1000;

    const activeRuns = await pgOne<Row>(
      client,
      `SELECT count(*)::int AS active
       FROM execution.workflow_runs
       WHERE trigger_id = $1
         AND status IN ('queued', 'running', 'cancel_requested')`,
      [input.triggerId],
    );
    const atCapacity =
      Number(activeRuns?.active ?? 0) >= input.maxConcurrentRuns;

    if (windowOpen || atCapacity) {
      await client.query(
        `UPDATE workflow.triggers
         SET state_json = $2::jsonb, updated_at = now()
         WHERE id = $1`,
        [
          input.triggerId,
          JSON.stringify({
            ...state,
            pending,
            firstReceivedAt: firstAt,
            // Bounded so the row cannot grow without limit under sustained load.
            seenKeys: [...seenKeys, input.idempotencyKey]
              .filter(Boolean)
              .slice(-500),
          }),
        ],
      );
      return { runId: null, accepted: true as const, pending: pending.length };
    }

    // Window elapsed and capacity available: flush everything into one run.
    await client.query(
      `UPDATE workflow.triggers
       SET state_json = $2::jsonb, updated_at = now()
       WHERE id = $1`,
      [
        input.triggerId,
        JSON.stringify({
          ...state,
          pending: [],
          firstReceivedAt: null,
          seenKeys: [...seenKeys, input.idempotencyKey]
            .filter(Boolean)
            .slice(-500),
        }),
      ],
    );

    const triggerEvent = {
      receivedAt: input.receivedAt,
      triggerId: input.triggerId,
      type: "webhook",
      coalesced: pending.length,
      firstReceivedAt: firstAt,
    };
    const runId = await startWorkflowRun(
      input.workflowTemplateId,
      input.organizationId,
      {
        triggerId: input.triggerId,
        triggerEvent,
        runtimeInput: {
          // The most recent payload stays at the top level so a workflow written
          // for a single event still reads correctly.
          ...input.payload,
          events: pending.map((entry) => entry.payload),
          _trigger: triggerEvent,
        },
      },
    );
    return { runId, accepted: true as const, pending: 0 };
  });
}

export async function cancelWorkflowRun(
  workflowRunId: string,
  organizationId?: string | null,
) {
  const bundle = await getWorkflowRun(workflowRunId, organizationId);
  if (!bundle) {
    return;
  }
  if (bundle.run.legacyRunId) {
    throw new StudioConflictError(
      "legacy_workflow_migration_required",
      "Legacy transfer workflows must be migrated before cancellation.",
    );
  }
  const timestamp = now();
  await withPostgresTransaction(pg(), async (client) => {
    await markWorkflowRunCancelledPg(client, workflowRunId, timestamp);
  });
}

export async function listWorkflowDynamicInstances(input: {
  workflowRunId: string;
  controlId: string;
  organizationId?: string | null;
  offset?: number;
  limit?: number;
}) {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 200);
  const offset = Math.max(Math.trunc(input.offset ?? 0), 0);
  const region = await pgOne<Row>(
    pg(),
    `
    SELECT region.*
    FROM execution.workflow_dynamic_regions region
    JOIN execution.workflow_runs run ON run.id = region.workflow_run_id
    JOIN workflow.templates template ON template.id = run.workflow_template_id
    WHERE region.workflow_run_id = $1 AND region.control_id = $2
      AND ($3 = '' OR template.organization_id = $3)
    `,
    [
      input.workflowRunId,
      input.controlId,
      organizationFilterValue(input.organizationId),
    ],
  );
  if (!region) return null;
  const rows = await pgMany<Row>(
    pg(),
    `
    SELECT *
    FROM execution.workflow_dynamic_instances
    WHERE dynamic_region_id = $1
    ORDER BY instance_index ASC, created_at ASC
    OFFSET $2 LIMIT $3
    `,
    [String(region.id), offset, limit],
  );
  return {
    region: workflowDynamicRegionRecord(region),
    instances: rows.map(workflowDynamicInstanceRecord),
    offset,
    limit,
    total: Number(region.instance_count ?? 0),
  };
}

export async function cancelWorkflowDynamicRegion(input: {
  workflowRunId: string;
  controlId: string;
  organizationId?: string | null;
  requestedBy?: string | null;
}) {
  const timestamp = now();
  return withPostgresTransaction(pg(), async (client) => {
    const region = await lockedWorkflowDynamicRegion(
      client,
      input.workflowRunId,
      input.controlId,
      input.organizationId,
    );
    if (!region)
      throw new StudioNotFoundError(
        "dynamic_region_not_found",
        "Dynamic workflow region not found.",
      );
    if (
      [
        "completed",
        "cancelled",
        "cancel_requested",
        "skipped",
        "not_reached",
      ].includes(String(region.status))
    ) {
      return workflowDynamicRegionRecord(region);
    }
    const children = await pgMany<Row>(
      client,
      `SELECT s.child_run_id
      FROM execution.workflow_step_runs s JOIN execution.workflow_dynamic_instances i ON i.id=s.dynamic_instance_id
      WHERE i.dynamic_region_id=$1 AND s.child_run_id IS NOT NULL`,
      [String(region.id)],
    );
    for (const child of children)
      await requestWorkflowCancellationPg(
        client,
        String(child.child_run_id),
        String(region.organization_id),
        "dynamic region cancellation requested",
      );
    await client.query(
      `UPDATE execution.executor_assignments a SET state='cancel_requested',cancel_requested_at=COALESCE(cancel_requested_at,now()),updated_at=now()
      FROM execution.workflow_step_runs s JOIN execution.workflow_dynamic_instances i ON i.id=s.dynamic_instance_id
      WHERE a.workflow_step_run_id=s.id AND i.dynamic_region_id=$1 AND a.cleanup_confirmed_at IS NULL`,
      [String(region.id)],
    );
    await client.query(
      `
      UPDATE execution.workflow_tasks task
      SET status = 'cancelled', error = COALESCE(task.error, 'dynamic region cancellation requested'),
          leased_by = NULL, locked_by = NULL, lease_expires_at = NULL,
          lock_expires_at = NULL, claim_token = NULL,
          completed_at = COALESCE(task.completed_at, $2), updated_at = $2
      FROM execution.workflow_step_runs step_run
      JOIN execution.workflow_dynamic_instances instance
        ON instance.id = step_run.dynamic_instance_id
      WHERE instance.dynamic_region_id = $1
        AND task.workflow_step_run_id = step_run.id
        AND task.status IN ('queued', 'leased', 'running', 'retry_scheduled')
        AND NOT EXISTS(SELECT 1 FROM execution.executor_assignments a WHERE a.task_id=task.id AND a.cleanup_confirmed_at IS NULL)
      `,
      [String(region.id), timestamp],
    );
    await client.query(
      `
      UPDATE execution.workflow_step_runs step_run
      SET status = 'cancelled', error = COALESCE(step_run.error, 'dynamic region cancellation requested'),
          completed_at = COALESCE(step_run.completed_at, $2), updated_at = $2
      FROM execution.workflow_dynamic_instances instance
      WHERE instance.dynamic_region_id = $1
        AND step_run.dynamic_instance_id = instance.id
        AND step_run.status IN ('queued', 'running')
        AND step_run.child_run_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM execution.executor_assignments a WHERE a.workflow_step_run_id=step_run.id AND a.cleanup_confirmed_at IS NULL)
      `,
      [String(region.id), timestamp],
    );
    await client.query(
      `UPDATE execution.workflow_dynamic_instances
       SET status = 'cancelled', error = COALESCE(error, 'dynamic region cancellation requested'),
           completed_at = COALESCE(completed_at, $2), updated_at = $2
       WHERE dynamic_region_id = $1
         AND status IN ('pending', 'queued', 'running')
         AND NOT EXISTS (SELECT 1 FROM execution.workflow_step_runs s WHERE s.dynamic_instance_id=execution.workflow_dynamic_instances.id AND s.status IN ('queued','running'))`,
      [String(region.id), timestamp],
    );
    const result = await client.query<Row>(
      `UPDATE execution.workflow_dynamic_regions
       SET status = 'cancel_requested', cancellation_requested_at = $2,
           requested_by = $3, error = COALESCE(error, 'dynamic region cancellation requested'),
           completed_at = NULL, updated_at = $2
       WHERE id = $1 RETURNING *`,
      [String(region.id), timestamp, input.requestedBy ?? null],
    );
    await appendWorkflowEventPg(client, {
      organizationId: String(region.organization_id),
      workflowTemplateId: String(region.workflow_template_id),
      workflowRunId: input.workflowRunId,
      eventType: "DynamicRegionCancellationRequested",
      payload: {
        controlId: input.controlId,
        requestedBy: input.requestedBy ?? null,
      },
    });
    return workflowDynamicRegionRecord(result.rows[0] ?? region);
  });
}

export async function retryWorkflowDynamicRegion(input: {
  authorizeExecution?: WorkflowExecutionAuthorizer;
  workflowRunId: string;
  controlId: string;
  organizationId?: string | null;
  requestedBy?: string | null;
}) {
  const timestamp = now();
  return withPostgresTransaction(pg(), async (client) => {
    const region = await lockedWorkflowDynamicRegion(
      client,
      input.workflowRunId,
      input.controlId,
      input.organizationId,
    );
    if (!region)
      throw new StudioNotFoundError(
        "dynamic_region_not_found",
        "Dynamic workflow region not found.",
      );
    if (region.historical)
      throw new StudioConflictError(
        "historical_run_not_retryable",
        "Historical workflow runs cannot be retried; run the current definition instead.",
      );
    if (!["failed", "cancelled"].includes(String(region.status))) {
      throw new StudioConflictError(
        "dynamic_region_not_retryable",
        "Only failed or cancelled dynamic regions can be retried.",
      );
    }
    await referenceFixtureGenerationsPg(client, input.workflowRunId, {
      snapshot: region.run_template_snapshot_json,
      input: region.run_input_json,
      steps: region.run_resolved_steps_json,
    });
    await (input.authorizeExecution ?? authorizeWorkflowExecutionPg)(client, {
      workflowRunId: input.workflowRunId,
      phase: "retry",
    });
    const retryInstances = await pgMany<Row>(
      client,
      `SELECT * FROM execution.workflow_dynamic_instances
       WHERE dynamic_region_id = $1
         AND status IN ('failed', 'cancelled', 'not_reached')
       ORDER BY instance_index ASC, created_at ASC`,
      [String(region.id)],
    );
    for (const instance of retryInstances) {
      const stepRun = await pgOne<Row>(
        client,
        `SELECT * FROM execution.workflow_step_runs
         WHERE dynamic_instance_id = $1 FOR UPDATE`,
        [String(instance.id)],
      );
      const task = stepRun
        ? await pgOne<Row>(
            client,
            `SELECT * FROM execution.workflow_tasks
             WHERE workflow_step_run_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
            [String(stepRun.id)],
          )
        : null;
      if (stepRun?.kind === "workflow" && stepRun.child_run_id) {
        const active = await pgOne<Row>(
          client,
          `WITH RECURSIVE descendants AS (
          SELECT id,status FROM execution.workflow_runs WHERE id=$1
          UNION ALL SELECT r.id,r.status FROM execution.workflow_runs r JOIN descendants d ON r.parent_run_id=d.id
        ) SELECT id FROM descendants WHERE status IN ('queued','running','cancel_requested') LIMIT 1`,
          [String(stepRun.child_run_id)],
        );
        if (active)
          throw new StudioConflictError(
            "descendant_cleanup_pending",
            "Wait for descendant cancellation and cleanup before retrying.",
          );
        await client.query(
          `UPDATE execution.workflow_step_runs SET status='queued',attempt=attempt+1,child_run_id=NULL,
          output_json='null',error=NULL,started_at=NULL,completed_at=NULL,updated_at=$2,
          metadata_json=metadata_json-'invocation'-'callTimedOut' WHERE id=$1`,
          [String(stepRun.id), timestamp],
        );
        await client.query(
          `UPDATE execution.workflow_dynamic_instances SET status='queued',current_attempt=current_attempt+1,
          output_json='null',error=NULL,completed_at=NULL,updated_at=$2 WHERE id=$1`,
          [String(instance.id), timestamp],
        );
      } else if (stepRun && task) {
        await client.query(
          `UPDATE execution.workflow_step_runs
           SET status = 'queued', attempt = attempt + 1, output_json = '{}'::jsonb,
               metadata_json = metadata_json || $2::jsonb, error = NULL,
               started_at = NULL, completed_at = NULL, updated_at = $3
           WHERE id = $1`,
          [
            String(stepRun.id),
            JSON.stringify({ retryRequestedBy: input.requestedBy ?? null }),
            timestamp,
          ],
        );
        await client.query(
          `UPDATE execution.workflow_tasks
           SET status = 'retry_scheduled', scheduled_at = $2,
               max_attempts = GREATEST(max_attempts, attempts + 1),
               error = NULL, completed_at = NULL, locked_by = NULL, leased_by = NULL,
               lock_expires_at = NULL, lease_expires_at = NULL, claim_token = NULL,
               updated_at = $2 WHERE id = $1`,
          [String(task.id), timestamp],
        );
        await client.query(
          `UPDATE execution.workflow_dynamic_instances
           SET status = 'queued', current_attempt = current_attempt + 1,
               output_json = '{}'::jsonb, error = NULL, completed_at = NULL,
               updated_at = $2 WHERE id = $1`,
          [String(instance.id), timestamp],
        );
      } else {
        if (stepRun) {
          await client.query(
            `DELETE FROM execution.workflow_step_runs WHERE id = $1`,
            [String(stepRun.id)],
          );
        }
        await client.query(
          `UPDATE execution.workflow_dynamic_instances
           SET status = 'pending', current_attempt = current_attempt + 1,
               input_json = '{}'::jsonb, output_json = '{}'::jsonb,
               metadata_json = metadata_json || $2::jsonb, error = NULL,
               started_at = NULL, completed_at = NULL, updated_at = $3
           WHERE id = $1`,
          [
            String(instance.id),
            JSON.stringify({ retryRequestedBy: input.requestedBy ?? null }),
            timestamp,
          ],
        );
      }
    }
    await client.query(
      `DELETE FROM execution.workflow_step_runs
       WHERE workflow_run_id = $1 AND dynamic_instance_id IS NULL
         AND status = 'not_reached'`,
      [input.workflowRunId],
    );
    await client.query(
      `UPDATE execution.workflow_runs
       SET status = 'running', error = NULL, completed_at = NULL, output_json='null',output_validation='unvalidated',updated_at = $2
       WHERE id = $1 AND status IN ('failed', 'cancelled', 'running')`,
      [input.workflowRunId, timestamp],
    );
    const result = await client.query<Row>(
      `UPDATE execution.workflow_dynamic_regions
       SET status = 'running', failed_count = 0, cancelled_count = 0,
           retry_requested_at = $2, requested_by = $3, error = NULL,cancellation_requested_at=NULL,
           completed_at = NULL, updated_at = $2
       WHERE id = $1 RETURNING *`,
      [String(region.id), timestamp, input.requestedBy ?? null],
    );
    await appendWorkflowEventPg(client, {
      organizationId: String(region.organization_id),
      workflowTemplateId: String(region.workflow_template_id),
      workflowRunId: input.workflowRunId,
      eventType: "DynamicRegionRetryRequested",
      payload: {
        controlId: input.controlId,
        instanceCount: retryInstances.length,
        requestedBy: input.requestedBy ?? null,
      },
    });
    return workflowDynamicRegionRecord(result.rows[0] ?? region);
  });
}

async function lockedWorkflowDynamicRegion(
  client: PgClient,
  workflowRunId: string,
  controlId: string,
  organizationId?: string | null,
) {
  return pgOne<Row>(
    client,
    `
    SELECT region.*, run.organization_id, run.workflow_template_id, run.historical,
      run.template_snapshot_json AS run_template_snapshot_json,
      run.input_json AS run_input_json, run.resolved_steps_json AS run_resolved_steps_json
    FROM execution.workflow_dynamic_regions region
    JOIN execution.workflow_runs run ON run.id = region.workflow_run_id
    JOIN workflow.templates template ON template.id = run.workflow_template_id
    WHERE region.workflow_run_id = $1 AND region.control_id = $2
      AND ($3 = '' OR template.organization_id = $3)
    FOR UPDATE OF region, run
    `,
    [workflowRunId, controlId, organizationFilterValue(organizationId)],
  );
}

async function markWorkflowRunCancelledPg(
  client: PgClient,
  workflowRunId: string,
  _timestamp: string,
  error = "cancellation requested",
) {
  const run = await pgOne<Row>(
    client,
    "SELECT organization_id FROM execution.workflow_runs WHERE id=$1",
    [workflowRunId],
  );
  if (run)
    await requestWorkflowCancellationPg(
      client,
      workflowRunId,
      String(run.organization_id),
      error,
    );
}

export async function retryWorkflowRun(
  workflowRunId: string,
  organizationId?: string | null,
  options: {
    authorizeExecution?: WorkflowExecutionAuthorizer;
  } = {},
) {
  const bundle = await getWorkflowRun(workflowRunId, organizationId);
  if (!bundle)
    throw new StudioNotFoundError(
      "workflow_run_not_found",
      "Workflow run not found.",
    );
  return withPostgresTransaction(pg(), (client) =>
    retryFrozenWorkflowRunPg(client, {
      workflowRunId,
      organizationId: bundle.run.organizationId,
      authorizeExecution: options.authorizeExecution,
    }),
  );
}

function stringValue(value: unknown) {
  return String(value ?? "").trim();
}
function nonEmptyText(value: unknown, label: string) {
  const result = stringValue(value);
  if (!result) throw new Error(`${label} is required.`);
  return result;
}

function resolveWorkflowRunTrigger(
  triggers: WorkflowTriggerRecord[],
  options: {
    triggerId?: string | null;
    triggerType?: string | null;
  },
) {
  const triggerById = options.triggerId
    ? triggers.find((trigger) => trigger.id === options.triggerId)
    : null;
  if (triggerById) {
    return triggerById;
  }

  const requestedType = options.triggerType
    ? workflowTriggerType(options.triggerType)
    : "manual";
  const triggerByType = triggers.find(
    (trigger) => trigger.type === requestedType,
  );
  if (triggerByType) {
    return triggerByType;
  }

  const fallback = triggers.find((trigger) => trigger.type === "manual");
  if (fallback) {
    return fallback;
  }

  throw new Error("Workflow has no trigger.");
}

function roomContextJson(value: unknown) {
  const room = workflowRoomContext(value);
  return room ? JSON.stringify(room) : null;
}

function workflowTemplateRecord(row: Row): WorkflowTemplateRecord {
  const graphVersion = workflowGraphVersion(row.graph_version);
  return {
    room: workflowRoomContext(row.room_context_json),
    failurePolicy: workflowFailurePolicy(
      parsePayload(row.config_json).failurePolicy,
    ),
    inputSchema: row.input_schema_json as WorkflowJsonSchema,
    output: row.output_contract_json as WorkflowOutputContract,
    agentBindings: parsePayload(row.agent_bindings_json),
    resourceBindings: parsePayload(row.resource_bindings_json),
    id: String(row.id),
    organizationId: String(row.organization_id ?? LOCAL_ORGANIZATION_ID),
    projectId: row.project_id ? String(row.project_id) : null,
    legacyTransferTemplateId: null,
    legacyTransferName: row.legacy_transfer_name
      ? String(row.legacy_transfer_name)
      : null,
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    apiKeyId: row.api_key_id ? String(row.api_key_id) : null,
    graphVersion,
    graph: parsePayload(row.graph_json),
    enabled: Number(row.enabled ?? 1) === 1,
    stepCount: Number(row.step_count ?? 0),
    runCount: Number(row.run_count ?? 0),
    lastRunStatus: row.last_run_status ? String(row.last_run_status) : null,
    scheduled: row.scheduled === true || Number(row.scheduled) === 1,
    nextRunAt: row.next_run_at ? timestampText(row.next_run_at) : null,
    createdAt: timestampText(row.created_at),
    updatedAt: timestampText(row.updated_at),
  };
}

function workflowFailurePolicy(
  value: unknown,
): "stop_on_failure" | "continue_on_failure" {
  if (value === undefined || value === "stop_on_failure")
    return "stop_on_failure";
  if (value === "continue_on_failure") return value;
  throw new StudioValidationError(
    "workflow_failure_policy_invalid",
    "Workflow failurePolicy must be stop_on_failure or continue_on_failure.",
    {
      field: "failurePolicy",
      acceptedValues: ["stop_on_failure", "continue_on_failure"],
    },
  );
}

function workflowGraphVersion(
  value: unknown,
  controls?: unknown[],
  decisions?: unknown[],
): "workflow-graph/v1" | "workflow-graph/v2" | "workflow-graph/v3" {
  // Decisions are resolved only by the dynamic graph orchestrator, so a graph
  // that contains one must be at least v2. Leaving it v1 would route the run through the
  // static path, which would ignore the decision entirely.
  if (value === WORKFLOW_GRAPH_V3) return WORKFLOW_GRAPH_V3;
  if (
    value === WORKFLOW_GRAPH_V2 ||
    (controls?.length ?? 0) > 0 ||
    (decisions?.length ?? 0) > 0
  ) {
    return WORKFLOW_GRAPH_V2;
  }
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    value === "workflow-graph/v1"
  ) {
    return "workflow-graph/v1";
  }
  throw graphValidationError(
    `Unsupported workflow graph version "${String(value)}".`,
  );
}

function workflowGraphFromTemplateRecord(
  template: WorkflowTemplateRecord,
  persistedEdges: WorkflowEdgeRecord[],
) {
  if (
    template.graphVersion === WORKFLOW_GRAPH_V2 ||
    template.graphVersion === WORKFLOW_GRAPH_V3
  ) {
    const rawEdges = Array.isArray(template.graph.edges)
      ? template.graph.edges
      : [];
    const rawControls = Array.isArray(template.graph.controls)
      ? template.graph.controls
      : [];
    return {
      version: template.graphVersion,
      controls: sanitizeWorkflowGraphControls(
        rawControls,
        template.graphVersion === WORKFLOW_GRAPH_V3,
      ),
      edges: sanitizeWorkflowGraphDefinitionEdges(rawEdges),
      ...(template.graphVersion === WORKFLOW_GRAPH_V3
        ? {
            distribution: template.graph
              .distribution as WorkflowGraphV3Distribution,
          }
        : {}),
    };
  }
  return {
    version: "workflow-graph/v1" as const,
    controls: [] as WorkflowGraphV2Control[],
    edges: persistedEdges.map((edge) => ({
      id: edge.id,
      from: edge.fromStepId,
      to: edge.toStepId,
      condition: edge.condition as ActionJson,
    })),
  };
}

export function sanitizeWorkflowGraphControls(values: unknown[], v3 = false) {
  return values.map((value, index): WorkflowGraphV2Control => {
    const control = jsonObject(value, `control ${index + 1}`);
    const kind = String(control.kind ?? "");
    const bodyValue = jsonObject(control.body, `control ${index + 1} body`);
    const body = {
      stepIds: stringArray(bodyValue.stepIds, "control body stepIds"),
      entryStepId: textId(bodyValue.entryStepId, "control body entry step"),
      outputStepId: textId(bodyValue.outputStepId, "control body output step"),
      edges: sanitizeWorkflowGraphDefinitionEdges(
        Array.isArray(bodyValue.edges) ? bodyValue.edges : [],
      ),
    };
    const layoutValue =
      control.layout && typeof control.layout === "object"
        ? jsonObject(control.layout, "control layout")
        : null;
    const layout = layoutValue
      ? {
          x: requiredFiniteNumber(layoutValue.x, "control layout x"),
          y: requiredFiniteNumber(layoutValue.y, "control layout y"),
          ...(finiteNumberOrNull(layoutValue.width) !== null
            ? { width: finiteNumberOrNull(layoutValue.width)! }
            : {}),
          ...(finiteNumberOrNull(layoutValue.height) !== null
            ? { height: finiteNumberOrNull(layoutValue.height)! }
            : {}),
          ...(finiteNumberOrNull(layoutValue.fanInX) !== null
            ? { fanInX: finiteNumberOrNull(layoutValue.fanInX)! }
            : {}),
          ...(finiteNumberOrNull(layoutValue.fanInY) !== null
            ? { fanInY: finiteNumberOrNull(layoutValue.fanInY)! }
            : {}),
        }
      : undefined;

    if (kind === "loop") {
      return {
        id: textId(control.id, "loop control"),
        kind,
        iterations: actionJsonValue(control.iterations, "loop iterations"),
        outputMode: control.outputMode === "last" ? "last" : "all",
        ...(layout ? { layout } : {}),
        body,
        ...(v3
          ? {
              initial: actionJsonValue(
                control.initial,
                "V3 loop initial routes",
              ),
              carry: actionJsonValue(control.carry, "V3 loop carry routes"),
              ...(control.stop === undefined
                ? {}
                : {
                    stop: actionJsonValue(control.stop, "V3 loop stop"),
                  }),
            }
          : {}),
      };
    }
    if (kind === "fan-out") {
      const concurrency = finiteNumberOrNull(control.concurrency);
      return {
        id: textId(control.id, "fan-out control"),
        kind,
        items: actionJsonValue(control.items, "fan-out items"),
        ...(concurrency !== null ? { concurrency } : {}),
        fanInId: textId(control.fanInId, "fan-in control"),
        ...(layout ? { layout } : {}),
        body,
      };
    }
    throw graphValidationError(
      `Control ${index + 1} has unsupported kind "${kind}".`,
    );
  });
}

function sanitizeWorkflowGraphDefinitionEdges(values: unknown[]) {
  return values.map((value, index) => {
    const edge = jsonObject(value, `graph edge ${index + 1}`);
    return {
      ...(edge.id ? { id: textId(edge.id, "graph edge") } : {}),
      from: textId(
        edge.from ?? edge.fromStepId,
        `graph edge ${index + 1} source`,
      ),
      to: textId(edge.to ?? edge.toStepId, `graph edge ${index + 1} target`),
      ...(edge.condition !== undefined
        ? {
            condition: actionJsonValue(
              edge.condition,
              `graph edge ${index + 1} condition`,
            ),
          }
        : {}),
    };
  });
}

function actionJsonValue(value: unknown, label: string): ActionJson {
  if (value === undefined) {
    throw graphValidationError(`${label} is required.`);
  }
  try {
    return JSON.parse(JSON.stringify(value)) as ActionJson;
  } catch {
    throw graphValidationError(`${label} must be JSON serializable.`);
  }
}

function stringArray(value: unknown, label: string) {
  if (!Array.isArray(value)) {
    throw graphValidationError(`${label} must be an array.`);
  }
  return value.map((entry) => textId(entry, label));
}

function requiredFiniteNumber(value: unknown, label: string) {
  const parsed = finiteNumberOrNull(value);
  if (parsed === null) {
    throw graphValidationError(`${label} must be a finite number.`);
  }
  return parsed;
}

function workflowStepRecord(row: Row): WorkflowStepRecord {
  return {
    kind: row.kind === "workflow" ? "workflow" : "action",
    calledWorkflowId: row.called_workflow_id
      ? String(row.called_workflow_id)
      : null,
    id: String(row.id),
    workflowTemplateId: String(row.workflow_template_id),
    name: row.name == null ? null : String(row.name),
    actionPackageName:
      row.action_package_name == null ? "" : String(row.action_package_name),
    actionVersionRange: String(row.action_version_range ?? "*"),
    position: Number(row.position ?? 0),
    enabled: Number(row.enabled ?? 1) === 1,
    config: parsePayload(row.config_json),
    inputBindings: parsePayload(row.input_bindings_json),
    executionTarget:
      row.kind === "workflow"
        ? undefined
        : actionExecutionTargetSchema.parse(
            row.execution_target_json ?? { kind: "studio" },
          ),
    placement: String(row.placement ?? "local-workers"),
    executionLocationId: row.execution_location_id
      ? String(row.execution_location_id)
      : null,
    canvasX: nullableNumber(row.canvas_x),
    canvasY: nullableNumber(row.canvas_y),
    timeoutSeconds: nullableNumber(row.timeout_seconds),
    required: Number(row.required ?? 1) === 1,
    manifest: row.manifest_json ? parsePayload(row.manifest_json) : null,
    createdAt: timestampText(row.created_at),
    updatedAt: timestampText(row.updated_at),
  };
}

function workflowActionLockRecord(row: Row): WorkflowActionLockRecord {
  return {
    id: String(row.id),
    workflowTemplateId: String(row.workflow_template_id),
    actionPackageName:
      row.action_package_name == null ? "" : String(row.action_package_name),
    versionRange: String(row.version_range),
    resolvedVersion: String(row.resolved_version),
    packageVersionId: row.package_version_id
      ? String(row.package_version_id)
      : null,
    manifestChecksum: String(row.checksum),
    artifactChecksum: row.artifact_checksum
      ? String(row.artifact_checksum)
      : null,
    artifactReference: row.artifact_reference
      ? String(row.artifact_reference)
      : null,
    sourceRegistry: String(row.source_registry),
    trustLevel: row.trust_level ? String(row.trust_level) : null,
    createdAt: timestampText(row.created_at),
  };
}

function workflowEdgeRecord(row: Row): WorkflowEdgeRecord {
  return {
    id: String(row.id),
    workflowTemplateId: String(row.workflow_template_id),
    fromStepId: String(row.from_step_id),
    toStepId: String(row.to_step_id),
    // Compare against null explicitly: a stored `false` is falsy, and treating
    // it as absent turns an always-false edge into an unconditional one.
    condition:
      row.condition_json == null ? null : parseJsonValue(row.condition_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function workflowTriggerRecord(row: Row): WorkflowTriggerRecord {
  const type = workflowTriggerType(row.type);
  return {
    id: String(row.id),
    workflowTemplateId: String(row.workflow_template_id),
    type,
    name:
      row.name?.toString() ||
      (type === "schedule" ? "On a schedule" : "Trigger manually"),
    enabled: Number(row.enabled ?? 1) === 1 || row.enabled === true,
    config: triggerConfigForRead(
      type,
      String(row.id),
      sanitizeWorkflowTriggerConfig(type, parsePayload(row.config_json)),
    ),
    state: parsePayload(row.state_json),
    canvasX: nullableNumber(row.canvas_x),
    canvasY: nullableNumber(row.canvas_y),
    createdAt: timestampText(row.created_at),
    updatedAt: timestampText(row.updated_at),
  };
}

function workflowTriggerEdgeRecord(row: Row): WorkflowTriggerEdgeRecord {
  return {
    id: String(row.id),
    workflowTemplateId: String(row.workflow_template_id),
    triggerId: String(row.trigger_id),
    toStepId: String(row.to_step_id),
    // Compare against null explicitly: a stored `false` is falsy, and treating
    // it as absent turns an always-false edge into an unconditional one.
    condition:
      row.condition_json == null ? null : parseJsonValue(row.condition_json),
    createdAt: timestampText(row.created_at),
    updatedAt: timestampText(row.updated_at),
  };
}

function workflowDecisionEvaluationRecord(row: Row) {
  const handled = row.handled_failures;
  return {
    id: String(row.id),
    workflowRunId: String(row.workflow_run_id),
    decisionId: String(row.decision_id),
    scopeKey: String(row.scope_key ?? "root"),
    joinMode: String(row.join_mode),
    decisionKind: String(row.decision_kind ?? "if"),
    evaluated: row.evaluated === true,
    result: row.result == null ? null : row.result === true,
    takenBranch: row.taken_branch == null ? null : String(row.taken_branch),
    handledFailures: Array.isArray(handled)
      ? handled.map(String)
      : typeof handled === "string"
        ? ((parseJsonValue(handled) as string[] | null) ?? [])
        : [],
    reason: String(row.reason),
    createdAt: timestampText(row.created_at),
  };
}

function workflowDecisionRecord(row: Row): WorkflowDecisionRecord {
  return {
    id: String(row.id),
    workflowTemplateId: String(row.workflow_template_id),
    name: String(row.name),
    kind: String(row.kind ?? "if") === "switch" ? "switch" : "if",
    enabled: row.enabled !== false,
    joinMode: String(row.join_mode) as WorkflowDecisionRecord["joinMode"],
    handleFailure: row.handle_failure === true,
    config: parsePayload(row.config_json),
    canvasX: finiteNumberOrNull(row.canvas_x),
    canvasY: finiteNumberOrNull(row.canvas_y),
    createdAt: timestampText(row.created_at),
    updatedAt: timestampText(row.updated_at),
  };
}

function workflowDecisionEdgeRecord(row: Row): WorkflowDecisionEdgeRecord {
  return {
    id: String(row.id),
    workflowTemplateId: String(row.workflow_template_id),
    fromStepId: row.from_step_id == null ? null : String(row.from_step_id),
    fromDecisionId:
      row.from_decision_id == null ? null : String(row.from_decision_id),
    toStepId: row.to_step_id == null ? null : String(row.to_step_id),
    toDecisionId:
      row.to_decision_id == null ? null : String(row.to_decision_id),
    branch:
      row.branch == null
        ? null
        : (String(row.branch) as WorkflowDecisionEdgeRecord["branch"]),
    createdAt: timestampText(row.created_at),
    updatedAt: timestampText(row.updated_at),
  };
}

function executionLocationRecord(row: Row): ExecutionLocationRecord {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id ?? LOCAL_ORGANIZATION_ID),
    name: String(row.name),
    kind: String(row.kind),
    endpointUrl: row.endpoint_url ? String(row.endpoint_url) : null,
    enabled: Number(row.enabled ?? 1) === 1,
    allowInsecureHttp: Number(row.allow_insecure_http ?? 0) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function registryCategoryRecord(row: Row): RegistryCategoryRecord {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    packageCount: Number(row.package_count ?? 0),
  };
}

function registryPackageRecord(row: Row): RegistryPackageRecord {
  const manifest = parsePayload(row.latest_manifest_json);
  const catalog = parsePayload(manifest.catalog);
  const runtime = parsePayload(manifest.runtime);
  const execution = parsePayload(manifest.execution);
  const packageMetadata = parsePayload(row.metadata_json);
  const latestProvenance = parsePayload(row.latest_provenance_json);
  const latestAdvisories = registryAdvisoryRecords(
    latestProvenance.advisories ?? packageMetadata.advisories,
  );
  const versions = safeJsonParse(String(row.versions_json ?? "[]"));
  const sourceRegistry = String(
    latestProvenance.source ?? packageMetadata.source ?? "local-registry",
  );
  return {
    id: String(row.id),
    packageName: String(row.package_name),
    scope: String(row.scope_name),
    name: String(row.name),
    displayName: String(row.display_name),
    description: row.description ? String(row.description) : null,
    category: row.category_name ? String(row.category_name) : null,
    categorySlug: row.category_slug ? String(row.category_slug) : null,
    visibility: String(row.visibility),
    status: String(row.status),
    trustLevel: String(row.trust_level),
    latestVersion: row.latest_version_resolved
      ? String(row.latest_version_resolved)
      : row.latest_version
        ? String(row.latest_version)
        : null,
    versionCount: Number(row.version_count ?? 0),
    latestValidationStatus: row.latest_validation_status
      ? String(row.latest_validation_status)
      : null,
    latestVersionStatus: row.latest_version_status
      ? String(row.latest_version_status)
      : null,
    latestManifestChecksum: row.latest_manifest_checksum
      ? String(row.latest_manifest_checksum)
      : null,
    latestArtifactChecksum: row.latest_artifact_checksum
      ? String(row.latest_artifact_checksum)
      : null,
    latestArtifactReference: actionArtifactReference({
      artifactChecksum: row.latest_artifact_checksum,
      hippiusBucket: row.latest_hippius_bucket,
      hippiusKey: row.latest_hippius_key,
      packageName: row.package_name,
      provenance: latestProvenance,
      sourceRegistry,
      version: row.latest_version_resolved ?? row.latest_version,
    }),
    latestSourceRegistry: sourceRegistry,
    latestHippiusBucket: row.latest_hippius_bucket
      ? String(row.latest_hippius_bucket)
      : null,
    latestHippiusKey: row.latest_hippius_key
      ? String(row.latest_hippius_key)
      : null,
    latestManifest: manifest,
    versions: Array.isArray(versions)
      ? versions.map((item): RegistryPackageVersionRecord => {
          const version = parsePayload(item);
          const provenance = parsePayload(version.provenance);
          const advisories = registryAdvisoryRecords(provenance.advisories);
          const versionSource = String(
            provenance.source ?? packageMetadata.source ?? "local-registry",
          );
          return {
            version: String(version.version),
            manifest: parsePayload(version.manifest),
            manifestChecksum: version.manifestChecksum
              ? String(version.manifestChecksum)
              : null,
            artifactChecksum: version.artifactChecksum
              ? String(version.artifactChecksum)
              : null,
            artifactSizeBytes: Number(version.artifactSizeBytes ?? 0),
            artifactReference: actionArtifactReference({
              artifactChecksum: version.artifactChecksum,
              hippiusBucket: version.hippiusBucket,
              hippiusKey: version.hippiusKey,
              packageName: row.package_name,
              provenance,
              sourceRegistry: versionSource,
              version: version.version,
            }),
            sourceRegistry: versionSource,
            trustLevel: String(
              provenance.registryTrustLevel ?? row.trust_level ?? "external",
            ),
            validationStatus: version.validationStatus
              ? String(version.validationStatus)
              : null,
            status: String(version.status ?? "active"),
            publishedAt: version.publishedAt
              ? timestampText(version.publishedAt)
              : null,
            advisories,
            vulnerable:
              Boolean(provenance.vulnerable) ||
              advisories.some(registryAdvisoryIsActive),
          };
        })
      : [],
    permissions: jsonStringArray(manifest.permissions),
    placements: jsonStringArray(
      execution.supportedPlacements ?? runtime.placements,
    ),
    tags: jsonStringArray(catalog.tags),
    advisories: latestAdvisories,
    vulnerable:
      Boolean(latestProvenance.vulnerable) ||
      latestAdvisories.some(registryAdvisoryIsActive),
    updatedAt: timestampText(row.updated_at),
  };
}

function registryAdvisoryRecords(value: unknown): RegistryAdvisory[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry, index) => {
    const advisory = parsePayload(entry);
    const severityValue = String(advisory.severity ?? "unknown").toLowerCase();
    const severity: RegistryAdvisory["severity"] =
      severityValue === "low" ||
      severityValue === "moderate" ||
      severityValue === "high" ||
      severityValue === "critical"
        ? severityValue
        : "unknown";
    return {
      id: String(advisory.id ?? `registry-advisory-${index + 1}`),
      title: String(advisory.title ?? advisory.summary ?? "Security advisory"),
      severity,
      status: String(advisory.status ?? "active"),
      summary: advisory.summary ? String(advisory.summary) : null,
      url: advisory.url ? String(advisory.url) : null,
      affectedVersions: jsonStringArray(advisory.affectedVersions),
      patchedVersions: jsonStringArray(advisory.patchedVersions),
      cves: jsonStringArray(advisory.cves),
      blocking: Boolean(advisory.blocking),
    };
  });
}

function registryAdvisoryIsActive(advisory: RegistryAdvisory) {
  return !["resolved", "withdrawn", "dismissed"].includes(advisory.status);
}

function actionArtifactReference(input: {
  artifactChecksum: unknown;
  hippiusBucket: unknown;
  hippiusKey: unknown;
  packageName: unknown;
  provenance: Row;
  sourceRegistry: string;
  version: unknown;
}) {
  const registryReference =
    input.provenance.artifactReference ?? input.provenance.registryArtifactUrl;
  if (registryReference) {
    return String(registryReference);
  }
  if (input.hippiusBucket && input.hippiusKey) {
    return `s3://${String(input.hippiusBucket)}/${String(input.hippiusKey).replace(/^\/+/, "")}`;
  }
  if (!input.packageName || !input.version || !input.artifactChecksum) {
    return null;
  }
  return `${input.sourceRegistry}:${String(input.packageName)}@${String(input.version)}#${String(input.artifactChecksum)}`;
}

function workflowRunRecord(row: Row): WorkflowRunRecord {
  return {
    room: workflowRoomContext(parsePayload(row.execution_context_json).room),
    organizationId: String(row.organization_id),
    parentRunId: row.parent_run_id ? String(row.parent_run_id) : null,
    rootRunId: row.root_run_id ? String(row.root_run_id) : null,
    output:
      row.status === "completed" && row.output_validation === "valid"
        ? row.output_json
        : null,
    outputValidation: String(row.output_validation),
    historical: row.historical === true,
    historicalSnapshot: row.historical
      ? parsePayload(row.historical_snapshot_json)
      : null,
    definitionRevisionId: row.workflow_plan_version_id
      ? String(row.workflow_plan_version_id)
      : null,
    id: String(row.id),
    workflowTemplateId: String(row.workflow_template_id),
    workflowName: row.workflow_name ? String(row.workflow_name) : null,
    legacyRunId: null,
    status: String(row.status),
    trigger: String(row.trigger ?? "manual"),
    triggerId: row.trigger_id ? String(row.trigger_id) : null,
    triggerType: row.trigger_type ? String(row.trigger_type) : null,
    triggerEvent: parsePayload(row.trigger_event_json),
    error: row.error ? String(row.error) : null,
    queuedAt: row.queued_at ? timestampText(row.queued_at) : null,
    startedAt: row.started_at ? timestampText(row.started_at) : null,
    completedAt: row.completed_at ? timestampText(row.completed_at) : null,
    createdAt: timestampText(row.created_at),
    updatedAt: timestampText(row.updated_at),
  };
}

function workflowDynamicRegionRecord(row: Row): WorkflowDynamicRegionRecord {
  return {
    id: String(row.id),
    workflowRunId: String(row.workflow_run_id),
    controlId: String(row.control_id),
    controlPath: String(row.control_path),
    kind: String(row.kind),
    status: String(row.status),
    instanceCount: Number(row.instance_count ?? 0),
    completedCount: Number(row.completed_count ?? 0),
    pendingCount: Number(row.pending_count ?? 0),
    runningCount: Number(row.running_count ?? 0),
    failedCount: Number(row.failed_count ?? 0),
    cancelledCount: Number(row.cancelled_count ?? 0),
    concurrencyLimit: nullableNumber(row.concurrency_limit),
    output: parsePayload(row.output_json),
    error: row.error ? String(row.error) : null,
    createdAt: timestampText(row.created_at),
    updatedAt: timestampText(row.updated_at),
  };
}

function workflowDynamicInstanceRecord(
  row: Row,
): WorkflowDynamicInstanceRecord {
  return {
    id: String(row.id),
    dynamicRegionId: String(row.dynamic_region_id),
    workflowStepId: String(row.workflow_step_id),
    controlPath: String(row.control_path),
    instanceIndex: Number(row.instance_index ?? 0),
    status: String(row.status),
    currentAttempt: Number(row.current_attempt ?? 1),
    context: parsePayload(row.context_json),
    input: parsePayload(row.input_json),
    output: parsePayload(row.output_json),
    error: row.error ? String(row.error) : null,
    startedAt: row.started_at ? timestampText(row.started_at) : null,
    completedAt: row.completed_at ? timestampText(row.completed_at) : null,
  };
}

function workflowConditionEvaluationRecord(row: Row) {
  return {
    id: String(row.id),
    workflowRunId: String(row.workflow_run_id),
    dynamicRegionId: row.dynamic_region_id
      ? String(row.dynamic_region_id)
      : null,
    dynamicInstanceId: row.dynamic_instance_id
      ? String(row.dynamic_instance_id)
      : null,
    scopeKey: String(row.scope_key),
    edgeId: String(row.edge_id),
    fromNodeId: String(row.from_node_id),
    toNodeId: String(row.to_node_id),
    outcome: String(row.outcome),
    result: typeof row.result === "boolean" ? row.result : null,
    reason: String(row.reason),
    summary: parsePayload(row.summary_json),
    createdAt: timestampText(row.created_at),
  };
}

function workflowStepRunRecord(row: Row): WorkflowStepRunRecord {
  const metadata = {
    ...parsePayload(row.metadata_json),
    executorAssignments: row.executor_assignments ?? [],
  };
  return {
    kind: row.kind === "workflow" ? "workflow" : "action",
    childRunId: row.child_run_id ? String(row.child_run_id) : null,
    id: String(row.id),
    workflowRunId: String(row.workflow_run_id),
    workflowStepId: String(row.workflow_step_id),
    actionPackageName:
      row.action_package_name == null ? "" : String(row.action_package_name),
    resolvedVersion: String(row.resolved_version),
    checksum: String(row.checksum),
    sourceRegistry: String(row.source_registry),
    resolvedPlacement: String(row.resolved_placement),
    executionLocationId: row.execution_location_id
      ? String(row.execution_location_id)
      : null,
    status: String(row.status),
    attempt: Number(row.attempt ?? 1),
    input: parsePayload(row.input_json),
    output: row.output_json as ActionJson,
    metadata,
    progress: workflowStepProgress(metadata),
    shardErrors: workflowShardErrors(metadata),
    state: parsePayload(row.state_json),
    externalRef: row.external_ref ? String(row.external_ref) : null,
    error: row.error ? String(row.error) : null,
    startedAt: row.started_at ? timestampText(row.started_at) : null,
    completedAt: row.completed_at ? timestampText(row.completed_at) : null,
    createdAt: timestampText(row.created_at),
    updatedAt: timestampText(row.updated_at),
  };
}

function workflowStepProgress(metadata: Row) {
  const value = metadata.distributedProgress;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const progress = value as Row;
  return {
    total: Number(progress.total ?? 0),
    completed: Number(progress.completed ?? 0),
    running: Number(progress.running ?? 0),
    failed: Number(progress.failed ?? 0),
    percent: Number(progress.progress ?? 0),
  };
}

function workflowShardErrors(metadata: Row) {
  return Array.isArray(metadata.shardErrors)
    ? metadata.shardErrors.map(String).filter(Boolean)
    : [];
}

function workflowArtifactRecord(row: Row): WorkflowArtifactRecord {
  return {
    id: String(row.id),
    workflowRunId: String(row.workflow_run_id),
    workflowStepRunId: row.workflow_step_run_id
      ? String(row.workflow_step_run_id)
      : null,
    type: String(row.type),
    name: String(row.name),
    uri: String(row.uri),
    mediaType: row.media_type ? String(row.media_type) : null,
    metadata: parsePayload(row.metadata_json),
    createdAt: timestampText(row.created_at),
  };
}

function parseEditableJson(value: string, label: string) {
  try {
    const parsed = value.trim() ? JSON.parse(value) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new StudioValidationError(
        "json_invalid",
        `${label} must be a JSON object.`,
      );
    }
    return parsed as Row;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new StudioValidationError("json_invalid", `Invalid ${label} JSON.`);
    }
    throw error;
  }
}

function textId(value: unknown, label: string) {
  const textValue = String(value ?? "").trim();
  if (!textValue) {
    throw new StudioValidationError(
      "identifier_required",
      `${label} is required.`,
    );
  }
  if (!/^[A-Za-z0-9._:@/-]+$/.test(textValue)) {
    throw new StudioValidationError(
      "identifier_invalid",
      `${label} contains unsupported characters.`,
    );
  }
  return textValue;
}

function optionalTextId(value: unknown) {
  const textValue = String(value ?? "").trim();
  return textValue ? textId(textValue, "decision edge endpoint") : null;
}

function workflowDecisionJoinMode(value: unknown) {
  const mode = String(value ?? "all").trim();
  if (mode !== "all" && mode !== "any_settled") {
    throw graphValidationError(
      `Decision join mode must be "all" or "any_settled", received "${mode}".`,
    );
  }
  return mode;
}

function workflowDecisionBranch(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const branch = String(value).trim();
  if (
    branch !== "true" &&
    branch !== "false" &&
    branch !== "default" &&
    !/^case:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(branch)
  ) {
    throw graphValidationError(
      `Decision edge branch "${branch}" is malformed.`,
    );
  }
  return branch;
}

/**
 * The predicate is stored as opaque declarative JSON. It is validated where it
 * is evaluated, so a decision can never crash a run; storing it unvalidated
 * would let the editor save a shape the engine silently ignores, so reject the
 * clearly malformed cases here.
 */
function sanitizeWorkflowDecisionConfig(kind: "if" | "switch", config: Row) {
  const value = jsonObjectOrEmpty(config);
  if (kind === "if") {
    if (value.predicate !== undefined && value.predicate !== null) {
      const error = workflowPredicateError(value.predicate);
      if (error) throw graphValidationError(error);
    }
    return { ...value, cases: undefined };
  }

  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    throw graphValidationError("Switch must contain at least one case.");
  }
  const caseIds = new Set<string>();
  const cases = value.cases.map((entry, index) => {
    const record = jsonObject(entry, `Switch case ${index + 1}`);
    const id = textId(record.id, `Switch case ${index + 1}`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
      throw graphValidationError(`Switch case id "${id}" is malformed.`);
    }
    if (caseIds.has(id)) {
      throw graphValidationError(`Switch contains duplicate case id "${id}".`);
    }
    caseIds.add(id);
    const error = workflowPredicateError(record.predicate);
    if (error) throw graphValidationError(`Switch case ${id}: ${error}`);
    return {
      id,
      name: String(record.name ?? "").trim() || `Case ${index + 1}`,
      predicate: record.predicate,
    };
  });
  return { ...value, predicate: undefined, cases };
}

function workflowDecisionKind(value: unknown): "if" | "switch" {
  const kind = String(value ?? "if").trim();
  if (kind !== "if" && kind !== "switch") {
    throw graphValidationError(`Unsupported decision kind "${kind}".`);
  }
  return kind;
}

function workflowTriggerType(value: unknown): WorkflowTriggerType {
  const type = String(value ?? "manual").trim();
  return type || "manual";
}

function jsonObject(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StudioValidationError(
      "json_invalid",
      `${label} must be a JSON object.`,
    );
  }
  return value as Row;
}

function jsonObjectOrEmpty(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
}

function remapWorkflowStepReferences<T>(
  value: T,
  stepIdMap: Map<string, string>,
): T {
  if (typeof value === "string") {
    return value.replace(
      /(\$\{steps\.)([^.\s}]+)(?=\.outputs(?:\.|}))/g,
      (match, prefix: string, stepId: string) => {
        const nextId = stepIdMap.get(stepId);
        return nextId ? `${prefix}${nextId}` : match;
      },
    ) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      remapWorkflowStepReferences(item, stepIdMap),
    ) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Row).map(([key, item]) => [
        key,
        remapWorkflowStepReferences(item, stepIdMap),
      ]),
    ) as T;
  }
  return value;
}

export { sanitizeWorkflowTriggerConfig as sanitizeWorkflowTriggerConfigForTest };

const WEBHOOK_TOKEN_SHAPE = /^[A-Za-z0-9_-]{24,128}$/;

/**
 * Adds the signing secret a sender needs, for a trigger that requires one.
 *
 * It is derived rather than stored, so it only exists once the token has been
 * decrypted, and it is read-only: the write sanitizer returns a fixed set of
 * keys, so a console that sends it back cannot store it.
 */
function triggerConfigForRead(
  type: WorkflowTriggerType,
  triggerId: string,
  config: Row,
) {
  if (type !== "webhook" || config.requireSignature !== true) {
    return config;
  }
  const token = String(config.token ?? "");
  return token
    ? { ...config, signingSecret: webhookSigningSecret(triggerId, token) }
    : config;
}

/**
 * The value written to `config_json.token`: always ciphertext.
 *
 * Accepts either a plaintext token the caller supplied or ciphertext being
 * rewritten unchanged, so saving a trigger the UI just read does not double
 * encrypt it.
 */
function sanitizedWebhookToken(stored: string) {
  const plaintext = WEBHOOK_TOKEN_SHAPE.test(stored)
    ? stored
    : decryptWebhookToken(stored);
  return encryptString(
    plaintext || randomBytes(24).toString("base64url"),
    vaultSecretFromEnv(),
  );
}

/** The plaintext behind a stored token, or "" when it cannot be read. */
function decryptWebhookToken(stored: string) {
  if (!stored) return "";
  try {
    const plaintext = decryptString(stored, vaultSecretFromEnv());
    return WEBHOOK_TOKEN_SHAPE.test(plaintext) ? plaintext : "";
  } catch {
    return "";
  }
}

/**
 * @param mint  True when the trigger is being written, false when it is being
 *   read. A webhook token is ciphertext at rest, so the direction decides
 *   whether the token is encrypted or decrypted — and only a write may replace
 *   an unusable token with a fresh one. Minting on read returned a different
 *   webhook URL on every load, none of which matched the stored token, so the
 *   URL the customer had configured upstream silently stopped being the one
 *   Studio displayed.
 */
function sanitizeWorkflowTriggerConfig(
  type: WorkflowTriggerType,
  value: unknown,
  mint = false,
) {
  const config = jsonObjectOrEmpty(value);
  if (type === "manual") {
    return {};
  }
  if (type === "webhook") {
    // At rest the token is vault-encrypted, like every other secret Studio
    // stores. Writing encrypts; reading decrypts, because the UI has to show
    // the webhook URL and the URL is the token.
    const stored = String(config.token ?? "").trim();
    const token = mint
      ? sanitizedWebhookToken(stored)
      : decryptWebhookToken(stored);
    return {
      token,
      /*
       * Coalescing exists because a Salesforce Record-Triggered Flow fires once
       * per record: a fifty-thousand-row data load would otherwise become fifty
       * thousand workflow runs. Events arriving inside the window accumulate
       * into one run carrying every record.
       *
       * Zero disables it, which is the right default for a low-volume webhook
       * where per-event latency matters more than batching.
       */
      coalesceWindowSeconds: boundedInt(
        config.coalesceWindowSeconds,
        0,
        0,
        3600,
      ),
      /** Refuses to start another run while this many are already active. */
      maxConcurrentRuns: boundedInt(config.maxConcurrentRuns, 1, 1, 50),
      /**
       * Deliveries per minute. The sanitizer used to drop this, so the knob
       * `withinWebhookRateLimit` reads was never stored and every trigger ran
       * on the default.
       */
      rateLimitPerMinute: boundedInt(
        config.rateLimitPerMinute,
        WEBHOOK_RATE_DEFAULT_PER_MINUTE,
        1,
        10_000,
      ),
      /**
       * Whether a body signature is required. Off by default: the token is in
       * the URL precisely because senders like Salesforce Flows cannot set
       * custom headers, and a signature is a header.
       */
      requireSignature: config.requireSignature === true,
    };
  }
  if (type === "date") {
    const runAt = normalizeOptionalScheduleDate(config.runAt);
    if (!runAt) {
      throw new StudioValidationError(
        "trigger_config_invalid",
        "Date trigger requires a valid run date.",
      );
    }
    return {
      runAt,
      timezone: normalizeTimezone(config.timezone),
    };
  }
  if (type === "completion") {
    const sourceKind = "workflow";
    const sourceId = String(config.sourceId ?? "").trim();
    if (!sourceId) {
      throw new StudioValidationError(
        "trigger_config_invalid",
        "Completion trigger requires a source.",
      );
    }
    const statuses = Array.isArray(config.statuses)
      ? config.statuses
          .map(String)
          .filter((status) => status === "completed" || status === "failed")
      : [];
    if (!statuses.length) {
      throw new StudioValidationError(
        "trigger_config_invalid",
        "Completion trigger requires at least one terminal status.",
      );
    }
    return {
      sourceKind,
      sourceId,
      statuses: [...new Set(statuses)],
    };
  }
  if (type !== "schedule") {
    return config;
  }

  const parsedFrequency = parseScheduleFrequency(
    String(config.frequency ?? ""),
  );
  const frequency =
    parsedFrequency?.kind === "interval"
      ? describeFrequency(parsedFrequency)
      : "every 1 hour";
  const nextRunAt =
    normalizeOptionalScheduleDate(config.nextRunAt) ??
    normalizeOptionalScheduleDate(config.startAt) ??
    nextHourIso();
  const endAt = normalizeOptionalScheduleDate(config.endAt);
  if (endAt && Date.parse(endAt) < Date.parse(nextRunAt)) {
    throw new StudioValidationError(
      "trigger_config_invalid",
      "Schedule trigger end date must be after the next run.",
    );
  }

  const budgetAlertThreshold = Math.min(
    Math.max(Math.floor(Number(config.budgetAlertThreshold ?? 80)), 1),
    100,
  );

  return {
    frequency,
    nextRunAt,
    endAt,
    timezone: normalizeTimezone(config.timezone),
    maxRunDurationSeconds: positiveInteger(config.maxRunDurationSeconds),
    creditBudgetLimit: positiveCredits(config.creditBudgetLimit, "down"),
    estimatedCreditCost:
      positiveCredits(
        config.estimatedCreditCost ?? config.creditCostPerRun,
        "up",
      ) ?? 0,
    maxRuns: positiveInteger(config.maxRuns),
    windowStartTime: normalizeClockTime(String(config.windowStartTime ?? "")),
    windowEndTime: normalizeClockTime(String(config.windowEndTime ?? "")),
    windowDays: normalizeWindowDays(config.windowDays),
    overlapPolicy: normalizeOverlapPolicy(config.overlapPolicy),
    budgetAlertThreshold: Number.isFinite(budgetAlertThreshold)
      ? budgetAlertThreshold
      : 80,
  };
}

function boundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function workflowTriggerName(type: WorkflowTriggerType) {
  if (type === "schedule") {
    return "On a schedule";
  }
  if (type === "webhook") {
    return "Webhook HTTP";
  }
  if (type === "date") {
    return "At a specific time";
  }
  if (type === "completion") {
    return "After workflow";
  }
  return "Trigger manually";
}

function secureTextEqual(expected: string, received: string) {
  if (!expected || !received) {
    return false;
  }
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

function normalizeOptionalScheduleDate(value: unknown) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new StudioValidationError(
      "trigger_config_invalid",
      "Schedule trigger date must be valid.",
    );
  }
  return new Date(parsed).toISOString();
}

function nextHourIso() {
  const date = new Date();
  date.setHours(date.getHours() + 1, 0, 0, 0);
  return date.toISOString();
}

function normalizeWindowDays(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6)
      .filter((item, index, days) => days.indexOf(item) === index)
      .sort((left, right) => left - right);
  }
  return parseWindowDays(String(value ?? ""));
}

function validateWorkflowTriggersForGraph(input: {
  triggers: Array<{
    id: string;
    type: WorkflowTriggerType;
    enabled: boolean;
  }>;
  triggerEdges: Array<{ triggerId: string; toStepId: string }>;
  steps: Array<{
    id: string;
    enabled: boolean;
    actionPackageName: string;
    inputBindings: Row;
  }>;
  edges: Array<{ fromStepId: string; toStepId: string }>;
}) {
  if (!input.triggers.length && !input.steps.length) {
    return;
  }

  if (!input.triggers.length) {
    throw graphValidationError("Graph must contain at least one trigger.");
  }

  const enabledTriggerIds = new Set(
    input.triggers
      .filter((trigger) => trigger.enabled)
      .map((trigger) => trigger.id),
  );
  if (!enabledTriggerIds.size) {
    throw graphValidationError(
      "Graph must contain at least one enabled trigger.",
    );
  }

  if (!input.steps.some((step) => step.enabled)) {
    return;
  }
  const nodes = input.steps.map((step) => ({
    id: step.id,
    enabled: step.enabled,
    actionPackageName: step.actionPackageName,
    inputBindings: step.inputBindings,
    definition: workflowNodeDefinition({
      actionPackageName: step.actionPackageName,
    }),
  }));
  const errors = validateTriggerTargets({
    graph: {
      nodes,
      edges: normalizeWorkflowEdges({
        nodes,
        edges: input.edges.map((edge, index) => ({
          id: `runtime_${index}_${edge.fromStepId}_${edge.toStepId}`,
          ...edge,
        })),
      }),
    },
    triggerEdges: input.triggerEdges,
    enabledTriggerIds,
  });
  if (errors[0]) {
    throw graphValidationError(errors[0]);
  }
}

function graphValidationError(message: string) {
  const error = new Error(message) as Error & {
    code: string;
    statusCode: number;
  };
  error.code = "workflow_graph_invalid";
  error.statusCode = 400;
  return error;
}

function workflowGraphHistoryConflictError() {
  const error = new Error(
    "This workflow has run history that references existing steps. Create a new workflow from the template before replacing the graph.",
  ) as Error & { code: string; statusCode: number };
  error.code = "workflow_graph_history_conflict";
  error.statusCode = 409;
  return error;
}

function isPostgresErrorCode(error: unknown, code: string) {
  return (error as { code?: unknown })?.code === code;
}

function finiteNumberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function parseJsonValue(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "object") {
    return value as Row | string | boolean | number | null;
  }
  try {
    return JSON.parse(String(value)) as Row | string | boolean | number | null;
  } catch {
    return null;
  }
}

async function insertDefaultWorkflowTriggerPg(
  client: PgClient,
  input: { workflowTemplateId: string; timestamp: string },
) {
  const existing = await pgOne<Row>(
    client,
    "SELECT id FROM workflow.triggers WHERE workflow_template_id = $1 LIMIT 1",
    [input.workflowTemplateId],
  );
  if (existing?.id) {
    return;
  }

  const triggerId = id("wftg");
  await client.query(
    `
    INSERT INTO workflow.triggers (
      id, workflow_template_id, type, name, enabled, config_json, state_json,
      canvas_x, canvas_y, created_at, updated_at
    )
    VALUES ($1, $2, 'manual', 'Trigger manually', true, '{}'::jsonb, '{}'::jsonb,
      -260, 120, $3, $3)
    ON CONFLICT(id) DO NOTHING
    `,
    [triggerId, input.workflowTemplateId, input.timestamp],
  );

  const firstStep = await pgOne<Row>(
    client,
    `
    SELECT id
    FROM workflow.steps
    WHERE workflow_template_id = $1
      AND retired_at IS NULL
    ORDER BY position ASC
    LIMIT 1
    `,
    [input.workflowTemplateId],
  );
  if (!firstStep?.id) {
    return;
  }

  await client.query(
    `
    INSERT INTO workflow.trigger_edges (
      id, workflow_template_id, trigger_id, to_step_id,
      condition_json, created_at, updated_at
    )
    VALUES ($1, $2, $3, $4, NULL, $5, $5)
    ON CONFLICT(id) DO NOTHING
    `,
    [
      `wfte_${triggerId}_${String(firstStep.id)}`,
      input.workflowTemplateId,
      triggerId,
      String(firstStep.id),
      input.timestamp,
    ],
  );
}
async function appendWorkflowEventPg(
  client: PgPool | PgClient,
  input: {
    organizationId?: string | null;
    workflowTemplateId?: string | null;
    workflowRunId?: string | null;
    workflowStepRunId?: string | null;
    workflowTaskId?: string | null;
    eventType: string;
    payload: Row;
  },
) {
  const subject = workflowEventSubject(input);
  await client.query(
    `
    INSERT INTO execution.workflow_events (
      id, organization_id, workflow_template_id, workflow_run_id,
      workflow_step_run_id, workflow_task_id, event_type, event_version,
      subject_type, subject_id, payload_json, created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10::jsonb, $11)
    `,
    [
      id("wfev"),
      input.organizationId ?? null,
      input.workflowTemplateId ?? null,
      input.workflowRunId ?? null,
      input.workflowStepRunId ?? null,
      input.workflowTaskId ?? null,
      input.eventType,
      subject.type,
      subject.id,
      JSON.stringify(input.payload),
      now(),
    ],
  );
}

function workflowEventSubject(input: {
  workflowTemplateId?: string | null;
  workflowRunId?: string | null;
  workflowStepRunId?: string | null;
  workflowTaskId?: string | null;
  eventType: string;
}) {
  if (input.workflowTaskId) {
    return { type: "workflow_task", id: input.workflowTaskId };
  }
  if (input.workflowStepRunId) {
    return { type: "workflow_step_run", id: input.workflowStepRunId };
  }
  if (input.workflowRunId) {
    return { type: "workflow_run", id: input.workflowRunId };
  }
  if (input.workflowTemplateId) {
    return { type: "workflow_template", id: input.workflowTemplateId };
  }
  return { type: "event", id: input.eventType };
}

async function workflowEventsAsLogs(workflowRunId: string) {
  const rows = await pgMany<Row>(
    pg(),
    `
    SELECT *
    FROM execution.workflow_events
    WHERE workflow_run_id = $1
    ORDER BY created_at ASC
    `,
    [workflowRunId],
  );
  return rows.map(
    (row): ExecutionLogRecord => ({
      id: String(row.id),
      runId: row.workflow_run_id ? String(row.workflow_run_id) : null,
      event: String(row.event_type),
      payload: parsePayload(row.payload_json),
      createdAt: timestampText(row.created_at),
      level: "info",
      correlationId: row.correlation_id ? String(row.correlation_id) : null,
      workerId: null,
    }),
  );
}

async function persistBuiltinActionPackagesPg(
  client: PgPool | PgClient,
  timestamp: string,
) {
  await persistRegistryBuiltinActionsPg(client, timestamp);
}

export async function assertPublicVersionIdentityAvailablePg(
  client: PgClient,
  input: {
    packageName: string;
    version: string;
    manifestChecksum: string;
    artifactChecksum: string;
  },
) {
  const existing = await pgOne<Row>(
    client,
    `
    SELECT pv.manifest_checksum, pv.artifact_checksum
    FROM actions.packages p
    JOIN actions.package_versions pv ON pv.package_id = p.id
    WHERE p.package_name = $1 AND pv.version = $2
    `,
    [input.packageName, input.version],
  );
  if (!existing) {
    return;
  }
  const existingManifestChecksum = normalizeManifestChecksum(
    existing.manifest_checksum,
  );
  const existingArtifactChecksum = normalizeSha256Checksum(
    existing.artifact_checksum,
  );
  if (
    existingManifestChecksum === input.manifestChecksum &&
    existingArtifactChecksum === input.artifactChecksum
  ) {
    return;
  }
  throw new RegistryClientError(
    "registry_version_identity_conflict",
    `${input.packageName}@${input.version} is already installed with different immutable checksums.`,
    {
      statusCode: 409,
      action:
        "Do not replace the installed bytes. Investigate the Registry package and install a new version.",
      details: {
        packageName: input.packageName,
        version: input.version,
        installedManifestChecksum: existingManifestChecksum,
        receivedManifestChecksum: input.manifestChecksum,
        installedArtifactChecksum: existingArtifactChecksum,
        receivedArtifactChecksum: input.artifactChecksum,
      },
    },
  );
}

/**
 * An installed package has one owner: the instance (null) or one
 * organization. Another organization may not install over a private package,
 * and its name is not revealed beyond "not available".
 */
async function assertPackageOwnerAvailablePg(
  client: PgClient,
  input: { packageName: string; ownerOrganizationId: string | null },
) {
  const existing = await pgOne<Row>(
    client,
    "SELECT organization_id FROM actions.packages WHERE package_name = $1 FOR UPDATE",
    [input.packageName],
  );
  if (
    existing?.organization_id &&
    existing.organization_id !== input.ownerOrganizationId
  ) {
    throw new RegistryClientError(
      "registry_package_unavailable",
      `${input.packageName} is not available to this organization.`,
      {
        statusCode: 409,
        action: "Choose another package, or install it from its organization.",
      },
    );
  }
}

async function persistPublicActionVersionPg(
  client: PgClient,
  input: {
    ownerOrganizationId: string | null;
    visibility: "public" | "unlisted" | "private";
    manifest: ActionManifest;
    manifestChecksum: string;
    artifactChecksum: string;
    artifactSizeBytes: number;
    hippiusBucket: string | null;
    hippiusKey: string | null;
    hippiusEndpoint: string | null;
    mediaType: string;
    signature: string | null;
    provenance: Row;
    validationStatus: string;
    status: string;
    publishedBy: string;
    publishedAt: string;
    timestamp: string;
  },
) {
  const packageName = input.manifest.name;
  const packageParts = packageNameParts(packageName);
  const manifestCatalog = parsePayload(input.manifest.catalog);
  const slug = categorySlug(input.manifest);
  const categoryResult = await client.query<{ id: string }>(
    `
    INSERT INTO actions.categories (
      id, slug, name, description, created_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $5)
    ON CONFLICT (slug) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      updated_at = EXCLUDED.updated_at
    RETURNING id
    `,
    [
      registryId("act_cat", slug),
      slug,
      titleFromSlug(slug),
      `Beam ${titleFromSlug(slug).toLowerCase()} actions.`,
      input.timestamp,
    ],
  );
  const categoryId = categoryResult.rows[0]?.id ?? registryId("act_cat", slug);
  const scopeResult = await client.query<{ id: string }>(
    `
    INSERT INTO actions.scopes (
      id, name, status, metadata_json, created_at, updated_at
    )
    VALUES ($1, $2, 'active', $3::jsonb, $4, $4)
    ON CONFLICT (name) DO UPDATE SET
      status = EXCLUDED.status,
      metadata_json = actions.scopes.metadata_json || EXCLUDED.metadata_json,
      updated_at = EXCLUDED.updated_at
    RETURNING id
    `,
    [
      registryId("act_scope", packageParts.scope),
      packageParts.scope,
      JSON.stringify({ source: "public-registry" }),
      input.timestamp,
    ],
  );
  const scopeId =
    scopeResult.rows[0]?.id ?? registryId("act_scope", packageParts.scope);
  const pkgId = registryId("act_pkg", packageName);
  const versionId = registryId(
    "act_ver",
    `${packageName}_${input.manifest.version}`,
  );
  const latestTagId = registryId("act_tag", `${packageName}_latest`);
  const packageResult = await client.query<{ id: string }>(
    `
    INSERT INTO actions.packages (
      id, scope_id, category_id, name, package_name, display_name,
      description, visibility, status, trust_level, latest_version,
      metadata_json, organization_id, created_at, updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $12, 'active', $8, $9,
      $10::jsonb, $13, $11, $11
    )
    ON CONFLICT (package_name) DO UPDATE SET
      scope_id = EXCLUDED.scope_id,
      category_id = EXCLUDED.category_id,
      display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      visibility = EXCLUDED.visibility,
      status = EXCLUDED.status,
      trust_level = EXCLUDED.trust_level,
      latest_version = EXCLUDED.latest_version,
      metadata_json = actions.packages.metadata_json || EXCLUDED.metadata_json,
      organization_id = EXCLUDED.organization_id,
      updated_at = EXCLUDED.updated_at
    RETURNING id
    `,
    [
      pkgId,
      scopeId,
      categoryId,
      packageParts.name,
      packageName,
      String(input.manifest.displayName ?? packageParts.name),
      input.manifest.description ? String(input.manifest.description) : null,
      input.manifest.trustLevel ?? "external",
      input.manifest.version,
      JSON.stringify({
        source: "public-registry",
        owner: manifestCatalog.owner ?? "unknown",
        maturity: manifestCatalog.maturity ?? "stable",
        tags: Array.isArray(manifestCatalog.tags) ? manifestCatalog.tags : [],
        sourceRegistryUrl: input.provenance.sourceRegistryUrl,
      }),
      input.timestamp,
      input.visibility,
      input.ownerOrganizationId,
    ],
  );
  const packageId = packageResult.rows[0]?.id ?? pkgId;
  const versionResult = await client.query<{ id: string }>(
    `
    INSERT INTO actions.package_versions (
      id, package_id, version, manifest_json, manifest_checksum,
      artifact_checksum, artifact_size_bytes, hippius_bucket, hippius_key,
      hippius_endpoint, media_type, signature, provenance_json,
      validation_status, status, published_by, published_at, created_at, updated_at
    )
    VALUES (
      $1, $2, $3, $4::jsonb, $5,
      $6, $7, $8, $9,
      $10, $11, $12, $13::jsonb,
      $14, $15, $16, $17, $18, $18
    )
    ON CONFLICT (package_id, version) DO UPDATE SET
      manifest_json = EXCLUDED.manifest_json,
      manifest_checksum = EXCLUDED.manifest_checksum,
      artifact_checksum = EXCLUDED.artifact_checksum,
      artifact_size_bytes = EXCLUDED.artifact_size_bytes,
      hippius_bucket = EXCLUDED.hippius_bucket,
      hippius_key = EXCLUDED.hippius_key,
      hippius_endpoint = EXCLUDED.hippius_endpoint,
      media_type = EXCLUDED.media_type,
      signature = EXCLUDED.signature,
      provenance_json = EXCLUDED.provenance_json,
      validation_status = EXCLUDED.validation_status,
      status = EXCLUDED.status,
      updated_at = EXCLUDED.updated_at
    WHERE actions.package_versions.manifest_checksum = EXCLUDED.manifest_checksum
      AND actions.package_versions.artifact_checksum = EXCLUDED.artifact_checksum
    RETURNING id
    `,
    [
      versionId,
      packageId,
      input.manifest.version,
      JSON.stringify(input.manifest),
      input.manifestChecksum,
      input.artifactChecksum,
      input.artifactSizeBytes,
      input.hippiusBucket,
      input.hippiusKey,
      input.hippiusEndpoint,
      input.mediaType,
      input.signature,
      JSON.stringify(input.provenance),
      input.validationStatus,
      input.status,
      input.publishedBy,
      input.publishedAt,
      input.timestamp,
    ],
  );
  if (!versionResult.rows[0]?.id) {
    throw new RegistryClientError(
      "registry_version_identity_conflict",
      `${packageName}@${input.manifest.version} is already installed with different immutable checksums.`,
      {
        statusCode: 409,
        action:
          "Do not replace the installed bytes. Investigate the Registry package and install a new version.",
        details: {
          packageName,
          version: input.manifest.version,
          receivedManifestChecksum: input.manifestChecksum,
          receivedArtifactChecksum: input.artifactChecksum,
        },
      },
    );
  }
  await client.query(
    `
    INSERT INTO actions.dist_tags (
      id, package_id, tag, version_id, updated_by, created_at, updated_at
    )
    VALUES ($1, $2, 'latest', $3, 'public-registry', $4, $4)
    ON CONFLICT (package_id, tag) DO UPDATE SET
      version_id = EXCLUDED.version_id,
      updated_by = EXCLUDED.updated_by,
      updated_at = EXCLUDED.updated_at
    `,
    [latestTagId, packageId, versionResult.rows[0].id, input.timestamp],
  );
}

export async function persistRegistryBuiltinActionsPg(
  client: PgPool | PgClient,
  timestamp: string,
) {
  const scopeResult = await client.query<{ id: string }>(
    `
    INSERT INTO actions.scopes (
      id, name, status, metadata_json, created_at, updated_at
    )
    VALUES ('act_scope_beam', '@beam', 'active', '{"source":"builtin"}'::jsonb, $1, $1)
    ON CONFLICT (name) DO UPDATE SET
      status = EXCLUDED.status,
      metadata_json = actions.scopes.metadata_json || EXCLUDED.metadata_json,
      updated_at = EXCLUDED.updated_at
    RETURNING id
    `,
    [timestamp],
  );
  const scopeId = scopeResult.rows[0]?.id ?? "act_scope_beam";

  const registry = createBuiltinActionRegistry();
  const actions = registry.listPackages();
  const categorySlugs = new Set(
    actions.map((action) => categorySlug(action.manifest)).filter(Boolean),
  );
  const categoryIdsBySlug = new Map<string, string>();

  for (const slug of categorySlugs) {
    const result = await client.query<{ id: string }>(
      `
      INSERT INTO actions.categories (
        id, slug, name, description, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $5)
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        updated_at = EXCLUDED.updated_at
      RETURNING id
      `,
      [
        registryId("act_cat", slug),
        slug,
        titleFromSlug(slug),
        `Beam ${titleFromSlug(slug).toLowerCase()} actions.`,
        timestamp,
      ],
    );
    categoryIdsBySlug.set(
      slug,
      result.rows[0]?.id ?? registryId("act_cat", slug),
    );
  }

  for (const action of actions) {
    const packageName = action.manifest.name;
    const packageParts = packageNameParts(packageName);
    const pkgId = registryId("act_pkg", packageName);
    const versionId = registryId(
      "act_ver",
      `${packageName}_${action.manifest.version}`,
    );
    const latestTagId = registryId("act_tag", `${packageName}_latest`);
    const manifestCatalog = parsePayload(action.manifest.catalog);
    const slug = categorySlug(action.manifest);
    const categoryId = slug
      ? (categoryIdsBySlug.get(slug) ?? registryId("act_cat", slug))
      : null;

    const packageResult = await client.query<{ id: string }>(
      `
      INSERT INTO actions.packages (
        id, scope_id, category_id, name, package_name, display_name,
        description, visibility, status, trust_level, latest_version,
        metadata_json, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, 'public', 'active', 'builtin', $8,
        $9::jsonb, $10, $10
      )
      ON CONFLICT (package_name) DO UPDATE SET
        category_id = EXCLUDED.category_id,
        display_name = EXCLUDED.display_name,
        description = EXCLUDED.description,
        visibility = EXCLUDED.visibility,
        status = EXCLUDED.status,
        trust_level = EXCLUDED.trust_level,
        latest_version = CASE
          WHEN actions.packages.metadata_json->>'source' = 'public-registry'
            THEN actions.packages.latest_version
          ELSE EXCLUDED.latest_version
        END,
        metadata_json = EXCLUDED.metadata_json || actions.packages.metadata_json,
        updated_at = EXCLUDED.updated_at
      RETURNING id
      `,
      [
        pkgId,
        scopeId,
        categoryId,
        packageParts.name,
        packageName,
        String(action.manifest.displayName ?? packageParts.name),
        action.manifest.description
          ? String(action.manifest.description)
          : null,
        action.manifest.version,
        JSON.stringify({
          source: "builtin",
          owner: manifestCatalog.owner ?? "Beam",
          maturity: manifestCatalog.maturity ?? "stable",
          tags: Array.isArray(manifestCatalog.tags) ? manifestCatalog.tags : [],
        }),
        timestamp,
      ],
    );
    const packageId = packageResult.rows[0]?.id ?? pkgId;

    const versionResult = await client.query<{ id: string }>(
      `
      INSERT INTO actions.package_versions (
        id, package_id, version, manifest_json, manifest_checksum,
        artifact_checksum, artifact_size_bytes, hippius_bucket, hippius_key,
        hippius_endpoint, media_type, provenance_json, validation_status,
        status, published_by, published_at, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4::jsonb, $5,
        $6, 0, NULL, NULL,
        NULL, 'application/vnd.beam.builtin-action+json',
        $7::jsonb, 'verified',
        'active', 'beam', $8, $8, $8
      )
      ON CONFLICT (package_id, version) DO UPDATE SET
        manifest_json = EXCLUDED.manifest_json,
        manifest_checksum = EXCLUDED.manifest_checksum,
        artifact_checksum = EXCLUDED.artifact_checksum,
        media_type = EXCLUDED.media_type,
        provenance_json = EXCLUDED.provenance_json,
        validation_status = EXCLUDED.validation_status,
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at
      RETURNING id
      `,
      [
        versionId,
        packageId,
        action.manifest.version,
        JSON.stringify(action.manifest),
        action.checksum,
        `sha256:${action.checksum}`,
        JSON.stringify({
          source: "builtin",
          note: "First-party action bundled with the Studio runtime.",
        }),
        timestamp,
      ],
    );
    const packageVersionId = versionResult.rows[0]?.id ?? versionId;

    await client.query(
      `
      INSERT INTO actions.dist_tags (
        id, package_id, tag, version_id, updated_by, created_at, updated_at
      )
      VALUES ($1, $2, 'latest', $3, 'beam', $4, $4)
      ON CONFLICT (package_id, tag) DO UPDATE SET
        version_id = EXCLUDED.version_id,
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at
      WHERE (
        SELECT p.metadata_json->>'source'
        FROM actions.packages p
        WHERE p.id = actions.dist_tags.package_id
      ) IS DISTINCT FROM 'public-registry'
      `,
      [latestTagId, packageId, packageVersionId, timestamp],
    );
  }
}

/**
 * Deletes the catalog rows of builtin actions this Studio no longer bundles.
 *
 * Builtins are only ever upserted, so a builtin dropped from the code would
 * otherwise stay listed in the Registry page and pickers while no runtime can
 * execute it. Only rows Studio seeded itself are touched: `source` "builtin"
 * (or the `{ "builtin": true }` marker written by `db:studio:init`), never an
 * organization's package, and never a Registry install, which records
 * `source` "public-registry" on the package. Deleting a package cascades to
 * its versions and tags; workflow action locks keep their name, version and
 * checksum and only lose the version reference.
 *
 * Returns the package names it removed.
 */
export async function pruneRemovedBuiltinActionsPg(client: PgPool | PgClient) {
  const bundled = createBuiltinActionRegistry()
    .listPackages()
    .map((action) => action.manifest.name);
  const result = await client.query<{ package_name: string }>(
    `
    DELETE FROM actions.packages
    WHERE organization_id IS NULL
      AND (
        metadata_json->>'source' = 'builtin'
        OR (
          NOT metadata_json ? 'source'
          AND metadata_json->>'builtin' = 'true'
        )
      )
      AND NOT (package_name = ANY($1::text[]))
    RETURNING package_name
    `,
    [[...new Set(bundled)]],
  );
  return result.rows.map((row) => row.package_name).sort();
}

function packageNameParts(packageName: string) {
  const match = /^(@[^/]+)\/(.+)$/.exec(packageName);
  return {
    scope: match?.[1] ?? "@unknown",
    name: match?.[2] ?? packageName,
  };
}

/**
 * A Registry client that authenticates as the organization with its default
 * Beam API key, so the Registry can show it its private packages. With no
 * organization or no usable key it reads anonymously (public packages only).
 */
async function registryClient(organizationId?: string | null) {
  const apiKey = organizationId
    ? await organizationBeamApiKey(organizationId).catch(() => null)
    : null;
  return createRegistryClient({ baseUrl: normalizedRegistryUrl(), apiKey });
}

/**
 * A fresh signed Registry URL for the exact artifact a Registry-installed step
 * froze, read as the step's organization. Null when the Registry issues none.
 */
export async function signedRegistryArtifactUrlForStep(input: {
  organizationId: string;
  step: {
    actionPackage?: unknown;
    resolvedVersion?: unknown;
    artifactChecksum?: unknown;
    sourceRegistry?: unknown;
  };
}) {
  if (input.step.sourceRegistry !== "public-registry") return null;
  const packageName = String(input.step.actionPackage ?? "");
  const version = String(input.step.resolvedVersion ?? "");
  if (!packageName || !version) return null;
  return freshSignedArtifactUrl(await registryClient(input.organizationId), {
    packageName,
    version,
    artifactChecksum: input.step.artifactChecksum,
  });
}

function httpUrlOrNull(value: unknown) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function normalizeManifestChecksum(value: unknown) {
  return String(value ?? "")
    .trim()
    .replace(/^sha256[:-]/i, "")
    .toLowerCase();
}

function normalizedRegistryUrl() {
  return webEnv.beamActionRegistryUrl.endsWith("/")
    ? webEnv.beamActionRegistryUrl
    : `${webEnv.beamActionRegistryUrl}/`;
}

function registryPackagePath(packageName: string) {
  const parts = packageNameParts(packageName);
  return `${encodeURIComponent(parts.scope)}/${encodeURIComponent(parts.name)}`;
}

function categorySlug(manifest: ActionManifest) {
  const catalog = manifest.catalog;
  return slugify(String(catalog?.category ?? "workflow"));
}

function titleFromSlug(slug: string) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function registryId(prefix: string, value: string) {
  return `${prefix}_${slugify(value).replaceAll("-", "_")}`;
}

function slugify(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replaceAll("/", "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return normalized || "unknown";
}

function appendExecutionLog(
  runId: string | null,
  event: string,
  payload: Row,
  database: SqlDatabase = db(),
) {
  const level =
    event.includes("failed") || event.includes("dead_letter")
      ? "error"
      : event.includes("retry")
        ? "warn"
        : "info";
  database
    .prepare(
      `
    INSERT INTO execution_logs (
      id, run_id, event, payload, created_at, level, correlation_id, worker_id
    )
    VALUES (
      :id, :runId, :event, :payload, :createdAt, :level, :correlationId, NULL
    )
  `,
    )
    .run({
      id: id("log"),
      runId,
      event,
      payload: JSON.stringify(payload),
      createdAt: now(),
      level,
      correlationId: runId,
    });
}

export function listExecutionLogs(
  filters: {
    runId?: string;
    q?: string;
    event?: string;
    organizationId?: string | null;
  } = {},
) {
  if (!legacyProductStateAvailable()) return [];
  return many<Row>(
    `
    SELECT *
    FROM execution_logs
    WHERE (:runId = '' OR run_id = :runId)
      AND (:event = '' OR event = :event)
      AND (:q = '' OR LOWER(event) LIKE LOWER(:likeQ) OR LOWER(payload) LIKE LOWER(:likeQ))
      AND (
        :organizationId = ''
        OR EXISTS (
          SELECT 1
          FROM runs r
          INNER JOIN transfer_templates t ON t.id = r.transfer_template_id
          WHERE r.id = execution_logs.run_id
            AND t.organization_id = :organizationId
        )
      )
    ORDER BY created_at DESC
    LIMIT 160
    `,
    {
      runId: filters.runId ?? "",
      event: filters.event ?? "",
      q: filters.q?.trim() ?? "",
      likeQ: `%${filters.q?.trim() ?? ""}%`,
      organizationId: organizationFilterValue(filters.organizationId),
    },
  ).map((row) => ({
    id: String(row.id),
    runId: row.run_id ? String(row.run_id) : null,
    event: String(row.event),
    payload: parsePayload(row.payload),
    createdAt: String(row.created_at),
    level: String(row.level ?? "info"),
    correlationId: row.correlation_id ? String(row.correlation_id) : null,
    workerId: row.worker_id ? String(row.worker_id) : null,
  }));
}

export function dashboardSummary(
  filters: { organizationId?: string | null } = {},
): DashboardSummary {
  const organizationId = organizationFilterValue(filters.organizationId);
  const row = !legacyProductStateAvailable()
    ? {}
    : (one<Row>(
        `
    SELECT
      (
        SELECT COUNT(*)
        FROM transfer_templates t
        WHERE (:organizationId = '' OR t.organization_id = :organizationId)
      ) AS transfer_count,
      (
        SELECT COUNT(*)
        FROM transfer_templates t
        WHERE t.enabled = 1
          AND (:organizationId = '' OR t.organization_id = :organizationId)
      ) AS enabled_transfer_count,
      (
        SELECT COUNT(*)
        FROM schedules s
        INNER JOIN transfer_templates t ON t.id = s.transfer_template_id
        WHERE s.enabled = 1
          AND (:organizationId = '' OR t.organization_id = :organizationId)
      ) AS active_schedule_count,
      (
        SELECT COUNT(*)
        FROM runs r
        INNER JOIN transfer_templates t ON t.id = r.transfer_template_id
        WHERE (:organizationId = '' OR t.organization_id = :organizationId)
      ) AS run_count,
      (
        SELECT COUNT(*)
        FROM runs r
        INNER JOIN transfer_templates t ON t.id = r.transfer_template_id
        WHERE r.status = 'completed'
          AND (:organizationId = '' OR t.organization_id = :organizationId)
      ) AS completed_run_count,
      (
        SELECT COUNT(*)
        FROM runs r
        INNER JOIN transfer_templates t ON t.id = r.transfer_template_id
        WHERE r.status = 'failed'
          AND (:organizationId = '' OR t.organization_id = :organizationId)
      ) AS failed_run_count,
      (
        SELECT COUNT(*)
        FROM transfer_sources s
        INNER JOIN transfer_templates t ON t.id = s.transfer_template_id
        WHERE (:organizationId = '' OR t.organization_id = :organizationId)
      ) AS source_count,
      (
        SELECT COUNT(*)
        FROM transfer_destinations d
        INNER JOIN transfer_templates t ON t.id = d.transfer_template_id
        WHERE (:organizationId = '' OR t.organization_id = :organizationId)
      ) AS destination_count
  `,
        { organizationId },
      ) ?? {});

  const runCount = Number(row.run_count ?? 0);
  const completedRunCount = Number(row.completed_run_count ?? 0);
  return {
    transferCount: Number(row.transfer_count ?? 0),
    enabledTransferCount: Number(row.enabled_transfer_count ?? 0),
    activeScheduleCount: Number(row.active_schedule_count ?? 0),
    runCount,
    completedRunCount,
    failedRunCount: Number(row.failed_run_count ?? 0),
    successRate: runCount
      ? Math.round((completedRunCount / runCount) * 100)
      : 0,
    sourceCount: Number(row.source_count ?? 0),
    destinationCount: Number(row.destination_count ?? 0),
  };
}

export function runsReportRows(
  filters: { organizationId?: string | null } = {},
) {
  if (!legacyProductStateAvailable()) return [];
  return many<Row>(
    `
    SELECT
      r.id,
      t.name AS transfer_name,
      r.status,
      r.started_at,
      r.completed_at,
      r.error,
      r.created_at,
      COALESCE(rt.count, 0) AS transfer_count
    FROM runs r
    INNER JOIN transfer_templates t ON t.id = r.transfer_template_id
    LEFT JOIN (SELECT run_id, COUNT(*) AS count FROM run_transfers GROUP BY run_id) rt
      ON rt.run_id = r.id
    WHERE (:organizationId = '' OR t.organization_id = :organizationId)
    ORDER BY r.created_at DESC
    `,
    { organizationId: organizationFilterValue(filters.organizationId) },
  );
}

export async function getAssistantProviderSettings(scope: {
  organizationId?: string | null;
  userId?: string | null;
}): Promise<AssistantProviderSettingsRecord | null> {
  const row = await pgOne<Row>(
    pg(),
    `
    SELECT *
    FROM assistant.provider_settings
    WHERE organization_id = $1
      AND user_id = $2
    `,
    [
      organizationFilterValue(scope.organizationId) || LOCAL_ORGANIZATION_ID,
      scope.userId?.trim() ?? "",
    ],
  );
  if (!row) return null;

  return {
    organizationId: String(row.organization_id),
    userId: String(row.user_id ?? ""),
    providerId: String(row.provider_id),
    baseUrl: String(row.base_url),
    apiKey: row.encrypted_api_key
      ? decryptString(String(row.encrypted_api_key), vaultSecret())
      : "",
    model:
      String(row.model ?? "") ||
      String(row.default_chat_model ?? "") ||
      String(row.default_copilot_model ?? ""),
    models: assistantModelsFromJson(row.models_cache_json),
    modelsCachedAt: row.models_cached_at
      ? timestampText(row.models_cached_at)
      : null,
    createdAt: timestampText(row.created_at),
    updatedAt: timestampText(row.updated_at),
  };
}

export async function upsertAssistantProviderSettings(input: {
  organizationId?: string | null;
  userId?: string | null;
  providerId: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  models?: AssistantModelOption[];
}) {
  if (
    !input.providerId.trim() ||
    !input.baseUrl.trim() ||
    !input.model.trim()
  ) {
    throw new StudioValidationError(
      "assistant_provider_fields_required",
      "Provider, base URL and model are required.",
    );
  }

  await withPostgresTransaction(pg(), async (client) => {
    const organizationId = await ensureIdentityOrganization(
      client,
      input.organizationId,
    );
    const userId = input.userId?.trim() ?? "";
    const existing = await pgOne<Row>(
      client,
      `
      SELECT provider_id, encrypted_api_key
      FROM assistant.provider_settings
      WHERE organization_id = $1
        AND user_id = $2
      FOR UPDATE
      `,
      [organizationId, userId],
    );
    const suppliedApiKey = input.apiKey?.trim();
    const encryptedApiKey =
      input.providerId.trim() === "beam-ai"
        ? null
        : suppliedApiKey
          ? encryptString(suppliedApiKey, vaultSecret())
          : existing?.provider_id === input.providerId.trim() &&
              existing.encrypted_api_key
            ? String(existing.encrypted_api_key)
            : null;
    const timestamp = now();
    const modelsSupplied = Array.isArray(input.models);
    const models = modelsSupplied
      ? sanitizeAssistantModels(input.models ?? [])
      : [];

    await client.query(
      `
      INSERT INTO assistant.provider_settings AS current_settings (
        organization_id,
        user_id,
        provider_id,
        base_url,
        encrypted_api_key,
        model,
        default_chat_model,
        default_copilot_model,
        models_cache_json,
        models_cached_at,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $8::jsonb, $9, $7, $7)
      ON CONFLICT (organization_id, user_id) DO UPDATE
      SET provider_id = EXCLUDED.provider_id,
          base_url = EXCLUDED.base_url,
          encrypted_api_key = EXCLUDED.encrypted_api_key,
          model = EXCLUDED.model,
          default_chat_model = EXCLUDED.default_chat_model,
          default_copilot_model = EXCLUDED.default_copilot_model,
          models_cache_json = CASE
            WHEN $10::boolean THEN EXCLUDED.models_cache_json
            WHEN current_settings.provider_id <> EXCLUDED.provider_id
              OR current_settings.base_url <> EXCLUDED.base_url
              OR $11::boolean
            THEN '[]'::jsonb
            ELSE current_settings.models_cache_json
          END,
          models_cached_at = CASE
            WHEN $10::boolean THEN EXCLUDED.models_cached_at
            WHEN current_settings.provider_id <> EXCLUDED.provider_id
              OR current_settings.base_url <> EXCLUDED.base_url
              OR $11::boolean
            THEN NULL
            ELSE current_settings.models_cached_at
          END,
          updated_at = EXCLUDED.updated_at
      `,
      [
        organizationId,
        userId,
        input.providerId.trim(),
        input.baseUrl.trim().replace(/\/+$/, ""),
        encryptedApiKey,
        input.model.trim(),
        timestamp,
        JSON.stringify(models),
        modelsSupplied ? timestamp : null,
        modelsSupplied,
        Boolean(suppliedApiKey),
      ],
    );
  });
}

export async function cacheAssistantProviderModels(input: {
  organizationId: string;
  userId: string;
  providerId: string;
  baseUrl: string;
  settingsUpdatedAt: string;
  models: AssistantModelOption[];
}) {
  const timestamp = now();
  await pg().query(
    `
    UPDATE assistant.provider_settings
    SET models_cache_json = $1::jsonb,
        models_cached_at = $2
    WHERE organization_id = $3
      AND user_id = $4
      AND provider_id = $5
      AND base_url = $6
      AND updated_at = $7
    `,
    [
      JSON.stringify(sanitizeAssistantModels(input.models)),
      timestamp,
      input.organizationId,
      input.userId,
      input.providerId,
      input.baseUrl,
      input.settingsUpdatedAt,
    ],
  );
  return timestamp;
}

export async function getAssistantModelCatalogCache(cacheKey: string) {
  const row = await pgOne<Row>(
    pg(),
    `
    SELECT models_json, cached_at
    FROM assistant.model_catalog_cache
    WHERE cache_key = $1
    `,
    [cacheKey],
  );
  return row
    ? {
        models: assistantModelsFromJson(row.models_json),
        cachedAt: timestampText(row.cached_at),
      }
    : null;
}

export async function cacheAssistantModelCatalog(input: {
  cacheKey: string;
  providerId: string;
  baseUrl: string;
  models: AssistantModelOption[];
}) {
  const timestamp = now();
  await pg().query(
    `
    INSERT INTO assistant.model_catalog_cache (
      cache_key,
      provider_id,
      base_url,
      models_json,
      cached_at
    )
    VALUES ($1, $2, $3, $4::jsonb, $5)
    ON CONFLICT (cache_key) DO UPDATE
    SET provider_id = EXCLUDED.provider_id,
        base_url = EXCLUDED.base_url,
        models_json = EXCLUDED.models_json,
        cached_at = EXCLUDED.cached_at
    `,
    [
      input.cacheKey,
      input.providerId,
      input.baseUrl,
      JSON.stringify(sanitizeAssistantModels(input.models)),
      timestamp,
    ],
  );
  return timestamp;
}

function assistantModelsFromJson(value: unknown): AssistantModelOption[] {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed) ? sanitizeAssistantModels(parsed) : [];
}

function sanitizeAssistantModels(models: unknown[]): AssistantModelOption[] {
  return models
    .map((model) => {
      if (!model || typeof model !== "object" || Array.isArray(model)) {
        return null;
      }
      const value = model as Row;
      const id = String(value.id ?? "").trim();
      if (!id) return null;
      return {
        id,
        name: String(value.name ?? id).trim() || id,
        ...(value.recommended === true ? { recommended: true } : {}),
      };
    })
    .filter((model): model is AssistantModelOption => Boolean(model))
    .slice(0, 5_000);
}

export type AssistantConversationSummary = {
  request: AssistantRequestSummary | null;
  unread: boolean;
  archivedAt: string | null;
  id: string;
  title: string;
  route: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type AssistantStoredMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  meta: Record<string, unknown>;
  createdAt: string;
};

const ASSISTANT_CONVERSATION_TITLE_LIMIT = 80;

export async function listAssistantConversations(scope: {
  organizationId?: string | null;
  userId?: string | null;
  archived?: boolean;
  search?: string;
}) {
  return pgMany<Row>(
    pg(),
    `
    SELECT
      c.id,
      c.title,
      c.route,
      c.archived_at,
      (SELECT json_build_object('id',r.id,'conversation_id',r.conversation_id,'status',r.status,'error',r.error,'error_code',r.error_code,'created_at',r.created_at,'completed_at',r.completed_at) FROM assistant.requests r WHERE r.conversation_id=c.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) AS latest_request,
      c.read_request_id,
      c.created_at,
      c.updated_at,
      (SELECT COUNT(*) FROM assistant.messages m WHERE m.conversation_id = c.id) AS message_count
    FROM assistant.conversations c
    WHERE ($1 = '' OR c.organization_id = $1)
      AND ($2 = '' OR c.user_id IS NOT DISTINCT FROM $2)
      AND (c.archived_at IS NOT NULL) = $3
      AND ($4 = '' OR strpos(lower(c.title), lower($4)) > 0)
    ORDER BY c.updated_at DESC
    LIMIT 100
    `,
    [
      organizationFilterValue(scope.organizationId),
      scope.userId?.trim() ?? "",
      scope.archived ?? false,
      scope.search?.trim() ?? "",
    ],
  ).then((rows) => rows.map(assistantConversationSummary));
}

export async function findAssistantReply(
  requestKey: string,
  scope: { organizationId?: string | null; userId?: string | null },
) {
  if (!requestKey || !scope.organizationId || !scope.userId) return null;
  const row = await pgOne<Row>(
    pg(),
    `
    SELECT m.conversation_id, m.meta_json->'response' AS response
    FROM assistant.messages m
    JOIN assistant.conversations c ON c.id = m.conversation_id
    WHERE c.organization_id = $1 AND c.user_id = $2
      AND m.role = 'assistant' AND m.meta_json->>'requestKey' = $3
    ORDER BY m.created_at DESC LIMIT 1
  `,
    [scope.organizationId, scope.userId, requestKey],
  );
  if (!row || !row.response || typeof row.response !== "object") return null;
  return {
    conversationId: String(row.conversation_id),
    response: row.response as Record<string, unknown>,
  };
}

export async function getAssistantConversation(
  conversationId: string,
  scope: { organizationId?: string | null; userId?: string | null },
) {
  const conversation = await pgOne<Row>(
    pg(),
    `
    SELECT c.id, c.title, c.route, c.archived_at, c.created_at, c.updated_at, c.read_request_id,
      (SELECT json_build_object('id',r.id,'conversation_id',r.conversation_id,'status',r.status,'error',r.error,'error_code',r.error_code,'created_at',r.created_at,'completed_at',r.completed_at) FROM assistant.requests r WHERE r.conversation_id=c.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) AS latest_request
    FROM assistant.conversations c
    WHERE c.id = $1
      AND ($2 = '' OR c.organization_id = $2)
      AND ($3 = '' OR c.user_id IS NOT DISTINCT FROM $3)
    `,
    [
      conversationId,
      organizationFilterValue(scope.organizationId),
      scope.userId?.trim() ?? "",
    ],
  );
  if (!conversation) {
    return null;
  }
  const messages = await pgMany<Row>(
    pg(),
    `
    SELECT id, role, content, meta_json, created_at
    FROM assistant.messages
    WHERE conversation_id = $1
    ORDER BY created_at ASC, id ASC
    `,
    [conversationId],
  );
  return {
    ...assistantConversationSummary({
      ...conversation,
      message_count: messages.length,
    }),
    messages: messages.map(assistantStoredMessage),
  };
}

export async function createAssistantConversation(input: {
  organizationId: string;
  projectId?: string | null;
  userId?: string | null;
  route?: string | null;
  title?: string | null;
}) {
  const conversationId = id("acv");
  const timestamp = now();
  // assistant.conversations references identity.organizations; a conversation
  // can be the first thing an organization writes.
  await ensureOrganizationPg(pg(), input.organizationId);
  await pgOne<Row>(
    pg(),
    `
    INSERT INTO assistant.conversations
      (id, organization_id, project_id, user_id, title, route, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
    RETURNING id
    `,
    [
      conversationId,
      input.organizationId,
      input.projectId?.trim() || null,
      input.userId?.trim() || null,
      assistantConversationTitle(input.title) || "New conversation",
      input.route?.trim() || null,
      timestamp,
    ],
  );
  return conversationId;
}

export async function appendAssistantMessages(
  conversationId: string,
  messages: Array<{
    role: "user" | "assistant";
    content: string;
    meta?: Record<string, unknown> | null;
  }>,
) {
  for (const message of messages) {
    await pgOne<Row>(
      pg(),
      `
      INSERT INTO assistant.messages (id, conversation_id, role, content, meta_json, created_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      RETURNING id
      `,
      [
        id("amsg"),
        conversationId,
        message.role,
        message.content,
        JSON.stringify(message.meta ?? {}),
        now(),
      ],
    );
  }
  await pgOne<Row>(
    pg(),
    `UPDATE assistant.conversations SET updated_at = $2 WHERE id = $1 RETURNING id`,
    [conversationId, now()],
  );
}

export async function renameAssistantConversation(
  conversationId: string,
  title: string,
  scope: { organizationId?: string | null; userId?: string | null },
) {
  const trimmed = assistantConversationTitle(title);
  if (!trimmed) {
    throw new StudioValidationError(
      "conversation_title_required",
      "Conversation title is required.",
      { field: "title" },
    );
  }
  const row = await pgOne<Row>(
    pg(),
    `
    UPDATE assistant.conversations
    SET title = $2, updated_at = $3
    WHERE id = $1
      AND ($4 = '' OR organization_id = $4)
      AND ($5 = '' OR user_id IS NOT DISTINCT FROM $5)
    RETURNING id
    `,
    [
      conversationId,
      trimmed,
      now(),
      organizationFilterValue(scope.organizationId),
      scope.userId?.trim() ?? "",
    ],
  );
  return Boolean(row);
}

export async function archiveAssistantConversation(
  conversationId: string,
  archived: boolean,
  scope: { organizationId?: string | null; userId?: string | null },
) {
  const row = await pgOne<Row>(
    pg(),
    `
    UPDATE assistant.conversations
    SET archived_at = $2
    WHERE id = $1
      AND ($3 = '' OR organization_id = $3)
      AND ($4 = '' OR user_id IS NOT DISTINCT FROM $4)
    RETURNING id
  `,
    [
      conversationId,
      archived ? now() : null,
      organizationFilterValue(scope.organizationId),
      scope.userId?.trim() ?? "",
    ],
  );
  return Boolean(row);
}

export async function deleteAssistantConversation(
  conversationId: string,
  scope: { organizationId?: string | null; userId?: string | null },
) {
  const row = await pgOne<Row>(
    pg(),
    `
    DELETE FROM assistant.conversations
    WHERE id = $1
      AND ($2 = '' OR organization_id = $2)
      AND ($3 = '' OR user_id IS NOT DISTINCT FROM $3)
    RETURNING id
    `,
    [
      conversationId,
      organizationFilterValue(scope.organizationId),
      scope.userId?.trim() ?? "",
    ],
  );
  return Boolean(row);
}

export function assistantConversationTitle(value?: string | null) {
  const collapsed = (value ?? "").replace(/\s+/g, " ").trim();
  if (collapsed.length <= ASSISTANT_CONVERSATION_TITLE_LIMIT) {
    return collapsed;
  }
  return `${collapsed.slice(0, ASSISTANT_CONVERSATION_TITLE_LIMIT - 1).trimEnd()}…`;
}

function assistantConversationSummary(row: Row): AssistantConversationSummary {
  const request = row.latest_request
    ? requestSummary(row.latest_request as AssistantRequestRow)
    : null;
  return {
    request,
    unread:
      request?.status === "succeeded" && row.read_request_id !== request.id,
    archivedAt: row.archived_at == null ? null : isoTimestamp(row.archived_at),
    id: String(row.id),
    title: String(row.title ?? "New conversation"),
    route: row.route == null ? null : String(row.route),
    messageCount: Number(row.message_count ?? 0),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

function assistantStoredMessage(row: Row): AssistantStoredMessage {
  return {
    id: String(row.id),
    role: row.role === "assistant" ? "assistant" : "user",
    content: String(row.content ?? ""),
    meta:
      row.meta_json && typeof row.meta_json === "object"
        ? (row.meta_json as Record<string, unknown>)
        : {},
    createdAt: isoTimestamp(row.created_at),
  };
}

function isoTimestamp(value: unknown) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(String(value ?? ""));
  return Number.isNaN(parsed.getTime()) ? now() : parsed.toISOString();
}
