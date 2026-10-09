import { Cable, Hand, MousePointer2, type LucideIcon } from "lucide-react";
import type { GraphControlMode } from "./workflow-graph-types";

export const BEAM_TRANSFER_ACTION = "@beam/transfer";
export const DOWNLOAD_ACTION = "@beam/download";
export const FAN_OUT_ACTION = "@beam/fan-out";
export const JOIN_ACTION = "@beam/join";
export const OBJECT_STORAGE_ENDPOINT_ACTION = "@beam/object-storage-endpoint";
export const UPLOAD_ACTION = "@beam/upload";
export const ZAPIER_ACTION = "@beam/zapier";

export const WORKFLOW_INPUT_HANDLE = "workflow-in";
export const WORKFLOW_OUTPUT_HANDLE = "workflow-out";
export const WORKFLOW_GRID_SIZE = 24;
export const WORKFLOW_SNAP_GRID: [number, number] = [
  WORKFLOW_GRID_SIZE,
  WORKFLOW_GRID_SIZE,
];
export const BEAM_TRANSFER_SOURCE_HANDLE = "source-endpoints";
export const BEAM_TRANSFER_DESTINATION_HANDLE = "destination-endpoints";

export function isControlFlowAction(actionPackageName: string) {
  return (
    actionPackageName === FAN_OUT_ACTION || actionPackageName === JOIN_ACTION
  );
}

export const graphControlModes: Array<{
  icon: LucideIcon;
  id: GraphControlMode;
  label: string;
  shortcut: string;
}> = [
  { id: "select", label: "Select", icon: MousePointer2, shortcut: "s" },
  { id: "pan", label: "Pan", icon: Hand, shortcut: "p" },
  { id: "connect", label: "Connect", icon: Cable, shortcut: "c" },
];
