import crypto from "node:crypto";
import type { SqlDatabase } from "@beam-studio/db";
import type { ActionJson, ActionPlacement } from "@beam-studio/core";
import type { ApiWorkflowStep, Row, WorkflowEdge } from "./types.js";

export function now() {
  return new Date().toISOString();
}

export function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function transaction<T>(db: SqlDatabase, callback: () => T) {
  db.exec("BEGIN");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function parseJsonObject(value: unknown): Row {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Row)
      : {};
  } catch {
    return {};
  }
}

export function parseActionJsonObject(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, ActionJson>;
  }
  return parseJsonObject(value) as Record<string, ActionJson>;
}

export function parseJsonArray(value: unknown) {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function numberOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function workflowStepFromSnapshot(row: Row, index: number): ApiWorkflowStep {
  return {
    id: String(row.id),
    position: Number.isInteger(Number(row.position)) ? Number(row.position) : index,
    enabled: row.enabled === undefined ? true : Boolean(row.enabled),
    actionPackage: String(row.actionPackage ?? row.action_package ?? ""),
    versionRange: String(row.versionRange ?? row.version_range ?? "*"),
    config: parseActionJsonObject(row.config),
    inputBindings: parseActionJsonObject(row.inputBindings),
    placement: String(row.resolvedPlacement ?? row.placement ?? "local-workers") as ActionPlacement,
    executionLocationId: row.executionLocationId ? String(row.executionLocationId) : null,
    timeoutSeconds: numberOrNull(row.timeoutSeconds),
    required: row.required === undefined ? true : Boolean(row.required),
    resolvedVersion: row.resolvedVersion ? String(row.resolvedVersion) : undefined,
    checksum: row.checksum ? String(row.checksum) : undefined,
    sourceRegistry: "builtin",
    resolvedPlacement: String(row.resolvedPlacement ?? row.placement ?? "local-workers") as ActionPlacement,
  };
}

export function workflowEdgesFromSnapshot(templateSnapshot: Row): WorkflowEdge[] {
  const rawEdges = Array.isArray(templateSnapshot.edges)
    ? templateSnapshot.edges
    : [];
  return rawEdges
    .filter((edge): edge is Row => Boolean(edge && typeof edge === "object"))
    .map((edge) => ({
      id: edge.id ? String(edge.id) : undefined,
      from: String(edge.from ?? edge.fromStepId ?? edge.from_step_id ?? ""),
      to: String(edge.to ?? edge.toStepId ?? edge.to_step_id ?? ""),
      condition: (edge.condition ?? null) as ActionJson,
    }));
}

export function appendExecutionLog(
  db: SqlDatabase,
  event: string,
  payload: Record<string, unknown>,
) {
  db.prepare(
    `
    INSERT INTO execution_logs (id, run_id, event, payload, created_at)
    VALUES (:id, NULL, :event, :payload, :createdAt)
  `,
  ).run({
    id: id("log"),
    event,
    payload: JSON.stringify(payload),
    createdAt: now(),
  });
}
