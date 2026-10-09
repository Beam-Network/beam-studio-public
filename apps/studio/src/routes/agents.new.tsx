import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { AgentEnrollmentFlow } from "./agents";

export const Route: any = createFileRoute("/agents/new")({
  component: NewAgentPage,
});

function NewAgentPage() {
  const navigate = useNavigate();

  return (
    <AppShell
      contentClassName="min-h-full p-0 xl:h-full xl:overflow-hidden"
      title="Connect an agent"
    >
      <AgentEnrollmentFlow onCancel={() => void navigate({ to: "/agents" })} />
    </AppShell>
  );
}
