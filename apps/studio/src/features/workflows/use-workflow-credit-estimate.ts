import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Node } from "@xyflow/react";
import { ApiError } from "@/lib/api-errors";
import { apiSend } from "@/lib/api-client";
import {
  boundEndpointIds,
  isTransferNode,
  projectTransfers,
  type WorkflowCreditEstimate,
} from "./workflow-credit-estimate";
import { fetchStorageObjects } from "./workflow-storage-browser";
import { isStepNode } from "./workflow-graph-model";
import type { WorkflowCanvasNodeData } from "./workflow-graph-types";
import type { WorkflowCreditEstimateState } from "./workflow-credit-estimate-pill";

/** Long enough that typing a bucket name is one estimate, not one per keystroke. */
const SETTLE_MS = 700;

/**
 * Price the workflow currently on the canvas, including unsaved edits.
 *
 * Keyed on what actually moves the price — the transfers, their endpoints and
 * the objects they point at — so moving a node or renaming a step does not
 * re-price, and repricing waits for the graph to settle.
 */
export function useWorkflowCreditEstimate(
  workflowId: string,
  nodes: Node<WorkflowCanvasNodeData>[],
  enabled = true,
): WorkflowCreditEstimateState {
  const signature = useMemo(() => pricingSignature(nodes), [nodes]);
  const [settled, setSettled] = useState(signature);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(signature), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [signature]);

  const query = useQuery({
    queryKey: ["workflow-credit-estimate", workflowId, settled],
    queryFn: async () => {
      const transfers = await projectTransfers(nodes, fetchStorageObjects);
      return apiSend<WorkflowCreditEstimate>(
        "POST",
        `/studio/workflows/${workflowId}/credit-estimate`,
        { transfers },
      );
    },
    // An estimate is a read; a failed one must never look like a failed run.
    enabled,
    retry: false,
    staleTime: 60_000,
  });

  // Stable while the values are: the editor hands this to the header, which
  // stores it in state, so a fresh object every render would loop the two of
  // them against each other until React gives up.
  return useMemo(
    () => ({
      estimate: query.data ?? null,
      pending: query.isFetching,
      unavailable: query.error ? unavailableReason(query.error) : null,
    }),
    [query.data, query.error, query.isFetching],
  );
}

/**
 * Everything that changes the price, and nothing that does not.
 *
 * Endpoint configuration is included because the bytes a transfer delivers
 * follow the objects it points at, and the destination count multiplies them.
 */
function pricingSignature(nodes: Node<WorkflowCanvasNodeData>[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));

  return JSON.stringify(
    nodes.filter(isTransferNode).map((node) => {
      const endpoints = [
        ...boundEndpointIds(node, "sourceEndpoints"),
        ...boundEndpointIds(node, "destinationEndpoints"),
      ];

      return [
        node.id,
        node.data.config.credentialId ?? "",
        boundEndpointIds(node, "destinationEndpoints").length,
        endpoints.map((id) => {
          const endpoint = byId.get(id);
          const config =
            endpoint && isStepNode(endpoint) ? endpoint.data.config : {};
          return [
            id,
            config.credentialId ?? "",
            config.bucket ?? "",
            config.objectKey ?? "",
            config.sourceType ?? "",
            config.objectSize ?? "",
          ];
        }),
      ];
    }),
  );
}

function unavailableReason(error: unknown) {
  if (error instanceof ApiError) {
    if (
      error.code === "api_key_required" ||
      error.code === "insufficient_credit"
    ) {
      return error.message;
    }
    return `Pricing is unavailable right now: ${error.message}`;
  }

  return "Pricing is unavailable right now.";
}
