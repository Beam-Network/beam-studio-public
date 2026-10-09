import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  Info,
  LockKeyhole,
  Save,
  Settings2,
  ShieldCheck,
  Trash2,
  Users,
  type LucideIcon,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PageSectionHeader } from "@/components/header-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { mockRoomById } from "./mock-room-data";

export function MockRoomSettingsPage({ roomId }: { roomId: string }) {
  const room = mockRoomById(roomId);
  const [name, setName] = useState(room.name);
  const [description, setDescription] = useState(room.description);
  const [visibility, setVisibility] = useState("private");
  const [memberInvites, setMemberInvites] = useState(true);
  const [saved, setSaved] = useState(false);

  function saveSettings() {
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2_000);
  }

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
          <Button asChild size="sm" variant="outline">
            <Link to={`/rooms/${room.id}` as never}>
              <ArrowLeft className="size-4" />
              Back to room
            </Link>
          </Button>
          <Button onClick={saveSettings} size="sm" type="button">
            {saved ? <Check className="size-4" /> : <Save className="size-4" />}
            {saved ? "Saved" : "Save changes"}
          </Button>
        </>
      }
      title={`${room.name} settings`}
    >
      <div className="mx-auto w-full max-w-5xl pb-12">
        <PageSectionHeader className="pt-2">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Room settings
              </p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight">
                Configure {room.name}
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                Manage room identity, access rules, and connection security.
              </p>
            </div>
            <Badge className="gap-1.5" variant="secondary">
              <span className="size-1.5 rounded-full bg-success" />
              Connected
            </Badge>
          </div>
        </PageSectionHeader>

        <div className="grid gap-6 pt-7">
          <SettingsSection
            description="The details members see when they select this room."
            icon={Settings2}
            title="General"
          >
            <div className="grid gap-5 sm:grid-cols-2">
              <Field hint="Use a short, recognizable name." label="Room name">
                <input
                  className={inputClass}
                  onChange={(event) => setName(event.target.value)}
                  value={name}
                />
              </Field>
              <Field
                hint="The connected agent hosting this room."
                label="Connected agent"
              >
                <div className="flex h-10 items-center gap-2 rounded-control border bg-muted/40 px-3 text-sm text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-success" />
                  {room.agentName}
                </div>
              </Field>
            </div>
            <Field
              hint="Optional context shown in the room selector."
              label="Description"
            >
              <textarea
                className="min-h-24 rounded-control border bg-background px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => setDescription(event.target.value)}
                value={description}
              />
            </Field>
          </SettingsSection>

          <div className="grid gap-6 lg:grid-cols-2">
            <SettingsSection
              description="Control who can discover and join this room."
              icon={Users}
              title="Access"
            >
              <Field
                hint="Private rooms are only visible to invited members."
                label="Visibility"
              >
                <select
                  className={inputClass}
                  onChange={(event) => setVisibility(event.target.value)}
                  value={visibility}
                >
                  <option value="private">Private</option>
                  <option value="organization">Organization members</option>
                  <option value="public">Anyone with an invite</option>
                </select>
              </Field>
              <ToggleRow
                checked={memberInvites}
                description="Allow room members with permission to invite others."
                label="Member invitations"
                onChange={setMemberInvites}
              />
            </SettingsSection>

            <SettingsSection
              description="Transport and encryption settings for connected clients."
              icon={ShieldCheck}
              title="Security"
            >
              <div className="flex items-start gap-3 rounded-control border bg-muted/30 p-3.5">
                <LockKeyhole className="mt-0.5 size-4 shrink-0 text-primary" />
                <div className="min-w-0">
                  <p className="text-sm font-medium">End-to-end encryption</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Enabled for all room channels. Encryption keys stay with
                    authorized members.
                  </p>
                </div>
                <Badge className="ml-auto shrink-0" variant="secondary">
                  On
                </Badge>
              </div>
              <div className="flex items-start gap-3 text-xs leading-5 text-muted-foreground">
                <Info className="mt-0.5 size-4 shrink-0" />
                <p>
                  Security changes will be applied to new connections in the
                  real flow.
                </p>
              </div>
            </SettingsSection>
          </div>

          <SettingsSection
            description="Actions here affect access to this room and cannot be undone."
            icon={Trash2}
            title="Danger zone"
            tone="danger"
          >
            <div className="flex flex-col gap-4 border border-destructive/40 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-sm font-semibold">Delete this room</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Permanently remove the room and disconnect its channels.
                </p>
              </div>
              <Button
                className="shrink-0"
                disabled
                type="button"
                variant="destructive"
              >
                <Trash2 className="size-4" />
                Delete room
              </Button>
            </div>
          </SettingsSection>
        </div>
      </div>
    </AppShell>
  );
}

function SettingsSection({
  children,
  description,
  icon: Icon,
  title,
  tone = "default",
}: {
  children: ReactNode;
  description: string;
  icon: LucideIcon;
  title: string;
  tone?: "default" | "danger";
}) {
  return (
    <section className="overflow-hidden border bg-card">
      <div className="flex items-start gap-3 border-b p-4 sm:p-5">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-control bg-primary/10 text-primary",
            tone === "danger" && "bg-destructive/10 text-destructive",
          )}
        >
          <Icon className="size-4" />
        </span>
        <div>
          <h2 className="font-medium">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="grid gap-5 p-4 sm:p-5">{children}</div>
    </section>
  );
}

function Field({
  children,
  hint,
  label,
}: {
  children: ReactNode;
  hint: string;
  label: string;
}) {
  return (
    <label className="grid gap-2 text-sm font-medium">
      {label}
      {children}
      <span className="text-xs font-normal leading-5 text-muted-foreground">
        {hint}
      </span>
    </label>
  );
}

function ToggleRow({
  checked,
  description,
  label,
  onChange,
}: {
  checked: boolean;
  description: string;
  label: string;
  onChange(value: boolean): void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-control border p-3.5">
      <input
        checked={checked}
        className="mt-1 size-4 accent-primary"
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  );
}

const inputClass =
  "h-10 rounded-control border bg-background px-3 text-sm font-normal outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring";
