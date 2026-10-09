import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CopyButton({
  value,
  label = "Copy response",
}: {
  value: string;
  label?: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Button
      aria-label={status === "copied" ? "Copied" : label}
      className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
      size="sm"
      type="button"
      variant="ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setStatus("copied");
        } catch {
          setStatus("error");
        }
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setStatus("idle"), 2500);
      }}
    >
      {status === "copied" ? (
        <Check aria-hidden="true" className="size-3.5" />
      ) : (
        <Copy aria-hidden="true" className="size-3.5" />
      )}
      <span role="status">
        {status === "copied"
          ? "Copied"
          : status === "error"
            ? "Could not copy"
            : "Copy"}
      </span>
    </Button>
  );
}
