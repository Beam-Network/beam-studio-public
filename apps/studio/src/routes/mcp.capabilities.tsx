import { MCP_SCOPE_DEFINITIONS } from "@beam-studio/shared";
import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";

export const Route: any = createFileRoute("/mcp/capabilities")({
  component: () => (
    <AppShell contentClassName="px-3 py-4">
      <div className="grid gap-3">
        <div className="rounded-surface border bg-card p-6 text-sm">
          <dl className="grid gap-2">
            {MCP_SCOPE_DEFINITIONS.map((scope) => (
              <div key={scope.id} className="grid gap-0.5">
                <dt>
                  <code>{scope.id}</code>
                </dt>
                <dd className="text-muted-foreground">{scope.description}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </AppShell>
  ),
});
