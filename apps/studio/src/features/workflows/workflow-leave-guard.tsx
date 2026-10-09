import { useRef, useState } from "react";
import { useBlocker } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Asks before leaving the editor with unsaved changes.
 *
 * Every workflow tab is its own route, so opening Settings, Credentials or a
 * run unmounts the editor and its unsaved graph with it. Without this guard a
 * step added before its credential existed was silently lost on the way to
 * creating the credential.
 *
 * In-app navigation gets a dialog; closing or reloading the tab gets the
 * browser's own prompt. Navigation inside the editor route (a changed search
 * parameter) is never blocked.
 */
export function WorkflowLeaveGuard({
  enabled,
  hasUnsavedChanges,
  issueCount,
  save,
}: {
  enabled: boolean;
  hasUnsavedChanges: boolean;
  /** Validation issues that currently prevent saving. */
  issueCount: number;
  /** Saves the graph; rejects when the save did not happen. */
  save(): Promise<unknown>;
}) {
  const unsavedRef = useRef(false);
  unsavedRef.current = enabled && hasUnsavedChanges;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      unsavedRef.current && current.pathname !== next.pathname,
    enableBeforeUnload: () => unsavedRef.current,
    withResolver: true,
  });

  if (blocker.status !== "blocked") return null;

  const canSave = issueCount === 0;
  const stay = () => {
    if (saving) return;
    setError("");
    blocker.reset();
  };
  const saveAndLeave = async () => {
    setSaving(true);
    setError("");
    try {
      await save();
      blocker.proceed();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : "The workflow could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : stay())}>
      <DialogContent onMouseDown={(event) => event.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Leave without saving?</DialogTitle>
          <DialogDescription>
            {canSave
              ? "This workflow has unsaved changes. Save them before leaving, or discard them."
              : `This workflow has unsaved changes that can't be saved until ${
                  issueCount === 1
                    ? "its 1 issue is fixed"
                    : `its ${issueCount} issues are fixed`
                }. Leaving discards them.`}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p
            className="rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            role="alert"
          >
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            disabled={saving}
            onClick={stay}
            type="button"
            variant="ghost"
          >
            Keep editing
          </Button>
          <Button
            disabled={saving}
            onClick={() => {
              setError("");
              blocker.proceed();
            }}
            type="button"
            variant={canSave ? "outline" : "destructive"}
          >
            Discard changes
          </Button>
          {canSave ? (
            <Button
              disabled={saving}
              onClick={() => void saveAndLeave()}
              type="button"
            >
              {saving ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {saving ? "Saving…" : "Save and leave"}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
