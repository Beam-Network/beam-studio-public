import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { BudgetAlertBar } from "@/features/billing/budget-alert-bar";
import { DashboardPage } from "@/features/dashboard/dashboard-overview";

export const Route: any = createFileRoute("/dashboard")({
  component: () => (
    <AppShell
      contentClassName="h-full max-w-none px-3 py-3"
      showCreateAction
    >
      {/* The shell header breadcrumb already names this page; the heading stays
          in the document outline without repeating itself on screen. */}
      <h1 className="sr-only">Dashboard</h1>
      <BudgetAlertBar className="mb-3" />
      <DashboardPage />
    </AppShell>
  ),
});
