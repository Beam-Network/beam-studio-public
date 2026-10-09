import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Workflow,
  Users,
  CopyPlus,
  GitBranch,
  LayoutDashboard,
  LoaderCircle,
  Magnet,
  Network,
  Plus,
  Redo2,
  Repeat2,
  Split,
  Trash2,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { studioEnv } from "@/lib/env";
import { cn } from "@/lib/utils";
import { graphControlModes } from "./workflow-graph-constants";
import type { GraphControlMode } from "./workflow-graph-types";

const commandButtonClassName = "shrink-0 whitespace-nowrap";

const ignoreLoadingCommand = () => {};

/** The loading state uses the real controls so labels and layout cannot drift. */
export function GraphActionBarLoading() {
  return (
    <fieldset
      disabled
      className="m-0 min-w-0 border-0 p-0 opacity-70"
      aria-label="Loading workflow controls"
    >
      <GraphActionBar
        controlMode="select"
        canRedo={false}
        canUndo={false}
        canDuplicate={false}
        endpointAvailable={false}
        layoutPending={false}
        snapToGrid={true}
        hasRoom={false}
        distributed={false}
        selectedCount={0}
        onAddEndpoint={ignoreLoadingCommand}
        onAddFanOut={ignoreLoadingCommand}
        onAddDecision={ignoreLoadingCommand}
        onAddSwitch={ignoreLoadingCommand}
        onAddLoop={ignoreLoadingCommand}
        onAutoLayout={ignoreLoadingCommand}
        onControlModeChange={ignoreLoadingCommand}
        onSnapToGridChange={ignoreLoadingCommand}
        onDeleteSelection={ignoreLoadingCommand}
        onDuplicateSelection={ignoreLoadingCommand}
        onOpenActions={ignoreLoadingCommand}
        onOpenWorkflows={ignoreLoadingCommand}
        onOpenRoom={ignoreLoadingCommand}
        onOpenDistribution={ignoreLoadingCommand}
        onRedo={ignoreLoadingCommand}
        onUndo={ignoreLoadingCommand}
      />
    </fieldset>
  );
}

