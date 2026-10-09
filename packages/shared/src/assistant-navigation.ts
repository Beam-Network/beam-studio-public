// Studio route shapes used to validate assistant links. A Studio contract test
// compares these against the generated router, so changes cannot silently drift.
export const STUDIO_ASSISTANT_ROUTE_PATTERNS = [
  "/",
  "/agents",
  "/auth",
  "/credentials",
  "/dashboard",
  "/dead-letter",
  "/login",
  "/mcp",
  "/new",
  "/orchestration",
  "/queue",
  "/registry",
  "/rooms",
  "/runs",
  "/schedules",
  "/settings",
  "/settings/access",
  "/transfers",
  "/workflows",
  "/agents/$id",
  "/agents/new",
  "/credentials/new",
  "/c/$id",
  "/mcp/activity",
  "/mcp/capabilities",
  "/mcp/connection",
  "/mcp/tokens",
  "/orchestration/orchestrators",
  "/orchestration/workers",
  "/rooms/$id",
  "/runs/$id",
  "/schedules/$id",
  "/schedules/new",
  "/transfers/$id",
  "/transfers/new",
  "/workflows/$id",
  "/workflows/new",
  "/agents/$id/activity",
  "/agents/$id/destinations",
  "/agents/$id/logs",
  "/agents/$id/overview",
  "/agents/$id/rooms",
  "/agents/$id/settings",
  "/agents/$id/tunnels",
  "/mcp/tokens/new",
  "/orchestration/orchestrators/$id",
  "/orchestration/workers/$id",
  "/registry/$scope/$name",
  "/rooms/$id/activity",
  "/rooms/$id/channels",
  "/rooms/$id/members",
  "/rooms/$id/settings",
  "/rooms/$id/transfers",
  "/schedules/$id/edit",
  "/workflows/$id/editor",
  "/workflows/$id/overview",
  "/workflows/$id/runs",
  "/workflows/$id/settings",
  "/workflows/runs/$id",
  "/rooms/$id/channels/$channelId",
  "/workflows/$id/runs/$runId",
  "/rooms/$id/channels/$channelId/details",
] as const;

export const STUDIO_ASSISTANT_NAVIGATION = [
  { label: "Home", href: "/" },
  { label: "Dashboard", href: "/dashboard" },
  { label: "Workflows", href: "/workflows" },
  { label: "Runs", href: "/runs" },
  { label: "Schedules", href: "/schedules" },
  { label: "Registry", href: "/registry" },
  { label: "Credentials", href: "/credentials" },
  { label: "Agents", href: "/agents" },
  { label: "Rooms", href: "/rooms" },
  { label: "Orchestration", href: "/orchestration" },
  { label: "MCP", href: "/mcp" },
  { label: "Settings", href: "/settings" },
] as const;

export function isStudioAssistantHref(href: string) {
  if (!href.startsWith("/") || href.startsWith("//") || href.includes("\\"))
    return false;
  const path = href.split(/[?#]/, 1)[0]!.replace(/\/$/, "") || "/";
  const segments = path.split("/");
  try {
    if (
      segments.some((segment) =>
        [".", ".."].includes(decodeURIComponent(segment)),
      )
    )
      return false;
  } catch {
    return false;
  }
  return STUDIO_ASSISTANT_ROUTE_PATTERNS.some((pattern) => {
    const expected = pattern.split("/");
    return (
      expected.length === segments.length &&
      expected.every((segment, index) =>
        segment.startsWith("$")
          ? Boolean(segments[index])
          : segment === segments[index],
      )
    );
  });
}

export function assistantContextHrefs(...sources: unknown[]): Set<string> {
  const hrefs = new Set<string>();
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (
        key === "href" &&
        typeof item === "string" &&
        isStudioAssistantHref(item)
      )
        hrefs.add(item);
      else if (item && typeof item === "object") visit(item);
    }
  }
  sources.forEach(visit);
  return hrefs;
}
