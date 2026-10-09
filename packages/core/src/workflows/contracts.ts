import { Ajv, type ValidateFunction } from "ajv";
import ajvFormats from "ajv-formats";
import type { ActionJson } from "./actions.js";
import type { resolveInputBindings } from "./runner.js";

export type WorkflowJsonSchema = Record<string, unknown> | boolean;
export type WorkflowOutputContract = {
  schema: WorkflowJsonSchema;
  bindings: ActionJson;
};
export type WorkflowContract = {
  inputSchema: WorkflowJsonSchema;
  output: WorkflowOutputContract;
};

export const defaultWorkflowContract: WorkflowContract = {
  inputSchema: { type: "object", additionalProperties: true },
  output: {
    schema: { type: "object", additionalProperties: false },
    bindings: {},
  },
};
export const maxWorkflowCallDepth = 16;

export class WorkflowContractError extends Error {
  readonly code = "workflow_contract_invalid";
  readonly statusCode = 400;
  readonly retryable = false;
}

// Schemas never load remote references or transform the caller's data.
const ajv = new Ajv({
  strict: true,
  strictTypes: false,
  strictTuples: false,
  strictRequired: false,
  allErrors: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  addUsedSchema: false,
  ownProperties: true,
});
ajvFormats.default(ajv);
const validators = new Map<string, ValidateFunction>();

