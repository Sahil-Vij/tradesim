import type { Redis } from "ioredis";
import { parsePrice } from "./price.ts";

// Candles come from Binance's REST API and are cached in Redis, so many browsers looking at the
// same chart cost one Binance call. See docs/design.md, "Prices and live updates".

export const BINANCE_REST_URL = "https://data-api.binance.vision";

/** Each interval's length in seconds, and how long its candles stay cached. */
export const INTERVALS: Record<string, { seconds: number; cacheSeconds: number }> = {
  "1m": { seconds: 60, cacheSeconds: 5 },
  "5m": { seconds: 300, cacheSeconds: 15 },
  "15m": { seconds: 900, cacheSeconds: 30 },
  "1h": { seconds: 3600, cacheSeconds: 60 },
  "4h": { seconds: 14_400, cacheSeconds: 120 },
  "1d": { seconds: 86_400, cacheSeconds: 300 },
};

/** Prices in 10^-8 dollars and volume in 10^-8 coins, as BigInt. `time` is the open, in seconds. */
export type Candle = { time: number; open: bigint; high: bigint; low: bigint; close: bigint; volume: bigint };

export class CandlesUnavailableError extends Error {}

/** Parses Binance's kline arrays: [openTime, open, high, low, close, volume, ...]. */
export function parseKlines(rows: unknown): Candle[] {
  if (!Array.isArray(rows)) throw new CandlesUnavailableError("klines response is not an array");
  return rows.map((row) => {
    if (!Array.isArray(row) || typeof row[0] !== "number") throw new CandlesUnavailableError("bad kline row");
    return {
      time: row[0] / 1000,
      open: parsePrice(row[1]),
      high: parsePrice(row[2]),
      low: parsePrice(row[3]),
      close: parsePrice(row[4]),
      volume: parsePrice(row[5]),
    };
  });
}

type Stored = Array<[number, string, string, string, string, string]>;

export async function getCandles(
  redis: Redis,
  symbol: string,
  interval: string,
  limit: number,
  baseUrl = BINANCE_REST_URL,
): Promise<Candle[]> {
  const key = `candles:${symbol}:${interval}:${limit}`;
  const cached = await redis.get(key);
  if (cached) {
    return (JSON.parse(cached) as Stored).map(([time, open, high, low, close, volume]) => ({
      time,
      open: BigInt(open),
      high: BigInt(high),
      low: BigInt(low),
      close: BigInt(close),
      volume: BigInt(volume),
    }));
  }

  const url = `${baseUrl}/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&limit=${limit}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  } catch (err) {
    throw new CandlesUnavailableError(`could not reach Binance: ${(err as Error).message}`);
  }
  if (!res.ok) throw new CandlesUnavailableError(`Binance answered ${res.status}`);
  const candles = parseKlines(await res.json());

  const stored: Stored = candles.map((c) => [c.time, `${c.open}`, `${c.high}`, `${c.low}`, `${c.close}`, `${c.volume}`]);
  await redis.set(key, JSON.stringify(stored), "EX", INTERVALS[interval]!.cacheSeconds);
  return candles;
}