export function GraphActionBar({
  controlMode,
  canRedo,
  canUndo,
  canDuplicate,
  endpointAvailable,
  onAddEndpoint,
  onAddFanOut,
  onAddDecision,
  onAddSwitch,
  onAddLoop,
  onAutoLayout,
  layoutPending,
  onControlModeChange,
  snapToGrid,
  onSnapToGridChange,
  onDeleteSelection,
  onDuplicateSelection,
  onOpenActions,
  onOpenWorkflows,
  onOpenRoom,
  onOpenDistribution,
  distributed,
  hasRoom,
  selectedCount,
  onRedo,
  onUndo,
}: {
  controlMode: GraphControlMode;
  canRedo: boolean;
  canUndo: boolean;
  canDuplicate: boolean;
  endpointAvailable: boolean;
  onAddEndpoint(): void;
  onAddFanOut(): void;
  onAddDecision(): void;
  onAddSwitch(): void;
  onAddLoop(): void;
  onAutoLayout(): void;
  layoutPending: boolean;
  onControlModeChange(value: GraphControlMode): void;
  snapToGrid: boolean;
  onSnapToGridChange(value: boolean): void;
  onDeleteSelection(): void;
  onDuplicateSelection(): void;
  onOpenActions(): void;
  onOpenWorkflows(): void;
  onOpenRoom(): void;
  onOpenDistribution(): void;
  distributed: boolean;
  hasRoom: boolean;
  selectedCount: number;
  onRedo(): void;
  onUndo(): void;
}) {
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branchMenuPosition, setBranchMenuPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const branchMenuRef = useRef<HTMLDivElement | null>(null);
  const branchMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const branchMenuPortalRef = useRef<HTMLDivElement | null>(null);
  const addBranchNode = (action: () => void) => {
    action();
    setBranchMenuOpen(false);
  };

  useEffect(() => {
    if (!branchMenuOpen) {
      return undefined;
    }

    function closeOnOutsideClick(event: MouseEvent) {
      const target = event.target as Node;
      if (
        !branchMenuRef.current?.contains(target) &&
        !branchMenuPortalRef.current?.contains(target)
      ) {
        setBranchMenuOpen(false);
      }
    }

    window.addEventListener("mousedown", closeOnOutsideClick);
    return () => window.removeEventListener("mousedown", closeOnOutsideClick);
  }, [branchMenuOpen]);

  useEffect(() => {
    if (!branchMenuOpen) {
      setBranchMenuPosition(null);
      return undefined;
    }

    const updateBranchMenuPosition = () => {
      const button = branchMenuButtonRef.current;
      if (!button) {
        return;
      }

      const rect = button.getBoundingClientRect();
      setBranchMenuPosition({
        left: rect.left,
        top: rect.bottom + 6,
      });
    };

    updateBranchMenuPosition();
    window.addEventListener("resize", updateBranchMenuPosition);
    window.addEventListener("scroll", updateBranchMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateBranchMenuPosition);
      window.removeEventListener("scroll", updateBranchMenuPosition, true);
    };
  }, [branchMenuOpen]);

  return (
    <>
      <div className="flex max-w-full items-center gap-2 overflow-x-auto rounded-control border bg-card/95 p-2 text-card-foreground shadow-sm backdrop-blur">
        <Button
          className={commandButtonClassName}
          onClick={() => onOpenActions()}
          size="sm"
          title="Actions · Add Registry action (A)"
          type="button"
        >
          <Plus className="h-4 w-4 shrink-0" />
          <span className="hidden sm:inline">Actions</span>
        </Button>
        <Button
          aria-label="Add child workflow"
          className={commandButtonClassName}
          onClick={onOpenWorkflows}
          size="sm"
          title="Add child workflow"
          type="button"
          variant="secondary"
        >
          <Workflow className="h-4 w-4 shrink-0" />
          <span className="hidden sm:inline">Workflow</span>
        </Button>
        <Button
          aria-label="Workflow room"
          className={cn(commandButtonClassName, hasRoom && "text-primary")}
          onClick={onOpenRoom}
          size="sm"
          title={
            hasRoom
              ? "Edit shared workflow room"
              : "Select an optional workflow room"
          }
          type="button"
          variant="secondary"
        >
          <Users className="h-4 w-4 shrink-0" />
          <span className="hidden sm:inline">Room</span>
          {hasRoom ? (
            <span className="size-1.5 rounded-full bg-primary" />
          ) : null}
        </Button>
        {studioEnv.roomWorkflowsEnabled || distributed ? (
          <Button
            aria-label="Distributed workflow settings"
            className={cn(commandButtonClassName, distributed && "text-primary")}
            onClick={onOpenDistribution}
            size="sm"
            title="Configure partitions, per-member actions and routes"
            type="button"
            variant="secondary"
          >
            <Network className="h-4 w-4 shrink-0" />
            <span className="hidden sm:inline">Distribution</span>
            {distributed ? (
              <span className="size-1.5 rounded-full bg-primary" />
            ) : null}
          </Button>
        ) : null}
        <Button
          className={commandButtonClassName}
          disabled={!endpointAvailable}
          onClick={() => onAddEndpoint()}
          size="sm"
          title={
            endpointAvailable
              ? "Resources · Add object storage endpoint (E)"
              : "Resources · No resource action found"
          }
          type="button"
          variant="secondary"
        >
          <Network className="h-4 w-4 shrink-0" />
          <span className="hidden sm:inline">Resources</span>
        </Button>
        <div className="relative shrink-0" ref={branchMenuRef}>
          <Button
            aria-expanded={branchMenuOpen}
            aria-haspopup="menu"
            aria-label="Add branch node"
            className={cn(commandButtonClassName, "w-9 px-0 lg:w-auto lg:px-3")}
            onClick={() => setBranchMenuOpen((open) => !open)}
            ref={branchMenuButtonRef}
            size="sm"
            title="Flow control · Add fan-out, loop or decision"
            type="button"
            variant="secondary"
          >
            <GitBranch className="h-4 w-4 shrink-0" />
            <span className="hidden lg:inline">Flow</span>
          </Button>
        </div>
        <Button
          aria-label="Auto-layout graph"
          aria-busy={layoutPending}
          disabled={layoutPending}
          className={cn(commandButtonClassName, "w-9 px-0 lg:w-auto lg:px-3")}
          onClick={onAutoLayout}
          size="sm"
          title="Auto-layout graph"
          type="button"
          variant="secondary"
        >
          {layoutPending ? (
            <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" />
          ) : (
            <LayoutDashboard className="h-4 w-4 shrink-0" />
          )}
          <span className="hidden lg:inline">
            {layoutPending ? "Arranging…" : "Layout"}
          </span>
        </Button>
        <div className="mx-1 h-6 w-px shrink-0 bg-border" />
        <button
          aria-label="Snap to grid"
          aria-pressed={snapToGrid}
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-control transition-colors",
            snapToGrid
              ? "bg-secondary text-secondary-foreground"
              : "text-muted-foreground hover:bg-secondary hover:text-secondary-foreground",
          )}
          onClick={() => onSnapToGridChange(!snapToGrid)}
          title={snapToGrid ? "Snap to grid: on" : "Snap to grid: off"}
          type="button"
        >
          <Magnet className="h-4 w-4" />
        </button>
        <button
          aria-label="Undo"
          className="grid size-9 shrink-0 place-items-center rounded-control text-muted-foreground transition-colors hover:bg-secondary hover:text-secondary-foreground disabled:cursor-not-allowed disabled:opacity-35"
          disabled={!canUndo}
          onClick={onUndo}
          title="Undo (⌘Z)"
          type="button"
        >
          <Undo2 className="h-4 w-4" />
        </button>
        <button
          aria-label="Redo"
          className="grid size-9 shrink-0 place-items-center rounded-control text-muted-foreground transition-colors hover:bg-secondary hover:text-secondary-foreground disabled:cursor-not-allowed disabled:opacity-35"
          disabled={!canRedo}
          onClick={onRedo}
          title="Redo (⇧⌘Z)"
          type="button"
        >
          <Redo2 className="h-4 w-4" />
        </button>
        {graphControlModes.map((mode) => {
          const Icon = mode.icon;
          return (
            <button
              aria-label={mode.label}
              aria-pressed={controlMode === mode.id}
              className={cn(
                "grid size-9 shrink-0 place-items-center rounded-control transition-colors",
                controlMode === mode.id
                  ? "bg-secondary font-medium text-secondary-foreground"
                  : "text-muted-foreground hover:bg-secondary hover:text-secondary-foreground",
              )}
              key={mode.id}
              onClick={() => onControlModeChange(mode.id)}
              title={
                mode.id === "pan"
                  ? `${mode.label} (${mode.shortcut}) · Middle-mouse drag in any mode`
                  : `${mode.label} (${mode.shortcut})`
              }
              type="button"
            >
              <Icon className="h-4 w-4" />
              <span className="sr-only">({mode.shortcut})</span>
            </button>
          );
        })}
        <div className="mx-1 h-6 w-px shrink-0 bg-border" />
        <button
          aria-label="Duplicate selected node"
          className="grid size-9 shrink-0 place-items-center rounded-control text-muted-foreground transition-colors hover:bg-secondary hover:text-secondary-foreground disabled:cursor-not-allowed disabled:opacity-35"
          disabled={!canDuplicate}
          onClick={onDuplicateSelection}
          title="Duplicate selected node (⌘D)"
          type="button"
        >
          <CopyPlus className="h-4 w-4" />
        </button>
        <button
          aria-label="Delete selection"
          className="grid size-9 shrink-0 place-items-center rounded-control text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-35"
          disabled={!selectedCount}
          onClick={onDeleteSelection}
          title="Delete selection (Delete)"
          type="button"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      {branchMenuOpen && branchMenuPosition && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fixed z-[1000] grid min-w-36 gap-1 rounded-control border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
              ref={branchMenuPortalRef}
              role="menu"
              style={branchMenuPosition}
            >
              <button
                className="flex h-9 items-center gap-2 rounded-badge px-2 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                onClick={() => addBranchNode(onAddFanOut)}
                role="menuitem"
                type="button"
              >
                <GitBranch className="h-4 w-4" />
                Fan-out
              </button>
              <button
                className="flex h-9 items-center gap-2 rounded-badge px-2 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                onClick={() => addBranchNode(onAddLoop)}
                role="menuitem"
                type="button"
              >
                <Repeat2 className="h-4 w-4" />
                Bounded loop
              </button>
              <button
                className="flex h-9 items-center gap-2 rounded-badge px-2 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                onClick={() => addBranchNode(onAddDecision)}
                role="menuitem"
                type="button"
              >
                <Split className="h-4 w-4" />
                Decision
              </button>
              <button
                className="flex h-9 items-center gap-2 rounded-badge px-2 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                onClick={() => addBranchNode(onAddSwitch)}
                role="menuitem"
                type="button"
              >
                <GitBranch className="h-4 w-4" />
                Switch
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
