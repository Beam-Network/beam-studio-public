import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  Download,
  ExternalLink,
  Info,
  History,
  Loader2,
  MoreHorizontal,
  RotateCcw,
  Sparkles,
  SquarePen,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type {
  AssistantMessage,
  AssistantModelOption,
  AssistantOperationPlan,
  AssistantProviderSettings,
  AssistantProviderSummary,
  AssistantReasoningEffort,
} from "@beam-studio/shared";
import { PanelHeader } from "@/components/header-primitives";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { MarkdownContent } from "@/features/registry/markdown";
import { apiGet, apiSend } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
  AssistantComposer,
  AssistantPlanCard,
  renderUserMessage,
} from "@/routes/new";

type ProvidersPayload = {
  providers: AssistantProviderSummary[];
  settings: AssistantProviderSettings | null;
};

type ChatResponse = {
  message: string;
  conversationId?: string;
  provider?: AssistantProviderSummary;
  degraded?: boolean;
  error?: string;
  providerMessage?: string;
  citations?: AssistantCitation[];
  plan?: AssistantOperationPlan;
};

type ConversationSummary = {
  id: string;
  title: string;
  route: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

type ConversationsPayload = {
  conversations: ConversationSummary[];
};

type ConversationPayload = {
  conversation: ConversationSummary & {
    messages: Array<{
      id: string;
      role: "user" | "assistant";
      content: string;
      meta: unknown;
    }>;
  };
};

type AssistantCitation = {
  id?: string;
  kind: "action" | "credential" | "registry" | "route" | "run" | "workflow";
  label: string;
  href: string;
  description?: string;
};

type AssistantMessageMeta = {
  citations?: AssistantCitation[];
  degraded?: boolean;
  error?: string;
  provider?: AssistantProviderSummary;
  providerMessage?: string;
  plan?: AssistantOperationPlan;
  planId?: string;
  workflowDraft?: WorkflowDraftMessageMeta;
};

type LocalAssistantMessage = AssistantMessage & {
  id: string;
  meta?: AssistantMessageMeta;
};

type AssistantRouteContext = {
  actionPackageName?: string;
  credentials?: unknown;
  registry?: unknown;
  routeKind: string;
  runId?: string;
  runs?: unknown;
  selectedNodeId?: string | null;
  studio?: unknown;
  validationErrors?: unknown;
  workflow?: unknown;
  workflowId?: string;
  workflows?: unknown;
};

export type StudioAssistantEditorContext = {
  acceptWorkflowDraft(id: string): Promise<void> | void;
  discardWorkflowDraft(id: string): void;
  requestWorkflowDraft(
    prompt: string,
    model?: string,
    reasoningEffort?: AssistantReasoningEffort,
  ): Promise<StudioAssistantWorkflowDraftResult>;
  selectedNodeId?: string | null;
  validationErrors: string[];
  workflow: unknown;
  workflowId: string;
};

type StudioAssistantWorkflowDraftResult = {
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

type WorkflowDraftStatus = "accepted" | "discarded" | "error" | "pending";

type WorkflowDraftMessageMeta = {
  error?: string;
  id: string;
  patchErrors?: string[];
  status: WorkflowDraftStatus;
};

type WorkflowDraftView = WorkflowDraftMessageMeta & {
  busy?: boolean;
};

type AssistantLanguage = "en" | "fr";

type StudioAssistantContextValue = {
  available: boolean;
  closeAssistant(): void;
  open: boolean;
  openAssistant(): void;
  setEditorContext(context: StudioAssistantEditorContext | null): void;
  setOpen(open: boolean): void;
  toggleAssistant(): void;
};

type RouteInfo = {
  actionPackageName?: string;
  needsCredentials: boolean;
  needsRegistry: boolean;
  needsRun: boolean;
  needsRuns: boolean;
  needsWorkflow: boolean;
  needsWorkflows: boolean;
  routeKind: AssistantRouteContext["routeKind"];
  runId?: string;
  workflowId?: string;
};

const StudioAssistantContext =
  createContext<StudioAssistantContextValue | null>(null);

const assistantOpenStorageKey = "beam-studio.assistant.open";

export function StudioAssistantProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const route = location.pathname;
  const workflowRoute = route.startsWith("/workflows/");

  const assistantEnabled =
    route !== "/login" &&
    route !== "/auth" &&
    route !== "/" &&
    route !== "/new" &&
    !workflowRoute;
  // Restored after mount, not during render: this component is server-rendered
  // and localStorage only exists on the client.
  const [open, setStoredOpen] = useState(false);
  const [, setEditorContextState] =
    useState<StudioAssistantEditorContext | null>(null);
  const setOpen = useCallback((nextOpen: boolean) => {
    setStoredOpen(nextOpen);
    try {
      localStorage.setItem(assistantOpenStorageKey, nextOpen ? "1" : "0");
    } catch {
      // Ignore storage failures; the assistant remains usable for the session.
    }
  }, []);
  const openAssistant = useCallback(() => setOpen(true), [setOpen]);
  const closeAssistant = useCallback(() => setOpen(false), [setOpen]);
  const toggleAssistant = useCallback(
    () =>
      setStoredOpen((current) => {
        const nextOpen = !current;
        try {
          localStorage.setItem(assistantOpenStorageKey, nextOpen ? "1" : "0");
        } catch {
          // Ignore storage failures; the assistant remains usable for the session.
        }
        return nextOpen;
      }),
    [],
  );
  const setEditorContext = useCallback(
    (context: StudioAssistantEditorContext | null) =>
      setEditorContextState(context),
    [],
  );
  const value = useMemo(
    () => ({
      available: assistantEnabled,
      closeAssistant,
      open,
      openAssistant,
      setEditorContext,
      setOpen,
      toggleAssistant,
    }),
    [
      assistantEnabled,
      closeAssistant,
      open,
      openAssistant,
      setEditorContext,
      setOpen,
      toggleAssistant,
    ],
  );

  useEffect(() => {
    setStoredOpen(readStoredAssistantOpen());
  }, []);

  useEffect(() => {
    if (!assistantEnabled && open) {
      setOpen(false);
    }
  }, [assistantEnabled, open, setOpen]);

  useEffect(() => {
    if (!assistantEnabled) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "i" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        toggleAssistant();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [assistantEnabled, toggleAssistant]);

  return (
    <StudioAssistantContext.Provider value={value}>
      {children}
    </StudioAssistantContext.Provider>
  );
}

export function useStudioAssistant() {
  const context = useContext(StudioAssistantContext);
  if (!context) {
    throw new Error(
      "useStudioAssistant must be used within StudioAssistantProvider.",
    );
  }
  return context;
}

export function StudioAssistantChat({
  editorContext,
  onOpenChange,
  open,
  route,
  variant = "drawer",
}: {
  editorContext?: StudioAssistantEditorContext | null;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  route: string;
  variant?: "drawer" | "editor";
}) {
  const titleId = useId();
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<LocalAssistantMessage[]>([]);
  const [workflowDraft, setWorkflowDraft] = useState<WorkflowDraftView | null>(
    null,
  );
  const routeInfo = useMemo(() => assistantRouteInfo(route), [route]);
  const queryClient = useQueryClient();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editorMessagesOpen, setEditorMessagesOpen] = useState(true);
  const providersQuery = useQuery({
    queryKey: ["/studio/ai/providers"],
    queryFn: () => apiGet<ProvidersPayload>("/studio/ai/providers"),
    enabled: open,
  });
  const configuredProvider = providersQuery.data?.providers[0] ?? null;
  const hasStoredAssistantSettings = Boolean(providersQuery.data?.settings);
  const assistantReady = Boolean(
    configuredProvider?.configured &&
    configuredProvider.enabled &&
    configuredProvider.status === "ready",
  );
  const conversationsQuery = useQuery({
    queryKey: ["/studio/assistant/conversations"],
    queryFn: () =>
      apiGet<ConversationsPayload>("/studio/assistant/conversations"),
    enabled: open && historyOpen,
  });
  const defaultModel =
    configuredProvider?.model || configuredProvider?.models?.fallback || "";
  const [selectedModel, setSelectedModel] = useState("");
  const [reasoningEffort, setReasoningEffort] =
    useState<AssistantReasoningEffort>("medium");
  const activeModel = selectedModel || defaultModel;
  const modelsQuery = useQuery({
    queryKey: [
      "/studio/ai/models",
      configuredProvider?.id,
      hasStoredAssistantSettings,
    ],
    queryFn: () =>
      hasStoredAssistantSettings
        ? apiGet<{ models: AssistantModelOption[] }>("/studio/ai/models")
        : apiSend<{ models: AssistantModelOption[] }>(
            "POST",
            "/studio/ai/models/discover",
            {},
          ),
    enabled: open && providersQuery.isSuccess,
    retry: false,
    staleTime: Infinity,
  });
  const modelSettingsMutation = useMutation({
    mutationFn: (model: string) =>
      apiSend("PATCH", "/studio/ai/settings", {
        model,
        models: modelsQuery.data?.models,
      }),
    onSuccess: async (_response, model) => {
      setSelectedModel(model);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/studio/ai/providers"] }),
        queryClient.invalidateQueries({ queryKey: ["/studio/settings"] }),
      ]);
    },
  });
  const contextQuery = useQuery({
    queryKey: ["/studio/assistant/context", route],
    queryFn: () =>
      apiGet<Record<string, unknown>>(
        `/studio/assistant/context?route=${encodeURIComponent(route)}`,
      ),
    enabled: open,
  });
  const routeContext = useMemo(
    () =>
      createRouteContext({
        editorContext,
        routeInfo,
        studioContext: contextQuery.data,
      }),
    [contextQuery.data, editorContext, routeInfo],
  );
  const lastResponseProvider = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.meta?.provider)
    ?.meta?.provider;
  const provider =
    lastResponseProvider ?? providersQuery.data?.providers[0] ?? null;
  const providerStatus = provider
    ? provider.configured
      ? "ready"
      : provider.status
    : providersQuery.isError
      ? "Provider unavailable"
      : providersQuery.isPending
        ? "Loading provider"
        : "No provider";
  const chatMutation = useMutation({
    mutationFn: ({
      nextMessages,
      routeContext,
    }: {
      nextMessages: LocalAssistantMessage[];
      routeContext: AssistantRouteContext;
    }) =>
      apiSend<ChatResponse>("POST", "/studio/assistant/chat", {
        context: routeContext,
        conversationId,
        idempotencyKey: [...nextMessages]
          .reverse()
          .find((message) => message.role === "user")?.id,
        messages: nextMessages.map(apiMessage),
        model: activeModel || undefined,
        reasoningEffort,
        route,
      }),
    onSuccess: (response, variables) => {
      if (response.conversationId) {
        setConversationId(response.conversationId);
        void queryClient.invalidateQueries({
          queryKey: ["/studio/assistant/conversations"],
        });
      }
      setMessages((current) => [
        ...current,
        createMessage("assistant", response.message, {
          citations: response.citations?.length
            ? response.citations
            : citationsForRouteContext(variables.routeContext),
          degraded: response.degraded,
          error: response.error,
          plan: response.plan,
          planId: response.plan?.id,
          provider: response.provider,
          providerMessage: response.providerMessage,
        }),
      ]);
    },
  });
  const workflowDraftMutation = useMutation({
    mutationFn: ({
      prompt,
      model,
      reasoningEffort,
    }: {
      prompt: string;
      model?: string;
      reasoningEffort?: AssistantReasoningEffort;
    }) => {
      if (!editorContext?.requestWorkflowDraft) {
        throw new Error("Open a workflow editor before asking for edits.");
      }
      return editorContext.requestWorkflowDraft(prompt, model, reasoningEffort);
    },
    onSuccess: (result, variables) => {
      const status: WorkflowDraftStatus = result.applied
        ? "pending"
        : result.patchErrors.length
          ? "error"
          : "pending";
      const draftMeta: WorkflowDraftMessageMeta = {
        id: result.id,
        patchErrors: result.patchErrors,
        status,
      };
      setWorkflowDraft(draftMeta);
      setMessages((current) => [
        ...current,
        createMessage(
          "assistant",
          workflowDraftMessage(result, routeContext, variables.prompt),
          {
            citations: citationsForRouteContext(routeContext),
            degraded: result.degraded,
            provider: result.provider,
            providerMessage: result.providerMessage,
            workflowDraft: draftMeta,
          },
        ),
      ]);
    },
  });
  const assistantBusy =
    chatMutation.isPending ||
    workflowDraftMutation.isPending ||
    workflowDraft?.busy === true;
  const lastAssistantIndex = messages.reduce(
    (last, message, index) => (message.role === "assistant" ? index : last),
    -1,
  );

  useEffect(() => {
    if (
      variant === "editor" &&
      (messages.length > 0 || assistantBusy || historyOpen)
    ) {
      setEditorMessagesOpen(true);
    }
  }, [assistantBusy, historyOpen, messages.length, variant]);

  function startNewConversation() {
    setConversationId(null);
    setMessages([]);
    setWorkflowDraft(null);
    setDraft("");
    setHistoryOpen(false);
  }

  async function openConversation(id: string) {
    setHistoryOpen(false);
    const payload = await apiGet<ConversationPayload>(
      `/studio/assistant/conversations/${encodeURIComponent(id)}`,
    );
    setConversationId(payload.conversation.id);
    setWorkflowDraft(null);
    setMessages(
      payload.conversation.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        meta: readMessageMeta(message.meta),
      })),
    );
  }

  async function deleteConversation(id: string) {
    await apiSend(
      "DELETE",
      `/studio/assistant/conversations/${encodeURIComponent(id)}`,
    );
    await queryClient.invalidateQueries({
      queryKey: ["/studio/assistant/conversations"],
    });
    if (id === conversationId) {
      startNewConversation();
    }
  }

  function submitMessage(content: string) {
    const trimmed = content.trim();
    if (
      !assistantReady ||
      !trimmed ||
      assistantBusy ||
      modelSettingsMutation.isPending
    ) {
      return;
    }
    const nextMessages: LocalAssistantMessage[] = [
      ...messages,
      createMessage("user", trimmed),
    ];
    setMessages(nextMessages);
    setDraft("");
    if (shouldDraftWorkflowChange(trimmed, editorContext)) {
      workflowDraftMutation.mutate({
        prompt: trimmed,
        model: activeModel,
        reasoningEffort,
      });
      return;
    }
    chatMutation.mutate({ nextMessages, routeContext });
  }

  function retryLast() {
    if (!assistantReady || assistantBusy || modelSettingsMutation.isPending) {
      return;
    }
    const lastUser = [...messages]
      .reverse()
      .find((message) => message.role === "user");
    if (!lastUser) {
      return;
    }
    const trimmedMessages =
      messages[messages.length - 1]?.role === "assistant"
        ? messages.slice(0, -1)
        : messages;
    setMessages(trimmedMessages);
    if (shouldDraftWorkflowChange(lastUser.content, editorContext)) {
      workflowDraftMutation.mutate({
        prompt: lastUser.content,
        model: activeModel,
        reasoningEffort,
      });
      return;
    }
    chatMutation.mutate({ nextMessages: trimmedMessages, routeContext });
  }

  async function acceptWorkflowDraft(id: string) {
    if (!editorContext?.acceptWorkflowDraft) {
      updateWorkflowDraftStatus(id, "error", "Open the workflow editor first.");
      return;
    }
    setWorkflowDraft((current) =>
      current?.id === id ? { ...current, busy: true } : current,
    );
    try {
      await editorContext.acceptWorkflowDraft(id);
      updateWorkflowDraftStatus(id, "accepted");
    } catch (error) {
      updateWorkflowDraftStatus(
        id,
        "error",
        error instanceof Error ? error.message : "Could not accept draft.",
      );
    }
  }

  function discardWorkflowDraft(id: string) {
    if (!editorContext?.discardWorkflowDraft) {
      updateWorkflowDraftStatus(id, "error", "Open the workflow editor first.");
      return;
    }
    try {
      editorContext.discardWorkflowDraft(id);
      updateWorkflowDraftStatus(id, "discarded");
    } catch (error) {
      updateWorkflowDraftStatus(
        id,
        "error",
        error instanceof Error ? error.message : "Could not discard draft.",
      );
    }
  }

  function updateWorkflowDraftStatus(
    id: string,
    status: WorkflowDraftStatus,
    error?: string,
  ) {
    setWorkflowDraft((current) =>
      current?.id === id ? { ...current, busy: false, error, status } : current,
    );
    setMessages((current) =>
      current.map((message) =>
        message.meta?.workflowDraft?.id === id
          ? {
              ...message,
              meta: {
                ...message.meta,
                workflowDraft: {
                  ...message.meta.workflowDraft,
                  error,
                  status,
                },
              },
            }
          : message,
      ),
    );
  }

  const composerBusy = assistantBusy || modelSettingsMutation.isPending;
  const modelsLoading = providersQuery.isPending || modelsQuery.isPending;
  const modelEmptyLabel = modelsLoading
    ? "Loading models…"
    : modelsQuery.isError
      ? "Could not load models"
      : "No compatible models";
  const setupError = providersQuery.error ?? modelsQuery.error;
  const setupNotice =
    modelSettingsMutation.isError ||
    setupError ||
    (!assistantReady && (modelsLoading || !modelsQuery.data?.models.length)) ? (
      <div
        className="rounded-surface border bg-card/90 px-3 py-2 text-xs text-muted-foreground"
        role={modelSettingsMutation.isError || setupError ? "alert" : "status"}
      >
        {modelSettingsMutation.isError ? (
          "Could not save the selected model. Please select it again to retry."
        ) : setupError ? (
          <div className="flex items-center justify-between gap-2">
            <span>Could not load BEAM AI. Please try again.</span>
            <Button
              disabled={providersQuery.isFetching || modelsQuery.isFetching}
              onClick={() => {
                if (providersQuery.isError) {
                  void providersQuery.refetch();
                } else {
                  void modelsQuery.refetch();
                }
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              Try again
            </Button>
          </div>
        ) : modelsLoading ? (
          "Loading BEAM AI models…"
        ) : (
          "No compatible BEAM AI models are currently available."
        )}
      </div>
    ) : null;

  if (variant === "editor") {
    return (
      <div className="nodrag nopan nowheel absolute bottom-4 left-1/2 z-20 grid w-[min(680px,calc(100%-32px))] -translate-x-1/2 gap-2">
        {editorMessagesOpen &&
        (messages.length ||
          assistantBusy ||
          historyOpen ||
          chatMutation.error ||
          workflowDraftMutation.error) ? (
          <div className="relative max-h-[min(300px,42vh)] overflow-y-auto rounded-surface border border-border/50 bg-card/55 p-3 shadow-xl backdrop-blur-2xl">
            <div className="sticky top-0 z-10 mb-1 flex justify-end gap-1">
              <Button
                aria-label="New conversation"
                className="size-7 rounded-full bg-background/50 backdrop-blur-xl"
                disabled={
                  assistantBusy || (!messages.length && !conversationId)
                }
                onClick={startNewConversation}
                size="icon"
                title="New conversation"
                type="button"
                variant="ghost"
              >
                <SquarePen className="h-3.5 w-3.5" />
              </Button>
              <Button
                aria-label={
                  historyOpen ? "Back to conversation" : "Conversation history"
                }
                className="size-7 rounded-full bg-background/50 backdrop-blur-xl"
                onClick={() => setHistoryOpen((value) => !value)}
                size="icon"
                title={
                  historyOpen ? "Back to conversation" : "Conversation history"
                }
                type="button"
                variant="ghost"
              >
                <History className="h-3.5 w-3.5" />
              </Button>
              <Button
                aria-label="Hide conversation history"
                className="size-7 rounded-full bg-background/50 backdrop-blur-xl"
                onClick={() => setEditorMessagesOpen(false)}
                size="icon"
                title="Hide conversation history"
                type="button"
                variant="ghost"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>

            {historyOpen ? (
              <ConversationHistoryView
                activeConversationId={conversationId}
                conversations={conversationsQuery.data?.conversations ?? []}
                error={conversationsQuery.error}
                loading={conversationsQuery.isPending}
                onDelete={deleteConversation}
                onSelect={openConversation}
              />
            ) : (
              <div className="grid gap-3">
                {messages.map((message, index) => (
                  <EditorChatBubble
                    key={message.id}
                    message={message}
                    onAcceptWorkflowDraft={acceptWorkflowDraft}
                    onDiscardWorkflowDraft={discardWorkflowDraft}
                    onModifyPlan={(plan) =>
                      setDraft(
                        `Modify plan ${plan.id} (${plan.operations
                          .map((operation) => operation.tool)
                          .join(", ")}): `,
                      )
                    }
                    onRetry={
                      index === lastAssistantIndex && !assistantBusy
                        ? retryLast
                        : undefined
                    }
                    workflowDraft={messageWorkflowDraft(message, workflowDraft)}
                  />
                ))}
                {chatMutation.error || workflowDraftMutation.error ? (
                  <div className="flex gap-2 rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="min-w-0 break-words">
                      {String(
                        chatMutation.error ?? workflowDraftMutation.error,
                      )}
                    </span>
                  </div>
                ) : null}
                {assistantBusy ? (
                  <div
                    aria-live="polite"
                    className="flex items-center gap-2.5 text-sm text-muted-foreground"
                  >
                    <BeamLogo className="size-4" />
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Updating workflow…
                  </div>
                ) : null}
              </div>
            )}
          </div>
        ) : null}

        {setupNotice}
        <AssistantComposer
          busy={composerBusy}
          context={routeContext}
          disabled={!assistantReady || composerBusy}
          draft={draft}
          effort={reasoningEffort}
          model={activeModel}
          modelEmptyLabel={modelEmptyLabel}
          models={modelsQuery.data?.models ?? []}
          onDraftChange={setDraft}
          onEffortChange={setReasoningEffort}
          onFocus={() => setEditorMessagesOpen(true)}
          onModelChange={(model) => modelSettingsMutation.mutate(model)}
          onSubmit={submitMessage}
          providerId={configuredProvider?.provider}
          selectionDisabled={composerBusy}
          variant="editor"
        />
      </div>
    );
  }

  return (
    <aside
      aria-labelledby={titleId}
      className={cn(
        "fixed bottom-0 right-0 top-0 z-40 flex w-[min(420px,100vw)] flex-col overflow-hidden border-l bg-card text-card-foreground transition-transform duration-200",
        open ? "translate-x-0" : "translate-x-full",
      )}
      inert={!open}
      role="dialog"
    >
      <PanelHeader className="justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold" id={titleId}>
            Studio Assistant
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {providerStatus}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            aria-label="New conversation"
            disabled={assistantBusy || (!messages.length && !conversationId)}
            onClick={startNewConversation}
            size="icon"
            title="New conversation"
            type="button"
            variant="ghost"
          >
            <SquarePen className="h-4 w-4" />
          </Button>
          <Button
            aria-label={
              historyOpen ? "Back to conversation" : "Conversation history"
            }
            aria-pressed={historyOpen}
            className={cn(historyOpen && "bg-accent text-accent-foreground")}
            onClick={() => setHistoryOpen((value) => !value)}
            size="icon"
            title={
              historyOpen ? "Back to conversation" : "Conversation history"
            }
            type="button"
            variant="ghost"
          >
            <History className="h-4 w-4" />
          </Button>
          <AssistantOverflowMenu
            canExport={messages.length > 0}
            onDeleteConversation={
              conversationId
                ? () => deleteConversation(conversationId)
                : undefined
            }
            onExport={() => exportConversation(messages)}
          />
          <Button
            aria-label="Close Studio assistant"
            onClick={() => onOpenChange(false)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </PanelHeader>

      {historyOpen ? (
        <ConversationHistoryView
          activeConversationId={conversationId}
          conversations={conversationsQuery.data?.conversations ?? []}
          error={conversationsQuery.error}
          loading={conversationsQuery.isPending}
          onDelete={deleteConversation}
          onSelect={openConversation}
        />
      ) : (
        <>
          <MessageScrollerProvider autoScroll defaultScrollPosition="end">
            <MessageScroller className="min-h-0 flex-1">
              <MessageScrollerViewport>
                <MessageScrollerContent className="p-3 pb-[132px]">
                  {messages.length ? (
                    messages.map((message, index) => (
                      <MessageScrollerItem
                        key={message.id}
                        messageId={message.id}
                        scrollAnchor={message.role === "user"}
                      >
                        <ChatBubble
                          message={message}
                          onModifyPlan={(plan) =>
                            setDraft(
                              `Modify plan ${plan.id} (${plan.operations
                                .map((operation) => operation.tool)
                                .join(", ")}): `,
                            )
                          }
                          onRetry={
                            index === lastAssistantIndex && !assistantBusy
                              ? retryLast
                              : undefined
                          }
                          workflowDraft={messageWorkflowDraft(
                            message,
                            workflowDraft,
                          )}
                          onAcceptWorkflowDraft={acceptWorkflowDraft}
                          onDiscardWorkflowDraft={discardWorkflowDraft}
                        />
                      </MessageScrollerItem>
                    ))
                  ) : (
                    <MessageScrollerItem messageId="empty">
                      <EmptyState
                        action={
                          <div className="grid gap-1.5">
                            {assistantSuggestions(routeInfo.routeKind).map(
                              (suggestion) => (
                                <button
                                  className="rounded-control border bg-card px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  key={suggestion}
                                  onClick={() => submitMessage(suggestion)}
                                  type="button"
                                >
                                  {suggestion}
                                </button>
                              ),
                            )}
                          </div>
                        }
                        className="px-4 py-10"
                        description="I can see the page you're on, so you can just say “this workflow” or “this run”."
                        icon={Sparkles}
                        title="Ask about what you're looking at"
                      />
                    </MessageScrollerItem>
                  )}
                  {chatMutation.error || workflowDraftMutation.error ? (
                    <MessageScrollerItem messageId="error">
                      <div className="flex gap-2 rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span className="min-w-0 break-words">
                          {String(
                            chatMutation.error ?? workflowDraftMutation.error,
                          )}
                        </span>
                      </div>
                    </MessageScrollerItem>
                  ) : null}
                  {assistantBusy ? (
                    <MessageScrollerItem messageId="pending">
                      <div
                        aria-live="polite"
                        className="flex items-center gap-2 text-sm text-muted-foreground"
                      >
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Thinking
                      </div>
                    </MessageScrollerItem>
                  ) : null}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton
                className="data-[direction=end]:bottom-[132px]"
                title="Jump to latest"
              />
            </MessageScroller>
          </MessageScrollerProvider>

          <div className="absolute inset-x-0 bottom-0 px-3">
            {setupNotice}
            <AssistantComposer
              busy={composerBusy}
              context={routeContext}
              disabled={!assistantReady || composerBusy}
              draft={draft}
              effort={reasoningEffort}
              model={activeModel}
              modelEmptyLabel={modelEmptyLabel}
              models={modelsQuery.data?.models ?? []}
              onDraftChange={setDraft}
              onEffortChange={setReasoningEffort}
              onModelChange={(model) => modelSettingsMutation.mutate(model)}
              onSubmit={submitMessage}
              providerId={configuredProvider?.provider}
              selectionDisabled={composerBusy}
            />
          </div>
        </>
      )}
    </aside>
  );
}

function ChatBubble({
  message,
  onAcceptWorkflowDraft,
  onDiscardWorkflowDraft,
  onModifyPlan,
  onRetry,
  workflowDraft,
}: {
  message: LocalAssistantMessage;
  onAcceptWorkflowDraft(id: string): void;
  onDiscardWorkflowDraft(id: string): void;
  onModifyPlan(plan: AssistantOperationPlan): void;
  onRetry?: () => void;
  workflowDraft?: WorkflowDraftView | null;
}) {
  const isUser = message.role === "user";
  const citations = isUser ? [] : (message.meta?.citations ?? []);
  return (
    <article
      className={cn(
        "relative grid min-w-0 gap-2 text-sm leading-5",
        isUser ? "ml-8 rounded-control border bg-secondary p-3 pr-10" : "mr-0 py-1",
        !isUser && (onRetry ? "pr-16" : "pr-8"),
      )}
    >
      <div className="absolute right-1 top-1 flex items-center">
        {onRetry ? (
          <Button
            aria-label="Retry this reply"
            className="h-7 w-7 opacity-60 hover:opacity-100"
            onClick={onRetry}
            size="icon"
            title="Retry this reply"
            type="button"
            variant="ghost"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        <Button
          aria-label={`Copy ${isUser ? "your" : "assistant"} message`}
          className="h-7 w-7 opacity-60 hover:opacity-100"
          onClick={() => navigator.clipboard.writeText(message.content)}
          size="icon"
          title="Copy message"
          type="button"
          variant="ghost"
        >
          <ClipboardCopy className="h-3.5 w-3.5" />
        </Button>
      </div>
      {message.meta?.degraded || message.meta?.providerMessage ? (
        <div className="flex gap-2 rounded-control border bg-muted/40 p-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">
            {message.meta.providerMessage
              ? `Local fallback: ${message.meta.providerMessage}`
              : "Local fallback used."}
          </span>
        </div>
      ) : null}
      {isUser ? (
        <p className="whitespace-pre-wrap break-words">
          {renderUserMessage(message.content)}
        </p>
      ) : (
        <MarkdownContent
          assistantLinks
          compact
          muted={false}
          value={message.content}
        />
      )}
      {!isUser && (message.meta?.plan || message.meta?.planId) ? (
        <AssistantPlanCard
          initialPlan={message.meta.plan}
          onModifyPlan={onModifyPlan}
          planId={message.meta.planId ?? message.meta.plan?.id ?? ""}
        />
      ) : null}
      {workflowDraft ? (
        <WorkflowDraftActions
          draft={workflowDraft}
          onAccept={onAcceptWorkflowDraft}
          onDiscard={onDiscardWorkflowDraft}
        />
      ) : null}
      {citations.length ? <CitationList citations={citations} /> : null}
    </article>
  );
}

function EditorChatBubble({
  message,
  onAcceptWorkflowDraft,
  onDiscardWorkflowDraft,
  onModifyPlan,
  onRetry,
  workflowDraft,
}: {
  message: LocalAssistantMessage;
  onAcceptWorkflowDraft(id: string): void;
  onDiscardWorkflowDraft(id: string): void;
  onModifyPlan(plan: AssistantOperationPlan): void;
  onRetry?: () => void;
  workflowDraft?: WorkflowDraftView | null;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[82%] whitespace-pre-wrap rounded-surface rounded-br-control bg-primary px-3.5 py-2.5 text-sm leading-5 text-primary-foreground shadow-sm">
          {renderUserMessage(message.content)}
        </div>
      </div>
    );
  }

  const citations = message.meta?.citations ?? [];
  return (
    <div className="flex items-start gap-2.5">
      <BeamLogo className="mt-1 size-4" />
      <div className="relative min-w-0 flex-1 rounded-surface rounded-tl-control border border-border/40 bg-background/35 px-3.5 py-2.5 text-sm shadow-sm">
        <div className="absolute right-1 top-1 flex">
          {onRetry ? (
            <Button
              aria-label="Retry this reply"
              className="size-7 opacity-60 hover:opacity-100"
              onClick={onRetry}
              size="icon"
              title="Retry this reply"
              type="button"
              variant="ghost"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          <Button
            aria-label="Copy assistant message"
            className="size-7 opacity-60 hover:opacity-100"
            onClick={() => navigator.clipboard.writeText(message.content)}
            size="icon"
            title="Copy message"
            type="button"
            variant="ghost"
          >
            <ClipboardCopy className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="pr-12">
          <MarkdownContent
            assistantLinks
            compact
            muted={false}
            value={message.content}
          />
        </div>
        {message.meta?.plan || message.meta?.planId ? (
          <div className="mt-2">
            <AssistantPlanCard
              initialPlan={message.meta.plan}
              onModifyPlan={onModifyPlan}
              planId={message.meta.planId ?? message.meta.plan?.id ?? ""}
            />
          </div>
        ) : null}
        {workflowDraft ? (
          <div className="mt-2">
            <WorkflowDraftActions
              draft={workflowDraft}
              onAccept={onAcceptWorkflowDraft}
              onDiscard={onDiscardWorkflowDraft}
            />
          </div>
        ) : null}
        {citations.length ? <CitationList citations={citations} /> : null}
      </div>
    </div>
  );
}

function messageWorkflowDraft(
  message: LocalAssistantMessage,
  activeDraft: WorkflowDraftView | null,
) {
  const messageDraft = message.meta?.workflowDraft;
  if (!messageDraft) {
    return null;
  }
  if (activeDraft?.id === messageDraft.id) {
    return activeDraft;
  }
  return messageDraft.status === "pending" ? null : messageDraft;
}

function WorkflowDraftActions({
  draft,
  onAccept,
  onDiscard,
}: {
  draft: WorkflowDraftView;
  onAccept(id: string): void;
  onDiscard(id: string): void;
}) {
  if (draft.status === "error") {
    return (
      <div className="grid gap-1 rounded-control border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
        {(draft.patchErrors?.length
          ? draft.patchErrors
          : [draft.error || "Could not apply draft."]
        ).map((error, index) => (
          <span className="break-words" key={`${error}:${index}`}>
            {error}
          </span>
        ))}
      </div>
    );
  }

  if (draft.status === "accepted" || draft.status === "discarded") {
    return (
      <div className="inline-flex w-fit items-center gap-2 rounded-control border bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
        {draft.status === "accepted" ? (
          <CheckCircle2 className="h-3.5 w-3.5" />
        ) : (
          <Undo2 className="h-3.5 w-3.5" />
        )}
        {draft.status === "accepted" ? "Accepted" : "Discarded"}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2 rounded-control border bg-muted/30 p-2">
      <Button
        disabled={draft.busy}
        onClick={() => onAccept(draft.id)}
        size="sm"
        type="button"
      >
        {draft.busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <CheckCircle2 className="h-4 w-4" />
        )}
        Accept
      </Button>
      <Button
        disabled={draft.busy}
        onClick={() => onDiscard(draft.id)}
        size="sm"
        type="button"
        variant="secondary"
      >
        <Undo2 className="h-4 w-4" />
        Discard
      </Button>
    </div>
  );
}

function CitationList({ citations }: { citations: AssistantCitation[] }) {
  return (
    <div className="flex flex-wrap gap-1.5 pt-1">
      {dedupeCitations(citations).map((citation) => (
        <a
          className="inline-flex max-w-full items-center gap-1 rounded-control border bg-muted/40 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          href={citation.href}
          key={`${citation.kind}:${citation.href}:${citation.label}`}
          title={citation.description || citation.label}
        >
          <span className="truncate">{citation.label}</span>
          <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
      ))}
    </div>
  );
}

function readStoredAssistantOpen() {
  try {
    return localStorage.getItem(assistantOpenStorageKey) === "1";
  } catch {
    return false;
  }
}

function createMessage(
  role: AssistantMessage["role"],
  content: string,
  meta?: AssistantMessageMeta,
): LocalAssistantMessage {
  return {
    id: `msg-${Date.now().toString(36)}-${shortId()}`,
    role,
    content,
    ...(meta ? { meta } : {}),
  };
}

function apiMessage(message: LocalAssistantMessage): AssistantMessage {
  return {
    role: message.role,
    content: message.content,
  };
}

function exportConversation(messages: LocalAssistantMessage[]) {
  const body = messages
    .map((message) =>
      [
        `## ${message.role === "user" ? "User" : "Assistant"}`,
        "",
        message.content.trim(),
      ].join("\n"),
    )
    .join("\n\n---\n\n");
  const content = [
    "# Studio Assistant Conversation",
    "",
    `Exported: ${new Date().toISOString()}`,
    "",
    body,
    "",
  ].join("\n");
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = `studio-assistant-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}

function shortId() {
  return (
    globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 8) ??
    Math.random().toString(36).slice(2, 10)
  );
}

function assistantSuggestions(routeKind: RouteInfo["routeKind"]) {
  switch (routeKind) {
    case "action":
      return [
        "What does this action do?",
        "Which inputs are required?",
        "Which credential does it need?",
      ];
    case "credentials":
      return [
        "Which credentials are unused?",
        "Which workflows use these credentials?",
      ];
    case "registry":
      return ["Which actions can move files?", "What's in the registry?"];
    case "run":
      return [
        "Why did this run fail?",
        "Summarise what happened",
        "Which step took the longest?",
      ];
    case "runs":
      return ["Which runs failed today?", "Which workflow fails most often?"];
    case "workflow":
      return [
        "Explain this workflow",
        "What happens if a step fails?",
        "Add a notification step at the end",
      ];
    case "workflows":
      return ["Which workflows are enabled?", "Which one hasn't run recently?"];
    default:
      return [
        "What can you help me with?",
        "How do I create a workflow?",
        "Why is a transfer stuck?",
      ];
  }
}

function assistantRouteInfo(route: string): RouteInfo {
  const pathname = route.split("?")[0] || "/";
  const contextualWorkflowRunMatch = pathname.match(
    /^\/workflows\/([^/]+)\/runs\/([^/]+)/,
  );
  const workflowRunMatch = pathname.match(/^\/workflows\/runs\/([^/]+)/);
  const runMatch = pathname.match(/^\/runs\/([^/]+)/);
  const workflowMatch = pathname.match(
    /^\/workflows\/(?!actions(?:\/|$)|runs(?:\/|$)|new(?:\/|$))([^/]+)/,
  );
  const registryMatch = pathname.match(/^\/registry\/([^/]+)\/([^/]+)/);

  if (
    contextualWorkflowRunMatch?.[2] ||
    workflowRunMatch?.[1] ||
    runMatch?.[1]
  ) {
    return {
      needsCredentials: false,
      needsRegistry: false,
      needsRun: true,
      needsRuns: false,
      needsWorkflow: Boolean(contextualWorkflowRunMatch?.[1]),
      needsWorkflows: false,
      routeKind: "run",
      runId: decodePathPart(
        contextualWorkflowRunMatch?.[2] ??
          workflowRunMatch?.[1] ??
          runMatch?.[1] ??
          "",
      ),
      workflowId: contextualWorkflowRunMatch?.[1]
        ? decodePathPart(contextualWorkflowRunMatch[1])
        : undefined,
    };
  }

  if (workflowMatch?.[1]) {
    return {
      needsCredentials: false,
      needsRegistry: false,
      needsRun: false,
      needsRuns: true,
      needsWorkflow: true,
      needsWorkflows: false,
      routeKind: "workflow",
      workflowId: decodePathPart(workflowMatch[1]),
    };
  }

  if (registryMatch?.[1] && registryMatch[2]) {
    return {
      actionPackageName: `${decodePathPart(registryMatch[1])}/${decodePathPart(
        registryMatch[2],
      )}`,
      needsCredentials: false,
      needsRegistry: true,
      needsRun: false,
      needsRuns: false,
      needsWorkflow: false,
      needsWorkflows: false,
      routeKind: "action",
    };
  }

  if (pathname.startsWith("/runs") || pathname.startsWith("/workflows/runs")) {
    return routeInfo("runs", { needsRuns: true });
  }
  if (pathname.startsWith("/workflows")) {
    return routeInfo("workflows", { needsWorkflows: true });
  }
  if (pathname.startsWith("/registry")) {
    return routeInfo("registry", { needsRegistry: true });
  }
  if (pathname.startsWith("/credentials")) {
    return routeInfo("credentials", { needsCredentials: true });
  }
  return routeInfo("route");
}

function routeInfo(
  routeKind: RouteInfo["routeKind"],
  flags: Partial<RouteInfo> = {},
): RouteInfo {
  return {
    needsCredentials: false,
    needsRegistry: false,
    needsRun: false,
    needsRuns: false,
    needsWorkflow: false,
    needsWorkflows: false,
    routeKind,
    ...flags,
  };
}

function createRouteContext(input: {
  editorContext?: StudioAssistantEditorContext | null;
  routeInfo: RouteInfo;
  studioContext?: Record<string, unknown>;
}): AssistantRouteContext {
  const context = isRecord(input.studioContext) ? input.studioContext : {};
  const workflowId =
    textValue(context.workflowId) || input.routeInfo.workflowId || undefined;
  const runId = textValue(context.runId) || input.routeInfo.runId || undefined;
  const editorContextMatches =
    Boolean(input.editorContext) &&
    (!workflowId || input.editorContext?.workflowId === workflowId);
  const routeKind =
    textValue(context.routeKind) || input.routeInfo.routeKind || "route";

  return {
    ...context,
    actionPackageName:
      textValue(context.actionPackageName) || input.routeInfo.actionPackageName,
    routeKind,
    runId,
    selectedNodeId: editorContextMatches
      ? input.editorContext?.selectedNodeId
      : textValue(context.selectedNodeId) || undefined,
    validationErrors: editorContextMatches
      ? input.editorContext?.validationErrors
      : context.validationErrors,
    workflow: editorContextMatches
      ? input.editorContext?.workflow
      : context.workflow,
    workflowId,
  };
}

function citationsForRouteContext(
  routeContext: AssistantRouteContext,
): AssistantCitation[] {
  const citations: AssistantCitation[] = [];
  if (routeContext.workflowId) {
    citations.push({
      href: `/workflows/${encodeURIComponent(routeContext.workflowId)}`,
      kind: "workflow",
      label: "Current workflow",
    });
  }
  if (routeContext.runId) {
    citations.push({
      href: routeContext.workflowId
        ? `/workflows/${encodeURIComponent(routeContext.workflowId)}/runs/${encodeURIComponent(routeContext.runId)}`
        : `/workflows/runs/${encodeURIComponent(routeContext.runId)}`,
      kind: "run",
      label: "Current run",
    });
  }
  if (routeContext.actionPackageName) {
    citations.push({
      href: registryPath(routeContext.actionPackageName),
      kind: "action",
      label: routeContext.actionPackageName,
    });
  }
  if (routeContext.routeKind === "credentials") {
    citations.push({
      href: "/credentials",
      kind: "credential",
      label: "Credentials",
    });
  }
  if (routeContext.routeKind === "registry") {
    citations.push({
      href: "/registry",
      kind: "registry",
      label: "Registry",
    });
  }
  return citations;
}

function readMessageMeta(value: unknown): AssistantMessageMeta | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return {
    citations: readCitations(record.citations),
    degraded: record.degraded === true,
    error: textValue(record.error) || undefined,
    planId: textValue(record.planId) || undefined,
    providerMessage: textValue(record.providerMessage) || undefined,
    workflowDraft: readWorkflowDraftMeta(record.workflowDraft),
  };
}

function readWorkflowDraftMeta(
  value: unknown,
): WorkflowDraftMessageMeta | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = textValue(value.id);
  if (!id) {
    return undefined;
  }
  return {
    error: textValue(value.error) || undefined,
    id,
    patchErrors: Array.isArray(value.patchErrors)
      ? value.patchErrors.map(String).filter(Boolean)
      : undefined,
    status: workflowDraftStatus(value.status),
  };
}

function workflowDraftStatus(value: unknown): WorkflowDraftStatus {
  return value === "accepted" ||
    value === "discarded" ||
    value === "error" ||
    value === "pending"
    ? value
    : "pending";
}

function readCitations(value: unknown): AssistantCitation[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const citations = value
    .map((item): AssistantCitation | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const record = item as Record<string, unknown>;
      const href = textValue(record.href);
      const label = textValue(record.label);
      if (!href || !label) {
        return null;
      }
      return {
        description: textValue(record.description) || undefined,
        href,
        id: textValue(record.id) || undefined,
        kind: citationKind(record.kind),
        label,
      };
    })
    .filter((item): item is AssistantCitation => Boolean(item));
  return citations.length ? citations : undefined;
}

function citationKind(value: unknown): AssistantCitation["kind"] {
  return value === "action" ||
    value === "credential" ||
    value === "registry" ||
    value === "run" ||
    value === "workflow"
    ? value
    : "route";
}

function dedupeCitations(citations: AssistantCitation[]) {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = `${citation.kind}:${citation.href}:${citation.label}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function registryPath(packageName: string) {
  const [scope, ...nameParts] = packageName.split("/");
  const name = nameParts.join("/") || packageName;
  return `/registry/${pathPart(scope || "unscoped")}/${pathPart(name)}`;
}

function pathPart(value: string) {
  return encodeURIComponent(value).replace("%40", "@");
}

function decodePathPart(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function shouldDraftWorkflowChange(
  prompt: string,
  editorContext?: StudioAssistantEditorContext | null,
) {
  if (!editorContext?.requestWorkflowDraft) {
    return false;
  }
  const graphTarget =
    /\b(step|étape|etape|node|nœud|noeud|trigger|déclencheur|declencheur|edge|connexion|condition|binding|liaison|input|entrée|entree|runtime|placement|timeout|version|action|métadonnée|metadonnee|nom|description|graphe|graph|layout|canvas)\b/i.test(
      prompt,
    );
  const otherStudioResource =
    /\b(transfer|transfert|credential|identifiant|schedule|planification|token|mcp|worker|orchestrateur|orchestrator|execution location|run)\b/i.test(
      prompt,
    );
  const wholeWorkflowOperation =
    /\b(clone|cloner|export|exporte|import|importe|delete|remove|supprime|cr[eé]e?r?|create)\b[\s\S]*\bworkflow\b/i.test(
      prompt,
    ) && !graphTarget;
  const executionOperation =
    /\b(run|execute|exécute|lance|cancel|annule|retry|relance|surveille|monitor)\b/i.test(
      prompt,
    );
  if (
    wholeWorkflowOperation ||
    (otherStudioResource && !graphTarget) ||
    (executionOperation && !graphTarget)
  ) {
    return false;
  }
  return (
    /\b(ajout(?:e|er|es)?|rajout(?:e|er|es)?|add|append|insert|place|pose|cr[eé]e?r?|g[eé]n[eé]re|connect(?:e|er)?|d[eé]connect(?:e|er)?|disconnect|branche|configure|modifie|mets|renomme|rename|update|supprime|retire|remove|delete|active|d[eé]sactive|enable|disable|duplique|duplicate|remplace|replace|corrige|fix|aligne|r[eé]organise)\b/i.test(
      prompt,
    ) &&
    (graphTarget || !otherStudioResource)
  );
}

function currentWorkflowLabel(routeContext: AssistantRouteContext) {
  const workflow = isRecord(routeContext.workflow) ? routeContext.workflow : {};
  const template = isRecord(workflow.template) ? workflow.template : {};
  return (
    textValue(template.name) ||
    textValue(workflow.name) ||
    routeContext.workflowId ||
    "Current workflow"
  );
}

function BeamLogo({ className }: { className: string }) {
  return (
    <span className={cn("grid shrink-0 place-items-center", className)}>
      <img
        alt=""
        className="hidden size-full dark:block"
        src="/beam-logo-white.svg"
      />
      <img
        alt=""
        className="size-full dark:hidden"
        src="/beam-logo-black.svg"
      />
    </span>
  );
}

function workflowDraftMessage(
  result: StudioAssistantWorkflowDraftResult,
  routeContext: AssistantRouteContext,
  prompt: string,
) {
  const language = assistantLanguage(prompt);
  if (!result.applied && result.patchErrors.length) {
    return [
      result.message ||
        (language === "en"
          ? "I could not apply this change."
          : "Je n'ai pas pu appliquer cette modification."),
      ...result.patchErrors.map((error) => `- ${error}`),
    ].join("\n");
  }

  const workflowLink = currentWorkflowLink(routeContext, language);
  const plan = result.plan.slice(0, 4).map((item) => `- ${item}`);
  const needsInput = result.needsInput.slice(0, 4).map((item) => `- ${item}`);
  const intro =
    result.message ||
    (language === "en"
      ? `Change applied in ${workflowLink}.`
      : `Modification appliquée dans ${workflowLink}.`);
  return [
    intro,
    result.message
      ? language === "en"
        ? `Change applied in ${workflowLink}.`
        : `Modification appliquée dans ${workflowLink}.`
      : "",
    plan.length ? ["", ...plan].join("\n") : "",
    needsInput.length
      ? [
          "",
          language === "en"
            ? "**To complete later**"
            : "**À compléter ensuite**",
          ...needsInput,
        ].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function currentWorkflowLink(
  routeContext: AssistantRouteContext,
  language: AssistantLanguage,
) {
  const workflow = isRecord(routeContext.workflow) ? routeContext.workflow : {};
  const template = isRecord(workflow.template) ? workflow.template : {};
  const label =
    textValue(template.name) ||
    (routeContext.workflowId
      ? language === "en"
        ? "this workflow"
        : "ce workflow"
      : language === "en"
        ? "the workflow"
        : "le workflow");
  const href =
    textValue(template.href) ||
    (routeContext.workflowId
      ? `/workflows/${encodeURIComponent(routeContext.workflowId)}/editor`
      : "");
  return href ? `[${label}](${href})` : label;
}

function ConversationHistoryView({
  activeConversationId,
  conversations,
  error,
  loading,
  onDelete,
  onSelect,
}: {
  activeConversationId: string | null;
  conversations: ConversationSummary[];
  error: unknown;
  loading: boolean;
  onDelete(id: string): void;
  onSelect(id: string): void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {loading ? (
        <div className="grid gap-1.5">
          {[0, 1, 2].map((row) => (
            <div className="h-14 animate-pulse rounded-control bg-muted" key={row} />
          ))}
        </div>
      ) : error ? (
        <div className="flex gap-2 rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 break-words">
            Could not load your conversations.
          </span>
        </div>
      ) : conversations.length ? (
        <div className="grid gap-1">
          {conversations.map((conversation) => (
            <div
              className={cn(
                "group/conversation flex items-center gap-1 rounded-control transition-colors hover:bg-accent",
                conversation.id === activeConversationId && "bg-accent",
              )}
              key={conversation.id}
            >
              <button
                className="min-w-0 flex-1 rounded-control px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onSelect(conversation.id)}
                type="button"
              >
                <span className="block truncate text-sm">
                  {conversation.title}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {conversationTimestamp(conversation.updatedAt)} ·{" "}
                  {conversation.messageCount} messages
                </span>
              </button>
              <Button
                aria-label={`Delete ${conversation.title}`}
                className="mr-1 size-7 shrink-0 text-muted-foreground opacity-0 hover:text-destructive group-hover/conversation:opacity-100 focus-visible:opacity-100"
                onClick={() => onDelete(conversation.id)}
                size="icon"
                title="Delete conversation"
                type="button"
                variant="ghost"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          className="px-4 py-10"
          description="Conversations you have with the assistant will show up here."
          icon={History}
          title="No past conversations"
        />
      )}
    </div>
  );
}

function AssistantOverflowMenu({
  canExport,
  onDeleteConversation,
  onExport,
}: {
  canExport: boolean;
  onDeleteConversation?: () => void;
  onExport(): void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const close = () => {
    setOpen(false);
    setConfirmingDelete(false);
  };

  return (
    <div className="relative">
      <Button
        aria-expanded={open}
        aria-label="More assistant actions"
        onClick={() => (open ? close() : setOpen(true))}
        size="icon"
        title="More actions"
        type="button"
        variant="ghost"
      >
        <MoreHorizontal className="h-4 w-4" />
      </Button>
      {open ? (
        <>
          <button
            aria-label="Close menu"
            className="fixed inset-0 z-20 cursor-default"
            onClick={close}
            type="button"
          />
          <div className="absolute right-0 top-[calc(100%+0.5rem)] z-30 w-56 overflow-hidden rounded-surface border bg-popover p-1.5 text-popover-foreground shadow-lg">
            <button
              className="flex w-full items-center gap-2 rounded-control px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
              disabled={!canExport}
              onClick={() => {
                onExport();
                close();
              }}
              type="button"
            >
              <Download className="size-4 text-muted-foreground" />
              Export as Markdown
            </button>
            {onDeleteConversation ? (
              confirmingDelete ? (
                <button
                  className="flex w-full items-center gap-2 rounded-control bg-destructive/10 px-2.5 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/15"
                  onClick={() => {
                    onDeleteConversation();
                    close();
                  }}
                  type="button"
                >
                  <Trash2 className="size-4" />
                  Delete permanently?
                </button>
              ) : (
                <button
                  className="flex w-full items-center gap-2 rounded-control px-2.5 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/10"
                  onClick={() => setConfirmingDelete(true)}
                  type="button"
                >
                  <Trash2 className="size-4" />
                  Delete conversation
                </button>
              )
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function conversationTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown date";
  }
  return date.toLocaleString(undefined, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  });
}
