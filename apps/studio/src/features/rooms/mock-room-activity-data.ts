export type MockParticipant = {
  id: string;
  name: string;
  machine: string;
  role: "Member" | "Owner";
  status: "away" | "offline" | "online";
};

export type MockRoomActivity = {
  id: string;
  label: string;
  meta: string;
  tone: "active" | "neutral";
};

export const mockParticipants: MockParticipant[] = [
  {
    id: "p-1",
    machine: "mbp-morgan",
    name: "Morgan",
    role: "Owner",
    status: "online",
  },
  {
    id: "p-2",
    machine: "edge-paris-01",
    name: "Paris edge",
    role: "Member",
    status: "online",
  },
  {
    id: "p-3",
    machine: "worker-ci-04",
    name: "CI worker",
    role: "Member",
    status: "away",
  },
  {
    id: "p-4",
    machine: "alice-laptop",
    name: "Alice",
    role: "Member",
    status: "offline",
  },
];

export const mockRoomActivity: MockRoomActivity[] = [
  {
    id: "event-1",
    label: "New HTTP session opened",
    meta: "edge-paris-01 · 12 seconds ago",
    tone: "active",
  },
  {
    id: "event-2",
    label: "Morgan joined the room",
    meta: "mbp-morgan · 4 minutes ago",
    tone: "neutral",
  },
  {
    id: "event-3",
    label: "Channel policy updated",
    meta: "api-gateway · 18 minutes ago",
    tone: "neutral",
  },
];
