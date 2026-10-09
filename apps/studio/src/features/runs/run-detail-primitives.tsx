import { redactSecretsForDisplay } from "./run-detail-primitives-redaction.js";
import type { ReactNode } from "react";
import {
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Clock,
  Loader2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  normalizeStatus,
  statusLabel,
  statusTone,
  type StatusTone,
} from "./run-detail-data";

const toneStyles: Record<
  StatusTone,
  { icon: LucideIcon; color: string; badge: string; spin?: boolean }
> = {
  success: {
    icon: CheckCircle2,
    color: "text-success",
    badge: "border-success/30 bg-success/10 text-success",
  },
  danger: {
    icon: XCircle,
    color: "text-destructive",
    badge: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  active: {
    icon: Loader2,
    color: "text-warning",
    badge: "border-warning/30 bg-warning/10 text-warning",
    spin: true,
  },
  pending: {
    icon: Clock,
    color: "text-warning",
    badge: "border-warning/30 bg-warning/10 text-warning",
  },
  neutral: {
    icon: CircleDashed,
    color: "text-muted-foreground",
    badge: "bg-secondary text-secondary-foreground",
  },
};

export function StatusIcon({
  className,
  status,
}: {
  className?: string;
  status: unknown;
}) {
  const normalized = normalizeStatus(status);
  const tone = statusTone(status);
  const style = toneStyles[tone];
  const Icon = normalized === "cancelled" ? CircleSlash : style.icon;

  return (
    <Icon
      aria-hidden
      className={cn(
        "h-4 w-4 shrink-0",
        style.color,
        style.spin && "animate-spin",
        className,
      )}
    />
  );
}

export function StatusBadge({
  className,
  status,
  withIcon,
}: {
  className?: string;
  status: unknown;
  withIcon?: boolean;
}) {
  const tone = statusTone(status);

  return (
    <Badge
      className={cn("gap-1.5", toneStyles[tone].badge, className)}
      variant="outline"
    >
      {withIcon ? <StatusIcon className="h-3.5 w-3.5" status={status} /> : null}
      {statusLabel(status)}
    </Badge>
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

export function Fact({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="grid gap-1 border-b pb-3 last:border-b-0 last:pb-0">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="min-w-0 break-words text-sm">{value}</div>
    </div>
  );
}

/** Console-style JSON output, mirroring the log panes of a CI run. */
export function JsonPanel({
  className,
  title,
  value,
}: {
  className?: string;
  title?: string;
  value: unknown;
}) {
  return (
    <div className="grid gap-1">
      {title ? (
        <div className="text-xs font-medium text-muted-foreground">{title}</div>
      ) : null}
      <pre
        className={cn(
          "max-h-72 overflow-auto rounded-control border bg-muted/60 p-3 font-mono text-xs leading-relaxed",
          className,
        )}
      >
        {JSON.stringify(redactSecretsForDisplay(value) ?? {}, null, 2)}
      </pre>
    </div>
  );
}

export function isEmptyValue(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return true;
  }
  if (Array.isArray(value)) {
    return !value.length;
  }
  if (typeof value === "object") {
    return !Object.keys(value as Record<string, unknown>).length;
  }
  return false;
}
