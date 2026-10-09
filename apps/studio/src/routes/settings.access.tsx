import { Outlet, createFileRoute, useLocation } from "@tanstack/react-router";
import { InstanceAccessPage } from "@/features/settings/instance-access-page";

export const Route: any = createFileRoute("/settings/access")({
  component: SettingsAccessRoute,
});

function SettingsAccessRoute() {
  const location = useLocation();
  if (location.pathname !== "/settings/access") {
    return <Outlet />;
  }

  return <InstanceAccessPage />;
}
