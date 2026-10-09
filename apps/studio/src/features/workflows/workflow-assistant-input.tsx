import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, Loader2, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type WorkflowAssistantInputResult = {
  applied: boolean;
  id: string;
};

export type WorkflowAssistantChatMessage = {
  content: string;
  detail?: string;
  draftId?: string;
  id: string;
  role: "assistant" | "user";
  status?: "error" | "kept" | "undone";
};

export function WorkflowAssistantInput({
  messages,
  onAcceptDraft,
  onDiscardDraft,
  onPromptChange,
  onSubmit,
  pending,
  prompt,
  result,
}: {
  messages: WorkflowAssistantChatMessage[];
  onAcceptDraft(id: string): void;
  onDiscardDraft(id: string): void;
  onPromptChange(value: string): void;
  onSubmit(): void;
  pending: boolean;
  prompt: string;
  result: WorkflowAssistantInputResult | null;
}) {
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const [historyOpen, setHistoryOpen] = useState(true);
  const draftPending = result?.applied === true;
  const pendingDraftId = result?.id;

  useEffect(() => {
    const messageList = messageListRef.current;
    if (messageList) {
      messageList.scrollTop = messageList.scrollHeight;
    }
  }, [messages, pending]);

  return (
    <div className="nodrag nopan nowheel absolute bottom-4 left-1/2 z-20 grid w-[min(680px,calc(100%-32px))] -translate-x-1/2 gap-2">
      {historyOpen && (messages.length || pending) ? (
        <div
          className="relative max-h-[min(300px,42vh)] overflow-y-auto rounded-surface border border-border/50 bg-card/55 p-3 shadow-xl backdrop-blur-2xl"
          ref={messageListRef}
        >
          <div className="sticky top-0 z-10 mb-1 flex justify-end">
            <Button
              aria-label="Hide conversation history"
              className="size-7 rounded-full bg-background/50 backdrop-blur-xl"
              onClick={() => setHistoryOpen(false)}
              size="icon"
              title="Hide conversation history"
              type="button"
              variant="ghost"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="grid gap-3">
            {messages.map((message) =>
              message.role === "user" ? (
                <div className="flex justify-end" key={message.id}>
                  <div className="max-w-[82%] whitespace-pre-wrap rounded-surface rounded-br-control bg-primary px-3.5 py-2.5 text-sm leading-5 text-primary-foreground shadow-sm">
                    {message.content}
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2.5" key={message.id}>
                  <BeamLogo className="mt-1 size-4" />
                  <div
                    className={cn(
                      "min-w-0 flex-1 rounded-surface rounded-tl-control border border-border/40 bg-background/35 px-3.5 py-2.5 text-sm shadow-sm",
                      message.status === "error" &&
                        "border-destructive/20 bg-destructive/5",
                    )}
                  >
                    <p className="whitespace-pre-wrap leading-5">
                      {message.content}
                    </p>
                    {message.detail ? (
                      <p className="mt-1.5 text-xs leading-4 text-muted-foreground">
                        {message.detail}
                      </p>
                    ) : null}
                    {pendingDraftId && pendingDraftId === message.draftId ? (
                      <div className="mt-2 flex justify-end gap-1">
                        <Button
                          onClick={() => onDiscardDraft(pendingDraftId)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          <RotateCcw className="h-4 w-4" />
                          Undo
                        </Button>
                        <Button
                          onClick={() => onAcceptDraft(pendingDraftId)}
                          size="sm"
                          type="button"
                        >
                          <Check className="h-4 w-4" />
                          Keep
                        </Button>
                      </div>
                    ) : message.status === "kept" ? (
                      <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                        <Check className="h-3.5 w-3.5" />
                        Changes kept
                      </p>
                    ) : message.status === "undone" ? (
                      <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                        <RotateCcw className="h-3.5 w-3.5" />
                        Changes undone
                      </p>
                    ) : null}
                  </div>
                </div>
              ),
            )}
            {pending ? (
              <div
                aria-live="polite"
                className="flex items-center gap-2.5 text-sm text-muted-foreground"
              >
                <BeamLogo className="size-4" />
                <Loader2 className="h-4 w-4 animate-spin" />
                Updating workflow…
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <form
        className="flex items-center gap-2 rounded-surface border bg-card/70 p-2 text-card-foreground shadow-xl backdrop-blur-2xl transition-colors focus-within:ring-2 focus-within:ring-ring"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <input
          aria-label="Describe a workflow change"
          autoComplete="off"
          className="h-10 min-w-0 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
          disabled={pending || draftPending}
          onChange={(event) => onPromptChange(event.target.value)}
          onFocus={() => setHistoryOpen(true)}
          placeholder={
            draftPending
              ? "Review the proposed changes above…"
              : "Describe how to change this workflow…"
          }
          value={prompt}
        />
        <button
          aria-label={pending ? "Updating workflow" : "Update workflow"}
          className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground text-background shadow-sm transition-colors hover:bg-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
          disabled={!prompt.trim() || pending || draftPending}
          title={pending ? "Updating workflow" : "Update workflow"}
          type="submit"
        >
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ArrowUp className="h-4 w-4" />
          )}
        </button>
      </form>
    </div>
  );
}

function BeamLogo({ className }: { className: string }) {
  return (
    <span className={cn("grid shrink-0 place-items-center", className)}>
      <img
        alt=""
        className="hidden size-full dark:block"
        src="/beam-logo-white.svg"
      />
      <img
        alt=""
        className="size-full dark:hidden"
        src="/beam-logo-black.svg"
      />
    </span>
  );
}
