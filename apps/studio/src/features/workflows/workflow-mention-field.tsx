import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export type MentionValue = {
  /** What gets written into the field, e.g. ${steps.wfs_1.status}. */
  expression: string;
  /** The value being referenced, e.g. "status". */
  field: string;
  hint: string;
};

export type MentionNode = {
  id: string;
  /** The node as the operator named it. */
  label: string;
  kind: "step" | "decision" | "trigger" | "workflow";
  values: MentionValue[];
};

/**
 * The `@word` immediately before the caret, if the caret sits inside one.
 * A space ends a mention, so ordinary prose never opens the list.
 */
export function detectMentionQuery(text: string, caret: number) {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  const fragment = before.slice(at + 1);
  if (/\s/.test(fragment)) return null;
  return { start: at, text: fragment };
}

/** Replaces the `@query` fragment with an expression, and says where the caret lands. */
export function applyMention(
  value: string,
  start: number,
  caret: number,
  expression: string,
) {
  return {
    text: value.slice(0, start) + expression + value.slice(caret),
    caret: start + expression.length,
  };
}

export function matchNodes(nodes: MentionNode[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  return nodes.filter((node) => node.label.toLowerCase().includes(needle));
}

export function matchValues(node: MentionNode, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return node.values;
  return node.values.filter((value) =>
    `${value.field} ${value.hint}`.toLowerCase().includes(needle),
  );
}

export function resolveMentionReference(
  nodes: MentionNode[],
  expression: string,
) {
  const exact = nodes
    .flatMap((node) =>
      node.values.map((entry) => ({ node, entry, suffix: "" })),
    )
    .find(({ entry }) => entry.expression === expression);
  if (exact) return exact;

  // Output bodies may be open JSON values. Keep the canonical top-level
  // output in the manifest, while still recognizing paths selected within
  // that value (for example outputs.body.pools.qualifying.eligible).
  return (
    nodes
      .flatMap((node) =>
        node.values.map((entry) => ({
          node,
          entry,
          prefix:
            entry.field.startsWith("outputs.") &&
            entry.expression.endsWith("}") &&
            expression.endsWith("}")
              ? `${entry.expression.slice(0, -1)}.`
              : "",
        })),
      )
      .filter(({ prefix }) => prefix && expression.startsWith(prefix))
      .sort((left, right) => right.prefix.length - left.prefix.length)
      .map(({ node, entry, prefix }) => ({
        node,
        entry,
        suffix: expression.slice(prefix.length, -1),
      }))[0] ?? null
  );
}

/**
 * A text field with `@` mention autocomplete over workflow nodes.
 *
 * Two stages: `@` lists the nodes, choosing one lists that node's values. A
 * canvas of six nodes offers well over a hundred values, which is unusable as
 * a single flat list.
 *
 * The field stores canonical `${steps.<id>.…}` expressions rather than names,
 * because ids are stable and names are not — renaming a node must not silently
 * break every reference to it. The readable form is shown beneath instead.
 */
export function MentionField({
  nodes,
  placeholder,
  value,
  onChange,
}: {
  nodes: MentionNode[];
  placeholder?: string;
  value: string;
  onChange(next: string): void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState<{ start: number; text: string } | null>(
    null,
  );
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState(0);

  const selectedNode = nodes.find((node) => node.id === nodeId) ?? null;
  const nodeMatches = useMemo(
    () => (query ? matchNodes(nodes, query.text) : []),
    [nodes, query],
  );
  const valueMatches = useMemo(
    () => (query && selectedNode ? matchValues(selectedNode, query.text) : []),
    [selectedNode, query],
  );
  const rowCount = selectedNode ? valueMatches.length : nodeMatches.length;
  const open = query !== null && rowCount > 0;

  useEffect(() => {
    setHighlighted(0);
  }, [query?.text, nodeId]);

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-highlighted="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [highlighted, rowCount]);

  const close = () => {
    setQuery(null);
    setNodeId(null);
  };

  /** Choosing a node narrows the list; the typed filter resets to `@`. */
  const chooseNode = (node: MentionNode) => {
    if (!query) return;
    const caret = inputRef.current?.selectionStart ?? value.length;
    const next = `${value.slice(0, query.start)}@${value.slice(caret)}`;
    onChange(next);
    setNodeId(node.id);
    setQuery({ start: query.start, text: "" });
    const caretAfter = query.start + 1;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(caretAfter, caretAfter);
    });
  };

  const chooseValue = (entry: MentionValue) => {
    if (!query) return;
    const caret = inputRef.current?.selectionStart ?? value.length;
    const { text: next, caret: caretAfter } = applyMention(
      value,
      query.start,
      caret,
      entry.expression,
    );
    onChange(next);
    close();
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(caretAfter, caretAfter);
    });
  };

  const commitHighlighted = () => {
    if (selectedNode) {
      const entry = valueMatches[highlighted];
      if (entry) chooseValue(entry);
      return;
    }
    const node = nodeMatches[highlighted];
    if (node) chooseNode(node);
  };

  return (
    <div className="relative grid gap-1">
      <input
        aria-autocomplete="list"
        aria-expanded={open}
        className="h-10 w-full rounded-control border bg-background px-3 font-mono text-xs outline-none transition-colors placeholder:font-sans placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        placeholder={placeholder}
        ref={inputRef}
        role="combobox"
        value={value}
        onBlur={() => {
          // Let a click on a row land before the list closes.
          window.setTimeout(close, 120);
        }}
        onChange={(event) => {
          onChange(event.target.value);
          const next = detectMentionQuery(
            event.target.value,
            event.target.selectionStart ?? 0,
          );
          setQuery(next);
          if (!next) setNodeId(null);
        }}
        onKeyDown={(event) => {
          if (!query) return;
          if (event.key === "ArrowDown" && rowCount) {
            event.preventDefault();
            setHighlighted((current) => (current + 1) % rowCount);
          } else if (event.key === "ArrowUp" && rowCount) {
            event.preventDefault();
            setHighlighted((current) => (current - 1 + rowCount) % rowCount);
          } else if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            commitHighlighted();
          } else if (event.key === "Escape") {
            event.preventDefault();
            // Step back to the node list before dismissing entirely.
            if (selectedNode) setNodeId(null);
            else close();
          } else if (event.key === "Backspace" && selectedNode && !query.text) {
            event.preventDefault();
            setNodeId(null);
          }
        }}
        onSelect={(event) => {
          const target = event.target as HTMLInputElement;
          setQuery(
            detectMentionQuery(target.value, target.selectionStart ?? 0),
          );
        }}
      />

      {open ? (
        <div
          className="absolute left-0 right-0 top-11 z-50 overflow-hidden rounded-control border bg-popover shadow-lg"
          role="listbox"
        >
          {selectedNode ? (
            <button
              className="flex w-full items-center gap-1 border-b px-2 py-1.5 text-left text-[11px] font-medium hover:bg-accent/60"
              onMouseDown={(event) => {
                event.preventDefault();
                setNodeId(null);
              }}
              type="button"
            >
              <ChevronLeft className="h-3 w-3" />
              {selectedNode.label}
              <span className="ml-auto text-muted-foreground">
                pick a value
              </span>
            </button>
          ) : (
            <div className="border-b px-2 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              Nodes
            </div>
          )}

          <div
            className="grid max-h-56 gap-0.5 overflow-y-auto p-1"
            ref={listRef}
          >
            {selectedNode
              ? valueMatches.map((entry, index) => (
                  <button
                    aria-selected={index === highlighted}
                    className={rowClass(index === highlighted)}
                    data-highlighted={index === highlighted}
                    key={entry.expression}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      chooseValue(entry);
                    }}
                    onMouseEnter={() => setHighlighted(index)}
                    role="option"
                    type="button"
                  >
                    <span className="text-xs font-medium">{entry.field}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {entry.hint}
                    </span>
                  </button>
                ))
              : nodeMatches.map((node, index) => (
                  <button
                    aria-selected={index === highlighted}
                    className={rowClass(index === highlighted)}
                    data-highlighted={index === highlighted}
                    key={node.id}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      chooseNode(node);
                    }}
                    onMouseEnter={() => setHighlighted(index)}
                    role="option"
                    type="button"
                  >
                    <span className="flex items-center text-xs font-medium">
                      {node.label}
                      <ChevronRight className="ml-auto h-3 w-3 opacity-60" />
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {node.kind} · {node.values.length} values
                    </span>
                  </button>
                ))}
          </div>
        </div>
      ) : null}

      {query && rowCount === 0 ? (
        <span className="text-[11px] text-muted-foreground">
          {selectedNode
            ? `${selectedNode.label} has no value matching “${query.text}”.`
            : `No node matches “${query.text}”.`}
        </span>
      ) : null}

      <ReadablePreview nodes={nodes} value={value} />
    </div>
  );
}

function rowClass(highlighted: boolean) {
  return cn(
    "grid gap-0.5 rounded-badge px-2 py-1.5 text-left",
    highlighted ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
  );
}

/**
 * Expressions store ids, which are unreadable. Echo the human form back so the
 * operator can confirm they referenced the node they meant.
 */
function ReadablePreview({
  nodes,
  value,
}: {
  nodes: MentionNode[];
  value: string;
}) {
  const referenced = [...value.matchAll(/\$\{[^}]+\}/g)].map(
    (match) => match[0],
  );
  if (!referenced.length) return null;

  return (
    <span className="text-[11px] leading-5 text-muted-foreground">
      {referenced.map((expression, index) => {
        const known = resolveMentionReference(nodes, expression);
        return (
          <span key={`${expression}:${index}`}>
            {index ? " · " : ""}
            {known ? (
              <>
                {known.node.label}
                <span>
                  .{known.entry.field}
                  {known.suffix ? `.${known.suffix}` : ""}
                </span>
              </>
            ) : (
              <span className="text-destructive">{expression} — unknown</span>
            )}
          </span>
        );
      })}
    </span>
  );
}
