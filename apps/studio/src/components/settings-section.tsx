import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export function SettingsSection({
  children,
  description,
  icon: Icon,
  title,
}: {
  children: ReactNode;
  description?: string;
  icon: LucideIcon;
  title: string;
}) {
  return (
    <section className="grid gap-4 border-b py-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-8">
      <div className="flex items-start gap-2.5">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {description && (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}
