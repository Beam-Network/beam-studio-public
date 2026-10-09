import type { OrchestratorConfig } from "./types.js";

export function readConfig(): OrchestratorConfig {
  return {
    natsUrl: process.env.NATS_URL ?? "nats://127.0.0.1:4222",
    taskSubject: process.env.NATS_TASK_SUBJECT ?? "beam.workflow.tasks",
    taskStream: process.env.NATS_TASK_STREAM ?? "BEAM_WORKFLOW_TASKS",
    deadLetterSubject:
      process.env.NATS_TASK_DLQ_SUBJECT ?? "beam.workflow.tasks.dlq.permanent",
    port: envInt("ORCHESTRATOR_PORT", envInt("API_PORT", 8787)),
    // Poll interval, batch size and task attempts are live service
    // configuration, read each tick (main.ts).
    remoteExecution: {
      enabled: envBool("REMOTE_EXECUTION_ENABLED", false),
      taskSubject:
        process.env.REMOTE_EXECUTION_TASK_SUBJECT ??
        "beam.workloads.studio.tasks",
      resultSubject:
        process.env.REMOTE_EXECUTION_RESULT_SUBJECT ??
        "beam.workloads.studio.results",
      ownerId: process.env.REMOTE_EXECUTION_OWNER_ID ?? "beam-orchestrator",
      leaseMs: envInt("REMOTE_EXECUTION_LEASE_MS", 60 * 60 * 1_000),
      sandboxRuntime: sandboxRuntime(
        process.env.REMOTE_EXECUTION_SANDBOX_RUNTIME,
      ),
      artifactUrlBase:
        process.env.REMOTE_EXECUTION_ARTIFACT_URL_BASE || undefined,
    },
  };
}

function envInt(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function envBool(name: string, fallback: boolean) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function sandboxRuntime(value: string | undefined) {
  if (value === "wasi" || value === "oci" || value === "node-legacy") {
    return value;
  }
  return "node-legacy" as const;
}
