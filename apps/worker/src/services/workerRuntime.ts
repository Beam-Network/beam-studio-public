import type { WorkerFileServerMetadata } from "./workerFileServer.js";

export type WorkerRuntimeDeclaration = {
  concurrency: number;
  capabilities: string[];
  reachability: "local" | "internet" | "private";
  accessibleEndpoints: string[];
  bandwidthMbps: number;
  networkIdentity?: string;
  fileServer?: WorkerFileServerMetadata;
};
