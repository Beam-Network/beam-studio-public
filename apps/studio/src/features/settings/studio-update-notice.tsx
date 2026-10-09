import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import * as Toast from "@radix-ui/react-toast";
import { ArrowUpCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiGet } from "@/lib/api-client";
import {
  updateNoticeVersion,
  type StudioUpdateCheckPayload,
} from "./studio-update-state";

const dismissedKey = "beam-studio.update-notice.dismissed";

/**
 * App-wide notice when a newer Beam Studio release is published on this
 * installation's channel. It only points to Settings; installing still needs
 * the explicit confirmation there. Closing it hides that release for good.
 */
export function StudioUpdateNotice() {
  const onSettings = useRouterState({
    select: (state) => state.location.pathname === "/settings",
  });
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  useEffect(() => {
    setDismissedVersion(readDismissed());
  }, []);

  // Shares its cache with the Settings panel. Errors (updates disabled,
  // updater unreachable) are reported there, never here.
  const check = useQuery({
    queryKey: ["/studio/updates/check"],
    queryFn: () => apiGet<StudioUpdateCheckPayload>("/studio/updates/check"),
    retry: false,
    staleTime: 60_000,
    refetchInterval: 30 * 60_000,
  });

  const version = updateNoticeVersion(check.data, dismissedVersion);
  if (!version || onSettings) return null;

  const dismiss = () => {
    setDismissedVersion(version);
    try {
      localStorage.setItem(dismissedKey, version);
    } catch {
      // Storage unavailable: the notice stays closed for this page load only.
    }
  };

  return (
    <Toast.Provider duration={Infinity} swipeDirection="right">
      <Toast.Root
        className="pointer-events-auto flex items-start gap-3 rounded-surface border bg-popover p-4 text-popover-foreground shadow-lg"
        onOpenChange={(open) => {
          if (!open) dismiss();
        }}
        open
        type="background"
      >
        <ArrowUpCircle
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-brand"
        />
        <div className="min-w-0 flex-1">
          <Toast.Title className="text-sm font-medium">
            Beam Studio {version} is available
          </Toast.Title>
          <Toast.Description className="mt-1 text-xs leading-5 text-muted-foreground">
            New release on the {check.data?.channel} channel
            {check.data?.installedVersion
              ? `; this Studio runs ${check.data.installedVersion}`
              : ""}
            .
            {check.data?.mode === "notify-only"
              ? " Ask the host operator to install it."
              : ""}
          </Toast.Description>
          {/* A plain link, not Toast.Action: opening Settings must not count
              as dismissing the release. */}
          <Button asChild className="mt-3" size="sm" variant="outline">
            <Link to="/settings">
              {check.data?.mode === "managed" ? "View update" : "Details"}
            </Link>
          </Button>
        </div>
        <Toast.Close asChild>
          <Button
            aria-label="Dismiss update notification"
            className="-mr-1 -mt-1 size-7 shrink-0"
            size="icon"
            variant="ghost"
          >
            <X aria-hidden="true" className="size-3.5" />
          </Button>
        </Toast.Close>
      </Toast.Root>
      <Toast.Viewport
        aria-label="Studio update"
        className="pointer-events-none fixed bottom-5 right-5 z-[90] flex w-[calc(100vw-2.5rem)] max-w-sm list-none flex-col gap-2 outline-none"
      />
    </Toast.Provider>
  );
}

function readDismissed() {
  try {
    return localStorage.getItem(dismissedKey);
  } catch {
    return null;
  }
}
