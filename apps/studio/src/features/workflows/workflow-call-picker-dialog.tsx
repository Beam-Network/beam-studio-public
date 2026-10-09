import { useState } from "react";
import { Search, Workflow } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { filterSidebarWorkflows } from "@/lib/sidebar-workflow-search";
import type { WorkflowSourceSummary } from "./workflow-graph-types";

export function WorkflowCallPickerDialog({
  open,
  onOpenChange,
  workflows,
  onSelect,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  workflows: WorkflowSourceSummary[];
  onSelect(workflow: WorkflowSourceSummary): void;
}) {
  const [search, setSearch] = useState("");
  const filtered = filterSidebarWorkflows({ workflows, query: search });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add child workflow</DialogTitle>
          <DialogDescription>
            Choose a saved workflow, then configure its inputs and use its
            public output.
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 rounded-control border px-3 py-2">
          <Search className="size-4 text-muted-foreground" />
          <input
            autoFocus
            aria-label="Search saved workflows"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            placeholder="Search workflows…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="max-h-80 overflow-y-auto">
          {filtered.map((workflow) => (
            <button
              key={workflow.id}
              type="button"
              className="flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                onOpenChange(false);
                onSelect(workflow);
              }}
            >
              <Workflow className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {workflow.name}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {workflow.id}
                </span>
              </span>
            </button>
          ))}
          {!filtered.length && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {workflows.length
                ? "No matching workflows."
                : "Create another workflow first to add a child call."}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
