export const studioEnv = {
  apiUrl: import.meta.env.VITE_STUDIO_API_URL ?? "http://localhost:8787",
  // Room Workflows (distributed workflow-graph/v3) ship in a later release.
  roomWorkflowsEnabled: import.meta.env.VITE_STUDIO_ROOM_WORKFLOWS === "true",
  // Tunnels are not offered yet: only Rooms are supported. Build with
  // VITE_STUDIO_TUNNELS=true to show the tunnel and destination UI again.
  tunnelsEnabled: import.meta.env.VITE_STUDIO_TUNNELS === "true",
};
