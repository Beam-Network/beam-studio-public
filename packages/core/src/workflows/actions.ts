export type ActionPlacement =
  | "local-workers"
  | "room-members"
  | "external-workers"
  | "beamcore-public"
  | "custom";
export type ActionTrustLevel = "builtin" | "verified" | "external" | "blocked";
export type ActionMaturity =
  | "experimental"
  | "stable"
  | "deprecated"
  | "blocked";
export type ActionTaskMode = "single-worker" | "distributed-workers";
export type ActionNodeIsolation = "sandboxed-esm" | "trusted-node";
export type ActionPermissionCategory =
  | "storage"
  | "network"
  | "secrets"
  | "filesystem"
  | "beam";

export type ActionPermission = `${ActionPermissionCategory}:${string}`;

export type ActionJsonSchema = Record<string, unknown>;
export type ActionJson =
  | null
  | boolean
  | number
  | string
  | ActionJson[]
  | {
      [key: string]: ActionJson;
    };

export type ActionCredentialRequirement = {
  key: string;
  displayName: string;
  description?: string;
  required: boolean;
  cardinality: "one" | "many";
  purpose?: string;
  configPaths: string[];
  permissions?: string[];
  /**
   * Credential type slugs this requirement accepts, matching
   * secrets.credential_types.slug. The editor uses these to offer a picker of
   * the credentials that actually fit, instead of asking for a pasted id.
   * Omit to accept any credential.
   */
  acceptedCredentialTypes?: string[];
};

export type ActionManifest = {
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  author?: string;
  apiVersion: "workflow-actions/v1" | "workflow-actions/v2";
  runtime: {
    placements: ActionPlacement[];
    defaultPlacement?: ActionPlacement;
    minStudioVersion?: string;
  };
  execution?: {
    runtime?: "node";
    isolation?: ActionNodeIsolation;
    defaultPlacement?: ActionPlacement;
    supportedPlacements?: ActionPlacement[];
    taskMode?: ActionTaskMode;
    distribution?: ActionDistribution;
    defaultTimeoutSeconds?: number;
    capabilityContract?: "action-execution/v1";
    minRuntimeVersion?: string;
    requiredCapabilities?: string[];
    requiredResources?: { capacitySlots: 1; leaseSeconds: number };
  };
  configSchema?: ActionJsonSchema;
  inputs?: Record<string, ActionJsonSchema>;
  outputs?: Record<string, ActionJsonSchema>;
  /** Present only for Registry workflow-actions/v2. Never synthesize it for v1. */
  contracts?: ActionManifestV2Contracts;
  permissions?: ActionPermission[];
  inputPermissions?: ActionPermission[];
  outputPermissions?: ActionPermission[];
  trustLevel?: ActionTrustLevel;
  catalog?: ActionCatalogMetadata;
};

/** Frozen Registry v2 wire shape; v1 interpretation remains unchanged. */
export type ActionArtifactPortV2 = {
  type: "artifact";
  cardinality: "one" | "many";
  format: string;
  required: boolean;
};

export type ActionManifestV2Contracts = {
  resources: {
    cpuMillis: number;
    memoryMiB: number;
    timeoutSeconds: number;
    maxArtifactBytes: number;
    maxArtifacts: number;
    maxInputBytes: number;
    maxOutputBytes: number;
  };
  recovery: {
    retry: "never" | "idempotent" | "requires-idempotency-key";
    externalEffects: "none" | "idempotent" | "non-idempotent";
  };
  computation: {
    semanticId: string;
    /** A separate Registry action that consumes a closed contribution set. */
    aggregation?: {
      inputPort: string;
      outputPort: string;
      contributionFormat: string;
      associative: boolean;
      closedUnderCombination: boolean;
    };
    partitioning?: {
      inputPort: string;
      outputPort: string;
      aggregation: "ordered-concatenate" | "associative-commutative";
      equivalentToSingleTask: true;
    };
  };
};

export type ActionManifestV2 = ActionManifest & {
  apiVersion: "workflow-actions/v2";
  inputs: Record<string, ActionArtifactPortV2>;
  outputs: Record<string, ActionArtifactPortV2>;
  execution: NonNullable<ActionManifest["execution"]> & {
    capabilityContract: "action-execution/v1";
    minRuntimeVersion?: string;
    requiredCapabilities: string[];
    requiredResources: { capacitySlots: 1; leaseSeconds: number };
  };
  contracts: ActionManifestV2Contracts;
  inputPermissions?: ActionPermission[];
  outputPermissions?: ActionPermission[];
};

