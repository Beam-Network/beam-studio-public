import { useScrollActiveOption } from "@/features/assistant/use-scroll-active-option";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  Navigate,
  createFileRoute,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import type {
  AssistantRequestSummary,
  AssistantInputRequest,
  AssistantModelOption,
  AssistantOperationPlan,
  AssistantProviderOption,
  AssistantProviderSettings,
  AssistantProviderSummary,
  AssistantReasoningEffort,
} from "@beam-studio/shared";
import {
  assistantEntityHref,
  isAssistantRequestActive,
} from "@beam-studio/shared";
import {
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  Archive,
  MoreHorizontal,
  Search,
  Square,
  Check,
  Eye,
  ExternalLink,
  GitBranch,
  History,
  Loader2,
  MessageSquare,
  Play,
  RotateCcw,
  SquarePen,
  X,
} from "lucide-react";
import { AppShell, PageControls } from "@/components/app-shell";
import { AssistantEffortSelector } from "@/components/assistant-effort-selector";
import { AssistantModelSelector } from "@/components/assistant-model-selector";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToastProvider, useToast } from "@/components/ui/toast";
import {
  conversationHref,
  conversationIdFromPath,
  useLastConversation,
} from "@/features/assistant/conversation-navigation";
import {
  draftStorageKey,
  groupConversations,
  isNearLatest,
  LOW_CREDIT_THRESHOLD,
  useStoredDraft,
  pendingRequestId,
} from "@/features/assistant/chat-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { MarkdownContent } from "@/features/registry/markdown";
import { ApiError } from "@/lib/api-errors";
import { apiGet, apiSend } from "@/lib/api-client";
import { formatCredits, toHundredths } from "@/lib/format-credits";
import { INSTANCE_UNCLAIMED } from "@/lib/api-errors";
import { cn } from "@/lib/utils";

type ChatMessage = {
  content: string;
  id: string;
  plan?: AssistantOperationPlan;
  planId?: string;
  role: "assistant" | "user";
};

type ChatResponse = {
  conversationId: string;
  request: AssistantRequestSummary;
};

type OrganizationOption = {
  credits?: number | null;
  id: string;
};

type OrganizationsPayload = {
  consoleUrl: string;
  organizations?: OrganizationOption[];
  selectedOrganizationId?: string | null;
};

type ConversationSummary = {
  request: AssistantRequestSummary | null;
  unread: boolean;
  archivedAt?: string | null;
  createdAt: string;
  id: string;
  messageCount: number;
  route: string | null;
  title: string;
  updatedAt: string;
};

type ConversationsPayload = {
  conversations: ConversationSummary[];
};

type ProvidersPayload = {
  catalog: AssistantProviderOption[];
  providers: AssistantProviderSummary[];
  settings: AssistantProviderSettings | null;
};

type ConversationPayload = {
  conversation: ConversationSummary & {
    messages: Array<{
      content: string;
      id: string;
      meta: Record<string, unknown>;
      role: "assistant" | "user";
    }>;
  };
};

type MentionCandidate = {
  id: string;
  name: string;
  type: string;
  typeLabel: string;
};

type ActiveMention = {
  end: number;
  query: string;
  start: number;
};

type DraftMention = {
  candidate: MentionCandidate;
  end: number;
  start: number;
};

const suggestions = [
  {
    label: "Create a workflow",
    prompt: "Create a workflow that transfers files every morning",
    icon: GitBranch,
  },
  {
    label: "Investigate failed runs",
    prompt: "Show me the failed runs and explain what happened",
    icon: AlertTriangle,
  },
  {
    label: "Compose workflows",
    prompt: "Create a workflow composing my existing workflows sequentially",
    icon: SquarePen,
  },
  {
    label: "Explore my workspace",
    prompt: "How is this Studio configured?",
    icon: MessageSquare,
  },
];

export const Route: any = createFileRoute("/new")({
  component: () => <Navigate to="/" />,
});

export function HomePage() {
  const session = useQuery({
    queryKey: ["/studio/session"],
    queryFn: () =>
      apiGet<{ session?: { userId: string } | null }>("/studio/session"),
  });
  const organizations = useQuery({
    queryKey: ["/studio/organizations"],
    queryFn: () => apiGet<OrganizationsPayload>("/studio/organizations"),
  });
  // The chat restarts when the user or organization changes. Mounting it only
  // once both are known keeps the first answer from restarting it.
  if (session.isPending || organizations.isPending) {
    return null;
  }
  const organizationId =
    organizations.data?.selectedOrganizationId ??
    organizations.data?.organizations?.[0]?.id;
  return (
    <ToastProvider
      key={JSON.stringify([session.data?.session?.userId, organizationId])}
    >
      <HomeChat />
    </ToastProvider>
  );
}

