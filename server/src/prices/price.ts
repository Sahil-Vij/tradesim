// Prices are BigInt in units of 10^-8 of the quote currency per whole coin. Cents are too coarse:
// DOGE trades near $0.06, so rounding to a cent would be off by up to 8%. Binance sends at most
// 8 decimal places, so parsing is exact.

export const PRICE_DECIMALS = 8;

/** A price older than this can't be traded on. Binance sends mini tickers about once a second. */
export const STALE_AFTER_MS = 10_000;

/** The symbols the worker subscribes to, as base assets quoted in USDT (treated as USD). */
export const STARTER_SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE"] as const;

export type Tick = {
  symbol: string;
  /** Units of 10^-8 USD per coin. */
  price: bigint;
  /** Binance's event time, in milliseconds since the epoch. */
  time: number;
};

/** Parses a decimal string like "63754.30000000" into units of 10^-8. Throws on anything else. */
export function parsePrice(text: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(text);
  if (!match) throw new Error(`not a price: ${JSON.stringify(text)}`);
  const [, whole, fraction = ""] = match;
  return BigInt(whole + fraction.padEnd(PRICE_DECIMALS, "0"));
}

/** Formats units of 10^-8 back into a decimal string, without trailing zeros. */
export function formatPrice(price: bigint): string {
  const digits = price.toString().padStart(PRICE_DECIMALS + 1, "0");
  const whole = digits.slice(0, -PRICE_DECIMALS);
  const fraction = digits.slice(-PRICE_DECIMALS).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * Reads one message from Binance's combined stream (`/stream?streams=...@miniTicker`).
 * Returns null for anything that isn't a mini ticker for a USDT pair we asked for.
 */
export function parseMiniTicker(raw: string, symbols: ReadonlySet<string>): Tick | null {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  const data = (message as { data?: Record<string, unknown> } | null)?.data;
  if (!data || data.e !== "24hrMiniTicker" || typeof data.s !== "string" || !data.s.endsWith("USDT")) return null;
  const symbol = data.s.slice(0, -"USDT".length);
  if (!symbols.has(symbol) || typeof data.c !== "string" || typeof data.E !== "number") return null;
  const price = parsePrice(data.c);
  if (price <= 0n) return null;
  return { symbol, price, time: data.E };
}
