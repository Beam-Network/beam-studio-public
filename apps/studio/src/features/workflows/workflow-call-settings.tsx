import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Node } from "@xyflow/react";
import { apiGet } from "@/lib/api-client";
import { PublicResultPicker } from "./workflow-contract-editor";
import { isStepNode } from "./workflow-graph-model";
import type {
  WorkflowBundle,
  WorkflowCanvasNodeData,
  WorkflowNodeData,
} from "./workflow-graph-types";

export function WorkflowCallSettings({
  node,
  nodes,
  onChange,
}: {
  node: Node<WorkflowNodeData>;
  nodes: Node<WorkflowCanvasNodeData>[];
  onChange(patch: Partial<WorkflowNodeData>): void;
}) {
  const id = node.data.calledWorkflowId;
  const child = useQuery({
    queryKey: ["/studio/workflows", id],
    queryFn: () =>
      apiGet<WorkflowBundle>(`/studio/workflows/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
  });
  const [text, setText] = useState(
    JSON.stringify(node.data.inputBindings, null, 2),
  );
  const [error, setError] = useState("");
  const [field, setField] = useState("");
  const update = (value: string) => {
    setText(value);
    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Input bindings must be an object.");
      onChange({ inputBindings: parsed, inputBindingsError: undefined });
      setError("");
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Invalid bindings JSON.";
      setError(message);
      onChange({ inputBindingsError: message });
    }
  };
  return (
    <div className="grid min-h-0 gap-4 overflow-y-auto p-5">
      <a
        className="text-sm underline"
        href={`/workflows/${encodeURIComponent(id || "")}/editor`}
      >
        {child.data?.template.name || "Open child workflow"}
      </a>
      <p className="text-xs text-muted-foreground">
        This call creates a child run. Its saved definition is frozen when the
        root run starts. Child schedules do not run.
      </p>
      {(node.data.workflowRoom ?? child.data?.template.room) && (
        <p className="rounded-control border p-3 text-sm">
          {node.data.workflowRoom ? "Inherited room" : "Child workflow room"}:{" "}
          {
            (node.data.workflowRoom ?? child.data?.template.room)
              ?.environmentTemplateKey
          }{" "}
          / {(node.data.workflowRoom ?? child.data?.template.room)?.roomId}
        </p>
      )}
      {node.data.workflowRoom &&
        child.data?.template.room &&
        (node.data.workflowRoom.roomId !== child.data.template.room.roomId ||
          node.data.workflowRoom.environmentTemplateKey !==
            child.data.template.room.environmentTemplateKey) && (
          <p role="alert" className="text-sm text-destructive">
            The child workflow room conflicts with the inherited room. Update
            its association before running.
          </p>
        )}
      <label className="grid gap-2 text-sm">
        Call name
        <input
          className="h-10 rounded-control border bg-background px-3"
          value={node.data.name || ""}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </label>
      <label className="grid gap-2 text-sm">
        Input bindings
        <textarea
          className="min-h-32 rounded-control border bg-background p-3 font-mono text-xs"
          value={text}
          onChange={(event) => update(event.target.value)}
          spellCheck={false}
        />
      </label>
      <label className="grid gap-2 text-sm">
        Input property
        <input
          className="h-10 rounded-control border bg-background px-3"
          value={field}
          onChange={(event) => setField(event.target.value)}
        />
      </label>
      <PublicResultPicker
        steps={nodes
          .filter(isStepNode)
          .filter((other) => other.id !== node.id)
          .map((other) => other.data)}
        onSelect={(expression) => {
          if (!field.trim()) {
            setError("Name the child input property to bind.");
            return;
          }
          update(
            JSON.stringify(
              { ...node.data.inputBindings, [field.trim()]: expression },
              null,
              2,
            ),
          );
        }}
      />
      <label className="flex gap-2 text-sm">
        <input
          type="checkbox"
          checked={node.data.required}
          onChange={(event) => onChange({ required: event.target.checked })}
        />
        Required step
      </label>
      <label className="grid gap-2 text-sm">
        Timeout in seconds (empty means no call timeout)
        <input
          className="h-10 rounded-control border bg-background px-3"
          type="number"
          min={1}
          value={node.data.timeoutSeconds ?? ""}
          onChange={(event) =>
            onChange({
              timeoutSeconds: event.target.value
                ? Number(event.target.value)
                : null,
            })
          }
        />
      </label>
      {(error || child.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error || child.error?.message}
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-sm">
          Child input and public output schemas
        </summary>
        <pre className="mt-2 overflow-auto rounded-control border p-3 text-xs">
          {JSON.stringify(
            {
              inputSchema: child.data?.template.inputSchema,
              outputSchema: child.data?.template.output.schema,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </div>
  );
}
