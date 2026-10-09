import {
  workflowActionsOptions,
  workflowDefinitionOptions,
  workflowListOptions,
} from "./workflow-queries";
import { BudgetAlertBar } from "@/features/billing/budget-alert-bar";
import { buildNodes } from "./workflow-graph-model";
import {
  isWorkflowTemplateId,
  workflowTemplateDraft,
} from "./workflow-creation";
import { useWorkflowPositionSync } from "./use-workflow-position-sync";
import { workflowDefinitionSignature } from "./workflow-definition-signature";
import type { PositionSyncState } from "./workflow-position-sync";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyEdgeChanges,
  applyNodeChanges,
  MarkerType,
  type Connection,
  type Edge,
  type Node,
  type OnEdgesChange,
  type OnNodesChange,
} from "@xyflow/react";
import {
  reconcileSaveResponse,
  type SaveRequestContext,
} from "./workflow-save-reconciliation";
import type {
  AssistantProviderSummary,
  AssistantReasoningEffort,
  AssistantWorkflowPatchOperation,
  AssistantWorkflowPlan,
} from "@beam-studio/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { latestActionPackagesByName } from "@beam-studio/core/workflows/action-versions";
import type {
  WorkflowGraphV3Distribution,
  WorkflowGraphV3LoopControl,
} from "@beam-studio/core/workflows/graph-v3";
import { AlertTriangle } from "lucide-react";
import { GraphActionBarLoading } from "./workflow-graph-toolbar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StudioAssistantChat } from "@/components/studio-assistant-chat";
import { ApiError } from "@/lib/api-errors";
import { apiGet, apiSend } from "@/lib/api-client";
import { WorkflowEditorCanvas } from "./workflow-editor-canvas";
import { planWorkflowConnection } from "./workflow-connection-planner";
import {
  firstActionTriggerConnection,
  nextNodePosition,
} from "./workflow-action-placement";
import { applyAssistantWorkflowPatch } from "./workflow-assistant-patch";
import { workflowDefinitionFromBundle } from "./workflow-header";
import { WorkflowOverview } from "./workflow-overview";
import { WorkflowSettings } from "./workflow-settings";
import { WorkflowRoomSettings } from "./workflow-room-settings";
import { WorkflowCallPickerDialog } from "./workflow-call-picker-dialog";
import { WorkflowExecutions } from "./workflow-executions";
import { WorkflowDistributionEditor } from "./workflow-distribution-editor";
import {
  distributionValidationError,
  emptyDistribution,
} from "./workflow-distribution";
import { WorkflowTriggerPickerDialog } from "./workflow-trigger-picker-dialog";
import {
  prepareWorkflowTriggerEditorSubmit,
  type WorkflowTriggerEditorSubmit,
} from "./workflow-trigger-editor-state";
import type { RegistryData } from "@/features/registry/registry-data";
import {
  duplicateStepNode,
  duplicateDecisionNode,
  createLinearTemplateGraph,
} from "./workflow-graph-operations";
import { layoutWorkflowWithElk } from "./workflow-elk-layout";
import {
  workflowLayoutSignature,
  type WorkflowLayoutHandles,
} from "./workflow-layout-routing";
import {
  builtinWorkflowTemplates,
  type BuiltinWorkflowTemplate,
} from "./workflow-templates";
import { useWorkflowCreditEstimate } from "./use-workflow-credit-estimate";
import { WorkflowLeaveGuard } from "./workflow-leave-guard";
import { workflowBillingKey } from "./workflow-billing-key";
import type { WorkflowCreditEstimateState } from "./workflow-credit-estimate-pill";
import {
  BEAM_TRANSFER_DESTINATION_HANDLE,
  BEAM_TRANSFER_ACTION,
  BEAM_TRANSFER_SOURCE_HANDLE,
  FAN_OUT_ACTION,
  JOIN_ACTION,
  OBJECT_STORAGE_ENDPOINT_ACTION,
} from "./workflow-graph-constants";
import {
  applyAutomaticBinding,
  automaticBindingPlan,
  removeAutomaticBinding,
} from "./workflow-graph-bindings";
import {
  applyWorkflowEdgePresentation,
  createNode,
  createControlNodes,
  createDecisionNode,
  createSwitchNode,
  createTrigger,
  decorateEdge,
  decorateTriggerEdge,
  edgeRuntimeSource,
  edgeRuntimeTarget,
  isStepNode,
  isControlNode,
  isDecisionNode,
  isTriggerEdge,
  isTriggerNode,
  presentationGraphFromWorkflowBundle,
  repairMissingWorkflowGraphReferences,
  shortId,
  toDraftPayload,
} from "./workflow-graph-model";
import {
  createWorkflowGraphClipboardPayload,
  materializeWorkflowGraphClipboardPayload,
  parseWorkflowGraphClipboardPayload,
  WORKFLOW_GRAPH_CLIPBOARD_KEY,
} from "./workflow-graph-clipboard";
import { useWorkflowGraphShortcuts } from "./workflow-graph-shortcuts";
import {
  resolveWorkflowStepAction,
  validateActionVersions,
  validateGraph,
} from "./workflow-graph-validation";
import type {
  ActionPackage,
  ActionSort,
  AutomaticBindingPlan,
  BeamTransferEndpointRole,
  CredentialsIndex,
  GraphControlMode,
  WorkflowCanvasNodeData,
  WorkflowBundle,
  WorkflowActionLockChange,
  WorkflowNodeData,
  WorkflowTab,
  WorkflowDecisionNodeData,
  WorkflowTriggerNodeData,
  WorkflowTriggerType,
} from "./workflow-graph-types";

type GraphSnapshot = {
  edges: Edge[];
  nodes: Node<WorkflowCanvasNodeData>[];
  distribution: WorkflowGraphV3Distribution | null;
};

type WorkflowGraphSavePayload = ReturnType<typeof toDraftPayload>;

type EndpointDraftConnection = {
  role: BeamTransferEndpointRole;
  transferNodeId: string;
};

type AssistantWorkflowDraftResponse = AssistantWorkflowPlan & {
  degraded?: boolean;
  error?: string;
  provider?: AssistantProviderSummary;
  providerMessage?: string;
};

type AssistantWorkflowDraftResult = {
  applied: boolean;
  assumptions: string[];
  degraded?: boolean;
  id: string;
  message: string;
  needsInput: string[];
  patchErrors: string[];
  plan: string[];
  provider?: AssistantProviderSummary;
  providerMessage?: string;
  risks: string[];
};

type CanvasPosition = { x: number; y: number };
type AssistantLanguage = "en" | "fr";

export type WorkflowEditorHeaderControls = {
  cleanPending: boolean;
  /** What a run would cost, so the price sits next to the button that spends it. */
  creditEstimate: WorkflowCreditEstimateState;
  hasUnsavedChanges: boolean;
  onCleanTemplate(): void;
  onCopyDefinition(): void;
  onCopyFullJson(): void;
  onOpenTemplates(): void;
  onRun(): void;
  onSave(): void;
  runPending: boolean;
  saveDisabled: boolean;
  savePending: boolean;
  positionSaveState?: PositionSyncState;
  onRetryPositions?(): void;
};

