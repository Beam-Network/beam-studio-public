import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBlocker } from "@tanstack/react-router";
import type { Node } from "@xyflow/react";
import type { WorkflowLayout } from "@beam-studio/shared";
import { apiConditionalGet, apiSend } from "@/lib/api-client";
import {
  WorkflowPositionSync,
  type PositionSyncState,
} from "./workflow-position-sync";
import type {
  WorkflowBundle,
  WorkflowCanvasNodeData,
} from "./workflow-graph-types";

export function savedWorkflowNodeIds(workflow: WorkflowBundle) {
  return [
    ...workflow.steps.map((p) => p.id),
    ...workflow.triggers.map((p) => p.id),
    ...(workflow.decisions ?? []).map((p) => p.id),
    ...(workflow.controls ?? []).flatMap((c) =>
      c.kind === "fan-out" ? [c.id, c.fanInId] : [c.id],
    ),
  ];
}

export function useWorkflowPositionSync(
  workflowId: string,
  enabled: boolean,
  nodes: Node<WorkflowCanvasNodeData>[],
  setNodes: React.Dispatch<
    React.SetStateAction<Node<WorkflowCanvasNodeData>[]>
  >,
  workflow?: WorkflowBundle,
) {
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const [state, setState] = useState<PositionSyncState>({
    pending: false,
    saving: false,
    error: "",
  });
  const syncRef = useRef<WorkflowPositionSync | null>(null);
  const knownRef = useRef<string[]>([]);
  knownRef.current = useMemo(
    () => (workflow ? savedWorkflowNodeIds(workflow) : []),
    [workflow],
  );

  useEffect(() => {
    const path = `/studio/workflows/${workflowId}/layout`;
    const sync = new WorkflowPositionSync(
      {
        read: (revision) =>
          apiConditionalGet<WorkflowLayout>(
            path,
            revision === null
              ? undefined
              : `"layout-${workflowId}-${revision}"`,
            AbortSignal.timeout(10_000),
          ),
        write: (patch) =>
          apiSend("PATCH", path, patch, {
            signal: AbortSignal.timeout(10_000),
          }),
      },
      (layout) => {
        if (syncRef.current !== sync) return;
        const positions = new Map(layout.positions.map((p) => [p.nodeId, p]));
        setNodes((current) => {
          let changed = false;
          const next = current.map((node) => {
            const position = positions.get(node.id);
            if (
              !position ||
              position.x === null ||
              position.y === null ||
              node.dragging ||
              sync.protects(node.id) ||
              (Math.fround(node.position.x) === Math.fround(position.x) &&
                Math.fround(node.position.y) === Math.fround(position.y))
            )
              return node;
            changed = true;
            return { ...node, position: { x: position.x, y: position.y } };
          });
          return changed ? next : current;
        });
      },
      (next) => {
        if (syncRef.current === sync) setState((current) =>
          current.pending === next.pending && current.saving === next.saving && current.error === next.error ? current : next);
      },
    );
    sync.setKnown(knownRef.current);
    syncRef.current = sync;
    setState({ pending: false, saving: false, error: "" });
    return () => {
      void sync
        .flush()
        .finally(() => sync.dispose())
        .catch(() => {});
      syncRef.current = null;
    };
  }, [workflowId, setNodes]);

  useEffect(() => {
    syncRef.current?.setKnown(knownRef.current);
  }, [workflow]);
  useEffect(() => {
    const update = () =>
      syncRef.current?.setActive(
        enabled && document.visibilityState === "visible",
      );
    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("online", update);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!syncRef.current?.hasPending) return;
      void syncRef.current.flush().catch(() => {});
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      syncRef.current?.setActive(false);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("online", update);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [enabled, workflowId]);

  const queue = useCallback((moved: Node<WorkflowCanvasNodeData>[]) => {
    syncRef.current?.enqueue(
      moved.map((node) => ({ nodeId: node.id, ...node.position })),
    );
  }, []);
  const flush = useCallback(async () => {
    await syncRef.current?.flush();
  }, []);
  useBlocker({
    shouldBlockFn: async () => {
      try {
        await flush();
        return false;
      } catch {
        return true;
      }
    },
    enableBeforeUnload: false,
  });
  const definitionSaved = useCallback(
    (
      saved: WorkflowBundle,
      positions: { nodeId: string; x: number; y: number }[],
    ) => {
      const sync = syncRef.current;
      if (!sync) return;
      sync.setKnown(savedWorkflowNodeIds(saved));
      const before = new Map(
        positions.map((position) => [position.nodeId, position]),
      );
      const moved = nodesRef.current.filter((node) => {
        const position = before.get(node.id);
        return (
          position &&
          (Math.fround(position.x) !== Math.fround(node.position.x) ||
            Math.fround(position.y) !== Math.fround(node.position.y))
        );
      });
      queue(moved);
      sync.refresh();
    },
    [queue],
  );
  return { ...state, queue, flush, definitionSaved };
}
