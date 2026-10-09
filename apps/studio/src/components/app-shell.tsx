import {
  workflowListOptions,
  workflowRunsOptions,
} from "@/features/workflows/workflow-queries";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type HTMLAttributes,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  conversationHref,
  useLastConversation,
} from "@/features/assistant/conversation-navigation";
import { createPortal } from "react-dom";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Bot,
  Building2,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  CircleOff,
  CircleDot,
  Clock3,
  Cog,
  Cpu,
  DatabaseZap,
  Folder,
  FolderOpen,
  Gauge,
  GitBranch,
  History,
  Info,
  KeyRound,
  LayoutDashboard,
  ListCollapse,
  LogOut,
  LoaderCircle,
  MoreHorizontal,
  Moon,
  Network,
  PackageSearch,
  PlugZap,
  Plus,
  Search,
  Server,
  Speech,
  Star,
  RadioTower,
  Settings,
  ShieldCheck,
  Sun,
  UserRound,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  fetchRoomsSnapshot,
  roomAgentName,
  roomDisplayName,
  roomsQueryKey,
} from "@/features/rooms/room-data";
import { apiGet, apiSend } from "@/lib/api-client";
import { sortAgentsForInventory } from "@/lib/agent-inventory";
import { cn } from "@/lib/utils";
import { filterSidebarWorkflows } from "@/lib/sidebar-workflow-search";
import { useSidebarWorkflowHierarchy } from "@/lib/use-sidebar-workflow-hierarchy";

const nav: Array<{
  icon: LucideIcon;
  label: string;
  sectionId?: string;
  to: string;
}> = [
  { to: "/", label: "Assistant", icon: Bot },
  {
    to: "/dashboard",
    label: "Dashboard",
    icon: Gauge,
  },
  {
    to: "/registry",
    label: "Registry",
    icon: PackageSearch,
  },
  {
    to: "/credentials",
    label: "Credentials",
    icon: ShieldCheck,
  },
  {
    to: "/agents",
    label: "Remote Machines",
    icon: RadioTower,
  },
  {
    to: "/rooms",
    label: "Rooms",
    icon: Speech,
  },
];

type SidebarNavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  badge?: string;
  exact?: boolean;
  matchPaths?: string[];
};

type SidebarNavGroup = {
  items: SidebarNavItem[];
};

type SidebarSection = {
  id: string;
  paths: string[];
  groups: SidebarNavGroup[];
};

type SidebarView = "auto" | "parent" | "main";
type SidebarAnimationDirection = "forward" | "back" | "none";

type OrganizationOption = {
  id: string;
  name?: string | null;
  slug?: string | null;
  credits?: number | null;
  role?: string | null;
};

type OrganizationsPayload = {
  organizations?: OrganizationOption[];
  selectedOrganizationId?: string | null;
};

type ProjectOption = {
  id: string;
  organizationId: string;
  name?: string | null;
  slug?: string | null;
  description?: string | null;
};

type ProjectsPayload = {
  organizationId?: string | null;
  projects?: ProjectOption[];
  selectedProjectId?: string | null;
};

type BreadcrumbWorkflow = {
  id: string;
  name?: string | null;
  description?: string | null;
  enabled?: boolean;
  lastRunStatus?: string | null;
  scheduled?: boolean;
  updatedAt?: string | null;
};

type BreadcrumbWorkflowRun = {
  id?: string;
  runId?: string;
  workflowTemplateId?: string | null;
  workflowName?: string | null;
  status?: string | null;
  trigger?: string | null;
  createdAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
};

type WorkflowsBreadcrumbPayload = {
  workflows?: BreadcrumbWorkflow[];
};

type WorkflowRunsBreadcrumbPayload = {
  runs?: BreadcrumbWorkflowRun[];
};

type WorkflowRunBreadcrumbPayload = {
  run?: BreadcrumbWorkflowRun | null;
  template?: BreadcrumbWorkflow | null;
};

type BreadcrumbRouteInfo = {
  agentId: string | null;
  roomId: string | null;
  runId: string | null;
  workflowId: string | null;
};

type BreadcrumbAgent = {
  id: string;
  machineName?: string | null;
  name?: string | null;
  status: string;
};

type AgentsBreadcrumbPayload = {
  agents?: BreadcrumbAgent[];
};

type StudioSession = {
  type: "account";
  userId: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
};

type SessionPayload = {
  session?: StudioSession | null;
};

export type AppShellContextSidebarItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  badge?: string;
};

export type AppShellContextSidebar = {
  activeItemId: string;
  items: AppShellContextSidebarItem[];
  onItemSelect: (itemId: string) => void;
  title: string;
};

const sidebarSections: SidebarSection[] = [
  {
    id: "settings",
    paths: ["/settings"],
    groups: [
      {
        items: [
          { to: "/settings", label: "Overview", icon: CircleDot, exact: true },
          {
            to: "/settings/access",
            label: "Access",
            icon: ShieldCheck,
            matchPaths: ["/settings/access"],
          },
        ],
      },
    ],
  },
  {
    id: "mcp",
    paths: ["/mcp"],
    groups: [
      {
        items: [
          { to: "/mcp", label: "Overview", icon: CircleDot, exact: true },
          { to: "/mcp/connection", label: "Connection", icon: PlugZap },
          { to: "/mcp/capabilities", label: "Capabilities", icon: DatabaseZap },
          {
            to: "/mcp/tokens",
            label: "Tokens",
            icon: KeyRound,
            matchPaths: ["/mcp/tokens"],
          },
          { to: "/mcp/activity", label: "Activity", icon: Clock3 },
        ],
      },
    ],
  },
  {
    id: "orchestration",
    paths: ["/orchestration"],
    groups: [
      {
        items: [
          {
            to: "/orchestration",
            label: "Overview",
            icon: Gauge,
            exact: true,
          },
          {
            to: "/orchestration/orchestrators",
            label: "Orchestrators",
            icon: Server,
          },
          {
            to: "/orchestration/workers",
            label: "Workers",
            icon: Cpu,
          },
        ],
      },
    ],
  },
];

