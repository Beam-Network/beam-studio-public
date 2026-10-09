import type { Node } from "@xyflow/react";
import { Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { NativeSelect } from "./workflow-form-controls";
import { MentionField, type MentionNode } from "./workflow-mention-field";
import {
  emptyGroup,
  emptyRow,
  operatorLabels,
  unaryOperators,
  type PredicateGroup,
  type PredicateNode,
  type PredicateOperator,
} from "./workflow-predicate-model";
import type { WorkflowCanvasNodeData } from "./workflow-graph-types";

const groupModes: Array<{ value: PredicateGroup["mode"]; label: string }> = [
  { value: "all", label: "All of these are true" },
  { value: "any", label: "Any of these is true" },
  { value: "none", label: "None of these is true" },
];

/**
 * Guided editing for a decision predicate.
 *
 * Rows read left to right as a sentence, and the left operand uses the same
 * `@` mention field as an input binding so one idea has one spelling
 * throughout the editor.
 */
export function PredicateBuilder({
  group,
  mentionNodes,
  onChange,
}: {
  group: PredicateGroup;
  mentionNodes: MentionNode[];
  onChange(next: PredicateGroup): void;
}) {
  return (
    <GroupEditor
      depth={0}
      group={group}
      mentionNodes={mentionNodes}
      onChange={onChange}
      onRemove={null}
    />
  );
}

function GroupEditor({
  depth,
  group,
  mentionNodes,
  onChange,
  onRemove,
}: {
  depth: number;
  group: PredicateGroup;
  mentionNodes: MentionNode[];
  onChange(next: PredicateGroup): void;
  onRemove: (() => void) | null;
}) {
  const replaceEntry = (index: number, entry: PredicateNode) =>
    onChange({
      ...group,
      entries: group.entries.map((current, position) =>
        position === index ? entry : current,
      ),
    });

  const removeEntry = (index: number) =>
    onChange({
      ...group,
      entries: group.entries.filter((_, position) => position !== index),
    });

  return (
    <div
      className={cn(
        "grid gap-2 rounded-control border p-2",
        depth === 0 ? "bg-background" : "bg-muted/30",
      )}
    >
      <div className="flex items-center gap-2">
        <NativeSelect
          className="h-8 w-auto text-xs"
          value={group.mode}
          onChange={(event) =>
            onChange({
              ...group,
              mode: event.target.value as PredicateGroup["mode"],
            })
          }
        >
          {groupModes.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </NativeSelect>
        {onRemove ? (
          <button
            aria-label="Remove group"
            className="ml-auto grid size-7 place-items-center rounded-control-compact text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            onClick={onRemove}
            type="button"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {group.entries.length ? (
        <div className="grid gap-2">
          {group.entries.map((entry, index) =>
            entry.kind === "group" ? (
              <GroupEditor
                depth={depth + 1}
                group={entry}
                key={index}
                mentionNodes={mentionNodes}
                onChange={(next) => replaceEntry(index, next)}
                onRemove={() => removeEntry(index)}
              />
            ) : (
              <RowEditor
                key={index}
                mentionNodes={mentionNodes}
                onChange={(next) => replaceEntry(index, next)}
                onRemove={() => removeEntry(index)}
                row={entry}
              />
            ),
          )}
        </div>
      ) : (
        <p className="px-1 text-[11px] text-muted-foreground">
          No conditions yet. The join alone decides the branch until you add
          one.
        </p>
      )}

      <div className="flex gap-2">
        <button
          className="flex items-center gap-1 rounded-control-compact border px-2 py-1 text-[11px] hover:bg-accent"
          onClick={() =>
            onChange({ ...group, entries: [...group.entries, emptyRow()] })
          }
          type="button"
        >
          <Plus className="h-3 w-3" />
          Condition
        </button>
        {depth < 2 ? (
          <button
            className="flex items-center gap-1 rounded-control-compact border px-2 py-1 text-[11px] hover:bg-accent"
            onClick={() =>
              onChange({
                ...group,
                entries: [...group.entries, emptyGroup("any")],
              })
            }
            type="button"
          >
            <Plus className="h-3 w-3" />
            Group
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RowEditor({
  mentionNodes,
  onChange,
  onRemove,
  row,
}: {
  mentionNodes: MentionNode[];
  onChange(next: PredicateNode): void;
  onRemove(): void;
  row: Extract<PredicateNode, { kind: "row" }>;
}) {
  const unary = unaryOperators.has(row.operator);
  return (
    <div className="grid gap-1.5 rounded-control border bg-background p-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <MentionField
            nodes={mentionNodes}
            placeholder="@ a node, or a literal"
            value={row.left}
            onChange={(next) => onChange({ ...row, left: next })}
          />
        </div>
        <button
          aria-label="Remove condition"
          className="mt-1 grid size-7 shrink-0 place-items-center rounded-control-compact text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          onClick={onRemove}
          type="button"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-2">
        <NativeSelect
          className="h-8 w-auto text-xs"
          value={row.operator}
          onChange={(event) =>
            onChange({
              ...row,
              operator: event.target.value as PredicateOperator,
            })
          }
        >
          {(Object.keys(operatorLabels) as PredicateOperator[]).map(
            (operator) => (
              <option key={operator} value={operator}>
                {operatorLabels[operator]}
              </option>
            ),
          )}
        </NativeSelect>
        {unary ? (
          <span className="text-[11px] text-muted-foreground">
            compares against nothing
          </span>
        ) : (
          <input
            className="h-8 min-w-0 flex-1 rounded-control border bg-background px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder={'value ("001" to keep text)'}
            value={row.right}
            onChange={(event) =>
              onChange({ ...row, right: event.target.value })
            }
          />
        )}
      </div>
    </div>
  );
}

/** Nodes a predicate may reference: every node on the canvas, including itself's peers. */
export function predicateMentionNodes(
  nodes: Node<WorkflowCanvasNodeData>[],
  selfId: string,
): MentionNode[] {
  const entries: MentionNode[] = [];
  for (const node of nodes) {
    if (node.id === selfId) continue;
    if (node.data.nodeKind === "step") {
      const label = node.data.name?.trim() || node.data.actionPackageName;
      const manifest = node.data.action?.manifest ?? node.data.manifest ?? {};
      entries.push({
        id: node.id,
        label,
        kind: "step",
        values: [
          {
            expression: `\${steps.${node.id}.status}`,
            field: "status",
            hint: "completed, failed, skipped, not_reached",
          },
          {
            expression: `\${steps.${node.id}.error}`,
            field: "error",
            hint: "failure message, empty when it succeeded",
          },
          {
            expression: `\${steps.${node.id}.durationMs}`,
            field: "durationMs",
            hint: "how long it ran",
          },
          ...Object.keys(
            (manifest.outputs as Record<string, unknown> | undefined) ?? {},
          ).map((output) => ({
            expression: `\${steps.${node.id}.outputs.${output}}`,
            field: `outputs.${output}`,
            hint: "an output, set only when this step succeeds",
          })),
          ...Object.keys(node.data.config ?? {}).map((key) => ({
            expression: `\${steps.${node.id}.config.${key}}`,
            field: `config.${key}`,
            hint: `its ${key} setting`,
          })),
        ],
      });
    }
    if (node.data.nodeKind === "decision") {
      entries.push({
        id: node.id,
        label: node.data.name?.trim() || "Decision",
        kind: "decision",
        values: [
          {
            expression: `\${decisions.${node.id}.branch}`,
            field: "branch",
            hint: "the branch it took: true or false",
          },
        ],
      });
    }
  }
  entries.push({
    id: "__workflow__",
    label: "This workflow",
    kind: "workflow",
    values: [
      {
        expression: "${workflow.name}",
        field: "name",
        hint: "this workflow's name",
      },
      {
        expression: "${workflow.triggerType}",
        field: "triggerType",
        hint: "how this run started",
      },
    ],
  });
  return entries;
}
