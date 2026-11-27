import { useEffect, useRef, useState } from "react";
import { api, type Price } from "./api.ts";

export type LivePrice = Price & { direction: "up" | "down" | null };

/**
 * Polls the latest prices once a second. A WebSocket replaces this in #9; until then, polling a
 * Redis hash once a second is cheap. Each price remembers whether it last moved up or down.
 */
export function usePrices(intervalMs = 1000): { prices: LivePrice[]; error: boolean } {
  const [prices, setPrices] = useState<LivePrice[]>([]);
  const [error, setError] = useState(false);
  const last = useRef(new Map<string, { price: bigint; direction: LivePrice["direction"] }>());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const body = await api<{ prices: Price[] }>("/api/prices");
        if (cancelled) return;
        setPrices(
          body.prices.map((p) => {
            const price = BigInt(p.price);
            const before = last.current.get(p.symbol);
            const direction =
              !before || before.price === price ? (before?.direction ?? null) : price > before.price ? "up" : "down";
            last.current.set(p.symbol, { price, direction });
            return { ...p, direction };
          }),
        );
        setError(false);
      } catch {
        if (!cancelled) setError(true);
      }
    };
    load();
    const timer = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [intervalMs]);

  return { prices, error };
}
