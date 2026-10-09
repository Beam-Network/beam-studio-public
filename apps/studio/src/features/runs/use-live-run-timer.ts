import { useEffect, useState } from "react";

export function useLiveRunTimer(enabled: boolean) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const interval = window.setInterval(() => {
      setTick((tick) => tick + 1);
    }, 1000);

    return () => window.clearInterval(interval);
  }, [enabled]);
}
