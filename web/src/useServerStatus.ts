import { useEffect, useState } from "react";

export type ServerStatus = "checking" | "up" | "down";

export function useServerStatus(): ServerStatus {
  const [status, setStatus] = useState<ServerStatus>("checking");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/health", { signal: controller.signal })
      .then((res) => setStatus(res.ok ? "up" : "down"))
      .catch((err: unknown) => {
        if ((err as Error).name !== "AbortError") setStatus("down");
      });
    return () => controller.abort();
  }, []);

  return status;
}
