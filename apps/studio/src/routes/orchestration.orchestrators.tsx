import {
  Outlet,
  createFileRoute,
  useLocation,
} from "@tanstack/react-router";
import { OrchestratorsPage } from "./orchestration";

export const Route: any = createFileRoute("/orchestration/orchestrators")({
  component: OrchestratorsRoute,
});

function OrchestratorsRoute() {
  const location = useLocation();
  if (location.pathname !== "/orchestration/orchestrators") {
    return <Outlet />;
  }

  return <OrchestratorsPage />;
}
