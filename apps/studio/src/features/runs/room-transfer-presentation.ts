type Row = Record<string, unknown>;
function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

export function roomSourcePresentation(value: unknown) {
  const source = record(value);
  const locator = record(source.locator);
  return {
    memberId: source.member_id ?? source.memberId ?? "-",
    kind: source.kind ?? (locator.type === "agent_path" ? "agent" : locator.type === "bucket_object" ? "object_storage" : undefined),
  };
}

// The display may use refreshed, publication-bound evidence. It never rewrites
// the action result or infers protection from room membership or source type.
export function roomRecipientPresentation(state: Row, recipient: Row, child: Row) {
  const destination = record(recipient.safe_destination ?? child.target);
  const execution = record(state.execution);
  const targets = Array.isArray(execution.targets) ? execution.targets.map(record) : [];
  const encryptedTarget = typeof state.publicationId === "string" &&
    state.publicationId.length > 0 && execution.publication_id === state.publicationId &&
    execution.schema_version === "room-transfer/v1" &&
    execution.protection === "btr.object.chunk.aead.v1" &&
    typeof recipient.member_id === "string" &&
    targets.some((target) => target.member_id === recipient.member_id);
  const kind = recipient.recipient_kind ?? destination.kind;
  const protection = recipient.protection ?? child.protection;
  return {
    destination,
    kind: kind ?? (encryptedTarget ? "agent" : undefined),
    protection: protection ?? (encryptedTarget && (kind === undefined || kind === "agent") ? "room_mls_e2ee" : undefined),
  };
}

export function roomMemberKindLabel(value: unknown) {
  if (value === "object_storage") return "Object-storage bucket";
  if (value === "agent") return "Agent";
  return "Unknown";
}
