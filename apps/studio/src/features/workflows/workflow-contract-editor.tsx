import { useEffect, useState } from "react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { Braces, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiGet, apiSend } from "@/lib/api-client";
import type { WorkflowBundle, WorkflowStep } from "./workflow-graph-types";
import { workflowReferencesSchema } from "@beam-studio/shared";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const pretty = (value: unknown) => JSON.stringify(value, null, 2);

/** Picks only a child's public contract, never its internal graph. */
export function PublicResultPicker({
  steps,
  onSelect,
}: {
  steps: WorkflowStep[];
  onSelect(expression: string): void;
}) {
  const calls = steps.filter(
    (step) => step.kind === "workflow" && step.calledWorkflowId,
  );
  const children = useQueries({
    queries: calls.map((step) => ({
      queryKey: ["/studio/workflows", step.calledWorkflowId],
      queryFn: () =>
        apiGet<WorkflowBundle>(
          `/studio/workflows/${encodeURIComponent(step.calledWorkflowId!)}`,
        ),
    })),
  });
  return (
    <label className="grid gap-2 text-sm">
      Step result
      <select
        className="h-10 rounded-control border bg-background px-3"
        value=""
        onChange={(event) => {
          if (event.target.value) onSelect(event.target.value);
        }}
      >
        <option value="">Select a public result or invocation status…</option>
        {steps.map((step) => {
          const child =
            children[calls.findIndex((call) => call.id === step.id)]?.data;
          const fields =
            step.kind === "workflow"
              ? Object.keys(
                  object(object(child?.template.output?.schema).properties),
                )
              : Object.keys(object(step.manifest?.outputs));
          const expression = (path: string) => `\${steps.${step.id}.${path}}`;
          return (
            <optgroup
              key={step.id}
              label={
                step.name ||
                (step.kind === "workflow"
                  ? child?.template.name || "Workflow call"
                  : step.actionPackageName)
              }
            >
              <option value={expression("outputs")}>
                Public output (whole value)
              </option>
              {fields.map((field) => (
                <option key={field} value={expression(`outputs.${field}`)}>
                  Output: {field}
                </option>
              ))}
              {[
                "status",
                "error",
                ...(step.kind === "workflow" ? ["runId"] : []),
              ].map((field) => (
                <option key={field} value={expression(field)}>
                  Invocation: {field}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
      {children.some((child) => child.isError) && (
        <span className="text-xs text-destructive">
          A child contract is unavailable. Check access to the referenced
          workflow.
        </span>
      )}
    </label>
  );
}

export function WorkflowContractEditor({
  workflow,
}: {
  workflow: WorkflowBundle;
}) {
  const { template } = workflow;
  const cache = useQueryClient();
  const [input, setInput] = useState(pretty(template.inputSchema));
  const [output, setOutput] = useState(pretty(template.output.schema));
  const [bindings, setBindings] = useState(pretty(template.output.bindings));
  const [agents, setAgents] = useState(pretty(template.agentBindings ?? {}));
  const [resources, setResources] = useState(
    pretty(template.resourceBindings ?? {}),
  );
  const [reference, setReference] = useState("");
  const [field, setField] = useState("");
  const [failurePolicy, setFailurePolicy] = useState(template.failurePolicy);
  const [error, setError] = useState("");
  useEffect(() => {
    setInput(pretty(template.inputSchema));
    setOutput(pretty(template.output.schema));
    setBindings(pretty(template.output.bindings));
    setAgents(pretty(template.agentBindings ?? {}));
    setResources(pretty(template.resourceBindings ?? {}));
    setFailurePolicy(template.failurePolicy);
  }, [
    template.id,
    template.inputSchema,
    template.output,
    template.failurePolicy,
    template.agentBindings,
    template.resourceBindings,
  ]);
  const save = useMutation({
    mutationFn: async () =>
      apiSend<WorkflowBundle>("PATCH", `/studio/workflows/${template.id}`, {
        inputSchema: JSON.parse(input),
        output: { schema: JSON.parse(output), bindings: JSON.parse(bindings) },
        failurePolicy,
        ...workflowReferencesSchema.parse({
          agentBindings: JSON.parse(agents),
          resourceBindings: JSON.parse(resources),
        }),
      }),
    onSuccess: (result) => {
      cache.setQueryData(["/studio/workflows", template.id], result);
      setError("");
    },
  });
  const textarea = (
    label: string,
    value: string,
    onChange: (value: string) => void,
  ) => (
    <label className="grid gap-2 text-sm">
      {label}
      <textarea
        className="min-h-24 rounded-control border bg-background p-3 font-mono text-xs"
        value={value}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
  return (
    <details className="group border-t">
      <summary className="flex cursor-pointer list-none items-center gap-3 py-5 [&::-webkit-details-marker]:hidden">
        <Braces className="size-4 text-muted-foreground" aria-hidden />
        <span className="flex-1">
          <span className="block text-sm font-medium">Public contract</span>
          <span className="text-xs text-muted-foreground">
            Advanced inputs, outputs, and bindings
          </span>
        </span>
        <ChevronDown
          className="size-4 transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>
      <div className="grid gap-4 pb-6">
        <p className="text-xs text-muted-foreground">
          Inputs and outputs use JSON Schema draft-07.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          {textarea("Input schema", input, setInput)}
          {textarea("Output schema", output, setOutput)}
        </div>
        {textarea("Output bindings", bindings, setBindings)}
        {textarea("Managed agent bindings", agents, setAgents)}
        <p className="text-xs text-muted-foreground">
          Name each reference, for example:{" "}
          {'{"source": {"agentId": "agent-id"}}'}. Referencing a machine does
          not assign computation to it.
        </p>
        {textarea("Resource bindings", resources, setResources)}
        <p className="text-xs text-muted-foreground">
          Supported kinds: credential, storage, endpoint, room-channel and data.
          Credentials use IDs. For example:{" "}
          {'{"key": {"kind": "credential", "credentialId": "credential-id"}}'}.
        </p>
        <label className="grid gap-2 text-sm">
          Named reference
          <select
            className="h-10 rounded-control border bg-background px-3"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          >
            <option value="">
              Choose a reference for an action configuration or input…
            </option>
            {referenceOptions(agents, resources).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          {reference && (
            <input
              aria-label="Reference expression"
              className="h-10 rounded-control border bg-background px-3 font-mono text-xs"
              readOnly
              value={reference}
              onFocus={(event) => event.target.select()}
            />
          )}
          <span className="text-xs text-muted-foreground">
            Use the expression as a whole JSON string value. Runs freeze these
            references; resource access is checked again during execution.
          </span>
        </label>
        <label className="grid gap-2 text-sm">
          Output property (leave empty to map the whole result)
          <input
            className="h-10 rounded-control border bg-background px-3"
            value={field}
            onChange={(event) => setField(event.target.value)}
          />
        </label>
        <PublicResultPicker
          steps={workflow.steps}
          onSelect={(expression) => {
            try {
              setBindings(
                pretty(
                  field.trim()
                    ? {
                        ...object(JSON.parse(bindings)),
                        [field.trim()]: expression,
                      }
                    : expression,
                ),
              );
              setError("");
            } catch {
              setError("Fix the output bindings JSON before adding a mapping.");
            }
          }}
        />
        <label className="grid gap-2 text-sm">
          Failure policy
          <select
            className="h-10 rounded-control border bg-background px-3"
            value={failurePolicy}
            onChange={(event) =>
              setFailurePolicy(event.target.value as typeof failurePolicy)
            }
          >
            <option value="stop_on_failure">
              Stop after an unhandled required-step failure
            </option>
            <option value="continue_on_failure">
              Continue, then report any unhandled failure
            </option>
          </select>
        </label>
        <p className="text-xs text-muted-foreground">
          There is no implicit last-step output. A workflow call exposes only
          its validated public output. Invocation status, error and child run ID
          are separate.
        </p>
        {(error || save.error) && (
          <p role="alert" className="text-sm text-destructive">
            {error || save.error?.message}
          </p>
        )}
        {save.isSuccess && (
          <p className="text-sm text-muted-foreground">
            Contract saved as an immutable revision.
          </p>
        )}
        <Button
          type="button"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          Save contract
        </Button>
      </div>
    </details>
  );
}

function referenceOptions(agents: string, resources: string): string[] {
  try {
    const references = workflowReferencesSchema.parse({
      agentBindings: JSON.parse(agents),
      resourceBindings: JSON.parse(resources),
    });
    return [
      ...Object.keys(references.agentBindings).map(
        (name) => `\${workflow.agents.${name}.agentId}`,
      ),
      ...Object.entries(references.resourceBindings).flatMap(
        ([name, resource]) => {
          const fields =
            resource.kind === "credential"
              ? ["credentialId"]
              : resource.kind === "storage"
                ? [
                    "endpoint",
                    "endpoint.credentialId",
                    "endpoint.bucket",
                    "endpoint.objectKey",
                  ]
                : resource.kind === "endpoint"
                  ? ["url"]
                  : resource.kind === "data"
                    ? ["value"]
                    : [
                        "room.environmentTemplateKey",
                        "room.roomId",
                        "channelId",
                      ];
          return fields.map(
            (field) => `\${workflow.resources.${name}.${field}}`,
          );
        },
      ),
    ];
  } catch {
    return [];
  }
}
