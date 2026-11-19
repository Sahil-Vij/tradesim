import { Redis } from "ioredis";
import { loadRedisUrl } from "./config.ts";
import { startBinanceFeed } from "./prices/feed.ts";
import { STARTER_SYMBOLS } from "./prices/price.ts";
import { saveTick } from "./prices/store.ts";

// Runs on its own so there is one Binance connection however many API servers there are.
const redis = new Redis(loadRedisUrl());
const feed = startBinanceFeed({
  symbols: STARTER_SYMBOLS,
  url: process.env.BINANCE_WS_URL || undefined,
  onTick: (tick) => saveTick(redis, tick).then(() => {}),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    feed.stop();
    redis.quit().then(() => process.exit(0));
  });
}
