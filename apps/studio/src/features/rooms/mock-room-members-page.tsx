import { useState } from "react";
import { UserPlus, Users } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PageSectionHeader } from "@/components/header-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { mockParticipants } from "./mock-room-activity-data";
import { mockRoomById } from "./mock-room-data";

export function MockRoomMembersPage({ roomId }: { roomId: string }) {
  const room = mockRoomById(roomId);
  const [inviteVisible, setInviteVisible] = useState(false);
  const onlineCount = mockParticipants.filter(
    (participant) => participant.status !== "offline",
  ).length;

  return (
    <AppShell
      contentClassName="min-h-full"
      headerActions={
        <>
          <Badge
            className="hidden border-amber-500/30 bg-amber-500/10 text-warning sm:inline-flex dark:text-amber-400"
            variant="outline"
          >
            Mock data
          </Badge>
          <Button
            onClick={() => setInviteVisible((visible) => !visible)}
            size="sm"
            type="button"
          >
            <UserPlus className="size-4" />
            Invite member
          </Button>
        </>
      }
      title={`${room.name} members`}
    >
      <div className="mx-auto w-full max-w-5xl pb-12">
        <PageSectionHeader className="flex flex-wrap items-end justify-between gap-4 pt-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Room members
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">
              Members
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              People and agents currently authorized to access {room.name}.
            </p>
          </div>
          <Badge className="gap-1.5" variant="secondary">
            <Users className="size-3.5" />
            {mockParticipants.length} members
          </Badge>
        </PageSectionHeader>

        {inviteVisible ? (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
            <div>
              <p className="font-medium">Mock invitation ready</p>
              <p className="mt-1 text-muted-foreground">
                The real flow will generate a scoped invitation for this room.
              </p>
            </div>
            <Button
              onClick={() => setInviteVisible(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Dismiss
            </Button>
          </div>
        ) : null}

        <div className="grid gap-6 pt-7 lg:grid-cols-[minmax(0,1fr)_280px]">
          <section className="overflow-hidden border bg-card">
            <div className="border-b p-4 sm:p-5">
              <h2 className="font-medium">Room access</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Membership status reported by the connected agent.
              </p>
            </div>
            <div className="divide-y">
              {mockParticipants.map((participant) => (
                <div
                  className="flex flex-wrap items-center gap-3 p-4 sm:px-5"
                  key={participant.id}
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                    {initials(participant.name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{participant.name}</p>
                      <Badge variant="outline">{participant.role}</Badge>
                    </div>
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      {participant.machine}
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        participant.status === "online" && "bg-success",
                        participant.status === "away" && "bg-warning",
                        participant.status === "offline" && "bg-muted-foreground/50",
                      )}
                    />
                    {participant.status}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <aside className="h-fit border bg-card p-4 sm:p-5">
            <h2 className="font-medium">Membership summary</h2>
            <dl className="mt-5 grid gap-4 text-sm">
              <Summary label="Total members" value={String(mockParticipants.length)} />
              <Summary label="Online or away" value={String(onlineCount)} />
              <Summary label="Room owner" value="Morgan" />
              <Summary label="Access" value="Private" />
            </dl>
          </aside>
        </div>
      </div>
    </AppShell>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-medium">{value}</dd>
    </div>
  );
}

function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
