import { useState, type ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronRight,
  Copy,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatBytes } from "@/lib/format-bytes";
import { cn } from "@/lib/utils";
import { text, type RoomSnapshot } from "./room-data";
import type { RoomTransfer, RoomTransferDelivery } from "./room-transfer-data";

const gridColumns = 64;

export function RoomTransferItem({
  channelName,
  defaultOpen = false,
  footer,
  room,
  transfer,
}: {
  channelName: string;
  defaultOpen?: boolean;
  footer?: ReactNode;
  room: RoomSnapshot;
  transfer: RoomTransfer;
}) {
  const isPublisher = transfer.role === "publisher";
  const total = transfer.deliveries.length;
  const delivered = transfer.deliveries.filter((delivery) =>
    isDeliveredState(delivery.state),
  ).length;
  const DirectionIcon = isPublisher ? ArrowUpFromLine : ArrowDownToLine;

  return (
    <details
      className="group overflow-hidden rounded-surface border bg-card transition-colors hover:border-primary/30 open:border-primary/30 open:shadow-sm"
      open={defaultOpen}
    >
      <summary className="flex min-h-16 cursor-pointer list-none items-center gap-4 px-4 py-3 text-sm outline-none transition-colors hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
        <span
          aria-hidden
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-control",
            isPublisher
              ? "bg-primary/10 text-primary"
              : "bg-sky-500/10 text-sky-600",
          )}
        >
          <DirectionIcon className="size-4" />
        </span>

        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium" title={transfer.filename}>
            {transfer.filename}
          </h3>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">{channelName}</span>
            <Dot />
            <span className="shrink-0">{sizeLabel(transfer.sizeBytes)}</span>
            {transfer.updatedAt ? (
              <>
                <Dot />
                <span
                  className="shrink-0"
                  title={formatDate(transfer.updatedAt)}
                >
                  {formatRelative(transfer.updatedAt)}
                </span>
              </>
            ) : null}
          </p>
        </div>

        <div className="hidden w-40 shrink-0 sm:block">
          {isPublisher && total ? (
            <TransferProgress
              delivered={delivered}
              state={transfer.state}
              total={total}
            />
          ) : (
            <span className="text-xs text-muted-foreground">
              {isPublisher ? "No destination" : "Received"}
            </span>
          )}
        </div>

        <RoomTransferStatus state={transfer.state} />

        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
      </summary>

      <div className="grid gap-5 border-t bg-muted/20 p-4">
        <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <TransferMeta
            label="Direction"
            value={isPublisher ? "Sent" : "Received"}
          />
          <TransferMeta label="Size" value={sizeLabel(transfer.sizeBytes)} />
          <TransferMeta label="Channel" value={channelName} />
          <TransferMeta
            label="Chunks"
            value={transfer.chunkCount ? String(transfer.chunkCount) : "—"}
          />
          <TransferMeta
            label="Created"
            value={formatDate(transfer.createdAt)}
          />
          <TransferMeta
            label="Updated"
            value={formatDate(transfer.updatedAt)}
          />
          <TransferMeta
            label="Expires"
            value={formatDate(transfer.expiresAt)}
          />
          <TransferMeta
            label="Transfer ID"
            value={transfer.id}
            action={<CopyButton value={transfer.id} />}
            mono
          />
        </dl>

        <RoomTransferDeliveries
          chunkCount={transfer.chunkCount}
          deliveries={transfer.deliveries}
          room={room}
        />

        {footer}
      </div>
    </details>
  );
}

export function RoomTransferStatus({ state }: { state: string }) {
  return (
    <Badge
      className={cn(
        "w-fit shrink-0 gap-1.5 whitespace-nowrap",
        (state === "completed" || state === "delivered") &&
          "border-success/40 bg-success/10 text-success",
        state === "in_progress" &&
          "border-amber-500/40 bg-amber-500/10 text-warning",
        state === "pending" && "border-sky-500/40 bg-sky-500/10 text-sky-600",
        state === "partial" &&
          "border-amber-500/40 bg-amber-500/10 text-warning",
        (state === "failed" || state === "unavailable") &&
          "border-destructive/40 bg-destructive/10 text-destructive",
      )}
      variant="outline"
    >
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full", deliveryTone(state, true))}
      />
      {formatState(state)}
    </Badge>
  );
}

