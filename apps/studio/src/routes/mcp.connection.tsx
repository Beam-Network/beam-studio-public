import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";

export const Route: any = createFileRoute("/mcp/connection")({
  component: () => (
    <AppShell contentClassName="px-3 py-4">
      <div className="grid gap-3">
        <div className="rounded-surface border bg-card p-6">
          <pre className="text-sm">
            {JSON.stringify({ endpoint: "/mcp" }, null, 2)}
          </pre>
        </div>
      </div>
    </AppShell>
  ),
});