export function AppShell({
  children,
  contentClassName,
  contextSidebar,
  headerActions,
  headerBreadcrumbActions,
  headerStart,
  showCreateAction = false,
  showHeader = true,
  title,
}: {
  children: ReactNode;
  contentClassName?: string;
  contextSidebar?: AppShellContextSidebar;
  headerActions?: ReactNode;
  headerBreadcrumbActions?: ReactNode;
  headerStart?: ReactNode;
  showCreateAction?: boolean;
  showHeader?: boolean;
  title?: string;
}) {
  const location = useLocation();
  const pageTitle = title ?? getPageTitle(location.pathname);
  const activeSection = getActiveSection(location.pathname);
  const breadcrumbContext = useBreadcrumbContext(location.pathname);
  const workflowHeaderId = breadcrumbContext.workflowId;
  const roomHeaderId = breadcrumbRouteInfo(location.pathname).roomId;
  const [sidebarView, setSidebarView] = useState<SidebarView>("auto");

  useEffect(() => {
    setSidebarView("auto");
  }, [location.pathname]);

  useEffect(() => {
    document.title = `${pageTitle} | Beam Studio`;
  }, [pageTitle]);

  const showContextSidebar = Boolean(contextSidebar && sidebarView === "auto");
  const showSectionSidebar = Boolean(
    activeSection &&
    (sidebarView === "parent" || (!contextSidebar && sidebarView === "auto")),
  );
  const sidebarLevel = showContextSidebar ? 2 : showSectionSidebar ? 1 : 0;
  const previousSidebarLevelRef = useRef(sidebarLevel);
  const [sidebarAnimationDirection, setSidebarAnimationDirection] =
    useState<SidebarAnimationDirection>("none");

  useEffect(() => {
    const previousSidebarLevel = previousSidebarLevelRef.current;

    if (sidebarLevel === previousSidebarLevel) {
      return;
    }

    setSidebarAnimationDirection(
      sidebarLevel > previousSidebarLevel ? "forward" : "back",
    );
    previousSidebarLevelRef.current = sidebarLevel;
  }, [sidebarLevel]);

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <div className="flex items-center justify-between gap-3 group-data-[collapsible=icon]/sidebar:justify-center">
            <Link
              aria-label="Beam Studio"
              className="flex min-w-0 items-center gap-2 rounded-control group-data-[collapsible=icon]/sidebar:hidden"
              to="/dashboard"
            >
              <span className="grid size-9 shrink-0 place-items-center">
                <img
                  alt=""
                  className="hidden size-5 dark:block"
                  src="/beam-logo-white.svg"
                />
                <img
                  alt=""
                  className="size-5 dark:hidden"
                  src="/beam-logo-black.svg"
                />
              </span>
              <span className="truncate font-display text-[0.9rem] font-bold uppercase leading-none tracking-[0.12em] text-sidebar-foreground">
                Beam Studio
              </span>
              <StudioBetaBadge />
            </Link>
            <SidebarTrigger className="shrink-0 group-data-[collapsible=icon]/sidebar:hidden" />
            <div className="group/logo-trigger relative hidden size-9 place-items-center group-data-[collapsible=icon]/sidebar:grid">
              <Link
                aria-label="Beam Studio"
                className="grid size-9 place-items-center rounded-control transition-opacity group-hover/logo-trigger:opacity-0 group-focus-within/logo-trigger:opacity-0"
                to="/dashboard"
              >
                <img
                  alt=""
                  className="hidden size-5 dark:block"
                  src="/beam-logo-white.svg"
                />
                <img
                  alt=""
                  className="size-5 dark:hidden"
                  src="/beam-logo-black.svg"
                />
              </Link>
              <SidebarTrigger className="pointer-events-none absolute inset-0 opacity-0 transition-opacity group-hover/logo-trigger:pointer-events-auto group-hover/logo-trigger:opacity-100 group-focus-within/logo-trigger:pointer-events-auto group-focus-within/logo-trigger:opacity-100" />
            </div>
          </div>
        </SidebarHeader>
        <div className="relative z-30 shrink-0 border-b border-sidebar-border px-3 py-2 md:group-data-[collapsible=icon]/sidebar:hidden">
          <ProjectSelector context={breadcrumbContext} />
        </div>
        <SidebarContent>
          <div
            className={cn(
              "w-full min-w-0 px-3 group-data-[collapsible=icon]/sidebar:px-2",
              sidebarAnimationDirection === "forward" &&
                "sidebar-level-forward",
              sidebarAnimationDirection === "back" && "sidebar-level-back",
            )}
            key={`${sidebarLevel}:${contextSidebar?.title ?? activeSection?.id ?? "main"}`}
          >
            {showContextSidebar && contextSidebar ? (
              <ContextSidebarNav
                onBack={() => setSidebarView(activeSection ? "parent" : "main")}
                pageTitle={pageTitle}
                section={contextSidebar}
              />
            ) : showSectionSidebar && activeSection ? (
              <SectionSidebarNav
                onBack={() => setSidebarView("main")}
                pageTitle={pageTitle}
                pathname={location.pathname}
                section={activeSection}
              />
            ) : (
              <MainSidebarNav
                activeSection={activeSection}
                onOpenSection={() => setSidebarView("auto")}
                pathname={location.pathname}
              />
            )}
          </div>
          <SidebarWorkspaceTree pathname={location.pathname} />
        </SidebarContent>
        <SidebarFooter>
          <SidebarAccountMenu />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        {showHeader ? (
          <header
            className={cn(
              "flex h-14 shrink-0 items-center justify-between gap-4 border-b px-4",
              workflowHeaderId &&
                "workflow-header relative z-20 gap-1 px-2 sm:gap-4 sm:px-4",
            )}
          >
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <SidebarTrigger className="md:hidden" />
              {headerStart}
              <HeaderBreadcrumb
                context={breadcrumbContext}
                title={pageTitle}
                workflowHeader={Boolean(workflowHeaderId)}
              />
              {headerBreadcrumbActions ? (
                <div className="flex shrink-0 items-center">
                  {headerBreadcrumbActions}
                </div>
              ) : null}
            </div>
            {workflowHeaderId ? (
              <WorkflowHeaderLinks
                pathname={location.pathname}
                workflowId={workflowHeaderId}
              />
            ) : null}
            <div className="flex shrink-0 items-center justify-end gap-3">
              {headerActions || showCreateAction ? (
                <>
                  <div className="header-action-buttons flex shrink-0 items-center gap-2">
                    {headerActions}
                    {showCreateAction ? (
                      <Button asChild size="sm" variant="default">
                        <Link to="/workflows/new">
                          <Plus className="size-4" />
                          Create
                        </Link>
                      </Button>
                    ) : null}
                  </div>
                  {!workflowHeaderId && roomHeaderId ? (
                    <span
                      aria-hidden="true"
                      className="hidden h-5 w-px shrink-0 bg-border md:block"
                    />
                  ) : null}
                </>
              ) : null}
              {roomHeaderId ? (
                <RoomHeaderLinks
                  pathname={location.pathname}
                  roomId={roomHeaderId}
                />
              ) : null}
            </div>
          </header>
        ) : null}
        <div className="min-h-0 flex-1 overflow-auto">
          <div className={cn("w-full px-6 py-6", contentClassName)}>
            {children}
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function WorkflowHeaderLinks({
  pathname,
  workflowId,
}: {
  pathname: string;
  workflowId: string;
}) {
  const sections = [
    { id: "editor", label: "Editor" },
    { id: "overview", label: "Overview" },
    { id: "runs", label: "Runs" },
    { id: "settings", label: "Settings" },
  ].map((section) => ({
    ...section,
    to: `/workflows/${workflowId}/${section.id}`,
    active:
      pathMatches(pathname, `/workflows/${workflowId}/${section.id}`) ||
      (section.id === "runs" && pathname.startsWith("/workflows/runs/")),
  }));
  const activeLabel =
    sections.find((section) => section.active)?.label ?? "Editor";

  return (
    <nav aria-label="Workflow pages" className="shrink-0 self-stretch">
      <div className="workflow-header-tabs h-full items-stretch gap-1">
        {sections.map((section) => (
          <Link
            aria-current={section.active ? "page" : undefined}
            className={cn(
              "flex items-center border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              section.active && "border-primary text-foreground",
            )}
            key={section.id}
            to={section.to as never}
          >
            {section.label}
          </Link>
        ))}
      </div>
      <div className="workflow-header-page-menu h-full items-center">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={`Workflow pages: ${activeLabel}`}
              className="gap-1 px-2"
              size="sm"
              variant="ghost"
            >
              {activeLabel}
              <ChevronDown aria-hidden="true" className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {sections.map((section) => (
              <DropdownMenuItem asChild key={section.id}>
                <Link
                  aria-current={section.active ? "page" : undefined}
                  to={section.to as never}
                >
                  {section.label}
                  {section.active ? (
                    <Check aria-hidden="true" className="ml-auto size-4" />
                  ) : null}
                </Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </nav>
  );
}

function RoomHeaderLinks({
  pathname,
  roomId,
}: {
  pathname: string;
  roomId: string;
}) {
  const overviewPath = `/rooms/${roomId}`;
  const channelsPath = `${overviewPath}/channels`;
  const settingsPath = `${overviewPath}/settings`;
  const overviewActive = pathname === overviewPath;
  const channelsActive = pathMatches(pathname, channelsPath);
  const settingsActive = pathMatches(pathname, settingsPath);

  return (
    <div className="flex items-center gap-1">
      <Button
        asChild
        className={cn(
          "size-9",
          overviewActive && "bg-accent text-accent-foreground",
        )}
        size="icon"
        variant="ghost"
      >
        <Link
          aria-current={overviewActive ? "page" : undefined}
          aria-label="Room overview"
          title="Overview"
          to={overviewPath as never}
        >
          <LayoutDashboard className="size-4" />
        </Link>
      </Button>
      <Button
        asChild
        className={cn(
          "size-9",
          channelsActive && "bg-accent text-accent-foreground",
        )}
        size="icon"
        variant="ghost"
      >
        <Link
          aria-current={channelsActive ? "page" : undefined}
          aria-label="Room channels"
          title="Channels"
          to={channelsPath as never}
        >
          <Network className="size-4" />
        </Link>
      </Button>
      <Button
        asChild
        className={cn(
          "size-9",
          settingsActive && "bg-accent text-accent-foreground",
        )}
        size="icon"
        variant="ghost"
      >
        <Link
          aria-current={settingsActive ? "page" : undefined}
          aria-label="Room settings"
          title="Settings"
          to={settingsPath as never}
        >
          <Settings className="size-4" />
        </Link>
      </Button>
    </div>
  );
}

function useBreadcrumbContext(pathname: string) {
  const loadContext = pathname !== "/login" && pathname !== "/auth";
  const routeInfo = useMemo(() => breadcrumbRouteInfo(pathname), [pathname]);
  const organizationsQuery = useQuery({
    queryKey: ["/studio/organizations"],
    queryFn: () => apiGet<OrganizationsPayload>("/studio/organizations"),
    enabled: loadContext,
  });
  const organizations = organizationsQuery.data?.organizations ?? [];
  const selectedOrganizationId =
    organizationsQuery.data?.selectedOrganizationId ?? null;
  const activeOrganization =
    organizations.find(
      (organization) => organization.id === selectedOrganizationId,
    ) ?? organizations[0];
  const activeOrganizationId =
    selectedOrganizationId ?? activeOrganization?.id ?? null;
  const projectsQuery = useQuery({
    queryKey: ["/studio/projects", activeOrganizationId],
    queryFn: () => apiGet<ProjectsPayload>("/studio/projects"),
    enabled: loadContext && Boolean(activeOrganizationId),
  });
  const projects = projectsQuery.data?.projects ?? [];
  const selectedProjectId = projectsQuery.data?.selectedProjectId ?? null;
  const activeProject =
    projects.find((project) => project.id === selectedProjectId) ?? null;
  const activeProjectId = selectedProjectId ?? activeProject?.id ?? null;
  const roomsQuery = useQuery({
    queryKey: roomsQueryKey,
    queryFn: () => fetchRoomsSnapshot(),
    enabled:
      loadContext && (pathname === "/rooms" || Boolean(routeInfo.roomId)),
    refetchInterval: 2_500,
  });
  const agentsQuery = useQuery({
    queryKey: ["/studio/agents"],
    queryFn: () => apiGet<AgentsBreadcrumbPayload>("/studio/agents"),
    enabled:
      loadContext && (pathname === "/agents" || Boolean(routeInfo.agentId)),
    refetchInterval: 5_000,
  });
  const needsWorkflowSelector = Boolean(
    routeInfo.workflowId || routeInfo.runId,
  );
  const workflowsQuery = useQuery({
    ...workflowListOptions(),
    enabled: loadContext && needsWorkflowSelector,
  });
  const runDetailQuery = useQuery({
    queryKey: [`/studio/workflow-runs/${routeInfo.runId}`],
    staleTime: 5_000,
    queryFn: () =>
      apiGet<WorkflowRunBreadcrumbPayload>(
        `/studio/workflow-runs/${routeInfo.runId}`,
      ),
    enabled: loadContext && Boolean(routeInfo.runId),
  });
  const currentWorkflowId =
    routeInfo.workflowId ??
    runDetailQuery.data?.run?.workflowTemplateId ??
    runDetailQuery.data?.template?.id ??
    null;
  const workflowRunsQuery = useQuery({
    ...workflowRunsOptions({
      workflowTemplateId: currentWorkflowId ?? undefined,
    }),
    enabled: loadContext && Boolean(routeInfo.runId && currentWorkflowId),
  });

  return useMemo(
    () => ({
      agents: sortAgentsForInventory(agentsQuery.data?.agents ?? []),
      projectId: activeProjectId,
      projectName: activeProject?.name ?? activeProject?.id ?? null,
      projects,
      rooms: (roomsQuery.data?.rooms ?? []).map((room) => ({
        description: `${room.id} · ${roomAgentName(room.agent)} · ${room.state}`,
        id: room.id,
        name: roomDisplayName(room),
        participantCount: room.memberships.length,
      })),
      routeInfo,
      runDetail: runDetailQuery.data ?? null,
      runs: workflowRunsQuery.data?.runs ?? [],
      workflowId: currentWorkflowId,
      workflows: workflowsQuery.data?.workflows ?? [],
    }),
    [
      agentsQuery.data?.agents,
      activeProjectId,
      activeProject?.id,
      activeProject?.name,
      projects,
      roomsQuery.data?.rooms,
      routeInfo,
      runDetailQuery.data,
      workflowRunsQuery.data?.runs,
      currentWorkflowId,
      workflowsQuery.data?.workflows,
    ],
  );
}

export function PageControls({ children }: { children?: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-5 py-3 sm:px-8 md:justify-end">
      <SidebarTrigger className="md:hidden" />
      {children}
    </div>
  );
}

function ProjectSelector({
  context,
}: {
  context: {
    projectId?: string | null;
    projectName?: string | null;
    projects?: ProjectOption[];
  };
}) {
  const queryClient = useQueryClient();

  const switchProject = async (projectId: string) => {
    await apiSend("POST", "/studio/project-context", {
      projectId: projectId === ORGANIZATION_WIDE_PROJECT_ID ? null : projectId,
    });
    queryClient.clear();
    window.location.reload();
  };

  return (
    <BreadcrumbEntitySelector
      emptyLabel="No projects found"
      fullWidth
      label={context.projectName ?? "All Projects"}
      options={[
        {
          description: "Organization-wide",
          id: ORGANIZATION_WIDE_PROJECT_ID,
          label: "All Projects",
        },
        ...(context.projects ?? []).map((project) => ({
          description: project.slug || project.description || "Project",
          id: project.id,
          label: project.name || project.id,
        })),
      ]}
      searchPlaceholder="Find project..."
      selectedId={context.projectId ?? ORGANIZATION_WIDE_PROJECT_ID}
      onSelect={(option) => switchProject(option.id)}
    />
  );
}

function HeaderBreadcrumb({
  context,
  title,
  workflowHeader = false,
}: {
  context: {
    agents?: BreadcrumbAgent[];
    projectId?: string | null;
    projectName?: string | null;
    projects?: ProjectOption[];
    rooms?: Array<{
      description?: string | null;
      id: string;
      name: string;
      participantCount?: number;
    }>;
    routeInfo: BreadcrumbRouteInfo;
    runDetail?: WorkflowRunBreadcrumbPayload | null;
    runs?: BreadcrumbWorkflowRun[];
    workflowId?: string | null;
    workflows?: BreadcrumbWorkflow[];
  };
  title: string;
  workflowHeader?: boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const routeInfo = context.routeInfo;
  const agents = context.agents ?? [];
  const workflows = context.workflows ?? [];
  const runs = context.runs ?? [];
  const rooms = context.rooms ?? [];
  const currentWorkflow =
    workflows.find((workflow) => workflow.id === context.workflowId) ??
    context.runDetail?.template ??
    null;
  const currentWorkflowRun =
    runs.find((run) => workflowRunId(run) === routeInfo.runId) ??
    context.runDetail?.run ??
    null;
  const currentAgent =
    agents.find((agent) => agent.id === routeInfo.agentId) ?? null;
  const hasAgentSelector =
    location.pathname === "/agents" || Boolean(routeInfo.agentId);
  const hasRoomSelector =
    location.pathname === "/rooms" || Boolean(routeInfo.roomId);
  const hasWorkflowSelector = Boolean(context.workflowId || routeInfo.runId);
  const hasWorkflowRunSelector = Boolean(routeInfo.runId);
  const hasRunSelector = hasWorkflowRunSelector;
  const staticSegments =
    hasAgentSelector || hasRoomSelector || hasWorkflowSelector || hasRunSelector
      ? []
      : title
          .split("/")
          .map((segment) => segment.trim())
          .filter(Boolean);

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1 text-sm tracking-normal [&>li:first-child>.breadcrumb-separator]:hidden">
        {hasAgentSelector ? (
          <BreadcrumbSelectorItem separatorClassName="lg:inline">
            <BreadcrumbEntitySelector
              createAction={{ label: "Connect an agent", to: "/agents/new" }}
              emptyLabel="No agents found"
              label={
                currentAgent?.name ||
                currentAgent?.machineName ||
                routeInfo.agentId ||
                "All agents"
              }
              options={[
                {
                  description: "Agent inventory",
                  id: ALL_AGENTS_ID,
                  label: "All agents",
                },
                ...agents.map((agent) => ({
                  description: `${agent.status} · ${agent.id}`,
                  id: agent.id,
                  label: agent.name || agent.machineName || agent.id,
                })),
              ]}
              searchPlaceholder="Find agent..."
              selectedId={routeInfo.agentId ?? ALL_AGENTS_ID}
              onSelect={(option) => {
                if (option.id === ALL_AGENTS_ID) {
                  navigate({ to: "/agents" });
                  return;
                }
                const section = location.pathname.match(
                  /^\/agents\/[^/]+\/(overview|tunnels|destinations|rooms|logs|activity|settings)/,
                )?.[1];
                navigate({
                  to: `/agents/${option.id}/${section || "overview"}` as never,
                });
              }}
            />
          </BreadcrumbSelectorItem>
        ) : null}
        {hasRoomSelector ? (
          <BreadcrumbSelectorItem separatorClassName="lg:inline">
            <BreadcrumbEntitySelector
              emptyLabel="No rooms found"
              label={
                rooms.find((room) => room.id === routeInfo.roomId)?.name ??
                routeInfo.roomId ??
                "All rooms"
              }
              options={[
                {
                  description: "Room directory",
                  id: ALL_ROOMS_ID,
                  label: "All rooms",
                },
                ...rooms.map((room) => ({
                  description: room.description,
                  id: room.id,
                  label: room.name,
                  participantCount: room.participantCount,
                })),
              ]}
              searchPlaceholder="Find room..."
              selectedId={routeInfo.roomId ?? ALL_ROOMS_ID}
              onSelect={(option) => {
                if (option.id === ALL_ROOMS_ID) {
                  navigate({ to: "/rooms" });
                  return;
                }
                const section = location.pathname.match(
                  /^\/rooms\/[^/]+\/(activity|channels|members|settings|transfers)/,
                )?.[1];
                navigate({
                  to: `/rooms/${option.id}${section ? `/${section}` : ""}` as never,
                });
              }}
            />
          </BreadcrumbSelectorItem>
        ) : null}
        {null}
        {hasWorkflowSelector ? (
          <BreadcrumbSelectorItem
            separatorClassName={workflowHeader ? "!hidden" : "lg:inline"}
          >
            <BreadcrumbEntitySelector
              triggerClassName={workflowHeader ? "max-w-none" : undefined}
              createAction={{
                label: "Create workflow",
                to: "/workflows/new",
              }}
              emptyLabel="No workflows found"
              label={currentWorkflow?.name ?? context.workflowId ?? "Workflow"}
              options={workflows.map((workflow) => ({
                description: workflow.description || "Workflow",
                id: workflow.id,
                label: workflow.name || workflow.id,
              }))}
              searchPlaceholder="Find workflow..."
              selectedId={context.workflowId ?? null}
              onSelect={(option) =>
                navigate({
                  to: `/workflows/${option.id}/${location.pathname.match(/\/(editor|overview|runs|settings)(?:\/|$)/)?.[1] ?? "editor"}` as never,
                })
              }
            />
          </BreadcrumbSelectorItem>
        ) : null}
        {hasRunSelector ? (
          <BreadcrumbSelectorItem separatorClassName="inline">
            <BreadcrumbEntitySelector
              emptyLabel="No runs found"
              label={
                workflowRunId(currentWorkflowRun) ?? routeInfo.runId ?? "Run"
              }
              options={runs.map((run) => ({
                description: runDescription(run),
                id: workflowRunId(run) ?? "",
                label: workflowRunId(run) ?? "Run",
              }))}
              searchPlaceholder={"Find run..."}
              selectedId={routeInfo.runId}
              onSelect={(option) =>
                navigate({
                  to: context.workflowId
                    ? (`/workflows/${context.workflowId}/runs/${option.id}` as never)
                    : (`/workflows/runs/${option.id}` as never),
                })
              }
            />
          </BreadcrumbSelectorItem>
        ) : null}
        {staticSegments.map((segment, index) => (
          <BreadcrumbStaticItem
            current={index === staticSegments.length - 1}
            key={`${segment}:${index}`}
            separatorClassName={index === 0 ? "lg:inline" : "inline"}
          >
            {segment}
          </BreadcrumbStaticItem>
        ))}
      </ol>
    </nav>
  );
}

const ORGANIZATION_WIDE_PROJECT_ID = "__organization_wide__";
const ALL_AGENTS_ID = "__all_agents__";
const ALL_ROOMS_ID = "__all_rooms__";
const BREADCRUMB_TRIGGER_CLASS_NAME =
  "flex h-9 min-w-0 max-w-[240px] items-center gap-1.5 rounded-control px-2.5 text-left text-sm font-semibold text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent";

type BreadcrumbSelectorOption = {
  description?: string | null;
  id: string;
  label: string;
  participantCount?: number;
};

function BreadcrumbSelectorItem({
  children,
  className,
  separatorClassName,
}: {
  children: ReactNode;
  className?: string;
  separatorClassName?: string;
}) {
  return (
    <li className={cn("flex min-w-0 items-center gap-1", className)}>
      <BreadcrumbSeparator className={separatorClassName} />
      {children}
    </li>
  );
}

function BreadcrumbStaticItem({
  children,
  current,
  separatorClassName,
}: {
  children: ReactNode;
  current: boolean;
  separatorClassName?: string;
}) {
  return (
    <li
      aria-current={current ? "page" : undefined}
      className="flex min-w-0 items-center gap-1"
    >
      <BreadcrumbSeparator className={separatorClassName} />
      <button
        className={BREADCRUMB_TRIGGER_CLASS_NAME}
        data-overflow-scroll-trigger=""
        disabled
        title={typeof children === "string" ? children : undefined}
        type="button"
      >
        {typeof children === "string" ? (
          <OverflowScrollText>{children}</OverflowScrollText>
        ) : (
          <span className="min-w-0 truncate">{children}</span>
        )}
      </button>
    </li>
  );
}

function BreadcrumbSeparator({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "breadcrumb-separator hidden shrink-0 text-muted-foreground",
        className,
      )}
    >
      /
    </span>
  );
}

function BreadcrumbEntitySelector({
  createAction,
  emptyLabel,
  fullWidth = false,
  label,
  options,
  searchPlaceholder,
  selectedId,
  onSelect,
  triggerClassName,
}: {
  fullWidth?: boolean;
  triggerClassName?: string;
  createAction?: { label: string; to: string };
  emptyLabel: string;
  label: string;
  options: BreadcrumbSelectorOption[];
  searchPlaceholder: string;
  selectedId?: string | null;
  onSelect(option: BreadcrumbSelectorOption): void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);

  const updateMenuPosition = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    const menuWidth = Math.min(360, window.innerWidth - 32);
    setMenuPosition({
      left: Math.max(
        16,
        Math.min(rect.left, window.innerWidth - menuWidth - 16),
      ),
      top: rect.bottom + 8,
    });
  };
  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return options.filter((option) => option.id);
    }
    return options.filter((option) =>
      [option.label, option.description, option.id]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [options, query]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setQuery("");
    const focusFrame = window.requestAnimationFrame(() =>
      searchInputRef.current?.focus(),
    );
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const choose = (option: BreadcrumbSelectorOption) => {
    setOpen(false);
    void onSelect(option);
  };

  return (
    // A flex wrapper, so the trigger is a flex item that shrinks with the
    // breadcrumb. In a block wrapper the button sizes to fit its full label and
    // spills past the wrapper — over the workflow tabs on a run page.
    <div className={cn("relative flex min-w-0", fullWidth && "w-full")}>
      <button
        aria-expanded={open}
        aria-label={label}
        className={cn(
          BREADCRUMB_TRIGGER_CLASS_NAME,
          fullWidth && "w-full max-w-none",
          triggerClassName,
        )}
        data-overflow-scroll-trigger=""
        onClick={() => {
          updateMenuPosition();
          setOpen((value) => !value);
        }}
        ref={triggerRef}
        title={label}
        type="button"
      >
        <OverflowScrollText>{label}</OverflowScrollText>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open && menuPosition && typeof document !== "undefined"
        ? createPortal(
            <>
              <button
                aria-label="Close breadcrumb selector"
                className="fixed inset-0 z-[999] cursor-default"
                onClick={() => setOpen(false)}
                type="button"
              />
              <div
                className="fixed z-[1000] w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-surface border bg-popover text-popover-foreground shadow-lg"
                style={menuPosition}
              >
                <div className="flex items-center gap-2 border-b px-3 py-2">
                  <Search className="size-4 shrink-0 text-muted-foreground" />
                  <input
                    className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={searchPlaceholder}
                    ref={searchInputRef}
                    value={query}
                  />
                  <kbd className="rounded-control border px-2 py-1 text-xs text-muted-foreground">
                    Esc
                  </kbd>
                </div>
                <div className="max-h-72 overflow-y-auto p-2">
                  {filteredOptions.length ? (
                    filteredOptions.map((option) => (
                      <button
                        className={cn(
                          "flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
                          option.id === selectedId &&
                            "bg-accent text-accent-foreground",
                        )}
                        key={option.id}
                        onClick={() => choose(option)}
                        type="button"
                      >
                        <span className="grid size-7 shrink-0 place-items-center rounded-control bg-secondary text-xs font-semibold text-secondary-foreground">
                          {option.label.slice(0, 2).toUpperCase()}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">
                            {option.label}
                          </span>
                          {option.description ||
                          option.participantCount !== undefined ? (
                            <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
                              {option.description ? (
                                <span className="truncate">
                                  {option.description}
                                </span>
                              ) : null}
                              {option.participantCount !== undefined ? (
                                <span className="inline-flex shrink-0 items-center gap-1">
                                  <span aria-hidden="true">·</span>
                                  <span>{option.participantCount}</span>
                                  <Users
                                    aria-hidden="true"
                                    className="size-3"
                                  />
                                </span>
                              ) : null}
                            </span>
                          ) : null}
                        </span>
                        {option.id === selectedId ? (
                          <Check className="size-4 shrink-0 text-primary" />
                        ) : null}
                      </button>
                    ))
                  ) : (
                    <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                      {emptyLabel}
                    </div>
                  )}
                </div>
                {createAction ? (
                  <div className="border-t p-2">
                    <Link
                      className="flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-left text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
                      onClick={() => setOpen(false)}
                      to={createAction.to as never}
                    >
                      <Plus className="size-4 text-muted-foreground" />
                      {createAction.label}
                    </Link>
                  </div>
                ) : null}
              </div>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}

function workflowRunId(run: BreadcrumbWorkflowRun | null | undefined) {
  return run?.id ?? run?.runId ?? null;
}

function runDescription(run: BreadcrumbWorkflowRun) {
  return [run.status, run.createdAt ? shortDateTime(run.createdAt) : null]
    .filter(Boolean)
    .join(" · ");
}

function shortDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString(undefined, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  });
}

function breadcrumbRouteInfo(pathname: string): BreadcrumbRouteInfo {
  const contextualWorkflowRunMatch = pathname.match(
    /^\/workflows\/([^/]+)\/runs\/([^/]+)/,
  );
  const workflowRunMatch = pathname.match(/^\/workflows\/runs\/([^/]+)/);
  const runMatch = pathname.match(/^\/runs\/([^/]+)/);
  const workflowMatch = pathname.match(
    /^\/workflows\/(?!actions(?:\/|$)|runs(?:\/|$)|new(?:\/|$))([^/]+)/,
  );
  const roomMatch = pathname.match(/^\/rooms\/([^/]+)/);
  const agentMatch = pathname.match(/^\/agents\/(?!new(?:\/|$))([^/]+)/);

  return {
    agentId: agentMatch?.[1] ? decodePathPart(agentMatch[1]) : null,
    roomId: roomMatch?.[1] ? decodePathPart(roomMatch[1]) : null,
    runId: contextualWorkflowRunMatch?.[2]
      ? decodePathPart(contextualWorkflowRunMatch[2])
      : workflowRunMatch?.[1]
        ? decodePathPart(workflowRunMatch[1])
        : runMatch?.[1]
          ? decodePathPart(runMatch[1])
          : null,
    workflowId: contextualWorkflowRunMatch?.[1]
      ? decodePathPart(contextualWorkflowRunMatch[1])
      : workflowMatch?.[1]
        ? decodePathPart(workflowMatch[1])
        : null,
  };
}

function decodePathPart(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const STUDIO_THEME_STORAGE_KEY = "beam-studio.theme";

type StudioTheme = "dark" | "light";

function themeFromDocument(): StudioTheme {
  if (typeof document === "undefined") {
    return "dark";
  }

  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function applyStudioTheme(theme: StudioTheme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

function useStudioThemeController() {
  const [theme, setTheme] = useState<StudioTheme>("dark");

  useEffect(() => {
    const storedTheme =
      localStorage.getItem(STUDIO_THEME_STORAGE_KEY) === "light"
        ? "light"
        : "dark";

    applyStudioTheme(storedTheme);
    setTheme(storedTheme);
  }, []);

  const toggleTheme = () => {
    const nextTheme = themeFromDocument() === "dark" ? "light" : "dark";

    localStorage.setItem(STUDIO_THEME_STORAGE_KEY, nextTheme);
    applyStudioTheme(nextTheme);
    setTheme(nextTheme);
  };

  return { theme, toggleTheme };
}

function userInitial(session: StudioSession | null | undefined) {
  return (session?.name?.[0] || session?.email?.[0] || "U").toUpperCase();
}

function userDisplayName(session: StudioSession) {
  return session.name || "User";
}

function UserAvatar({
  session,
}: {
  session: StudioSession | null | undefined;
}) {
  return (
    <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-full bg-sidebar-primary text-xs font-bold text-sidebar-primary-foreground">
      {session?.image ? (
        <img
          alt={session.name || "User"}
          className="size-full object-cover"
          src={session.image}
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      ) : (
        userInitial(session)
      )}
    </span>
  );
}
const SIDEBAR_FAVORITE_WORKFLOWS_STORAGE_KEY =
  "beam-studio.sidebar.favorite-workflows";

function SidebarWorkspaceTree({ pathname }: { pathname: string }) {
  const { state: sidebarState } = useSidebar();
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searching = searchQuery.trim().length > 0;

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen]);

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
    searchButtonRef.current?.focus();
  };
  const [favoriteWorkflowIds, setFavoriteWorkflowIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [favoriteWorkflowsRestored, setFavoriteWorkflowsRestored] =
    useState(false);
  const [scrollEdges, setScrollEdges] = useState({
    bottom: false,
    top: false,
  });
  const workflowsQuery = useQuery({
    ...workflowListOptions(),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const workflows = workflowsQuery.data?.workflows ?? [];
  const workflowsById = new Map(
    workflows.map((workflow) => [workflow.id, workflow]),
  );
  const filtered = filterSidebarWorkflows({
    workflows,
    query: searchQuery,
  });
  const sessionQuery = useQuery({
    queryKey: ["/studio/session"],
    queryFn: () => apiGet<SessionPayload>("/studio/session"),
  });
  const organizationsQuery = useQuery({
    queryKey: ["/studio/organizations"],
    queryFn: () => apiGet<OrganizationsPayload>("/studio/organizations"),
  });
  const organizationId =
    organizationsQuery.data?.selectedOrganizationId ??
    organizationsQuery.data?.organizations?.[0]?.id;
  const userId = sessionQuery.data?.session?.userId;
  const hierarchy = useSidebarWorkflowHierarchy(
    workflows,
    searchQuery,
    breadcrumbRouteInfo(pathname).workflowId,
    organizationId && userId ? `${userId}:${organizationId}` : null,
  );
  const [movingWorkflowId, setMovingWorkflowId] = useState<string | null>(null);
  const [moveParentId, setMoveParentId] = useState("");
  const openMoveDialog = (id: string) => {
    setMovingWorkflowId(id);
    setMoveParentId(hierarchy.parents[id] ?? "");
  };
  const rootDropProps: HTMLAttributes<HTMLDivElement> = {
    onDragOver: (event) => {
      if (
        !hierarchy.draggingId ||
        !hierarchy.canMove(hierarchy.draggingId, null)
      )
        return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      hierarchy.setDropTarget("root");
    },
    onDragLeave: () => hierarchy.setDropTarget(null),
    onDrop: (event) => {
      event.preventDefault();
      if (hierarchy.draggingId) hierarchy.move(hierarchy.draggingId, null);
    },
  };
  const favoriteWorkflows = filtered.filter((workflow) =>
    favoriteWorkflowIds.has(workflow.id),
  );
  const activeWorkflowId = breadcrumbRouteInfo(pathname).workflowId;

  useEffect(() => {
    try {
      const storedValue = localStorage.getItem(
        SIDEBAR_FAVORITE_WORKFLOWS_STORAGE_KEY,
      );
      if (storedValue !== null) {
        const storedWorkflowIds = JSON.parse(storedValue);
        if (
          Array.isArray(storedWorkflowIds) &&
          storedWorkflowIds.every(
            (workflowId) => typeof workflowId === "string",
          )
        ) {
          setFavoriteWorkflowIds(new Set(storedWorkflowIds));
        }
      }
    } catch {
      // Keep the in-memory favorites when storage is unavailable or malformed.
    }
    setFavoriteWorkflowsRestored(true);
  }, []);

  useEffect(() => {
    if (!favoriteWorkflowsRestored) {
      return;
    }

    try {
      localStorage.setItem(
        SIDEBAR_FAVORITE_WORKFLOWS_STORAGE_KEY,
        JSON.stringify([...favoriteWorkflowIds]),
      );
    } catch {
      // Favorites remain available for the current session.
    }
  }, [favoriteWorkflowIds, favoriteWorkflowsRestored]);

  useEffect(() => {
    const updateScrollEdges = () => {
      updateSidebarScrollEdges(scrollAreaRef.current, setScrollEdges);
    };
    const frame = requestAnimationFrame(updateScrollEdges);
    window.addEventListener("resize", updateScrollEdges);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", updateScrollEdges);
    };
  }, [
    searchQuery,
    searchOpen,
    favoriteWorkflowIds,
    sidebarState,
    workflows.length,
    hierarchy.rows.length,
  ]);

  const toggleFavoriteWorkflow = (workflowId: string) => {
    setFavoriteWorkflowIds((current) => {
      const next = new Set(current);
      if (next.has(workflowId)) {
        next.delete(workflowId);
      } else {
        next.add(workflowId);
      }
      return next;
    });
  };

  return (
    <>
      <Dialog
        open={Boolean(movingWorkflowId)}
        onOpenChange={(open) => {
          if (!open) setMovingWorkflowId(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Move workflow</DialogTitle>
            <DialogDescription>
              Organize{" "}
              {workflowsById.get(movingWorkflowId ?? "")?.name ||
                "this workflow"}{" "}
              in the sidebar.
            </DialogDescription>
          </DialogHeader>
          <label className="grid gap-2 text-sm">
            Parent workflow
            <select
              aria-label="Parent workflow"
              className="h-10 w-full rounded-control border bg-background px-3"
              value={moveParentId}
              onChange={(event) => setMoveParentId(event.target.value)}
            >
              <option value="">Top level</option>
              {workflows
                .filter(
                  (workflow) =>
                    movingWorkflowId &&
                    hierarchy.canMove(movingWorkflowId, workflow.id),
                )
                .map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.name || "Untitled workflow"}
                  </option>
                ))}
            </select>
          </label>
          <Button
            disabled={
              !movingWorkflowId ||
              !hierarchy.canMove(movingWorkflowId, moveParentId || null)
            }
            onClick={() => {
              if (movingWorkflowId)
                hierarchy.move(movingWorkflowId, moveParentId || null);
              setMovingWorkflowId(null);
            }}
          >
            Move workflow
          </Button>
        </DialogContent>
      </Dialog>
      <div className="relative flex min-h-0 w-full flex-1 group-data-[collapsible=icon]/sidebar:hidden">
        <div
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-2 pl-3 pr-0.5 [scrollbar-gutter:stable]"
          onScroll={(event) =>
            updateSidebarScrollEdges(event.currentTarget, setScrollEdges)
          }
          ref={scrollAreaRef}
        >
          <SidebarGroup>
            <div
              {...rootDropProps}
              className={cn(
                "sticky top-0 z-10 bg-sidebar",
                hierarchy.dropTarget === "root" &&
                  "rounded-control ring-2 ring-primary",
                scrollEdges.top &&
                  "shadow-[0_6px_8px_-8px_hsl(var(--sidebar-foreground)/0.45)]",
              )}
            >
              <SidebarGroupLabel className="justify-between text-sidebar-foreground">
                {/*
                  The heading is the only route to /workflows: nothing else in
                  the app links to it, so the index was reachable only by typing
                  the URL. It stays plain text mid-drag, when it is a drop
                  target instruction rather than somewhere to go.
                */}
                {hierarchy.draggingId ? (
                  <span>Drop here for top level</span>
                ) : (
                  <Link
                    className="rounded-control transition-colors hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                    title="All workflows"
                    to="/workflows"
                  >
                    Workflows
                  </Link>
                )}
                <span className="flex items-center gap-0.5">
                  <button
                    aria-controls="sidebar-workflow-search"
                    aria-expanded={searchOpen}
                    aria-label="Search workflows"
                    className={cn(
                      "grid size-6 place-items-center rounded-control transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                      searchOpen &&
                        "bg-sidebar-accent text-sidebar-accent-foreground",
                    )}
                    onClick={() =>
                      searchOpen ? closeSearch() : setSearchOpen(true)
                    }
                    ref={searchButtonRef}
                    title="Search workflows"
                    type="button"
                  >
                    <Search className="size-3.5" />
                  </button>
                  <Link
                    aria-label="Create workflow"
                    className="grid size-6 place-items-center rounded-control transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                    title="Create workflow"
                    to="/workflows/new"
                  >
                    <Plus className="size-3.5" />
                  </Link>
                </span>
              </SidebarGroupLabel>
              <div
                className="px-1 pb-2 pt-1"
                hidden={!searchOpen}
                id="sidebar-workflow-search"
              >
                <div className="flex h-8 items-center gap-1.5 rounded-control border border-sidebar-border bg-background px-2 focus-within:ring-2 focus-within:ring-sidebar-ring">
                  <Search
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                  <input
                    aria-label="Search workflows and folders"
                    className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                    onChange={(event) => {
                      setSearchQuery(event.target.value);
                      scrollAreaRef.current?.scrollTo({ top: 0 });
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        closeSearch();
                      }
                    }}
                    placeholder="Search workflows…"
                    ref={searchInputRef}
                    type="search"
                    value={searchQuery}
                  />
                  <button
                    aria-label="Close workflow search"
                    className="grid size-5 shrink-0 place-items-center rounded-control-compact text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                    onClick={closeSearch}
                    type="button"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              </div>
            </div>
            <SidebarGroupContent>
              <p
                aria-live="polite"
                className={
                  hierarchy.saveError
                    ? "px-2 py-1 text-xs text-destructive"
                    : "sr-only"
                }
              >
                {hierarchy.message}
              </p>
              {favoriteWorkflows.length ? (
                <div className="mb-2">
                  <p className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-[0.12em] text-sidebar-foreground">
                    Favorites
                  </p>
                  <SidebarMenu>
                    {favoriteWorkflows.map((workflow) => (
                      <SidebarWorkflowNode
                        enabled={workflow.enabled}
                        favorite
                        key={`favorite:${workflow.id}`}
                        lastRunStatus={workflow.lastRunStatus}
                        name={workflow.name}
                        onToggleFavorite={toggleFavoriteWorkflow}
                        pathname={pathname}
                        scheduled={workflow.scheduled}
                        workflowId={workflow.id}
                      />
                    ))}
                  </SidebarMenu>
                </div>
              ) : null}
              <SidebarMenu>
                {workflowsQuery.isPending ? (
                  <SidebarTreeLoading />
                ) : (
                  <>
                    {hierarchy.rows.map(
                      ({ workflow, depth, hasChildren, expanded }) => (
                        <SidebarWorkflowNode
                          tree={{
                            depth,
                            hasChildren,
                            expanded,
                            onToggle: () => hierarchy.toggle(workflow.id),
                            onMove: () => openMoveDialog(workflow.id),
                            rowProps: {
                              draggable: hierarchy.canMove(workflow.id, null),
                              "data-workflow-id": workflow.id,
                              onDragStart: (event) => {
                                event.dataTransfer.setData(
                                  "application/x-beam-workflow",
                                  workflow.id,
                                );
                                event.dataTransfer.effectAllowed = "move";
                                hierarchy.setDraggingId(workflow.id);
                              },
                              onDragEnd: () => {
                                hierarchy.setDraggingId(null);
                                hierarchy.setDropTarget(null);
                              },
                              onDragOver: (event) => {
                                if (
                                  !hierarchy.draggingId ||
                                  !hierarchy.canMove(
                                    hierarchy.draggingId,
                                    workflow.id,
                                  )
                                )
                                  return;
                                event.preventDefault();
                                event.stopPropagation();
                                event.dataTransfer.dropEffect = "move";
                                hierarchy.setDropTarget(workflow.id);
                              },
                              onDragLeave: () => hierarchy.setDropTarget(null),
                              onDrop: (event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                if (hierarchy.draggingId)
                                  hierarchy.move(
                                    hierarchy.draggingId,
                                    workflow.id,
                                  );
                              },
                            },
                            dropTarget: hierarchy.dropTarget === workflow.id,
                            dragging: hierarchy.draggingId === workflow.id,
                          }}
                          enabled={workflow.enabled}
                          favorite={favoriteWorkflowIds.has(workflow.id)}
                          key={workflow.id}
                          lastRunStatus={workflow.lastRunStatus}
                          name={workflow.name}
                          onToggleFavorite={toggleFavoriteWorkflow}
                          pathname={pathname}
                          scheduled={workflow.scheduled}
                          workflowId={workflow.id}
                        />
                      ),
                    )}
                    {!hierarchy.rows.length ? (
                      <SidebarTreeEmpty
                        label={
                          searching
                            ? "No matching workflows"
                            : "No workflows yet"
                        }
                      />
                    ) : null}
                  </>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </div>
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-gradient-to-t from-sidebar to-transparent transition-opacity",
            scrollEdges.bottom ? "opacity-100" : "opacity-0",
          )}
        />
      </div>
      <CollapsedWorkflowStatuses pathname={pathname} workflows={workflows} />
    </>
  );
}

function updateSidebarScrollEdges(
  element: HTMLDivElement | null,
  setScrollEdges: Dispatch<SetStateAction<{ bottom: boolean; top: boolean }>>,
) {
  if (!element) {
    return;
  }

  const nextEdges = {
    bottom: element.scrollTop + element.clientHeight < element.scrollHeight - 1,
    top: element.scrollTop > 1,
  };

  setScrollEdges((current) =>
    current.bottom === nextEdges.bottom && current.top === nextEdges.top
      ? current
      : nextEdges,
  );
}

function CollapsedWorkflowStatuses({
  pathname,
  workflows,
}: {
  pathname: string;
  workflows: BreadcrumbWorkflow[];
}) {
  return (
    <div className="hidden min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto pb-2 [scrollbar-width:none] group-data-[collapsible=icon]/sidebar:flex [&::-webkit-scrollbar]:hidden">
      {workflows.map((workflow) => {
        const workflowName = workflow.name?.trim() || "Untitled workflow";
        const status = sidebarWorkflowStatus({
          enabled: workflow.enabled ?? true,
          lastRunStatus: workflow.lastRunStatus,
          scheduled: workflow.scheduled ?? false,
        });
        const active = pathMatches(pathname, `/workflows/${workflow.id}`);

        return (
          <SidebarInstantTooltip
            key={workflow.id}
            label={`${workflowName} · ${status}`}
          >
            <Link
              aria-current={active ? "page" : undefined}
              aria-label={`${workflowName} · ${status}`}
              className={cn(
                "grid size-8 shrink-0 place-items-center rounded-control outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                active && "bg-sidebar-accent",
              )}
              to={`/workflows/${workflow.id}/editor` as never}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-2 rounded-full",
                  sidebarWorkflowStatusDotClass(status),
                )}
              />
            </Link>
          </SidebarInstantTooltip>
        );
      })}
    </div>
  );
}

