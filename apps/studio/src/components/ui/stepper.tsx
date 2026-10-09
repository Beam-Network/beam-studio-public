import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export type StepperStep<Id extends string> = {
  id: Id;
  label: string;
  hint?: string;
  /** Steps the user cannot reach yet render dimmed and are not clickable. */
  enabled?: boolean;
};

/**
 * Segmented step bar shared by every multi-step flow in Studio. Pass
 * `onStepChange` to let the user jump back to an earlier step.
 */
export function Stepper<Id extends string>({
  className,
  current,
  steps,
  orientation = "horizontal",
  onStepChange,
}: {
  className?: string;
  current: Id;
  steps: ReadonlyArray<StepperStep<NoInfer<Id>>>;
  orientation?: "horizontal" | "vertical";
  onStepChange?(id: NoInfer<Id>): void;
}) {
  const activeIndex = steps.findIndex((step) => step.id === current);

  return (
    <ol
      className={cn(
        "grid overflow-hidden rounded-control border bg-card text-sm",
        orientation === "vertical" &&
          "gap-1 rounded-none border-0 bg-transparent",
        className,
      )}
      style={{
        gridTemplateColumns:
          orientation === "vertical"
            ? "minmax(0, 1fr)"
            : `repeat(${steps.length}, minmax(0, 1fr))`,
      }}
    >
      {steps.map((step, index) => {
        const active = index === activeIndex;
        const complete = index < activeIndex;
        const enabled = step.enabled ?? true;
        const interactive = Boolean(onStepChange) && enabled && !active;

        return (
          <li
            className={
              orientation === "horizontal"
                ? "border-r last:border-r-0"
                : undefined
            }
            key={step.id}
          >
            <StepBody
              vertical={orientation === "vertical"}
              active={active}
              complete={complete}
              enabled={enabled}
              index={index}
              interactive={interactive}
              step={step}
              onSelect={interactive ? () => onStepChange?.(step.id) : undefined}
            />
          </li>
        );
      })}
    </ol>
  );
}

function StepBody<Id extends string>({
  active,
  complete,
  enabled,
  index,
  interactive,
  step,
  onSelect,
  vertical,
}: {
  active: boolean;
  complete: boolean;
  enabled: boolean;
  index: number;
  interactive: boolean;
  step: StepperStep<Id>;
  onSelect?(): void;
  vertical: boolean;
}) {
  const className = cn(
    "flex h-full w-full items-center gap-3 px-4 py-3 text-left transition-colors",
    vertical && "border-l-2 border-transparent",
    vertical && active && "border-l-primary",
    active ? "bg-primary/10 text-foreground" : "text-muted-foreground",
    interactive && "hover:bg-muted",
    !enabled && "opacity-60",
  );
  const content = (
    <>
      <span
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-full border text-xs font-medium tabular-nums",
          active || complete
            ? "border-primary bg-primary text-primary-foreground"
            : "bg-background",
        )}
      >
        {complete ? <Check size={13} /> : index + 1}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-medium">{step.label}</span>
        {step.hint ? (
          <span className="block truncate text-xs text-muted-foreground">
            {step.hint}
          </span>
        ) : null}
      </span>
    </>
  );

  if (!interactive) {
    return (
      <div aria-current={active ? "step" : undefined} className={className}>
        {content}
      </div>
    );
  }

  return (
    <button
      aria-current={active ? "step" : undefined}
      className={className}
      onClick={onSelect}
      type="button"
    >
      {content}
    </button>
  );
}