function TransferProgress({
  delivered,
  state,
  total,
}: {
  delivered: number;
  state: string;
  total: number;
}) {
  const percent = total ? Math.round((delivered / total) * 100) : 0;
  const failed = state === "failed" || state === "partial";

  return (
    <div className="grid gap-1.5">
      <div
        aria-label={`${delivered} of ${total} destinations delivered`}
        aria-valuemax={total}
        aria-valuemin={0}
        aria-valuenow={delivered}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            failed ? "bg-warning" : "bg-success",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">
        {delivered}/{total} delivered
      </span>
    </div>
  );
}

function RoomTransferDeliveries({
  chunkCount,
  deliveries,
  room,
}: {
  chunkCount: number;
  deliveries: RoomTransferDelivery[];
  room: RoomSnapshot;
}) {
  if (!deliveries.length) {
    return (
      <p className="rounded-control border border-dashed p-3 text-xs text-muted-foreground">
        No destination has been recorded for this transfer yet.
      </p>
    );
  }

  const columns = Math.min(gridColumns, Math.max(1, deliveries.length));

  return (
    <section className="grid gap-3 rounded-surface border bg-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Users className="size-3.5" />
          Destinations ({deliveries.length})
        </h4>
        {deliveries.length > columns ? (
          <span className="text-xs text-muted-foreground">
            {columns} per row
          </span>
        ) : null}
      </header>

      <div className="-m-1 overflow-x-auto p-1">
        <Tooltip.Provider
          delayDuration={0}
          disableHoverableContent
          skipDelayDuration={0}
        >
          <div
            aria-label={`${deliveries.length} transfer agent${
              deliveries.length === 1 ? "" : "s"
            }`}
            className="grid justify-start gap-[3px]"
            role="list"
            style={{
              gridTemplateColumns: `repeat(${columns}, minmax(9px, 14px))`,
            }}
          >
            {deliveries.map((delivery, index) => (
              <DeliverySquare
                chunkCount={chunkCount}
                delivery={delivery}
                key={delivery.memberId || `delivery-${index}`}
                room={room}
              />
            ))}
          </div>
        </Tooltip.Provider>
      </div>

      <footer className="flex flex-wrap items-center justify-end gap-3">
        {deliveryStateCounts(deliveries).map(([state, count]) => (
          <span
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            key={state}
          >
            <span
              aria-hidden
              className={cn(
                "size-2.5 rounded-badge border",
                deliveryTone(state),
              )}
            />
            {count} {formatState(state)}
          </span>
        ))}
      </footer>
    </section>
  );
}

