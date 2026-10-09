import { createLinearTemplateGraph } from "./workflow-graph-operations";
import { toSavePayload } from "./workflow-graph-model";
import type { ActionPackage } from "./workflow-graph-types";

export type BuiltinWorkflowTemplate = {
  id: string;
  name: string;
  description: string;
  actionNames: string[];
};

export const builtinWorkflowTemplates: BuiltinWorkflowTemplate[] = [
  {
    id: "transfer-webhook",
    name: "Transfer, webhook",
    description: "Run a transfer, then notify a webhook.",
    actionNames: ["@beam/transfer", "@beam/webhook"],
  },
];

export function findBuiltinWorkflowTemplate(templateId: string) {
  return (
    builtinWorkflowTemplates.find((template) => template.id === templateId) ??
    null
  );
}

export function buildBuiltinTemplatePayload(
  templateId: string,
  actions: ActionPackage[],
) {
  const template = findBuiltinWorkflowTemplate(templateId);
  if (!template) {
    return null;
  }
  const graph = createLinearTemplateGraph(actions, template.actionNames);
  return toSavePayload(graph.nodes, graph.edges);
}