export function WorkflowGraphEditor({
  activeTab: activeTabProp,
  onHeaderControlsChange,
  onOpenEditor,
  workflowId,
}: {
  activeTab?: WorkflowTab;
  onHeaderControlsChange?: (
    controls: WorkflowEditorHeaderControls | null,
  ) => void;
  onOpenEditor?: () => void;
  workflowId: string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const activeTab = activeTabProp ?? "editor";
  const requestedEditTriggerId = useMemo(
    () => new URLSearchParams(location.searchStr).get("editTrigger"),
    [location.searchStr],
  );
  const requestedTemplateId = useMemo(
    () => new URLSearchParams(location.searchStr).get("template"),
    [location.searchStr],
  );
  const workflowQuery = useQuery(workflowDefinitionOptions(workflowId));
  const [nodes, setNodes] = useState<Node<WorkflowCanvasNodeData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [distribution, setDistribution] =
    useState<WorkflowGraphV3Distribution | null>(null);
  const [distributionOpen, setDistributionOpen] = useState(false);
  const [infoNode, setInfoNode] = useState<Node<WorkflowCanvasNodeData> | null>(
    null,
  );
  const [triggerEditorNodeId, setTriggerEditorNodeId] = useState<string | null>(
    null,
  );
  const [endpointDraftNode, setEndpointDraftNode] =
    useState<Node<WorkflowNodeData> | null>(null);
  const [endpointDraftConnection, setEndpointDraftConnection] =
    useState<EndpointDraftConnection | null>(null);
  const [actionCatalogOpen, setActionCatalogOpen] = useState(false);
  const [workflowPickerOpen, setWorkflowPickerOpen] = useState(false);
  const [roomPickerOpen, setRoomPickerOpen] = useState(false);
  // A node just added from the catalog, which the canvas brings into view.
  const [revealNodeId, setRevealNodeId] = useState<string | null>(null);
  const clearRevealNode = useCallback(() => setRevealNodeId(null), []);
  const [pendingActionPosition, setPendingActionPosition] =
    useState<CanvasPosition | null>(null);
  const [templateCatalogOpen, setTemplateCatalogOpen] = useState(false);
  const [templateError, setTemplateError] = useState("");
  const [graphLoadError, setGraphLoadError] = useState("");
  const [actionSearch, setActionSearch] = useState("");
  const [actionSort, setActionSort] = useState<ActionSort>("name");
  const [controlMode, setControlMode] = useState<GraphControlMode>("select");
  const [hydratedWorkflowId, setHydratedWorkflowId] = useState<string | null>(
    null,
  );
  const [savedGraphSignature, setSavedGraphSignature] = useState("");
  const [pendingLockChanges, setPendingLockChanges] = useState<
    WorkflowActionLockChange[]
  >([]);
  const [pendingRepairLockChanges, setPendingRepairLockChanges] = useState<
    WorkflowActionLockChange[]
  >([]);
  const confirmLockChangesRef = useRef(false);
  const [assistantMetadataDraft, setAssistantMetadataDraft] = useState<{
    description?: string;
    enabled?: boolean;
    name?: string;
  }>({});
  const actionsQuery = useQuery({
    ...workflowActionsOptions(),
    enabled: activeTab === "editor",
  });
  const sourcesQuery = useQuery(workflowListOptions());
  const credentialsQuery = useQuery({
    queryKey: ["/studio/credentials"],
    queryFn: () => apiGet<CredentialsIndex>("/studio/credentials"),
    enabled:
      activeTab === "editor" &&
      Boolean(infoNode || endpointDraftNode || actionCatalogOpen),
    staleTime: 30_000,
  });
  const localRegistryQuery = useQuery({
    queryKey: ["/studio/registry"],
    queryFn: () => apiGet<RegistryData>("/studio/registry"),
    enabled: actionCatalogOpen,
    staleTime: 60_000,
  });
  const publicRegistryQuery = useQuery({
    queryKey: ["/studio/registry/public"],
    queryFn: () => apiGet<RegistryData>("/studio/registry/public"),
    enabled: actionCatalogOpen,
    staleTime: 60_000,
  });
  const savedActions = useMemo(
    () =>
      (workflowQuery.data?.steps ?? []).flatMap((step): ActionPackage[] =>
        step.manifest
          ? [
              {
                id: step.actionPackageName,
                name: step.actionPackageName,
                version: String(
                  step.manifest.version ?? step.actionVersionRange,
                ),
                manifest: step.manifest,
                checksum: "",
              },
            ]
          : [],
      ),
    [workflowQuery.data?.steps],
  );
  const actions = actionsQuery.data?.actions ?? savedActions;
  const credentials = credentialsQuery.data?.credentials ?? [];
  const sourceWorkflows = (sourcesQuery.data?.workflows ?? []).filter(
    (workflow) => workflow.id !== workflowId,
  );
  const actionsByName = useMemo(
    () => latestActionPackagesByName([...actions, ...savedActions]),
    [actions, savedActions],
  );
  const credentialsById = useMemo(
    () => new Map(credentials.map((credential) => [credential.id, credential])),
    [credentials],
  );
  const undoStackRef = useRef<GraphSnapshot[]>([]);
  const redoStackRef = useRef<GraphSnapshot[]>([]);
  const [historyRevision, setHistoryRevision] = useState(0);
  const nodeDragHistoryRecordedRef = useRef(false);
  const dragPositionsRef = useRef(new Map<string, CanvasPosition>());
  const pasteCountRef = useRef(0);
  const assistantDraftRef = useRef<{
    before: GraphSnapshot;
    beforeMetadata: {
      description?: string;
      enabled?: boolean;
      name?: string;
    };
    id: string;
  } | null>(null);
  const [assistantLayoutRequest, setAssistantLayoutRequest] = useState(0);
  const endpointAction = useMemo(
    () =>
      actions.find(
        (action) => action.name === OBJECT_STORAGE_ENDPOINT_ACTION,
      ) ?? null,
    [actions],
  );
  const openEndpointDraft = useCallback(
    (position?: CanvasPosition, connection?: EndpointDraftConnection) => {
      if (!endpointAction) {
        return;
      }
      let draftPosition = position;
      if (connection) {
        const transfer = nodes.find(
          (node) => node.id === connection.transferNodeId,
        );
        if (!transfer) {
          return;
        }
        const connectedCount = edges.filter(
          (edge) =>
            edge.data?.compositeNodeId === transfer.id &&
            edge.data?.membershipRole ===
              (connection.role === "source"
                ? "sourceEndpoints"
                : "destinationEndpoints"),
        ).length;
        draftPosition = {
          x: transfer.position.x + (connection.role === "source" ? -420 : 420),
          y: transfer.position.y + connectedCount * 176,
        };
      }
      const draft = createNode(
        endpointAction,
        nodes.length,
        "endpoint",
        draftPosition,
      );
      if (connection) {
        draft.data.config = {
          ...draft.data.config,
          name:
            connection.role === "source"
              ? "Source endpoint"
              : "Destination endpoint",
        };
      }
      setEndpointDraftConnection(connection ?? null);
      setEndpointDraftNode(draft);
    },
    [edges, endpointAction, nodes],
  );
  const graphStateFromWorkflow = useCallback(
    (workflow: WorkflowBundle) => {
      const nextDistribution =
        workflow.graph.version === "workflow-graph/v3"
          ? workflow.graph.distribution
          : null;
      const presentation = presentationGraphFromWorkflowBundle(
        workflow,
        actionsByName,
      );
      const sanitizedPayload = toDraftPayload(
        presentation.nodes,
        presentation.edges,
        workflow.template.graphVersion,
        nextDistribution ?? undefined,
      );
      const rawTriggerEdgePayload =
        workflow.triggerEdges.map(triggerEdgePayload);
      const savedSignature =
        graphSignature(rawTriggerEdgePayload) ===
        graphSignature(sanitizedPayload.triggerEdges)
          ? workflowDefinitionSignature(sanitizedPayload)
          : workflowDefinitionSignature({
              ...sanitizedPayload,
              triggerEdges: rawTriggerEdgePayload,
            });
      return {
        nextEdges: presentation.edges,
        nextNodes: presentation.nodes,
        nextDistribution,
        savedSignature,
      };
    },
    [actionsByName],
  );

  useEffect(() => {
    if (
      workflowQuery.data &&
      hydratedWorkflowId !== workflowQuery.data.template.id
    ) {
      try {
        const { nextEdges, nextNodes, nextDistribution, savedSignature } =
          graphStateFromWorkflow(workflowQuery.data);
        setNodes(nextNodes);
        setEdges(nextEdges);
        setDistribution(nextDistribution);
        undoStackRef.current = [];
        redoStackRef.current = [];
        assistantDraftRef.current = null;
        setTriggerEditorNodeId(null);
        setAssistantMetadataDraft({});
        setSavedGraphSignature(savedSignature);
        setGraphLoadError("");
        setHydratedWorkflowId(workflowQuery.data.template.id);
      } catch (error) {
        setNodes([]);
        setEdges([]);
        setDistribution(null);
        setSavedGraphSignature("");
        setGraphLoadError(workflowGraphLoadErrorMessage(error));
      }
    }
  }, [graphStateFromWorkflow, hydratedWorkflowId, workflowQuery.data]);

  useEffect(() => {
    if (!infoNode || !isTriggerNode(infoNode)) {
      return;
    }
    setInfoNode(null);
    setTriggerEditorNodeId(infoNode.id);
  }, [infoNode]);

  const positionSync = useWorkflowPositionSync(
    workflowId,
    activeTab === "editor" && hydratedWorkflowId === workflowId,
    nodes,
    setNodes,
    workflowQuery.data,
  );

  const graphValidation = useMemo(
    () =>
      validateGraph(
        nodes,
        edges,
        actionsByName,
        workflowQuery.data?.template.room,
      ),
    [actionsByName, edges, nodes, workflowQuery.data?.template.room],
  );
  const graphVersion = distribution
    ? "workflow-graph/v3"
    : workflowQuery.data?.template.graphVersion;
  const distributionError = useMemo(() => {
    if (!distribution) return null;
    const payload = toDraftPayload(
      nodes,
      edges,
      "workflow-graph/v3",
      distribution,
    );
    return distributionValidationError({
      controls: payload.controls,
      distribution,
      edges: payload.edges,
      steps: payload.steps,
    });
  }, [distribution, edges, nodes]);
  const versionValidation = useMemo(
    () =>
      validateActionVersions(
        nodes,
        actions,
        localRegistryQuery.data?.packages ?? [],
        publicRegistryQuery.data?.packages ?? [],
      ),
    [
      actions,
      localRegistryQuery.data?.packages,
      nodes,
      publicRegistryQuery.data?.packages,
    ],
  );
  const validation = useMemo(() => {
    const nodeIssues = new Map(graphValidation.nodeIssues);
    for (const [nodeId, issues] of versionValidation.nodeIssues) {
      nodeIssues.set(nodeId, [...(nodeIssues.get(nodeId) ?? []), ...issues]);
    }
    return {
      errors: [
        ...graphValidation.errors,
        ...versionValidation.errors,
        ...(distributionError ? [distributionError] : []),
      ],
      nodeIssues,
      warnings: versionValidation.warnings,
    };
  }, [
    distributionError,
    graphValidation.errors,
    graphValidation.nodeIssues,
    versionValidation,
  ]);
  const renderedNodes = useMemo(
    () =>
      nodes.map((node) => {
        if (isStepNode(node)) {
          const credentialId = node.data.config.credentialId;
          const credential =
            typeof credentialId === "string"
              ? credentialsById.get(credentialId)
              : undefined;
          const natsUrl = credential?.metadata?.natsUrl;
          const environment = credential?.metadata?.environment;
          return {
            ...node,
            data: {
              ...node.data,
              workflowRoom: workflowQuery.data?.template.room ?? null,
              action: resolveWorkflowStepAction(node.data, actions),
              credentialName: credential?.name,
              // The credential's kind is its provider profile id, which is what
              // the node uses to show Slack's logo rather than a generic box.
              credentialProvider: credential?.kind,
              credentialNatsUrl:
                typeof natsUrl === "string" ? natsUrl : undefined,
              credentialEnvironment:
                typeof environment === "string" ? environment : undefined,
              endpointActionAvailable: Boolean(endpointAction),
              onQuickAddEndpoint:
                node.data.definition.presentation === "composite"
                  ? (role: BeamTransferEndpointRole) =>
                      openEndpointDraft(undefined, {
                        role,
                        transferNodeId: node.id,
                      })
                  : undefined,
              issues: validation.nodeIssues.get(node.id) ?? [],
            },
          };
        }
        return {
          ...node,
          data: {
            ...node.data,
            issues: validation.nodeIssues.get(node.id) ?? [],
          },
        };
      }),
    [
      actions,
      credentialsById,
      endpointAction,
      nodes,
      openEndpointDraft,
      validation.nodeIssues,
      workflowQuery.data?.template.room,
    ],
  );
  const renderedEdges = useMemo(() => {
    const steps = nodes.filter(isStepNode).map((node) => node.data);
    return edges.map((edge) => applyWorkflowEdgePresentation(edge, steps));
  }, [edges, nodes]);
  const triggerEditorCandidate =
    nodes.find((node) => node.id === triggerEditorNodeId) ?? null;
  const triggerEditorNode =
    triggerEditorCandidate && isTriggerNode(triggerEditorCandidate)
      ? triggerEditorCandidate
      : null;
  const currentSavePayload = useMemo(
    () => toDraftPayload(nodes, edges, graphVersion, distribution ?? undefined),
    [distribution, edges, graphVersion, nodes],
  );
  const currentGraphSignature = useMemo(
    () => graphSignature(currentSavePayload),
    [currentSavePayload],
  );
  const layoutContextRef = useRef("");
  layoutContextRef.current = JSON.stringify([
    workflowId,
    activeTab,
    currentGraphSignature,
    workflowLayoutSignature(nodes, edges),
    nodes.map((node) => node.measured),
  ]);
  const layoutRequestRef = useRef(0);
  useEffect(
    () => () => {
      layoutRequestRef.current += 1;
    },
    [],
  );
  const hasUnsavedChanges =
    Boolean(savedGraphSignature) &&
    (workflowDefinitionSignature(currentSavePayload) !== savedGraphSignature ||
      Object.keys(assistantMetadataDraft).length > 0);

  // The graph stays editable while a save is in flight. The response describes
  // what was sent, not what the canvas holds now, so applying it blindly
  // discards anything typed in the meantime.
  const currentGraphSignatureRef = useRef("");
  currentGraphSignatureRef.current = currentGraphSignature;
  const saveSequenceRef = useRef(0);
  const appliedSaveRef = useRef(0);

  const applyServerGraph = useCallback(
    (
      updatedWorkflow: WorkflowBundle,
      options: { preserveLocalEdits?: boolean } = {},
    ) => {
      try {
        const { nextEdges, nextNodes, nextDistribution, savedSignature } =
          graphStateFromWorkflow(updatedWorkflow);
        if (!options.preserveLocalEdits) {
          setEdges(nextEdges);
          setNodes(nextNodes);
          setDistribution(nextDistribution);
          undoStackRef.current = [];
          redoStackRef.current = [];
          assistantDraftRef.current = null;
          setAssistantMetadataDraft({});
        }
        // The baseline moves either way: the server now holds what was sent, so
        // a preserved draft correctly reports itself as unsaved.
        setSavedGraphSignature(savedSignature);
        setGraphLoadError("");
        setHydratedWorkflowId(updatedWorkflow.template.id);
      } catch (error) {
        setNodes([]);
        setEdges([]);
        setDistribution(null);
        setSavedGraphSignature("");
        setHydratedWorkflowId(null);
        setGraphLoadError(workflowGraphLoadErrorMessage(error));
      }
    },
    [graphStateFromWorkflow],
  );

  const saveMutation = useMutation({
    mutationFn: async (payload?: WorkflowGraphSavePayload) => {
      if (!payload && validation.errors.length) {
        throw new Error(validation.errors[0]);
      }
      await positionSync.flush();
      const graph = await apiSend<WorkflowBundle>(
        "PATCH",
        `/studio/workflows/${workflowId}/graph`,
        {
          ...(payload ?? currentSavePayload),
          confirmActionLockChanges: confirmLockChangesRef.current,
        },
      );
      if (!Object.keys(assistantMetadataDraft).length) {
        return graph;
      }
      return apiSend<WorkflowBundle>(
        "PATCH",
        `/studio/workflows/${workflowId}`,
        assistantMetadataDraft,
      );
    },
    onMutate: (payload?: WorkflowGraphSavePayload) => ({
      requestId: (saveSequenceRef.current += 1),
      requestSignature: graphSignature(payload ?? currentSavePayload),
      positions: nodes.map((node) => ({ nodeId: node.id, ...node.position })),
    }),
    onSuccess: (updatedWorkflow, _payload, context) => {
      confirmLockChangesRef.current = false;
      setTemplateError("");
      setPendingLockChanges([]);
      // onMutate always runs before onSuccess, so the context is present.
      const { requestId, requestSignature } = context as SaveRequestContext;
      const decision = reconcileSaveResponse({
        requestId,
        appliedRequestId: appliedSaveRef.current,
        requestSignature,
        currentSignature: currentGraphSignatureRef.current,
      });
      if (!decision.apply) return;
      appliedSaveRef.current = requestId;
      positionSync.definitionSaved(updatedWorkflow, context.positions);
      queryClient.setQueryData(
        ["/studio/workflows", workflowId],
        updatedWorkflow,
      );
      applyServerGraph(updatedWorkflow, {
        preserveLocalEdits: decision.preserveLocalEdits,
      });
    },
    onError: (error) => {
      confirmLockChangesRef.current = false;
      if (
        error instanceof ApiError &&
        error.code === "workflow_action_lock_confirmation_required"
      ) {
        const lockChanges = error.details.lockChanges;
        setPendingLockChanges(
          Array.isArray(lockChanges)
            ? (lockChanges as WorkflowActionLockChange[])
            : [],
        );
      }
    },
  });
  const cleanMutation = useMutation({
    mutationFn: () =>
      apiSend<WorkflowBundle>(
        "PATCH",
        `/studio/workflows/${workflowId}/graph`,
        toDraftPayload([createTrigger("manual", 0)], []),
      ),
    onSuccess: (updatedWorkflow) => {
      queryClient.setQueryData(
        ["/studio/workflows", workflowId],
        updatedWorkflow,
      );
      // Clearing the graph is a deliberate replacement, so it always applies.
      applyServerGraph(updatedWorkflow);
    },
  });
  const repairGraphMutation = useMutation({
    mutationFn: (confirmActionLockChanges: boolean) => {
      const workflow = workflowQuery.data;
      if (!workflow) throw new Error("Workflow not found.");
      const repair = repairMissingWorkflowGraphReferences(workflow);
      if (!repair.removedReferenceCount) {
        throw new Error("No missing graph references were found.");
      }
      return apiSend<WorkflowBundle>(
        "PATCH",
        `/studio/workflows/${workflowId}/graph`,
        {
          ...repair.payload,
          confirmActionLockChanges,
        },
      );
    },
    onSuccess: (updatedWorkflow) => {
      setPendingRepairLockChanges([]);
      setGraphLoadError("");
      setHydratedWorkflowId(null);
      queryClient.setQueryData(
        ["/studio/workflows", workflowId],
        updatedWorkflow,
      );
    },
    onError: (error) => {
      if (
        error instanceof ApiError &&
        error.code === "workflow_action_lock_confirmation_required"
      ) {
        const lockChanges = error.details.lockChanges;
        setPendingRepairLockChanges(
          Array.isArray(lockChanges)
            ? (lockChanges as WorkflowActionLockChange[])
            : [],
        );
      }
    },
  });
  // Read-only and deliberately off the run path: a price that cannot be
  // fetched must never delay or block starting the workflow.
  const creditEstimate = useWorkflowCreditEstimate(
    workflowId,
    nodes,
    activeTab === "editor" && hydratedWorkflowId === workflowId,
  );
  const runMutation = useMutation({
    mutationFn: () =>
      apiSend<Record<string, unknown>>(
        "POST",
        `/studio/workflows/${workflowId}/run`,
        {
          triggerId:
            nodes.find(
              (node) =>
                isTriggerNode(node) &&
                node.data.type === "manual" &&
                node.data.enabled,
            )?.id ?? "",
        },
      ),
    onSuccess: (result) => {
      const runId = String(result.runId ?? "");
      if (runId) {
        navigate({
          to: `/workflows/${workflowId}/runs/${runId}` as never,
        });
      }
    },
  });
  const cleanWorkflow = cleanMutation.mutate;
  const runWorkflow = runMutation.mutate;
  const saveWorkflow = useCallback(() => {
    if (validation.errors.length > 0) {
      return;
    }
    confirmLockChangesRef.current = false;
    setPendingLockChanges([]);
    saveMutation.mutate(undefined);
  }, [saveMutation.mutate, validation.errors.length]);
  // Rejects when the save does not happen, so leaving waits for a real save.
  const saveBeforeLeaving = useCallback(async () => {
    confirmLockChangesRef.current = false;
    setPendingLockChanges([]);
    await saveMutation.mutateAsync(undefined);
  }, [saveMutation.mutateAsync]);
  const confirmWorkflowLockChanges = useCallback(() => {
    confirmLockChangesRef.current = true;
    setPendingLockChanges([]);
    saveMutation.reset();
    saveMutation.mutate(undefined);
  }, [saveMutation.mutate, saveMutation.reset]);
  const graphSnapshot = useCallback(
    () => cloneGraphSnapshot({ edges, nodes, distribution }),
    [distribution, edges, nodes],
  );
  const recordGraphHistory = useCallback(() => {
    undoStackRef.current = [
      ...undoStackRef.current.slice(-49),
      graphSnapshot(),
    ];
    redoStackRef.current = [];
    setHistoryRevision((revision) => revision + 1);
  }, [graphSnapshot]);
  const undoGraphChange = useCallback(() => {
    const previous = undoStackRef.current.pop();
    if (!previous) {
      return;
    }
    redoStackRef.current.push(graphSnapshot());
    positionSync.queue(previous.nodes);
    setNodes(previous.nodes);
    setEdges(previous.edges);
    setDistribution(previous.distribution);
    setInfoNode(null);
    setHistoryRevision((revision) => revision + 1);
  }, [graphSnapshot, positionSync.queue]);
  const redoGraphChange = useCallback(() => {
    const next = redoStackRef.current.pop();
    if (!next) {
      return;
    }
    undoStackRef.current.push(graphSnapshot());
    positionSync.queue(next.nodes);
    setNodes(next.nodes);
    setEdges(next.edges);
    setDistribution(next.distribution);
    setInfoNode(null);
    setHistoryRevision((revision) => revision + 1);
  }, [graphSnapshot, positionSync.queue]);
  const selectEntireGraph = useCallback(() => {
    setNodes((current) =>
      current.map((node) => ({
        ...node,
        selected: true,
      })),
    );
    setEdges((current) =>
      current.map((edge) => ({
        ...edge,
        selected: true,
      })),
    );
  }, []);
  const deleteSelection = useCallback(() => {
    const selectedNodeIds = new Set(
      nodes.filter((node) => node.selected).map((node) => node.id),
    );
    const selectedEdgeIds = new Set(
      edges.filter((edge) => edge.selected).map((edge) => edge.id),
    );
    if (!selectedNodeIds.size && !selectedEdgeIds.size) {
      return;
    }
    const removedEdges = edges.filter(
      (edge) =>
        selectedEdgeIds.has(edge.id) ||
        selectedNodeIds.has(edge.source) ||
        selectedNodeIds.has(edge.target) ||
        edgeTouchesRuntimeNode(edge, selectedNodeIds),
    );
    recordGraphHistory();
    setNodes((current) =>
      removeBindingsForEdges(current, removedEdges).filter(
        (node) => !selectedNodeIds.has(node.id),
      ),
    );
    setEdges((current) =>
      current.filter(
        (edge) =>
          !selectedEdgeIds.has(edge.id) &&
          !selectedNodeIds.has(edge.source) &&
          !selectedNodeIds.has(edge.target) &&
          !edgeTouchesRuntimeNode(edge, selectedNodeIds),
      ),
    );
    setInfoNode(null);
    setTriggerEditorNodeId(null);
  }, [edges, nodes, recordGraphHistory]);
  const selectedNodeIds = useCallback(
    (contextNodeId?: string) => {
      const selected = new Set(
        nodes.filter((node) => node.selected).map((node) => node.id),
      );
      if (contextNodeId && !selected.has(contextNodeId)) {
        return new Set([contextNodeId]);
      }
      return selected;
    },
    [nodes],
  );
  const copySelection = useCallback(
    async (contextNodeId?: string) => {
      const nodeIds = selectedNodeIds(contextNodeId);
      if (!nodeIds.size) {
        return false;
      }
      const payload = createWorkflowGraphClipboardPayload({
        edges,
        nodes,
        selectedNodeIds: nodeIds,
        workflowId,
      });
      // A cut may remove only a selection that can be restored completely.
      if (payload.nodes.length !== nodeIds.size) return false;
      const serialized = JSON.stringify(payload);
      let copied = false;
      try {
        window.localStorage.setItem(WORKFLOW_GRAPH_CLIPBOARD_KEY, serialized);
        copied = true;
      } catch {
        // The system clipboard can still be available.
      }
      try {
        await navigator.clipboard.writeText(serialized);
        copied = true;
      } catch {
        // localStorage keeps inter-workflow paste available in this browser.
      }
      return copied;
    },
    [edges, nodes, selectedNodeIds, workflowId],
  );
  const cutSelection = useCallback(
    async (contextNodeId?: string) => {
      const nodeIds = selectedNodeIds(contextNodeId);
      if (!nodeIds.size || !(await copySelection(contextNodeId))) {
        return;
      }
      recordGraphHistory();
      const removedEdges = edges.filter(
        (edge) =>
          nodeIds.has(edge.source) ||
          nodeIds.has(edge.target) ||
          edgeTouchesRuntimeNode(edge, nodeIds),
      );
      setNodes((current) =>
        removeBindingsForEdges(current, removedEdges).filter(
          (node) => !nodeIds.has(node.id),
        ),
      );
      setEdges((current) =>
        current.filter(
          (edge) =>
            !nodeIds.has(edge.source) &&
            !nodeIds.has(edge.target) &&
            !edgeTouchesRuntimeNode(edge, nodeIds),
        ),
      );
      setInfoNode(null);
      setTriggerEditorNodeId(null);
    },
    [copySelection, edges, recordGraphHistory, selectedNodeIds],
  );
  const pasteSelection = useCallback(
    async (anchor?: CanvasPosition) => {
      let serialized: string | null = null;
      try {
        serialized = await navigator.clipboard.readText();
      } catch {
        try {
          serialized = window.localStorage.getItem(
            WORKFLOW_GRAPH_CLIPBOARD_KEY,
          );
        } catch {
          serialized = null;
        }
      }
      const payload = serialized
        ? parseWorkflowGraphClipboardPayload(serialized)
        : null;
      if (!payload) {
        return;
      }
      const pasted = materializeWorkflowGraphClipboardPayload({
        actionsByName,
        anchor,
        existingNodeCount: nodes.filter(isStepNode).length,
        offset: 48 * ((pasteCountRef.current % 6) + 1),
        payload,
        targetWorkflowId: workflowId,
      });
      pasteCountRef.current += 1;
      recordGraphHistory();
      setNodes((current) => [
        ...current.map((node) => ({ ...node, selected: false })),
        ...pasted.nodes,
      ]);
      setEdges((current) => [
        ...current.map((edge) => ({ ...edge, selected: false })),
        ...pasted.edges,
      ]);
      setInfoNode(null);
      setTriggerEditorNodeId(null);
    },
    [actionsByName, nodes, recordGraphHistory, workflowId],
  );

  const onNodesChange: OnNodesChange<Node<WorkflowCanvasNodeData>> =
    useCallback(
      (changes) => {
        const positionChanges = changes.filter(
          (change) => change.type === "position",
        );
        const structuralChanges = changes.some(
          (change) => change.type === "add" || change.type === "remove",
        );
        const nonDraggingPositionChange = positionChanges.some(
          (change) => !change.dragging,
        );
        const draggingPositionChange = positionChanges.some(
          (change) => change.dragging,
        );

        if (structuralChanges) {
          recordGraphHistory();
          setTriggerEditorNodeId(null);
        } else if (draggingPositionChange) {
          if (!nodeDragHistoryRecordedRef.current) {
            recordGraphHistory();
            nodeDragHistoryRecordedRef.current = true;
          }
        } else if (
          nonDraggingPositionChange &&
          !nodeDragHistoryRecordedRef.current
        ) {
          recordGraphHistory();
        }

        if (nonDraggingPositionChange) {
          nodeDragHistoryRecordedRef.current = false;
        }
        for (const change of positionChanges) {
          if (change.position)
            dragPositionsRef.current.set(change.id, change.position);
        }
        setNodes((current) => applyNodeChanges(changes, current));
        if (nonDraggingPositionChange) {
          const moved: Node<WorkflowCanvasNodeData>[] = [];
          const byId = new Map(nodes.map((node) => [node.id, node]));
          for (const change of positionChanges.filter(
            (change) => !change.dragging,
          )) {
            const node = byId.get(change.id);
            if (node)
              moved.push({
                ...node,
                position:
                  dragPositionsRef.current.get(change.id) ?? node.position,
              });
            dragPositionsRef.current.delete(change.id);
          }
          positionSync.queue(moved);
        }
      },
      [nodes, positionSync.queue, recordGraphHistory],
    );
  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      const removedIds = new Set(
        changes
          .filter((change) => change.type === "remove")
          .map((change) => change.id),
      );
      const removedEdges = edges.filter((edge) => removedIds.has(edge.id));
      if (changes.some((change) => change.type !== "select")) {
        recordGraphHistory();
      }
      if (removedEdges.length) {
        setNodes((current) => removeBindingsForEdges(current, removedEdges));
      }
      setEdges((current) =>
        applyEdgeChanges(changes, current).map((edge) =>
          isTriggerEdge(edge) ? decorateTriggerEdge(edge) : decorateEdge(edge),
        ),
      );
    },
    [edges, recordGraphHistory],
  );
  const onConnect = useCallback(
    (connection: Connection) => {
      const plan = planWorkflowConnection({ connection, nodes, edges });
      if (!plan.accepted) {
        setTemplateError(plan.reason ?? "Connection is incompatible.");
        return;
      }
      setTemplateError("");
      recordGraphHistory();
      setEdges((current) => [...current, ...plan.visualEdges]);
      if (plan.nodePatches.length) {
        setNodes((current) =>
          current.map((node) => {
            const patch = plan.nodePatches.find(
              (candidate) => candidate.nodeId === node.id,
            );
            return patch && isStepNode(node)
              ? { ...node, data: { ...node.data, ...patch.patch } }
              : node;
          }),
        );
      }
    },
    [edges, nodes, recordGraphHistory],
  );
  const addNodeFromAction = useCallback(
    (action: ActionPackage | null, kind: "action" | "endpoint") => {
      if (!action) {
        return;
      }
      const created = createNode(
        action,
        nodes.length,
        kind,
        pendingActionPosition ?? nextNodePosition(nodes) ?? undefined,
      );
      // A new Beam Transfer step starts with the Studio instance key.
      const instanceKey = credentials.find(
        (credential) => credential.managedBy === "studio-instance",
      );
      const next =
        action.name === BEAM_TRANSFER_ACTION && instanceKey
          ? {
              ...created,
              data: {
                ...created.data,
                config: {
                  ...created.data.config,
                  credentialId: instanceKey.id,
                },
              },
            }
          : created;
      const connection =
        kind === "action"
          ? firstActionTriggerConnection({ nodes, edges, action: next })
          : null;
      recordGraphHistory();
      setNodes((current) => [
        ...current,
        connection
          ? {
              ...next,
              data: {
                ...next.data,
                ...connection.nodePatches.find(
                  (patch) => patch.nodeId === next.id,
                )?.patch,
              },
            }
          : next,
      ]);
      if (connection) {
        setEdges((current) => [...current, ...connection.visualEdges]);
      }
      setPendingActionPosition(null);
      setRevealNodeId(next.id);
      if (kind === "action") {
        setActionCatalogOpen(false);
      }
    },
    [credentials, edges, nodes, pendingActionPosition, recordGraphHistory],
  );
  const addInstalledActionFromMarketplace = useCallback(
    (action: ActionPackage) => {
      queryClient.setQueryData<{ actions: ActionPackage[] }>(
        ["/studio/workflow-actions"],
        (current) => {
          if (!current) {
            return { actions: [action] };
          }
          if (
            current.actions.some((candidate) => candidate.name === action.name)
          ) {
            return current;
          }
          return { ...current, actions: [...current.actions, action] };
        },
      );
      addNodeFromAction(action, "action");
    },
    [addNodeFromAction, queryClient],
  );
  const addDynamicControl = useCallback(
    (kind: "loop" | "fan-out", position?: CanvasPosition) => {
      const selectedBodyStepIds = nodes
        .filter(
          (node) => isStepNode(node) && node.selected && node.data.enabled,
        )
        .map((node) => node.id);
      const created = createControlNodes(
        kind,
        nodes.filter(isControlNode).length,
        selectedBodyStepIds,
        position,
      );
      if (
        distribution &&
        kind === "loop" &&
        created[0] &&
        isControlNode(created[0])
      ) {
        created[0].data.control = {
          ...created[0].data.control,
          initial: { routes: [] },
          carry: { routes: [] },
        } as WorkflowGraphV3LoopControl;
      }
      recordGraphHistory();
      setNodes((current) => [...current, ...created]);
      setInfoNode(created[0] ?? null);
    },
    [distribution, nodes, recordGraphHistory],
  );
  const addDecision = useCallback(
    (position?: CanvasPosition) => {
      const created = createDecisionNode(
        nodes.filter(isDecisionNode).length,
        position,
      );
      recordGraphHistory();
      setNodes((current) => [...current, created]);
      setInfoNode(created);
    },
    [nodes, recordGraphHistory],
  );
  const addSwitch = useCallback(
    (position?: CanvasPosition) => {
      const created = createSwitchNode(
        nodes.filter(isDecisionNode).length,
        position,
      );
      recordGraphHistory();
      setNodes((current) => [...current, created]);
      setInfoNode(created);
    },
    [nodes, recordGraphHistory],
  );
  const addTrigger = useCallback(
    (
      type: WorkflowTriggerType,
      config?: Record<string, unknown>,
      options?: { enabled?: boolean; name?: string },
    ) => {
      const triggerCount = nodes.filter(isTriggerNode).length;
      const trigger = createTrigger(type, triggerCount);
      if (config) {
        trigger.data.config = config;
      }
      if (options?.name) {
        trigger.data.name = options.name;
      }
      if (options?.enabled !== undefined) {
        trigger.data.enabled = options.enabled;
      }
      recordGraphHistory();
      setNodes((current) => [...current, trigger]);
    },
    [nodes, recordGraphHistory],
  );
  const duplicateNode = useCallback(
    (node: Node<WorkflowCanvasNodeData>) => {
      const duplicate = isStepNode(node)
        ? duplicateStepNode(node, nodes.filter(isStepNode).length)
        : isTriggerNode(node)
          ? duplicateTriggerNode(node, nodes.filter(isTriggerNode).length)
          : isDecisionNode(node)
            ? duplicateDecisionNode(node)
            : null;
      if (!duplicate) {
        return;
      }
      recordGraphHistory();
      setNodes((current) => [...current, duplicate]);
      if (isTriggerNode(duplicate)) {
        setInfoNode(null);
        setTriggerEditorNodeId(duplicate.id);
      } else {
        setInfoNode(duplicate);
      }
    },
    [nodes, recordGraphHistory],
  );
  const deleteNode = useCallback(
    (nodeId: string) => {
      const target = nodes.find((node) => node.id === nodeId);
      if (!target) {
        return;
      }
      const deletedIds = new Set([nodeId]);
      if (isControlNode(target)) {
        for (const node of nodes) {
          if (
            isControlNode(node) &&
            node.data.controlId === target.data.controlId
          ) {
            deletedIds.add(node.id);
          }
        }
      }
      const removedEdges = edges.filter(
        (edge) =>
          deletedIds.has(edge.source) ||
          deletedIds.has(edge.target) ||
          edgeTouchesRuntimeNode(edge, deletedIds),
      );
      recordGraphHistory();
      setNodes((current) =>
        removeBindingsForEdges(current, removedEdges).filter(
          (node) => !deletedIds.has(node.id),
        ),
      );
      setEdges((current) =>
        current.filter(
          (edge) =>
            !deletedIds.has(edge.source) &&
            !deletedIds.has(edge.target) &&
            !edgeTouchesRuntimeNode(edge, deletedIds),
        ),
      );
      setInfoNode((current) =>
        current && deletedIds.has(current.id) ? null : current,
      );
      setTriggerEditorNodeId((current) =>
        current && deletedIds.has(current) ? null : current,
      );
    },
    [edges, nodes, recordGraphHistory],
  );
  const autoLayout = useCallback(
    async (handles: WorkflowLayoutHandles) => {
      const request = ++layoutRequestRef.current;
      const context = layoutContextRef.current;
      const result = await layoutWorkflowWithElk(nodes, edges, handles);
      if (
        request !== layoutRequestRef.current ||
        context !== layoutContextRef.current
      )
        return null;
      recordGraphHistory();
      setNodes(result.nodes);
      positionSync.queue(result.nodes);
      return result;
    },
    [edges, nodes, recordGraphHistory, positionSync.queue],
  );
  const applyReusableTemplate = useCallback(
    (template: BuiltinWorkflowTemplate) => {
      if (workflowQuery.data?.runCount) {
        setTemplateError(
          "This workflow has run history. Create a new workflow from the template before replacing the graph.",
        );
        setTemplateCatalogOpen(false);
        return;
      }
      const graph = createLinearTemplateGraph(actions, template.actionNames);
      recordGraphHistory();
      setNodes(graph.nodes);
      setEdges(graph.edges);
      setTemplateError("");
      setTemplateCatalogOpen(false);
    },
    [actions, recordGraphHistory, workflowQuery.data?.runCount],
  );
  const requestAssistantWorkflowDraft = useCallback(
    async (
      prompt: string,
      model?: string,
      reasoningEffort?: AssistantReasoningEffort,
    ) => {
      const language = assistantLanguage(prompt);
      const draftId = `assistant-draft-${shortId()}`;
      if (assistantDraftRef.current) {
        return {
          applied: false,
          assumptions: [],
          id: draftId,
          message:
            language === "en"
              ? "An AI change is already pending. Accept or discard it first."
              : "Une modification IA est déjà en attente. Accepte-la ou annule-la d'abord.",
          needsInput: [],
          patchErrors: ["Pending assistant draft."],
          plan: [],
          risks: [],
        } satisfies AssistantWorkflowDraftResult;
      }

      const plan = await apiSend<AssistantWorkflowDraftResponse>(
        "POST",
        `/studio/workflows/${workflowId}/assistant/plan`,
        {
          model,
          prompt,
          reasoningEffort,
          selectedNodeId: infoNode?.id ?? undefined,
          validationErrors: validation.errors,
          workflow: currentSavePayload,
        },
      );
      const fallbackPatch = fallbackAssistantWorkflowPatch(prompt, actions);
      const patch = mergeAssistantWorkflowPatch(plan.patch, fallbackPatch);
      const usedFallbackPatch = patchIncludesFallback(patch, fallbackPatch);
      const patchErrors = patch.length
        ? [...(plan.patchErrors ?? [])]
        : ["Assistant returned no workflow change."];
      let applied = false;
      if (patch.length) {
        const beforeSignature = graphSignature(
          toDraftPayload(nodes, edges, graphVersion, distribution ?? undefined),
        );
        const result = applyAssistantWorkflowPatch({
          actions,
          edges,
          nodes,
          patch,
        });
        patchErrors.push(...result.errors);
        const afterSignature = graphSignature(
          toDraftPayload(
            result.nodes,
            result.edges,
            graphVersion,
            distribution ?? undefined,
          ),
        );
        const hasMetadataChange = Object.keys(result.metadata).length > 0;
        if (afterSignature !== beforeSignature || hasMetadataChange) {
          assistantDraftRef.current = {
            before: graphSnapshot(),
            beforeMetadata: { ...assistantMetadataDraft },
            id: draftId,
          };
          recordGraphHistory();
          setNodes(result.nodes);
          setEdges(result.edges);
          if (hasMetadataChange) {
            setAssistantMetadataDraft((current) => ({
              ...current,
              ...result.metadata,
            }));
          }
          setInfoNode(null);
          applied = true;
          setAssistantLayoutRequest((current) => current + 1);
        } else {
          patchErrors.push("No workflow node could be added.");
        }
      }

      return {
        applied,
        assumptions: plan.assumptions,
        degraded: plan.degraded,
        id: draftId,
        message:
          applied && usedFallbackPatch
            ? language === "en"
              ? "I placed the requested nodes on the canvas."
              : "J'ai placé les nodes demandés dans le canvas."
            : plan.message,
        needsInput: plan.needsInput,
        patchErrors,
        plan: plan.plan,
        provider: plan.provider,
        providerMessage: plan.providerMessage,
        risks: plan.risks,
      };
    },
    [
      actions,
      assistantMetadataDraft,
      currentSavePayload,
      distribution,
      edges,
      graphVersion,
      graphSnapshot,
      infoNode?.id,
      nodes,
      recordGraphHistory,
      validation.errors,
      workflowId,
    ],
  );
  const acceptAssistantWorkflowDraft = useCallback((id: string) => {
    if (assistantDraftRef.current?.id !== id) {
      throw new Error("Assistant draft is no longer active.");
    }
    assistantDraftRef.current = null;
  }, []);
  const discardAssistantWorkflowDraft = useCallback((id: string) => {
    const draft = assistantDraftRef.current;
    if (draft?.id !== id) {
      throw new Error("Assistant draft is no longer active.");
    }
    setNodes(draft.before.nodes);
    setEdges(draft.before.edges);
    setDistribution(draft.before.distribution);
    setAssistantMetadataDraft(draft.beforeMetadata);
    setInfoNode(null);
    assistantDraftRef.current = null;
  }, []);
  const openActions = useCallback((position?: CanvasPosition) => {
    setPendingActionPosition(position ?? null);
    setActionCatalogOpen(true);
  }, []);
  const openTriggerEditor = useCallback(
    (triggerId: string) => {
      if (activeTab !== "editor") {
        navigate({
          search: { editTrigger: triggerId } as never,
          to: `/workflows/${workflowId}/editor` as never,
        });
        return;
      }
      setInfoNode(null);
      setTriggerEditorNodeId(triggerId);
    },
    [activeTab, navigate, workflowId],
  );
  const applyTriggerEditorSubmit = useCallback(
    (trigger: WorkflowTriggerEditorSubmit) => {
      const source = nodes.find(
        (node) => node.id === triggerEditorNodeId && isTriggerNode(node),
      );
      if (!source || !isTriggerNode(source)) {
        setTriggerEditorNodeId(null);
        return;
      }
      const nextNodes = nodes.map((node) =>
        node.id === source.id
          ? patchCanvasNode(node, {
              config: trigger.config,
              enabled: trigger.enabled,
              name: trigger.name,
              state: source.data.type === trigger.type ? source.data.state : {},
              type: trigger.type,
            })
          : node,
      );
      recordGraphHistory();
      setNodes(nextNodes);
      setTriggerEditorNodeId(null);
      saveMutation.mutate(
        toDraftPayload(
          nextNodes,
          edges,
          graphVersion,
          distribution ?? undefined,
        ),
      );
    },
    [
      edges,
      distribution,
      graphVersion,
      nodes,
      recordGraphHistory,
      saveMutation,
      triggerEditorNodeId,
    ],
  );
  const setTriggerEnabledAndSave = useCallback(
    (triggerId: string, enabled: boolean) => {
      const source = nodes.find(
        (node) => node.id === triggerId && isTriggerNode(node),
      );
      if (!source || !isTriggerNode(source)) {
        return;
      }
      const prepared = prepareWorkflowTriggerEditorSubmit(
        {
          config: source.data.config,
          enabled,
          name: source.data.name,
          type: source.data.type,
        },
        { currentEnabled: source.data.enabled },
      );
      if (!prepared.ok) {
        setTemplateError(prepared.issue);
        openTriggerEditor(triggerId);
        return;
      }
      const nextNodes = nodes.map((node) =>
        node.id === source.id
          ? patchCanvasNode(node, {
              config: prepared.trigger.config,
              enabled: prepared.trigger.enabled,
              name: prepared.trigger.name,
              type: prepared.trigger.type,
            })
          : node,
      );
      recordGraphHistory();
      setNodes(nextNodes);
      saveMutation.mutate(
        toDraftPayload(
          nextNodes,
          edges,
          graphVersion,
          distribution ?? undefined,
        ),
      );
    },
    [
      edges,
      distribution,
      graphVersion,
      nodes,
      openTriggerEditor,
      recordGraphHistory,
      saveMutation,
    ],
  );

  useWorkflowGraphShortcuts({
    activeTab,
    actionCatalogOpen,
    endpointDraftOpen: Boolean(endpointDraftNode),
    infoNodeOpen: Boolean(infoNode) || distributionOpen,
    onControlModeChange: setControlMode,
    onCopySelection: () => void copySelection(),
    onCutSelection: () => void cutSelection(),
    onDeleteSelection: deleteSelection,
    onOpenActions: () => setActionCatalogOpen(true),
    onOpenEndpoint: openEndpointDraft,
    onPaste: () => void pasteSelection(),
    onRedo: redoGraphChange,
    onSelectAll: selectEntireGraph,
    onUndo: undoGraphChange,
  });

  const workflow = workflowQuery.data;
  const graphRepairReferenceCount = useMemo(
    () =>
      workflow
        ? repairMissingWorkflowGraphReferences(workflow).removedReferenceCount
        : 0,
    [workflow],
  );
  const graphHydrated =
    hydratedWorkflowId === workflow?.template.id && savedGraphSignature !== "";
  const editorPreparing =
    activeTab === "editor" &&
    (workflowQuery.isPending || (!graphHydrated && !graphLoadError));

  useEffect(() => {
    if (activeTab !== "editor" || !requestedEditTriggerId || editorPreparing) {
      return;
    }
    const trigger = nodes.find(
      (node) => node.id === requestedEditTriggerId && isTriggerNode(node),
    );
    if (!trigger) {
      return;
    }
    setInfoNode(null);
    setTriggerEditorNodeId(requestedEditTriggerId);
    navigate({ replace: true, to: `/workflows/${workflowId}/editor` as never });
  }, [
    activeTab,
    editorPreparing,
    navigate,
    nodes,
    requestedEditTriggerId,
    workflowId,
  ]);

  // A workflow created from a template opens with the template as an unsaved
  // draft: its steps still need a bucket and credentials before the graph can
  // be saved. Only a workflow with nothing in it yet takes the draft, once per
  // editor. The parameter stays in the URL: navigating here remounts the
  // editor, which would discard the draft, and a saved workflow has steps and
  // ignores it.
  const appliedTemplateWorkflowIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      activeTab !== "editor" ||
      !requestedTemplateId ||
      editorPreparing ||
      !workflow ||
      !actionsQuery.isSuccess ||
      appliedTemplateWorkflowIdRef.current === workflowId
    ) {
      return;
    }
    appliedTemplateWorkflowIdRef.current = workflowId;
    const draft =
      isWorkflowTemplateId(requestedTemplateId) &&
      !workflow.steps.length &&
      !workflow.runCount
        ? workflowTemplateDraft(workflow, requestedTemplateId)
        : null;
    if (!draft) {
      return;
    }
    const presentation = presentationGraphFromWorkflowBundle(
      draft,
      actionsByName,
    );
    recordGraphHistory();
    setNodes(presentation.nodes);
    setEdges(presentation.edges);
  }, [
    actionsByName,
    actionsQuery.isSuccess,
    activeTab,
    editorPreparing,
    recordGraphHistory,
    requestedTemplateId,
    workflow,
    workflowId,
  ]);

  useEffect(() => {
    if (
      !onHeaderControlsChange ||
      !workflow ||
      editorPreparing ||
      Boolean(graphLoadError)
    ) {
      onHeaderControlsChange?.(null);
      return undefined;
    }

    onHeaderControlsChange({
      cleanPending: cleanMutation.isPending,
      creditEstimate,
      hasUnsavedChanges,
      onCleanTemplate: () => {
        if (distribution) {
          setTemplateError(
            "A distributed workflow must retain at least one partition and action. Edit its distribution or create a new workflow.",
          );
          return;
        }
        cleanWorkflow();
      },
      onCopyDefinition: () =>
        navigator.clipboard.writeText(
          JSON.stringify(workflowDefinitionFromBundle(workflow), null, 2),
        ),
      onCopyFullJson: () =>
        navigator.clipboard.writeText(JSON.stringify(workflow, null, 2)),
      onOpenTemplates: () => setTemplateCatalogOpen(true),
      onRun: () => {
        // Runs start from the saved workflow, so its saved steps decide the key.
        if (
          !workflowBillingKey(workflow.template.apiKeyId, workflow.steps)
            .apiKeyId
        ) {
          navigate({ to: `/workflows/${workflowId}/settings` as never });
          return;
        }
        runWorkflow();
      },
      onSave: () => saveWorkflow(),
      runPending: runMutation.isPending,
      saveDisabled: validation.errors.length > 0,
      savePending: saveMutation.isPending,
      positionSaveState: {
        pending: positionSync.pending,
        saving: positionSync.saving,
        error: positionSync.error,
      },
      onRetryPositions: () => {
        void positionSync.flush().catch(() => {});
      },
    });

    return undefined;
  }, [
    cleanMutation.isPending,
    cleanWorkflow,
    creditEstimate,
    editorPreparing,
    graphLoadError,
    hasUnsavedChanges,
    onHeaderControlsChange,
    runMutation.isPending,
    runWorkflow,
    navigate,
    workflowId,
    saveMutation.isPending,
    saveWorkflow,
    distribution,
    positionSync.pending,
    positionSync.saving,
    positionSync.error,
    positionSync.flush,
    validation.errors.length,
    workflow,
  ]);

  useEffect(
    () => () => {
      onHeaderControlsChange?.(null);
    },
    [onHeaderControlsChange],
  );

  if (workflowQuery.isPending) {
    return activeTab === "editor" ? (
      <WorkflowEditorLoadingState />
    ) : (
      <WorkflowDetailLoadingState />
    );
  }
  if (workflowQuery.error || !workflow) {
    return (
      <div className="grid h-full w-full place-items-center bg-background p-6">
        <div className="max-w-md rounded-control border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {String(workflowQuery.error ?? "Workflow not found")}
        </div>
      </div>
    );
  }
  if (activeTab === "editor" && graphLoadError) {
    const repairError =
      repairGraphMutation.error instanceof ApiError &&
      repairGraphMutation.error.code ===
        "workflow_action_lock_confirmation_required"
        ? null
        : repairGraphMutation.error;
    return (
      <>
        <div className="grid h-full w-full place-items-center bg-background p-6">
          <div
            className="w-full max-w-xl rounded-control border border-destructive/40 bg-destructive/10 p-5"
            role="alert"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
              <div className="min-w-0">
                <h2 className="font-semibold text-foreground">
                  Workflow graph needs repair
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  A saved connection points to a node that no longer exists. The
                  editor stopped loading the graph to prevent accidental data
                  loss.
                </p>
              </div>
            </div>
            <div className="mt-4 rounded-control-compact border border-destructive/20 bg-background/70 p-3">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Technical detail
              </div>
              <code className="mt-1 block break-words text-xs text-destructive">
                {graphLoadError}
              </code>
            </div>
            {repairError ? (
              <p className="mt-3 text-sm text-destructive">
                {String(repairError)}
              </p>
            ) : null}
            {graphRepairReferenceCount > 0 ? (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button
                  disabled={repairGraphMutation.isPending}
                  onClick={() => repairGraphMutation.mutate(false)}
                >
                  {repairGraphMutation.isPending
                    ? "Repairing..."
                    : `Remove invalid connection${graphRepairReferenceCount === 1 ? "" : "s"}`}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {graphRepairReferenceCount} invalid saved reference
                  {graphRepairReferenceCount === 1 ? "" : "s"} will be removed.
                </span>
              </div>
            ) : null}
          </div>
        </div>
        <WorkflowActionLockWarningDialog
          changes={pendingRepairLockChanges}
          onCancel={() => {
            setPendingRepairLockChanges([]);
            repairGraphMutation.reset();
          }}
          onConfirm={() => {
            setPendingRepairLockChanges([]);
            repairGraphMutation.reset();
            repairGraphMutation.mutate(true);
          }}
          pending={repairGraphMutation.isPending}
        />
      </>
    );
  }
  const saveError =
    saveMutation.error instanceof ApiError &&
    saveMutation.error.code === "workflow_action_lock_confirmation_required"
      ? null
      : saveMutation.error;

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col bg-background">
      <WorkflowLeaveGuard
        enabled={activeTab === "editor"}
        hasUnsavedChanges={hasUnsavedChanges}
        issueCount={validation.errors.length}
        save={saveBeforeLeaving}
      />
      {activeTab === "editor" && actionsQuery.error ? (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          Action catalog unavailable: {String(actionsQuery.error)}
        </p>
      ) : null}
      {activeTab === "editor" && (
        <>
          <WorkflowCallPickerDialog
            key={String(workflowPickerOpen)}
            open={workflowPickerOpen}
            onOpenChange={setWorkflowPickerOpen}
            workflows={sourceWorkflows}
            onSelect={(selected) => {
              recordGraphHistory();
              const call = buildNodes(
                [
                  {
                    id: `wfs_${crypto.randomUUID().replaceAll("-", "")}`,
                    kind: "workflow",
                    calledWorkflowId: selected.id,
                    name: selected.name,
                    actionPackageName: "",
                    actionVersionRange: "*",
                    position: nodes.filter(isStepNode).length,
                    enabled: true,
                    config: {},
                    inputBindings: {},
                    placement: "local-workers",
                    executionLocationId: null,
                    canvasX: null,
                    canvasY: null,
                    timeoutSeconds: null,
                    required: true,
                    manifest: null,
                  },
                ],
                new Map(),
              )[0]!;
              setNodes((current) => [...current, call]);
              setInfoNode(call);
            }}
          />
          <Dialog open={roomPickerOpen} onOpenChange={setRoomPickerOpen}>
            <DialogContent className="sm:max-w-xl">
              <DialogHeader>
                <DialogTitle>Workflow room</DialogTitle>
                <DialogDescription>
                  Choose an optional shared room for this workflow and its child
                  calls.
                </DialogDescription>
              </DialogHeader>
              <WorkflowRoomSettings
                key={String(roomPickerOpen)}
                workflow={workflow}
              />
            </DialogContent>
          </Dialog>
          <Dialog open={distributionOpen} onOpenChange={setDistributionOpen}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
              <DialogHeader>
                <DialogTitle>Distributed workflow</DialogTitle>
                <DialogDescription>
                  Configure frozen member partitions, one action task per
                  member, port routes and bounded loop state.
                </DialogDescription>
              </DialogHeader>
              {distribution ? (
                <>
                  {workflow.template.graphVersion !== "workflow-graph/v3" ? (
                    <Button
                      className="justify-self-start"
                      size="sm"
                      type="button"
                      variant="outline"
                      onClick={() => {
                        recordGraphHistory();
                        setDistribution(null);
                        setNodes((current) =>
                          current.map((node) => {
                            if (
                              !isControlNode(node) ||
                              node.data.role !== "loop"
                            )
                              return node;
                            const {
                              initial: _initial,
                              carry: _carry,
                              stop: _stop,
                              ...control
                            } = node.data.control as WorkflowGraphV3LoopControl;
                            return { ...node, data: { ...node.data, control } };
                          }),
                        );
                      }}
                    >
                      Cancel V3 conversion
                    </Button>
                  ) : null}
                  <WorkflowDistributionEditor
                    distribution={distribution}
                    error={distributionError}
                    loop={(() => {
                      const control = nodes.find(
                        (node) =>
                          isControlNode(node) && node.data.role === "loop",
                      );
                      return control && isControlNode(control)
                        ? (control.data.control as WorkflowGraphV3LoopControl)
                        : null;
                    })()}
                    onChange={(next) => {
                      recordGraphHistory();
                      setDistribution(next);
                    }}
                    onLoopChange={(next) => {
                      recordGraphHistory();
                      setNodes((current) =>
                        current.map((node) =>
                          isControlNode(node) && node.data.controlId === next.id
                            ? { ...node, data: { ...node.data, control: next } }
                            : node,
                        ),
                      );
                    }}
                    steps={nodes.filter(isStepNode).map((node) => ({
                      id: node.id,
                      name:
                        node.data.name ||
                        node.data.actionPackageName ||
                        "Action",
                      enabled: node.data.enabled,
                    }))}
                  />
                </>
              ) : (
                <div className="grid gap-3 rounded-surface border p-4 text-sm">
                  <p>
                    Enable V3 distribution for this workflow. Existing V1 and V2
                    workflows retain their current behavior until enabled.
                  </p>
                  <Button
                    className="justify-self-start"
                    type="button"
                    onClick={() => {
                      recordGraphHistory();
                      setDistribution(emptyDistribution());
                      setNodes((current) =>
                        current.map((node) => {
                          if (!isControlNode(node) || node.data.role !== "loop")
                            return node;
                          return {
                            ...node,
                            data: {
                              ...node.data,
                              control: {
                                ...node.data.control,
                                initial: { routes: [] },
                                carry: { routes: [] },
                              } as WorkflowGraphV3LoopControl,
                            },
                          };
                        }),
                      );
                    }}
                  >
                    Enable V3 distribution
                  </Button>
                </div>
              )}
            </DialogContent>
          </Dialog>
        </>
      )}

      {/* Above the validation warnings: a spent budget decides whether to run
          this at all, where a validation warning only shapes how. */}
      <BudgetAlertBar className="mx-4 mt-4" />

      {saveError || runMutation.error || templateError ? (
        <div className="mx-4 mt-4 rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {templateError || String(saveError ?? runMutation.error)}
        </div>
      ) : null}
      {!templateError &&
      !saveError &&
      !runMutation.error &&
      validation.warnings.length ? (
        <div className="mx-4 mt-4 rounded-control border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-900">
          {validation.warnings.join(" ")}
        </div>
      ) : null}
      {activeTab === "editor" && distributionError && !distributionOpen ? (
        <div
          className="mx-4 mt-4 rounded-control border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          role="alert"
        >
          Distribution: {distributionError}{" "}
          <button
            className="underline"
            type="button"
            onClick={() => setDistributionOpen(true)}
          >
            Edit distribution
          </button>
        </div>
      ) : null}

      {editorPreparing ? (
        <WorkflowEditorLoadingState />
      ) : activeTab === "editor" ? (
        <WorkflowEditorCanvas
          revealNodeId={revealNodeId}
          onNodeRevealed={clearRevealNode}
          onOpenWorkflows={() => setWorkflowPickerOpen(true)}
          onOpenRoom={() => setRoomPickerOpen(true)}
          onOpenDistribution={() => setDistributionOpen(true)}
          distributed={Boolean(distribution)}
          hasRoom={Boolean(workflow.template.room)}
          actionCatalogOpen={actionCatalogOpen}
          actionSearch={actionSearch}
          actionSort={actionSort}
          actions={actions}
          allActionsCount={actions.length}
          canRedo={historyRevision >= 0 && redoStackRef.current.length > 0}
          canUndo={historyRevision >= 0 && undoStackRef.current.length > 0}
          controlMode={controlMode}
          credentials={credentials}
          edges={renderedEdges}
          endpointActionAvailable={Boolean(endpointAction)}
          endpointDraftNode={endpointDraftNode}
          endpointDraftRole={endpointDraftConnection?.role}
          infoNode={
            infoNode
              ? (renderedNodes.find((node) => node.id === infoNode.id) ??
                infoNode)
              : null
          }
          layoutRequestKey={assistantLayoutRequest}
          nodes={renderedNodes}
          onActionCatalogOpenChange={(open) => {
            setActionCatalogOpen(open);
            if (!open) {
              setPendingActionPosition(null);
            }
          }}
          onActionInstalled={addInstalledActionFromMarketplace}
          onActionSearchChange={setActionSearch}
          onActionSelect={(action) => addNodeFromAction(action, "action")}
          onActionSortChange={setActionSort}
          onAddEndpoint={openEndpointDraft}
          onAddFanOut={(position) => addDynamicControl("fan-out", position)}
          onAddDecision={(position) => addDecision(position)}
          onAddSwitch={(position) => addSwitch(position)}
          onAddLoop={(position) => addDynamicControl("loop", position)}
          onAddTrigger={addTrigger}
          onAutoLayout={autoLayout}
          onConnect={onConnect}
          onControlModeChange={setControlMode}
          onCopyNode={(node) => void copySelection(node.id)}
          onCutNode={(node) => void cutSelection(node.id)}
          onDeleteNode={deleteNode}
          onDeleteSelection={deleteSelection}
          onDuplicateNode={duplicateNode}
          onRedo={redoGraphChange}
          onUndo={undoGraphChange}
          onEdgesChange={onEdgesChange}
          onEndpointCancel={() => {
            setEndpointDraftConnection(null);
            setEndpointDraftNode(null);
          }}
          onEndpointCreate={(node) => {
            recordGraphHistory();
            const connection = endpointDraftConnection;
            const transfer = connection
              ? nodes.find(
                  (candidate) =>
                    candidate.id === connection.transferNodeId &&
                    isStepNode(candidate) &&
                    candidate.data.definition.presentation === "composite",
                )
              : null;
            if (connection && transfer && isStepNode(transfer)) {
              const plan = beamTransferBindingPlan(connection.role);
              setNodes((current) => [
                ...current.map((candidate) =>
                  candidate.id === transfer.id && isStepNode(candidate)
                    ? {
                        ...candidate,
                        data: {
                          ...candidate.data,
                          inputBindings: applyAutomaticBinding(
                            candidate.data.inputBindings,
                            plan,
                            node.id,
                          ),
                        },
                      }
                    : candidate,
                ),
                node,
              ]);
              const isSource = connection.role === "source";
              setEdges((current) => [
                ...current,
                decorateEdge({
                  id: `wfe_${node.id}_${transfer.id}_${shortId()}`,
                  source: isSource ? node.id : transfer.id,
                  sourceHandle: isSource
                    ? null
                    : BEAM_TRANSFER_DESTINATION_HANDLE,
                  target: isSource ? transfer.id : node.id,
                  targetHandle: isSource ? BEAM_TRANSFER_SOURCE_HANDLE : null,
                  type: "smoothstep",
                  data: {
                    edgeKind: "binding",
                    beamTransferEndpointRole: connection.role,
                    condition: null,
                    connectionKind: "endpoint",
                    runtimeSource: node.id,
                    runtimeTarget: transfer.id,
                    runtimeSourceKind: "step",
                    runtimeTargetKind: "step",
                    runtimeEdges: [
                      {
                        id: `wfe_${node.id}_${transfer.id}`,
                        source: node.id,
                        target: transfer.id,
                        sourceKind: "step",
                        targetKind: "step",
                        dependency: true,
                      },
                    ],
                    binding: {
                      sourceNodeId: node.id,
                      sourceOutput: "endpoint",
                      targetNodeId: transfer.id,
                      targetInput:
                        connection.role === "source"
                          ? "sourceEndpoints"
                          : "destinationEndpoints",
                      mode: "append",
                    },
                    compositeNodeId: transfer.id,
                    memberNodeId: node.id,
                    membershipRole:
                      connection.role === "source"
                        ? "sourceEndpoints"
                        : "destinationEndpoints",
                  },
                  markerEnd: { type: MarkerType.ArrowClosed },
                }),
              ]);
            } else {
              setNodes((current) => [...current, node]);
            }
            setEndpointDraftConnection(null);
            setEndpointDraftNode(null);
          }}
          onEndpointNodeChange={(patch) => {
            setEndpointDraftNode((current) =>
              current
                ? { ...current, data: { ...current.data, ...patch } }
                : current,
            );
          }}
          onEditTrigger={openTriggerEditor}
          onInfoNodeChange={(nodeId, patch) => {
            recordGraphHistory();
            const source = nodes.find((node) => node.id === nodeId);
            const controlId =
              source && isControlNode(source) ? source.data.controlId : null;
            setNodes((current) =>
              current.map((node) =>
                node.id === nodeId ||
                (controlId &&
                  isControlNode(node) &&
                  node.data.controlId === controlId)
                  ? patchCanvasNode(node, patch)
                  : node,
              ),
            );
            setInfoNode((current) =>
              current?.id === nodeId
                ? patchCanvasNode(current, patch)
                : current,
            );
          }}
          onInfoOpenChange={(open) => {
            if (!open) {
              setInfoNode(null);
            }
          }}
          onNodeSelect={setInfoNode}
          onNodesChange={onNodesChange}
          onOpenActions={openActions}
          onPaste={(position) => void pasteSelection(position)}
          templateCatalogOpen={templateCatalogOpen}
          templates={builtinWorkflowTemplates}
          workflowId={workflowId}
          workflows={sourceWorkflows}
          onTemplateCatalogOpenChange={setTemplateCatalogOpen}
          onTemplateSelect={applyReusableTemplate}
        />
      ) : null}

      {!editorPreparing && activeTab === "editor" ? (
        <>
          <StudioAssistantChat
            editorContext={{
              acceptWorkflowDraft: acceptAssistantWorkflowDraft,
              discardWorkflowDraft: discardAssistantWorkflowDraft,
              requestWorkflowDraft: requestAssistantWorkflowDraft,
              selectedNodeId: infoNode?.id ?? null,
              validationErrors: validation.errors,
              workflow: {
                ...currentSavePayload,
                template: {
                  ...workflow.template,
                  ...assistantMetadataDraft,
                },
              },
              workflowId,
            }}
            key={workflowId}
            onOpenChange={() => undefined}
            open
            route={`/workflows/${encodeURIComponent(workflowId)}/editor`}
            variant="editor"
          />
        </>
      ) : null}

      {activeTab === "runs" ? (
        <WorkflowExecutions workflowId={workflowId} />
      ) : null}

      {activeTab === "overview" ? (
        <WorkflowOverview
          controls={workflow.controls}
          edges={workflow.edges}
          onEditTrigger={openTriggerEditor}
          onOpenEditor={onOpenEditor}
          onSetTriggerEnabled={setTriggerEnabledAndSave}
          runCount={workflow.runCount}
          scheduleActionPending={saveMutation.isPending}
          steps={workflow.steps}
          template={workflow.template}
          triggerEdges={workflow.triggerEdges}
          triggers={workflow.triggers}
        />
      ) : null}

      {activeTab === "settings" ? (
        <WorkflowSettings workflow={workflow} />
      ) : null}

      <WorkflowTriggerPickerDialog
        currentConfig={triggerEditorNode?.data.config}
        currentEnabled={triggerEditorNode?.data.enabled}
        currentName={triggerEditorNode?.data.name}
        currentType={triggerEditorNode?.data.type}
        mode="change"
        open={Boolean(triggerEditorNode)}
        onOpenChange={(open) => {
          if (!open) {
            setTriggerEditorNodeId(null);
          }
        }}
        onSubmit={applyTriggerEditorSubmit}
        triggerId={triggerEditorNode?.id}
        workflowId={workflowId}
        workflows={sourceWorkflows}
      />

      <WorkflowActionLockWarningDialog
        changes={pendingLockChanges}
        onCancel={() => {
          setPendingLockChanges([]);
          saveMutation.reset();
        }}
        onConfirm={confirmWorkflowLockChanges}
        pending={saveMutation.isPending}
      />
    </div>
  );
}

