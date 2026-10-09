import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

export function DescriptionGrid({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid gap-3 text-sm">
      {items.map(([term, value]) => (
        <div
          className="grid gap-1 border-b pb-3 last:border-b-0 last:pb-0"
          key={term}
        >
          <dt className="text-xs font-medium uppercase text-muted-foreground">
            {term}
          </dt>
          <dd className="min-w-0">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function JsonInline({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-control bg-muted p-3 text-xs">
      {JSON.stringify(value ?? {}, null, 2)}
    </pre>
  );
}

export function EmptyState({ body, title }: { body: string; title: string }) {
  return (
    <div className="grid place-items-center rounded-control border border-dashed p-8 text-center">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

export function DateText({ value }: { value?: string | null }) {
  if (!value) {
    return <span className="text-muted-foreground">-</span>;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return <span>{value}</span>;
  }
  return <time dateTime={value}>{date.toLocaleString()}</time>;
}

export function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const variant =
    normalized === "completed" ||
    normalized === "enabled" ||
    normalized === "active"
      ? "default"
      : normalized === "failed" ||
          normalized === "cancelled" ||
          normalized === "disabled"
        ? "outline"
        : "secondary";
  return <Badge variant={variant}>{status}</Badge>;
}

export function KeyboardHint({ children }: { children: ReactNode }) {
  return (
    <kbd className="ml-1 rounded-control-compact border bg-background/70 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-muted-foreground">
      {children}
    </kbd>
  );
}
