import type { Node } from "@xyflow/react";
import { Plus } from "lucide-react";
import {
  BEAM_TRANSFER_FOLDER_SOURCE_ISSUE,
  isFolderEndpointConfig,
} from "@beam-studio/core/workflows/graph-semantics";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { OBJECT_STORAGE_ENDPOINT_ACTION } from "./workflow-graph-constants";
import { stringValue } from "./workflow-config-schema";
import { ActionNodeSettings } from "./workflow-action-node-settings";
import { WorkflowCallSettings } from "./workflow-call-settings";
import { ControlNodeSettings } from "./workflow-control-node-settings";
import { DecisionNodeSettings } from "./workflow-decision-node-settings";
import { ObjectStorageEndpointSettings } from "./workflow-object-storage-endpoint-settings";
import { isBeamTransferSourceEndpoint } from "./workflow-graph-validation";
import {
  isControlNode,
  isDecisionNode,
  isStepNode,
  isTriggerNode,
} from "./workflow-graph-model";
import type {
  BeamTransferEndpointRole,
  CredentialRecord,
  WorkflowCanvasNodeData,
  WorkflowNodeData,
} from "./workflow-graph-types";

export function NodeInfoDialog({
  credentials,
  node,
  nodes,
  steps,
  onNodeChange,
  onOpenChange,
}: {
  credentials: CredentialRecord[];
  node: Node<WorkflowCanvasNodeData> | null;
  nodes: Node<WorkflowCanvasNodeData>[];
  steps: Node<WorkflowNodeData>[];
  onNodeChange(nodeId: string, patch: Partial<WorkflowCanvasNodeData>): void;
  onOpenChange(open: boolean): void;
}) {
  const infoNode = node && !isTriggerNode(node) ? node : null;
  const stepNode = infoNode && isStepNode(infoNode) ? infoNode : null;
  const controlNode = infoNode && isControlNode(infoNode) ? infoNode : null;
  const decisionNode = infoNode && isDecisionNode(infoNode) ? infoNode : null;
  const manifest =
    stepNode?.data.action?.manifest ?? stepNode?.data.manifest ?? {};
  const displayName = String(
    (controlNode?.data.role === "loop"
      ? "Bounded loop"
      : controlNode?.data.role === "fan-in"
        ? "Deterministic fan-in"
        : controlNode
          ? "Array fan-out"
          : decisionNode
            ? decisionNode.data.name || "Decision"
            : undefined) ??
      manifest.displayName ??
      (stepNode?.data.kind === "workflow"
        ? stepNode.data.name || "Workflow call"
        : stepNode?.data.actionPackageName) ??
      "Step",
  );
  const isObjectStorageEndpoint =
    stepNode?.data.actionPackageName === OBJECT_STORAGE_ENDPOINT_ACTION;
  const isActionNode = Boolean(stepNode && !isObjectStorageEndpoint);
  // Echo the choice back, so the button confirms something visible rather than
  // closing a dialog whose selection the operator has to take on trust.
  const endpointBucket = stringValue(stepNode?.data.config?.bucket);
  const endpointObjectKey = stringValue(stepNode?.data.config?.objectKey);
  const endpointSummary =
    endpointBucket && endpointObjectKey
      ? `${endpointBucket}/${endpointObjectKey}`
      : endpointBucket || "";

  return (
    <Dialog open={Boolean(infoNode)} onOpenChange={onOpenChange}>
      <DialogContent
        className={
          isObjectStorageEndpoint
            ? "grid h-[min(860px,calc(100vh-32px))] w-[min(1180px,calc(100vw-24px))] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0"
            : isActionNode
              ? "grid h-[min(760px,calc(100dvh-24px))] w-[min(800px,calc(100vw-24px))] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0"
              : undefined
        }
      >
        <DialogHeader
          className={
            isObjectStorageEndpoint || isActionNode
              ? "min-w-0 break-words border-b px-5 py-4 pr-12"
              : undefined
          }
        >
          <DialogTitle>{displayName}</DialogTitle>
          <DialogDescription>
            {controlNode
              ? `${controlNode.data.control.kind}.${controlNode.data.controlId}`
              : decisionNode
                ? `decision.${decisionNode.data.decisionId}`
                : stepNode?.data.actionPackageName}
          </DialogDescription>
        </DialogHeader>
        {controlNode ? (
          <ControlNodeSettings
            node={controlNode}
            steps={steps}
            onChange={(patch) => onNodeChange(controlNode.id, patch)}
          />
        ) : decisionNode ? (
          <DecisionNodeSettings
            key={decisionNode.id}
            node={decisionNode}
            nodes={nodes}
            onChange={(patch) => onNodeChange(decisionNode.id, patch)}
          />
        ) : isObjectStorageEndpoint && stepNode ? (
          <ObjectStorageEndpointSettings
            credentials={credentials}
            fileOnly={isBeamTransferSourceEndpoint(nodes, stepNode.id)}
            node={stepNode}
            onChange={(patch) => onNodeChange(stepNode.id, patch)}
          />
        ) : stepNode?.data.kind === "workflow" ? (
          <WorkflowCallSettings
            key={stepNode.id}
            node={stepNode}
            nodes={nodes}
            onChange={(patch) => onNodeChange(stepNode.id, patch)}
          />
        ) : stepNode ? (
          <ActionNodeSettings
            key={stepNode.id}
            credentials={credentials}
            node={stepNode}
            nodes={nodes}
            onChange={(patch) => onNodeChange(stepNode.id, patch)}
          />
        ) : null}
        <div
          className={
            isObjectStorageEndpoint || isActionNode
              ? "flex flex-wrap items-center justify-between gap-3 border-t px-5 py-4"
              : "mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4"
          }
        >
          <p className="text-xs text-muted-foreground">
            {isObjectStorageEndpoint
              ? endpointSummary
                ? `Using ${endpointSummary}.`
                : "Select a credential, bucket, and object."
              : "Changes apply as you edit them."}
          </p>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function EndpointCreateDialog({
  credentials,
  node,
  onCancel,
  onCreate,
  onNodeChange,
  role,
}: {
  credentials: CredentialRecord[];
  node: Node<WorkflowNodeData> | null;
  onCancel(): void;
  onCreate(node: Node<WorkflowNodeData>): void;
  onNodeChange(patch: Partial<WorkflowNodeData>): void;
  role?: BeamTransferEndpointRole;
}) {
  // Unmounted with its draft rather than animated closed: a closing dialog
  // whose draft is gone rendered as an empty "Add storage endpoint" shell,
  // and its overlay kept blocking the canvas when the exit animation stalled.
  if (!node) return null;
  const folderSource =
    role === "source" && isFolderEndpointConfig(node.data.config);
  const canCreate = isEndpointConfigured(node) && !folderSource;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
    >
      <DialogContent className="grid h-[min(860px,calc(100vh-32px))] w-[min(1180px,calc(100vw-24px))] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-4 pr-12">
          <DialogTitle>
            Add {role ? `${role} ` : ""}storage endpoint
          </DialogTitle>
          <DialogDescription>
            {role
              ? `Configure and connect this endpoint as a transfer ${role}.`
              : "Connect a file or folder from your object storage as a workflow endpoint."}
          </DialogDescription>
        </DialogHeader>
        <ObjectStorageEndpointSettings
          credentials={credentials}
          fileOnly={role === "source"}
          node={node}
          onChange={onNodeChange}
        />
        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-4">
          <p
            className={
              folderSource
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {folderSource
              ? BEAM_TRANSFER_FOLDER_SOURCE_ISSUE
              : canCreate
                ? "Ready to add."
                : "Select a credential, bucket, and object to continue."}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              disabled={!canCreate}
              type="button"
              onClick={() => onCreate(node)}
            >
              <Plus className="h-4 w-4" />
              Add endpoint
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function isEndpointConfigured(node: Node<WorkflowNodeData>) {
  const config = node.data.config;
  return Boolean(
    stringValue(config.credentialId) &&
    stringValue(config.bucket) &&
    stringValue(config.objectKey),
  );
}
