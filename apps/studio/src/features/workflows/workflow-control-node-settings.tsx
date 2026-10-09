import type { ReactNode } from "react";
import type { Node } from "@xyflow/react";
import { Badge } from "@/components/ui/badge";
import type {
  WorkflowControlNodeData,
  WorkflowNodeData,
} from "./workflow-graph-types";

export function ControlNodeSettings({
  node,
  steps,
  onChange,
}: {
  node: Node<WorkflowControlNodeData>;
  steps: Node<WorkflowNodeData>[];
  onChange(patch: Partial<WorkflowControlNodeData>): void;
}) {
  const control = node.data.control;
  const updateControl = (patch: Partial<typeof control>) =>
    onChange({ control: { ...control, ...patch } as typeof control });
  const updateBodySteps = (stepId: string, checked: boolean) => {
    const stepIds = checked
      ? [...new Set([...control.body.stepIds, stepId])]
      : control.body.stepIds.filter((candidate) => candidate !== stepId);
    updateControl({
      body: {
        ...control.body,
        stepIds,
        entryStepId: stepIds.includes(control.body.entryStepId)
          ? control.body.entryStepId
          : (stepIds[0] ?? ""),
        outputStepId: stepIds.includes(control.body.outputStepId)
          ? control.body.outputStepId
          : (stepIds.at(-1) ?? ""),
        edges: control.body.edges.filter(
          (edge) => stepIds.includes(edge.from) && stepIds.includes(edge.to),
        ),
      },
    });
  };

  return (
    <div className="grid max-h-[min(720px,calc(100vh-180px))] gap-5 overflow-y-auto px-1 py-2">
      <div className="rounded-control border bg-muted/25 p-3 text-sm">
        <div className="flex items-center justify-between gap-2">
          <strong>
            {control.kind === "loop" ? "Bounded loop" : "Array fan-out/fan-in"}
          </strong>
          <Badge variant="outline">
            {"initial" in control ? "workflow-graph/v3" : "workflow-graph/v2"}
          </Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          The body steps execute once per iteration or array item. Their
          internal edges are stored inside this dynamic region.
        </p>
      </div>

      {control.kind === "loop" ? (
        <Field
          label="Iterations"
          hint={
            "initial" in control
              ? "Literal maximum from 1 to 128 for V3."
              : "Positive integer or ${workflow.input.…} binding."
          }
        >
          <input
            className="h-9 rounded-control border bg-background px-3 text-sm"
            value={String(control.iterations)}
            onChange={(event) => {
              const value = event.target.value.trim();
              const numeric = Number(value);
              updateControl({
                iterations:
                  value !== "" && Number.isInteger(numeric) ? numeric : value,
              });
            }}
          />
        </Field>
      ) : (
        <>
          <Field
            label="Array binding"
            hint="JSON array or ${workflow.input.…} binding."
          >
            <input
              className="h-9 rounded-control border bg-background px-3 text-sm"
              value={
                typeof control.items === "string"
                  ? control.items
                  : JSON.stringify(control.items)
              }
              onChange={(event) => {
                const value = event.target.value.trim();
                let items: typeof control.items = value;
                if (value.startsWith("[")) {
                  try {
                    const parsed = JSON.parse(value);
                    if (Array.isArray(parsed)) items = parsed;
                  } catch {
                    // Keep the draft string so validation can explain the issue.
                  }
                }
                updateControl({ items });
              }}
            />
          </Field>
          <Field label="Concurrency" hint="Maximum number of active shards.">
            <input
              className="h-9 rounded-control border bg-background px-3 text-sm"
              min={1}
              max={100}
              type="number"
              value={control.concurrency ?? 10}
              onChange={(event) =>
                updateControl({ concurrency: Number(event.target.value) })
              }
            />
          </Field>
        </>
      )}

      <div className="grid gap-2">
        <label className="text-sm font-medium">Region body</label>
        <div className="grid max-h-52 gap-1 overflow-y-auto rounded-control border p-2">
          {steps.length ? (
            steps.map((step) => (
              <label
                className="flex items-center gap-2 rounded-control-compact px-2 py-1.5 text-sm hover:bg-muted"
                key={step.id}
              >
                <input
                  checked={control.body.stepIds.includes(step.id)}
                  onChange={(event) =>
                    updateBodySteps(step.id, event.target.checked)
                  }
                  type="checkbox"
                />
                <span className="min-w-0 truncate">
                  {String(
                    step.data.action?.manifest.displayName ??
                      step.data.actionPackageName,
                  )}
                </span>
                <code className="ml-auto text-[10px] text-muted-foreground">
                  {step.id}
                </code>
              </label>
            ))
          ) : (
            <p className="p-2 text-sm text-muted-foreground">
              Add a wait action before configuring the region body.
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Entry step">
          <select
            className="h-9 rounded-control border bg-background px-3 text-sm"
            value={control.body.entryStepId}
            onChange={(event) =>
              updateControl({
                body: { ...control.body, entryStepId: event.target.value },
              })
            }
          >
            {control.body.stepIds.map((stepId) => (
              <option key={stepId} value={stepId}>
                {stepId}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Output step">
          <select
            className="h-9 rounded-control border bg-background px-3 text-sm"
            value={control.body.outputStepId}
            onChange={(event) =>
              updateControl({
                body: { ...control.body, outputStepId: event.target.value },
              })
            }
          >
            {control.body.stepIds.map((stepId) => (
              <option key={stepId} value={stepId}>
                {stepId}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </div>
  );
}

function Field({
  children,
  hint,
  label,
}: {
  children: ReactNode;
  hint?: string;
  label: string;
}) {
  return (
    <div className="grid gap-1.5">
      <label className="text-sm font-medium">{label}</label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
