import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

export function AgentCopyButton({
  value,
  label = "agent ID",
}: {
  value: string;
  label?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  useEffect(() => setState("idle"), [value]);
  useEffect(() => {
    if (state !== "copied") return;
    const timeout = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(timeout);
  }, [state]);
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <Button
        size="icon"
        variant="ghost"
        className={state === "error" ? "size-7 text-destructive" : "size-7"}
        type="button"
        aria-label={`Copy ${label}`}
        title={
          state === "error"
            ? "Clipboard access blocked. Select and copy manually."
            : `Copy ${label}`
        }
        onClick={async (event) => {
          event.stopPropagation();
          event.preventDefault();
          try {
            await navigator.clipboard.writeText(value);
            setState("copied");
          } catch {
            setState("error");
          }
        }}
      >
        {state === "copied" ? (
          <Check className="size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </Button>
      <span className="sr-only" role="status">
        {state === "error"
          ? "Select and copy manually"
          : state === "copied"
            ? `${label} copied`
            : ""}
      </span>
    </span>
  );
}
