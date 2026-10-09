import type {
  ActionManifest,
  ActionJson,
  ActionPlacement,
  WorkflowTemplateStep,
  WorkflowGraphV3Definition,
  DistributedMember,
} from "@beam-studio/core";
import type { Telemetry } from "@beam-studio/telemetry";

export type Row = Record<string, unknown>;

export type OrchestratorConfig = {
  natsUrl: string;
  taskSubject: string;
  taskStream: string;
  deadLetterSubject: string;
  port: number;
  remoteExecution: RemoteExecutionConfig;
};

export type RemoteExecutionConfig = {
  enabled: boolean;
  taskSubject: string;
  resultSubject: string;
  ownerId: string;
  leaseMs: number;
  sandboxRuntime: "node-legacy" | "wasi" | "oci";
  artifactUrlBase?: string;
};

export type ApiLogger = {
  info(payload: unknown, message: string): void;
  warn(payload: unknown, message: string): void;
  error(payload: unknown, message: string): void;
};

export type WorkflowEdge = {
  id?: string;
  from: string;
  to: string;
  condition?: ActionJson;
};

export type ApiWorkflowStep = WorkflowTemplateStep & {
  resolvedVersion?: string;
  checksum?: string;
  manifestChecksum?: string;
  artifactChecksum?: string;
  artifactSizeBytes?: number;
  mediaType?: string;
  sourceRegistry?: string;
  manifestSnapshot?: ActionManifest | null;
  registryArtifactUrl?: string | null;
  hippiusBucket?: string | null;
  hippiusKey?: string | null;
  hippiusEndpoint?: string | null;
  resolvedPlacement?: ActionPlacement;
};

export type OrchestratorOptions = {
  remoteExecutionEnabled?: boolean;
  authorizeExecution?: import("@beam-studio/db").WorkflowExecutionAuthorizer;
  batchSize: number;
  maxAttempts: number;
  taskSubjectRoot?: string;
  logger: ApiLogger;
  broker: TaskBroker;
  telemetry?: Telemetry;
  /** Trusted private controller boundary. It must authorize the frozen room
   * cohort and requester before returning members. Missing means V3 is closed. */
  resolveFrozenV3Room?: (input: {
    workflowRunId: string;
    organizationId: string;
    graph: WorkflowGraphV3Definition;
    steps: ApiWorkflowStep[];
  }) => Promise<{ membersByPartition: Record<string, DistributedMember[]> }>;
  /** Rechecks live room grants for accepted routed artifact inputs. */
  authorizeV3ArtifactRead?: (input: {
    workflowRunId: string;
    consumerMemberId: string;
    artifact: import("./frozenAggregationPlan.js").FrozenAggregationArtifactInput;
  }) => Promise<void>;
};

export type TaskBroker = {
  publishTask(task: string | TaskPublishRequest): Promise<void>;
};

export type TaskPublishRequest = {
  taskId: string;
  messageId?: string;
  taskKind?: string;
  actionPackageName?: string;
  targetWorkerId?: string | null;
  subject?: string | null;
  placement?: string;
  workflowRunId?: string;
  correlationId?: string;
  traceparent?: string;
};

export type PreparedTaskPublication = {
  subject: string;
  messageId: string;
  payload: unknown;
};
