import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as Toast from "@radix-ui/react-toast";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ToastMessage = {
  id?: string;
  message: string;
  variant?: "error" | "info";
  action?: { label: string; onClick(): void };
};
type ToastApi = {
  notify(message: ToastMessage): void;
  dismiss(id?: string): void;
};
const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<
    Array<ToastMessage & { id: string; version: number }>
  >([]);
  const sequence = useRef(0);
  const notify = useCallback((message: ToastMessage) => {
    const version = ++sequence.current;
    const id = message.id ?? `toast-${version}`;
    setMessages((current) => [
      ...current.filter((item) => item.id !== id).slice(-2),
      { ...message, id, version },
    ]);
  }, []);
  const dismiss = useCallback(
    (id?: string) =>
      setMessages((current) =>
        id ? current.filter((message) => message.id !== id) : [],
      ),
    [],
  );
  const api = useMemo(() => ({ notify, dismiss }), [notify, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      <Toast.Provider duration={8000} swipeDirection="right">
        {children}
        {messages.map((message) => (
          <Toast.Root
            key={message.version}
            open
            onOpenChange={(open) => {
              if (!open) dismiss(message.id);
            }}
            className={cn(
              "pointer-events-auto flex items-start gap-3 rounded-surface border bg-popover p-4 text-popover-foreground shadow-lg",
              message.variant === "error" && "border-destructive/40",
            )}
          >
            <div className="min-w-0 flex-1">
              <Toast.Description className="break-words text-sm leading-5">
                {message.message}
              </Toast.Description>
              {message.action ? (
                <Toast.Action asChild altText={message.action.label}>
                  <Button
                    className="mt-3"
                    size="sm"
                    variant="outline"
                    onClick={message.action.onClick}
                  >
                    {message.action.label}
                  </Button>
                </Toast.Action>
              ) : null}
            </div>
            <Toast.Close asChild>
              <Button
                aria-label="Dismiss notification"
                className="-mr-1 -mt-1 size-7 shrink-0"
                size="icon"
                variant="ghost"
              >
                <X aria-hidden="true" className="size-3.5" />
              </Button>
            </Toast.Close>
          </Toast.Root>
        ))}
        <Toast.Viewport
          aria-label="Notifications"
          className="pointer-events-none fixed bottom-5 right-5 z-[100] flex w-[calc(100vw-2.5rem)] max-w-sm list-none flex-col gap-2 outline-none"
        />
      </Toast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast requires ToastProvider");
  return context;
}
