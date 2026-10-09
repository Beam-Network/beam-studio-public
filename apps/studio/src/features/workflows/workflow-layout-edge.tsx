import { BaseEdge, SmoothStepEdge, type EdgeProps } from "@xyflow/react";
import { workflowRoutePath, type LayoutPoint } from "./workflow-layout-routing";

export function WorkflowLayoutEdge(props: EdgeProps) {
  const route = props.data?.layoutRoute as LayoutPoint[] | undefined;
  const path =
    route &&
    workflowRoutePath(
      route,
      { x: props.sourceX, y: props.sourceY },
      { x: props.targetX, y: props.targetY },
    );
  if (!path) return <SmoothStepEdge {...props} />;
  return (
    <BaseEdge
      id={props.id}
      path={path}
      style={props.style}
      markerStart={props.markerStart}
      markerEnd={props.markerEnd}
      interactionWidth={props.interactionWidth}
    />
  );
}
