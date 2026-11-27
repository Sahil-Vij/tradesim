import { Redis } from "ioredis";
import { loadRedisUrl } from "./config.ts";
import { enqueueTick, matchQueue } from "./orders/matcher.ts";
import { startBinanceFeed } from "./prices/feed.ts";
import { STARTER_SYMBOLS } from "./prices/price.ts";
import { saveTick } from "./prices/store.ts";

// Runs on its own so there is one Binance connection however many API servers there are.
const url = loadRedisUrl();
const redis = new Redis(url);
const queue = matchQueue({ url });
const feed = startBinanceFeed({
  symbols: STARTER_SYMBOLS,
  url: process.env.BINANCE_WS_URL || undefined,
  // Only a tick that became the latest price is matched; an older one arriving late is dropped.
  onTick: async (tick) => {
    if (await saveTick(redis, tick)) await enqueueTick(queue, tick);
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    feed.stop();
    Promise.all([queue.close(), redis.quit()]).then(() => process.exit(0));
  });
}