export type ActionDistribution = {
  mode: "partitioned-reduce";
  inputKey: string;
  outputKey: string;
  preferredItemsPerTask?: number;
  maxParallelism?: number;
  /** Opt in to stable logical partitions. Omitted on historical manifests. */
  partitionPlanVersion?: "logical/v1";
  /** V2 opt-in. Omission means one flat reduction; V1 keeps its old planner. */
  reductionStrategy?: "flat" | "hierarchical";
};

export type ActionCatalogMetadata = {
  category: string;
  maturity: ActionMaturity;
  owner: string;
  tags: string[];
  changelog: Array<{
    version: string;
    date?: string;
    notes: string[];
  }>;
  examples?: string[];
  credentialRequirements?: ActionCredentialRequirement[];
};

export type ActionArtifact = {
  id?: string;
  name: string;
  type: string;
  uri: string;
  mediaType?: string;
  metadata?: Record<string, ActionJson>;
};

export type ActionLogger = {
  debug(message: string, payload?: Record<string, unknown>): void;
  info(message: string, payload?: Record<string, unknown>): void;
  warn(message: string, payload?: Record<string, unknown>): void;
  error(message: string, payload?: Record<string, unknown>): void;
};

export type ActionStateRuntime = {
  get(): Record<string, ActionJson>;
  set(nextState: Record<string, ActionJson>): Promise<void> | void;
  patch(partialState: Record<string, ActionJson>): Promise<void> | void;
};

export type ActionStorageRuntime = {
  getJson(key: string): Promise<ActionJson | undefined>;
  putJson(key: string, value: ActionJson): Promise<void>;
};

export type ActionArtifactsRuntime = {
  publish(artifact: ActionArtifact): Promise<ActionArtifact>;
  /** Read a verified, invocation-scoped artifact input as canonical base64. */
  readInput?(port: string, index?: number): Promise<string>;
  /** Publish canonical base64 through a declared output port. */
  publishOutput?(
    port: string,
    base64: string,
    options?: { name?: string; mediaType?: string },
  ): Promise<ActionArtifact>;
};

export type ActionSecretsRuntime = {
  get(name: string): Promise<string | null>;
};

export type BeamRuntime = Record<string, unknown>;

export type ActionContext = {
  taskId?: string;
  assignmentId?: string;
  room?: import("@beam-studio/shared").WorkflowRoomContext | null;
  workflowRunId: string;
  stepRunId: string;
  stepId: string;
  attempt: number;
  logger: ActionLogger;
  state: ActionStateRuntime;
  storage: ActionStorageRuntime;
  artifacts: ActionArtifactsRuntime;
  secrets: ActionSecretsRuntime;
  beam: BeamRuntime;
  signal: AbortSignal;
};

export type ActionResult = {
  outputs?: Record<string, ActionJson>;
  metadata?: Record<string, ActionJson>;
  state?: Record<string, ActionJson>;
  externalRef?: string | null;
  artifacts?: ActionArtifact[];
  artifactManifest?: import("@beam-studio/shared").RoomArtifactManifest;
};

export type ActionExecute = (
  input: {
    config: Record<string, ActionJson>;
    inputs: Record<string, ActionJson>;
  },
  context: ActionContext,
) => Promise<ActionResult> | ActionResult;

export type ActionPackageSource = "builtin" | "remote";

export type RegisteredActionPackage = {
  source: ActionPackageSource;
  manifest: ActionManifest;
  checksum: string;
  execute: ActionExecute;
};

export class ActionExecutionError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = "ActionExecutionError";
    this.retryable = options.retryable ?? true;
  }
}

export class ActionPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionPermissionError";
  }
}

export class ActionPlacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionPlacementError";
  }
}

export class ActionTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionTrustError";
  }
}

export class ActionManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionManifestError";
  }
}

export class ActionRuntimeCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionRuntimeCompatibilityError";
  }
}

export class ActionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionInputError";
  }
}

export function validatePackageName(name: string) {
  if (!/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new ActionManifestError(
      `Action package name "${name}" must use the @scope/name format.`,
    );
  }
}

