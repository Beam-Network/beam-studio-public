import { useState } from "react";

export const LOW_CREDIT_THRESHOLD = 100;

export function draftStorageKey(
  userId: string,
  organizationId: string,
  conversationId: string | null,
) {
  return `beam:assistant:draft:${JSON.stringify([userId, organizationId, conversationId ?? "new"])}`;
}

export function pendingRequestId(
  stored: string,
  content: string,
): string | null {
  try {
    const value = JSON.parse(stored);
    return typeof value?.id === "string" && value.content === content
      ? value.id
      : null;
  } catch {
    return null;
  }
}

export function readStoredDraft<T>(key: string | null, fallback: T): T {
  if (!key || typeof window === "undefined") return fallback;
  try {
    const stored = window.localStorage.getItem(key);
    if (!stored) return fallback;
    const parsed: unknown = JSON.parse(stored);
    if (typeof fallback === "string")
      return (typeof parsed === "string" ? parsed : fallback) as T;
    return (
      Array.isArray(fallback) && Array.isArray(parsed) ? parsed : fallback
    ) as T;
  } catch {
    return fallback;
  }
}

export function writeStoredDraft(key: string | null, value: unknown) {
  if (!key) return;
  try {
    if (value === "" || (Array.isArray(value) && !value.length))
      window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Keep editing available if browser storage is unavailable. */
  }
}

export function useStoredDraft<T>(key: string | null, fallback: T) {
  const [state, setState] = useState<{ key: string | null; value: T }>({
    key,
    value: readStoredDraft(key, fallback),
  });
  const value =
    state.key === key ? state.value : readStoredDraft(key, fallback);
  function setValue(next: T | ((current: T) => T)) {
    const updated =
      typeof next === "function" ? (next as (current: T) => T)(value) : next;
    setState({ key, value: updated });
    writeStoredDraft(key, updated);
  }
  return [value, setValue] as const;
}

export function groupConversations<
  T extends { title: string; updatedAt: string },
>(conversations: T[], query: string, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const normalized = query.trim().toLocaleLowerCase();
  const groups: Record<string, T[]> = { Today: [], Yesterday: [], Earlier: [] };
  for (const conversation of [...conversations].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  )) {
    if (!conversation.title.toLocaleLowerCase().includes(normalized)) continue;
    const date = new Date(conversation.updatedAt);
    const label =
      date >= today ? "Today" : date >= yesterday ? "Yesterday" : "Earlier";
    groups[label]!.push(conversation);
  }
  return Object.entries(groups).filter(([, items]) => items.length);
}

export function isNearLatest(
  element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}
