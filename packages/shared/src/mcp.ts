export const MCP_SCOPE_DEFINITIONS = [
  {
    id: "read:runs",
    label: "Read runs",
    description: "Read run status, recent runs, and Beam transfer status.",
  },
  {
    id: "read:transfers",
    label: "Read transfers",
    description: "Read transfer templates exposed as MCP resources.",
  },
  {
    id: "read:credentials",
    label: "Read credentials",
    description: "List provider credentials with safe payload previews.",
  },
  {
    id: "read:api_keys",
    label: "Read API keys",
    description: "List Beam API key metadata without exposing secrets.",
  },
  {
    id: "write:transfers",
    label: "Write transfers",
    description: "Create transfer templates.",
  },
  {
    id: "run:transfers",
    label: "Run transfers",
    description: "Queue transfer templates for immediate execution.",
  },
  {
    id: "write:schedules",
    label: "Write schedules",
    description: "Create recurring transfer schedules.",
  },
  {
    id: "cancel:runs",
    label: "Cancel runs",
    description: "Cancel queued runs or request cancellation for running runs.",
  },
  // The scopes below were added when these tokens stopped being MCP-only and
  // became the credential for machine callers across the HTTP API. The names
  // keep saying "mcp" because the token prefix and the table do, and renaming
  // those would invalidate every issued token.
  {
    id: "read:workflows",
    label: "Read workflows",
    description: "Read workflow definitions, graphs and layouts.",
  },
  {
    id: "write:workflows",
    label: "Write workflows",
    description: "Create, edit and delete workflows and their graphs.",
  },
  {
    id: "run:workflows",
    label: "Run workflows",
    description: "Launch, retry and cancel workflow runs.",
  },
  {
    id: "read:schedules",
    label: "Read schedules",
    description: "Read recurring transfer and workflow schedules.",
  },
  {
    id: "write:credentials",
    label: "Write credentials",
    description: "Create, edit and delete provider credentials.",
  },
  {
    id: "read:rooms",
    label: "Read rooms",
    description: "Read rooms, their members and their storage bindings.",
  },
  {
    id: "write:rooms",
    label: "Write rooms",
    description: "Create rooms and change their storage members.",
  },
  {
    id: "read:agents",
    label: "Read agents",
    description: "Read enrolled agents, their commands and their events.",
  },
  {
    id: "read:registry",
    label: "Read registry",
    description: "Read the action registry and installed action packages.",
  },
  {
    id: "read:settings",
    label: "Read settings",
    description: "Read Studio settings and Beam environment templates.",
  },
  {
    id: "read:dashboard",
    label: "Read dashboard",
    description: "Read dashboard, queue, worker and reporting views.",
  },
] as const;

export type McpScope = (typeof MCP_SCOPE_DEFINITIONS)[number]["id"];

export const MCP_SCOPE_IDS = MCP_SCOPE_DEFINITIONS.map((scope) => scope.id);

export const MCP_SCOPE_PRESETS = [
  {
    id: "read-only",
    label: "Read-only",
    description: "Observe runs, transfer templates, credentials, and API keys.",
    scopes: [
      "read:runs",
      "read:transfers",
      "read:credentials",
      "read:api_keys",
    ],
  },
  {
    id: "operator",
    label: "Operator",
    description: "Observe and run existing transfers.",
    scopes: [
      "read:runs",
      "read:transfers",
      "read:credentials",
      "read:api_keys",
      "run:transfers",
      "cancel:runs",
    ],
  },
  {
    id: "admin",
    label: "Admin",
    description: "Full MCP access for transfer operations.",
    scopes: MCP_SCOPE_IDS,
  },
] as const;

export const MCP_ADMIN_SCOPES = [...MCP_SCOPE_IDS] as McpScope[];

export const MCP_TOOL_SCOPE_REQUIREMENTS: Record<string, McpScope[]> = {
  "beam.list_rooms": ["read:transfers"],
  "beam.list_room_storage_members": ["read:transfers"],
  "beam.attach_room_storage_member": ["write:transfers"],
  "beam.update_room_storage_member": ["write:transfers"],
  "beam.remove_room_storage_member": ["write:transfers"],
  "beam.create_room_workflow": ["write:transfers"],
  "beam.create_workflow": ["write:transfers"],
  "beam.get_workflow": ["read:transfers"],
  "beam.update_workflow_graph": ["write:transfers"],
  "beam.run_workflow": ["run:transfers"],
  "beam.retry_workflow_run": ["run:transfers"],
  "beam.get_workflow_run": ["read:runs"],
  "beam.cancel_workflow_run": ["cancel:runs"],
  "beam.list_api_keys": ["read:api_keys"],
  "beam.list_credentials": ["read:credentials"],
  "beam.create_transfer": ["write:transfers"],
  "beam.run_transfer_now": ["run:transfers"],
  "beam.schedule_transfer": ["write:schedules"],
  "beam.cancel_run": ["cancel:runs"],
  "beam.get_run_status": ["read:runs"],
  "beam.get_transfer_status": ["read:runs"],
  "beam.list_recent_runs": ["read:runs"],
};

export const MCP_RESOURCE_SCOPE_REQUIREMENTS: Record<string, McpScope[]> = {
  "beam://recent-runs": ["read:runs"],
  "beam://transfer-templates": ["read:transfers"],
};

export function isMcpScope(value: string): value is McpScope {
  return (MCP_SCOPE_IDS as string[]).includes(value);
}

/**
 * Rejects unrecognised scope names instead of dropping them. Silently filtering
 * turns a misspelled scope into a different grant than the caller asked for.
 */
export function assertMcpScopes(value: readonly string[]): McpScope[] {
  const unknown = value.filter((scope) => !isMcpScope(scope));
  if (unknown.length) {
    throw new Error(`Unknown MCP scope: ${[...new Set(unknown)].join(", ")}.`);
  }
  const scopes = [...new Set(value as readonly McpScope[])];
  if (!scopes.length) {
    throw new Error("Select at least one MCP scope.");
  }
  return scopes;
}

export function parseMcpScopes(value: string | null | undefined): McpScope[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "null");
    return Array.isArray(parsed)
      ? [
          ...new Set(
            parsed.filter(
              (scope): scope is McpScope =>
                typeof scope === "string" && isMcpScope(scope),
            ),
          ),
        ]
      : [];
  } catch {
    return [];
  }
}

export function mcpScopesJson(scopes: readonly McpScope[]) {
  return JSON.stringify(assertMcpScopes([...scopes]));
}