export function isBeamFirstPartyPackage(name: string) {
  return name.startsWith("@beam/");
}

export function validateActionManifest(manifest: ActionManifest) {
  validatePackageName(manifest.name);
  if (
    !manifest.version ||
    !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(manifest.version)
  ) {
    throw new ActionManifestError(
      `Action package "${manifest.name}" must declare an exact semver version.`,
    );
  }
  if (
    manifest.apiVersion !== "workflow-actions/v1" &&
    manifest.apiVersion !== "workflow-actions/v2"
  ) {
    throw new ActionRuntimeCompatibilityError(
      `Action package "${manifest.name}" uses unsupported apiVersion "${manifest.apiVersion}".`,
    );
  }
  if (manifest.apiVersion === "workflow-actions/v2")
    validateActionManifestV2(manifest as ActionManifestV2);
  if (!manifest.runtime?.placements?.length) {
    throw new ActionRuntimeCompatibilityError(
      `Action package "${manifest.name}" must declare at least one runtime placement.`,
    );
  }
  validateNodeIsolation(manifest);
  const placements = supportedPlacements(manifest);
  if (
    !placements.some(
      (placement) =>
        placement === "local-workers" || placement === "room-members",
    )
  ) {
    throw new ActionRuntimeCompatibilityError(
      `Action package "${manifest.name}" must support an implemented Studio or room-member target.`,
    );
  }
  for (const permission of manifest.permissions ?? []) {
    validateActionPermission(permission);
  }
  const defaultTimeoutSeconds = manifest.execution?.defaultTimeoutSeconds;
  if (
    defaultTimeoutSeconds !== undefined &&
    (!Number.isInteger(defaultTimeoutSeconds) || defaultTimeoutSeconds <= 0)
  ) {
    throw new ActionManifestError(
      `Action package "${manifest.name}" must declare a positive integer defaultTimeoutSeconds.`,
    );
  }
  const requirementKeys = new Set<string>();
  for (const requirement of manifest.apiVersion === "workflow-actions/v1"
    ? (manifest.catalog?.credentialRequirements ?? [])
    : []) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(requirement.key)) {
      throw new ActionManifestError(
        `Action package "${manifest.name}" has invalid credential requirement key "${requirement.key}".`,
      );
    }
    if (requirementKeys.has(requirement.key)) {
      throw new ActionManifestError(
        `Action package "${manifest.name}" repeats credential requirement key "${requirement.key}".`,
      );
    }
    requirementKeys.add(requirement.key);
    if (!requirement.displayName || !requirement.configPaths.length) {
      throw new ActionManifestError(
        `Credential requirement "${requirement.key}" must declare displayName and configPaths.`,
      );
    }
  }
  if (!manifest.inputs || !manifest.outputs) {
    throw new ActionManifestError(
      `Action package "${manifest.name}" must declare inputs and outputs.`,
    );
  }
}

const isExactSemver = (value: string) =>
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
const placements = new Set([
  "local-workers",
  "room-members",
  "external-workers",
  "beamcore-public",
  "custom",
]);
const capabilities = new Set([
  "action-execution/v1",
  "action-artifact-ports/v1",
  "action-process-ownership/v1",
  "runtime:node",
  "partitioned-reduce/v1",
  "idempotency-key/v1",
]);
const identifier = /^[a-z][a-z0-9._/-]*\/v[1-9][0-9]*$/;
const portName = /^[a-z][a-zA-Z0-9_]*$/;
const mediaType = /^[a-z0-9][a-z0-9_.+-]*\/[a-z0-9][a-z0-9_.+-]*$/;

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ActionManifestError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function keys(value: unknown, path: string, allowed: readonly string[]) {
  const object = record(value, path);
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new ActionManifestError(
        `${path} contains unsupported field "${key}".`,
      );
    }
  }
  return object;
}

function positiveInteger(value: unknown, path: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ActionManifestError(`${path} must be a positive safe integer.`);
  }
}

function uniqueStrings(value: unknown, path: string) {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string") ||
    new Set(value).size !== value.length
  ) {
    throw new ActionManifestError(
      `${path} must be an array of unique strings.`,
    );
  }
  return value as string[];
}

