export type MockRoom = {
  agentName: string;
  description: string;
  id: string;
  name: string;
  participantCount: number;
};

export const mockRooms: MockRoom[] = [
  {
    agentName: "edge-paris-01",
    description: "Production tunnels",
    id: "production-eu",
    name: "production-eu",
    participantCount: 4,
  },
  {
    agentName: "edge-new-york-02",
    description: "Staging services",
    id: "staging-us",
    name: "staging-us",
    participantCount: 3,
  },
  {
    agentName: "mbp-jo",
    description: "Local development",
    id: "local-lab",
    name: "local-lab",
    participantCount: 2,
  },
];

export const defaultMockRoom = mockRooms[0]!;

export function mockRoomById(roomId: string | null | undefined) {
  return mockRooms.find((room) => room.id === roomId) ?? defaultMockRoom;
}
