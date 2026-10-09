import { useEffect, useMemo, useRef, useState } from "react";
import type { Node } from "@xyflow/react";
import { workflowPredicateError } from "@beam-studio/core/workflows/decisions";
import { workflowSwitchNodeDefinition } from "@beam-studio/core/workflows/graph-semantics";
import { Button } from "@/components/ui/button";
import {
  FieldRow,
  NativeSelect,
  TextArea,
  TextInput,
  ToggleRow,
} from "./workflow-form-controls";
import {
  PredicateBuilder,
  predicateMentionNodes,
} from "./workflow-predicate-builder";
import {
  emptyGroup,
  parsePredicate,
  serializePredicate,
  type PredicateGroup,
} from "./workflow-predicate-model";
import { shortId } from "./workflow-graph-model";
import type {
  WorkflowCanvasNodeData,
  WorkflowDecisionNodeData,
} from "./workflow-graph-types";

export function DecisionNodeSettings({
  node,
  nodes,
  onChange,
}: {
  node: Node<WorkflowDecisionNodeData>;
  nodes: Node<WorkflowCanvasNodeData>[];
  onChange(patch: Partial<WorkflowDecisionNodeData>): void;
}) {
  const data = node.data;
  const mentionNodes = useMemo(
    () => predicateMentionNodes(nodes, node.id),
    [nodes, node.id],
  );
  const updateCases = (cases: WorkflowDecisionNodeData["cases"]) => {
    onChange({ cases, definition: workflowSwitchNodeDefinition(cases) });
  };

  return (
    <div className="grid max-h-[min(720px,calc(100vh-180px))] gap-5 overflow-y-auto px-1 py-2">
      <FieldRow label="Name">
        <TextInput
          value={data.name}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </FieldRow>

      <FieldRow
        label="Continue when"
        hint="Both modes wait for every input to finish before the gateway resolves."
      >
        <NativeSelect
          value={data.joinMode}
          onChange={(event) =>
            onChange({
              joinMode: event.target
                .value as WorkflowDecisionNodeData["joinMode"],
            })
          }
        >
          <option value="all">Every input succeeded</option>
          <option value="any_settled">
            Any input succeeded (still waits for all)
          </option>
        </NativeSelect>
      </FieldRow>

      {data.kind === "switch" ? (
        <div className="grid gap-3">
          <div>
            <div className="text-sm font-medium">Ordered cases</div>
            <p className="text-xs leading-5 text-muted-foreground">
              The first matching case wins. Default runs when none match.
            </p>
          </div>
          {data.cases.map((entry, index) => (
            <div
              className="grid gap-3 rounded-control border p-3"
              key={entry.id}
            >
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                    Case {index + 1}
                  </div>
                  <TextInput
                    aria-label={`Case ${index + 1} name`}
                    value={entry.name}
                    onChange={(event) =>
                      updateCases(
                        data.cases.map((candidate) =>
                          candidate.id === entry.id
                            ? { ...candidate, name: event.target.value }
                            : candidate,
                        ),
                      )
                    }
                  />
                </div>
                <Button
                  disabled={index === 0}
                  onClick={() =>
                    updateCases(moveCase(data.cases, index, index - 1))
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Up
                </Button>
                <Button
                  disabled={index === data.cases.length - 1}
                  onClick={() =>
                    updateCases(moveCase(data.cases, index, index + 1))
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Down
                </Button>
                <Button
                  disabled={data.cases.length === 1}
                  onClick={() =>
                    updateCases(
                      data.cases.filter(
                        (candidate) => candidate.id !== entry.id,
                      ),
                    )
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Remove
                </Button>
              </div>
              <PredicateEditor
                key={entry.id}
                label="Case condition"
                mentionNodes={mentionNodes}
                value={entry.predicate}
                onChange={(predicate) =>
                  updateCases(
                    data.cases.map((candidate) =>
                      candidate.id === entry.id
                        ? { ...candidate, predicate: predicate ?? false }
                        : candidate,
                    ),
                  )
                }
              />
            </div>
          ))}
          <Button
            className="justify-self-start"
            onClick={() =>
              updateCases([
                ...data.cases,
                {
                  id: `case_${shortId()}`,
                  name: `Case ${data.cases.length + 1}`,
                  predicate: false,
                },
              ])
            }
            type="button"
            variant="outline"
          >
            Add case
          </Button>
          <div className="rounded-control border border-dashed p-3 text-xs text-muted-foreground">
            Default is mandatory and has no condition.
          </div>
        </div>
      ) : (
        <PredicateEditor
          label="Condition"
          mentionNodes={mentionNodes}
          value={data.predicate}
          onChange={(predicate) => onChange({ predicate })}
        />
      )}

      <div className="grid gap-3 rounded-control border bg-muted/20 p-3">
        <ToggleRow
          checked={data.enabled}
          label="Enabled"
          onCheckedChange={(checked) => onChange({ enabled: checked })}
        />
        <ToggleRow
          checked={data.handleFailure}
          label="Mark upstream failure as handled"
          onCheckedChange={(checked) => onChange({ handleFailure: checked })}
        />
        <p className="text-xs leading-5 text-muted-foreground">
          A failed input still appears as failed, but an evaluation that reaches
          this gateway can absorb it so the overall run may recover.
        </p>
      </div>

      {data.issues.length ? (
        <div className="rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {data.issues.join(" ")}
        </div>
      ) : null}
    </div>
  );
}

function PredicateEditor({
  label,
  mentionNodes,
  value,
  onChange,
}: {
  label: string;
  mentionNodes: ReturnType<typeof predicateMentionNodes>;
  value: unknown;
  onChange(value: unknown): void;
}) {
  const parsed = useMemo(() => parsePredicate(value), [value]);
  const [group, setGroup] = useState<PredicateGroup>(
    () => parsed ?? emptyGroup(),
  );
  const [jsonMode, setJsonMode] = useState(() => parsed === null);
  const [jsonDraft, setJsonDraft] = useState(() =>
    value == null ? "" : JSON.stringify(value, null, 2),
  );
  const [jsonError, setJsonError] = useState<string | null>(null);
  const lastEmitted = useRef(JSON.stringify(value ?? null));

  useEffect(() => {
    const incoming = JSON.stringify(value ?? null);
    if (incoming === lastEmitted.current) return;
    lastEmitted.current = incoming;
    const next = parsePredicate(value);
    if (next) setGroup(next);
    else setJsonMode(true);
    setJsonDraft(value == null ? "" : JSON.stringify(value, null, 2));
    setJsonError(null);
  }, [value]);

  const commitBuilder = (next: PredicateGroup) => {
    setGroup(next);
    const predicate = serializePredicate(next);
    lastEmitted.current = JSON.stringify(predicate ?? null);
    setJsonDraft(predicate == null ? "" : JSON.stringify(predicate, null, 2));
    onChange(predicate);
  };
  const commitJson = (raw: string) => {
    setJsonDraft(raw);
    if (!raw.trim()) {
      setJsonError(null);
      lastEmitted.current = "null";
      setGroup(emptyGroup());
      onChange(null);
      return;
    }
    try {
      const next: unknown = JSON.parse(raw);
      const error = workflowPredicateError(next);
      if (error) {
        setJsonError(error);
        return;
      }
      setJsonError(null);
      lastEmitted.current = JSON.stringify(next);
      const nextGroup = parsePredicate(next);
      if (nextGroup) setGroup(nextGroup);
      onChange(next);
    } catch {
      setJsonError("That is not valid JSON.");
    }
  };

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <button
          className="text-[11px] text-muted-foreground underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          disabled={parsed === null}
          onClick={() => setJsonMode((current) => !current)}
          type="button"
        >
          {jsonMode ? "Use the builder" : "Edit as JSON"}
        </button>
      </div>
      {jsonMode || parsed === null ? (
        <TextArea
          className="min-h-32 font-mono text-xs"
          placeholder="{}"
          value={jsonDraft}
          onChange={(event) => commitJson(event.target.value)}
        />
      ) : (
        <PredicateBuilder
          group={group}
          mentionNodes={mentionNodes}
          onChange={commitBuilder}
        />
      )}
      {jsonError ? (
        <p className="text-xs text-destructive">{jsonError}</p>
      ) : null}
    </div>
  );
}

function moveCase<T>(entries: T[], from: number, to: number) {
  if (to < 0 || to >= entries.length) return entries;
  const next = [...entries];
  const [entry] = next.splice(from, 1);
  if (entry !== undefined) next.splice(to, 0, entry);
  return next;
}
