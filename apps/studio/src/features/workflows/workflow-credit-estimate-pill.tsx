import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Coins, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format-bytes";
import { formatCreditAmount, formatCredits } from "@/lib/format-credits";
import {
  creditShortfall,
  creditShortfallMessage,
  type WorkflowCreditEstimate,
} from "./workflow-credit-estimate";

export type WorkflowCreditEstimateState = {
  estimate: WorkflowCreditEstimate | null;
  pending: boolean;
  /** Why no estimate can be shown; null while one can. */
  unavailable: string | null;
};

/**
 * What this workflow will cost, next to the button that spends it.
 *
 * The pill only ever shows a number the price book produced. When a price
 * cannot be fetched it says so and why: a plausible-looking total that nobody
 * is charged is worse than admitting the estimate is missing, because the
 * operator would budget against it.
 */
export function WorkflowCreditEstimatePill({
  estimate,
  pending,
  unavailable,
}: WorkflowCreditEstimateState) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;

    function closeOnOutsideClick(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    window.addEventListener("mousedown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const shortfall =
    estimate && !pending && !unavailable ? creditShortfall(estimate) : null;
  const shortfallMessage = shortfall ? creditShortfallMessage(shortfall) : null;
  const label = unavailable
    ? "Estimate unavailable"
    : !estimate || pending
      ? "Estimating…"
      : `${estimate.atLeast ? "≥" : "~"} ${formatCredits(estimate.total)}${
          shortfall
            ? ` · ${formatCreditAmount(shortfall.available)} available`
            : ""
        }`;

  return (
    <div className="relative hidden sm:block" ref={containerRef}>
      <button
        aria-description={shortfallMessage ?? undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={cn(
          "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-control border px-2.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
          shortfall
            ? "border-warning/30 bg-warning/10 text-warning"
            : unavailable
              ? "text-muted-foreground"
              : "text-foreground",
        )}
        onClick={() => setOpen((value) => !value)}
        title={shortfallMessage ?? undefined}
        type="button"
      >
        {shortfall ? (
          <AlertTriangle aria-hidden="true" className="size-3.5" />
        ) : (
          <Coins aria-hidden="true" className="size-3.5 text-muted-foreground" />
        )}
        {label}
        <Info aria-hidden="true" className="size-3.5 text-muted-foreground" />
      </button>

      {open ? (
        <div
          aria-label="Estimated credits"
          className="absolute right-0 top-[calc(100%+0.5rem)] z-50 w-80 rounded-surface border bg-popover p-3 text-popover-foreground shadow-xl"
          role="dialog"
        >
          <p className="mb-2 text-sm font-medium">Estimated credits</p>

          {unavailable ? (
            <p className="text-[13px] text-muted-foreground">{unavailable}</p>
          ) : !estimate ? (
            <p className="text-[13px] text-muted-foreground">
              Pricing this workflow…
            </p>
          ) : (
            <>
              {shortfallMessage ? (
                <p
                  className="mb-3 flex gap-2 rounded-control border border-warning/30 bg-warning/10 p-2 text-[13px] text-warning"
                  role="alert"
                >
                  <AlertTriangle
                    aria-hidden="true"
                    className="mt-0.5 size-3.5 shrink-0"
                  />
                  {shortfallMessage}
                </p>
              ) : null}
              <EstimateBreakdown estimate={estimate} />
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function EstimateBreakdown({ estimate }: { estimate: WorkflowCreditEstimate }) {
  return (
    <>
      <dl className="grid gap-1 text-[13px]">
        <div className="flex items-baseline justify-between gap-3 font-medium">
          <dt>Total</dt>
          <dd>
            {estimate.atLeast ? "≥" : "~"} {formatCredits(estimate.total)}
          </dd>
        </div>

        {estimate.lines.map((line, index) => (
          <div
            className="flex items-baseline justify-between gap-3 text-muted-foreground"
            key={line.stepId ?? `${line.kind}-${index}`}
          >
            <dt className="truncate">{line.label}</dt>
            <dd className="flex shrink-0 items-baseline gap-3">
              {line.volumeUnknown ? (
                <span>volume measured after the run</span>
              ) : line.bytes ? (
                <span>
                  {line.partial ? "≥ " : ""}
                  {formatBytes(Number(line.bytes))}
                </span>
              ) : null}
              <span className="tabular-nums text-foreground">
                {line.volumeUnknown || line.partial ? "≥" : ""}{" "}
                {formatCreditAmount(line.credits)}
              </span>
            </dd>
          </div>
        ))}
      </dl>

      <p className="mt-3 border-t pt-2 text-[12px] leading-relaxed text-muted-foreground">
        {estimate.atLeast
          ? "Some volume is not known yet, so this is the least this run can cost. Transfers are billed on the bytes they actually deliver."
          : "Final credit usage may vary slightly: transfers are billed on the bytes they actually deliver."}
      </p>
    </>
  );
}