function SidebarWorkflowNode({
  tree,
  compact = false,
  enabled = true,
  favorite,
  lastRunStatus,
  name,
  onToggleFavorite,
  pathname,
  scheduled = false,
  workflowId,
}: {
  tree?: {
    depth: number;
    hasChildren: boolean;
    expanded: boolean;
    dropTarget: boolean;
    dragging: boolean;
    rowProps: HTMLAttributes<HTMLDivElement> & { "data-workflow-id": string };
    onToggle(): void;
    onMove(): void;
  };
  compact?: boolean;
  enabled?: boolean;
  favorite: boolean;
  lastRunStatus?: string | null;
  name?: string | null;
  onToggleFavorite(workflowId: string): void;
  pathname: string;
  scheduled?: boolean;
  workflowId: string;
}) {
  const workflowName = name?.trim() || "Untitled workflow";
  const workflowStatus = sidebarWorkflowStatus({
    enabled,
    lastRunStatus,
    scheduled,
  });
  const WorkflowIcon =
    workflowStatus === "running"
      ? LoaderCircle
      : workflowStatus === "disabled"
        ? CircleOff
        : workflowStatus === "scheduled"
          ? CalendarClock
          : tree?.hasChildren
            ? tree.expanded
              ? FolderOpen
              : Folder
            : GitBranch;
  const active = pathMatches(pathname, `/workflows/${workflowId}`);
  const overviewPath = `/workflows/${workflowId}/overview`;
  const runsPath = `/workflows/${workflowId}/runs`;
  const overviewActive = pathMatches(pathname, overviewPath);
  const runsActive = pathMatches(pathname, runsPath);

  return (
    <SidebarMenuItem
      className="group/workflow-item"
      style={tree ? { paddingLeft: tree.depth * 14 } : undefined}
    >
      <div
        {...tree?.rowProps}
        data-overflow-scroll-trigger=""
        className={cn(
          "relative flex min-w-0 items-center rounded-control text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-within:bg-sidebar-accent focus-within:text-sidebar-accent-foreground",
          compact ? "h-7 text-xs" : "h-8 text-sm",
          tree?.dropTarget && "ring-2 ring-inset ring-primary bg-primary/10",
          tree?.dragging && "opacity-40",
          active &&
            "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
        )}
      >
        {tree ? (
          tree.hasChildren ? (
            <button
              type="button"
              className="grid size-5 shrink-0 place-items-center rounded-control hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              aria-label={`${tree.expanded ? "Collapse" : "Expand"} ${workflowName}`}
              aria-expanded={tree.expanded}
              onClick={tree.onToggle}
            >
              {tree.expanded ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
            </button>
          ) : (
            <span className="w-5 shrink-0" />
          )
        ) : null}
        <Link
          draggable={false}
          aria-current={active ? "page" : undefined}
          className="flex h-full min-w-0 flex-1 items-center gap-2 px-2"
          title={`${workflowName} · ${workflowStatus}`}
          to={`/workflows/${workflowId}/editor` as never}
        >
          <WorkflowIcon
            className={cn(
              "shrink-0",
              compact ? "size-3.5" : "size-4",
              workflowStatus === "running" && "animate-spin text-info",
              workflowStatus === "disabled" && "text-sidebar-foreground",
              workflowStatus === "scheduled" && "text-warning",
              workflowStatus === "enabled" && "text-sidebar-foreground",
            )}
          />
          <OverflowScrollText endClearance={22}>
            {workflowName}
          </OverflowScrollText>
          <span className="sr-only"> ({workflowStatus})</span>
        </Link>
        <SidebarWorkflowActions
          onMove={tree?.onMove}
          favorite={favorite}
          onToggleFavorite={() => onToggleFavorite(workflowId)}
          overviewActive={overviewActive}
          overviewPath={overviewPath}
          runsActive={runsActive}
          runsPath={runsPath}
          workflowName={workflowName}
        />
      </div>
    </SidebarMenuItem>
  );
}

function OverflowScrollText({
  children,
  endClearance = 0,
}: {
  children: string;
  endClearance?: number;
}) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  const [motion, setMotion] = useState({
    distance: 0,
    durationMs: 500,
    faded: false,
  });

  useEffect(() => {
    const viewport = viewportRef.current;
    const title = titleRef.current;
    if (!viewport || !title) {
      return;
    }

    const updateMotion = () => {
      const viewportWidth = viewport.clientWidth;
      const titleWidth = title.scrollWidth;
      if (viewportWidth <= 0 || titleWidth <= 0) {
        return;
      }
      const distance = Math.max(0, titleWidth - viewportWidth + endClearance);
      const characterCount = Math.max(Array.from(children).length, 1);
      const averageCharacterWidth = titleWidth / characterCount;
      const hiddenCharacterCount = distance / averageCharacterWidth;
      const nextMotion = {
        distance,
        durationMs: Math.max(500, Math.round(hiddenCharacterCount * 420)),
        faded: titleWidth > viewportWidth + 1,
      };

      setMotion((current) =>
        current.distance === nextMotion.distance &&
        current.durationMs === nextMotion.durationMs &&
        current.faded === nextMotion.faded
          ? current
          : nextMotion,
      );
    };

    updateMotion();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updateMotion);
    resizeObserver?.observe(viewport);
    resizeObserver?.observe(title);
    window.addEventListener("resize", updateMotion);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateMotion);
    };
  }, [children, endClearance]);

  const style = {
    "--overflow-scroll-duration": `${motion.durationMs}ms`,
    "--overflow-scroll-shift": `${-motion.distance}px`,
  } as CSSProperties;

  return (
    <span
      className="relative min-w-0 flex-1 overflow-hidden"
      data-faded={motion.faded ? "true" : "false"}
      data-overflow-scroll-text=""
      ref={viewportRef}
    >
      <span
        className="inline-block max-w-none whitespace-nowrap will-change-transform"
        data-overflow-scroll-text-content=""
        ref={titleRef}
        style={style}
      >
        {children}
      </span>
    </span>
  );
}

