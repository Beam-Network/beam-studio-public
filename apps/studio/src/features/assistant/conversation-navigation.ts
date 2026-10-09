import { useSyncExternalStore } from "react";
import { readStoredDraft } from "./chat-state";

const changedEvent = "beam:assistant:last-conversation";

export function conversationHref(id: string | null) {
  return id ? `/c/${encodeURIComponent(id)}` : "/";
}

export function conversationIdFromPath(pathname: string): string | null {
  const match = /^\/c\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

export function lastConversationKey(
  userId?: string | null,
  organizationId?: string | null,
) {
  return userId && organizationId
    ? `beam:assistant:last:${JSON.stringify([userId, organizationId])}`
    : null;
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(changedEvent, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(changedEvent, onChange);
  };
}

export function useLastConversation(
  userId?: string | null,
  organizationId?: string | null,
) {
  const key = lastConversationKey(userId, organizationId);
  const id = useSyncExternalStore(
    subscribe,
    () => readStoredDraft(key, ""),
    () => "",
  );
  function remember(id: string) {
    if (!key) return;
    try {
      if (id) window.localStorage.setItem(key, JSON.stringify(id));
      else window.localStorage.removeItem(key);
      window.dispatchEvent(new Event(changedEvent));
    } catch {
      /* Direct conversation URLs still work without browser storage. */
    }
  }
  return [id, remember] as const;
}
