import { useEffect, useRef } from "react";

export function useScrollActiveOption(
  index: number,
  count: number,
  open: boolean,
) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [index, count, open]);
  return listRef;
}
