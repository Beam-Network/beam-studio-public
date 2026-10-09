type NamedEntry = { id: string; name?: string | null };
function normalize(value: string) {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}
export function filterSidebarWorkflows<Workflow extends NamedEntry>({
  workflows,
  query,
}: {
  workflows: Workflow[];
  query: string;
}) {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  return workflows.filter((workflow) => {
    const text = normalize(`${workflow.name ?? ""} ${workflow.id}`);
    return terms.every((term) => text.includes(term));
  });
}
