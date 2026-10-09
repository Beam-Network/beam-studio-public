export type ActionRuntimeOptions = {
  /** Backend-owned durable process record; never supplied by an action. */
  processOwnership?: import("./process-ownership.js").ActionProcessOwnership;
  /** Scoped artifact capability, used only for the initial URL; redirects are rejected. */
  actionArtifactAuthorization?: string;
  allowedHostOperations?: string[];
  placement?: import("@beam-studio/core").ActionPlacement;
  requireArtifact?: boolean;
  actionCacheDir?: string;
  actionArtifactStorage?: {
    endpoint: string;
    region: string;
    forcePathStyle: boolean;
    accessKeyId?: string;
    secretAccessKey?: string;
  };
  allowedActionPermissions?: string[];
  trustedNodeActionPackages?: string[];
  trustedNodeAllowedNetwork?: string[];
  /** Null is reserved for a trusted room action guarded by the worker's verified idle lease. */
  actionSandboxTimeoutMs?: number | null;
  actionSandboxMemoryMb?: number;
  actionScratchDir?: string;
  actionScratchMaxBytes?: number;
  actionArtifactMaxBytes?: number;
  logger: {
    debug(payload: unknown, message: string): void;
    info(payload: unknown, message: string): void;
    warn(payload: unknown, message: string): void;
    error(payload: unknown, message: string): void;
  };
  allowScratchWrites?: boolean;
};
