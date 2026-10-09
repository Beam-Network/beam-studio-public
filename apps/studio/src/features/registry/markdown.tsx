import { Fragment, type ReactNode } from "react";
import {
  normalizeAssistantMarkdownLinks,
  sanitizeAssistantMarkdownLinks,
} from "@beam-studio/shared";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/copy-button";

type MarkdownBlock =
  | { type: "heading"; depth: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "code"; code: string };

export function MarkdownContent({
  assistantLinks = false,
  className,
  compact = false,
  copyCode = false,
  muted = true,
  value,
}: {
  assistantLinks?: boolean;
  className?: string;
  compact?: boolean;
  copyCode?: boolean;
  muted?: boolean;
  value: string;
}) {
  const normalizedValue = assistantLinks
    ? sanitizeAssistantMarkdownLinks(value)
    : normalizeAssistantMarkdownLinks(value);
  return (
    <div
      className={cn(
        compact
          ? "grid gap-2 text-sm leading-5"
          : "grid gap-4 text-sm leading-6",
        className,
      )}
    >
      {parseMarkdown(normalizedValue).map((block, index) => {
        if (block.type === "heading") {
          const className =
            block.depth === 1
              ? "text-2xl font-semibold tracking-tight"
              : "text-base font-semibold tracking-tight";
          return (
            <div className={className} key={index}>
              {renderInline(block.text)}
            </div>
          );
        }

        if (block.type === "list") {
          return (
            <ul
              className={cn(
                "list-disc space-y-1 pl-5",
                muted && "text-muted-foreground",
              )}
              key={index}
            >
              {block.items.map((item, itemIndex) => (
                <li key={`${item}:${itemIndex}`}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }

        if (block.type === "code") {
          return (
            <div className="min-w-0 rounded-control bg-muted" key={index}>
              {copyCode ? (
                <div className="flex justify-end px-2 pt-1">
                  <CopyButton label="Copy code" value={block.code} />
                </div>
              ) : null}
              <pre className="overflow-auto p-3 text-xs">
                <code>{block.code}</code>
              </pre>
            </div>
          );
        }

        return (
          <p
            className={cn("break-words", muted && "text-muted-foreground")}
            key={index}
          >
            {renderInline(block.text)}
          </p>
        );
      })}
    </div>
  );
}

function parseMarkdown(value: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = value.replaceAll("\r\n", "\n").split("\n");
  let paragraph: string[] = [];
  let list: string[] = [];
  let code: string[] | null = null;

  function flushParagraph() {
    if (paragraph.length) {
      blocks.push({ type: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  }

  function flushList() {
    if (list.length) {
      blocks.push({ type: "list", items: list });
      list = [];
    }
  }

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (code) {
        blocks.push({ type: "code", code: code.join("\n") });
        code = null;
      } else {
        flushParagraph();
        flushList();
        code = [];
      }
      continue;
    }

    if (code) {
      code.push(line);
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        type: "heading",
        depth: heading[1]?.length ?? 1,
        text: heading[2] ?? "",
      });
      continue;
    }

    const listItem = /^\s*(?:[-*]|\d+[.)])\s+(.+)$/.exec(line);
    if (listItem) {
      flushParagraph();
      list.push(listItem[1] ?? "");
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  if (code) {
    blocks.push({ type: "code", code: code.join("\n") });
  }

  return blocks;
}

function renderInline(value: string): ReactNode {
  const parts = value.split(
    /(`[^`]+`|\*\*[^*]+?\*\*|\*[^*\n]+?\*|\[[^\]]+\]\(\s*(?:https?:\/\/|\/)[^)]+?\s*\))/g,
  );
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          className="rounded-control-compact bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground"
          key={index}
        >
          {part.slice(1, -1)}
        </code>
      );
    }

    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong className="font-semibold text-foreground" key={index}>
          {renderInline(part.slice(2, -2))}
        </strong>
      );
    }

    if (part.startsWith("*") && part.endsWith("*")) {
      return (
        <em className="italic" key={index}>
          {renderInline(part.slice(1, -1))}
        </em>
      );
    }

    const link = /^\[([^\]]+)\]\(\s*((?:https?:\/\/|\/)[^)\s]+)\s*\)$/.exec(
      part,
    );
    if (link) {
      const href = link[2] ?? "";
      return (
        <a
          className="font-medium text-primary underline underline-offset-4"
          href={href}
          key={index}
          rel={href.startsWith("http") ? "noreferrer" : undefined}
          target={href.startsWith("http") ? "_blank" : undefined}
        >
          {link[1]}
        </a>
      );
    }

    return <Fragment key={index}>{part}</Fragment>;
  });
}
