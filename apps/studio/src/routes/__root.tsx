import { useEffect, type ReactNode } from "react";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { StudioUpdateNotice } from "@/features/settings/studio-update-notice";
import { ApiError } from "@/lib/api-errors";
import { apiGet } from "@/lib/api-client";
import {
  INSTANCE_ACCESS_PATH,
  INSTANCE_UNCLAIMED_EVENT,
  STUDIO_API_UNREACHABLE,
} from "@/lib/api-errors";
import { cryptoCompatibilityScript } from "@/lib/crypto-compat";
import {
  requiresStudioSession,
  studioAuthRedirectPath,
} from "@/lib/auth-redirect";
import "@xyflow/react/dist/style.css";
import "../styles.css";

type RouterContext = {
  queryClient: QueryClient;
};

type SessionPayload = {
  session?: { userId?: string } | null;
};

const themeInitScript = `
(() => {
  try {
    const theme = localStorage.getItem("beam-studio.theme") === "light" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", theme === "dark");
  } catch {
    document.documentElement.classList.add("dark");
  }
})();
`;

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      {
        title: "Beam Studio",
      },
      {
        name: "description",
        content:
          "Build, run, and monitor data transfer workflows and automations with Beam Studio.",
      },
    ],
    links: [
      {
        rel: "icon",
        type: "image/svg+xml",
        href: "/beam-logo-black.svg",
      },
      {
        rel: "icon",
        type: "image/svg+xml",
        href: "/beam-logo-white.svg",
        media: "(prefers-color-scheme: dark)",
      },
    ],
  }),
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <RootDocument>
      <QueryClientProvider client={queryClient}>
        <StudioSessionBoundary>
          <Outlet />
        </StudioSessionBoundary>
      </QueryClientProvider>
    </RootDocument>
  );
}

function StudioSessionBoundary({
  children,
}: Readonly<{ children: ReactNode }>) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const sessionRequired = requiresStudioSession(pathname);
  const sessionQuery = useQuery({
    queryKey: ["/studio/session"],
    queryFn: () => apiGet<SessionPayload>("/studio/session"),
    enabled: sessionRequired,
    retry: false,
    refetchOnMount: "always",
  });
  const authenticated = Boolean(sessionQuery.data?.session?.userId);
  const navigate = useNavigate();

  // An installation nobody has claimed refuses every workspace call. Rather
  // than let each page report its failed request, open the claim step.
  useEffect(() => {
    const openClaimStep = () => {
      if (window.location.pathname === INSTANCE_ACCESS_PATH) return;
      void navigate({ to: INSTANCE_ACCESS_PATH, replace: true });
    };
    window.addEventListener(INSTANCE_UNCLAIMED_EVENT, openClaimStep);
    return () =>
      window.removeEventListener(INSTANCE_UNCLAIMED_EVENT, openClaimStep);
  }, [navigate]);

  useEffect(() => {
    if (!sessionRequired || sessionQuery.status !== "success" || authenticated) {
      return;
    }
    window.location.replace(
      studioAuthRedirectPath(
        window.location.pathname,
        window.location.search,
        window.location.hash,
      ),
    );
  }, [authenticated, sessionQuery.status, sessionRequired]);

  if (!sessionRequired) {
    return children;
  }

  if (authenticated) {
    return (
      <>
        {children}
        <StudioUpdateNotice />
      </>
    );
  }

  if (sessionQuery.isError) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
        <section className="max-w-md text-center">
          <h1 className="text-xl font-semibold">Unable to verify your session</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {sessionQuery.error instanceof ApiError &&
            sessionQuery.error.code === STUDIO_API_UNREACHABLE
              ? sessionQuery.error.message
              : "Studio could not reach the authentication service."}
          </p>
          <button
            className="mt-5 inline-flex h-10 items-center rounded-control bg-primary px-4 text-sm font-medium text-primary-foreground"
            onClick={() => window.location.reload()}
            type="button"
          >
            Retry
          </button>
        </section>
      </main>
    );
  }

  return (
    <main
      aria-label="Checking Studio session"
      className="grid min-h-screen place-items-center bg-background text-foreground"
    >
      <span className="size-8 animate-spin rounded-full border-2 border-muted border-t-foreground" />
    </main>
  );
}

function NotFoundComponent() {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
      <section className="max-w-md text-center">
        <p className="text-sm font-medium text-muted-foreground">404</p>
        <h1 className="mt-2 text-2xl font-semibold">Page not found</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          The page you requested does not exist or may have moved.
        </p>
        <a
          className="mt-6 inline-flex h-10 items-center rounded-control bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          href="/"
        >
          Return to Studio
        </a>
      </section>
    </main>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          id="studio-crypto-compat"
          dangerouslySetInnerHTML={{ __html: cryptoCompatibilityScript }}
        />
        <script
          id="studio-theme-init"
          dangerouslySetInnerHTML={{ __html: themeInitScript }}
        />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
