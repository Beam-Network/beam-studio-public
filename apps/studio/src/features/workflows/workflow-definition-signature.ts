/** Layout has its own save queue; it is not a semantic definition edit. */
export function workflowDefinitionSignature(payload: unknown) {
  const graph = payload as Record<string, unknown>;
  return JSON.stringify({
    ...graph,
    ...Object.fromEntries(
      ["steps", "triggers", "decisions"].map((key) => [
        key,
        Array.isArray(graph[key])
          ? graph[key].map((node: Record<string, unknown>) => ({
              ...node,
              canvasX: undefined,
              canvasY: undefined,
            }))
          : graph[key],
      ]),
    ),
    controls: Array.isArray(graph.controls)
      ? graph.controls.map((control: Record<string, unknown>) => ({
          ...control,
          layout: undefined,
        }))
      : graph.controls,
  });
}
