import { ArrowUpRight, RadioTower, ShieldCheck, Users } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { PageSectionHeader } from "@/components/header-primitives";
import { Badge } from "@/components/ui/badge";
import { mockRooms } from "./mock-room-data";

export function MockRoomsPage() {
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
      title="Rooms"
    >
      <div className="mx-auto w-full max-w-6xl pb-12">
        <PageSectionHeader className="flex flex-wrap items-end justify-between gap-4 pt-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Beam rooms
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">Rooms</h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Shared spaces for connected agents, channels, and participants.
            </p>
          </div>
          <p className="text-sm text-muted-foreground">
            {mockRooms.length} connected rooms
          </p>
        </PageSectionHeader>

        <div className="grid gap-4 pt-7 md:grid-cols-2 xl:grid-cols-3">
          {mockRooms.map((room) => (
            <Link
              className="group flex min-h-64 flex-col overflow-hidden border bg-card transition-colors hover:border-foreground/25 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              key={room.id}
              to={`/rooms/${room.id}` as never}
            >
              <div className="flex items-start justify-between gap-4 border-b p-5">
                <span className="grid size-10 place-items-center rounded-control bg-primary/10 text-primary">
                  <RadioTower className="size-5" />
                </span>
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-success" />
                  Connected
                </span>
              </div>
              <div className="flex flex-1 flex-col p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate font-mono text-base font-semibold">
                      {room.name}
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      {room.description}
                    </p>
                  </div>
                  <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-foreground" />
                </div>

                <dl className="mt-auto grid grid-cols-2 gap-3 border-t pt-5 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">Agent</dt>
                    <dd className="mt-1 flex min-w-0 items-center gap-1.5 truncate font-mono text-xs">
                      <RadioTower className="size-3 text-primary" />
                      {room.agentName}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Members</dt>
                    <dd className="mt-1 flex items-center gap-1.5 font-mono text-xs">
                      <Users className="size-3 text-primary" />
                      {room.participantCount}
                    </dd>
                  </div>
                </dl>
              </div>
              <div className="flex items-center gap-2 border-t px-5 py-3 text-xs text-muted-foreground">
                <ShieldCheck className="size-3.5 text-primary" />
                End-to-end encrypted
              </div>
            </Link>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
