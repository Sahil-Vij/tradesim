import { useEffect, useRef, useState } from "react";
import { api, type Price } from "./api.ts";

export type LivePrice = Price & {
  direction: "up" | "down" | null;
  /** Bumps each time the price changes, so a cell can replay its highlight. */
  changes: number;
  /** Prices seen since the page opened, oldest first, for the sparkline. Display only. */
  history: number[];
};

const HISTORY = 120;

/**
 * Polls the latest prices once a second. A WebSocket replaces this in #9; until then, polling a
 * Redis hash once a second is cheap. Each price remembers its last move and recent history.
 */
export function usePrices(intervalMs = 1000): { prices: LivePrice[]; error: boolean } {
  const [prices, setPrices] = useState<LivePrice[]>([]);
  const [error, setError] = useState(false);
  const last = useRef(new Map<string, { price: bigint; direction: LivePrice["direction"]; changes: number; history: number[] }>());

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
            const moved = before !== undefined && before.price !== price;
            const direction = moved ? (price > before.price ? "up" : "down") : (before?.direction ?? null);
            const changes = (before?.changes ?? 0) + (moved ? 1 : 0);
            const history = moved || !before ? [...(before?.history ?? []), Number(price)].slice(-HISTORY) : before.history;
            last.current.set(p.symbol, { price, direction, changes, history });
            return { ...p, direction, changes, history };
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
