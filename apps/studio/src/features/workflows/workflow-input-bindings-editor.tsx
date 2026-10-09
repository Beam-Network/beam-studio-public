import { useQueries } from "@tanstack/react-query";
import { apiGet } from "@/lib/api-client";
import type { Node } from "@xyflow/react";
import { isStepMetadataField } from "@beam-studio/core/workflows/node-metadata";
import { FieldRow } from "./workflow-form-controls";
import {
  MentionField,
  type MentionNode,
  type MentionValue,
} from "./workflow-mention-field";
import type {
  JsonObject,
  WorkflowCanvasNodeData,
  WorkflowNodeData,
  WorkflowBundle,
} from "./workflow-graph-types";

/**
 * Authoring for a step's input bindings.
 *
 * Config is passed to an action verbatim, so only inputs can carry a `${…}`
 * expression. Without this editor those expressions can only be written by the
 * assistant, which makes anything dynamic — a Slack message naming the step
 * that failed — impossible to author by hand.
 */
export function InputBindingsEditor({
  node,
  nodes,
  onChange,
}: {
  node: Node<WorkflowNodeData>;
  nodes: Node<WorkflowCanvasNodeData>[];
  onChange(inputBindings: JsonObject): void;
}) {
  const manifest = node.data.action?.manifest ?? node.data.manifest ?? {};
  const declaredInputs = Object.keys(
    (manifest.inputs as Record<string, unknown> | undefined) ?? {},
  );
  const bindings = node.data.inputBindings ?? {};
  // Bindings the assistant or an edge set for inputs the manifest no longer
  // declares still need to be visible, or they would be silently unremovable.
  const keys = [
    ...declaredInputs,
    ...Object.keys(bindings).filter((key) => !declaredInputs.includes(key)),
  ];

  const calls = nodes.filter(
    (other) => other.data.nodeKind === "step" && other.data.kind === "workflow",
  );
  const contracts = useQueries({
    queries: calls.map((call) => ({
      queryKey: [
        "/studio/workflows",
        (call.data as WorkflowNodeData).calledWorkflowId,
      ],
      queryFn: () =>
        apiGet<WorkflowBundle>(
          `/studio/workflows/${encodeURIComponent((call.data as WorkflowNodeData).calledWorkflowId!)}`,
        ),
      enabled: Boolean((call.data as WorkflowNodeData).calledWorkflowId),
    })),
  });
  const schemas = new Map(
    calls.map((call, index) => [
      call.id,
      contracts[index]?.data?.template.output.schema,
    ]),
  );
  const options = available(nodes, node.id, schemas);

  if (!keys.length) {
    return (
      <p className="text-xs leading-5 text-muted-foreground">
        This action declares no inputs, so there is nothing to bind.
      </p>
    );
  }

  const setBinding = (key: string, raw: string) => {
    const next = { ...bindings };
    if (!raw.trim()) {
      delete next[key];
    } else {
      next[key] = raw;
    }
    onChange(next);
  };

  return (
    <div className="grid gap-3">
      <p className="text-[11px] leading-5 text-muted-foreground">
        Type <kbd className="rounded-control-compact border px-1">@</kbd> to reference another
        node and its metadata.
      </p>
      {keys.map((key) => {
        const current = bindings[key];
        const text =
          current === undefined || current === null
            ? ""
            : typeof current === "string"
              ? current
              : JSON.stringify(current);
        return (
          <FieldRow key={key} label={key}>
            <MentionField
              nodes={options}
              placeholder="Literal text, or @ to reference a node"
              value={text}
              onChange={(next) => setBinding(key, next)}
            />
          </FieldRow>
        );
      })}
    </div>
  );
}

/**
 * Every node that can be referenced, with the values it offers, so the list
 * reads like the canvas rather than like a set of ids.
 */
function available(
  nodes: Node<WorkflowCanvasNodeData>[],
  selfId: string,
  schemas: Map<string, unknown>,
): MentionNode[] {
  const stepMetadata = [
    ["name", "the node's label"],
    ["status", "completed, failed, skipped, not_reached"],
    ["error", "failure message, empty when it succeeded"],
    ["action", "action package name"],
    ["attempt", "which try this was"],
    ["startedAt", "when it started"],
    ["completedAt", "when it finished"],
    ["durationMs", "how long it ran"],
  ] as const;

  const entries: MentionNode[] = [];

  for (const other of nodes) {
    if (other.id === selfId) continue;

    if (other.data.nodeKind === "step") {
      const values: MentionValue[] = [];
      if (other.data.kind === "workflow") {
        const schema = schemas.get(other.id) as
          | { properties?: Record<string, unknown> }
          | undefined;
        for (const field of [
          "outputs",
          ...Object.keys(schema?.properties ?? {}).map(
            (key) => `outputs.${key}`,
          ),
          "status",
          "error",
          "runId",
        ]) {
          values.push({
            expression: `\${steps.${other.id}.${field}}`,
            field,
            hint: field.startsWith("outputs")
              ? "the child workflow's validated public output"
              : "child invocation metadata",
          });
        }
        entries.push({
          id: other.id,
          label: other.data.name?.trim() || "Workflow call",
          kind: "step",
          values,
        });
        continue;
      }
      for (const [field, hint] of stepMetadata) {
        if (!isStepMetadataField(field)) continue;
        values.push({
          expression: `\${steps.${other.id}.${field}}`,
          field,
          hint,
        });
      }
      const manifest = other.data.action?.manifest ?? other.data.manifest ?? {};
      for (const output of Object.keys(
        (manifest.outputs as Record<string, unknown> | undefined) ?? {},
      )) {
        values.push({
          expression: `\${steps.${other.id}.outputs.${output}}`,
          field: `outputs.${output}`,
          hint: "an output, set only when this step succeeds",
        });
      }
      for (const configKey of Object.keys(other.data.config ?? {})) {
        values.push({
          expression: `\${steps.${other.id}.config.${configKey}}`,
          field: `config.${configKey}`,
          hint: `its ${configKey} setting`,
        });
      }
      entries.push({
        id: other.id,
        label: other.data.name?.trim() || other.data.actionPackageName,
        kind: "step",
        values,
      });
    }

    if (other.data.nodeKind === "decision") {
      entries.push({
        id: other.id,
        label: other.data.name?.trim() || "Decision",
        kind: "decision",
        values: (
          [
            ["branch", "the branch it took: true or false"],
            ["result", "the predicate result"],
            ["joinMode", "all or any_settled"],
          ] as const
        ).map(([field, hint]) => ({
          expression: `\${decisions.${other.id}.${field}}`,
          field,
          hint,
        })),
      });
    }
  }

  entries.push({
    id: "__workflow__",
    label: "This workflow",
    kind: "workflow",
    values: [
      {
        expression: "\${workflow.name}",
        field: "name",
        hint: "this workflow's name",
      },
      {
        expression: "\${workflow.runId}",
        field: "runId",
        hint: "this run's id",
      },
      {
        expression: "\${workflow.triggerType}",
        field: "triggerType",
        hint: "how this run started",
      },
    ],
  });
  return entries;
}
