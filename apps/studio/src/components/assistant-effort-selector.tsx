import { useState } from "react";
import type { AssistantReasoningEffort } from "@beam-studio/shared";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

const EFFORT_OPTIONS: Array<{
  description: string;
  label: string;
  value: AssistantReasoningEffort;
}> = [
  {
    value: "low",
    label: "Low",
    description: "Faster and more economical for simple requests.",
  },
  {
    value: "medium",
    label: "Medium",
    description: "Balanced reasoning for everyday work.",
  },
  {
    value: "high",
    label: "High",
    description: "More depth for complex tasks.",
  },
];

export function AssistantEffortSelector({
  disabled = false,
  onChange,
  side = "top",
  value,
}: {
  disabled?: boolean;
  onChange(value: AssistantReasoningEffort): void;
  side?: "bottom" | "top";
  value: AssistantReasoningEffort;
}) {
  const [open, setOpen] = useState(false);
  const selected =
    EFFORT_OPTIONS.find((option) => option.value === value) ??
    EFFORT_OPTIONS[1]!;

  return (
    <div className="relative shrink-0">
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex h-8 items-center gap-1.5 rounded-control border border-transparent bg-muted/60 px-2.5 text-xs text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        title={`Reasoning effort: ${selected.label}`}
        type="button"
      >
        <span>{selected.label}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 opacity-70" />
      </button>

      {open ? (
        <>
          <button
            aria-label="Close effort selector"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
            type="button"
          />
          <div
            className={cn(
              "absolute left-0 z-50 w-72 overflow-hidden rounded-surface border bg-popover p-1.5 text-popover-foreground shadow-xl",
              side === "top"
                ? "bottom-[calc(100%+0.5rem)]"
                : "top-[calc(100%+0.5rem)]",
            )}
            role="listbox"
          >
            <p className="px-2.5 pb-1.5 pt-1 text-xs font-medium text-muted-foreground">
              Reasoning effort
            </p>
            {EFFORT_OPTIONS.map((option) => (
              <button
                aria-selected={option.value === value}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-control px-2.5 py-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground",
                  option.value === value && "bg-accent text-accent-foreground",
                )}
                key={option.value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                role="option"
                type="button"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">
                    {option.label}
                  </span>
                  <span className="block text-xs leading-4 text-muted-foreground">
                    {option.description}
                  </span>
                </span>
                {option.value === value ? (
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                ) : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
