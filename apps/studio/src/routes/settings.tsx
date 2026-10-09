import { Outlet, createFileRoute, useLocation } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { SettingsPage } from "@/components/data-page";

export const Route: any = createFileRoute("/settings")({
  component: SettingsRoute,
});

function SettingsRoute() {
  const location = useLocation();
  if (location.pathname !== "/settings") {
    return <Outlet />;
  }

  return (
    <AppShell contentClassName="px-3 py-4">
      <SettingsPage />
    </AppShell>
  );
}