function validatePortSet(ports: unknown, path: string) {
  const portMap = record(ports, path);
  for (const [name, spec] of Object.entries(portMap)) {
    if (!portName.test(name))
      throw new ActionManifestError(
        `${path}.${name} has an invalid port name.`,
      );
    const port = keys(spec, `${path}.${name}`, [
      "type",
      "cardinality",
      "format",
      "required",
    ]);
    if (port.type !== "artifact") {
      throw new ActionManifestError(
        `${path}.${name} must use a Studio artifact port.`,
      );
    }
    if (port.cardinality !== "one" && port.cardinality !== "many") {
      throw new ActionManifestError(
        `${path}.${name} has an unsupported cardinality.`,
      );
    }
    if (typeof port.format !== "string" || !mediaType.test(port.format)) {
      throw new ActionManifestError(
        `${path}.${name} must declare one exact artifact format.`,
      );
    }
    if (typeof port.required !== "boolean") {
      throw new ActionManifestError(
        `${path}.${name}.required must be a boolean.`,
      );
    }
  }
  return portMap as Record<string, ActionArtifactPortV2>;
}

export function validateActionManifestV2(manifest: ActionManifestV2) {
  keys(manifest, "manifest", [
    "name",
    "version",
    "displayName",
    "description",
    "author",
    "apiVersion",
    "runtime",
    "execution",
    "configSchema",
    "inputs",
    "outputs",
    "permissions",
    "inputPermissions",
    "outputPermissions",
    "trustLevel",
    "catalog",
    "contracts",
  ]);
  if (manifest.apiVersion !== "workflow-actions/v2") {
    throw new ActionRuntimeCompatibilityError(
      "Expected a workflow-actions/v2 manifest.",
    );
  }
  if (manifest.permissions !== undefined)
    uniqueStrings(manifest.permissions, "permissions");
  for (const field of ["inputPermissions", "outputPermissions"] as const) {
    if (manifest[field] === undefined) continue;
    for (const permission of uniqueStrings(manifest[field], field)) {
      if (
        !/^(storage|network|secrets|filesystem|beam):[a-z0-9._*-]+$/.test(
          permission,
        )
      ) {
        throw new ActionManifestError(
          `${field} contains an invalid permission "${permission}".`,
        );
      }
    }
  }
  const runtime = keys(manifest.runtime, "runtime", [
    "placements",
    "defaultPlacement",
    "minStudioVersion",
  ]);
  const declaredPlacements = uniqueStrings(
    runtime.placements,
    "runtime.placements",
  );
  if (
    !declaredPlacements.length ||
    declaredPlacements.some((placement) => !placements.has(placement))
  ) {
    throw new ActionRuntimeCompatibilityError(
      "runtime.placements contains an unsupported placement.",
    );
  }
  if (
    runtime.defaultPlacement !== undefined &&
    !declaredPlacements.includes(runtime.defaultPlacement as string)
  ) {
    throw new ActionManifestError(
      "runtime.defaultPlacement must be a declared placement.",
    );
  }
  if (
    runtime.minStudioVersion !== undefined &&
    (typeof runtime.minStudioVersion !== "string" ||
      !isExactSemver(runtime.minStudioVersion))
  ) {
    throw new ActionManifestError(
      "runtime.minStudioVersion must be an exact semver version.",
    );
  }
  const execution = keys(manifest.execution, "execution", [
    "runtime",
    "isolation",
    "defaultPlacement",
    "supportedPlacements",
    "taskMode",
    "distribution",
    "defaultTimeoutSeconds",
    "capabilityContract",
    "minRuntimeVersion",
    "requiredCapabilities",
    "requiredResources",
  ]);
  if (
    execution.runtime !== "node" ||
    !["sandboxed-esm", "trusted-node"].includes(execution.isolation as string)
  ) {
    throw new ActionRuntimeCompatibilityError(
      "execution requires a supported node runtime and isolation.",
    );
  }
  if (execution.capabilityContract !== "action-execution/v1") {
    throw new ActionRuntimeCompatibilityError(
      "execution.capabilityContract must be action-execution/v1.",
    );
  }
  if (
    execution.minRuntimeVersion !== undefined &&
    (typeof execution.minRuntimeVersion !== "string" ||
      !isExactSemver(execution.minRuntimeVersion))
  ) {
    throw new ActionManifestError(
      "execution.minRuntimeVersion must be an exact semver version.",
    );
  }
  if (
    execution.isolation === "trusted-node" &&
    (!manifest.name.startsWith("@beam/") ||
      !["builtin", "verified"].includes(manifest.trustLevel as string))
  ) {
    throw new ActionRuntimeCompatibilityError(
      "Trusted Node isolation requires a first-party verified action.",
    );
  }
  if (
    !["single-worker", "distributed-workers"].includes(
      execution.taskMode as string,
    )
  ) {
    throw new ActionManifestError("execution.taskMode is unsupported.");
  }
  if (execution.supportedPlacements !== undefined) {
    const supported = uniqueStrings(
      execution.supportedPlacements,
      "execution.supportedPlacements",
    );
    if (
      !supported.length ||
      supported.some((placement) => !declaredPlacements.includes(placement))
    ) {
      throw new ActionManifestError(
        "execution.supportedPlacements must be a nonempty subset of runtime.placements.",
      );
    }
  }
  const effectivePlacements = (execution.supportedPlacements ??
    declaredPlacements) as string[];
  if (
    runtime.defaultPlacement !== undefined &&
    !effectivePlacements.includes(runtime.defaultPlacement as string)
  ) {
    throw new ActionManifestError(
      "runtime.defaultPlacement must be supported by execution.",
    );
  }
  if (
    execution.defaultPlacement !== undefined &&
    !effectivePlacements.includes(execution.defaultPlacement as string)
  ) {
    throw new ActionManifestError(
      "execution.defaultPlacement must be a supported placement.",
    );
  }
  if (execution.defaultTimeoutSeconds !== undefined)
    positiveInteger(
      execution.defaultTimeoutSeconds,
      "execution.defaultTimeoutSeconds",
    );

  const contracts = keys(manifest.contracts, "contracts", [
    "resources",
    "recovery",
    "computation",
  ]);
  if (manifest.configSchema !== undefined)
    record(manifest.configSchema, "configSchema");
  const inputs = validatePortSet(manifest.inputs, "inputs");
  const outputs = validatePortSet(manifest.outputs, "outputs");
  if (!Object.keys(inputs).length && !Object.keys(outputs).length) {
    throw new ActionManifestError(
      "v2 requires at least one declared artifact port.",
    );
  }
  const required = uniqueStrings(
    execution.requiredCapabilities,
    "execution.requiredCapabilities",
  );
  if (
    !required.includes("action-execution/v1") ||
    !required.includes("action-artifact-ports/v1")
  ) {
    throw new ActionManifestError(
      "v2 requires action-execution/v1 and action-artifact-ports/v1 capabilities.",
    );
  }
  for (const capability of required) {
    if (
      !capabilities.has(capability) &&
      !/^(isolation:(sandboxed-esm|trusted-node)|host:[A-Za-z][A-Za-z0-9.]*|permission:(storage|network|secrets|filesystem|beam):[a-z0-9._*-]+)$/.test(
        capability,
      )
    ) {
      throw new ActionRuntimeCompatibilityError(
        `Unknown mandatory action capability "${capability}".`,
      );
    }
  }
  const requiredResources = keys(
    execution.requiredResources,
    "execution.requiredResources",
    ["capacitySlots", "leaseSeconds"],
  );
  if (requiredResources.capacitySlots !== 1) {
    throw new ActionRuntimeCompatibilityError(
      "execution.requiredResources.capacitySlots must be one.",
    );
  }
  positiveInteger(
    requiredResources.leaseSeconds,
    "execution.requiredResources.leaseSeconds",
  );
  if (
    (requiredResources.leaseSeconds as number) < 5 ||
    (requiredResources.leaseSeconds as number) > 120
  ) {
    throw new ActionRuntimeCompatibilityError(
      "execution.requiredResources.leaseSeconds must fit the action-execution/v1 lease range.",
    );
  }
  const resources = keys(contracts.resources, "contracts.resources", [
    "cpuMillis",
    "memoryMiB",
    "timeoutSeconds",
    "maxArtifactBytes",
    "maxArtifacts",
    "maxInputBytes",
    "maxOutputBytes",
  ]);
  for (const field of [
    "cpuMillis",
    "memoryMiB",
    "timeoutSeconds",
    "maxArtifactBytes",
    "maxArtifacts",
    "maxInputBytes",
    "maxOutputBytes",
  ]) {
    positiveInteger(resources[field], `contracts.resources.${field}`);
  }
  if (
    (resources.maxArtifactBytes as number) > 32 * 1024 ||
    (resources.maxArtifacts as number) > 16 ||
    (resources.maxInputBytes as number) + (resources.maxOutputBytes as number) >
      64 * 1024
  ) {
    throw new ActionRuntimeCompatibilityError(
      "Resources exceed the bounded action-artifact-ports/v1 transport.",
    );
  }
  if (
    execution.defaultTimeoutSeconds !== undefined &&
    (execution.defaultTimeoutSeconds as number) >
      (resources.timeoutSeconds as number)
  ) {
    throw new ActionManifestError(
      "execution.defaultTimeoutSeconds exceeds contracts.resources.timeoutSeconds.",
    );
  }
  if (
    (requiredResources.leaseSeconds as number) >
    (resources.timeoutSeconds as number)
  ) {
    throw new ActionManifestError(
      "execution.requiredResources.leaseSeconds exceeds contracts.resources.timeoutSeconds.",
    );
  }
  const recovery = keys(contracts.recovery, "contracts.recovery", [
    "retry",
    "externalEffects",
  ]);
  if (
    !["never", "idempotent", "requires-idempotency-key"].includes(
      recovery.retry as string,
    ) ||
    !["none", "idempotent", "non-idempotent"].includes(
      recovery.externalEffects as string,
    )
  ) {
    throw new ActionManifestError(
      "contracts.recovery has an unsupported retry or external effects policy.",
    );
  }
  if (
    recovery.externalEffects === "non-idempotent" &&
    recovery.retry !== "never"
  ) {
    throw new ActionManifestError(
      "Non-idempotent external effects cannot be retried.",
    );
  }
  if (
    recovery.retry === "requires-idempotency-key" &&
    !required.includes("idempotency-key/v1")
  ) {
    throw new ActionManifestError(
      "Idempotency-key retries require idempotency-key/v1.",
    );
  }
  const computation = keys(contracts.computation, "contracts.computation", [
    "semanticId",
    "aggregation",
    "partitioning",
  ]);
  if (
    typeof computation.semanticId !== "string" ||
    !identifier.test(computation.semanticId)
  ) {
    throw new ActionManifestError(
      "contracts.computation.semanticId must be a versioned identifier.",
    );
  }
  if (computation.aggregation !== undefined) {
    const aggregation = keys(
      computation.aggregation,
      "contracts.computation.aggregation",
      [
        "inputPort",
        "outputPort",
        "contributionFormat",
        "associative",
        "closedUnderCombination",
      ],
    );
    const input = inputs[aggregation.inputPort as string];
    const output = outputs[aggregation.outputPort as string];
    if (
      execution.taskMode !== "single-worker" ||
      !input ||
      input.cardinality !== "many" ||
      !input.required ||
      !output ||
      output.cardinality !== "one"
    ) {
      throw new ActionManifestError(
        "Aggregation requires a single-worker action with a required collection input and one output.",
      );
    }
    if (
      typeof aggregation.contributionFormat !== "string" ||
      !mediaType.test(aggregation.contributionFormat)
    )
      throw new ActionManifestError(
        "Aggregation requires an exact contribution MIME format.",
      );
    if (input.format !== aggregation.contributionFormat)
      throw new ActionManifestError(
        "Aggregation contribution format must match its many input format.",
      );
    for (const field of ["associative", "closedUnderCombination"] as const) {
      if (typeof aggregation[field] !== "boolean")
        throw new ActionManifestError(
          `contracts.computation.aggregation.${field} must be boolean.`,
        );
    }
    if (
      aggregation.closedUnderCombination &&
      output.format !== aggregation.contributionFormat
    ) {
      throw new ActionManifestError(
        "Closed aggregation requires a many input and matching contribution and output formats.",
      );
    }
    if (computation.partitioning !== undefined)
      throw new ActionManifestError(
        "An aggregation action cannot also declare partitioning.",
      );
  }
  if (computation.partitioning === undefined) {
    if (
      execution.taskMode === "distributed-workers" ||
      execution.distribution !== undefined
    ) {
      throw new ActionManifestError(
        "Distributed execution requires an explicit partitioning contract.",
      );
    }
    return;
  }
  const partitioning = keys(
    computation.partitioning,
    "contracts.computation.partitioning",
    ["inputPort", "outputPort", "aggregation", "equivalentToSingleTask"],
  );
  if (
    execution.taskMode !== "distributed-workers" ||
    !required.includes("partitioned-reduce/v1")
  ) {
    throw new ActionManifestError(
      "Partitioning requires distributed-workers and partitioned-reduce/v1.",
    );
  }
  const distribution = keys(execution.distribution, "execution.distribution", [
    "mode",
    "inputKey",
    "outputKey",
    "preferredItemsPerTask",
    "maxParallelism",
    "partitionPlanVersion",
    "reductionStrategy",
  ]);
  if (
    distribution.partitionPlanVersion !== undefined &&
    distribution.partitionPlanVersion !== "logical/v1"
  )
    throw new ActionManifestError(
      "execution.distribution.partitionPlanVersion is unsupported.",
    );
  if (
    distribution.mode !== "partitioned-reduce" ||
    distribution.inputKey !== partitioning.inputPort ||
    distribution.outputKey !== partitioning.outputPort
  ) {
    throw new ActionManifestError(
      "Partition ports must match execution.distribution inputKey and outputKey.",
    );
  }
  for (const field of ["preferredItemsPerTask", "maxParallelism"]) {
    if (distribution[field] !== undefined)
      positiveInteger(distribution[field], `execution.distribution.${field}`);
  }
  if (
    distribution.reductionStrategy !== undefined &&
    !["flat", "hierarchical"].includes(distribution.reductionStrategy as string)
  )
    throw new ActionManifestError("Unsupported reduction strategy.");
  if (
    distribution.reductionStrategy === "hierarchical" &&
    partitioning.aggregation !== "associative-commutative"
  )
    throw new ActionManifestError(
      "Hierarchical reduction requires associative-commutative partitioning.",
    );
  const inputPort = Object.hasOwn(inputs, partitioning.inputPort as string)
    ? inputs[partitioning.inputPort as string]
    : undefined;
  if (
    !inputPort ||
    inputPort.cardinality !== "many" ||
    !inputPort.required ||
    !Object.hasOwn(outputs, partitioning.outputPort as string)
  ) {
    throw new ActionManifestError(
      "Partitioning requires a collection input and a declared output port.",
    );
  }
  if (
    !["ordered-concatenate", "associative-commutative"].includes(
      partitioning.aggregation as string,
    ) ||
    partitioning.equivalentToSingleTask !== true
  ) {
    throw new ActionManifestError(
      "Partitioning requires an aggregation mode and explicit single-task equivalence.",
    );
  }
}