function SidebarWorkflowActions({
  onMove,
  favorite,
  onToggleFavorite,
  overviewActive,
  overviewPath,
  runsActive,
  runsPath,
  workflowName,
}: {
  onMove?(): void;
  favorite: boolean;
  onToggleFavorite(): void;
  overviewActive: boolean;
  overviewPath: string;
  runsActive: boolean;
  runsPath: string;
  workflowName: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);

  const toggleMenu = () => {
    if (open) {
      setOpen(false);
      return;
    }

    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }

    const triggerRect = trigger.getBoundingClientRect();
    const menuWidth = 176;
    setMenuPosition({
      left: Math.max(
        8,
        Math.min(
          triggerRect.right - menuWidth,
          window.innerWidth - menuWidth - 8,
        ),
      ),
      top: Math.min(
        triggerRect.bottom + 4,
        window.innerHeight - (onMove ? 176 : 132),
      ),
    });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) {
      return;
    }

    const focusFrame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    });

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !triggerRef.current?.contains(event.target) &&
        !menuRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const closeOnViewportChange = () => setOpen(false);

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [open]);

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Actions for ${workflowName}`}
        className={cn(
          "absolute right-1 grid size-6 place-items-center rounded-control bg-sidebar-accent text-sidebar-foreground opacity-0 outline-none transition-[color,opacity] hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring group-hover/workflow-item:opacity-100 [@media(hover:none)]:opacity-100",
          open && "opacity-100 text-sidebar-foreground",
        )}
        onClick={toggleMenu}
        ref={triggerRef}
        type="button"
      >
        <MoreHorizontal className="size-3.5" />
      </button>
      {open && menuPosition
        ? createPortal(
            <div
              className="fixed z-50 w-44 rounded-control border border-sidebar-border bg-popover p-1 text-popover-foreground shadow-lg"
              onKeyDown={handleSidebarMenuKeyDown}
              ref={menuRef}
              role="menu"
              style={menuPosition}
            >
              <Link
                aria-current={overviewActive ? "page" : undefined}
                className={cn(
                  "flex h-8 items-center gap-2 rounded-control px-2 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
                  overviewActive && "bg-accent text-accent-foreground",
                )}
                onClick={() => setOpen(false)}
                role="menuitem"
                to={overviewPath as never}
              >
                <Info className="size-3.5" />
                Info
              </Link>
              <Link
                aria-current={runsActive ? "page" : undefined}
                className={cn(
                  "flex h-8 items-center gap-2 rounded-control px-2 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
                  runsActive && "bg-accent text-accent-foreground",
                )}
                onClick={() => setOpen(false)}
                role="menuitem"
                to={runsPath as never}
              >
                <History className="size-3.5" />
                History
              </Link>
              {onMove ? (
                <button
                  type="button"
                  role="menuitem"
                  className="flex h-8 w-full items-center gap-2 rounded-control px-2 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"
                  onClick={() => {
                    setOpen(false);
                    onMove();
                  }}
                >
                  <Folder className="size-3.5" />
                  Move workflow…
                </button>
              ) : null}
              <div className="my-1 border-t border-border" />
              <button
                className="flex h-8 w-full items-center gap-2 rounded-control px-2 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                onClick={() => {
                  onToggleFavorite();
                  setOpen(false);
                }}
                role="menuitem"
                type="button"
              >
                <Star
                  className={cn(
                    "size-3.5",
                    favorite && "fill-current text-primary",
                  )}
                />
                {favorite ? "Remove favorite" : "Add to favorites"}
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function handleSidebarMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    return;
  }

  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  );
  if (!items.length) {
    return;
  }

  event.preventDefault();
  const currentIndex = items.indexOf(document.activeElement as HTMLElement);
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowUp"
          ? (currentIndex - 1 + items.length) % items.length
          : (currentIndex + 1) % items.length;
  items[nextIndex]?.focus();
}

function sidebarWorkflowStatus({
  enabled,
  lastRunStatus,
  scheduled,
}: {
  enabled: boolean;
  lastRunStatus?: string | null;
  scheduled: boolean;
}): "disabled" | "enabled" | "running" | "scheduled" {
  const normalizedRunStatus = lastRunStatus?.trim().toLowerCase();

  if (
    normalizedRunStatus &&
    ["cancel_requested", "queued", "running"].includes(normalizedRunStatus)
  ) {
    return "running";
  }
  if (!enabled) {
    return "disabled";
  }
  if (scheduled) {
    return "scheduled";
  }
  return "enabled";
}

function sidebarWorkflowStatusDotClass(
  status: ReturnType<typeof sidebarWorkflowStatus>,
) {
  if (status === "running") {
    return "animate-pulse bg-info";
  }
  if (status === "scheduled") {
    return "bg-warning";
  }
  if (status === "disabled") {
    return "bg-sidebar-foreground/25";
  }
  return "bg-success";
}

function SidebarTreeLoading() {
  return (
    <>
      <li className="h-8 animate-pulse rounded-control bg-sidebar-accent/60" />
      <li className="h-8 animate-pulse rounded-control bg-sidebar-accent/40" />
    </>
  );
}

function SidebarTreeEmpty({ label }: { label: string }) {
  return (
    <li className="px-2 py-1 text-xs text-sidebar-foreground/50">{label}</li>
  );
}

function SidebarAccountMenu() {
  const [open, setOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const accountMenuButtonRef = useRef<HTMLButtonElement>(null);
  const accountMenuPopoverRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<{
    bottom: number;
    left: number;
    width: number;
  } | null>(null);
  const { state: sidebarState } = useSidebar();
  const { theme, toggleTheme } = useStudioThemeController();
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: ["/studio/session"],
    queryFn: () => apiGet<SessionPayload>("/studio/session"),
  });
  const session = sessionQuery.data?.session ?? null;
  const organizationsQuery = useQuery({
    queryKey: ["/studio/organizations"],
    queryFn: () => apiGet<OrganizationsPayload>("/studio/organizations"),
    enabled: Boolean(session),
  });
  const organizations = organizationsQuery.data?.organizations ?? [];
  const selectedOrganizationId =
    organizationsQuery.data?.selectedOrganizationId ??
    organizations[0]?.id ??
    null;
  useEffect(() => {
    if (!open) {
      setMenuPosition(null);
      return;
    }

    const updateMenuPosition = () => {
      const button = accountMenuButtonRef.current;
      if (!button) {
        return;
      }

      const buttonRect = button.getBoundingClientRect();
      setMenuPosition({
        bottom: window.innerHeight - buttonRect.top + 8,
        left: buttonRect.left,
        width: sidebarState === "collapsed" ? 256 : buttonRect.width,
      });
    };

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);

    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open, sidebarState]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !accountMenuRef.current?.contains(event.target) &&
        !accountMenuPopoverRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  const signOut = async () => {
    await apiSend("POST", "/studio/auth/logout");
    window.location.assign("/auth");
  };

  const switchOrganization = async (organizationId: string) => {
    await apiSend("POST", "/studio/organization-context", { organizationId });
    setOpen(false);
    window.location.reload();
  };

  if (sessionQuery.isLoading) {
    return (
      <div className="w-full group-data-[collapsible=icon]/sidebar:w-auto">
        <div className="flex h-11 items-center gap-2 rounded-control border border-sidebar-border px-2 group-data-[collapsible=icon]/sidebar:size-9 group-data-[collapsible=icon]/sidebar:justify-center group-data-[collapsible=icon]/sidebar:px-0">
          <span className="size-8 animate-pulse rounded-full bg-sidebar-accent" />
          <span className="grid min-w-0 flex-1 gap-1 group-data-[collapsible=icon]/sidebar:hidden">
            <span className="h-3 w-24 animate-pulse rounded-control-compact bg-sidebar-accent" />
            <span className="h-3 w-16 animate-pulse rounded-control-compact bg-sidebar-accent" />
          </span>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="w-full group-data-[collapsible=icon]/sidebar:w-auto">
        <SidebarInstantTooltip label="Sign in">
          <SidebarMenuButton asChild>
            <Link to="/auth">
              <UserRound />
              <span className="group-data-[collapsible=icon]/sidebar:hidden">
                Sign in
              </span>
            </Link>
          </SidebarMenuButton>
        </SidebarInstantTooltip>
      </div>
    );
  }

  const displayName = userDisplayName(session);

  return (
    <div
      className="relative w-full group-data-[collapsible=icon]/sidebar:w-auto"
      ref={accountMenuRef}
    >
      <SidebarInstantTooltip label={displayName}>
        <button
          aria-expanded={open}
          aria-label="Open account menu"
          className="flex h-11 w-full items-center gap-2 rounded-control px-2 text-left text-sm outline-none transition-colors hover:bg-sidebar-accent/50 focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]/sidebar:size-9 group-data-[collapsible=icon]/sidebar:justify-center group-data-[collapsible=icon]/sidebar:px-0"
          onClick={() => setOpen((value) => !value)}
          ref={accountMenuButtonRef}
          type="button"
        >
          <UserAvatar session={session} />
          <span className="min-w-0 flex-1 group-data-[collapsible=icon]/sidebar:hidden">
            <span className="block truncate font-semibold">{displayName}</span>
          </span>
          <ChevronUp
            className={cn(
              "size-4 shrink-0 text-sidebar-foreground/65 transition-transform group-data-[collapsible=icon]/sidebar:hidden",
              open && "rotate-180",
            )}
          />
        </button>
      </SidebarInstantTooltip>

      {open && menuPosition
        ? createPortal(
            <div
              className="fixed z-50 overflow-hidden rounded-control border border-sidebar-border bg-popover text-popover-foreground shadow-lg"
              ref={accountMenuPopoverRef}
              style={menuPosition}
            >
              <div className="flex items-center gap-3 border-b border-border px-3 py-3">
                <UserAvatar session={session} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {displayName}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {session.email || "No email"}
                  </span>
                </span>
              </div>
              <div className="max-h-[min(70vh,36rem)] overflow-y-auto p-2">
                {organizations.length ? (
                  <div className="border-b border-border py-2">
                    <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
                      Organizations
                    </p>
                    {organizations.map((organization) => (
                      <button
                        className={cn(
                          "flex w-full items-center gap-2 rounded-control px-2 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
                          organization.id === selectedOrganizationId &&
                            "bg-accent text-accent-foreground",
                        )}
                        key={organization.id}
                        onClick={() => switchOrganization(organization.id)}
                        type="button"
                      >
                        <Building2 className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">
                            {organization.name || organization.id}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {organization.slug ||
                              organization.role ||
                              "Organization"}
                          </span>
                        </span>
                        {organization.id === selectedOrganizationId ? (
                          <Check className="size-4 shrink-0 text-primary" />
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : null}

                <div className="border-b border-border py-2">
                  <Link
                    className="flex w-full items-center gap-2 rounded-control px-2 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                    onClick={() => setOpen(false)}
                    to={"/mcp" as never}
                  >
                    <Bot className="size-4 text-muted-foreground" />
                    MCP
                  </Link>
                  <Link
                    className="flex w-full items-center gap-2 rounded-control px-2 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                    onClick={() => setOpen(false)}
                    to={"/orchestration" as never}
                  >
                    <Server className="size-4 text-muted-foreground" />
                    Orchestration
                  </Link>
                  <Link
                    className="flex w-full items-center gap-2 rounded-control px-2 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                    onClick={() => setOpen(false)}
                    to={"/settings" as never}
                  >
                    <Settings className="size-4 text-muted-foreground" />
                    Settings
                  </Link>
                </div>

                <button
                  aria-checked={theme === "dark"}
                  className="flex w-full items-center justify-between rounded-control px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                  onClick={toggleTheme}
                  role="switch"
                  type="button"
                >
                  <span className="flex items-center gap-2">
                    {theme === "dark" ? (
                      <Sun className="size-4" />
                    ) : (
                      <Moon className="size-4" />
                    )}
                    Day / Night
                  </span>
                  <span
                    className={cn(
                      "flex h-6 w-11 items-center rounded-full border-2 border-transparent bg-input p-0.5 transition-colors",
                      theme === "dark" && "bg-primary",
                    )}
                  >
                    <span
                      className={cn(
                        "size-5 rounded-full bg-background transition-transform",
                        theme === "dark" && "translate-x-5",
                      )}
                    />
                  </span>
                </button>
                <button
                  className="flex w-full items-center gap-2 rounded-control px-2 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/10"
                  onClick={signOut}
                  type="button"
                >
                  <LogOut className="size-4" />
                  Logout
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function SidebarInstantTooltip({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  const { state } = useSidebar();

  if (state !== "collapsed") {
    return children;
  }

  return (
    <TooltipPrimitive.Provider delayDuration={0} skipDelayDuration={0}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            className="z-[70] rounded-control border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
            side="right"
            sideOffset={6}
          >
            {label}
            <TooltipPrimitive.Arrow className="fill-border" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

function MainSidebarNav({
  activeSection,
  onOpenSection,
  pathname,
}: {
  activeSection?: SidebarSection;
  onOpenSection(): void;
  pathname: string;
}) {
  const session = useQuery({
    queryKey: ["/studio/session"],
    queryFn: () =>
      apiGet<{ session?: { userId: string } | null }>("/studio/session"),
  });
  const organizations = useQuery({
    queryKey: ["/studio/organizations"],
    queryFn: () => apiGet<OrganizationsPayload>("/studio/organizations"),
  });
  const [lastConversation] = useLastConversation(
    session.data?.session?.userId,
    organizations.data?.selectedOrganizationId ??
      organizations.data?.organizations?.[0]?.id,
  );
  const homeHref = conversationHref(lastConversation);
  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu className="gap-[2px]">
          {nav.map((item) => {
            const Icon = item.icon;
            const section =
              item.sectionId &&
              sidebarSections.find(
                (candidate) => candidate.id === item.sectionId,
              );
            const active = section
              ? activeSection?.id === section.id
              : item.to === "/"
                ? pathname === "/" ||
                  pathname === "/new" ||
                  pathname.startsWith("/c/")
                : pathMatches(pathname, item.to);

            return (
              <SidebarMenuItem key={item.to}>
                <SidebarInstantTooltip label={item.label}>
                  <SidebarMenuButton
                    asChild
                    className="h-8 px-2"
                    isActive={active}
                  >
                    <Link
                      aria-current={active ? "page" : undefined}
                      onClick={() => {
                        if (section) {
                          onOpenSection();
                        }
                      }}
                      to={(item.to === "/" ? homeHref : item.to) as never}
                    >
                      <Icon />
                      <span className="min-w-0 flex-1 truncate group-data-[collapsible=icon]/sidebar:hidden">
                        {item.label}
                      </span>
                      {section ? (
                        <ChevronRight className="group-data-[collapsible=icon]/sidebar:hidden" />
                      ) : null}
                    </Link>
                  </SidebarMenuButton>
                </SidebarInstantTooltip>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function StudioBetaBadge() {
  return (
    <span
      aria-label="Release stage: beta"
      className="shrink-0 rounded-full border border-sidebar-border bg-transparent px-1.5 py-0.5 font-mono text-[9px] font-normal uppercase leading-none tracking-[0.06em] text-muted-foreground group-data-[collapsible=icon]/sidebar:hidden"
    >
      Beta
    </span>
  );
}

function SectionSidebarNav({
  onBack,
  pageTitle,
  pathname,
  section,
}: {
  onBack(): void;
  pageTitle: string;
  pathname: string;
  section: SidebarSection;
}) {
  return (
    <>
      <SidebarLevelHeader onBack={onBack} title={pageTitle} />
      {section.groups.map((group, groupIndex) => (
        <SidebarGroup key={groupIndex}>
          <SidebarGroupContent>
            <SidebarMenu>
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = itemMatches(pathname, item);

                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      asChild
                      isActive={active}
                      title={item.label}
                    >
                      <Link
                        aria-current={active ? "page" : undefined}
                        to={item.to as never}
                      >
                        <Icon />
                        <span className="min-w-0 flex-1 group-data-[collapsible=icon]/sidebar:hidden">
                          {item.label}
                        </span>
                        {item.badge ? (
                          <span className="rounded-control bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary group-data-[collapsible=icon]/sidebar:hidden">
                            {item.badge}
                          </span>
                        ) : null}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  );
}

function ContextSidebarNav({
  onBack,
  pageTitle,
  section,
}: {
  onBack(): void;
  pageTitle: string;
  section: AppShellContextSidebar;
}) {
  return (
    <>
      <SidebarLevelHeader onBack={onBack} title={pageTitle} />
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {section.items.map((item) => {
              const Icon = item.icon;
              const active = item.id === section.activeItemId;

              return (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    aria-current={active ? "page" : undefined}
                    isActive={active}
                    onClick={() => section.onItemSelect(item.id)}
                    title={item.label}
                    type="button"
                  >
                    <Icon />
                    <span className="min-w-0 flex-1 group-data-[collapsible=icon]/sidebar:hidden">
                      {item.label}
                    </span>
                    {item.badge ? (
                      <span className="rounded-control bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary group-data-[collapsible=icon]/sidebar:hidden">
                        {item.badge}
                      </span>
                    ) : null}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
}

function SidebarLevelHeader({
  onBack,
  title,
}: {
  onBack(): void;
  title: string;
}) {
  return (
    <div className="mb-1 grid w-full gap-1 group-data-[collapsible=icon]/sidebar:hidden">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            aria-label={`Back from ${title}`}
            className="grid grid-cols-[1rem_minmax(0,1fr)] text-sidebar-foreground/80"
            onClick={onBack}
            title={title}
            type="button"
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="min-w-0 truncate text-left">{title}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </div>
  );
}

function getActiveSection(pathname: string) {
  return sidebarSections.find((section) =>
    section.paths.some((path) => pathMatches(pathname, path)),
  );
}

function itemMatches(pathname: string, item: SidebarNavItem) {
  if (item.exact) {
    return pathname === item.to;
  }

  return [item.to, ...(item.matchPaths ?? [])].some((path) =>
    pathMatches(pathname, path),
  );
}

function pathMatches(pathname: string, path: string) {
  return pathname === path || pathname.startsWith(`${path}/`);
}

const routeTitles: Array<
  [RegExp, string | ((match: RegExpMatchArray) => string)]
> = [
  [/^\/?$/, "Assistant"],
  [/^\/new\/?$/, "Assistant"],
  [/^\/c\/[^/]+\/?$/, "Assistant"],
  [/^\/dashboard\/?$/, "Dashboard"],
  [/^\/login\/?$/, "Login"],
  [
    /^\/registry\/([^/]+)\/([^/]+)\/?$/,
    (match) =>
      `Registry / ${decodeURIComponent(match[1] ?? "")}/${decodeURIComponent(
        match[2] ?? "",
      )}`,
  ],
  [/^\/registry\/?$/, "Registry"],
  [/^\/credentials\/new\/?$/, "New credential"],
  [/^\/credentials\/?$/, "Credentials"],
  [
    /^\/rooms\/([^/]+)\/?$/,
    (match) => `Room / ${decodeURIComponent(match[1] ?? "")}`,
  ],
  [/^\/rooms\/?$/, "Rooms"],
  [
    /^\/orchestration\/orchestrators\/([^/]+)\/?$/,
    (match) => `Orchestrator / ${decodeURIComponent(match[1] ?? "")}`,
  ],
  [/^\/orchestration\/orchestrators\/?$/, "Orchestrators"],
  [
    /^\/orchestration\/workers\/([^/]+)\/?$/,
    (match) => `Worker / ${decodeURIComponent(match[1] ?? "")}`,
  ],
  [/^\/orchestration\/workers\/?$/, "Workers"],
  [/^\/orchestration\/?$/, "Orchestration"],
  [/^\/settings\/access\/?$/, "Access"],
  [/^\/settings\/?$/, "Settings"],
  [/^\/workflows\/new\/?$/, "New workflow"],
  [/^\/workflows\/actions\/?$/, "Workflow actions"],
  [
    /^\/workflows\/([^/]+)\/runs\/([^/]+)\/?$/,
    (match) => `Workflow run / ${match[2]}`,
  ],
  [/^\/workflows\/runs\/([^/]+)\/?$/, (match) => `Workflow run / ${match[1]}`],
  [
    /^\/workflows\/([^/]+)\/(editor|runs|overview)\/?$/,
    (match) => `Workflow / ${decodeURIComponent(match[1] ?? "")}`,
  ],
  [/^\/workflows\/([^/]+)\/?$/, "Workflow"],
  [/^\/workflows\/?$/, "Workflows"],
  [/^\/runs\/([^/]+)\/?$/, (match) => `Run / ${match[1]}`],
  [/^\/runs\/?$/, "Runs"],
  [/^\/schedules\/new\/?$/, "New schedule"],
  [/^\/schedules\/([^/]+)\/edit\/?$/, (match) => `Edit schedule / ${match[1]}`],
  [/^\/schedules\/([^/]+)\/?$/, (match) => `Schedule / ${match[1]}`],
  [/^\/schedules\/?$/, "Schedules"],
  [/^\/transfers\/new\/?$/, "New transfer"],
  [/^\/transfers\/([^/]+)\/?$/, (match) => `Transfer / ${match[1]}`],
  [/^\/transfers\/?$/, "Transfers"],
  [/^\/mcp\/connection\/?$/, "MCP connection"],
  [/^\/mcp\/capabilities\/?$/, "MCP capabilities"],
  [/^\/mcp\/activity\/?$/, "MCP activity"],
  [/^\/mcp\/tokens\/new\/?$/, "New MCP token"],
  [/^\/mcp\/tokens\/?$/, "MCP tokens"],
  [/^\/mcp\/?$/, "MCP"],
];

function getPageTitle(pathname: string) {
  for (const [pattern, title] of routeTitles) {
    const match = pathname.match(pattern);

    if (!match) {
      continue;
    }

    return typeof title === "function" ? title(match) : title;
  }

  return titleFromPath(pathname);
}

function titleFromPath(pathname: string) {
  const segment = pathname.split("/").filter(Boolean).at(-1);

  if (!segment) {
    return "Dashboard";
  }

  return segment
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
