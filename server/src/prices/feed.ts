import { parseMiniTicker, type Tick } from "./price.ts";

// Binance's market-data-only host. It serves the same streams as stream.binance.com.
export const BINANCE_WS_URL = "wss://data-stream.binance.vision";

export type FeedOptions = {
  symbols: readonly string[];
  onTick: (tick: Tick) => void | Promise<void>;
  url?: string;
  /** Reconnect delays grow from `minDelayMs` to `maxDelayMs`, doubling each failed attempt. */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** A connection that sends nothing for this long is treated as dead and replaced. */
  silenceMs?: number;
  log?: (message: string) => void;
  random?: () => number;
};

export type Feed = { stop: () => void };

/** The delay before reconnect attempt `attempt` (0-based): full jitter over an exponential cap. */
export function backoffDelay(attempt: number, minDelayMs: number, maxDelayMs: number, random = Math.random): number {
  const cap = Math.min(maxDelayMs, minDelayMs * 2 ** attempt);
  return Math.round(minDelayMs + random() * (cap - minDelayMs));
}

/**
 * Holds Binance's combined mini-ticker stream for `symbols` and calls `onTick` for each update.
 * Reconnects with backoff when the socket closes, errors, or goes quiet. Binance also drops every
 * connection after 24 hours; that is handled the same way.
 */
export function startBinanceFeed(options: FeedOptions): Feed {
  const {
    symbols,
    onTick,
    url = BINANCE_WS_URL,
    minDelayMs = 1_000,
    maxDelayMs = 30_000,
    silenceMs = 30_000,
    log = console.log,
    random = Math.random,
  } = options;
  const wanted = new Set(symbols);
  const streams = symbols.map((s) => `${s.toLowerCase()}usdt@miniTicker`).join("/");
  const streamUrl = `${url}/stream?streams=${streams}`;

  let socket: WebSocket | null = null;
  let attempt = 0;
  let stopped = false;
  let retryTimer: NodeJS.Timeout | undefined;
  let silenceTimer: NodeJS.Timeout | undefined;

  const connect = () => {
    const ws = new WebSocket(streamUrl);
    socket = ws;
    let closed = false;

    const resetSilence = () => {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        log(`price feed: no data for ${silenceMs}ms, reconnecting`);
        ws.close();
        // close() waits for the server's reply, which a dead connection never sends.
        onClose();
      }, silenceMs);
    };

    const onClose = () => {
      if (closed) return;
      closed = true;
      clearTimeout(silenceTimer);
      if (stopped) return;
      const delay = backoffDelay(attempt++, minDelayMs, maxDelayMs, random);
      log(`price feed: disconnected, retrying in ${delay}ms`);
      retryTimer = setTimeout(connect, delay);
    };

    ws.addEventListener("open", () => {
      log(`price feed: connected (${symbols.join(", ")})`);
      resetSilence();
    });
    ws.addEventListener("message", (event) => {
      resetSilence();
      let tick;
      try {
        tick = parseMiniTicker(String(event.data), wanted);
      } catch (err) {
        log(`price feed: skipped a bad message: ${(err as Error).message}`);
        return;
      }
      if (!tick) return;
      // Only data proves the connection works; a socket that opens and closes straight away keeps backing off.
      attempt = 0;
      Promise.resolve(onTick(tick)).catch((err) => log(`price feed: could not save ${tick.symbol}: ${err}`));
    });
    ws.addEventListener("error", () => {
      // A close event always follows; reconnecting happens there.
    });
    ws.addEventListener("close", onClose);
  };

  connect();

  return {
    stop: () => {
      stopped = true;
      clearTimeout(retryTimer);
      clearTimeout(silenceTimer);
      socket?.close();
    },
  };
}