function validateNodeIsolation(manifest: ActionManifest) {
  const isolation = manifest.execution?.isolation ?? "sandboxed-esm";
  if (isolation !== "sandboxed-esm" && isolation !== "trusted-node") {
    throw new ActionRuntimeCompatibilityError(
      `Action package "${manifest.name}" declares unsupported Node isolation "${String(isolation)}".`,
    );
  }
  if (isolation !== "trusted-node") {
    return;
  }
  if (!isBeamFirstPartyPackage(manifest.name)) {
    throw new ActionTrustError(
      `Trusted Node isolation is reserved for first-party @beam/* action packages.`,
    );
  }
  if (manifest.trustLevel !== "builtin" && manifest.trustLevel !== "verified") {
    throw new ActionTrustError(
      `Trusted Node action package "${manifest.name}" must use builtin or verified trust.`,
    );
  }
}

export function assertBuiltinActionAllowed(manifest: ActionManifest) {
  validateActionManifest(manifest);
  if (!isBeamFirstPartyPackage(manifest.name)) {
    throw new ActionManifestError(
      `V1 only allows builtin first-party packages in the reserved @beam/* namespace.`,
    );
  }
}

export function validateActionPermission(permission: string) {
  if (
    !/^(storage|network|secrets|filesystem|beam):[a-z0-9._*-]+$/.test(
      permission,
    )
  ) {
    throw new ActionManifestError(
      `Action permission "${permission}" must use category:operation format.`,
    );
  }
}

export function supportedPlacements(manifest: ActionManifest) {
  return manifest.execution?.supportedPlacements?.length
    ? manifest.execution.supportedPlacements
    : manifest.runtime.placements;
}

export function defaultPlacement(manifest: ActionManifest) {
  return (
    manifest.execution?.defaultPlacement ??
    manifest.runtime.defaultPlacement ??
    supportedPlacements(manifest)[0] ??
    "local-workers"
  );
}
