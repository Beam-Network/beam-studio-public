import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api-client";
import { FieldRow, TextInput } from "./workflow-form-controls";

/**
 * The Zapier action's tool field.
 *
 * A Zapier tool name is an opaque slug that only the user's own MCP server
 * knows, so a plain text box asks them to remember something they have no way
 * of looking up here. The names come from the credential, and the input stays
 * free text rather than becoming a select: a server that cannot be reached
 * right now must not block editing a workflow, and a tool added on Zapier's
 * side after this list was fetched should still be typeable.
 */
export function ZapierToolField({
  credentialId,
  label,
  value,
  onChange,
}: {
  credentialId: string;
  label: string;
  value: string;
  onChange(value: string): void;
}) {
  const listId = `zapier-tools-${credentialId || "none"}`;
  const query = useQuery({
    queryKey: ["zapier-tools", credentialId],
    enabled: Boolean(credentialId),
    // The MCP round trip is not free and the tool set rarely changes mid-edit.
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () =>
      apiGet<{ tools: Array<{ name: string; description: string }> }>(
        `/studio/credentials/${encodeURIComponent(credentialId)}/zapier/tools`,
      ),
  });

  const tools = query.data?.tools ?? [];
  const selected = tools.find((tool) => tool.name === value);

  return (
    <FieldRow
      label={label}
      hint={hint({ credentialId, query, tools, selected })}
    >
      <TextInput
        list={listId}
        placeholder="slack_send_channel_message"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={listId}>
        {tools.map((tool) => (
          <option key={tool.name} value={tool.name}>
            {tool.description}
          </option>
        ))}
      </datalist>
    </FieldRow>
  );
}

function hint({
  credentialId,
  query,
  tools,
  selected,
}: {
  credentialId: string;
  query: { isPending: boolean; isError: boolean };
  tools: Array<{ name: string }>;
  selected?: { description: string };
}) {
  if (!credentialId) {
    return "Choose a Zapier credential to list the actions it exposes.";
  }
  if (query.isPending) {
    return "Loading the actions on this Zapier MCP server…";
  }
  if (query.isError) {
    return "Could not reach this Zapier MCP server. Type the action name to continue.";
  }
  if (selected?.description) {
    return selected.description;
  }
  if (!tools.length) {
    return "This Zapier MCP server exposes no actions yet. Add some at mcp.zapier.com.";
  }
  return `${tools.length} action${tools.length === 1 ? "" : "s"} available. Start typing to filter.`;
}
