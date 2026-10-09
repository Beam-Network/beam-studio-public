import { useState, type ReactElement } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function ConfirmationDialog({
  cancelLabel = "Cancel",
  confirmLabel = "Confirm",
  description,
  onConfirm,
  title,
  trigger,
}: {
  cancelLabel?: string;
  confirmLabel?: string;
  description: string;
  onConfirm(): unknown | Promise<unknown>;
  title: string;
  trigger: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  function changeOpen(nextOpen: boolean) {
    if (pending) return;
    setOpen(nextOpen);
    if (nextOpen) setError("");
  }

  async function confirm() {
    setPending(true);
    setError("");
    try {
      await onConfirm();
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent onMouseDown={(event) => event.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            disabled={pending}
            onClick={() => changeOpen(false)}
            type="button"
            variant="ghost"
          >
            {cancelLabel}
          </Button>
          <Button
            disabled={pending}
            onClick={() => void confirm()}
            type="button"
            variant="destructive"
          >
            {pending ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {pending ? `${confirmLabel}…` : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