function WorkflowActionLockWarningDialog({
  changes,
  onCancel,
  onConfirm,
  pending,
}: {
  changes: WorkflowActionLockChange[];
  onCancel(): void;
  onConfirm(): void;
  pending: boolean;
}) {
  return (
    <Dialog
      open={changes.length > 0}
      onOpenChange={(open) => {
        if (!open && !pending) {
          onCancel();
        }
      }}
    >
      <DialogContent className="max-h-[min(760px,calc(100vh-32px))] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-warning" />
            Review workflow action lock changes
          </DialogTitle>
          <DialogDescription>
            Saving will change the exact action bytes used by future runs.
            Existing run snapshots remain unchanged.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {changes.map((change) => (
            <div className="rounded-control border p-3" key={change.stepId}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <code className="text-xs font-semibold">
                  {change.actionPackageName}
                </code>
                <span className="text-xs font-medium uppercase tracking-wide text-amber-700">
                  {change.kind}
                </span>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <LockIdentity label="Current lock" lock={change.previous} />
                <LockIdentity label="Proposed lock" lock={change.next} />
              </div>
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button disabled={pending} onClick={onCancel} variant="outline">
            Keep current locks
          </Button>
          <Button disabled={pending} onClick={onConfirm}>
            {pending ? "Saving..." : "Confirm lock changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LockIdentity({
  label,
  lock,
}: {
  label: string;
  lock: WorkflowActionLockChange["next"];
}) {
  if (!lock) {
    return (
      <div className="rounded-control-compact bg-muted p-3 text-xs text-muted-foreground">
        <div className="font-medium text-foreground">{label}</div>
        <div className="mt-2">Lock removed</div>
      </div>
    );
  }
  return (
    <dl className="grid gap-1 rounded-control-compact bg-muted p-3 text-xs">
      <dt className="font-medium text-foreground">{label}</dt>
      <dd className="font-mono">v{lock.resolvedVersion}</dd>
      <dd className="break-all font-mono text-muted-foreground">
        manifest {lock.manifestChecksum}
      </dd>
      <dd className="break-all font-mono text-muted-foreground">
        artifact {lock.artifactChecksum ?? "not recorded"}
      </dd>
      <dd className="break-all text-muted-foreground">
        {lock.sourceRegistry} · {lock.trustLevel ?? "unknown trust"}
      </dd>
      <dd className="break-all font-mono text-muted-foreground">
        {lock.artifactReference ?? "No artifact reference"}
      </dd>
    </dl>
  );
}

function fallbackAssistantWorkflowPatch(
  prompt: string,
  actions: ActionPackage[],
): AssistantWorkflowPatchOperation[] {
  const normalizedPrompt = normalizeSearchText(prompt);
  const requestedActions = [
    ...fallbackNamedActions(normalizedPrompt),
    ...actions
      .filter((action) => actionPromptMatchIndex(action, normalizedPrompt) >= 0)
      .sort(
        (left, right) =>
          actionPromptMatchIndex(left, normalizedPrompt) -
          actionPromptMatchIndex(right, normalizedPrompt),
      )
      .map((action) => action.name),
  ];
  const actionNames = new Set(actions.map((action) => action.name));
  const uniqueActions = [...new Set(requestedActions)].filter((name) =>
    actionNames.has(name),
  );
  if (!uniqueActions.length) {
    return [];
  }
  return uniqueActions.map((actionName, index) => ({
    op: "add_step",
    ref: `draft_${actionName.replace(/[^a-z0-9]+/gi, "_")}_${index + 1}`,
    actionPackageName: actionName,
    config: {},
  }));
}

function mergeAssistantWorkflowPatch(
  planPatch: AssistantWorkflowPatchOperation[],
  fallbackPatch: AssistantWorkflowPatchOperation[],
): AssistantWorkflowPatchOperation[] {
  if (!fallbackPatch.length) {
    return planPatch;
  }
  if (!planPatch.length) {
    return fallbackPatch;
  }

  const existingActionNames = new Set(
    planPatch
      .filter((operation) => operation.op === "add_step")
      .map((operation) => operation.actionPackageName),
  );
  const additions = fallbackPatch.filter(
    (operation) =>
      operation.op !== "add_step" ||
      !existingActionNames.has(operation.actionPackageName),
  );
  return additions.length ? [...planPatch, ...additions] : planPatch;
}

function patchIncludesFallback(
  patch: AssistantWorkflowPatchOperation[],
  fallbackPatch: AssistantWorkflowPatchOperation[],
) {
  if (!fallbackPatch.length) {
    return false;
  }
  const patchActions = new Set(
    patch
      .filter((operation) => operation.op === "add_step")
      .map((operation) => operation.actionPackageName),
  );
  return fallbackPatch.some(
    (operation) =>
      operation.op === "add_step" &&
      patchActions.has(operation.actionPackageName),
  );
}

function fallbackNamedActions(prompt: string) {
  const actionNames: string[] = [];
  if (/\bfan[\s-]?out\b/.test(prompt) || /\bbranche/.test(prompt)) {
    actionNames.push(FAN_OUT_ACTION);
  }
  if (/\bjoin\b|\bfan[\s-]?in\b|\bregroupe/.test(prompt)) {
    actionNames.push(JOIN_ACTION);
  }
  if (/\bendpoint\b|\bs3\b|\bstorage\b/.test(prompt)) {
    actionNames.push(OBJECT_STORAGE_ENDPOINT_ACTION);
  }
  if (/\btransfer\b|\btransfert\b/.test(prompt)) {
    actionNames.push(BEAM_TRANSFER_ACTION);
  }
  return actionNames;
}

function actionPromptMatchIndex(action: ActionPackage, prompt: string) {
  const names = [
    action.name.replace(/^@[^/]+\//, ""),
    action.name.replace(/^@[^/]+\//, "").replace(/[-_]+/g, " "),
    action.manifest.displayName,
  ]
    .map(normalizeSearchText)
    .filter((value) => value.length > 2);
  const exactMatchIndexes = names
    .map((name) => prompt.indexOf(name))
    .filter((index) => index >= 0);
  if (exactMatchIndexes.length) {
    return Math.min(...exactMatchIndexes);
  }

  const displayTokens = normalizeSearchText(action.manifest.displayName)
    .split(/\s+/)
    .filter((token) => token.length > 2 && !genericActionToken(token));
  if (
    displayTokens.length >= 2 &&
    displayTokens.every((token) => prompt.includes(token))
  ) {
    return Math.min(...displayTokens.map((token) => prompt.indexOf(token)));
  }

  return -1;
}

function genericActionToken(token: string) {
  return token === "action" || token === "beam" || token === "node";
}

function assistantLanguage(value: string): AssistantLanguage {
  const normalized = normalizeSearchText(value);
  const frenchScore = markerScore(normalized, [
    "ajoute",
    "rajoute",
    "liste",
    "montre",
    "donne",
    "fais",
    "fait",
    "quoi",
    "quel",
    "quelle",
    "pourquoi",
    "comment",
    "avec",
    "sans",
    "dans",
    "mes",
    "mon",
    "ma",
    "le",
    "la",
    "les",
    "un",
    "une",
    "des",
  ]);
  const englishScore = markerScore(normalized, [
    "add",
    "list",
    "show",
    "tell",
    "create",
    "insert",
    "update",
    "rename",
    "what",
    "which",
    "why",
    "how",
    "with",
    "without",
    "my",
    "the",
    "a",
    "an",
  ]);
  return frenchScore > englishScore ? "fr" : "en";
}

function markerScore(value: string, markers: string[]) {
  return markers.reduce(
    (score, marker) =>
      score + (new RegExp(`\\b${escapeRegExp(marker)}\\b`).test(value) ? 1 : 0),
    0,
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSearchText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function WorkflowDetailLoadingState() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="grid h-full w-full place-items-center bg-background p-6"
      role="status"
    >
      <div className="grid w-full max-w-md gap-3 rounded-control border bg-card p-5 text-sm text-muted-foreground shadow-sm">
        <SkeletonBlock className="h-4 w-36" />
        <SkeletonBlock className="h-3 w-full" />
        <SkeletonBlock className="h-3 w-3/4" />
      </div>
    </div>
  );
}

function WorkflowEditorLoadingState() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="relative min-h-0 flex-1 overflow-hidden bg-background"
      role="status"
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle,hsl(var(--border))_1px,transparent_1px)] [background-size:24px_24px]" />
      <div className="absolute left-4 right-4 top-4 z-10 flex justify-center">
        <GraphActionBarLoading />
      </div>
    </div>
  );
}

function SkeletonBlock({ className }: { className: string }) {
  return (
    <span
      className={`${className} block shrink-0 animate-pulse rounded-control-compact bg-muted`}
    />
  );
}

function patchCanvasNode(
  node: Node<WorkflowCanvasNodeData>,
  patch: Partial<WorkflowCanvasNodeData>,
): Node<WorkflowCanvasNodeData> {
  if (isStepNode(node)) {
    return {
      ...node,
      data: {
        ...node.data,
        ...(patch as Partial<WorkflowNodeData>),
        nodeKind: "step",
      },
    };
  }

  if (isTriggerNode(node)) {
    const triggerPatch = patch as Partial<WorkflowTriggerNodeData>;
    return {
      ...node,
      data: {
        id: triggerPatch.id ?? node.data.id,
        workflowTemplateId:
          triggerPatch.workflowTemplateId ?? node.data.workflowTemplateId,
        type: triggerPatch.type ?? node.data.type,
        name: triggerPatch.name ?? node.data.name,
        enabled: triggerPatch.enabled ?? node.data.enabled,
        config: triggerPatch.config ?? node.data.config,
        state: triggerPatch.state ?? node.data.state,
        canvasX: triggerPatch.canvasX ?? node.data.canvasX,
        canvasY: triggerPatch.canvasY ?? node.data.canvasY,
        createdAt: triggerPatch.createdAt ?? node.data.createdAt,
        updatedAt: triggerPatch.updatedAt ?? node.data.updatedAt,
        nodeKind: "trigger",
        workflowNodeKind: "trigger",
        definition: node.data.definition,
        issues: triggerPatch.issues ?? node.data.issues,
      },
    };
  }

  if (isControlNode(node)) {
    return {
      ...node,
      data: {
        ...node.data,
        ...(patch as Partial<typeof node.data>),
        nodeKind: "control",
      },
    };
  }

  if (isDecisionNode(node)) {
    return {
      ...node,
      data: {
        ...node.data,
        ...(patch as Partial<WorkflowDecisionNodeData>),
        nodeKind: "decision",
      },
    };
  }

  return node;
}

function duplicateTriggerNode(
  source: Node<WorkflowCanvasNodeData>,
  order: number,
): Node<WorkflowTriggerNodeData> | null {
  if (!isTriggerNode(source)) {
    return null;
  }

  const id = `wftg_${shortId()}`;
  const position = {
    x: source.position.x + 48,
    y: source.position.y + 48,
  };

  return {
    ...source,
    id,
    selected: false,
    position,
    data: {
      ...source.data,
      id,
      name: `${source.data.name} copy`,
      config: { ...source.data.config },
      state: { ...source.data.state },
      canvasX: position.x,
      canvasY: position.y,
      createdAt: undefined,
      updatedAt: undefined,
      issues: [],
      nodeKind: "trigger",
    },
  };
}

function cloneGraphSnapshot(snapshot: GraphSnapshot): GraphSnapshot {
  return {
    distribution: snapshot.distribution
      ? structuredClone(snapshot.distribution)
      : null,
    edges: snapshot.edges.map((edge) => ({
      ...edge,
      data: edge.data ? { ...edge.data } : edge.data,
      markerEnd:
        edge.markerEnd && typeof edge.markerEnd === "object"
          ? { ...edge.markerEnd }
          : edge.markerEnd,
      style: edge.style ? { ...edge.style } : edge.style,
    })),
    nodes: snapshot.nodes.map((node) => {
      if (isStepNode(node)) {
        return {
          ...node,
          data: {
            ...node.data,
            config: { ...node.data.config },
            inputBindings: { ...node.data.inputBindings },
            issues: [...node.data.issues],
          },
          position: { ...node.position },
        };
      }
      if (isTriggerNode(node)) {
        return {
          ...node,
          data: {
            ...node.data,
            config: { ...node.data.config },
            state: { ...node.data.state },
            issues: [...node.data.issues],
          },
          position: { ...node.position },
        };
      }
      return {
        ...node,
        position: { ...node.position },
      };
    }),
  };
}

function beamTransferBindingPlan(
  role: BeamTransferEndpointRole,
): AutomaticBindingPlan {
  return {
    inputKey: role === "source" ? "sourceEndpoints" : "destinationEndpoints",
    outputKey: "endpoint",
    mode: "append",
  };
}

function removeBindingsForEdges(
  nodes: Node<WorkflowCanvasNodeData>[],
  removedEdges: Edge[],
) {
  let nextNodes = nodes;
  for (const edge of removedEdges) {
    const runtimeSourceId = edgeRuntimeSource(edge);
    const runtimeTargetId = edgeRuntimeTarget(edge);
    const source = nextNodes.find(
      (node) => node.id === runtimeSourceId && isStepNode(node),
    );
    const target = nextNodes.find(
      (node) => node.id === runtimeTargetId && isStepNode(node),
    );
    if (!source || !target || !isStepNode(source) || !isStepNode(target)) {
      continue;
    }
    const plan = automaticBindingPlan(source, target);
    if (!plan) {
      continue;
    }
    nextNodes = nextNodes.map((node) =>
      node.id === runtimeTargetId && isStepNode(node)
        ? {
            ...node,
            data: {
              ...node.data,
              inputBindings: removeAutomaticBinding(
                node.data.inputBindings,
                plan,
                runtimeSourceId,
              ),
            },
          }
        : node,
    );
  }
  return nextNodes;
}

function edgeTouchesRuntimeNode(edge: Edge, nodeIds: ReadonlySet<string>) {
  return (
    !isTriggerEdge(edge) &&
    (nodeIds.has(edgeRuntimeSource(edge)) ||
      nodeIds.has(edgeRuntimeTarget(edge)))
  );
}

function triggerEdgePayload(edge: {
  id: string;
  triggerId: string;
  toStepId: string;
  condition: unknown;
}) {
  return {
    id: edge.id,
    triggerId: edge.triggerId,
    toStepId: edge.toStepId,
    condition: edge.condition ?? null,
  };
}

function graphSignature(payload: unknown) {
  return JSON.stringify(payload);
}

export function workflowGraphLoadErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
