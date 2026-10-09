import type {
  WorkflowGraphV2Control,
  WorkflowGraphV2Definition,
} from "@beam-studio/core/workflows/graph-v2";
import type { WorkflowGraphV3Definition } from "@beam-studio/core/workflows/graph-v3";
import type {
  WorkflowEdgeKind,
  WorkflowNodeDefinition,
  WorkflowNodeKind,
} from "@beam-studio/core/workflows/graph-semantics";
import type { Edge } from "@xyflow/react";

type JsonObject = Record<string, unknown>;

type ActionPackage = {
  id: string;
  name: string;
  version: string;
  manifest: JsonObject;
  checksum: string;
};

type WorkflowStep = {
  kind?: "action" | "workflow";
  calledWorkflowId?: string | null;
  id: string;
  /** Operator-facing label for the node, independent of its action package. */
  name?: string | null;
  actionPackageName: string;
  actionVersionRange: string;
  position: number;
  enabled: boolean;
  config: JsonObject;
  inputBindings: JsonObject;
  placement: string;
  executionTarget?: import("@beam-studio/shared").ActionExecutionTarget;
  executionLocationId: string | null;
  canvasX: number | null;
  canvasY: number | null;
  timeoutSeconds: number | null;
  required: boolean;
  manifest: JsonObject | null;
};

type WorkflowEdge = {
  id: string;
  fromStepId: string;
  toStepId: string;
  condition: JsonObject | string | boolean | number | null;
};

