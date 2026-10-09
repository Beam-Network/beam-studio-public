/**
 * The editable shape of a decision predicate.
 *
 * The engine's predicate language is broader than what a form can express, so
 * this model is deliberately partial: a predicate that does not fit is left
 * alone and edited as JSON rather than being rewritten into something the
 * builder can draw. Silently normalising a hand-written predicate would lose
 * meaning the author put there on purpose.
 */

export type PredicateOperator =
  | "eq"
  | "ne"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "exists"
  | "empty"
  | "contains";

/** Operators that compare against nothing, so the form hides the right side. */
export const unaryOperators = new Set<PredicateOperator>(["exists", "empty"]);

export const operatorLabels: Record<PredicateOperator, string> = {
  eq: "is",
  ne: "is not",
  lt: "is less than",
  lte: "is at most",
  gt: "is greater than",
  gte: "is at least",
  exists: "is set",
  empty: "is empty",
  contains: "contains",
};

export type PredicateRow = {
  kind: "row";
  left: string;
  operator: PredicateOperator;
  right: string;
};

export type PredicateGroup = {
  kind: "group";
  /** none renders as {not: {any: […]}}, which reads as "none of these". */
  mode: "all" | "any" | "none";
  entries: PredicateNode[];
};

export type PredicateNode = PredicateRow | PredicateGroup;

export function emptyGroup(
  mode: PredicateGroup["mode"] = "all",
): PredicateGroup {
  return { kind: "group", mode, entries: [] };
}

export function emptyRow(): PredicateRow {
  return { kind: "row", left: "", operator: "eq", right: "" };
}

/**
 * Parses a stored predicate into the builder model, or returns null when it
 * uses something the form cannot represent.
 */
export function parsePredicate(value: unknown): PredicateGroup | null {
  if (value === null || value === undefined) return emptyGroup();
  const node = parseNode(value);
  if (!node) return null;
  return node.kind === "group"
    ? node
    : { kind: "group", mode: "all", entries: [node] };
}

function parseNode(value: unknown): PredicateNode | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  for (const mode of ["all", "any"] as const) {
    if (mode in record) {
      if (!Array.isArray(record[mode]) || !record[mode].length) return null;
      const entries = (record[mode] as unknown[]).map(parseNode);
      if (entries.some((entry) => entry === null)) return null;
      return { kind: "group", mode, entries: entries as PredicateNode[] };
    }
  }

  if ("not" in record) {
    const inner = record.not;
    // Only the exact {not:{any:[…]}} shape maps to a "none of" group.
    if (
      inner &&
      typeof inner === "object" &&
      !Array.isArray(inner) &&
      Array.isArray((inner as Record<string, unknown>).any) &&
      ((inner as Record<string, unknown>).any as unknown[]).length > 0
    ) {
      const entries = ((inner as Record<string, unknown>).any as unknown[]).map(
        parseNode,
      );
      if (entries.some((entry) => entry === null)) return null;
      return {
        kind: "group",
        mode: "none",
        entries: entries as PredicateNode[],
      };
    }
    return null;
  }

  if ("left" in record && "op" in record) {
    const operator = String(record.op) as PredicateOperator;
    if (!Object.hasOwn(operatorLabels, operator)) return null;
    const left = operandToText(record.left);
    if (left === null) return null;
    const right = unaryOperators.has(operator)
      ? ""
      : operandToText(record.right === undefined ? null : record.right);
    if (right === null) return null;
    return { kind: "row", left, operator, right };
  }

  return null;
}

/** Serialises the builder model, or null when it holds nothing to evaluate. */
export function serializePredicate(group: PredicateGroup): unknown {
  const entries = group.entries
    .map(serializeNode)
    .filter((entry) => entry !== null);
  if (!entries.length) return null;
  if (group.mode === "none") return { not: { any: entries } };
  return { [group.mode]: entries };
}

function serializeNode(node: PredicateNode): unknown {
  if (node.kind === "group") return serializePredicate(node);
  if (!node.left.trim()) return null;
  const left = textToOperand(node.left);
  if (unaryOperators.has(node.operator)) {
    return { left, op: node.operator };
  }
  return { left, op: node.operator, right: textToOperand(node.right) };
}

/**
 * `{step, field}` is how the engine reads a node's run status. The form shows
 * it as the same `${steps.<id>.status}` expression used everywhere else, so an
 * operator never meets two spellings of one idea.
 */
function operandToText(value: unknown): string | null {
  if (value === null) return "null";
  if (typeof value === "string") {
    // Quote literals that would otherwise be coerced (or discarded as an
    // unfinished row). The text field must preserve the stored JSON type.
    return !value.trim() || textToOperand(value) !== value
      ? JSON.stringify(value)
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.step === "string" && record.field === "status") {
      return `\${steps.${record.step}.status}`;
    }
  }
  return null;
}

/** Numbers and booleans typed into the form become their JSON values. */
function textToOperand(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  if (trimmed.startsWith('"')) {
    try {
      const value: unknown = JSON.parse(trimmed);
      if (typeof value === "string") return value;
    } catch {
      // An unfinished quoted value remains editable as text.
    }
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (
    /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed) &&
    Number.isFinite(Number(trimmed))
  ) {
    return Number(trimmed);
  }
  return text;
}
