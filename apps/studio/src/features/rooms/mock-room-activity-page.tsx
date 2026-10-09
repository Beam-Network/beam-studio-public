import { Activity, RadioTower } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PageSectionHeader } from "@/components/header-primitives";
import { Badge } from "@/components/ui/badge";
import { mockRoomActivity } from "./mock-room-activity-data";
import { mockRoomById } from "./mock-room-data";

export function MockRoomActivityPage({ roomId }: { roomId: string }) {
  const room = mockRoomById(roomId);

  return (
    <AppShell
      contentClassName="min-h-full"
      headerActions={
        <Badge
          className="hidden border-amber-500/30 bg-amber-500/10 text-warning sm:inline-flex dark:text-amber-400"
          variant="outline"
        >
          Mock data
        </Badge>
      }
      title={`${room.name} activity`}
    >
      <div className="mx-auto w-full max-w-5xl pb-12">
        <PageSectionHeader className="flex flex-wrap items-end justify-between gap-4 pt-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Room activity
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">
              Activity
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Recent events and connection changes recorded for {room.name}.
            </p>
          </div>
          <Badge className="gap-1.5" variant="secondary">
            <span className="size-1.5 rounded-full bg-success" />
            Live
          </Badge>
        </PageSectionHeader>

        <section className="mt-7 overflow-hidden border bg-card">
          <div className="flex items-center gap-3 border-b p-4 sm:p-5">
            <span className="grid size-9 place-items-center rounded-control bg-primary/10 text-primary">
              <Activity className="size-4" />
            </span>
            <div>
              <h2 className="font-medium">Room timeline</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Events from channels, members, and room policy.
              </p>
            </div>
          </div>
          <div className="divide-y">
            {mockRoomActivity.map((event) => (
              <div
                className="grid gap-3 p-4 sm:grid-cols-[24px_1fr_auto] sm:items-start sm:px-5"
                key={event.id}
              >
                <span
                  className={`mt-1.5 size-2 rounded-full bg-muted-foreground/50 ${
                    event.tone === "active"
                      ? "bg-primary shadow-[0_0_0_4px_hsl(var(--primary)/0.12)]"
                      : ""
                  }`}
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{event.label}</p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {event.meta}
                  </p>
                </div>
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <RadioTower className="size-3.5" />
                  Room event
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
