import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function PageSectionHeader({
  className,
  ...props
}: ComponentProps<"header">) {
  return (
    <header
      className={cn("border-b pb-4", className)}
      data-header="page-section"
      {...props}
    />
  );
}

export function PanelHeader({ className, ...props }: ComponentProps<"header">) {
  return (
    <header
      className={cn(
        "flex min-h-14 shrink-0 items-center border-b px-3 py-2",
        className,
      )}
      data-header="panel"
      {...props}
    />
  );
}
