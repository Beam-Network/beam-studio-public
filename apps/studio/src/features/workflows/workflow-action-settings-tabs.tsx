import { useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const tabs = [
  ["configuration", "Configuration"],
  ["inputs", "Inputs"],
  ["settings", "Settings"],
] as const;
type Tab = (typeof tabs)[number][0];

// Only recognize messages emitted by workflow-graph-validation. Unknown issues
// remain in the shared summary rather than being assigned to a guessed tab.
export function actionIssueTab(issue: string): Tab | undefined {
  if (issue === "Beam transfer requires a Beam credential.") {
    return "configuration";
  }
  if (
    /^Binding expression \$\{.+\} is not supported\.$/.test(issue) ||
    /^Binding references missing (decision|step) .+\.$/.test(issue) ||
    /^Binding from .+ is missing a graph edge\.$/.test(issue) ||
    [
      "Beam transfer requires source endpoints.",
      "Beam transfer requires destination endpoints.",
      "Download requires an endpoint binding.",
      "Upload requires an endpoint binding.",
      "Upload requires a content binding.",
    ].includes(issue)
  ) {
    return "inputs";
  }
}

export function ActionSettingsTabs({
  name,
  configuration,
  inputs,
  settings,
  issues,
}: {
  name: ReactNode;
  configuration: ReactNode;
  inputs: ReactNode;
  settings: ReactNode;
  issues: string[];
}) {
  const [active, setActive] = useState<Tab>("configuration");
  const id = useId();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const panels = { configuration, inputs, settings };

  return (
    <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="shrink-0 px-5 py-4">{name}</div>
      <div
        aria-label="Action settings"
        className="flex shrink-0 gap-1 border-b px-3 sm:px-5"
        role="tablist"
      >
        {tabs.map(([tab, label], index) => {
          const count = issues.filter(
            (issue) => actionIssueTab(issue) === tab,
          ).length;
          return (
            <button
              aria-controls={`${id}-${tab}-panel`}
              aria-selected={active === tab}
              className={cn(
                "flex min-w-0 flex-1 items-center justify-center gap-1 border-b-2 px-1 py-3 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:flex-none sm:px-3 sm:text-sm",
                active === tab
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              id={`${id}-${tab}-tab`}
              key={tab}
              onClick={() => setActive(tab)}
              onKeyDown={(event) => {
                let next: number;
                switch (event.key) {
                  case "ArrowRight":
                    next = (index + 1) % tabs.length;
                    break;
                  case "ArrowLeft":
                    next = (index + tabs.length - 1) % tabs.length;
                    break;
                  case "Home":
                    next = 0;
                    break;
                  case "End":
                    next = tabs.length - 1;
                    break;
                  default:
                    return;
                }
                event.preventDefault();
                const nextTab = tabs[next];
                if (!nextTab) return;
                setActive(nextTab[0]);
                buttons.current[next]?.focus();
              }}
              ref={(element) => {
                buttons.current[index] = element;
              }}
              role="tab"
              tabIndex={active === tab ? 0 : -1}
              type="button"
            >
              {label}
              {count > 0 ? (
                <span className="text-xs text-destructive">
                  <span aria-hidden="true">({count})</span>
                  <span className="sr-only">{count} validation issues</span>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {/* Keep every panel mounted: JSON and mention editors own local drafts. */}
      {tabs.map(([tab]) => (
        <div
          aria-labelledby={`${id}-${tab}-tab`}
          className={cn(
            "min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain break-words p-5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            active !== tab && "hidden",
          )}
          hidden={active !== tab}
          id={`${id}-${tab}-panel`}
          key={tab}
          role="tabpanel"
          tabIndex={0}
        >
          {panels[tab]}
        </div>
      ))}
      {issues.length > 0 ? (
        <div
          className="shrink-0 border-t bg-destructive/5 px-5 py-3 text-xs text-destructive"
          aria-live="polite"
        >
          <p className="font-medium">
            {issues.length} validation{" "}
            {issues.length === 1 ? "issue" : "issues"}
          </p>
          <ul
            aria-label="Validation issues"
            className="mt-1 max-h-20 list-disc space-y-1 overflow-y-auto break-words pl-4"
            tabIndex={0}
          >
            {issues.map((issue, index) => (
              <li key={`${index}-${issue}`}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