function DeliverySquare({
  chunkCount,
  delivery,
  room,
}: {
  chunkCount: number;
  delivery: RoomTransferDelivery;
  room: RoomSnapshot;
}) {
  const membership = deliveryMembership(delivery, room);
  const agentId = delivery.agentId ?? text(membership?.agent_id);
  const label = deliveryLabel(delivery, room);
  const chunks = deliveryChunkProgress(delivery, chunkCount);
  const accessibleLabel = [
    agentId ? `Agent ${agentId}` : label,
    formatState(delivery.state),
    chunks?.summary,
    delivery.unavailableReason,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <span
          aria-label={accessibleLabel}
          className={cn(
            "relative aspect-square rounded-badge border transition-transform hover:z-10 hover:scale-125 focus-visible:z-10 focus-visible:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
            deliveryTone(delivery.state),
          )}
          role="listitem"
          tabIndex={0}
        />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          className="z-[100] w-max max-w-[min(320px,calc(100vw-32px))] rounded-control border bg-popover px-3 py-2 text-popover-foreground shadow-md"
          collisionPadding={12}
          sideOffset={8}
        >
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <DeliveryTooltipRow
              label="Agent ID"
              mono
              value={agentId ?? "Unavailable"}
            />
            {delivery.memberId && delivery.memberId !== agentId ? (
              <DeliveryTooltipRow
                label="Member ID"
                mono
                value={delivery.memberId}
              />
            ) : null}
            <DeliveryTooltipRow
              label="Status"
              value={formatState(delivery.state)}
            />
            {chunks ? (
              <DeliveryTooltipRow label="Chunks" value={chunks.summary} />
            ) : null}
            {delivery.updatedAt ? (
              <DeliveryTooltipRow
                label="Updated"
                value={formatDate(delivery.updatedAt)}
              />
            ) : null}
            {delivery.unavailableReason ? (
              <DeliveryTooltipRow
                label="Reason"
                value={delivery.unavailableReason}
              />
            ) : null}
          </dl>
          <Tooltip.Arrow className="fill-border" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function DeliveryTooltipRow({
  label,
  mono,
  value,
}: {
  label: string;
  mono?: boolean;
  value: string;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 break-all font-medium", mono && "font-mono")}>
        {value}
      </dd>
    </>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      aria-label="Copy transfer ID"
      className="shrink-0 rounded-control p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      title={copied ? "Copied" : "Copy transfer ID"}
      type="button"
    >
      {copied ? (
        <Check className="size-3.5 text-success" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </button>
  );
}

function Dot() {
  return (
    <span aria-hidden className="shrink-0 text-muted-foreground/50">
      ·
    </span>
  );
}

function deliveryStateCounts(deliveries: RoomTransferDelivery[]) {
  const counts = new Map<string, number>();
  for (const delivery of deliveries) {
    counts.set(delivery.state, (counts.get(delivery.state) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}

function deliveryLabel(delivery: RoomTransferDelivery, room: RoomSnapshot) {
  const membership = deliveryMembership(delivery, room);
  return (
    text(membership?.principal_id) ??
    delivery.agentId ??
    text(membership?.agent_id) ??
    delivery.memberId
  );
}

function deliveryMembership(
  delivery: RoomTransferDelivery,
  room: RoomSnapshot,
) {
  return room.memberships.find(
    (value) => text(value.member_id) === delivery.memberId,
  );
}

function deliveryChunkProgress(
  delivery: RoomTransferDelivery,
  chunkCount: number,
) {
  let completed = delivery.completedChunks;
  if (completed === null && delivery.coverageBase64 && chunkCount > 0) {
    completed = coveredChunkCount(delivery.coverageBase64, chunkCount);
  }
  if (
    completed === null &&
    isDeliveredState(delivery.state) &&
    chunkCount > 0
  ) {
    completed = chunkCount;
  }
  if (completed !== null && chunkCount > 0) {
    const boundedCompleted = Math.min(Math.max(completed, 0), chunkCount);
    const pending = chunkCount - boundedCompleted;
    const percent = Math.round((boundedCompleted / chunkCount) * 100);
    return {
      summary: `${boundedCompleted}/${chunkCount} completed · ${pending} pending · ${percent}%`,
    };
  }
  if (completed !== null) {
    return { summary: `${Math.max(completed, 0)} completed` };
  }
  return chunkCount > 0 ? { summary: `${chunkCount} total` } : null;
}

function coveredChunkCount(coverageBase64: string, chunkCount: number) {
  try {
    const bytes = Uint8Array.from(atob(coverageBase64), (value) =>
      value.charCodeAt(0),
    );
    let completed = 0;
    for (let chunk = 0; chunk < chunkCount; chunk += 1) {
      if ((bytes[chunk >> 3] ?? 0) & (1 << (chunk & 7))) completed += 1;
    }
    return completed;
  } catch {
    return null;
  }
}

function isDeliveredState(state: string) {
  return state === "delivered" || state === "completed";
}

function deliveryTone(state: string | undefined, solid = false) {
  switch (state) {
    case "completed":
    case "delivered":
      return solid ? "bg-success" : "border-success/30 bg-success";
    case "in_progress":
      return solid ? "bg-warning" : "border-amber-500/30 bg-warning";
    case "partial":
      return solid ? "bg-warning" : "border-amber-500/30 bg-warning";
    case "pending":
      return solid ? "bg-sky-500" : "border-sky-600/30 bg-sky-500";
    case "cancelled":
    case "expired":
    case "failed":
    case "unavailable":
      return solid ? "bg-destructive" : "border-destructive/30 bg-destructive";
    default:
      return solid ? "bg-muted-foreground/40" : "border-border/60 bg-muted";
  }
}

function TransferMeta({
  action,
  label,
  mono,
  value,
}: {
  action?: ReactNode;
  label: string;
  mono?: boolean;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 flex min-w-0 items-center gap-1">
        <span
          className={cn("truncate font-medium", mono && "font-mono text-xs")}
          title={value}
        >
          {value}
        </span>
        {action}
      </dd>
    </div>
  );
}

function formatState(state: string) {
  return state.replaceAll("_", " ");
}

/** A room transfer reports 0 until its size is known. */
function sizeLabel(value: number) {
  return (value ? formatBytes(value) : null) ?? "—";
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatRelative(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3600],
    ["minute", 60],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, {
    numeric: "auto",
  });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return formatter.format(Math.round(seconds / size), unit);
    }
  }
  return formatter.format(seconds, "second");
}