type WorkflowActionLock = {
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

type WorkflowActionLockChange = {
  stepId: string;
  kind: "update" | "remove";
  actionPackageName: string;
  previous: WorkflowActionLock;
  next: WorkflowActionLock | null;
};

type WorkflowTriggerType = "manual" | "schedule" | (string & {});

type WorkflowTrigger = {
  id: string;
  workflowTemplateId: string;
  type: WorkflowTriggerType;
  name: string;
  enabled: boolean;
  config: JsonObject;
  state: JsonObject;
  canvasX: number | null;
  canvasY: number | null;
  createdAt?: string;
  updatedAt?: string;
};

type WorkflowTriggerEdge = {
  id: string;
  workflowTemplateId: string;
  triggerId: string;
  toStepId: string;
  condition: JsonObject | string | boolean | number | null;
};

type WorkflowRun = {
  id: string;
  workflowTemplateId: string;
  workflowName?: string | null;
  status: string;
  trigger?: string | null;
  triggerId?: string | null;
  triggerType?: string | null;
  triggerEvent?: JsonObject;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string | null;
};

type WorkflowRoomContext =
  import("@beam-studio/shared").WorkflowRoomContext;

type WorkflowBundle = {
  template: {
    room?: WorkflowRoomContext | null;
    inputSchema: JsonObject | boolean;
    output: { schema: JsonObject | boolean; bindings: unknown };
    failurePolicy: "stop_on_failure" | "continue_on_failure";
    agentBindings?: import("@beam-studio/shared").WorkflowReferences["agentBindings"];
    resourceBindings?: import("@beam-studio/shared").WorkflowReferences["resourceBindings"];
    id: string;
    name: string;
    description: string | null;
    /** Beam API key this workflow's runs are charged to. */
    apiKeyId: string | null;
    enabled: boolean;
    graphVersion:
      | "workflow-graph/v1"
      | "workflow-graph/v2"
      | "workflow-graph/v3";
    graph: JsonObject;
    updatedAt?: string;
    legacyTransferTemplateId?: string | null;
    legacyTransferName?: string | null;
  };
  graph:
    | WorkflowGraphV3Definition
    | WorkflowGraphV2Definition
    | {
        version: "workflow-graph/v1";
        controls: WorkflowGraphV2Control[];
        edges: Array<{
          id?: string;
          from: string;
          to: string;
          condition?: unknown;
        }>;
      };
  controls: WorkflowGraphV2Control[];
  triggers: WorkflowTrigger[];
  triggerEdges: WorkflowTriggerEdge[];
  decisions?: WorkflowDecisionRecord[];
  decisionEdges?: WorkflowDecisionEdgeRecord[];
  steps: WorkflowStep[];
  actionLocks: WorkflowActionLock[];
  edges: WorkflowEdge[];
  runCount: number;
};

type WorkflowDecisionRecord = {
  id: string;
  name: string;
  kind: "if" | "switch";
  enabled: boolean;
  joinMode: "all" | "any_settled";
  handleFailure: boolean;
  config: JsonObject;
  canvasX: number | null;
  canvasY: number | null;
};

type WorkflowDecisionEdgeRecord = {
  id: string;
  fromStepId: string | null;
  fromDecisionId: string | null;
  toStepId: string | null;
  toDecisionId: string | null;
  branch: "true" | "false" | `case:${string}` | "default" | null;
};

type WorkflowsIndex = {
  workflows: WorkflowSourceSummary[];
};

type WorkflowSourceSummary = {
  id: string;
  sidebarParentId: string | null;
  name: string;
  description: string | null;
  enabled: boolean;
  updatedAt: string;
  stepCount: number;
  runCount: number;
  lastRunStatus: string | null;
  scheduled: boolean;
  nextRunAt: string | null;
};

type CredentialsIndex = {
  credentials: CredentialRecord[];
};

type CredentialRecord = {
  id: string;
  name: string;
  /** Provider profile id, for example "slack-bot". */
  kind: string;
  /** Credential type slug, for example "slack_bot_token". */
  credentialType?: string;
  metadata?: JsonObject;
  payloadPreview?: string;
  /** "studio-instance" for the Studio instance key. */
  managedBy?: "studio-instance" | null;
};

type CredentialDetail = CredentialRecord & {
  payload?: JsonObject;
};

type ObjectListPayload = {
  prefixes: string[];
  objects: Array<{
    key: string;
    size: number | null;
    updatedAt: string | null;
  }>;
  prefix: string;
  truncated: boolean;
};

type WorkflowNodeData = WorkflowStep & {
  workflowRoom?: WorkflowRoomContext | null;
  inputBindingsError?: string;
  nodeKind: "step";
  workflowNodeKind: Extract<
    WorkflowNodeKind,
    "action" | "resource" | "composite"
  >;
  definition: WorkflowNodeDefinition;
  action: ActionPackage | null;
  credentialName?: string;
  credentialNatsUrl?: string;
  /** Beam environment on the bound credential, "dev" or "prod". */
  credentialEnvironment?: string;
  /**
   * Provider profile id of the bound credential, for example "slack-bot".
   * Lets an action node show the service's own logo instead of a generic icon.
   */
  credentialProvider?: string;
  endpointActionAvailable?: boolean;
  onQuickAddEndpoint?: (role: BeamTransferEndpointRole) => void;
  issues: string[];
};

type WorkflowTriggerNodeData = WorkflowTrigger & {
  nodeKind: "trigger";
  workflowNodeKind: "trigger";
  definition: WorkflowNodeDefinition;
  issues: string[];
};

type WorkflowControlNodeData = {
  nodeKind: "control";
  workflowNodeKind: "control";
  definition: WorkflowNodeDefinition;
  role: "loop" | "fan-out" | "fan-in";
  controlId: string;
  control: WorkflowGraphV2Control;
  issues: string[];
};

type WorkflowDecisionNodeData = {
  nodeKind: "decision";
  workflowNodeKind: "gateway";
  definition: WorkflowNodeDefinition;
  decisionId: string;
  name: string;
  kind: "if" | "switch";
  enabled: boolean;
  joinMode: "all" | "any_settled";
  handleFailure: boolean;
  predicate: unknown;
  cases: Array<{ id: string; name: string; predicate: unknown }>;
  issues: string[];
};

type WorkflowCanvasNodeData =
  | WorkflowNodeData
  | WorkflowTriggerNodeData
  | WorkflowControlNodeData
  | WorkflowDecisionNodeData;

type WorkflowGraphEdgeData = {
  edgeKind: WorkflowEdgeKind;
  condition: unknown;
  runtimeSource: string;
  runtimeTarget: string;
  runtimeSourceKind: "trigger" | "step" | "control";
  runtimeTargetKind: "step" | "control";
  runtimeEdges?: Array<{
    id: string;
    source: string;
    target: string;
    sourceKind: "trigger" | "step" | "control";
    targetKind: "step" | "control";
    dependency: boolean;
  }>;
  binding?: {
    sourceNodeId: string;
    sourceOutput: string;
    targetNodeId: string;
    targetInput: string;
    mode: "replace" | "append";
  };
  compositeNodeId?: string;
  memberNodeId?: string;
  membershipRole?: string;
  dynamicControlId?: string;
  [key: string]: unknown;
};

type WorkflowCanvasEdge = Edge<WorkflowGraphEdgeData>;

type WorkflowTab = "editor" | "runs" | "overview" | "settings";
type GraphControlMode = "select" | "pan" | "connect";
type ActionSort = "name" | "version" | "maturity";
type BindingMode = "replace" | "append";
type BeamTransferEndpointRole = "source" | "destination";

type AutomaticBindingPlan = {
  inputKey: string;
  outputKey: string;
  mode: BindingMode;
};

export type {
  ActionPackage,
  ActionSort,
  AutomaticBindingPlan,
  BeamTransferEndpointRole,
  CredentialDetail,
  CredentialRecord,
  CredentialsIndex,
  GraphControlMode,
  JsonObject,
  ObjectListPayload,
  WorkflowBundle,
  WorkflowActionLock,
  WorkflowActionLockChange,
  WorkflowCanvasNodeData,
  WorkflowCanvasEdge,
  WorkflowControlNodeData,
  WorkflowDecisionEdgeRecord,
  WorkflowDecisionNodeData,
  WorkflowDecisionRecord,
  WorkflowEdge,
  WorkflowGraphEdgeData,
  WorkflowTrigger,
  WorkflowTriggerEdge,
  WorkflowTriggerNodeData,
  WorkflowTriggerType,
  WorkflowNodeData,
  WorkflowRun,
  WorkflowSourceSummary,
  WorkflowStep,
  WorkflowTab,
  WorkflowsIndex,
};
