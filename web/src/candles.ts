// Candles as the chart draws them. Prices arrive as 10^-8 dollar strings and become plain numbers
// here, for drawing only; nothing computed from these goes back to the server.

export type ApiCandle = { time: number; open: string; high: string; low: string; close: string; volume: string };
export type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };

export const INTERVALS = [
  { id: "1m", label: "1m", seconds: 60 },
  { id: "5m", label: "5m", seconds: 300 },
  { id: "15m", label: "15m", seconds: 900 },
  { id: "1h", label: "1H", seconds: 3600 },
  { id: "4h", label: "4H", seconds: 14_400 },
  { id: "1d", label: "1D", seconds: 86_400 },
] as const;
export type IntervalId = (typeof INTERVALS)[number]["id"];

const toNumber = (units: string) => Number(units) / 1e8;

export function toBar(c: ApiCandle): Bar {
  return {
    time: c.time,
    open: toNumber(c.open),
    high: toNumber(c.high),
    low: toNumber(c.low),
    close: toNumber(c.close),
    volume: toNumber(c.volume),
  };
}

/**
 * Folds a live price into the newest bar. A tick inside the newest bar's period moves its close
 * and stretches its high or low; a tick in a later period starts a new bar there. A tick older
 * than the newest bar is ignored, since that bar already includes it. Returns null when nothing
 * should change.
 */
export function applyTick(last: Bar | undefined, price: number, tickMs: number, intervalSeconds: number): Bar | null {
  if (!last) return null;
  const bucket = Math.floor(tickMs / 1000 / intervalSeconds) * intervalSeconds;
  if (bucket < last.time) return null;
  if (bucket === last.time) {
    return { ...last, close: price, high: Math.max(last.high, price), low: Math.min(last.low, price) };
  }
  // Volume for a bar we start ourselves is unknown until the next fetch, so it starts at zero.
  return { time: bucket, open: last.close, high: Math.max(last.close, price), low: Math.min(last.close, price), close: price, volume: 0 };
}

/** Decimal places to show for a coin's price: cents above a dollar, five places below. */
export function precisionFor(price: number): number {
  return price < 1 ? 5 : 2;
}
