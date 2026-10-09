import { useEffect } from "react";
import { graphControlModes } from "./workflow-graph-constants";
import type { GraphControlMode, WorkflowTab } from "./workflow-graph-types";

export function useWorkflowGraphShortcuts({
  actionCatalogOpen,
  activeTab,
  endpointDraftOpen,
  infoNodeOpen,
  onControlModeChange,
  onCopySelection,
  onCutSelection,
  onDeleteSelection,
  onOpenActions,
  onOpenEndpoint,
  onPaste,
  onRedo,
  onSelectAll,
  onUndo,
}: {
  actionCatalogOpen: boolean;
  activeTab: WorkflowTab;
  endpointDraftOpen: boolean;
  infoNodeOpen: boolean;
  onControlModeChange(value: GraphControlMode): void;
  onCopySelection(): void;
  onCutSelection(): void;
  onDeleteSelection(): void;
  onOpenActions(): void;
  onOpenEndpoint(): void;
  onPaste(): void;
  onRedo(): void;
  onSelectAll(): void;
  onUndo(): void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        activeTab !== "editor" ||
        actionCatalogOpen ||
        endpointDraftOpen ||
        infoNodeOpen ||
        event.altKey ||
        isEditableShortcutTarget(event.target)
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && key === "a") {
        event.preventDefault();
        onSelectAll();
        return;
      }
      if (modifier && key === "c") {
        event.preventDefault();
        onCopySelection();
        return;
      }
      if (modifier && key === "x") {
        event.preventDefault();
        onCutSelection();
        return;
      }
      if (modifier && key === "v") {
        event.preventDefault();
        onPaste();
        return;
      }
      if (modifier && key === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          onRedo();
        } else {
          onUndo();
        }
        return;
      }
      if (modifier && key === "y") {
        event.preventDefault();
        onRedo();
        return;
      }
      if (modifier) {
        return;
      }
      if (key === "delete" || key === "backspace") {
        event.preventDefault();
        onDeleteSelection();
        return;
      }
      if (key === "a") {
        event.preventDefault();
        onOpenActions();
        return;
      }
      if (key === "e") {
        event.preventDefault();
        onOpenEndpoint();
        return;
      }

      const mode = graphControlModes.find((item) => item.shortcut === key);
      if (mode) {
        event.preventDefault();
        onControlModeChange(mode.id);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activeTab,
    actionCatalogOpen,
    endpointDraftOpen,
    infoNodeOpen,
    onControlModeChange,
    onCopySelection,
    onCutSelection,
    onDeleteSelection,
    onOpenActions,
    onOpenEndpoint,
    onPaste,
    onRedo,
    onSelectAll,
    onUndo,
  ]);
}

function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(
    target.closest("input, textarea, select, [contenteditable='true']"),
  );
}
