import { useMemo, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";

export type SearchableSelectOption = {
  id: string;
  name: string;
  description?: string | null;
  disabled?: boolean;
};

export function SearchableSelect({
  disabled,
  emptyText = "No matching options",
  hasMore = false,
  loading = false,
  onChange,
  onLoadMore,
  onSearchChange,
  options,
  placeholder,
  searchPlaceholder = "Search…",
  value,
}: {
  disabled?: boolean;
  emptyText?: string;
  hasMore?: boolean;
  loading?: boolean;
  onChange(value: string): void;
  onLoadMore?(): void;
  onSearchChange?(query: string): void;
  options: SearchableSelectOption[];
  placeholder: string;
  searchPlaceholder?: string;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((option) => option.id === value);
  const visible = useMemo(() => {
    if (onSearchChange) return options;
    const needle = query.trim().toLowerCase();
    return needle
      ? options.filter((option) =>
          `${option.name} ${option.description ?? ""}`
            .toLowerCase()
            .includes(needle),
        )
      : options;
  }, [onSearchChange, options, query]);
  const changeQuery = (next: string) => {
    setQuery(next);
    onSearchChange?.(next);
  };
  return (
    <div className="relative">
      <button
        className="flex h-10 w-full items-center justify-between gap-2 rounded-control border border-input bg-background px-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        disabled={disabled}
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <span
          className={selected ? "truncate" : "truncate text-muted-foreground"}
        >
          {selected?.name ?? placeholder}
        </span>
        <ChevronDown className="size-4 shrink-0" />
      </button>
      {open ? (
        <>
          <button
            aria-label="Close options"
            className="fixed inset-0 z-40 cursor-default"
            type="button"
            onClick={() => setOpen(false)}
          />
          <div className="absolute z-50 mt-1 w-full min-w-64 rounded-control border bg-popover p-2 text-popover-foreground shadow-xl">
            <label className="mb-2 flex h-9 items-center gap-2 rounded-control border border-input bg-background px-2">
              <Search className="size-4 text-muted-foreground" />
              <input
                autoFocus
                className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                placeholder={searchPlaceholder}
                value={query}
                onChange={(event) => changeQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setOpen(false);
                  if (
                    event.key === "Enter" &&
                    visible[0] &&
                    !visible[0].disabled
                  ) {
                    onChange(visible[0].id);
                    setOpen(false);
                  }
                }}
              />
            </label>
            <div className="max-h-64 overflow-auto" role="listbox">
              {visible.map((option) => (
                <button
                  className="grid w-full gap-0.5 rounded-control px-2 py-2 text-left text-sm hover:bg-accent disabled:opacity-50"
                  disabled={option.disabled}
                  key={option.id}
                  type="button"
                  onClick={() => {
                    onChange(option.id);
                    setOpen(false);
                  }}
                >
                  <span className="truncate font-medium">{option.name}</span>
                  {option.description ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  ) : null}
                </button>
              ))}
              {!visible.length && !loading ? (
                <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                  {emptyText}
                </p>
              ) : null}
            </div>
            {hasMore ? (
              <Button
                className="mt-2 w-full"
                size="sm"
                variant="ghost"
                type="button"
                onClick={onLoadMore}
              >
                Load more
              </Button>
            ) : null}
            {loading ? (
              <p className="px-2 py-2 text-center text-xs text-muted-foreground">
                Loading…
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
