import {
  Outlet,
  createFileRoute,
  useLocation,
} from "@tanstack/react-router";
import { WorkersPage } from "./orchestration";

export const Route: any = createFileRoute("/orchestration/workers")({
  component: WorkersRoute,
});

function WorkersRoute() {
  const location = useLocation();
  if (location.pathname !== "/orchestration/workers") {
    return <Outlet />;
  }

  return <WorkersPage />;
}
