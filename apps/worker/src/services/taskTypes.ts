import type { ActionRuntimeOptions } from "@beam-studio/action-runtime";
import type {
  ActionJson,
  RegisteredActionPackage,
  TaskRetryPolicy,
} from "@beam-studio/core";
import type { Telemetry, TraceContext } from "@beam-studio/telemetry";
import type { WorkerFileServer } from "./workerFileServer.js";

export type WorkflowTaskKind =
  | "step"
  | "step-shard"
  | "step-intermediate-reduce"
  | "step-reduce";

export type ClaimedWorkflowTask = {
  id: string;
  workflowRunId: string;
  workflowStepRunId: string;
  workflowStepId: string;
  actionPackageName: string;
  taskKind: WorkflowTaskKind;
  shardIndex: number | null;
  shardCount: number | null;
  input: Record<string, ActionJson>;
  attempt: number;
  maxAttempts: number;
  retryPolicy: TaskRetryPolicy;
  claimToken: string;
  leaseExpiresAt?: string;
  correlationId: string;
  traceContext: TraceContext | null;
};

export type TaskProcessResult =
  | {
      status: "completed" | "ignored" | "terminal" | "dead_letter";
      retryDelayMs?: never;
    }
  | { status: "retry"; retryDelayMs: number };

export type WorkflowObjectStorageEndpoint = {
  name?: string;
  provider: string;
  bucket: string;
  objectKey: string;
  uri?: string;
  sourceType?: "file" | "directory";
  region?: string;
  endpointUrl?: string;
  credentialId: string;
};

export type TaskWorkerOptions = ActionRuntimeOptions & {
  authorizeExecution?: import("@beam-studio/db").WorkflowExecutionAuthorizer;
  workerId: string;
  concurrency: number;
  lockTtlMs: number;
  cancellationPollIntervalMs?: number;
  processOwnershipDir?: string;
  maxAttempts: number;
  resolveActionPackage?: (step: unknown) => Promise<RegisteredActionPackage>;
  telemetry?: Telemetry;
  downloadObject(endpoint: WorkflowObjectStorageEndpoint): Promise<{
    content?: string;
    bytes?: number;
    uri?: string;
    mediaType?: string;
    metadata?: Record<string, ActionJson>;
  }>;
  uploadObject(
    endpoint: WorkflowObjectStorageEndpoint,
    content: string,
    options?: { mediaType?: string },
  ): Promise<{
    bytes?: number;
    uri?: string;
    mediaType?: string;
    metadata?: Record<string, ActionJson>;
  }>;
  deleteObject(endpoint: WorkflowObjectStorageEndpoint): Promise<{
    uri?: string;
    metadata?: Record<string, ActionJson>;
  }>;
  fileServer?: Pick<WorkerFileServer, "publishLocalFile">;
};
