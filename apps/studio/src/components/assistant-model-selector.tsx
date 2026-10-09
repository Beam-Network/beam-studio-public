import { useEffect, useMemo, useRef, useState } from "react";
import type { AssistantModelOption } from "@beam-studio/shared";
import { Check, ChevronsUpDown, Search, Sparkles } from "lucide-react";
import { AssistantProviderLogo } from "@/components/assistant-provider-logo";
import { cn } from "@/lib/utils";

export function AssistantModelSelector({
  compact = false,
  disabled = false,
  emptyLabel = "No compatible models",
  models,
  onChange,
  placeholder = "Choose a model",
  providerId,
  side = "bottom",
  value,
}: {
  compact?: boolean;
  disabled?: boolean;
  emptyLabel?: string;
  models: AssistantModelOption[];
  onChange(value: string): void;
  placeholder?: string;
  providerId?: string;
  side?: "bottom" | "top";
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const availableModels = useMemo(
    () =>
      value && !models.some((model) => model.id === value)
        ? [{ id: value, name: value }, ...models]
        : models,
    [models, value],
  );
  const selected = availableModels.find((model) => model.id === value) ?? null;
  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return availableModels;
    return availableModels.filter((model) =>
      `${model.name} ${model.id}`.toLowerCase().includes(normalizedQuery),
    );
  }, [availableModels, query]);
  const recommended = filtered.filter((model) => model.recommended);
  const allModels = filtered.filter((model) => !model.recommended);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [open]);

  const choose = (model: AssistantModelOption) => {
    onChange(model.id);
    setOpen(false);
  };

  return (
    <div className={cn("relative min-w-0", compact ? "shrink" : "w-full")}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className={cn(
          "flex items-center gap-2 rounded-control text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          compact
            ? "h-8 max-w-52 rounded-control border border-transparent bg-muted/60 px-2.5 font-mono text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            : "h-10 w-full border bg-background px-3 text-sm hover:bg-accent/40",
        )}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        title={selected?.name || value || placeholder}
        type="button"
      >
        {selected ? (
          <AssistantProviderLogo
            className="size-4"
            modelId={selected.id}
            providerId={providerId}
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate font-mono">
          {selected?.name || value || placeholder}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </button>

      {open ? (
        <>
          <button
            aria-label="Close model selector"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
            type="button"
          />
          <div
            className={cn(
              "absolute z-50 w-[min(380px,calc(100vw-2rem))] overflow-hidden rounded-surface border bg-popover text-popover-foreground shadow-xl",
              "left-0",
              side === "top"
                ? "bottom-[calc(100%+0.5rem)]"
                : "top-[calc(100%+0.5rem)]",
            )}
          >
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <input
                className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setOpen(false);
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    const firstMatch = recommended[0] ?? allModels[0];
                    if (firstMatch) choose(firstMatch);
                  }
                }}
                placeholder="Search models..."
                ref={searchInputRef}
                value={query}
              />
              <kbd className="rounded-control border px-2 py-1 text-xs text-muted-foreground">
                Esc
              </kbd>
            </div>
            <div className="max-h-80 overflow-y-auto p-2" role="listbox">
              {recommended.length ? (
                <ModelGroup
                  models={recommended}
                  onChoose={choose}
                  providerId={providerId}
                  selectedId={value}
                  title="Recommended"
                />
              ) : null}
              {allModels.length ? (
                <ModelGroup
                  models={allModels}
                  onChoose={choose}
                  providerId={providerId}
                  selectedId={value}
                  title={
                    recommended.length ? "All compatible models" : "Models"
                  }
                />
              ) : null}
              {!recommended.length && !allModels.length ? (
                <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {query ? `No model matches "${query}"` : emptyLabel}
                </div>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function ModelGroup({
  models,
  onChoose,
  providerId,
  selectedId,
  title,
}: {
  models: AssistantModelOption[];
  onChoose(model: AssistantModelOption): void;
  providerId?: string;
  selectedId: string;
  title: string;
}) {
  return (
    <section className="py-1">
      <p className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground">
        {title === "Recommended" ? <Sparkles className="size-3.5" /> : null}
        {title}
      </p>
      {models.map((model) => (
        <button
          aria-selected={model.id === selectedId}
          className={cn(
            "flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
            model.id === selectedId && "bg-accent text-accent-foreground",
          )}
          key={model.id}
          onClick={() => onChoose(model)}
          role="option"
          type="button"
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-control bg-secondary">
            <AssistantProviderLogo modelId={model.id} providerId={providerId} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{model.name}</span>
            {model.name !== model.id ? (
              <span className="block truncate font-mono text-xs text-muted-foreground">
                {model.id}
              </span>
            ) : null}
          </span>
          {model.id === selectedId ? (
            <Check className="size-4 shrink-0 text-primary" />
          ) : null}
        </button>
      ))}
    </section>
  );
}