function validator(schema: WorkflowJsonSchema): ValidateFunction {
  const key = JSON.stringify(schema);
  const cached = validators.get(key);
  if (cached) return cached;
  const inspect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(inspect); return; }
    const node = value as Record<string, unknown>;
    if (Object.hasOwn(node, "$ref") && (typeof node.$ref !== "string" || !node.$ref.startsWith("#"))) {
        throw new WorkflowContractError(
          "Workflow schemas support document-local $ref values only.",
        );
    }
    if (Object.hasOwn(node, "$async"))
      throw new WorkflowContractError(
        "Workflow schemas must validate synchronously.",
      );
    for (const key of [
      "items",
      "additionalItems",
      "additionalProperties",
      "contains",
      "propertyNames",
      "not",
      "if",
      "then",
      "else",
      "allOf",
      "anyOf",
      "oneOf",
    ])
      inspect(node[key]);
    for (const key of [
      "properties",
      "patternProperties",
      "definitions",
      "$defs",
      "dependencies",
    ]) {
      const children = node[key];
      if (children && typeof children === "object") Object.values(children).forEach(inspect);
    }
  };
  inspect(schema);
  try {
    const compiled = ajv.compile(schema);
    if (validators.size >= 256)
      validators.delete(validators.keys().next().value!);
    validators.set(key, compiled);
    return compiled;
  } catch (error) {
    throw new WorkflowContractError(
      `Invalid workflow schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function validateWorkflowContract(contract: WorkflowContract): void {
  if (
    !contract ||
    !Object.hasOwn(contract, "inputSchema") ||
    !contract.output ||
    !Object.hasOwn(contract.output, "schema") ||
    !Object.hasOwn(contract.output, "bindings")
  ) {
    throw new WorkflowContractError(
      "A workflow requires an input schema and an explicit output schema and bindings.",
    );
  }
  validator(contract.inputSchema);
  validator(contract.output.schema);
  visitBindings(contract.output.bindings, (expression) => {
    if (
      !/^(workflow\.input(?:\.[^.]+)*|steps\.[^.]+\.(outputs(?:\.[^.]+)*|status|error|runId))$/.test(
        expression,
      )
    ) {
      throw new WorkflowContractError(
        `Unsupported workflow output binding: ${expression}`,
      );
    }
  });
}

export function assertWorkflowValue(
  schema: WorkflowJsonSchema,
  value: unknown,
  label: string,
): asserts value is ActionJson {
  const check = validator(schema);
  if (!check(value)) {
    throw new WorkflowContractError(
      `${label}: ${ajv.errorsText(check.errors, { dataVar: label })}`,
    );
  }
}

export type WorkflowBindingContext = {
  input: ActionJson;
  steps: Map<
    string,
    {
      status: string;
      output?: ActionJson;
      error?: string | null;
      runId?: string | null;
    }
  >;
};

function visitBindings(
  value: ActionJson,
  visit: (expression: string) => void,
): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\$\{([^{}]*)\}/g))
      visit(match[1]!.trim());
  } else if (Array.isArray(value)) {
    value.forEach((entry) => visitBindings(entry, visit));
  } else if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && Object.hasOwn(value, "$literal"))
      return;
    Object.values(value).forEach((entry) => visitBindings(entry, visit));
  }
}

function pathValue(
  root: unknown,
  path: string[],
  expression: string,
): ActionJson {
  let value = root;
  for (const part of path) {
    if (
      part === "__proto__" ||
      part === "prototype" ||
      part === "constructor" ||
      !value ||
      typeof value !== "object" ||
      !Object.hasOwn(value, part)
    ) {
      throw new WorkflowContractError(
        `Unresolved workflow binding: ${expression}`,
      );
    }
    value = (value as Record<string, unknown>)[part];
  }
  if (value === undefined)
    throw new WorkflowContractError(
      `Unresolved workflow binding: ${expression}`,
    );
  return value as ActionJson;
}

/** Resolve only the public result of each step, never a child definition or snapshot. */
export function resolveWorkflowBindings(
  value: ActionJson,
  context: WorkflowBindingContext,
): ActionJson {
  const resolve = (expression: string): ActionJson => {
    const parts = expression.trim().split(".");
    if (parts[0] === "workflow" && parts[1] === "input")
      return pathValue(context.input, parts.slice(2), expression);
    if (parts[0] !== "steps" || !parts[1])
      throw new WorkflowContractError(
        `Unsupported workflow binding: ${expression}`,
      );
    const step = context.steps.get(parts[1]);
    if (!step)
      throw new WorkflowContractError(`Unavailable workflow step: ${parts[1]}`);
    if (parts[2] === "outputs") {
      if (step.status !== "completed")
        throw new WorkflowContractError(
          `Step ${parts[1]} has no successful public output.`,
        );
      return pathValue(step.output, parts.slice(3), expression);
    }
    if (
      parts.length === 3 &&
      ["status", "error", "runId"].includes(parts[2]!)
    ) {
      return pathValue(step, [parts[2]!], expression);
    }
    throw new WorkflowContractError(
      `Unsupported workflow binding: ${expression}`,
    );
  };
  if (typeof value === "string") {
    const matches = [...value.matchAll(/\$\{([^{}]*)\}/g)];
    if (matches.length === 1 && matches[0]![0].length === value.length)
      return resolve(matches[0]![1]!);
    return value.replace(/\$\{([^{}]*)\}/g, (_, expression: string) => {
      const result = resolve(expression);
      return typeof result === "string" ? result : JSON.stringify(result);
    });
  }
  if (Array.isArray(value))
    return value.map((entry) => resolveWorkflowBindings(entry, context));
  if (
    value &&
    typeof value === "object" &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, "$literal")
  )
    return value.$literal!;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        resolveWorkflowBindings(entry, context),
      ]),
    );
  return value;
}

export function materializeWorkflowOutput(
  contract: WorkflowOutputContract,
  context: WorkflowBindingContext,
): ActionJson {
  const output = resolveWorkflowBindings(contract.bindings, context);
  assertWorkflowValue(contract.schema, output, "Workflow output");
  return output;
}

/** Calls bind only public values and invocation metadata; unresolved values are contract errors. */
export const resolveWorkflowCallBindings: typeof resolveInputBindings = (
  bindings,
  input,
  _configuration,
  outputs,
  _artifacts,
  metadata,
) => {
  const steps: WorkflowBindingContext["steps"] = new Map();
  for (const [id, value] of metadata?.stepsById ?? []) {
    steps.set(id, {
      status: value.status,
      output: outputs.get(id),
      error: value.error ?? null,
      runId: value.runId ?? null,
    });
  }
  for (const [id, output] of outputs) {
    if (!steps.has(id))
      steps.set(id, { status: "completed", output, error: null, runId: null });
  }
  return resolveWorkflowBindings(bindings, { input, steps }) as Record<
    string,
    ActionJson
  >;
};
