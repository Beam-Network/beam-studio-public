import {
  workflowReferencesSchema,
  type WorkflowReferences,
} from "@beam-studio/shared";
import type { ActionJson } from "./actions.js";
import { WorkflowContractError } from "./contracts.js";

export function parseWorkflowReferences(
  agentBindings: unknown,
  resourceBindings: unknown,
): WorkflowReferences {
  const result = workflowReferencesSchema.safeParse({
    agentBindings,
    resourceBindings,
  });
  if (!result.success)
    throw new WorkflowContractError(
      `Invalid workflow references: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  return result.data;
}

/** Compile only named references; literal resource data never becomes another expression. */
export function resolveWorkflowReferences(
  value: ActionJson,
  references: WorkflowReferences,
  mode: "config" | "binding",
): ActionJson {
  if (typeof value === "string") {
    const match = /^\$\{workflow\.(agents|resources)\.([^{}]+)\}$/.exec(value);
    if (!match) {
      if (/\$\{\s*workflow\.(agents|resources)(?:\.|\})/.test(value))
        throw new WorkflowContractError(
          "Use a named workflow reference as a whole value, without text interpolation.",
        );
      return value;
    }
    let selected: unknown =
      match[1] === "agents"
        ? references.agentBindings
        : references.resourceBindings;
    for (const segment of match[2]!.split(".")) {
      if (
        ["__proto__", "prototype", "constructor"].includes(segment) ||
        !selected ||
        typeof selected !== "object" ||
        !Object.hasOwn(selected, segment)
      )
        throw new WorkflowContractError(
          `Unresolved workflow reference: ${value}`,
        );
      selected = (selected as Record<string, unknown>)[segment];
    }
    const literal = structuredClone(selected) as ActionJson;
    return mode === "binding" ? { $literal: literal } : literal;
  }
  if (Array.isArray(value))
    return value.map((item) =>
      resolveWorkflowReferences(item, references, mode),
    );
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && Object.hasOwn(value, "$literal"))
      return structuredClone(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveWorkflowReferences(item, references, mode),
      ]),
    );
  }
  return value;
}