function HomeChat() {
  const navigate = useNavigate();
  const location = useLocation();
  const routeConversationId = conversationIdFromPath(location.pathname);
  const routeIdRef = useRef(routeConversationId);
  routeIdRef.current = routeConversationId;
  const { notify, dismiss } = useToast();
  const retryChat = useRef<() => void>(() => {});
  const [historyOpen, setHistoryOpen] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const followingLatest = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const [archived, setArchived] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(
      () => setDebouncedSearch(historySearch.trim()),
      200,
    );
    return () => clearTimeout(timer);
  }, [historySearch]);
  const sessionQuery = useQuery({
    queryKey: ["/studio/session"],
    queryFn: () =>
      apiGet<{ session?: { userId: string } | null }>("/studio/session"),
  });
  const [quotaFailure, setQuotaFailure] = useState<{
    message: string;
    organizationId: string | null;
  } | null>(null);
  const queryClient = useQueryClient();
  const organizationsQuery = useQuery({
    queryKey: ["/studio/organizations"],
    queryFn: () => apiGet<OrganizationsPayload>("/studio/organizations"),
    refetchInterval: 30_000,
  });
  const organizations = organizationsQuery.data?.organizations ?? [];
  const activeOrganizationId =
    organizationsQuery.data?.selectedOrganizationId ??
    organizations[0]?.id ??
    null;
  const activeOrganization =
    organizations.find(
      (organization) => organization.id === activeOrganizationId,
    ) ?? organizations[0];
  const userId = sessionQuery.data?.session?.userId;
  const [, setLastConversation] = useLastConversation(
    userId,
    activeOrganizationId,
  );
  const draftKey =
    userId && activeOrganizationId
      ? draftStorageKey(userId, activeOrganizationId, routeConversationId)
      : null;
  const [draft, setDraft] = useStoredDraft(draftKey, "");
  const [pendingRequest, setPendingRequest] = useStoredDraft(
    draftKey ? `${draftKey}:request` : null,
    "",
  );
  const reportedCreditsExhausted =
    typeof activeOrganization?.credits === "number" &&
    toHundredths(activeOrganization.credits) <= 0;
  const quotaDetectedForActiveOrganization = Boolean(
    quotaFailure && quotaFailure.organizationId === activeOrganizationId,
  );
  const beamAiUnavailable =
    reportedCreditsExhausted || quotaDetectedForActiveOrganization;
  const providersQuery = useQuery({
    queryKey: ["/studio/ai/providers"],
    queryFn: () => apiGet<ProvidersPayload>("/studio/ai/providers"),
  });
  const provider = providersQuery.data?.providers[0] ?? null;
  const hasStoredAssistantSettings = Boolean(providersQuery.data?.settings);
  const defaultModel = provider?.model || provider?.models?.fallback || "";
  const [selectedModel, setSelectedModel] = useState("");
  const [reasoningEffort, setReasoningEffort] =
    useState<AssistantReasoningEffort>("medium");
  const activeModel = selectedModel || defaultModel;
  const modelsQuery = useQuery({
    queryKey: ["/studio/ai/models", provider?.id, hasStoredAssistantSettings],
    queryFn: () =>
      hasStoredAssistantSettings
        ? apiGet<{ models: AssistantModelOption[] }>("/studio/ai/models")
        : apiSend<{ models: AssistantModelOption[] }>(
            "POST",
            "/studio/ai/models/discover",
            {},
          ),
    enabled: providersQuery.isSuccess,
    retry: false,
    staleTime: Infinity,
  });
  const modelSettingsMutation = useMutation({
    mutationFn: (model: string) =>
      apiSend("PATCH", "/studio/ai/settings", {
        model,
        models: modelsQuery.data?.models,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["/studio/ai/providers"] }),
    onError: () =>
      notify({
        id: "model",
        message: "Could not save the selected model. Please try again.",
        variant: "error",
      }),
  });
  const conversationsQuery = useQuery({
    queryKey: ["/studio/assistant/conversations", activeOrganizationId, userId],
    queryFn: () =>
      apiGet<ConversationsPayload>("/studio/assistant/conversations"),
    refetchInterval: 2_000,
    enabled: organizationsQuery.isSuccess && Boolean(activeOrganizationId),
  });
  const archivedQuery = useQuery({
    queryKey: [
      "/studio/assistant/conversations",
      activeOrganizationId,
      userId,
      "archived",
    ],
    queryFn: () =>
      apiGet<ConversationsPayload>(
        "/studio/assistant/conversations?archived=true",
      ),
    enabled: organizationsQuery.isSuccess && Boolean(activeOrganizationId),
    refetchInterval: 2_000,
  });
  const searchQuery = useQuery({
    queryKey: [
      "/studio/assistant/conversations",
      activeOrganizationId,
      userId,
      "search",
      archived,
      debouncedSearch,
    ],
    queryFn: () =>
      apiGet<ConversationsPayload>(
        `/studio/assistant/conversations?archived=${archived}&search=${encodeURIComponent(debouncedSearch)}`,
      ),
    enabled: Boolean(activeOrganizationId && debouncedSearch),
    refetchInterval: 2_000,
  });
  const contextQuery = useQuery({
    queryKey: ["/studio/assistant/context", "/"],
    queryFn: () =>
      apiGet<Record<string, unknown>>(
        `/studio/assistant/context?route=${encodeURIComponent("/")}`,
      ),
  });
  const conversationKey = [
    "/studio/assistant/conversation",
    activeOrganizationId,
    userId,
    routeConversationId,
  ];
  const conversationQuery = useQuery({
    queryKey: conversationKey,
    queryFn: () =>
      apiGet<ConversationPayload>(
        `/studio/assistant/conversations/${encodeURIComponent(routeConversationId!)}`,
      ),
    enabled: Boolean(routeConversationId && userId && activeOrganizationId),
    refetchInterval: 1_500,
    retry: false,
  });
  const conversation = conversationQuery.data?.conversation;
  const request = conversation?.request;
  const requestActive = isAssistantRequestActive(request);
  const messages = useMemo<ChatMessage[]>(
    () =>
      (conversation?.messages ?? []).map(({ content, id, meta, role }) => ({
        content,
        id,
        role,
        plan: meta?.plan as AssistantOperationPlan | undefined,
        planId: typeof meta?.planId === "string" ? meta.planId : undefined,
      })),
    [conversation?.messages],
  );
  const openingConversation =
    Boolean(routeConversationId) && conversationQuery.isPending;
  const conversationMismatch = Boolean(routeConversationId) && !conversation;

  function refreshConversations() {
    void queryClient.invalidateQueries({
      queryKey: ["/studio/assistant/conversations"],
    });
    void queryClient.invalidateQueries({
      queryKey: ["/studio/assistant/conversation"],
    });
  }
  const chatMutation = useMutation({
    onMutate: () => ({
      sourceId: routeConversationId,
      clearDraft: setDraft,
      clearPending: setPendingRequest,
    }),
    mutationFn: (submission: {
      prompt: string;
      requestKey: string;
      conversationId: string | null;
      context: Record<string, unknown>;
      model?: string;
      reasoningEffort: AssistantReasoningEffort;
      organizationId: string;
    }) =>
      apiSend<ChatResponse>(
        "POST",
        "/studio/assistant/requests",
        {
          conversationId: submission.conversationId,
          prompt: submission.prompt,
          context: submission.context,
          idempotencyKey: submission.requestKey,
          model: submission.model,
          reasoningEffort: submission.reasoningEffort,
          route: "/",
        },
        { headers: { "X-Organization-Id": submission.organizationId } },
      ),
    onSuccess: (response, _, context) => {
      context?.clearDraft("");
      context?.clearPending("");
      refreshConversations();
      if (!mounted.current || routeIdRef.current !== context?.sourceId) return;
      setLastConversation(response.conversationId);
      if (routeIdRef.current !== response.conversationId) {
        void navigate({
          to: conversationHref(response.conversationId) as never,
          replace: true,
        });
      }
    },
    onError: (error, _, context) => {
      if (mounted.current && routeIdRef.current === context?.sourceId)
        notify({
          id: "chat",
          message: error.message,
          variant: "error",
          action: { label: "Try again", onClick: () => retryChat.current() },
        });
    },
  });
  const requestAction = useMutation({
    onMutate: () => dismiss("chat"),
    mutationFn: ({ id, action }: { id: string; action: "cancel" | "retry" }) =>
      apiSend(
        "POST",
        `/studio/assistant/requests/${encodeURIComponent(id)}/${action}`,
        {},
      ),
    onSuccess: refreshConversations,
    onError: () =>
      notify({
        id: "request-action",
        message: "Could not update this response. Please try again.",
        variant: "error",
      }),
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    followingLatest.current = true;
    setShowLatest(false);
    dismiss();
    if (!routeConversationId) setLastConversation("");
  }, [routeConversationId]);
  useEffect(() => {
    if (conversation) setLastConversation(conversation.id);
  }, [conversation?.id]);
  useEffect(() => {
    if (!conversationQuery.error) return;
    notify({
      id: "conversation",
      message: "Could not open this conversation. Please try again.",
      variant: "error",
      action: {
        label: "Try again",
        onClick: () => {
          void conversationQuery.refetch();
        },
      },
    });
  }, [conversationQuery.error, notify]);
  useEffect(() => {
    if (
      !request ||
      (request.status !== "failed" && request.status !== "cancelled")
    )
      return;
    if (request.errorCode === "quota") {
      setQuotaFailure({
        message: request.error || "Your organization has no credits left.",
        organizationId: activeOrganizationId,
      });
      void organizationsQuery.refetch();
    }
    notify({
      id: "chat",
      message:
        request.status === "cancelled"
          ? "Response stopped."
          : request.error || "The assistant could not respond.",
      variant: request.status === "cancelled" ? "info" : "error",
      action: {
        label: "Try again",
        onClick: () =>
          requestAction.mutate({ id: request.id, action: "retry" }),
      },
    });
  }, [request?.id, request?.status, request?.completedAt]);
  useEffect(() => {
    if (
      typeof activeOrganization?.credits === "number" &&
      toHundredths(activeOrganization.credits) > 0
    )
      setQuotaFailure(null);
  }, [activeOrganization?.credits]);
  useEffect(() => {
    const container = messagesRef.current;
    if (container && messages.length && followingLatest.current)
      container.scrollTop = container.scrollHeight;
    else if (container && messages.length)
      setShowLatest(!isNearLatest(container));
  }, [messages, requestActive]);
  useEffect(() => {
    if (!conversation?.unread || request?.status !== "succeeded") return;
    let marking = false;
    let active = true;
    const markRead = async () => {
      if (
        marking ||
        document.visibilityState !== "visible" ||
        !followingLatest.current
      )
        return;
      marking = true;
      try {
        await apiSend(
          "POST",
          `/studio/assistant/conversations/${encodeURIComponent(conversation.id)}/read`,
          { requestId: request.id },
        );
        if (!active) return;
        queryClient.setQueryData<ConversationPayload>(
          conversationKey,
          (current) =>
            current?.conversation.request?.id === request.id
              ? { conversation: { ...current.conversation, unread: false } }
              : current,
        );
        void queryClient.invalidateQueries({
          queryKey: ["/studio/assistant/conversations"],
        });
      } catch {
        marking = false;
      }
    };
    void markRead();
    document.addEventListener("visibilitychange", markRead);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", markRead);
    };
  }, [
    conversation?.id,
    conversation?.unread,
    request?.id,
    request?.status,
    showLatest,
  ]);
  const showCreditsExhaustedPage =
    beamAiUnavailable &&
    organizationsQuery.isSuccess &&
    conversationsQuery.isSuccess &&
    conversationsQuery.data.conversations.length === 0 &&
    archivedQuery.isSuccess &&
    archivedQuery.data.conversations.length === 0 &&
    !routeConversationId;
  const consoleUrl =
    organizationsQuery.data?.consoleUrl ?? "https://console.b1m.ai";

  function startNewConversation() {
    dismiss();
    setLastConversation("");
    void navigate({ to: "/" });
    followingLatest.current = true;
    setShowLatest(false);
    setHistoryOpen(false);
    chatMutation.reset();
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function submit(content: string) {
    const value = content.trim();
    if (
      !value ||
      !draftKey ||
      beamAiUnavailable ||
      chatMutation.isPending ||
      requestActive ||
      conversationMismatch ||
      requestAction.isPending ||
      modelSettingsMutation.isPending
    )
      return;
    followingLatest.current = true;
    setShowLatest(false);
    dismiss("chat");
    const key = pendingRequestId(pendingRequest, value) ?? messageId("user");
    // Persist the submission identity before sending; retries after a lost HTTP
    // acknowledgement resolve to the same server request and conversation.
    setDraft(value);
    setPendingRequest(JSON.stringify({ id: key, content: value }));
    chatMutation.mutate({
      prompt: value,
      requestKey: key,
      conversationId: routeConversationId,
      context: contextQuery.data ?? {},
      model: activeModel || undefined,
      reasoningEffort,
      organizationId: activeOrganizationId!,
    });
  }

  function selectModel(model: string) {
    dismiss("model");
    setSelectedModel(model);
    modelSettingsMutation.mutate(model);
  }
  retryChat.current = () =>
    submit(draft.trim() || chatMutation.variables?.prompt || "");

  const conversationEdit = useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      title?: string;
      archived?: boolean;
    }) =>
      apiSend(
        "PATCH",
        `/studio/assistant/conversations/${encodeURIComponent(id)}`,
        body,
      ),
    onSuccess: (_, change) => {
      void queryClient.invalidateQueries({
        queryKey: ["/studio/assistant/conversations"],
      });
      if (change.archived && change.id === routeConversationId)
        startNewConversation();
    },
  });
  const visibleHistory = debouncedSearch
    ? searchQuery
    : archived
      ? archivedQuery
      : conversationsQuery;
  useEffect(() => {
    if (!visibleHistory.error) return;
    // The app shell opens the claim step for this one; a toast would only
    // repeat a request failure the customer cannot act on here.
    if (
      visibleHistory.error instanceof ApiError &&
      visibleHistory.error.code === INSTANCE_UNCLAIMED
    )
      return;
    notify({
      id: "history",
      message: "Could not load conversations. Please try again.",
      variant: "error",
      action: {
        label: "Try again",
        onClick: () => {
          void visibleHistory.refetch();
        },
      },
    });
  }, [
    visibleHistory.error,
    visibleHistory.errorUpdatedAt,
    visibleHistory.refetch,
    notify,
  ]);

  const historyProps = {
    activeConversationId: routeConversationId,
    conversations: visibleHistory.data?.conversations ?? [],
    archived,
    query: historySearch,
    onQueryChange: setHistorySearch,
    onEdit: (change: { id: string; title?: string; archived?: boolean }) =>
      conversationEdit.mutateAsync(change),
    error: visibleHistory.error,
    loading:
      visibleHistory.isPending || historySearch.trim() !== debouncedSearch,
    loadingConversationId: openingConversation ? routeConversationId : null,
    disabled: chatMutation.isPending || conversationEdit.isPending,
    onRetry: () => {
      void visibleHistory.refetch();
    },
    onSelect: () => setHistoryOpen(false),
  };

  if (showCreditsExhaustedPage) {
    return (
      <AppShell
        contentClassName="flex h-full max-w-none flex-col px-0 py-0"
        showHeader={false}
        title="Assistant"
      >
        <PageControls />
        <CreditsExhaustedPage
          checking={organizationsQuery.isFetching}
          consoleUrl={consoleUrl}
          onCheckAgain={() => {
            setQuotaFailure(null);
            void organizationsQuery.refetch();
          }}
        />
      </AppShell>
    );
  }

  return (
    <AppShell
      contentClassName="flex h-full max-w-none px-0 py-0"
      showHeader={false}
      title="Assistant"
    >
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col",
          !messages.length && "overflow-y-auto",
        )}
      >
        <PageControls>
          <div className="flex items-center gap-1 lg:hidden">
            <ConversationFilter archived={archived} onChange={setArchived} />
            <Button
              aria-label="Start a new conversation"
              disabled={historyProps.disabled}
              onClick={startNewConversation}
              size="sm"
              variant="ghost"
            >
              <SquarePen aria-hidden="true" className="size-4" />
              <span className="hidden sm:inline">New chat</span>
            </Button>
            <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
              <DialogTrigger asChild>
                <Button
                  aria-label="Conversation history"
                  size="sm"
                  variant="ghost"
                >
                  <History aria-hidden="true" className="size-4" />
                  <span className="hidden sm:inline">Conversations</span>
                </Button>
              </DialogTrigger>
              <DialogContent className="flex max-h-[80dvh] flex-col rounded-surface">
                <div className="flex items-center justify-between gap-2 pr-6">
                  <DialogTitle>
                    {archived ? "Archived conversations" : "Conversations"}
                  </DialogTitle>
                  <div className="flex items-center gap-1">
                    <ConversationFilter
                      archived={archived}
                      onChange={setArchived}
                    />
                    <Button
                      aria-label="Start a new conversation"
                      disabled={historyProps.disabled}
                      size="icon"
                      className="size-8"
                      variant="ghost"
                      onClick={startNewConversation}
                    >
                      <SquarePen aria-hidden="true" className="size-4" />
                    </Button>
                  </div>
                </div>
                <DialogDescription>
                  Pick up where you left off.
                </DialogDescription>
                <ConversationHistory {...historyProps} />
              </DialogContent>
            </Dialog>
          </div>
        </PageControls>
        <div
          className={cn(
            "mx-auto flex min-h-0 w-full max-w-3xl flex-col px-5 sm:px-8",
            messages.length ? "h-full" : "my-auto shrink-0 py-10 sm:py-16",
          )}
        >
          <div
            ref={messagesRef}
            onScroll={(event) => {
              followingLatest.current = isNearLatest(event.currentTarget);
              setShowLatest(!followingLatest.current);
            }}
            className={cn(
              messages.length ? "min-h-0 flex-1 overflow-y-auto" : "pb-6",
            )}
          >
            {openingConversation ? (
              <div
                className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"
                role="status"
              >
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Opening conversation…
              </div>
            ) : conversationMismatch ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                Conversation unavailable
              </div>
            ) : messages.length ? (
              <div className="grid gap-6 py-8">
                {messages.map((message) => (
                  <ChatMessageBubble
                    key={message.id}
                    message={message}
                    onModifyPlan={(plan) => {
                      setDraft(
                        `Modify plan ${plan.id} (${plan.operations
                          .map((operation) => operation.tool)
                          .join(", ")}): `,
                      );
                    }}
                  />
                ))}
                {requestActive ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    {request?.status === "queued"
                      ? "Waiting to start…"
                      : "Working…"}
                  </div>
                ) : null}
              </div>
            ) : (
              <div>
                <div className="mb-5 flex items-center gap-2.5 text-sm font-medium">
                  <span aria-hidden="true">
                    <BeamLogo className="size-5" />
                  </span>
                  BEAM AI
                </div>
                <h1 className="font-sans text-3xl font-semibold normal-case leading-tight tracking-tight">
                  What would you like to work on?
                </h1>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  Build workflows, investigate runs, or ask about your
                  workspace.
                </p>
              </div>
            )}
          </div>

          {showLatest && messages.length ? (
            <div className="flex justify-center py-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  followingLatest.current = true;
                  if (messagesRef.current)
                    messagesRef.current.scrollTop =
                      messagesRef.current.scrollHeight;
                  setShowLatest(false);
                }}
              >
                <ArrowDown aria-hidden="true" className="size-3.5" />
                Latest message
              </Button>
            </div>
          ) : null}

          {beamAiUnavailable ||
          (typeof activeOrganization?.credits === "number" &&
            toHundredths(activeOrganization.credits) > 0 &&
            toHundredths(activeOrganization.credits) <=
              toHundredths(LOW_CREDIT_THRESHOLD)) ? (
            <div className="flex flex-wrap items-center justify-between gap-2 px-1 py-2 text-xs text-muted-foreground">
              <span>
                {formatCredits(
                  beamAiUnavailable ? 0 : (activeOrganization?.credits ?? 0),
                )}{" "}
                remaining
              </span>
              <div className="flex items-center gap-2">
                {beamAiUnavailable ? (
                  <Button
                    aria-label="Refresh credit balance"
                    className="size-7"
                    size="icon"
                    variant="ghost"
                    disabled={organizationsQuery.isFetching}
                    onClick={() => {
                      setQuotaFailure(null);
                      void organizationsQuery.refetch();
                    }}
                  >
                    <RotateCcw
                      aria-hidden="true"
                      className={cn(
                        "size-3.5",
                        organizationsQuery.isFetching &&
                          "motion-safe:animate-spin",
                      )}
                    />
                  </Button>
                ) : null}
                <a
                  className="inline-flex items-center gap-1 rounded-control underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  href={consoleUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Add credits
                  <ExternalLink aria-hidden="true" className="size-3" />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </div>
            </div>
          ) : null}

          {request &&
          (request.status === "failed" || request.status === "cancelled") ? (
            <div className="flex justify-start py-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={requestAction.isPending}
                onClick={() =>
                  requestAction.mutate({ id: request.id, action: "retry" })
                }
              >
                <RotateCcw className="size-3.5" /> Retry response
              </Button>
            </div>
          ) : null}
          <AssistantComposer
            key={draftKey ?? "loading"}
            draftKey={draftKey}
            onStop={
              requestActive && request && !requestAction.isPending
                ? () =>
                    requestAction.mutate({ id: request.id, action: "cancel" })
                : undefined
            }
            busy={
              requestActive ||
              chatMutation.isPending ||
              modelSettingsMutation.isPending
            }
            inputRef={composerRef}
            context={contextQuery.data ?? {}}
            disabled={
              !draftKey ||
              conversationMismatch ||
              beamAiUnavailable ||
              chatMutation.isPending ||
              requestActive ||
              requestAction.isPending ||
              modelSettingsMutation.isPending
            }
            draft={chatMutation.isPending ? "" : draft}
            effort={reasoningEffort}
            model={activeModel}
            modelEmptyLabel={
              providersQuery.isPending || modelsQuery.isPending
                ? "Loading models…"
                : modelsQuery.isError
                  ? "Could not load models"
                  : "No compatible models"
            }
            models={modelsQuery.data?.models ?? []}
            onDraftChange={setDraft}
            onEffortChange={setReasoningEffort}
            onModelChange={selectModel}
            onSubmit={submit}
            providerId={provider?.provider}
            selectionDisabled={
              chatMutation.isPending ||
              requestActive ||
              requestAction.isPending ||
              modelSettingsMutation.isPending
            }
          />
          {!routeConversationId && !messages.length ? (
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {suggestions.map(({ label, prompt, icon: Icon }) => (
                <button
                  className="flex items-center gap-2.5 rounded-control px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                  disabled={beamAiUnavailable || historyProps.disabled}
                  key={label}
                  onClick={() => {
                    setDraft(prompt);
                    composerRef.current?.focus();
                  }}
                  type="button"
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  {label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <aside
        aria-label="Conversation history"
        className="hidden h-full min-h-0 w-64 shrink-0 flex-col border-l bg-card/40 lg:flex xl:w-72"
      >
        <div className="flex items-center justify-between gap-2 px-5 pb-3 pt-5">
          <h2 className="text-sm font-medium">
            {archived ? "Archived" : "Conversations"}
          </h2>
          <div className="flex items-center gap-1">
            <ConversationFilter archived={archived} onChange={setArchived} />
            <Button
              aria-label="Start a new conversation"
              title="New chat"
              disabled={historyProps.disabled}
              onClick={startNewConversation}
              size="icon"
              className="size-8"
              variant="ghost"
            >
              <SquarePen aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col px-2 pb-3">
          <ConversationHistory {...historyProps} />
        </div>
      </aside>
    </AppShell>
  );
}

function ConversationFilter({
  archived,
  onChange,
}: {
  archived: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Conversation view options"
          title="Conversation view options"
          className="size-8"
          size="icon"
          variant="ghost"
        >
          <MoreHorizontal aria-hidden="true" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={archived ? "archived" : "active"}
          onValueChange={(value) => onChange(value === "archived")}
        >
          <DropdownMenuRadioItem value="active">
            <MessageSquare aria-hidden="true" className="size-3.5" />
            Active conversations
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="archived">
            <Archive aria-hidden="true" className="size-3.5" />
            Archived conversations
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CreditsExhaustedPage({
  checking,
  consoleUrl,
  onCheckAgain,
}: {
  checking: boolean;
  consoleUrl: string;
  onCheckAgain(): void;
}) {
  return (
    <div className="flex min-h-0 w-full flex-1 overflow-y-auto px-6 py-12 sm:px-8">
      <section
        aria-labelledby="credits-exhausted-title"
        className="m-auto w-full max-w-md"
      >
        <div className="flex items-center gap-2.5 text-sm font-medium">
          <span aria-hidden="true">
            <BeamLogo className="size-5" />
          </span>
          <span>BEAM AI</span>
        </div>
        <h1
          className="mt-6 text-3xl font-semibold leading-tight tracking-tight"
          id="credits-exhausted-title"
        >
          No credits remaining
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Add credits to your organization in Beam Console to start a
          conversation with the assistant.
        </p>
        <Button asChild className="mt-7 w-full sm:w-auto" variant="brand">
          <a href={consoleUrl} rel="noreferrer" target="_blank">
            Add credits in Beam Console
            <ExternalLink aria-hidden="true" className="size-4" />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </Button>
        <div className="mt-4 flex flex-wrap items-center gap-x-1 gap-y-1 text-sm">
          <span className="text-muted-foreground">Already added credits?</span>
          <Button
            aria-live="polite"
            className="text-muted-foreground"
            disabled={checking}
            onClick={onCheckAgain}
            size="sm"
            type="button"
            variant="ghost"
          >
            <RotateCcw
              aria-hidden="true"
              className={cn("size-3.5", checking && "motion-safe:animate-spin")}
            />
            {checking ? "Checking…" : "Refresh balance"}
          </Button>
        </div>
        <p className="mt-8 border-t pt-5 text-sm leading-6 text-muted-foreground">
          You can still edit workflows and manage your workspace in Studio.
        </p>
      </section>
    </div>
  );
}

export function AssistantComposer({
  context,
  disabled,
  busy = disabled,
  inputRef,
  draftKey,
  onStop,
  draft,
  effort = "medium",
  model,
  modelEmptyLabel = "No compatible models",
  models = [],
  onDraftChange,
  onEffortChange,
  onFocus,
  onModelChange,
  onSubmit,
  providerId,
  selectionDisabled = disabled,
  variant = "home",
}: {
  busy?: boolean;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  draftKey?: string | null;
  onStop?(): void;
  context: Record<string, unknown>;
  disabled: boolean;
  draft: string;
  effort?: AssistantReasoningEffort;
  model?: string;
  modelEmptyLabel?: string;
  models?: AssistantModelOption[];
  onDraftChange(value: string): void;
  onEffortChange?(value: AssistantReasoningEffort): void;
  onFocus?(): void;
  onModelChange?(value: string): void;
  onSubmit(value: string): void;
  providerId?: string;
  selectionDisabled?: boolean;
  variant?: "editor" | "home";
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [activeMention, setActiveMention] = useState<ActiveMention | null>(
    null,
  );
  const [selectedMention, setSelectedMention] = useState(0);
  const [draftMentions, setDraftMentions] = useStoredDraft<DraftMention[]>(
    draftKey ? `${draftKey}:mentions` : null,
    [],
  );
  const candidates = useMemo(() => mentionCandidates(context), [context]);
  const matches = useMemo(() => {
    if (!activeMention) return [];
    const query = normalizeMentionSearch(activeMention.query);
    return candidates
      .filter((candidate) =>
        normalizeMentionSearch(
          `${candidate.name} ${candidate.id} ${candidate.typeLabel}`,
        ).includes(query),
      )
      .slice(0, 12);
  }, [activeMention, candidates]);

  const mentionListRef = useScrollActiveOption(
    selectedMention,
    matches.length,
    Boolean(activeMention),
  );

  function updateMention(value: string, cursor: number | null) {
    const nextCursor = cursor ?? value.length;
    const mention = activeMentionAt(value, nextCursor);
    if (
      mention &&
      draftMentions.some((draftMention) => draftMention.start === mention.start)
    ) {
      setActiveMention(null);
      return;
    }
    setActiveMention(mention);
    setSelectedMention(0);
  }

  function insertMention(candidate: MentionCandidate) {
    if (!activeMention) return;
    const label = `@${candidate.name}`;
    const next = `${draft.slice(0, activeMention.start)}${label} ${draft.slice(activeMention.end)}`;
    const nextMentions = reconcileDraftMentions(draftMentions, draft, next);
    nextMentions.push({
      candidate,
      start: activeMention.start,
      end: activeMention.start + label.length,
    });
    setDraftMentions(nextMentions);
    const cursor = activeMention.start + label.length + 1;
    onDraftChange(next);
    setActiveMention(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(cursor, cursor);
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (activeMention && matches.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setSelectedMention(
          (current) => (current + direction + matches.length) % matches.length,
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const candidate = matches[selectedMention] ?? matches[0];
        if (candidate) insertMention(candidate);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setActiveMention(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit(serializeDraftMentions(draft, draftMentions));
      setDraftMentions([]);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    onSubmit(serializeDraftMentions(draft, draftMentions));
    setDraftMentions([]);
  }

  return (
    <form
      className={cn("relative shrink-0", variant === "home" && "pb-4 pt-1")}
      onSubmit={handleSubmit}
    >
      {activeMention ? (
        <div
          ref={mentionListRef}
          aria-label="Studio entity mentions"
          className="absolute bottom-full left-0 right-0 z-30 mb-1 max-h-72 overflow-y-auto rounded-surface border bg-popover p-1.5 text-popover-foreground shadow-xl"
          role="listbox"
        >
          {matches.length ? (
            matches.map((candidate, index) => (
              <button
                aria-selected={index === selectedMention}
                className={cn(
                  "flex w-full items-center gap-3 rounded-control px-3 py-2 text-left",
                  index === selectedMention
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/60",
                )}
                key={`${candidate.type}:${candidate.id}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertMention(candidate);
                }}
                role="option"
                type="button"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-control border bg-background text-xs font-semibold">
                  @
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {candidate.name}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {candidate.typeLabel} · {candidate.id}
                  </span>
                </span>
              </button>
            ))
          ) : (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              No matching Studio entity
            </div>
          )}
        </div>
      ) : null}

      <div
        className={cn(
          "rounded-surface border",
          variant === "editor"
            ? "bg-card/70 p-2 text-card-foreground shadow-xl backdrop-blur-2xl focus-within:ring-2 focus-within:ring-ring"
            : "bg-card/60 p-2 shadow-sm transition-colors focus-within:border-foreground/40",
        )}
      >
        <textarea
          aria-autocomplete="list"
          aria-expanded={Boolean(activeMention)}
          aria-label="Message Studio"
          autoFocus
          className={cn(
            "block w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground",
            variant === "editor"
              ? "min-h-14 px-2 py-2 leading-relaxed"
              : "min-h-20 px-2 py-2 leading-relaxed",
          )}
          disabled={disabled}
          onBlur={() => window.setTimeout(() => setActiveMention(null), 100)}
          onChange={(event) => {
            setDraftMentions((current) =>
              reconcileDraftMentions(current, draft, event.target.value),
            );
            onDraftChange(event.target.value);
            updateMention(event.target.value, event.target.selectionStart);
          }}
          onClick={(event) =>
            updateMention(
              event.currentTarget.value,
              event.currentTarget.selectionStart,
            )
          }
          onKeyDown={handleKeyDown}
          onFocus={onFocus}
          onSelect={(event) =>
            updateMention(
              event.currentTarget.value,
              event.currentTarget.selectionStart,
            )
          }
          placeholder={
            variant === "editor"
              ? "Ask about or change this workflow…"
              : "Ask anything, or describe what you want to build…"
          }
          ref={(node) => {
            textareaRef.current = node;
            if (inputRef) inputRef.current = node;
          }}
          value={draft}
        />
        {variant === "home" ? (
          <div className="flex items-center justify-between gap-2 px-1 pb-1">
            {onModelChange || onEffortChange ? (
              <div className="flex min-w-0 items-center gap-1.5">
                {onModelChange ? (
                  <AssistantModelSelector
                    compact
                    disabled={selectionDisabled}
                    emptyLabel={modelEmptyLabel}
                    models={models}
                    onChange={onModelChange}
                    providerId={providerId}
                    side="top"
                    value={model ?? ""}
                  />
                ) : null}
                {onEffortChange ? (
                  <AssistantEffortSelector
                    disabled={selectionDisabled}
                    onChange={onEffortChange}
                    side="top"
                    value={effort}
                  />
                ) : null}
              </div>
            ) : (
              <span className="text-[11px] text-muted-foreground">
                Type @ to mention · Enter to send · Shift+Enter for a new line
              </span>
            )}
            {onStop ? (
              <Button
                aria-label="Stop response"
                className="size-8 shrink-0"
                size="icon"
                type="button"
                variant="secondary"
                onClick={onStop}
              >
                <Square aria-hidden="true" className="size-3.5 fill-current" />
              </Button>
            ) : (
              <Button
                aria-label="Send message"
                className="size-8 shrink-0 rounded-control"
                disabled={!draft.trim() || disabled}
                size="icon"
                type="submit"
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </Button>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 px-1 pb-1">
            {onModelChange || onEffortChange ? (
              <div className="flex min-w-0 items-center gap-1.5">
                {onModelChange ? (
                  <AssistantModelSelector
                    compact
                    disabled={selectionDisabled}
                    emptyLabel={modelEmptyLabel}
                    models={models}
                    onChange={onModelChange}
                    providerId={providerId}
                    side="top"
                    value={model ?? ""}
                  />
                ) : null}
                {onEffortChange ? (
                  <AssistantEffortSelector
                    disabled={selectionDisabled}
                    onChange={onEffortChange}
                    side="top"
                    value={effort}
                  />
                ) : null}
              </div>
            ) : null}
            <Button
              aria-label="Send message"
              className="size-8 shrink-0 rounded-full"
              disabled={!draft.trim() || disabled}
              size="icon"
              type="submit"
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </Button>
          </div>
        )}
      </div>
      {variant === "home" ? (
        <p className="mt-2 px-1 text-xs leading-5 text-muted-foreground">
          Type @ to reference a workflow, run, or other item.
        </p>
      ) : null}
    </form>
  );
}

function ConversationHistory({
  activeConversationId,
  conversations,
  disabled,
  error,
  loading,
  loadingConversationId,
  onRetry,
  onSelect,
  archived,
  onEdit,
  query,
  onQueryChange,
}: {
  activeConversationId: string | null;
  conversations: ConversationSummary[];
  disabled: boolean;
  error: unknown;
  loading: boolean;
  loadingConversationId: string | null;
  onRetry(): void;
  onSelect(id: string): void;
  archived: boolean;
  onEdit(change: {
    id: string;
    title?: string;
    archived?: boolean;
  }): Promise<unknown>;
  query: string;
  onQueryChange(value: string): void;
}) {
  const [menuId, setMenuId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const { notify } = useToast();
  const groups = groupConversations(conversations, query);

  async function edit(change: {
    id: string;
    title?: string;
    archived?: boolean;
  }) {
    try {
      await onEdit(change);
      setEditingId(null);
      setMenuId(null);
    } catch {
      notify({
        id: "conversation-edit",
        message: "Could not save the change. Please try again.",
        variant: "error",
      });
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 px-3 pb-3">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground"
          />
          <input
            aria-label="Search conversation titles"
            className="h-9 w-full rounded-control border bg-background pl-8 pr-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="Search conversations…"
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setMenuId(null);
            setEditingId(null);
          }
        }}
      >
        {loading ? (
          <div
            className="flex items-center gap-2 px-3 py-5 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2
              aria-hidden="true"
              className="size-4 motion-safe:animate-spin"
            />
            Loading conversations…
          </div>
        ) : error ? (
          <div className="px-3 py-5">
            <Button
              className="mt-3"
              onClick={onRetry}
              size="sm"
              variant="outline"
            >
              Try again
            </Button>
          </div>
        ) : groups.length ? (
          groups.map(([label, items]) => (
            <section key={label} className="mb-4">
              <h3 className="px-4 py-2 text-xs font-medium text-muted-foreground">
                {label}
              </h3>
              <ul className="space-y-1 p-1">
                {items.map((conversation) => (
                  <li className="group" key={conversation.id}>
                    {editingId === conversation.id ? (
                      <form
                        className="space-y-2 rounded-control border p-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (title.trim())
                            void edit({
                              id: conversation.id,
                              title: title.trim(),
                            });
                        }}
                      >
                        <input
                          aria-label="Conversation title"
                          autoFocus
                          maxLength={80}
                          className="w-full rounded-control border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          value={title}
                          onChange={(event) => setTitle(event.target.value)}
                          disabled={disabled}
                        />
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            type="submit"
                            disabled={disabled || !title.trim()}
                          >
                            Save
                          </Button>
                          <Button
                            size="sm"
                            type="button"
                            variant="ghost"
                            disabled={disabled}
                            onClick={() => setEditingId(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <div
                          className={cn(
                            "flex items-center rounded-control hover:bg-accent",
                            conversation.id === activeConversationId &&
                              "bg-accent",
                          )}
                        >
                          <Link
                            to={conversationHref(conversation.id) as never}
                            aria-current={
                              conversation.id === activeConversationId
                                ? "page"
                                : undefined
                            }
                            aria-busy={
                              loadingConversationId === conversation.id
                            }
                            className="min-w-0 flex-1 rounded-control px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:opacity-60"
                            disabled={disabled}
                            onClick={() => onSelect(conversation.id)}
                            title={conversation.title}
                          >
                            <span className="block truncate text-sm font-medium">
                              {conversation.title}
                            </span>
                            <span
                              className={cn(
                                "mt-1 flex items-center gap-1.5 text-xs text-muted-foreground",
                                conversation.unread &&
                                  "font-medium text-primary",
                              )}
                            >
                              {isAssistantRequestActive(
                                conversation.request,
                              ) ? (
                                <Loader2
                                  aria-hidden="true"
                                  className="size-3 animate-spin"
                                />
                              ) : conversation.unread ? (
                                <span className="size-1.5 rounded-full bg-primary" />
                              ) : null}
                              {loadingConversationId === conversation.id
                                ? "Opening…"
                                : conversation.request?.status === "queued"
                                  ? "Waiting to start…"
                                  : conversation.request?.status === "running"
                                    ? "In progress…"
                                    : conversation.unread
                                      ? "Response ready"
                                      : conversation.request?.status ===
                                          "failed"
                                        ? "Response failed"
                                        : conversation.request?.status ===
                                            "cancelled"
                                          ? "Stopped"
                                          : conversationTimestamp(
                                              conversation.updatedAt,
                                            )}
                            </span>
                          </Link>
                          <DropdownMenu
                            open={menuId === conversation.id}
                            onOpenChange={(open) =>
                              setMenuId(open ? conversation.id : null)
                            }
                          >
                            <DropdownMenuTrigger asChild>
                              <Button
                                aria-label={`Options for ${conversation.title}`}
                                className="mr-1 size-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
                                size="icon"
                                variant="ghost"
                                disabled={disabled}
                              >
                                <MoreHorizontal
                                  aria-hidden="true"
                                  className="size-4"
                                />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                disabled={disabled}
                                onSelect={() => {
                                  setEditingId(conversation.id);
                                  setTitle(conversation.title);
                                }}
                              >
                                <SquarePen
                                  aria-hidden="true"
                                  className="size-3.5"
                                />
                                Rename
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={disabled}
                                onSelect={() =>
                                  void edit({
                                    id: conversation.id,
                                    archived: !archived,
                                  })
                                }
                              >
                                <Archive
                                  aria-hidden="true"
                                  className="size-3.5"
                                />
                                {archived ? "Restore" : "Archive"}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))
        ) : (
          <div className="px-3 py-5">
            <p className="text-sm font-medium">
              {query.trim()
                ? "No matching conversations"
                : archived
                  ? "No archived conversations"
                  : "No conversations yet"}
            </p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {query.trim()
                ? "Try a different title."
                : archived
                  ? "Archived chats stay here until you restore them."
                  : "Start a chat. It will appear here after the first reply."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function ChatMessageBubble({
  message,
  onModifyPlan,
}: {
  message: ChatMessage;
  onModifyPlan(plan: AssistantOperationPlan): void;
}) {
  const user = message.role === "user";

  return (
    <article
      className={cn(
        "max-w-[85%] text-sm leading-7",
        user ? "ml-auto" : "mr-auto w-full",
      )}
    >
      {!user ? (
        <span className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <BeamLogo className="size-3.5" />
          Studio
        </span>
      ) : null}
      {user ? (
        <div className="grid justify-items-end gap-1">
          <div className="whitespace-pre-wrap rounded-surface bg-secondary px-4 py-2.5 text-secondary-foreground">
            {renderUserMessage(message.content)}
          </div>
          <CopyButton label="Copy message" value={message.content} />
        </div>
      ) : (
        <div className="grid gap-4">
          <MarkdownContent
            assistantLinks
            compact
            copyCode
            muted={false}
            value={message.content}
          />
          <div>
            <CopyButton value={message.content} />
          </div>
          {(message.plan && !isReadOnlyPlan(message.plan)) ||
          (!message.plan && message.planId) ? (
            <AssistantPlanCard
              initialPlan={message.plan}
              onModifyPlan={onModifyPlan}
              planId={message.planId ?? message.plan?.id ?? ""}
            />
          ) : null}
        </div>
      )}
    </article>
  );
}

export function AssistantPlanCard({
  initialPlan,
  onModifyPlan,
  planId,
}: {
  initialPlan?: AssistantOperationPlan;
  onModifyPlan(plan: AssistantOperationPlan): void;
  planId: string;
}) {
  const queryClient = useQueryClient();
  const [inputValues, setInputValues] = useState<Record<string, unknown>>(
    Object.fromEntries(
      (initialPlan?.needsInput ?? [])
        .filter((request) => request.value !== undefined)
        .map((request) => [request.id, request.value]),
    ),
  );
  const [oneTimeValue, setOneTimeValue] = useState<string | null>(null);
  const [oneTimePending, setOneTimePending] = useState(false);
  const [oneTimeError, setOneTimeError] = useState<string | null>(null);
  const planQuery = useQuery({
    queryKey: ["/studio/assistant/plans", planId],
    queryFn: () =>
      apiGet<PlanPayload>(
        `/studio/assistant/plans/${encodeURIComponent(planId)}`,
      ),
    initialData: initialPlan ? { plan: initialPlan } : undefined,
    enabled: Boolean(planId),
    refetchInterval: (query) =>
      (query.state.data as PlanPayload | undefined)?.plan.status === "running"
        ? 1_000
        : false,
  });
  const actionMutation = useMutation({
    mutationFn: async ({
      action,
      inputs,
    }: {
      action:
        | "validate"
        | "confirm"
        | "confirm_execute"
        | "execute"
        | "cancel"
        | "rollback";
      inputs?: Record<string, unknown>;
    }) => {
      if (action === "confirm_execute") {
        await apiSend<PlanPayload>(
          "POST",
          `/studio/assistant/plans/${encodeURIComponent(planId)}/confirm`,
          {},
        );
        return apiSend<PlanPayload>(
          "POST",
          `/studio/assistant/plans/${encodeURIComponent(planId)}/execute`,
          {},
        );
      }
      return apiSend<PlanPayload>(
        "POST",
        `/studio/assistant/plans/${encodeURIComponent(planId)}/${action}`,
        action === "validate" ? { inputs: inputs ?? {} } : {},
      );
    },
    onMutate: ({ action }) => {
      if (action !== "execute" && action !== "confirm_execute") {
        return;
      }
      queryClient.setQueryData<PlanPayload>(
        ["/studio/assistant/plans", planId],
        (current) =>
          current
            ? {
                ...current,
                plan: { ...current.plan, status: "running" },
              }
            : current,
      );
    },
    onSuccess: (payload) => {
      queryClient.setQueryData(["/studio/assistant/plans", planId], payload);
      const workspaceSwitch = payload.plan.operations.find(
        (operation) => operation.result?.workspaceSwitch === true,
      );
      if (workspaceSwitch) {
        window.location.assign(
          typeof workspaceSwitch.result?.href === "string"
            ? workspaceSwitch.result.href
            : "/",
        );
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["/studio/assistant/plans", planId],
      });
    },
  });
  const payload = planQuery.data;
  const plan = payload?.plan;
  if (!plan) {
    return (
      <section className="rounded-surface border bg-card p-4">
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading plan…
        </span>
      </section>
    );
  }
  if (isReadOnlyPlan(plan)) {
    return null;
  }
  const canCancel = !["running", "completed", "cancelled"].includes(
    plan.status,
  );
  const resultLinks = plan.operations.flatMap((operation) => {
    const href =
      typeof operation.result?.href === "string" ? operation.result.href : null;
    return href ? [{ href, label: resultLabel(operation) }] : [];
  });

  return (
    <section className="overflow-hidden rounded-surface border bg-card shadow-sm">
      <div className="flex items-start justify-between gap-4 border-b px-4 py-3">
        <div className="min-w-0">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Studio operation plan
          </span>
          <h3 className="mt-0.5 text-sm font-semibold leading-5">
            {plan.summary}
          </h3>
        </div>
        <PlanStatus status={plan.status} />
      </div>

      <div className="grid gap-4 p-4">
        <div>
          <h4 className="text-xs font-medium text-muted-foreground">
            Operations and dependencies
          </h4>
          <div className="mt-2 grid gap-2">
            {plan.operations.map((operation, index) => (
              <div
                className="flex items-start gap-2 rounded-surface border bg-background px-3 py-2"
                key={operation.id}
              >
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[10px] font-semibold">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">
                    {operation.tool}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    Risk: {operation.risk}
                    {operation.dependsOn.length
                      ? ` · after ${operation.dependsOn.join(", ")}`
                      : " · no dependency"}
                  </span>
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {operation.status}
                </span>
              </div>
            ))}
          </div>
        </div>

        {plan.needsInput.length ? (
          <div>
            <h4 className="text-xs font-medium text-muted-foreground">
              Missing information
            </h4>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {plan.needsInput.map((request) => (
                <PlanInput
                  key={request.id}
                  onChange={(value) =>
                    setInputValues((current) => ({
                      ...current,
                      [request.id]: value,
                    }))
                  }
                  request={request}
                  value={inputValues[request.id] ?? request.value ?? ""}
                />
              ))}
            </div>
          </div>
        ) : null}

        {plan.preview ? (
          <div>
            <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <GitBranch className="size-3.5" />
              Preview
            </h4>
            <div className="mt-2 grid gap-2">
              {plan.preview.diffs.map((diff, index) => (
                <div
                  className="rounded-surface border bg-background px-3 py-2"
                  key={`${diff.resourceType}-${diff.resourceId ?? index}`}
                >
                  <span className="text-xs font-medium">
                    {diff.change} · {diff.label}
                  </span>
                  {diff.after || diff.before ? (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {diff.change === "delete" ? "Impact: " : ""}
                      {previewDescription(diff.after ?? diff.before ?? {})}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {plan.assumptions.length || plan.risks.length ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {plan.assumptions.length ? (
              <PlanNotes label="Assumptions" values={plan.assumptions} />
            ) : null}
            {plan.risks.length ? (
              <PlanNotes
                icon={<AlertTriangle className="size-3.5" />}
                label="Risks"
                values={plan.risks}
              />
            ) : null}
          </div>
        ) : null}

        {plan.estimatedImpact ? (
          <div className="rounded-surface border bg-muted/20 px-3 py-2">
            <h4 className="text-xs font-medium">Estimated impact</h4>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
              {[
                typeof plan.estimatedImpact.credits === "number"
                  ? formatCredits(plan.estimatedImpact.credits)
                  : null,
                plan.estimatedImpact.duration,
                ...(plan.estimatedImpact.externalEffects ?? []),
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        ) : null}

        {payload?.errors?.length ? (
          <div className="rounded-surface border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            {payload.errors.join(" ")}
          </div>
        ) : null}

        {plan.operations.some((operation) => operation.result) ? (
          <div>
            <h4 className="text-xs font-medium text-muted-foreground">
              Results
            </h4>
            <div className="mt-2 grid gap-2">
              {plan.operations
                .filter((operation) => operation.result)
                .map((operation) => (
                  <div
                    className="rounded-surface border bg-background px-3 py-2"
                    key={`result-${operation.id}`}
                  >
                    <span className="text-xs font-medium">
                      {operation.tool}
                    </span>
                    <p className="mt-0.5 break-words text-[11px] text-muted-foreground">
                      {operationResultSummary(operation.result ?? {})}
                    </p>
                  </div>
                ))}
            </div>
          </div>
        ) : null}

        {oneTimeValue ? (
          <div className="rounded-surface border border-amber-500/40 bg-amber-500/10 p-3">
            <span className="block text-xs font-medium">
              One-time secret — copy it now
            </span>
            <code className="mt-1 block select-all break-all text-xs">
              {oneTimeValue}
            </code>
          </div>
        ) : null}
        {oneTimeError ? (
          <div className="text-xs text-destructive">{oneTimeError}</div>
        ) : null}
        {actionMutation.error ? (
          <div className="rounded-surface border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            {String(actionMutation.error)}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2 border-t pt-3">
          {!["completed", "cancelled"].includes(plan.status) ? (
            <Button
              disabled={actionMutation.isPending}
              onClick={() => onModifyPlan(plan)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <SquarePen className="size-3.5" />
              Modify plan
            </Button>
          ) : null}
          {["draft", "needs_input", "failed"].includes(plan.status) ? (
            <Button
              disabled={actionMutation.isPending}
              onClick={() =>
                actionMutation.mutate({
                  action: "validate",
                  inputs: inputValues,
                })
              }
              size="sm"
              type="button"
              variant="outline"
            >
              <Eye className="size-3.5" />
              {plan.status === "failed" ? "Retry preview" : "Preview"}
            </Button>
          ) : null}
          {plan.status === "ready" ? (
            <>
              <Button
                disabled={actionMutation.isPending}
                onClick={() => actionMutation.mutate({ action: "confirm" })}
                size="sm"
                type="button"
                variant="outline"
              >
                <Check className="size-3.5" />
                {plan.confirmation.policy === "explicit"
                  ? "Confirm destructive impact"
                  : plan.confirmation.policy === "reinforced"
                    ? "Confirm security change"
                    : "Confirm"}
              </Button>
              <Button
                disabled={actionMutation.isPending}
                onClick={() =>
                  actionMutation.mutate({ action: "confirm_execute" })
                }
                size="sm"
                type="button"
              >
                <Play className="size-3.5" />
                {plan.confirmation.policy === "explicit"
                  ? "Confirm impact and execute"
                  : "Confirm and execute"}
              </Button>
            </>
          ) : null}
          {plan.status === "confirmed" ? (
            <Button
              disabled={actionMutation.isPending}
              onClick={() => actionMutation.mutate({ action: "execute" })}
              size="sm"
              type="button"
            >
              <Play className="size-3.5" />
              Execute
            </Button>
          ) : null}
          {resultLinks.map((link) => (
            <Button asChild key={link.href} size="sm" variant="outline">
              <a href={link.href}>{link.label}</a>
            </Button>
          ))}
          {plan.operations.some(
            (operation) => typeof operation.result?.oneTimeHref === "string",
          ) && !oneTimeValue ? (
            <Button
              disabled={oneTimePending}
              onClick={async () => {
                const href = plan.operations
                  .map((operation) => operation.result?.oneTimeHref)
                  .find((value): value is string => typeof value === "string");
                if (!href) return;
                setOneTimePending(true);
                setOneTimeError(null);
                try {
                  const response = await apiSend<{ secret: string }>(
                    "POST",
                    href,
                    {},
                  );
                  setOneTimeValue(response.secret);
                } catch (error) {
                  setOneTimeError(String(error));
                } finally {
                  setOneTimePending(false);
                }
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              {oneTimePending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Eye className="size-3.5" />
              )}
              Reveal once
            </Button>
          ) : null}
          {plan.status === "completed" &&
          plan.operations.some((operation) => operation.reversible) ? (
            <Button
              disabled={actionMutation.isPending}
              onClick={() => actionMutation.mutate({ action: "rollback" })}
              size="sm"
              type="button"
              variant="outline"
            >
              <RotateCcw className="size-3.5" />
              Rollback
            </Button>
          ) : null}
          {canCancel ? (
            <Button
              disabled={actionMutation.isPending}
              onClick={() => actionMutation.mutate({ action: "cancel" })}
              size="sm"
              type="button"
              variant="ghost"
            >
              <X className="size-3.5" />
              Cancel
            </Button>
          ) : null}
          {actionMutation.isPending ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Updating…
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}

type PlanPayload = {
  plan: AssistantOperationPlan;
  errors?: string[];
};

function isReadOnlyPlan(plan: AssistantOperationPlan) {
  return (
    plan.operations.length === 0 ||
    plan.operations.every((operation) => operation.risk === "read")
  );
}

function PlanInput({
  onChange,
  request,
  value,
}: {
  onChange(value: string | number | boolean): void;
  request: AssistantInputRequest;
  value: unknown;
}) {
  if (request.type === "secure_secret" || request.sensitive) {
    return (
      <div className="rounded-surface border bg-muted/30 px-3 py-2">
        <span className="block text-xs font-medium">{request.label}</span>
        <span className="block text-[11px] text-muted-foreground">
          Enter this secret in the dedicated secure Studio form. It will never
          be sent to the assistant.
        </span>
      </div>
    );
  }
  if (request.type === "boolean") {
    return (
      <label className="flex items-center gap-2 rounded-surface border px-3 py-2 text-xs">
        <input
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
          type="checkbox"
        />
        {request.label}
      </label>
    );
  }
  return (
    <label className="grid gap-1 text-xs">
      <span className="font-medium">{request.label}</span>
      <input
        className="h-9 rounded-control border bg-background px-2.5 outline-none focus:ring-2 focus:ring-ring"
        onChange={(event) =>
          onChange(
            request.type === "number"
              ? Number(event.target.value)
              : event.target.value,
          )
        }
        placeholder={
          request.type === "credential_reference"
            ? "Credential reference (never the secret)"
            : request.description
        }
        type={request.type === "number" ? "number" : "text"}
        value={
          typeof value === "string" || typeof value === "number" ? value : ""
        }
      />
    </label>
  );
}

function PlanNotes({
  icon,
  label,
  values,
}: {
  icon?: React.ReactNode;
  label: string;
  values: string[];
}) {
  return (
    <div className="rounded-surface border bg-muted/20 px-3 py-2">
      <h4 className="flex items-center gap-1.5 text-xs font-medium">
        {icon}
        {label}
      </h4>
      <ul className="mt-1 list-disc pl-4 text-[11px] leading-5 text-muted-foreground">
        {values.map((value) => (
          <li key={value}>{value}</li>
        ))}
      </ul>
    </div>
  );
}

function PlanStatus({ status }: { status: AssistantOperationPlan["status"] }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        status === "completed" &&
          "border-success/30 bg-success/10 text-success",
        status === "failed" &&
          "border-destructive/30 bg-destructive/10 text-destructive",
        status === "running" &&
          "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
      )}
    >
      {status.replace("_", " ")}
    </span>
  );
}

function previewDescription(value: Record<string, unknown>) {
  return Object.entries(value)
    .filter(([, item]) => item !== null && item !== undefined && item !== "")
    .slice(0, 10)
    .map(([key, item]) => {
      if (Array.isArray(item)) {
        const labels = item
          .map((entry) =>
            entry && typeof entry === "object"
              ? String((entry as Record<string, unknown>).name ?? "")
              : String(entry),
          )
          .filter(Boolean);
        return `${key}: ${labels.length ? labels.join(", ") : item.length}`;
      }
      if (item && typeof item === "object") {
        return `${key}: ${Object.keys(item as Record<string, unknown>).length} fields`;
      }
      return `${key}: ${String(item)}`;
    })
    .join(" · ");
}

function resultLabel(operation: AssistantOperationPlan["operations"][number]) {
  return operation.tool === "workflow.create"
    ? "Open in editor"
    : "Open result";
}

function operationResultSummary(value: Record<string, unknown>) {
  const hiddenKeys = new Set(["before", "oneTimeReceiptId", "oneTimeHref"]);
  return Object.entries(value)
    .filter(([key]) => !hiddenKeys.has(key))
    .slice(0, 8)
    .map(([key, item]) => {
      const rendered =
        item && typeof item === "object"
          ? Array.isArray(item)
            ? `${item.length} items`
            : `${Object.keys(item as Record<string, unknown>).length} fields`
          : String(item);
      return `${key}: ${rendered}`;
    })
    .join(" · ");
}

function mentionCandidates(
  context: Record<string, unknown>,
): MentionCandidate[] {
  const candidates: MentionCandidate[] = [];
  const addCollection = (
    key: string,
    type: string,
    typeLabel: string,
    nameKeys: string[],
  ) => {
    const values = Array.isArray(context[key]) ? context[key] : [];
    for (const value of values) {
      const entity = mentionRecord(value);
      const id = mentionString(entity.id);
      if (!id) continue;
      const name =
        nameKeys
          .map((nameKey) => mentionString(entity[nameKey]))
          .find(Boolean) ?? id;
      candidates.push({ id, name, type, typeLabel });
    }
  };

  addCollection("workflows", "workflow", "Workflow", ["name"]);
  addCollection("transfers", "transfer", "Transfer", ["name"]);
  addCollection("credentials", "credential", "Credential", ["name"]);
  addCollection("schedules", "schedule", "Schedule", ["name", "transferName"]);
  addCollection(
    "executionLocations",
    "execution_location",
    "Execution location",
    ["name"],
  );
  addCollection("mcpTokens", "mcp_token", "MCP token", ["name"]);
  addCollection("organizations", "organization", "Organization", ["name"]);
  addCollection("projects", "project", "Project", ["name"]);

  const runs = Array.isArray(context.runs) ? context.runs : [];
  for (const value of runs) {
    const run = mentionRecord(value);
    const id = mentionString(run.id);
    if (!id) continue;
    const resourceName =
      mentionString(run.workflowName) || mentionString(run.transferName);
    candidates.push({
      id,
      name: resourceName ? `${resourceName} · ${id}` : id,
      type: "run",
      typeLabel: `Run${mentionString(run.status) ? ` · ${mentionString(run.status)}` : ""}`,
    });
  }

  const registry = mentionRecord(context.registry);
  const packages = Array.isArray(registry.packages) ? registry.packages : [];
  for (const value of packages) {
    const item = mentionRecord(value);
    const id = mentionString(item.name);
    if (!id) continue;
    candidates.push({
      id,
      name: mentionString(item.displayName) || id,
      type: "registry_action",
      typeLabel: `Registry action${mentionString(item.version) ? ` · ${mentionString(item.version)}` : ""}`,
    });
  }

  return [
    ...new Map(
      candidates.map((candidate) => [
        `${candidate.type}:${candidate.id}`,
        candidate,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      left.typeLabel.localeCompare(right.typeLabel) ||
      left.name.localeCompare(right.name),
  );
}

function activeMentionAt(value: string, cursor: number): ActiveMention | null {
  const beforeCursor = value.slice(0, cursor);
  const start = beforeCursor.lastIndexOf("@");
  if (start < 0) return null;
  const preceding = value[start - 1];
  if (preceding && !/[\s([{]/.test(preceding)) return null;
  const query = value.slice(start + 1, cursor);
  if (
    query.length > 80 ||
    /[\n\r@[\](),;!?]/.test(query) ||
    query.includes("studio:")
  ) {
    return null;
  }
  return { start, end: cursor, query };
}

function reconcileDraftMentions(
  mentions: DraftMention[],
  previous: string,
  next: string,
) {
  let prefixLength = 0;
  while (
    prefixLength < previous.length &&
    prefixLength < next.length &&
    previous[prefixLength] === next[prefixLength]
  ) {
    prefixLength += 1;
  }
  let suffixLength = 0;
  while (
    suffixLength < previous.length - prefixLength &&
    suffixLength < next.length - prefixLength &&
    previous[previous.length - suffixLength - 1] ===
      next[next.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }
  const previousChangeEnd = previous.length - suffixLength;
  const nextChangeEnd = next.length - suffixLength;
  const delta = nextChangeEnd - previousChangeEnd;
  return mentions.flatMap((mention) => {
    const expected = `@${mention.candidate.name}`;
    if (previous.slice(mention.start, mention.end) !== expected) {
      return [];
    }
    if (mention.end <= prefixLength) {
      return [mention];
    }
    if (mention.start >= previousChangeEnd) {
      return [
        {
          ...mention,
          start: mention.start + delta,
          end: mention.end + delta,
        },
      ];
    }
    return [];
  });
}

function serializeDraftMentions(value: string, mentions: DraftMention[]) {
  return [...mentions]
    .sort((left, right) => right.start - left.start)
    .reduce((content, mention) => {
      const visible = `@${mention.candidate.name}`;
      if (content.slice(mention.start, mention.end) !== visible) {
        return content;
      }
      const token = `@[${escapeMentionLabel(mention.candidate.name)}](studio:${mention.candidate.type}:${mention.candidate.id})`;
      return `${content.slice(0, mention.start)}${token}${content.slice(mention.end)}`;
    }, value);
}

export function renderUserMessage(value: string) {
  const pattern = /@\[((?:\\.|[^\]])+)\]\(studio:([a-z_]+):([^)]+)\)/g;
  const output: React.ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    if (match.index > cursor) {
      output.push(value.slice(cursor, match.index));
    }
    const name = (match[1] ?? "").replace(/\\([[\]\\])/g, "$1");
    const href = assistantEntityHref(match[2] ?? "", match[3] ?? "");
    output.push(
      href ? (
        <a
          className="mx-0.5 inline-flex items-center rounded-control border border-primary-foreground/30 bg-primary-foreground/10 px-1.5 py-0.5 text-xs font-medium text-inherit transition-colors hover:bg-primary-foreground/20 hover:underline"
          href={href}
          key={`${match.index}-${match[2]}-${match[3]}`}
          title={`Open ${match[2]} · ${match[3]}`}
        >
          @{name}
        </a>
      ) : (
        <span
          className="mx-0.5 inline-flex items-center rounded-control border border-primary-foreground/30 bg-primary-foreground/10 px-1.5 py-0.5 text-xs font-medium"
          key={`${match.index}-${match[2]}-${match[3]}`}
          title={`${match[2]} · ${match[3]}`}
        >
          @{name}
        </span>
      ),
    );
    cursor = pattern.lastIndex;
  }
  if (!output.length) return value;
  if (cursor < value.length) output.push(value.slice(cursor));
  return output;
}

function normalizeMentionSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function escapeMentionLabel(value: string) {
  return value.replace(/[[\]\\]/g, "\\$&");
}

function mentionRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mentionString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
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

function messageId(role: ChatMessage["role"]) {
  return `${role}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
